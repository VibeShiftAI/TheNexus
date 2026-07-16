/**
 * /api/token-usage — daily token throughput across every engine on the box.
 *
 * Praxis logs tokens=null for CLI dispatches (subscription seats aren't
 * token-billed), so the real numbers come from each CLI's own session logs:
 *   - claude-code: ~/.claude/projects/**\/*.jsonl assistant entries
 *     (input + cache-creation + output; cache reads excluded — they'd dwarf
 *     real work). Streamed rewrites deduped by message id, last wins.
 *   - codex: ~/.codex/sessions/**\/rollout-*.jsonl — the last token_count
 *     event per session carries the cumulative session usage
 *     ((input − cached) + output).
 *   - local + cloud API: the Praxis cost ledger
 *     (~/.praxis-mind/cost_ledger.sqlite, read-only via the sqlite3 CLI).
 *   - antigravity: the agy headless CLI emits NO usage signal anywhere
 *     (verified end-to-end: no CLI flag, nothing in run transcripts, nothing
 *     in the agy conversation DBs). The only number available is the char/4
 *     text-volume estimate the Nexus server backfills into task_dispatches
 *     (tokens_estimated=1) on dispatch close — surfaced here as today's sum in
 *     the `antigravity` field ONLY, rendered "~N", and deliberately kept OUT
 *     of every DayRow.total so the reactor gauge stays 100% real telemetry.
 *
 * Per-file results are cached by mtime+size (session logs never rewrite old
 * entries), and the assembled response is cached for 30s, so the two bridge
 * pollers don't rescan gigabytes of JSONL.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileP = promisify(execFile);

const WINDOW_DAYS = 30;
const RESPONSE_TTL_MS = 30_000;

interface DayRow {
  date: string;
  claudeCode: number;
  codex: number;
  local: number;
  cloud: number;
  total: number;
}

const fileCache = new Map<string, { mtimeMs: number; size: number; perDay: Record<string, number> }>();
let responseCache: { at: number; body: unknown } | null = null;

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function listJsonl(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { recursive: true });
    return entries
      .map(String)
      .filter((e) => e.endsWith(".jsonl"))
      .map((e) => path.join(root, e));
  } catch {
    return [];
  }
}

async function scanFiles(
  files: string[],
  cutoffMs: number,
  parse: (fp: string) => Promise<Record<string, number>>,
): Promise<Map<string, number>> {
  const perDay = new Map<string, number>();
  for (const fp of files) {
    let stat;
    try {
      stat = await fs.stat(fp);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoffMs) continue;
    const cached = fileCache.get(fp);
    let fileDays: Record<string, number>;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      fileDays = cached.perDay;
    } else {
      fileDays = await parse(fp);
      fileCache.set(fp, { mtimeMs: stat.mtimeMs, size: stat.size, perDay: fileDays });
    }
    for (const [day, tokens] of Object.entries(fileDays)) {
      perDay.set(day, (perDay.get(day) ?? 0) + tokens);
    }
  }
  return perDay;
}

async function parseClaudeFile(fp: string): Promise<Record<string, number>> {
  let text: string;
  try {
    text = await fs.readFile(fp, "utf8");
  } catch {
    return {};
  }
  // Streamed responses rewrite the same message id with growing usage —
  // last occurrence wins so each API turn counts exactly once.
  const perMsg = new Map<string, { day: string; tokens: number }>();
  let anon = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const row = JSON.parse(line);
      const usage = row?.message?.usage;
      if (!usage || !row.timestamp) continue;
      const tokens =
        (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
      if (!tokens) continue;
      const key = row.message?.id ?? row.uuid ?? `anon-${anon++}`;
      perMsg.set(key, { day: dayKey(new Date(row.timestamp)), tokens });
    } catch {
      /* malformed line */
    }
  }
  const perDay: Record<string, number> = {};
  for (const { day, tokens } of perMsg.values()) perDay[day] = (perDay[day] ?? 0) + tokens;
  return perDay;
}

async function parseCodexFile(fp: string): Promise<Record<string, number>> {
  let text: string;
  try {
    text = await fs.readFile(fp, "utf8");
  } catch {
    return {};
  }
  // total_token_usage is cumulative per session — keep the last event only.
  let last: { ts?: string; tokens: number } | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("token_count")) continue;
    try {
      const row = JSON.parse(line);
      const tu = row?.payload?.info?.total_token_usage;
      if (!tu) continue;
      const tokens = Math.max(0, (tu.input_tokens ?? 0) - (tu.cached_input_tokens ?? 0)) + (tu.output_tokens ?? 0);
      last = { ts: row.timestamp, tokens };
    } catch {
      /* malformed line */
    }
  }
  if (!last || !last.tokens) return {};
  return { [dayKey(new Date(last.ts ?? Date.now()))]: last.tokens };
}

const CLI_PROVIDERS = new Set(["claude-code", "codex", "antigravity"]);

async function scanLedger(days: number): Promise<{ local: Map<string, number>; cloud: Map<string, number> }> {
  const local = new Map<string, number>();
  const cloud = new Map<string, number>();
  const db = path.join(os.homedir(), ".praxis-mind", "cost_ledger.sqlite");
  try {
    const sql = `SELECT date(ts,'localtime') AS day, provider, SUM(COALESCE(total_tokens,0)) AS tokens FROM llm_calls WHERE ts >= datetime('now','-${days} days') GROUP BY day, provider;`;
    const { stdout } = await execFileP("sqlite3", ["-json", "-readonly", db, sql], { timeout: 8000 });
    const rows: Array<{ day?: string; provider?: string | null; tokens?: number }> = stdout.trim()
      ? JSON.parse(stdout)
      : [];
    for (const r of rows) {
      if (!r.day || !r.tokens) continue;
      if (r.provider === "local") local.set(r.day, (local.get(r.day) ?? 0) + r.tokens);
      else if (!CLI_PROVIDERS.has(r.provider ?? "")) cloud.set(r.day, (cloud.get(r.day) ?? 0) + r.tokens);
    }
  } catch {
    /* sqlite3 unavailable or ledger locked — local/cloud report 0 */
  }
  return { local, cloud };
}

// Antigravity emits no real token telemetry, so its only number is the char/4
// estimate the Nexus server backfills into task_dispatches on dispatch close
// (tokens_estimated=1). Sum it per day from the board DB — read-only, same
// sqlite3-CLI pattern as the cost ledger. Failure (DB missing / locked) yields
// an empty map, so antigravity gracefully reports null and the UI shows "—".
async function scanAntigravityEstimate(days: number): Promise<Map<string, number>> {
  const perDay = new Map<string, number>();
  const db = process.env.NEXUS_DB_PATH || path.resolve(process.cwd(), "..", "nexus.db");
  try {
    const sql =
      `SELECT date(COALESCE(completed_at, started_at),'localtime') AS day, ` +
      `SUM(COALESCE(tokens,0)) AS tokens FROM task_dispatches ` +
      `WHERE executor='antigravity' AND tokens_estimated=1 ` +
      `AND COALESCE(completed_at, started_at) >= datetime('now','-${days} days') GROUP BY day;`;
    const { stdout } = await execFileP("sqlite3", ["-json", "-readonly", db, sql], { timeout: 8000 });
    const rows: Array<{ day?: string; tokens?: number }> = stdout.trim() ? JSON.parse(stdout) : [];
    for (const r of rows) {
      if (!r.day || !r.tokens) continue;
      perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.tokens);
    }
  } catch {
    /* board DB unavailable — antigravity estimate reports null */
  }
  return perDay;
}

export async function GET() {
  if (responseCache && Date.now() - responseCache.at < RESPONSE_TTL_MS) {
    return NextResponse.json(responseCache.body);
  }

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  const home = os.homedir();
  const [claudeFiles, codexFiles] = await Promise.all([
    listJsonl(path.join(home, ".claude", "projects")),
    listJsonl(path.join(home, ".codex", "sessions")),
  ]);
  const [claude, codex, ledger, agyEstimate] = await Promise.all([
    scanFiles(claudeFiles, cutoff.getTime(), parseClaudeFile),
    scanFiles(codexFiles, cutoff.getTime(), parseCodexFile),
    scanLedger(WINDOW_DAYS),
    scanAntigravityEstimate(WINDOW_DAYS),
  ]);

  const today = dayKey(now);
  const cutoffKey = dayKey(cutoff);
  const allDays = new Set<string>([
    today,
    ...claude.keys(),
    ...codex.keys(),
    ...ledger.local.keys(),
    ...ledger.cloud.keys(),
  ]);

  const days: DayRow[] = [...allDays]
    .filter((d) => d >= cutoffKey && d <= today)
    .sort()
    .map((date) => {
      const claudeCode = claude.get(date) ?? 0;
      const cdx = codex.get(date) ?? 0;
      const local = ledger.local.get(date) ?? 0;
      const cloud = ledger.cloud.get(date) ?? 0;
      return { date, claudeCode, codex: cdx, local, cloud, total: claudeCode + cdx + local + cloud };
    });

  const todayRow = days.find((d) => d.date === today) ?? {
    date: today,
    claudeCode: 0,
    codex: 0,
    local: 0,
    cloud: 0,
    total: 0,
  };
  const record = days.reduce((best, d) => (d.total > best.total ? d : best), todayRow);

  // Antigravity's char/4 estimate for today, surfaced in its own field so the
  // UI can render "~N" — never folded into any DayRow.total. Null when there
  // was no antigravity activity today (or the board DB was unreadable), so the
  // row stays "—" rather than an unfounded "~0".
  const agyToday = agyEstimate.get(today) ?? 0;

  const body = {
    today: todayRow,
    record: { date: record.date, total: record.total },
    days,
    antigravity: agyToday > 0 ? { today: agyToday, estimated: true as const } : null,
    windowDays: WINDOW_DAYS,
    computedAt: now.toISOString(),
  };
  responseCache = { at: Date.now(), body };
  return NextResponse.json(body);
}
