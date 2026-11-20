#!/usr/bin/env node
/**
 * Load check for /api/token-usage (task 6802cb06, incident 2026-11-20: the
 * supervised dashboard stopped answering its root route while overlapping
 * token-usage scans grew it to 19 GB).
 *
 *   node scripts/token-usage-load-check.mjs generate <home>
 *     Writes a synthetic fixture home shaped like the real session-log tree:
 *     <home>/.claude/projects (10,000 files by default; mean ~165 KB, 3% over
 *     600 KB, plus 84/60/48/40 MB sessions), <home>/.codex/sessions (300
 *     rollouts plus one 150 MB), 300 Claude files older than the 30-day
 *     window, a cost ledger and a board DB for the sqlite readers. Synthetic
 *     text only; nothing is copied from real logs.
 *
 *   node scripts/token-usage-load-check.mjs run --home <home> --target <t> --out <dir>
 *       [--duration 120] [--pollers 5] [--interval 10000] [--heap-mb 2048] [--drain 60]
 *     <t> is one of
 *       inproc-old  the route as of 36f0db2e (before this fix), served by a
 *                   bare node:http server in a child process;
 *       inproc-new  this checkout's route, same server;
 *       next-dev    this checkout under `next dev --webpack` (the live
 *                   dashboard's mode) on a free port, dist dir
 *                   .next-verify-token-usage (removed afterwards).
 *     Every target runs with HOME=<home>, so os.homedir() is the fixture.
 *     While it runs: <pollers> concurrent GET /api/token-usage every
 *     <interval> ms (five widgets per bridge page poll it); GET / every second
 *     with the supervisor's 5 s deadline; new lines appended every 2 s to the
 *     largest sessions and 18 others, as live sessions do; RSS and CPU of the
 *     target's process group sampled every second. Writes
 *     <out>/<label>-samples.jsonl and <out>/<label>-summary.json.
 *
 * Children run detached in their own process group and are stopped by that
 * group only (never by process name). Readiness comes from each child's own
 * line (SERVE_READY, next dev's "Ready in"); the only timers are the load
 * schedule itself.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(here, "..");
const REPO = path.resolve(DASHBOARD, "..");
const BASELINE_SHA = "36f0db2e45e86bff512d103eae3e01bb08b0fa76";
const ROUTE_REL = "dashboard/src/app/api/token-usage/route.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

// ── generate ────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "the of and to in is that for it as with was on be by this are or from at an which not have but all were when we there can more if will one about so".split(" ");

function makeFiller(rand, bytes) {
  const out = [];
  let n = 0;
  while (n < bytes) {
    const w = WORDS[Math.floor(rand() * WORDS.length)];
    out.push(w);
    n += w.length + 1;
  }
  return out.join(" ");
}

async function writeStreamed(fp, produce, targetBytes) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const ws = fs.createWriteStream(fp);
  let written = 0;
  let pending = [];
  let pendingBytes = 0;
  while (written < targetBytes) {
    const line = produce() + "\n";
    pending.push(line);
    pendingBytes += line.length;
    written += line.length;
    if (pendingBytes > 4 * 1024 * 1024) {
      if (!ws.write(pending.join(""))) await new Promise((r) => ws.once("drain", r));
      pending = [];
      pendingBytes = 0;
    }
  }
  ws.end(pending.join(""));
  await new Promise((r, j) => ws.on("finish", r).on("error", j));
  return written;
}

function claudeProducer(rand, filler, startMs) {
  let t = startMs;
  let seq = 0;
  let stream = null; // pending streamed rewrites of one message id
  const slice = (len) => {
    const at = Math.floor(rand() * (filler.length - len));
    return filler.slice(at, at + len);
  };
  return () => {
    t += 1000 + Math.floor(rand() * 20_000);
    const timestamp = new Date(t).toISOString();
    if (stream && stream.left > 0) {
      stream.left--;
      stream.output += 40 + Math.floor(rand() * 400);
      return JSON.stringify({ type: "assistant", uuid: `u${seq++}`, timestamp, message: { id: stream.id, role: "assistant", content: [{ type: "text", text: slice(200 + Math.floor(rand() * 1500)) }], usage: { input_tokens: stream.input, cache_creation_input_tokens: stream.cc, cache_read_input_tokens: 40_000, output_tokens: stream.output } } });
    }
    const u = rand();
    if (u < 0.45) return JSON.stringify({ type: "user", uuid: `u${seq++}`, timestamp, message: { role: "user", content: slice(300 + Math.floor(rand() * 2700)) } });
    if (u < 0.55) {
      const big = rand() < 0.03 ? 200_000 + Math.floor(rand() * 600_000) : 2000 + Math.floor(rand() * 38_000);
      return JSON.stringify({ type: "user", uuid: `u${seq++}`, timestamp, toolUseResult: { stdout: slice(Math.min(big, filler.length - 1)) } });
    }
    const id = `msg_${t.toString(36)}_${seq}`;
    const input = 1 + Math.floor(rand() * 50);
    const cc = Math.floor(rand() * 3000);
    const output = 20 + Math.floor(rand() * 900);
    if (rand() < 0.35) stream = { id, input, cc, output, left: 1 + Math.floor(rand() * 2) };
    return JSON.stringify({ type: "assistant", uuid: `u${seq++}`, timestamp, message: { id, role: "assistant", content: [{ type: "text", text: slice(200 + Math.floor(rand() * 3800)) }], usage: { input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: 40_000, output_tokens: output } } });
  };
}

function codexProducer(rand, filler, startMs) {
  let t = startMs;
  let input = 0;
  let cached = 0;
  let output = 0;
  return () => {
    t += 2000 + Math.floor(rand() * 30_000);
    const timestamp = new Date(t).toISOString();
    if (rand() < 0.3) {
      input += 2000 + Math.floor(rand() * 20_000);
      cached += Math.floor(rand() * 15_000);
      output += 100 + Math.floor(rand() * 2000);
      return JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: Math.min(cached, input), output_tokens: output } } } });
    }
    const at = Math.floor(rand() * (filler.length - 4000));
    return JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", content: filler.slice(at, at + 300 + Math.floor(rand() * 3700)) } });
  };
}

function claudeSize(rand) {
  const u = rand();
  if (u < 0.8) return 5_000 + rand() * 95_000;
  if (u < 0.97) return 100_000 + rand() * 500_000;
  if (u < 0.998) return 600_000 + rand() * 2_400_000;
  return 3_000_000 + rand() * 9_000_000;
}

async function generate(home) {
  const rand = mulberry32(Number(flags.seed ?? 20261120));
  const claudeFiles = Number(flags["claude-files"] ?? 10_000);
  const codexFiles = Number(flags["codex-files"] ?? 300);
  const filler = makeFiller(rand, 1_200_000);
  const now = Date.now();
  const DAY = 86_400_000;
  const claudeRoot = path.join(home, ".claude", "projects");
  const codexRoot = path.join(home, ".codex", "sessions");
  const manifest = { generatedAt: new Date(now).toISOString(), claude: { files: 0, bytes: 0 }, codex: { files: 0, bytes: 0 }, outsideWindow: { files: 0, bytes: 0 }, hot: [] };
  const setMtime = (fp, ms) => fs.utimesSync(fp, new Date(ms), new Date(ms));
  const t0 = performance.now();

  const big = [84, 60, 48, 40].map((mb) => mb * 1024 * 1024);
  for (let n = 0; n < claudeFiles + big.length; n++) {
    const fp = path.join(claudeRoot, `proj-${String(n % 100).padStart(2, "0")}`, n % 7 === 0 ? `sub-${n % 5}` : "", `session-${String(n).padStart(5, "0")}.jsonl`);
    const hot = n >= claudeFiles || n < 18;
    const mtime = hot ? now - Math.floor(rand() * 30 * 60_000) : now - Math.floor(rand() * 29 * DAY);
    const size = n >= claudeFiles ? big[n - claudeFiles] : claudeSize(rand);
    const bytes = await writeStreamed(fp, claudeProducer(rand, filler, mtime - 6 * 3_600_000), size);
    setMtime(fp, mtime);
    manifest.claude.files++;
    manifest.claude.bytes += bytes;
    if (hot) manifest.hot.push(fp);
  }
  for (let n = 0; n < 300; n++) {
    const fp = path.join(claudeRoot, "proj-archive", `old-${n}.jsonl`);
    const bytes = await writeStreamed(fp, claudeProducer(rand, filler, now - 40 * DAY), 20_000 + rand() * 200_000);
    setMtime(fp, now - (31 + Math.floor(rand() * 14)) * DAY);
    manifest.outsideWindow.files++;
    manifest.outsideWindow.bytes += bytes;
  }
  for (let n = 0; n <= codexFiles; n++) {
    const mtime = n === codexFiles || n < 2 ? now - Math.floor(rand() * 30 * 60_000) : now - Math.floor(rand() * 29 * DAY);
    const d = new Date(mtime);
    const fp = path.join(codexRoot, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"), `rollout-${n}.jsonl`);
    const size = n === codexFiles ? 150 * 1024 * 1024 : 50_000 + rand() * 1_300_000;
    const bytes = await writeStreamed(fp, codexProducer(rand, filler, mtime - 3 * 3_600_000), size);
    setMtime(fp, mtime);
    manifest.codex.files++;
    manifest.codex.bytes += bytes;
    if (n === codexFiles || n < 2) manifest.hot.push(fp);
  }

  fs.mkdirSync(path.join(home, ".praxis-mind"), { recursive: true });
  const ledger = path.join(home, ".praxis-mind", "cost_ledger.sqlite");
  fs.rmSync(ledger, { force: true });
  execFileSync("sqlite3", [ledger, "CREATE TABLE llm_calls(ts TEXT, provider TEXT, total_tokens INTEGER); INSERT INTO llm_calls VALUES (datetime('now'),'local',125000),(datetime('now','-1 day'),'local',90000),(datetime('now'),'openrouter',42000),(datetime('now'),'claude-code',999999);"]);
  const board = path.join(home, "nexus.db");
  fs.rmSync(board, { force: true });
  execFileSync("sqlite3", [board, "CREATE TABLE task_dispatches(executor TEXT, tokens INTEGER, tokens_estimated INTEGER, completed_at TEXT, started_at TEXT); INSERT INTO task_dispatches VALUES ('antigravity',31000,1,datetime('now'),datetime('now'));"]);

  manifest.generateSeconds = +((performance.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(path.join(home, "fixture-manifest.json"), JSON.stringify(manifest, null, 2));
  const gib = (b) => +(b / 2 ** 30).toFixed(2);
  console.log(JSON.stringify({ home, claudeFiles: manifest.claude.files, claudeGiB: gib(manifest.claude.bytes), codexFiles: manifest.codex.files, codexGiB: gib(manifest.codex.bytes), outsideWindowFiles: manifest.outsideWindow.files, hotFiles: manifest.hot.length, seconds: manifest.generateSeconds }));
}

// ── serve (child of run for the inproc targets) ─────────────────────────────

async function serve() {
  const impl = flags.impl;
  let routeUrl;
  if (impl === "new") {
    routeUrl = pathToFileURL(path.join(REPO, ROUTE_REL)).href;
  } else {
    // The pre-fix route, verbatim except for its next/server import (plain
    // node cannot resolve it; NextResponse.json is Response.json plus Next
    // bookkeeping), written beside the run's evidence.
    const source = execFileSync("git", ["-C", REPO, "show", `${BASELINE_SHA}:${ROUTE_REL}`], { encoding: "utf8" });
    const shimmed = source.replace('import { NextResponse } from "next/server";', "const NextResponse = { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) };");
    if (shimmed === source) throw new Error("baseline route import not found");
    const file = path.join(flags.out, "baseline-route-36f0db2e.ts");
    fs.writeFileSync(file, shimmed);
    routeUrl = pathToFileURL(file).href;
  }
  const route = await import(routeUrl);
  const service = impl === "new" ? await import(pathToFileURL(path.join(DASHBOARD, "src/app/api/token-usage/token-usage-service.ts")).href) : null;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let inflight = 0;
  let peakInflight = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/") return res.end("ok"); // the root: answers as soon as the event loop is free
    if (req.url === "/__metrics") {
      const ms = (ns) => +(ns / 1e6).toFixed(1);
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ peakConcurrentRouteCalls: peakInflight, eventLoopDelayMs: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) }, service: service?.sharedTokenUsageService().metrics() ?? null }));
    }
    if (req.url?.startsWith("/api/token-usage")) {
      inflight++;
      peakInflight = Math.max(peakInflight, inflight);
      try {
        const response = await route.GET();
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      } finally {
        inflight--;
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1", () => console.log(`SERVE_READY ${server.address().port}`));
}

// ── run ─────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startChild(name, command, args, opts, readyLine, logPath) {
  const child = spawn(command, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const log = fs.createWriteStream(logPath);
  const closed = new Promise((resolve) => child.on("close", resolve));
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    const scan = (chunk) => {
      log.write(chunk);
      buf += chunk;
      const m = buf.match(readyLine);
      if (m) {
        resolve(m);
        buf = "";
      } else buf = buf.slice(buf.lastIndexOf("\n") + 1);
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code, signal) => reject(new Error(`${name} exited (${signal || code}) before ready; log ${logPath}`)));
  });
  ready.catch(() => {});
  return { child, closed, ready };
}

function request(url, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      let bytes = 0;
      res.on("data", (c) => (bytes += c.length));
      res.on("end", () => resolve({ status: res.statusCode, ms: performance.now() - t0, bytes }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, ms: performance.now() - t0, error: err.message }));
  });
}

function requestJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(null));
  });
}

function groupUsage(pgid) {
  // Sum over the target's process group (next dev runs several processes).
  const out = execFileSync("ps", ["-ax", "-o", "pgid=,pid=,rss=,pcpu="], { encoding: "utf8" });
  let rssKb = 0;
  let cpu = 0;
  let maxRssKb = 0;
  for (const line of out.split("\n")) {
    const [g, , rss, pcpu] = line.trim().split(/\s+/);
    if (Number(g) !== pgid) continue;
    rssKb += Number(rss);
    cpu += Number(pcpu);
    maxRssKb = Math.max(maxRssKb, Number(rss));
  }
  return { rssMiB: Math.round(rssKb / 1024), maxProcessRssMiB: Math.round(maxRssKb / 1024), cpuPercent: Math.round(cpu) };
}

const pct = (values, p) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
};

async function run() {
  const home = path.resolve(flags.home);
  const target = flags.target;
  const out = path.resolve(flags.out);
  const durationMs = Number(flags.duration ?? 120) * 1000;
  const pollers = Number(flags.pollers ?? 5);
  const intervalMs = Number(flags.interval ?? 10_000);
  const heapMb = Number(flags["heap-mb"] ?? 2048);
  const drainMs = Number(flags.drain ?? 60) * 1000;
  const label = flags.label ?? target;
  let t0 = performance.now();
  fs.mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(home, "fixture-manifest.json"), "utf8"));
  const env = { ...process.env, HOME: home, NEXUS_DB_PATH: path.join(home, "nexus.db"), NEXT_TELEMETRY_DISABLED: "1" };

  let stack;
  let base;
  let tsconfigSnapshot = null;
  const distDir = ".next-verify-token-usage";
  if (target === "inproc-old" || target === "inproc-new") {
    stack = startChild(target, process.execPath, [`--max-old-space-size=${heapMb}`, "--import", path.join(DASHBOARD, "test/register.mjs"), fileURLToPath(import.meta.url), "serve", "--impl", target.slice(7), "--out", out], { cwd: DASHBOARD, env }, /SERVE_READY (\d+)/, path.join(out, `${label}-server.txt`));
    base = `http://127.0.0.1:${(await stack.ready)[1]}`;
  } else if (target === "next-dev") {
    const port = await freePort();
    tsconfigSnapshot = fs.readFileSync(path.join(DASHBOARD, "tsconfig.json"));
    const nodeOptions = flags["heap-mb"] ? { NODE_OPTIONS: `--max-old-space-size=${heapMb}` } : {};
    stack = startChild(target, "npx", ["next", "dev", "--webpack", "-p", String(port)], { cwd: DASHBOARD, env: { ...env, NEXT_DIST_DIR: distDir, ...nodeOptions } }, /\bReady in\b/, path.join(out, `${label}-server.txt`));
    await stack.ready;
    base = `http://127.0.0.1:${port}`;
  } else {
    throw new Error(`unknown target ${target}`);
  }

  const samples = fs.createWriteStream(path.join(out, `${label}-samples.jsonl`));
  const record = (event) => samples.write(JSON.stringify({ t: +((performance.now() - t0) / 1000).toFixed(2), ...event }) + "\n");
  let stopping = false;
  const teardown = async () => {
    stopping = true;
    if (stack.child.exitCode === null && stack.child.signalCode === null) {
      try {
        process.kill(-stack.child.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    await stack.closed;
    if (tsconfigSnapshot) {
      fs.writeFileSync(path.join(DASHBOARD, "tsconfig.json"), tsconfigSnapshot);
      fs.rmSync(path.join(DASHBOARD, distDir), { recursive: true, force: true });
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await teardown(); process.exit(2); });

  let warmRoot = null;
  if (target === "next-dev") {
    // Compile the root page before measuring, as the supervisor probes a running server.
    warmRoot = await request(`${base}/`, 300_000);
  }

  let crashed = null;
  stack.child.on("exit", (code, signal) => {
    if (stopping) return;
    crashed = { code, signal, atSeconds: +((performance.now() - t0) / 1000).toFixed(1) };
  });
  t0 = performance.now();
  const polls = [];
  const probes = [];
  const usage = [];
  const outstanding = new Set();

  const poll = () => {
    const p = request(`${base}/api/token-usage`, durationMs + drainMs).then((r) => {
      polls.push({ startedAt: +((p.startedAt - t0) / 1000).toFixed(1), ...r });
      record({ kind: "poll", status: r.status, ms: Math.round(r.ms), error: r.error });
      outstanding.delete(p);
    });
    p.startedAt = performance.now();
    outstanding.add(p);
  };
  const appendRound = () => {
    const ts = new Date().toISOString();
    for (const fp of manifest.hot) {
      const id = `msg_live_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9)}`;
      const line = fp.includes(`${path.sep}.codex${path.sep}`)
        ? JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9_000_000 + Math.floor(Math.random() * 1e6), cached_input_tokens: 1_000_000, output_tokens: 90_000 } } } })
        : JSON.stringify({ type: "assistant", timestamp: ts, message: { id, role: "assistant", content: [{ type: "text", text: "live append ".repeat(100) }], usage: { input_tokens: 5, cache_creation_input_tokens: 300, cache_read_input_tokens: 40_000, output_tokens: 120 } } });
      fs.appendFileSync(fp, line + "\n");
    }
  };

  const timers = [];
  const every = (ms, fn) => {
    fn();
    timers.push(setInterval(fn, ms));
  };
  every(intervalMs, () => {
    for (let i = 0; i < pollers; i++) poll();
  });
  every(1000, () => {
    request(`${base}/`, 5000).then((r) => {
      probes.push(r);
      record({ kind: "root", status: r.status, ms: Math.round(r.ms), error: r.error });
    });
  });
  every(1000, () => {
    if (crashed) return;
    const u = groupUsage(stack.child.pid);
    usage.push(u);
    record({ kind: "usage", ...u });
  });
  every(2000, appendRound);

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  for (const t of timers) clearInterval(t);
  const drainUntil = performance.now() + drainMs;
  while (outstanding.size && performance.now() < drainUntil && !crashed) {
    await Promise.race([Promise.race(outstanding), new Promise((r) => setTimeout(r, 1000))]);
  }
  const unfinished = outstanding.size;
  const metrics = target.startsWith("inproc") && !crashed ? await requestJson(`${base}/__metrics`, 10_000) : null;
  const finalBody = !crashed ? await requestJson(`${base}/api/token-usage`, 120_000) : null;
  await teardown();
  samples.end();

  const ok = polls.filter((p) => p.status === 200);
  const rootOk = probes.filter((p) => p.status === 200);
  const summary = {
    label,
    target,
    fixture: { claudeFiles: manifest.claude.files, claudeGiB: +(manifest.claude.bytes / 2 ** 30).toFixed(2), codexFiles: manifest.codex.files, codexGiB: +(manifest.codex.bytes / 2 ** 30).toFixed(2), hotFilesAppendedEvery2s: manifest.hot.length },
    load: { durationSeconds: durationMs / 1000, pollers, intervalMs, heapCapMiB: target === "next-dev" && !flags["heap-mb"] ? null : heapMb },
    warmRootMs: warmRoot ? Math.round(warmRoot.ms) : null,
    crashed,
    tokenUsagePolls: {
      launched: polls.length + unfinished,
      ok: ok.length,
      failed: polls.length - ok.length,
      unfinishedAtEnd: unfinished,
      firstOkAfterSeconds: ok.length ? +Math.min(...ok.map((p) => p.startedAt + p.ms / 1000)).toFixed(1) : null,
      latencyMs: { p50: pct(ok.map((p) => p.ms), 50), p95: pct(ok.map((p) => p.ms), 95), max: pct(ok.map((p) => p.ms), 100) },
    },
    rootProbes: {
      sent: probes.length,
      ok: rootOk.length,
      overFiveSecondsOrFailed: probes.length - rootOk.length,
      latencyMs: { p50: pct(rootOk.map((p) => p.ms), 50), p95: pct(rootOk.map((p) => p.ms), 95), max: pct(rootOk.map((p) => p.ms), 100) },
    },
    resources: {
      peakGroupRssMiB: usage.length ? Math.max(...usage.map((u) => u.rssMiB)) : null,
      finalGroupRssMiB: usage.length ? usage[usage.length - 1].rssMiB : null,
      meanCpuPercent: usage.length ? Math.round(usage.reduce((a, u) => a + u.cpuPercent, 0) / usage.length) : null,
    },
    serverMetrics: metrics,
    finalBody: finalBody ? { today: finalBody.today, antigravity: finalBody.antigravity, days: finalBody.days?.length, computedAt: finalBody.computedAt } : null,
  };
  fs.writeFileSync(path.join(out, `${label}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (cmd === "generate") await generate(path.resolve(positional[0] ?? flags.home));
else if (cmd === "serve") await serve();
else if (cmd === "run") await run();
else {
  console.error("usage: token-usage-load-check.mjs generate <home> | run --home <home> --target inproc-old|inproc-new|next-dev --out <dir>");
  process.exit(2);
}
