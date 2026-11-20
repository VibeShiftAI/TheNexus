/**
 * Test oracle: the token-usage accounting exactly as the route computed it
 * before the 2026-11-20 repair (36f0db2e dashboard/src/app/api/token-usage/
 * route.ts): whole-file readFile + split, per-file message-id dedupe, last
 * codex token_count per file. The parse functions are copied verbatim; only
 * the roots, clock and sqlite-backed inputs are parameters so tests can point
 * it at generated fixtures. The new service must produce the same body.
 */
import { promises as fs } from "fs";
import path from "path";

import type { LedgerTotals, TokenUsageBody, DayRow } from "../token-usage-service";

const WINDOW_DAYS = 30;

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
    const fileDays = await parse(fp);
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

function parseCodexFileWith(nowMs: number) {
  return async function parseCodexFile(fp: string): Promise<Record<string, number>> {
    let text: string;
    try {
      text = await fs.readFile(fp, "utf8");
    } catch {
      return {};
    }
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
    return { [dayKey(new Date(last.ts ?? nowMs))]: last.tokens };
  };
}

export async function originalTokenUsageBody(input: {
  claudeRoot: string;
  codexRoot: string;
  now: Date;
  ledger: LedgerTotals;
  agyEstimate: Map<string, number>;
}): Promise<TokenUsageBody> {
  const now = input.now;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
  cutoff.setHours(0, 0, 0, 0);
  const [claudeFiles, codexFiles] = await Promise.all([listJsonl(input.claudeRoot), listJsonl(input.codexRoot)]);
  const claude = await scanFiles(claudeFiles, cutoff.getTime(), parseClaudeFile);
  const codex = await scanFiles(codexFiles, cutoff.getTime(), parseCodexFileWith(now.getTime()));
  const { ledger, agyEstimate } = input;

  const today = dayKey(now);
  const cutoffKey = dayKey(cutoff);
  const allDays = new Set<string>([today, ...claude.keys(), ...codex.keys(), ...ledger.local.keys(), ...ledger.cloud.keys()]);
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
  const todayRow = days.find((d) => d.date === today) ?? { date: today, claudeCode: 0, codex: 0, local: 0, cloud: 0, total: 0 };
  const record = days.reduce((best, d) => (d.total > best.total ? d : best), todayRow);
  const agyToday = agyEstimate.get(today) ?? 0;
  return {
    today: todayRow,
    record: { date: record.date, total: record.total },
    days,
    antigravity: agyToday > 0 ? { today: agyToday, estimated: true as const } : null,
    windowDays: WINDOW_DAYS,
    computedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fixture line builders (synthetic data only, never real session content).

export function at(daysAgo: number, hour = 12, base = new Date()): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - daysAgo, hour, 0, 0);
  return d.toISOString();
}

export function claudeLine(opts: {
  id?: string | null;
  uuid?: string;
  ts?: string | null;
  input?: number;
  cacheCreate?: number;
  cacheRead?: number;
  output?: number;
  content?: string;
}): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    type: "message",
    content: [{ type: "text", text: opts.content ?? "synthetic reply" }],
    usage: {
      input_tokens: opts.input ?? 0,
      cache_creation_input_tokens: opts.cacheCreate ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      output_tokens: opts.output ?? 0,
    },
  };
  if (opts.id !== null) message.id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const row: Record<string, unknown> = { type: "assistant", message };
  if (opts.uuid) row.uuid = opts.uuid;
  if (opts.ts !== null) row.timestamp = opts.ts ?? at(0);
  return JSON.stringify(row);
}

export function claudeUserLine(text: string, ts = at(0)): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: ts });
}

export function codexTokenLine(opts: { ts?: string | null; input: number; cached?: number; output: number }): string {
  const row: Record<string, unknown> = {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: opts.input,
          cached_input_tokens: opts.cached ?? 0,
          output_tokens: opts.output,
        },
      },
    },
  };
  if (opts.ts !== null) row.timestamp = opts.ts ?? at(0);
  return JSON.stringify(row);
}

export function codexOtherLine(text: string, ts = at(0)): string {
  return JSON.stringify({ type: "response_item", payload: { type: "message", content: text }, timestamp: ts });
}

export async function writeLog(fp: string, lines: string[], opts: { trailingNewline?: boolean; mtimeDaysAgo?: number } = {}) {
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const body = lines.join("\n") + (opts.trailingNewline === false ? "" : "\n");
  await fs.writeFile(fp, body, "utf8");
  if (opts.mtimeDaysAgo !== undefined) {
    const t = new Date(Date.now() - opts.mtimeDaysAgo * 86_400_000);
    await fs.utimes(fp, t, t);
  }
}
