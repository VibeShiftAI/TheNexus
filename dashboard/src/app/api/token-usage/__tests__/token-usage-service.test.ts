// Regression tests for the token-usage service behind /api/token-usage
// (incident 2026-11-20: overlapping full scans stalled the dashboard).
// All data is generated here; no real session log is read.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { createTokenUsageService, dayKey, type LedgerTotals, type TokenUsageServiceOptions } from "../token-usage-service.ts";
import {
  at,
  claudeLine,
  claudeUserLine,
  codexOtherLine,
  codexTokenLine,
  originalTokenUsageBody,
  writeLog,
} from "./token-usage-oracle.ts";

const scratchRoots: string[] = [];
after(async () => {
  for (const dir of scratchRoots) await fs.rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "token-usage-test-"));
  scratchRoots.push(dir);
  return dir;
}

const TODAY = dayKey(new Date());
const YESTERDAY = dayKey(new Date(Date.now() - 86_400_000));

function fixedLedger(): LedgerTotals {
  return { local: new Map([[TODAY, 1000]]), cloud: new Map([[YESTERDAY, 2000]]) };
}

interface Harness {
  root: string;
  claudeRoot: string;
  codexRoot: string;
  clock: { ms: number };
  ledger: LedgerTotals;
  agy: Map<string, number>;
  options(extra?: Partial<TokenUsageServiceOptions>): TokenUsageServiceOptions;
  oracle(): ReturnType<typeof originalTokenUsageBody>;
}

async function harness(): Promise<Harness> {
  const root = await scratch();
  const h: Harness = {
    root,
    claudeRoot: path.join(root, ".claude", "projects"),
    codexRoot: path.join(root, ".codex", "sessions"),
    clock: { ms: Date.now() },
    ledger: fixedLedger(),
    agy: new Map([[TODAY, 333]]),
    options(extra = {}) {
      return {
        claudeRoot: h.claudeRoot,
        codexRoot: h.codexRoot,
        readLedger: async () => h.ledger,
        readAntigravityEstimate: async () => h.agy,
        now: () => new Date(h.clock.ms),
        onRefreshError: () => {},
        ...extra,
      };
    },
    oracle() {
      return originalTokenUsageBody({
        claudeRoot: h.claudeRoot,
        codexRoot: h.codexRoot,
        now: new Date(h.clock.ms),
        ledger: h.ledger,
        agyEstimate: h.agy,
      });
    },
  };
  return h;
}

/** The accounting fixture: every dedupe / cumulative / exclusion rule the route applies. */
async function writeAccountingFixture(h: Harness) {
  await writeLog(path.join(h.claudeRoot, "proj-a", "s1.jsonl"), [
    claudeUserLine("hello"),
    // A marker-bearing line that is not an assistant usage entry.
    JSON.stringify({ type: "user", toolUseResult: { usage: "not tokens" }, timestamp: at(0) }),
    // msg_A streamed twice: the last occurrence wins (35 then 80 -> 80). Cache reads never count.
    claudeLine({ id: "msg_A", input: 10, cacheCreate: 20, output: 5, cacheRead: 1000 }),
    claudeLine({ id: "msg_A", input: 10, cacheCreate: 20, output: 50, cacheRead: 1000 }),
    claudeLine({ id: "msg_B", ts: at(1), input: 7, output: 3 }),
    // No message id: keyed by uuid, last wins (9 then 11 -> 11).
    claudeLine({ id: null, uuid: "u-1", input: 9 }),
    claudeLine({ id: null, uuid: "u-1", input: 11 }),
    // Neither id nor uuid: each counts on its own (4 + 6).
    claudeLine({ id: null, input: 4 }),
    claudeLine({ id: null, output: 6 }),
    // A zero-token rewrite of msg_A is ignored, not an override.
    claudeLine({ id: "msg_A", input: 0, output: 0 }),
    claudeLine({ id: "msg_C", ts: null, input: 500 }), // no timestamp: ignored
    claudeLine({ id: "msg_D", cacheRead: 500 }), // cache reads only: ignored
    '{"type":"assistant","message":{"id":"msg_E","usage":{"input_tokens":', // malformed
  ]);
  // Same message id in another file counts again: dedupe is per file.
  await writeLog(path.join(h.claudeRoot, "proj-a", "nested", "deeper", "s2.jsonl"), [claudeLine({ id: "msg_A", input: 15 })]);
  // Outside the 30-day window by mtime: excluded entirely.
  await writeLog(path.join(h.claudeRoot, "proj-old", "old.jsonl"), [claudeLine({ id: "msg_old", input: 9999 })], { mtimeDaysAgo: 40 });
  // Not a .jsonl file: never read.
  await writeLog(path.join(h.claudeRoot, "proj-a", "notes.txt"), [claudeLine({ id: "msg_txt", input: 9999 })]);

  // Codex: the last token_count event carries cumulative usage, (input - cached) + output.
  await writeLog(path.join(h.codexRoot, "2026", "11", "19", "rollout-1.jsonl"), [
    codexOtherLine("session start"),
    codexTokenLine({ input: 100, cached: 40, output: 10 }),
    '{"type":"event_msg","payload":{"type":"token_count","info":', // malformed
    codexTokenLine({ input: 300, cached: 100, output: 30 }),
    codexOtherLine("done"),
  ]);
  // Last event reports zero: the file contributes nothing, earlier events notwithstanding.
  await writeLog(path.join(h.codexRoot, "2026", "11", "19", "rollout-2.jsonl"), [
    codexTokenLine({ input: 400, output: 40 }),
    codexTokenLine({ input: 0, output: 0 }),
  ]);
  // Last event has no timestamp: dated by the clock (today).
  await writeLog(path.join(h.codexRoot, "rollout-3.jsonl"), [codexTokenLine({ ts: null, input: 50, output: 5 })]);
}

test("accounting and response fields match the original route exactly", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  const service = createTokenUsageService(h.options());
  const body = await service.getUsage();

  assert.deepEqual(Object.keys(body), ["today", "record", "days", "antigravity", "windowDays", "computedAt"]);
  assert.deepEqual(body.today, { date: TODAY, claudeCode: 116, codex: 285, local: 1000, cloud: 0, total: 1401 });
  assert.deepEqual(
    body.days.find((d) => d.date === YESTERDAY),
    { date: YESTERDAY, claudeCode: 10, codex: 0, local: 0, cloud: 2000, total: 2010 },
  );
  assert.deepEqual(body.record, { date: YESTERDAY, total: 2010 });
  // Antigravity's estimate stays in its own field and out of every total.
  assert.deepEqual(body.antigravity, { today: 333, estimated: true });
  assert.ok(body.days.every((d) => d.total === d.claudeCode + d.codex + d.local + d.cloud));
  assert.equal(body.windowDays, 30);
  assert.equal(body.computedAt, new Date(h.clock.ms).toISOString());

  assert.deepEqual(body, await h.oracle());
});

test("no antigravity activity today reports null, not an estimated zero", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  h.agy = new Map([[YESTERDAY, 50]]);
  const body = await createTokenUsageService(h.options()).getUsage();
  assert.equal(body.antigravity, null);
  assert.deepEqual(body, await h.oracle());
});

test("line splitting is exact at every read size, including markers split across reads", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  // Adversarial file: markers at varied offsets, several markers in one line,
  // short and long lines, CRLF endings, blank lines and an unterminated final line.
  const lines: string[] = [];
  for (let n = 0; n < 60; n++) {
    lines.push("x".repeat(n));
    const entry = claudeLine({ id: `msg_${n % 17}`, input: n + 1, output: n % 5, content: "y".repeat(n * 3) });
    // Every third line carries the marker twice (an extra top-level "usage" key).
    lines.push(n % 3 === 0 ? `{"usage":${n},` + entry.slice(1) : entry);
    if (n % 7 === 0) lines.push("");
    if (n % 11 === 0) lines.push(claudeLine({ id: `crlf_${n}`, input: 3 }) + "\r");
  }
  lines.push(claudeLine({ id: "tail_msg", input: 42 }));
  const adversarial = path.join(h.claudeRoot, "proj-b", "adversarial.jsonl");
  const late = claudeLine({ id: "late", input: 9 });
  // Finishes the unterminated tail, rewrites msg_3, then leaves a half-written line; the second piece completes it.
  const appends = ["\n" + claudeLine({ id: "msg_3", input: 1000 }) + "\n" + late.slice(0, 30), late.slice(30) + "\n"];

  for (const chunkBytes of [1, 2, 3, 6, 7, 8, 13, 31, 64, 257, 4096, 1 << 20]) {
    await writeLog(adversarial, lines, { trailingNewline: false });
    const service = createTokenUsageService(h.options({ chunkBytes, ttlMs: 0 }));
    assert.deepEqual(await service.refresh(), await h.oracle(), `chunkBytes=${chunkBytes}`);
    // Each append resumes only if the prefix digest snapshotted mid-chunk
    // equals a fresh hash of the whole prefix, at every read size.
    for (const piece of appends) {
      await fs.appendFile(adversarial, piece);
      const before = service.metrics();
      const body = await service.refresh();
      const after = service.metrics();
      assert.deepEqual(body, await h.oracle(), `chunkBytes=${chunkBytes} after append`);
      assert.equal(after.incrementalParses - before.incrementalParses, 1, `chunkBytes=${chunkBytes} resumed`);
      assert.equal(after.fullParses - before.fullParses, 0, `chunkBytes=${chunkBytes} no reparse`);
    }
  }
});

test("large and malformed JSONL is streamed without holding the file in memory", async () => {
  const h = await harness();
  const fp = path.join(h.claudeRoot, "proj-big", "big.jsonl");
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const parts: Buffer[] = [];
  const add = (s: string | Buffer) => parts.push(typeof s === "string" ? Buffer.from(s + "\n", "utf8") : s);
  add("﻿" + claudeLine({ id: "bom_first", input: 77 })); // BOM-prefixed: unparseable, as before
  const filler = claudeUserLine("f".repeat(1000));
  for (let n = 0; n < 20_000; n++) {
    add(filler);
    if (n % 500 === 0) add(claudeLine({ id: `big_${n}`, ts: at(n % 3), input: n + 1, output: 2 }));
  }
  add(claudeUserLine("g".repeat(5 * 1024 * 1024))); // 5 MiB line without the marker
  add(claudeLine({ id: "giant", input: 1234, content: "h".repeat(3 * 1024 * 1024) })); // 3 MiB marked line
  // Invalid UTF-8 inside a usage line decodes to U+FFFD and still parses.
  const head = Buffer.from(claudeLine({ id: "badutf8", input: 8, content: "@@" }).replace("@@", "<>"), "utf8");
  const split = head.indexOf("<>");
  parts.push(Buffer.concat([head.subarray(0, split), Buffer.from([0xc3, 0x28, 0xff]), head.subarray(split + 2), Buffer.from("\n")]));
  add(Buffer.from([0x00, 0xff, 0xfe, 0x22, 0x75, 0x73, 0x61, 0x67, 0x65, 0x22, 0x0a])); // binary junk carrying the marker
  add('{"message":{"usage":{"input_tokens":5}},"timestamp":"' + at(0) + '"'); // unbalanced: malformed
  parts.push(Buffer.from(claudeLine({ id: "unterminated", input: 99 }), "utf8")); // final line without newline
  await fs.writeFile(fp, Buffer.concat(parts));
  const size = (await fs.stat(fp)).size;
  assert.ok(size > 24 * 1024 * 1024, `fixture is ${size} bytes`);

  const service = createTokenUsageService(h.options());
  const body = await service.getUsage();
  assert.deepEqual(body, await h.oracle());

  const m = service.metrics();
  // One 1 MiB read buffer plus the single 3 MiB marked line re-read on its
  // own: never the 25 MiB file, and never the 5 MiB line without the marker.
  assert.ok(m.peakHeldBytes <= 3 * 1024 * 1024 + 4096, `peakHeldBytes=${m.peakHeldBytes}`);
  assert.ok(m.peakHeldBytes < 5 * 1024 * 1024);
  assert.equal(m.fullParses, 1);
});

test("concurrent cold requests share one refresh and one parse per file", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let ledgerCalls = 0;
  const service = createTokenUsageService(
    h.options({
      readLedger: async () => {
        ledgerCalls++;
        await gate; // hold the refresh open while more requests arrive
        return h.ledger;
      },
    }),
  );

  const early = Array.from({ length: 25 }, () => service.getUsage());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const late = Array.from({ length: 25 }, () => service.getUsage());
  assert.equal(service.metrics().refreshInFlight, true);
  release();
  const bodies = await Promise.all([...early, ...late]);

  for (const body of bodies) assert.equal(body, bodies[0]); // the same object: one computation
  const m = service.metrics();
  assert.equal(m.refreshesStarted, 1);
  assert.equal(ledgerCalls, 1);
  assert.equal(m.fullParses, 5); // 2 claude + 3 codex files in the window, each parsed once
  assert.equal(m.refreshInFlight, false);
  assert.deepEqual(bodies[0], await h.oracle());

  // Inside the TTL nothing is rescanned.
  h.clock.ms += 10_000;
  assert.equal(await service.getUsage(), bodies[0]);
  assert.equal(service.metrics().refreshesStarted, 1);
});

test("stale requests answer from cache at once while exactly one refresh runs", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  const service = createTokenUsageService(h.options());
  const first = await service.getUsage();

  const s1 = path.join(h.claudeRoot, "proj-a", "s1.jsonl");
  await fs.appendFile(s1, claudeLine({ id: "msg_new", input: 1000 }) + "\n");
  h.clock.ms += 31_000; // past the 30 s TTL

  const stale = await Promise.all(Array.from({ length: 25 }, () => service.getUsage()));
  for (const body of stale) assert.equal(body, first);
  assert.equal(service.metrics().refreshesStarted, 2);
  assert.equal(service.metrics().refreshInFlight, true);

  await service.idle();
  const fresh = await service.getUsage();
  assert.notEqual(fresh, first);
  assert.equal(fresh.today.claudeCode, first.today.claudeCode + 1000);
  assert.deepEqual(fresh, await h.oracle());
  const m = service.metrics();
  assert.equal(m.refreshesStarted, 2);
  assert.equal(m.incrementalParses, 1); // only the appended file was read again
  assert.equal(m.fullParses, 5);
});

test("changed files: appends, partial lines, rewrites, truncation, deletion and age-out", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  const service = createTokenUsageService(h.options({ ttlMs: 0 }));
  const refresh = async () => {
    const body = await service.refresh();
    assert.deepEqual(body, await h.oracle());
    return body;
  };
  await refresh();
  const s1 = path.join(h.claudeRoot, "proj-a", "s1.jsonl");
  const s1Size = (await fs.stat(s1)).size;

  // Append: a new message plus a streamed rewrite of msg_A (80 -> 300). The
  // whole committed prefix is re-read and hashed (never trusted from a sample),
  // then only the appended lines are scanned and parsed.
  let before = service.metrics();
  const appended = [claudeLine({ id: "msg_F", input: 21 }), claudeLine({ id: "msg_A", input: 300 })].join("\n") + "\n";
  await fs.appendFile(s1, appended);
  let body = await refresh();
  assert.equal(body.today.claudeCode, 116 - 80 + 300 + 21);
  let after = service.metrics();
  assert.equal(after.incrementalParses - before.incrementalParses, 1);
  const verified = after.verifiedBytes - before.verifiedBytes;
  assert.equal(verified, s1Size, "the entire committed prefix is verified");
  assert.ok(after.bytesRead - before.bytesRead - verified < Buffer.byteLength(appended) + 256, "only the appended bytes are scanned");

  // A line still being written (no newline yet) counts provisionally, then exactly once when finished.
  const partial = claudeLine({ id: "msg_G", input: 5 });
  await fs.appendFile(s1, partial);
  body = await refresh();
  assert.equal(body.today.claudeCode, 116 - 80 + 300 + 21 + 5);
  await fs.appendFile(s1, "\n" + claudeLine({ id: "msg_G", input: 50 }) + "\n");
  body = await refresh();
  assert.equal(body.today.claudeCode, 116 - 80 + 300 + 21 + 50);
  // A half-written line is malformed until finished: it adds nothing meanwhile.
  const line = claudeLine({ id: "msg_H", input: 7 });
  await fs.appendFile(s1, line.slice(0, 40));
  body = await refresh();
  assert.equal(body.today.claudeCode, 116 - 80 + 300 + 21 + 50);
  await fs.appendFile(s1, line.slice(40) + "\n");
  body = await refresh();
  assert.equal(body.today.claudeCode, 116 - 80 + 300 + 21 + 50 + 7);
  // An unterminated streamed rewrite of a committed message replaces it (50 -> 70), never adds to it.
  await fs.appendFile(s1, claudeLine({ id: "msg_G", input: 70 }));
  body = await refresh();
  assert.equal(body.today.claudeCode, 116 - 80 + 300 + 21 + 70 + 7);
  await fs.appendFile(s1, "\n");
  body = await refresh();
  assert.equal(body.today.claudeCode, 116 - 80 + 300 + 21 + 70 + 7);

  // Rewritten in place with different, longer content: the prefix digest no longer matches, so it reparses.
  before = service.metrics();
  await writeLog(s1, [claudeLine({ id: "rewritten", input: 2 }), claudeUserLine("z".repeat(5000))]);
  body = await refresh();
  after = service.metrics();
  assert.equal(after.fullParses - before.fullParses, 1);
  assert.equal(body.today.claudeCode, 2 + 15);

  // Truncated (smaller than the committed offset): reparsed from the start.
  await writeLog(s1, [claudeLine({ id: "short", input: 4 })]);
  body = await refresh();
  assert.equal(body.today.claudeCode, 4 + 15);

  // Codex appends keep the newest cumulative event.
  const r1 = path.join(h.codexRoot, "2026", "11", "19", "rollout-1.jsonl");
  await fs.appendFile(r1, codexTokenLine({ input: 900, cached: 100, output: 100 }) + "\n");
  body = await refresh();
  assert.equal(body.today.codex, 900 + 55);

  // Deleted and aged-out files leave the totals and the cache.
  const cachedBefore = service.metrics().cachedFiles;
  await fs.rm(path.join(h.claudeRoot, "proj-a", "nested", "deeper", "s2.jsonl"));
  const old = new Date(Date.now() - 45 * 86_400_000);
  await fs.utimes(path.join(h.codexRoot, "rollout-3.jsonl"), old, old);
  body = await refresh();
  assert.equal(body.today.claudeCode, 4);
  assert.equal(body.today.codex, 900);
  assert.equal(service.metrics().cachedFiles, cachedBefore - 2);
});

test("an earlier entry rewritten in place is reparsed even when size, inode and trailing bytes are unchanged", async () => {
  const h = await harness();
  const service = createTokenUsageService(h.options({ ttlMs: 0 }));
  const claudeFile = path.join(h.claudeRoot, "p", "session.jsonl");
  const codexFile = path.join(h.codexRoot, "rollout.jsonl");
  // Long unchanged trailing content after the entry that will be rewritten,
  // so any check that samples only the bytes near the end sees no change.
  const trailer = [claudeUserLine("unchanged trailing content ".repeat(40))];
  const codexTrailer = [codexOtherLine("unchanged trailing content ".repeat(40))];
  await writeLog(claudeFile, [claudeLine({ id: "first", input: 10 }), ...trailer]);
  await writeLog(codexFile, [codexTokenLine({ input: 100, output: 1 }), ...codexTrailer]);
  let mtime = Date.now();
  const touch = async (fp: string) => {
    mtime += 1000;
    await fs.utimes(fp, new Date(mtime), new Date(mtime));
  };
  let body = await service.refresh();
  assert.equal(body.today.claudeCode, 10);
  assert.equal(body.today.codex, 101);

  // Same size, same inode, same trailing bytes; only the earlier usage differs (10 -> 90, 100 -> 900).
  const sizes = [(await fs.stat(claudeFile)).size, (await fs.stat(codexFile)).size];
  const inodes = [(await fs.stat(claudeFile)).ino, (await fs.stat(codexFile)).ino];
  await fs.writeFile(claudeFile, [claudeLine({ id: "first", input: 90 }), ...trailer].join("\n") + "\n");
  await fs.writeFile(codexFile, [codexTokenLine({ input: 900, output: 1 }), ...codexTrailer].join("\n") + "\n");
  await touch(claudeFile);
  await touch(codexFile);
  assert.deepEqual([(await fs.stat(claudeFile)).size, (await fs.stat(codexFile)).size], sizes);
  assert.deepEqual([(await fs.stat(claudeFile)).ino, (await fs.stat(codexFile)).ino], inodes);
  let before = service.metrics();
  body = await service.refresh();
  let after = service.metrics();
  assert.equal(body.today.claudeCode, 90);
  assert.equal(body.today.codex, 901);
  assert.deepEqual(body, await h.oracle());
  assert.equal(after.fullParses - before.fullParses, 2, "both files reparse from the start");
  assert.equal(after.incrementalParses - before.incrementalParses, 0);

  // Rewritten in place and appended to: the size grows and the old boundary
  // bytes still match, yet the earlier entry changed (90 -> 50) and must count.
  const fileText = await fs.readFile(claudeFile, "utf8");
  await fs.writeFile(
    claudeFile,
    fileText.replace('"input_tokens":90', '"input_tokens":50') + claudeLine({ id: "second", input: 7 }) + "\n",
  );
  await touch(claudeFile);
  before = service.metrics();
  body = await service.refresh();
  after = service.metrics();
  assert.equal(body.today.claudeCode, 50 + 7);
  assert.deepEqual(body, await h.oracle());
  assert.equal(after.fullParses - before.fullParses, 1);

  // A genuine append after that still resumes, and stays exact.
  await fs.appendFile(claudeFile, claudeLine({ id: "first", input: 60 }) + "\n");
  before = service.metrics();
  body = await service.refresh();
  after = service.metrics();
  assert.equal(after.incrementalParses - before.incrementalParses, 1);
  assert.equal(body.today.claudeCode, 60 + 7);
  assert.deepEqual(body, await h.oracle());
});

test("idle files drop their dedupe index and reparse exactly if they change again", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  const s1 = path.join(h.claudeRoot, "proj-a", "s1.jsonl");
  const hourAgo = new Date(Date.now() - 3_600_000);
  await fs.utimes(s1, hourAgo, hourAgo);
  const service = createTokenUsageService(h.options({ ttlMs: 0, hotIndexMs: 60_000 }));
  await service.refresh();
  let m = service.metrics();
  // s1 is idle (index dropped); s2 was just written (index kept).
  assert.equal(m.indexedFiles, 1);
  assert.equal(m.indexedMessages, 1);

  await fs.appendFile(s1, claudeLine({ id: "msg_A", input: 1 }) + "\n"); // rewrite of msg_A: must replace 80
  const before = service.metrics().fullParses;
  const body = await service.refresh();
  assert.equal(service.metrics().fullParses - before, 1);
  assert.equal(body.today.claudeCode, 116 - 80 + 1);
  assert.deepEqual(body, await h.oracle());
  m = service.metrics();
  assert.equal(m.indexedFiles, 2); // s1 is hot again
});

test("a failed cold refresh is reported once and the next request recovers", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  let fail = true;
  const errors: unknown[] = [];
  const service = createTokenUsageService(
    h.options({
      readLedger: async () => {
        if (fail) throw new Error("ledger unavailable");
        return h.ledger;
      },
      onRefreshError: (err) => errors.push(err),
    }),
  );

  const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.getUsage()));
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(errors.length, 1);
  let m = service.metrics();
  assert.equal(m.refreshesStarted, 1);
  assert.equal(m.refreshesFailed, 1);
  assert.equal(m.refreshInFlight, false);

  fail = false;
  const body = await service.getUsage();
  assert.deepEqual(body, await h.oracle());
  m = service.metrics();
  assert.equal(m.refreshesStarted, 2);
  assert.equal(m.refreshesSucceeded, 1);
  // The file scan from the failed attempt was kept: nothing is parsed twice.
  assert.equal(m.fullParses, 5);
});

test("a refresh that fails early still finishes its scan before a retry can start", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  // Enough files that the scan is still running when the ledger read fails.
  for (let n = 0; n < 200; n++) {
    await writeLog(path.join(h.claudeRoot, "proj-many", `s${n}.jsonl`), [claudeLine({ id: `m${n}`, input: 1 })]);
  }
  let fail = true;
  const service = createTokenUsageService(
    h.options({
      readLedger: async () => {
        if (fail) throw new Error("ledger unavailable");
        return h.ledger;
      },
    }),
  );
  await assert.rejects(service.getUsage(), /ledger unavailable/);
  fail = false;
  const body = await service.getUsage(); // the retry, issued the moment the failure is seen
  assert.deepEqual(body, await h.oracle());
  // Each of the 205 files was parsed once: the retry never overlapped a scan still in progress.
  assert.equal(service.metrics().fullParses, 205);
});

test("a failed stale refresh is not hidden behind old numbers", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  let mode: "ok" | "fail" = "ok";
  const service = createTokenUsageService(
    h.options({
      readLedger: async () => {
        if (mode === "fail") throw new Error("ledger unavailable");
        return h.ledger;
      },
    }),
  );
  const first = await service.getUsage();

  h.clock.ms += 31_000;
  mode = "fail";
  assert.equal(await service.getUsage(), first); // stale answer while the refresh runs
  await service.idle();
  assert.equal(service.metrics().refreshesFailed, 1);

  // After the failure, requests wait for a retry instead of getting the old body.
  await assert.rejects(service.getUsage(), /ledger unavailable/);
  assert.equal(service.metrics().refreshesFailed, 2);

  mode = "ok";
  h.ledger = { local: new Map([[TODAY, 5000]]), cloud: new Map() };
  const recovered = await service.getUsage();
  assert.equal(recovered.today.local, 5000);
  assert.deepEqual(recovered, await h.oracle());
  assert.equal(service.metrics().refreshInFlight, false);
});

test("a listed .jsonl entry that is not a readable file contributes nothing", async () => {
  const h = await harness();
  await writeAccountingFixture(h);
  const s2 = path.join(h.claudeRoot, "proj-a", "nested", "deeper", "s2.jsonl");
  // Replace the file with a directory of the same name: listed, but not a readable log.
  await fs.rm(s2);
  await fs.mkdir(s2);
  const body = await createTokenUsageService(h.options()).getUsage();
  assert.equal(body.today.claudeCode, 101);
  assert.deepEqual(body, await h.oracle());
});
