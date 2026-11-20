/**
 * Token-usage aggregation behind /api/token-usage (route.ts is only the HTTP
 * seam). Accounting is unchanged from the original route:
 *   - claude-code: ~/.claude/projects/**\/*.jsonl assistant entries
 *     (input + cache-creation + output; cache reads excluded). Streamed
 *     rewrites are deduped by message id within a file, last occurrence wins.
 *   - codex: ~/.codex/sessions/**\/*.jsonl, the last token_count event per
 *     session carries the cumulative usage ((input - cached) + output).
 *   - local + cloud API: the Praxis cost ledger (sqlite3 CLI, read-only).
 *   - antigravity: the char/4 estimate the Nexus server backfills into
 *     task_dispatches, reported in its own field and never in any total.
 *
 * What changed (incident 2026-11-20, NexusDashboard DOWN): every poll used to
 * start its own full scan, re-reading each changed session log whole
 * (readFile + split) and caching only after the scan finished. With five
 * pollers per page and 7.9 GiB of logs, scans overlapped by the dozen and the
 * dev server reached 19 GB and stopped answering its root route. Now:
 *   - one refresh at a time: concurrent requests join the refresh in flight;
 *     a stale body is served immediately while that refresh runs, and after a
 *     failed refresh the next request waits for a retry instead of being
 *     served old numbers;
 *   - files are read in fixed-size chunks and only lines carrying the source's
 *     marker are decoded and parsed, so no whole file is ever held in memory;
 *   - appends are parsed from the last complete line, but only after the whole
 *     committed prefix has been re-read and found byte-identical (SHA-256 of
 *     bytes [0, offset) kept per file); any other change reparses the file;
 *   - the per-message dedupe index is kept only for files still being written;
 *     cache entries for deleted or aged-out files are evicted every refresh.
 */
import { promises as fs, type Stats } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { createHash, type Hash } from "crypto";
import { promisify } from "util";

const execFileP = promisify(execFile);

// Both unchanged from the original route (36f0db2e route.ts:38-39).
export const WINDOW_DAYS = 30;
export const RESPONSE_TTL_MS = 30_000;

// Tuning constants. None affects accounting: each only trades memory, I/O or
// event-loop time. Sources are measurements on the real session-log tree
// (48,914 JSONL files, 8.0 GiB; Apple M4 Max, libuv's default 4 fs threads)
// on 2026-11-20, kept with the scripts that produced them in
// /Volumes/Projects/OperationsEvidence/nexus-dashboard-2026-11-20/repair-6802cb06/round2/
// (constants-basis.out.jsonl, verify-cost.out.jsonl).

/**
 * Read size per I/O and the one buffer a scan holds per source (two sources
 * scan at once: 2 MiB, plus the longest marked line when one spans reads).
 * Measured cold scan of a 386 MiB project directory, two rounds: 64 KiB
 * 332-592 ms, 256 KiB 255-312 ms, 1 MiB 236-239 ms, 4 MiB 189-205 ms. 1 MiB is
 * within 25% of 4 MiB's time at a quarter of its memory.
 */
const DEFAULT_CHUNK_BYTES = 1 << 20;
/**
 * In-flight stat() calls in the metadata sweep. With 4 libuv threads serving
 * all of the process's fs calls, this caps how many stats any other file
 * access (a page render, the dev server) can queue behind. Measured full
 * sweep of 48,914 files, best of two: 1 -> 536 ms, 4 -> 191 ms, 8 -> 128 ms,
 * 16 -> 108 ms, 32 -> 95 ms, 128 -> 84 ms; past 32 the saving is about 11 ms
 * per refresh.
 */
const STAT_CONCURRENCY = 32;
/**
 * A Claude file untouched this long drops its dedupe index and prefix digest;
 * a later append reparses it in full (exact, just slower once). The index
 * exists for streamed rewrites of one message id, and those land close
 * together: across 6,118 ids in files written in the last 24 h, the first and
 * last line of an id were p50 2.4 s, p99 38.1 s and at most 206 s apart, none
 * over an hour. Memory, measured at 279 bytes per indexed message: 1 h held
 * 43 files and 150 messages; 24 h would hold 2,513 files and 6,146 messages,
 * and SHA-256 each of those files' 429 MiB on every full parse.
 */
const DEFAULT_HOT_INDEX_MS = 60 * 60_000;
/**
 * Cache hits folded between event-loop yields during a sweep. Budget: each
 * synchronous slice stays under 1 ms on a warm cache (below the 1.0-1.3 ms
 * event-loop delay p50 of the same runs), and when cached entries have been
 * paged out a slice still costs at most 512 page faults. Measured warm sweep
 * of 48,369 cached files, two rounds, slice p50 / max: 64 -> 0.03-0.04 /
 * 0.39-0.44 ms, 512 -> 0.22-0.25 / 0.52-0.55 ms, 2048 -> 0.91-0.99 /
 * 1.36-1.41 ms, 8192 -> 3.5-3.7 / 4.3-4.5 ms. The second round's sweep took
 * 443-474 ms at every interval and 444 ms never yielding, so yielding costs
 * nothing measurable (the first round, run straight after the cold scan,
 * took 1,625 ms for its first refresh and 441-618 ms for the rest).
 */
const YIELD_EVERY_FILES = 512;

export interface DayRow {
  date: string;
  claudeCode: number;
  codex: number;
  local: number;
  cloud: number;
  total: number;
}

export interface TokenUsageBody {
  today: DayRow;
  record: { date: string; total: number };
  days: DayRow[];
  antigravity: { today: number; estimated: true } | null;
  windowDays: number;
  computedAt: string;
}

export interface LedgerTotals {
  local: Map<string, number>;
  cloud: Map<string, number>;
}

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Per-line parsers: the exact field logic of the original whole-file parsers.

const ANON = Symbol("anonymous-entry");

interface ClaudeEntry {
  key: unknown;
  day: string;
  tokens: number;
}

function parseClaudeLine(line: string): ClaudeEntry | null {
  try {
    const row = JSON.parse(line);
    const usage = row?.message?.usage;
    if (!usage || !row.timestamp) return null;
    const tokens: number =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    if (!tokens) return null;
    return { key: row.message?.id ?? row.uuid ?? ANON, day: dayKey(new Date(row.timestamp)), tokens };
  } catch {
    return null; // malformed line
  }
}

interface CodexEvent {
  ts: unknown;
  tokens: number;
}

function parseCodexLine(line: string): CodexEvent | null {
  try {
    const row = JSON.parse(line);
    const tu = row?.payload?.info?.total_token_usage;
    if (!tu) return null;
    const tokens: number =
      Math.max(0, (tu.input_tokens ?? 0) - (tu.cached_input_tokens ?? 0)) + (tu.output_tokens ?? 0);
    return { ts: row.timestamp, tokens };
  } catch {
    return null; // malformed line
  }
}

/**
 * How one log family is read. `commit` folds a complete line into the file's
 * state; `result` turns that state, plus a provisional unterminated last line
 * (still being written), into the file's per-day tokens.
 */
interface LogSource<S> {
  marker: Buffer;
  init(): S;
  commit(state: S, line: string): void;
  result(state: S, tail: string | null, nowMs: number): Record<string, number>;
  /** False when the state is worth dropping once the file goes idle. */
  retainWhenIdle: boolean;
  indexSize(state: S): number;
}

interface ClaudeState {
  msgs: Map<unknown, { day: string; tokens: number }>;
  anon: number;
}

const CLAUDE_SOURCE: LogSource<ClaudeState> = {
  marker: Buffer.from('"usage"'),
  init: () => ({ msgs: new Map(), anon: 0 }),
  commit(state, line) {
    const entry = parseClaudeLine(line);
    if (!entry) return;
    const key = entry.key === ANON ? `anon-${state.anon++}` : entry.key;
    state.msgs.set(key, { day: entry.day, tokens: entry.tokens });
  },
  result(state, tail) {
    const pending = tail === null ? null : parseClaudeLine(tail);
    const pendingKey = pending ? (pending.key === ANON ? `anon-${state.anon}` : pending.key) : undefined;
    const perDay: Record<string, number> = {};
    for (const [key, { day, tokens }] of state.msgs) {
      if (pending && key === pendingKey) continue; // the newer line replaces it
      perDay[day] = (perDay[day] ?? 0) + tokens;
    }
    if (pending) perDay[pending.day] = (perDay[pending.day] ?? 0) + pending.tokens;
    return perDay;
  },
  retainWhenIdle: false,
  indexSize: (state) => state.msgs.size,
};

interface CodexState {
  last: CodexEvent | null;
}

const CODEX_SOURCE: LogSource<CodexState> = {
  marker: Buffer.from("token_count"),
  init: () => ({ last: null }),
  commit(state, line) {
    const event = parseCodexLine(line);
    if (event) state.last = event;
  },
  result(state, tail, nowMs) {
    const last = (tail === null ? null : parseCodexLine(tail)) ?? state.last;
    if (!last || !last.tokens) return {};
    return { [dayKey(new Date((last.ts as string | number | undefined) ?? nowMs))]: last.tokens };
  },
  retainWhenIdle: true,
  indexSize: () => 0,
};

// ---------------------------------------------------------------------------
// Chunked line scanning.

interface ScanMeter {
  bytesRead: number;
  /** Bytes re-read only to prove a committed prefix unchanged (part of bytesRead). */
  verifiedBytes: number;
  /** Largest single buffer allocated for reading (a chunk or one re-read line). */
  peakHeldBytes: number;
}

const EMPTY = Buffer.alloc(0);

/** Feeds bytes [start, end) to `hash` one chunk at a time; false if the file ended early. */
async function hashRange(
  handle: fs.FileHandle,
  start: number,
  end: number,
  hash: Hash,
  chunkBytes: number,
  meter: ScanMeter,
): Promise<boolean> {
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, end - start)));
  meter.peakHeldBytes = Math.max(meter.peakHeldBytes, buf.length);
  let pos = start;
  while (pos < end) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, end - pos), pos);
    if (bytesRead === 0) return false;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
    meter.bytesRead += bytesRead;
    meter.verifiedBytes += bytesRead;
  }
  return true;
}

async function readRange(handle: fs.FileHandle, start: number, end: number, meter: ScanMeter): Promise<Buffer> {
  const out = Buffer.allocUnsafe(Math.max(0, end - start));
  meter.peakHeldBytes = Math.max(meter.peakHeldBytes, out.length);
  let filled = 0;
  while (filled < out.length) {
    const { bytesRead } = await handle.read(out, filled, out.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  meter.bytesRead += filled;
  return filled === out.length ? out : out.subarray(0, filled);
}

/**
 * Reads [from, to) in chunks and calls onLine for every complete line that
 * contains `marker`, exactly the lines the original `text.split("\n")` loop
 * would have parsed. Lines without the marker are never decoded or kept; a
 * marked line that spans reads is re-read from disk on its own, so memory is
 * bounded by the chunk size plus the longest marked line, never the file.
 * Returns the offset just past the last newline and, when the file ends in an
 * unterminated marked line, that line's text (for a provisional parse).
 *
 * `hash`, when given, already holds bytes [0, from); every byte read is added
 * to it, and `committedDigest` is its digest over exactly [0, committedEnd)
 * (snapshotted at the last newline of each chunk), which the next refresh
 * must reproduce before it may resume at committedEnd.
 */
async function scanLines(
  handle: fs.FileHandle,
  from: number,
  to: number,
  marker: Buffer,
  onLine: (line: string) => void,
  chunkBytes: number,
  meter: ScanMeter,
  hash: Hash | null,
): Promise<{ committedEnd: number; tail: string | null; committedDigest: Buffer | null }> {
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, to - from)));
  meter.peakHeldBytes = Math.max(meter.peakHeldBytes, buf.length);
  const overlap = marker.length - 1;
  let pos = from;
  let lineStart = from;
  let lineMarked = false;
  // Last (marker.length - 1) bytes of the current, still unmarked line, so a
  // marker split across two reads is still seen.
  let probe: Buffer = EMPTY;
  // Hash state over [0, lineStart): lineStart only ever moves to just past a newline.
  let committedHash = hash?.copy() ?? null;

  while (pos < to) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, to - pos), pos);
    if (bytesRead === 0) {
      to = pos; // the file shrank under us; the next refresh sees the new size
      break;
    }
    const chunkStart = pos;
    const chunk = buf.subarray(0, bytesRead);
    pos += bytesRead;
    meter.bytesRead += bytesRead;
    if (hash) {
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) hash.update(chunk);
      else {
        hash.update(chunk.subarray(0, lastNl + 1));
        committedHash = hash.copy();
        hash.update(chunk.subarray(lastNl + 1));
      }
    }

    const carried = probe;
    probe = EMPTY;
    if (!lineMarked && carried.length > 0) {
      const head = chunk.subarray(0, Math.min(chunk.length, overlap));
      if (Buffer.concat([carried, head]).indexOf(marker) !== -1) lineMarked = true;
    }

    let i = 0;
    for (;;) {
      if (!lineMarked) {
        const m = chunk.indexOf(marker, i);
        if (m === -1) {
          const nl = chunk.lastIndexOf(0x0a);
          if (nl >= i) lineStart = chunkStart + nl + 1;
          const part = chunk.subarray(Math.max(0, lineStart - chunkStart));
          probe =
            lineStart < chunkStart && part.length < overlap
              ? Buffer.concat([carried, part]).subarray(-overlap)
              : Buffer.from(part.subarray(Math.max(0, part.length - overlap)));
          break;
        }
        const nl = chunk.lastIndexOf(0x0a, m);
        if (nl >= i) lineStart = chunkStart + nl + 1;
        lineMarked = true;
        i = m + marker.length;
      }
      const end = chunk.indexOf(0x0a, i);
      if (end === -1) break; // the marked line continues past this read
      const lineEnd = chunkStart + end;
      const text =
        lineStart >= chunkStart
          ? chunk.toString("utf8", lineStart - chunkStart, end)
          : (await readRange(handle, lineStart, lineEnd, meter)).toString("utf8");
      onLine(text);
      lineStart = lineEnd + 1;
      lineMarked = false;
      i = end + 1;
    }
  }

  const tail = lineMarked && lineStart < to ? (await readRange(handle, lineStart, to, meter)).toString("utf8") : null;
  return { committedEnd: lineStart, tail, committedDigest: committedHash?.digest() ?? null };
}

// ---------------------------------------------------------------------------
// Per-file cache with append-only resume.

interface FileEntry<S> {
  ino: number;
  mtimeMs: number;
  size: number;
  /** Offset just past the last complete line folded into `state`. */
  offset: number;
  /**
   * SHA-256 of bytes [0, offset). A changed file resumes at `offset` only if
   * re-hashing that whole prefix reproduces this digest; null means reparse.
   */
  prefixDigest: Buffer | null;
  /** Null once dropped (idle file) or after a read error: the next change reparses. */
  state: S | null;
  perDay: Record<string, number>;
}

interface ParseCounters extends ScanMeter {
  fullParses: number;
  incrementalParses: number;
}

interface ScanSettings {
  chunkBytes: number;
  hotIndexMs: number;
}

async function parseFile<S>(
  source: LogSource<S>,
  fp: string,
  st: Stats,
  prev: FileEntry<S> | undefined,
  nowMs: number,
  settings: ScanSettings,
  counters: ParseCounters,
): Promise<FileEntry<S>> {
  const base = { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
  // An idle Claude file drops its state right after this parse (scanSource),
  // so it can never resume and needs no prefix digest.
  const mayResumeLater = source.retainWhenIdle || nowMs - st.mtimeMs <= settings.hotIndexMs;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(fp, "r");
    // Resume only when the whole committed prefix is byte-identical. A
    // matching inode, size or boundary sample proves nothing about the bytes
    // before it (an earlier entry can be rewritten in place), so the prefix is
    // re-read and hashed in full; only the appended lines are then parsed.
    let resumed: { state: S; offset: number; hash: Hash } | null = null;
    if (prev && prev.state !== null && prev.prefixDigest && prev.ino === st.ino && st.size >= prev.offset) {
      const hash = createHash("sha256");
      const complete = await hashRange(handle, 0, prev.offset, hash, settings.chunkBytes, counters);
      if (complete && hash.copy().digest().equals(prev.prefixDigest)) {
        resumed = { state: prev.state, offset: prev.offset, hash };
      }
    }
    const state = resumed ? resumed.state : source.init();
    if (resumed) counters.incrementalParses++;
    else counters.fullParses++;
    const { committedEnd, tail, committedDigest } = await scanLines(
      handle,
      resumed ? resumed.offset : 0,
      st.size,
      source.marker,
      (line) => source.commit(state, line),
      settings.chunkBytes,
      counters,
      resumed ? resumed.hash : mayResumeLater ? createHash("sha256") : null,
    );
    return {
      ...base,
      offset: committedEnd,
      prefixDigest: committedDigest,
      state,
      perDay: source.result(state, tail, nowMs),
    };
  } catch {
    // Unreadable (vanished, permissions, I/O error): contributes nothing until
    // it changes again, as the original readFile failure did.
    return { ...base, offset: 0, prefixDigest: null, state: null, perDay: {} };
  } finally {
    await handle?.close().catch(() => {});
  }
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function scanSource<S>(
  source: LogSource<S>,
  root: string,
  cache: Map<string, FileEntry<S>>,
  cutoffMs: number,
  nowMs: number,
  settings: ScanSettings,
  counters: ParseCounters,
): Promise<Map<string, number>> {
  const files = await listJsonl(root);
  const stats = await mapLimit(files, STAT_CONCURRENCY, (fp) => fs.stat(fp).catch(() => null));
  const live = new Map<string, FileEntry<S>>();
  const perDay = new Map<string, number>();
  for (let k = 0; k < files.length; k++) {
    // Unchanged files never await, so give the event loop a turn every so
    // often: tens of thousands of cache hits (possibly paged out by the OS)
    // must not hold up the dashboard's other requests.
    if (k > 0 && k % YIELD_EVERY_FILES === 0) await new Promise((resolve) => setImmediate(resolve));
    const fp = files[k];
    const st = stats[k];
    if (!st || !st.isFile() || st.mtimeMs < cutoffMs) continue;
    let entry = cache.get(fp);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = await parseFile(source, fp, st, entry, nowMs, settings, counters);
    }
    if (entry.state !== null && !source.retainWhenIdle && nowMs - st.mtimeMs > settings.hotIndexMs) {
      entry.state = null;
      entry.prefixDigest = null;
    }
    live.set(fp, entry);
    for (const [day, tokens] of Object.entries(entry.perDay)) perDay.set(day, (perDay.get(day) ?? 0) + tokens);
  }
  cache.clear();
  for (const [fp, entry] of live) cache.set(fp, entry);
  return perDay;
}

// ---------------------------------------------------------------------------
// SQLite-backed sources (unchanged from the original route).

const CLI_PROVIDERS = new Set(["claude-code", "codex", "antigravity"]);

export async function scanLedger(days: number, db: string): Promise<LedgerTotals> {
  const local = new Map<string, number>();
  const cloud = new Map<string, number>();
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
    /* sqlite3 unavailable or ledger locked: local/cloud report 0 */
  }
  return { local, cloud };
}

// Antigravity emits no real token telemetry, so its only number is the char/4
// estimate the Nexus server backfills into task_dispatches on dispatch close
// (tokens_estimated=1). Failure (DB missing / locked) yields an empty map, so
// antigravity reports null and the UI shows its dash placeholder.
export async function scanAntigravityEstimate(days: number): Promise<Map<string, number>> {
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
    /* board DB unavailable: antigravity estimate reports null */
  }
  return perDay;
}

// ---------------------------------------------------------------------------
// Response assembly (unchanged from the original route).

function assembleBody(
  now: Date,
  cutoff: Date,
  claude: Map<string, number>,
  codex: Map<string, number>,
  ledger: LedgerTotals,
  agyEstimate: Map<string, number>,
): TokenUsageBody {
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

  // Antigravity's char/4 estimate for today, in its own field so the UI can
  // render "~N"; never folded into any DayRow.total. Null when there was no
  // antigravity activity today (or the board DB was unreadable).
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
// The service: one refresh in flight, stale-while-refreshing, retry on failure.

export interface TokenUsageServiceOptions {
  claudeRoot: string;
  codexRoot: string;
  readLedger: (days: number) => Promise<LedgerTotals>;
  readAntigravityEstimate: (days: number) => Promise<Map<string, number>>;
  now?: () => Date;
  ttlMs?: number;
  chunkBytes?: number;
  hotIndexMs?: number;
  onRefreshError?: (err: unknown) => void;
}

export interface TokenUsageMetrics {
  refreshesStarted: number;
  refreshesSucceeded: number;
  refreshesFailed: number;
  refreshInFlight: boolean;
  lastRefreshMs: number | null;
  fullParses: number;
  incrementalParses: number;
  bytesRead: number;
  /** Of bytesRead, the bytes re-read to prove committed prefixes unchanged. */
  verifiedBytes: number;
  peakHeldBytes: number;
  cachedFiles: number;
  indexedFiles: number;
  indexedMessages: number;
}

export interface TokenUsageService {
  /** Fresh body from cache, stale body while a refresh runs, or the shared refresh's result. */
  getUsage(): Promise<TokenUsageBody>;
  /** Starts a refresh, or joins the one already in flight. */
  refresh(): Promise<TokenUsageBody>;
  /** Resolves once no refresh is in flight (settled either way). */
  idle(): Promise<void>;
  metrics(): TokenUsageMetrics;
}

export function createTokenUsageService(options: TokenUsageServiceOptions): TokenUsageService {
  const clock = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? RESPONSE_TTL_MS;
  const settings: ScanSettings = {
    chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    hotIndexMs: options.hotIndexMs ?? DEFAULT_HOT_INDEX_MS,
  };
  const onRefreshError =
    options.onRefreshError ??
    ((err: unknown) => console.error(`[token-usage] refresh failed: ${err instanceof Error ? err.message : String(err)}`));

  const claudeCache = new Map<string, FileEntry<ClaudeState>>();
  const codexCache = new Map<string, FileEntry<CodexState>>();
  const counters: ParseCounters = {
    bytesRead: 0,
    verifiedBytes: 0,
    peakHeldBytes: 0,
    fullParses: 0,
    incrementalParses: 0,
  };
  let cached: { at: number; body: TokenUsageBody } | null = null;
  let inflight: Promise<TokenUsageBody> | null = null;
  let lastRefreshFailed = false;
  let started = 0;
  let succeeded = 0;
  let failed = 0;
  let lastRefreshMs: number | null = null;

  async function compute(): Promise<TokenUsageBody> {
    const now = clock();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    cutoff.setHours(0, 0, 0, 0);
    // allSettled, not all: a refresh must not settle (and let the next one
    // start) while one of its scans is still walking the shared file caches.
    const [claude, codex, ledger, agyEstimate] = await Promise.allSettled([
      scanSource(CLAUDE_SOURCE, options.claudeRoot, claudeCache, cutoff.getTime(), now.getTime(), settings, counters),
      scanSource(CODEX_SOURCE, options.codexRoot, codexCache, cutoff.getTime(), now.getTime(), settings, counters),
      options.readLedger(WINDOW_DAYS),
      options.readAntigravityEstimate(WINDOW_DAYS),
    ]);
    for (const part of [claude, codex, ledger, agyEstimate]) if (part.status === "rejected") throw part.reason;
    return assembleBody(
      now,
      cutoff,
      (claude as PromiseFulfilledResult<Map<string, number>>).value,
      (codex as PromiseFulfilledResult<Map<string, number>>).value,
      (ledger as PromiseFulfilledResult<LedgerTotals>).value,
      (agyEstimate as PromiseFulfilledResult<Map<string, number>>).value,
    );
  }

  function refresh(): Promise<TokenUsageBody> {
    if (inflight) return inflight;
    started++;
    const t0 = performance.now();
    inflight = compute()
      .then(
        (body) => {
          cached = { at: clock().getTime(), body };
          lastRefreshFailed = false;
          succeeded++;
          return body;
        },
        (err: unknown) => {
          lastRefreshFailed = true;
          failed++;
          onRefreshError(err);
          throw err;
        },
      )
      .finally(() => {
        lastRefreshMs = performance.now() - t0;
        inflight = null;
      });
    return inflight;
  }

  return {
    async getUsage() {
      if (cached && clock().getTime() - cached.at < ttlMs) return cached.body;
      if (cached && !lastRefreshFailed) {
        refresh().catch(() => {}); // logged once by refresh(); the stale body answers now
        return cached.body;
      }
      return refresh();
    },
    refresh,
    async idle() {
      while (inflight) await inflight.catch(() => {});
    },
    metrics() {
      let indexedFiles = 0;
      let indexedMessages = 0;
      for (const entry of claudeCache.values()) {
        if (entry.state === null) continue;
        indexedFiles++;
        indexedMessages += CLAUDE_SOURCE.indexSize(entry.state);
      }
      return {
        refreshesStarted: started,
        refreshesSucceeded: succeeded,
        refreshesFailed: failed,
        refreshInFlight: inflight !== null,
        lastRefreshMs,
        fullParses: counters.fullParses,
        incrementalParses: counters.incrementalParses,
        bytesRead: counters.bytesRead,
        verifiedBytes: counters.verifiedBytes,
        peakHeldBytes: counters.peakHeldBytes,
        cachedFiles: claudeCache.size + codexCache.size,
        indexedFiles,
        indexedMessages,
      };
    },
  };
}

/** Production wiring: the CLI log roots and cost ledger under the OS home. */
export function defaultTokenUsageOptions(home = os.homedir()): TokenUsageServiceOptions {
  const ledgerDb = path.join(home, ".praxis-mind", "cost_ledger.sqlite");
  return {
    claudeRoot: path.join(home, ".claude", "projects"),
    codexRoot: path.join(home, ".codex", "sessions"),
    readLedger: (days) => scanLedger(days, ledgerDb),
    readAntigravityEstimate: scanAntigravityEstimate,
  };
}

// Kept on globalThis so a dev-server re-evaluation of this module joins the
// existing cache and in-flight refresh instead of starting a second scan.
const SHARED_KEY = Symbol.for("thenexus.dashboard.token-usage-service.v2");

export function sharedTokenUsageService(): TokenUsageService {
  const slot = globalThis as unknown as Record<symbol, TokenUsageService | undefined>;
  return (slot[SHARED_KEY] ??= createTokenUsageService(defaultTokenUsageOptions()));
}
