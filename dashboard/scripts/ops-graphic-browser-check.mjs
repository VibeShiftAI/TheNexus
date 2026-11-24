#!/usr/bin/env node
/**
 * Real-browser check for task 56c15b54 (2026-11-23): the Ops graphic draws one
 * child node per live run under its provider, with vendor logos, and the main
 * viewer no longer has a Crew section.
 *
 * One foreground process owns the stack and tears it down by process group:
 *   - a stand-in for Praxis, in this process: it answers /api/dispatch/state
 *     and the council routes from the scenario table below, and 404s the rest;
 *   - a throwaway Nexus API (this checkout's server/server.js) on an empty
 *     temporary SQLite database, PRAXIS_URL pointing at the stand-in;
 *   - `next dev --webpack` from CHECK_DASHBOARD (default: this checkout) on an
 *     OS-assigned port, proxying /api to that API, dist dir .next-verify-ops.
 *     Webpack, not Turbopack: a Praxis worktree links dashboard/node_modules
 *     from the shared checkout and Turbopack refuses a symlink that leaves the
 *     repo root;
 *   - headless Chrome over CDP. Connections the dashboard makes to the shared
 *     localhost:4000 (socket.io) are mapped to the throwaway API.
 * Nothing here reads or writes the live board, the live Praxis or nexus.db.
 *
 * No step waits a fixed time. Readiness comes from the children's own lines
 * (the API's "Local Nexus running", next dev's "Ready in", Chrome's "DevTools
 * listening on"); a scenario is on screen when the map reports the expected
 * run count (a DOM observer in the page resolves on it; its 60 s limit is a
 * failure bound, not a wait); a screenshot follows a painted frame.
 *
 * Task 52b5db3d (2026-11-24) made the panel shorter: an executor node is its
 * logo alone (name and status only in its aria-label and title, trouble as a
 * ring and badge on the logo), and a run node draws no task title (slot tag,
 * or the role word when there is no slot, then model, effort, role, phase,
 * elapsed). The assertions below check that; each scenario also records the
 * Ops panel's measured height (#station-dispatch and .dispatch-map) in both
 * modes, so before and after are compared in the same state.
 *
 * Scenarios (each at desktop 1440x900 and phone 390x844):
 *   idle      nothing running: no run node, every provider collapsed.
 *   busy      six runs across three executors: task runs and one QA review
 *             run, slot tags on some, three without a slot, one run with no
 *             model reported, one whose served model differs from the
 *             requested one.
 *   overflow  23 runs (14 on one provider), a sitting council, three queued
 *             tasks: more than fits one row.
 *   trouble   two runs on Claude Code, Codex suspended by the fleet posture
 *             while it still holds one run (busy and in trouble at once),
 *             Antigravity's last run failed a moment ago.
 *   delayed   the stand-in answers dispatch state with 503: every executor's
 *             signal is delayed.
 * CHECK_LABEL=after (default) asserts the new behaviour; CHECK_LABEL=before
 * with CHECK_DASHBOARD=<baseline>/dashboard only records, measures and
 * photographs the same scenarios on the old tree.
 *
 *   node scripts/ops-graphic-browser-check.mjs
 *   CHECK_LABEL=before CHECK_DASHBOARD=<baseline>/dashboard node scripts/ops-graphic-browser-check.mjs
 *
 * Env: CHECK_LABEL, CHECK_DASHBOARD, CHECK_OUT
 * (docs/reviews/2026-11-24-ops-panel-compact-evidence), CHECK_PACKAGE
 * (docs/reviews/2026-11-24-ops-panel-compact; the busy Ops panel shots are
 * also written there as <label>/busy-<viewport>-ops-panel.png), CHECK_CHROME.
 * Writes <out>/<label>/*.png and report.json; exits 1 on any failed assertion.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const NEXUS = path.resolve(here, "..", "..");
const DASHBOARD = path.resolve(process.env.CHECK_DASHBOARD || path.join(NEXUS, "dashboard"));
const LABEL = process.env.CHECK_LABEL || "after";
const AFTER = LABEL !== "before";
const OUT = path.join(path.resolve(process.env.CHECK_OUT || path.join(NEXUS, "docs/reviews/2026-11-24-ops-panel-compact-evidence")), LABEL);
const PACKAGE = path.join(path.resolve(process.env.CHECK_PACKAGE || path.join(NEXUS, "docs/reviews/2026-11-24-ops-panel-compact")), LABEL);
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PACKAGE, { recursive: true });

// Widths are the two the repo's layout audit covers (scripts/responsive-audit.mjs,
// "390,1440"); 390x844 at 2x is the iPhone 12-15 CSS viewport the other phone
// checks use, 1440x900 the 16:10 desktop of that width.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, scale: 1, mobile: false },
  { name: "phone", width: 390, height: 844, scale: 2, mobile: true },
];

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "CHECK_OK  " : "CHECK_FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
};

// ── scenarios: what the stand-in Praxis reports ──
const T0 = Date.now();
const ago = (minutes) => new Date(T0 - minutes * 60_000).toISOString();
const run = (taskId, executor, title, minutes, extra = {}) => ({
  taskId, executor, title, workspace: "/tmp/fixture", kind: taskId.startsWith("qa--") ? "qa" : "task", phase: "writing", status: "active",
  startedAt: ago(minutes), updatedAt: new Date(T0).toISOString(), lastActivityAt: new Date(T0).toISOString(), ...extra,
});
const BUSY_RUNS = [
  run("fx-ops-graphic", "claude-code", "Expand the Ops graphic to show every running agent", 47, { phase: "testing", model: "claude-fable-5-2", requestedModel: "claude-fable-5-2", requestedEffort: "high", servedModel: "claude-fable-5-2", slotNumber: 2 }),
  run("fx-intake-form", "claude-code", "Repair the intake form validation", 12, { phase: "thinking", model: "claude-opus-5-5", requestedModel: "claude-fable-5-2", requestedEffort: "xhigh", servedModel: "claude-opus-5-5", slotNumber: 5 }),
  run("qa--fx-token-scan", "claude-code", "Review: token usage scan repair", 3, { phase: "reviewing", model: "claude-opus-5-5", requestedModel: "claude-opus-5-5", requestedEffort: "high" }),
  run("fx-slot-numbers", "codex", "Number the day's schedule slots", 26, { phase: "testing", model: "gpt-6.2-astra", requestedModel: "gpt-6.2-astra", requestedEffort: "xhigh", slotNumber: 3 }),
  // No model reported at all: must read "unknown", never a guess from "codex".
  run("fx-no-model", "codex", "Thought stream box follows the live run", 1, { phase: "thinking" }),
  run("fx-site-audit", "antigravity", "Audit the landing page on a phone", 8, { phase: "browsing", model: "gemini-4-argon" }),
];
const OVERFLOW_RUNS = Array.from({ length: 23 }, (_, i) => {
  const executor = i < 14 ? "claude-code" : i < 21 ? "codex" : "antigravity";
  const qa = i % 5 === 4;
  return run(`${qa ? "qa--" : ""}fx-many-${String(i + 1).padStart(2, "0")}`, executor, `${qa ? "Review: " : ""}Concurrent fixture task number ${i + 1}`, 60 - i * 2, {
    phase: qa ? "reviewing" : i % 3 ? "writing" : "testing",
    ...(i % 7 === 6 ? {} : { model: executor === "codex" ? "gpt-6.2-astra" : executor === "antigravity" ? "gemini-4-argon" : "claude-opus-5-5", requestedEffort: i % 2 ? "high" : "xhigh" }),
    ...(i % 4 === 0 ? { slotNumber: i / 4 + 1 } : {}),
  });
});
const SCENARIOS = {
  idle: { runs: [], queue: [], council: null },
  busy: { runs: BUSY_RUNS, queue: [], council: null },
  overflow: {
    runs: OVERFLOW_RUNS,
    queue: [
      { taskId: "fx-queued-1", title: "Queued: rebuild the system map", executor: "claude-code", enqueuedAt: ago(4), slotNumber: 9 },
      { taskId: "fx-queued-2", title: "Queued: refresh the model registry", executor: "codex", enqueuedAt: ago(2) },
      { taskId: "fx-queued-3", title: "Queued: weekly vault index", executor: "claude-code", enqueuedAt: ago(1), slotNumber: 11 },
    ],
    council: {
      sessionId: "fx-council", topic: "Fixture council: next improvements", phase: "deliberation", createdAt: T0 - 95_000, metadata: {},
      voices: [
        { name: "cli:claude-code/claude-opus-5-5", model: "cli:claude-code/claude-opus-5-5", status: "running", registeredAt: T0 - 95_000 },
        { name: "cli:codex/gpt-6.2-astra", model: "cli:codex/gpt-6.2-astra", status: "running", registeredAt: T0 - 95_000 },
        { name: "cli:antigravity/gemini-4-argon", model: "cli:antigravity/gemini-4-argon", status: "success", registeredAt: T0 - 95_000, elapsedMs: 41_000 },
      ],
      stats: { voiceCount: 3, thesisCount: 1, successCount: 1, failureCount: 0, hasSynthesis: false, elapsedMs: 95_000 }, durationMs: 95_000, hasSynthesis: false,
    },
  },
  trouble: {
    // Codex is suspended while it still holds a run: busy and in trouble at once.
    runs: [BUSY_RUNS[0], BUSY_RUNS[2], BUSY_RUNS[3]], queue: [], council: null, suspended: ["codex"],
    // Ended a moment before each request: the station counts a result as recent for 60 s (dispatch-station.tsx).
    ended: () => [run("fx-failed-run", "antigravity", "Audit the landing page on a phone", 9, { status: "failed", phase: "failed", model: "gemini-4-argon", updatedAt: new Date(Date.now() - 2_000).toISOString(), lastActivityAt: new Date(Date.now() - 2_000).toISOString() })],
  },
  delayed: { runs: [], queue: [], council: null, unavailable: true },
};
const EXECUTORS = ["claude-code", "codex", "antigravity", "openrouter"];
let scenario = "idle";
function dispatchState() {
  const s = SCENARIOS[scenario];
  const limit = Math.max(10, s.runs.length + 2);
  const occupancy = Object.fromEntries(EXECUTORS.map((e) => [e, { active: s.runs.filter((r) => r.executor === e).length, slots: null, free: limit - s.runs.length }]));
  return {
    antigravity: { bridge: null, active: 0, pending: 0, queue: [] }, dispatchLog: [], cron: [],
    executors: {
      runs: [...s.runs, ...(s.ended?.() ?? [])], sessions: [], history: [], cliQueue: s.queue, workers: { available: true, workers: [] },
      cliConcurrency: { limit, burst: true, reason: "burst: fixture state for the Ops graphic check", slots: {}, active: s.runs.length, free: limit - s.runs.length, occupancy, queued: s.queue.length },
      dispatchedToday: { total: s.runs.length, failed: 0 },
      posture: { mode: "nominal", available: ["claude-code", "codex", "antigravity"].filter((e) => !s.suspended?.includes(e)), suspended: s.suspended ?? [], crossExecutorQaPossible: true, summary: "fixture", since: ago(600) },
    },
    localLlm: { worker: { paused: false }, counts: {}, jobs: [] },
    lmStudio: { reachable: true, models: [], loadedCount: 1, lastActivityAt: null },
    system: { memory: { totalBytes: 64 * 1024 ** 3, availBytes: 40 * 1024 ** 3, availPct: 62 } },
  };
}
const BENCH = {
  name: "council-default", isDefault: true,
  references: [
    { id: "cli:codex/gpt-6.2-astra", kind: "cli", label: "Codex · GPT-6.2 Astra", model: "gpt-6.2-astra" },
    { id: "cli:claude-code/claude-opus-5-5", kind: "cli", label: "Claude Code · Opus 5.5", model: "claude-opus-5-5" },
    { id: "cli:antigravity/gemini-4-argon", kind: "cli", label: "Antigravity · Gemini 4 Argon", model: "gemini-4-argon" },
  ],
  aggregator: { id: "cli:claude-code/claude-opus-5-5", kind: "cli", label: "Claude Code · Opus 5.5", model: "claude-opus-5-5" },
};
const praxis = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method !== "GET") return json(405, { error: "the Ops graphic fixture is read-only" });
  if (url.pathname === "/api/dispatch/state") return SCENARIOS[scenario].unavailable ? json(503, { error: "fixture: dispatch signal delayed" }) : json(200, dispatchState());
  if (url.pathname === "/api/council/sessions") return json(200, { sessions: SCENARIOS[scenario].council ? [SCENARIOS[scenario].council] : [] });
  if (url.pathname === "/api/council/benches") return json(200, { benches: [BENCH] });
  if (url.pathname === "/api/council/arbiter") return json(200, { preference: "auto", next: "cli:codex", seats: ["cli:claude-code", "cli:codex"] });
  return json(404, { error: "not in the Ops graphic fixture" });
});
await new Promise((resolve) => praxis.listen(0, "127.0.0.1", resolve));
const PRAXIS_URL = `http://127.0.0.1:${praxis.address().port}`;

// ── children: started detached (own process group), ready on a printed line ──
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const children = [];
function start(name, cmd, args, opts, readyLine) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const logPath = path.join(os.tmpdir(), `nexus-ops-graphic-${LABEL}-${name}.txt`);
  const log = fs.createWriteStream(logPath);
  const closed = new Promise((resolve) => child.on("close", resolve));
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    const scan = (chunk) => {
      log.write(chunk);
      buf += chunk;
      const m = buf.match(readyLine);
      if (m) { resolve(m); buf = ""; } else buf = buf.slice(buf.lastIndexOf("\n") + 1);
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code, signal) => reject(new Error(`${name} exited (${signal || code}) before it was ready; output: ${logPath}`)));
  });
  ready.catch(() => {});
  children.push({ name, child, closed });
  return { ready, logPath };
}

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ops-graphic-")));
const distDir = ".next-verify-ops";
const restore = ["tsconfig.json", "next-env.d.ts"].map((name) => {
  const file = path.join(DASHBOARD, name);
  return { file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null };
});
async function teardown() {
  for (const { child, closed } of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    }
    await closed; // every process holding the child's output has exited
  }
  children.length = 0;
  await new Promise((resolve) => praxis.close(resolve));
  praxis.closeAllConnections?.();
  // next dev rewrites these two files for a custom dist dir; put the exact bytes back.
  for (const { file, bytes } of restore) { if (bytes) fs.writeFileSync(file, bytes); else fs.rmSync(file, { force: true }); }
  fs.rmSync(path.join(DASHBOARD, distDir), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
const abort = async (message) => { console.error(message); await teardown(); process.exit(2); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort(`stopped by ${signal}`));

const apiPort = await freePort();
const emptyFleetEnv = path.join(tmp, "empty-fleet-env");
fs.writeFileSync(emptyFleetEnv, "");
const api = start("api", process.execPath, ["server/server.js"], {
  cwd: NEXUS,
  env: { ...process.env, PORT: String(apiPort), NEXUS_DB_PATH: path.join(tmp, "nexus.db"), NEXUS_CHAT_FILES_DIR: path.join(tmp, "chat-files"), NEXUS_REVIEW_BLOB_DIR: path.join(tmp, "review-blobs"), PRAXIS_URL, FLEET_ENV_PATH: emptyFleetEnv },
}, /Local Nexus running on/);
try { await api.ready; } catch (err) { await abort(err.message); }
const API = `http://127.0.0.1:${apiPort}`;
console.log(`CHECK_API ${API} (empty temp database; Praxis stand-in ${PRAXIS_URL})`);

const devPort = await freePort();
const dev = start("next-dev", "npx", ["next", "dev", "--webpack", "-p", String(devPort)],
  { cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: distDir, NEXUS_API_URL: API, NEXT_PUBLIC_API_URL: API } }, /\bReady in\b/);
try { await dev.ready; } catch (err) { await abort(err.message); }
const BASE = `http://localhost:${devPort}`;
console.log(`CHECK_BASE ${BASE} (${LABEL}; dashboard ${DASHBOARD})`);

const profile = path.join(tmp, "chrome-profile");
const chrome = start("chrome", CHROME, [
  `--host-resolver-rules=MAP localhost:4000 127.0.0.1:${apiPort}, MAP 127.0.0.1:4000 127.0.0.1:${apiPort}`, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], {}, /DevTools listening on (ws:\/\/\S+)/);
let browserWs;
try { browserWs = new URL((await chrome.ready)[1]); } catch (err) { await abort(err.message); }
const target = await (await fetch(`http://${browserWs.host}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const listeners = [];
const exceptions = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails?.text);
  for (const fn of [...listeners]) fn(m);
};
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const once = (method) => new Promise((resolve) => {
  const fn = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(fn), 1); resolve(m.params); } };
  listeners.push(fn);
});
const evalJs = async (expression) => {
  const { result } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(`page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");

/** Two animation frames: whatever the page committed before the call is on screen. */
const painted = () => evalJs("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
/**
 * Resolves true as soon as `predicate` (a page expression) holds, watching the
 * DOM for changes; false if it has not held after `limitMs` (a failure bound).
 */
const until = (predicate, limitMs = 60_000) => evalJs(`new Promise((resolve) => {
  const holds = () => { try { return Boolean(${predicate}); } catch { return false; } };
  if (holds()) return resolve(true);
  const observer = new MutationObserver(() => { if (holds()) { observer.disconnect(); clearTimeout(limit); resolve(true); } });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const limit = setTimeout(() => { observer.disconnect(); resolve(holds()); }, ${limitMs});
})`);
async function navigate(url) {
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
}
/**
 * Screenshot of one element, whole. The viewport is made as tall as the page
 * for the capture, so nothing has to scroll and the sticky header and the
 * fixed voice bar stay at the page edges instead of lying over the element.
 */
async function shotOf(vp, selector, name, pad = 8, alsoTo = null) {
  const pageHeight = await evalJs("document.documentElement.scrollHeight");
  await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: Math.max(vp.height, pageHeight), deviceScaleFactor: vp.scale, mobile: vp.mobile });
  await evalJs("(scrollTo(0, 0), true)");
  await painted();
  const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, page: document.documentElement.scrollWidth }; })()`);
  let saved = null;
  if (box) {
    const x = Math.max(0, box.x - pad);
    const clip = { x, y: Math.max(0, box.y - pad), width: Math.min(box.width + pad * 2, box.page - x), height: box.height + pad * 2, scale: 1 };
    const { result } = await send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data, "base64"));
    if (alsoTo) fs.writeFileSync(alsoTo, Buffer.from(result.data, "base64"));
    saved = name;
  } else check(false, `screenshot target ${selector} exists`, name);
  await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile });
  await painted();
  return saved;
}

/** Everything the assertions need from the Ops graphic, read in one pass. */
const READ_MAP = `(() => {
  const map = document.querySelector('.dispatch-map');
  if (!map) return null;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
  const text = (el, sel) => el.querySelector(sel)?.textContent.trim() ?? null;
  const runs = [...map.querySelectorAll('.dispatch-run')].map((el) => {
    const title = el.getAttribute('title')?.split('\\n')[0] ?? null;
    const first = el.firstElementChild;
    // Rows the node's text wraps onto: distinct top edges of its children.
    const rows = new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top))).size;
    return {
      key: el.dataset.run, provider: el.closest('[data-provider]')?.dataset.provider, role: text(el, '.dispatch-run-role'), title, aria: el.getAttribute('aria-label'),
      model: text(el, '.dispatch-run-model'), effort: text(el, '.dispatch-run-effort'), phase: text(el, '.dispatch-run-phase'), elapsed: text(el, '.dispatch-run-elapsed'),
      slot: text(el, '.dispatch-run-slot'), standin: text(el, '.dispatch-run-standin'), head: first ? { cls: first.className, text: first.textContent.trim() } : null,
      visibleTitle: text(el, '.dispatch-run-title'), titleShown: title ? el.innerText.includes(title) : false, rows,
      fontPx: Math.min(...[...el.children].map((c) => parseFloat(getComputedStyle(c).fontSize))), box: rect(el),
    };
  });
  const flows = [...map.querySelectorAll('path.module-flow')].map((p) => { const cs = getComputedStyle(p); return { wire: p.dataset.wire ?? null, animation: cs.animationName, state: cs.animationPlayState, duration: cs.animationDuration, length: Math.round(p.getTotalLength()) }; });
  const logos = [...map.querySelectorAll('[data-logo]')].map((el) => ({ provider: el.dataset.logo, tag: el.tagName, box: rect(el), loaded: el.tagName === 'IMG' ? el.complete && el.naturalWidth > 0 : getComputedStyle(el).maskImage !== 'none' || getComputedStyle(el).webkitMaskImage !== 'none' }));
  const base = map.getBoundingClientRect();
  // Path end points in page px: the wires are drawn in the map's own coordinates.
  const ends = (p) => { const n = p.getTotalLength(); const a = p.getPointAtLength(0), b = p.getPointAtLength(n); return [a, b].map((q) => ({ x: Math.round(q.x + base.left + map.clientLeft), y: Math.round(q.y + base.top + map.clientTop) })); };
  const station = document.querySelector('#station-dispatch');
  return {
    live: map.dataset.live, runCount: map.dataset.runs ?? null, map: rect(map), runs, flows, logos,
    heights: { station: station ? Math.round(station.getBoundingClientRect().height) : null, map: Math.round(base.height) },
    providers: [...map.querySelectorAll('[data-provider]')].map((el) => {
      const button = el.querySelector('.dispatch-provider-button');
      const logo = el.querySelector('.dispatch-logo');
      const badge = el.querySelector('.dispatch-logo-badge');
      const wires = [...map.querySelectorAll('[data-wires="' + el.dataset.provider + '"] path[data-wire="spoke"], [data-wires="' + el.dataset.provider + '"] path[data-wire="run"]')];
      const lcs = logo ? getComputedStyle(logo) : null;
      return {
        id: el.dataset.provider, expanded: el.dataset.expanded ?? null, active: el.dataset.active, trouble: el.dataset.trouble ?? null,
        label: text(el, '.dispatch-provider-label'), phase: text(el, '.dispatch-phase'), runList: !!el.querySelector('.dispatch-runs'),
        // Visible text other than the logo itself (OpenRouter and unknown workers draw a glyph as their logo).
        buttonText: button ? button.innerText.replace(el.querySelector('.dispatch-logo-glyph')?.innerText ?? '', '').trim() : null, glyph: text(el, '.dispatch-logo-glyph'), aria: button?.getAttribute('aria-label') ?? null, title: button?.getAttribute('title') ?? null,
        button: button ? rect(button) : null, logo: logo ? rect(logo) : null,
        ring: lcs ? { width: lcs.borderTopWidth, style: lcs.borderTopStyle, color: lcs.borderTopColor, glow: lcs.boxShadow } : null,
        badge: badge ? { trouble: badge.dataset.trouble, box: rect(badge), background: getComputedStyle(badge).backgroundColor, visible: getComputedStyle(badge).visibility === 'visible' && getComputedStyle(badge).display !== 'none' } : null,
        wireEnds: wires.map((p) => ({ wire: p.dataset.wire, ends: ends(p) })),
      };
    }),
    oldChips: map.querySelectorAll('.dispatch-chip').length, queue: document.querySelector('.dispatch-queue')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, viewport: innerWidth,
  };
})()`;
const READ_VIEWER = `(() => {
  const core = document.querySelector('#station-core');
  if (!core) return null;
  const crewHeading = [...core.querySelectorAll('span')].find((el) => el.textContent.trim().toLowerCase() === 'crew' && el.children.length === 0);
  return { crewSection: Boolean(crewHeading), crewChips: crewHeading ? crewHeading.closest('div.w-full')?.querySelectorAll('button').length ?? 0 : 0, text: core.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) };
})()`;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const report = { label: LABEL, at: new Date().toISOString(), base: BASE, dashboard: DASHBOARD, scenarios: {} };

for (const vp of VIEWPORTS) {
  await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile });
  for (const name of Object.keys(SCENARIOS)) {
    scenario = name;
    const expected = SCENARIOS[name];
    const seats = expected.council ? expected.council.voices.filter((v) => v.status === "running").length : 0;
    const want = expected.runs.length + seats;
    const tag = `${vp.name} ${name}`;
    await navigate(`${BASE}/`);
    // On screen: the map is live and reports this scenario's run count (the
    // delayed scenario: the map is up and reports the signal as not live).
    const wires = `document.querySelectorAll('.dispatch-wires path[data-wire="spoke"]').length > 0`;
    const ready = await until(expected.unavailable
      // The old tree (before mode) has no trouble marks; there every pod read "Signal delayed".
      ? `document.querySelector('.dispatch-map')?.dataset.live === 'false' && [...document.querySelectorAll('[data-provider]')].length > 0 && [...document.querySelectorAll('[data-provider]')].every((p) => ${AFTER ? `p.dataset.trouble === 'delayed'` : `/Signal delayed/i.test(p.innerText)`}) && ${wires}`
      : `document.querySelector('.dispatch-map')?.dataset.live === 'true' && document.querySelector('.dispatch-map').dataset.runs === '${want}' && ${wires}${expected.ended ? ` && /Run failed/.test(document.querySelector('[data-provider="antigravity"] .dispatch-provider-button')?.getAttribute('aria-label') + document.querySelector('[data-provider="antigravity"]')?.innerText)` : ""}`);
    await evalJs("document.fonts.ready.then(() => true)");
    await painted();
    // Colours change through CSS transitions (the logo ring, .dispatch-logo); read them once those have finished.
    await evalJs("Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => null))).then(() => true)");
    await painted();
    const map = await evalJs(READ_MAP);
    const viewer = await evalJs(READ_VIEWER);
    const out = (report.scenarios[tag] = { expectedRuns: expected.runs.length, expectedSeats: seats, map, viewer });
    check(ready && !!map, `${tag}: the Ops graphic shows the scenario`, map ? `data-live=${map.live} data-runs=${map.runCount}` : "no map");
    if (!map) continue;
    console.log(`CHECK_HEIGHT ${LABEL} ${tag}: Ops panel (#station-dispatch) ${map.heights.station}px, map ${map.heights.map}px at ${map.viewport}px wide`);
    out.opsShot = await shotOf(vp, "#station-dispatch", `${name}-${vp.name}-ops-panel.png`, 8, name === "busy" ? path.join(PACKAGE, `busy-${vp.name}-ops-panel.png`) : null);

    if (!AFTER) {
      console.log(`CHECK_NOTE  ${tag}: baseline tree shows ${map.providers.length} provider pods and ${map.runs.length} run nodes`);
      continue;
    }

    // Executor nodes: the logo alone; name and status only in the label and title.
    const texty = map.providers.filter((p) => p.label !== null || p.phase !== null || p.buttonText !== "");
    check(texty.length === 0, `${tag}: executor nodes show the logo with no visible name or status text`, texty.map((p) => `${p.id}: "${p.buttonText}"`).join(", ") || map.providers.map((p) => p.id).join(", "));
    const unnamed = map.providers.filter((p) => { const status = p.aria?.replace(/^Inspect [^:]+: /, ""); return !p.aria?.startsWith("Inspect ") || !status || !p.title?.includes(status); });
    check(unnamed.length === 0, `${tag}: each executor's name and status stay in its aria-label and title`, unnamed.map((p) => p.id).join(", ") || map.providers.map((p) => `${p.aria}`).join(" | "));
    // The wires meet the logo itself: the hub spoke ends inside the logo box and every run branch starts there.
    const inside = (pt, box) => pt.x >= box.left && pt.x <= box.right && pt.y >= box.top && pt.y <= box.bottom;
    const offLogo = map.providers.flatMap((p) => p.wireEnds.filter((w) => !inside(w.wire === "spoke" ? w.ends[1] : w.ends[0], p.logo)).map((w) => `${p.id} ${w.wire} ${JSON.stringify(w.ends)} logo ${JSON.stringify(p.logo)}`));
    check(offLogo.length === 0 && map.providers.every((p) => p.wireEnds.some((w) => w.wire === "spoke")), `${tag}: the connector lines pass through the logo`, offLogo.join(" | ") || `${map.providers.reduce((n, p) => n + p.wireEnds.length, 0)} wire ends on logos`);
    // Trouble on the logo, without words.
    const wantTrouble = expected.unavailable ? Object.fromEntries(map.providers.map((p) => [p.id, "delayed"])) : { ...Object.fromEntries((expected.suspended ?? []).map((id) => [id, "suspended"])), ...(expected.ended ? { antigravity: "failed" } : {}) };
    // Ring colours from globals.css: failed #fb7185, suspended #fbbf24, delayed #94a3b8 (dashed).
    const RING = { failed: "rgb(251, 113, 133)", suspended: "rgb(251, 191, 36)", delayed: "rgb(148, 163, 184)" };
    // The glow is the trouble's colour even while the executor is busy (failed and suspended; delayed has none).
    const glowWrong = (p) => p.trouble === "delayed" ? p.ring.glow !== "none" : !p.ring.glow.includes(RING[p.trouble].slice(4, -1));
    const troubleWrong = map.providers.filter((p) => (wantTrouble[p.id] ?? null) !== p.trouble || (p.trouble ? !p.badge?.visible || p.badge.trouble !== p.trouble || p.badge.box.width < 10 || p.ring?.width !== "2px" || p.ring.color !== RING[p.trouble] || (p.trouble === "delayed") !== (p.ring.style === "dashed") || glowWrong(p) : p.badge !== null || p.ring?.width !== "1px"));
    check(troubleWrong.length === 0, `${tag}: failed, suspended and delayed executors are marked on the logo (ring and badge), healthy ones are not`, troubleWrong.map((p) => `${p.id}=${p.trouble}`).join(", ") || map.providers.map((p) => `${p.id}:${p.trouble ?? "ok"}${p.ring ? ` ${p.ring.width} ${p.ring.style} ${p.ring.color}` : ""}`).join(" | "));
    if (expected.unavailable) continue;

    // One child per run, each with task, model, role and elapsed time.
    check(map.runs.length === want, `${tag}: one child node per live run`, `${map.runs.length} nodes for ${expected.runs.length} runs + ${seats} sitting seats`);
    const missing = expected.runs.filter((r) => { const n = map.runs.find((x) => x.key === r.taskId); return !n || n.provider !== r.executor || n.title !== r.title; });
    check(missing.length === 0, `${tag}: every run is under its own provider with its task title on hover`, missing.map((r) => r.taskId).join(", ") || `${expected.runs.length} matched`);
    const titled = map.runs.filter((n) => n.visibleTitle !== null || n.titleShown || !n.aria?.includes(n.title));
    check(titled.length === 0, `${tag}: no run node draws its task title; the title stays in the hover title and aria-label`, titled.map((n) => n.key).join(", ") || `${map.runs.length} nodes`);
    const incomplete = map.runs.filter((n) => !n.model || !n.role || !n.elapsed);
    check(incomplete.length === 0, `${tag}: every node shows model, role and elapsed time`, incomplete.map((n) => n.key).join(", ") || "all complete");
    const wrongRole = expected.runs.filter((r) => map.runs.find((n) => n.key === r.taskId)?.role !== (r.kind === "qa" ? "reviewing" : "building"));
    check(wrongRole.length === 0, `${tag}: task runs read building, QA review runs read reviewing`, wrongRole.map((r) => r.taskId).join(", "));
    const slotWrong = expected.runs.filter((r) => {
      const n = map.runs.find((x) => x.key === r.taskId);
      const role = r.kind === "qa" ? "reviewing" : "building";
      return r.slotNumber ? n?.slot !== `S${r.slotNumber}` || n.head?.cls !== "dispatch-run-slot" || n.standin !== null
        : n?.slot !== null || n.head?.cls !== "dispatch-run-standin dispatch-run-role" || n.head.text !== role;
    });
    check(slotWrong.length === 0, `${tag}: a slotted run leads with S<number>, an unslotted run with its role word (never an empty head)`, slotWrong.map((r) => r.taskId).join(", ") || `${expected.runs.filter((r) => r.slotNumber).length} tagged, ${expected.runs.filter((r) => !r.slotNumber).length} with the role stand-in`);
    const unknownWrong = expected.runs.filter((r) => !r.model && !r.requestedModel && !r.servedModel && map.runs.find((n) => n.key === r.taskId)?.model !== "unknown");
    check(unknownWrong.length === 0, `${tag}: a run with no reported model reads 'unknown'`, `${expected.runs.filter((r) => !r.model && !r.requestedModel && !r.servedModel).length} such runs`);
    // Idle providers collapse; busy ones expand.
    const badExpand = map.providers.filter((p) => (p.expanded === "true") !== map.runs.some((n) => n.provider === p.id) || p.runList !== (p.expanded === "true"));
    check(badExpand.length === 0, `${tag}: a provider is expanded only while it holds runs`, map.providers.map((p) => `${p.id}=${p.expanded}`).join(" "));
    // Present and legible: inside the map, not overlapping, readable text, no sideways scroll.
    const outside = map.runs.filter((n) => n.box.width < 100 || n.box.height < 20 || n.box.left < map.map.left || n.box.right > map.map.right || n.box.top < map.map.top || n.box.bottom > map.map.bottom);
    check(outside.length === 0, `${tag}: every run node lies inside the graphic at a usable size`, outside.map((n) => `${n.key} ${JSON.stringify(n.box)}`).join(" | ") || `narrowest ${Math.min(...map.runs.map((n) => n.box.width), Infinity)}px`);
    const clashes = map.runs.flatMap((a, i) => map.runs.slice(i + 1).filter((b) => overlaps(a.box, b.box)).map((b) => `${a.key}/${b.key}`));
    check(clashes.length === 0, `${tag}: no two run nodes overlap`, clashes.join(", "));
    // 10px is the run line's size before this change (globals.css .dispatch-run-meta, then .dispatch-run).
    const tiny = map.runs.filter((n) => n.fontPx < 10);
    check(tiny.length === 0, `${tag}: run node text stays at 10px or more`, tiny.map((n) => n.key).join(", ") || (map.runs.length ? `rows per node: ${map.runs.map((n) => n.rows).join(",")}` : "no runs"));
    check(map.pageOverflowX <= 0, `${tag}: the page does not scroll sideways`, `overflow ${map.pageOverflowX}px at ${map.viewport}px`);
    // Logos: the four vendor files render at 20px or less (the old chip was 35px).
    const need = ["claude-code", "codex", "antigravity", "local-llm"];
    const logoBad = need.filter((id) => { const l = map.logos.find((x) => x.provider === id); return !l || !l.loaded || l.box.width > 20 || l.box.width < 12; });
    check(logoBad.length === 0 && map.oldChips === 0, `${tag}: vendor logos render, smaller than the old 35px chips`, map.logos.map((l) => `${l.provider} ${l.box.width}px ${l.loaded ? "loaded" : "NOT loaded"}`).join(", "));
    // Animation: every flow wire runs a CSS animation along a real path.
    const runFlows = map.flows.filter((f) => f.wire === "run-flow");
    const stalled = map.flows.filter((f) => f.animation === "none" || f.state !== "running" || f.length <= 0);
    check(stalled.length === 0 && runFlows.length === want && (want === 0 || map.flows.some((f) => f.wire === "spoke-flow")), `${tag}: work flows along the edges of every busy node`, `${runFlows.length} run wires and ${map.flows.filter((f) => f.wire === "spoke-flow").length} hub wires animating (${[...new Set(map.flows.map((f) => f.animation))].join(",") || "none while idle"})`);
    if (want > 0) {
      // The dash offset really moves between two painted frames.
      const moved = await evalJs(`(async () => { const p = document.querySelector('.dispatch-wires path[data-wire="run-flow"]'); const a = getComputedStyle(p).strokeDashoffset; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return [a, getComputedStyle(p).strokeDashoffset]; })()`);
      check(moved[0] !== moved[1], `${tag}: the flow marker moves between frames`, `stroke-dashoffset ${moved[0]} -> ${moved[1]}`);
    }
    if (name === "overflow") check(/Queued: rebuild the system map/.test(map.queue ?? "") && /S9/.test(map.queue ?? "") && /\+1 queued/.test(map.queue ?? ""), `${tag}: queued work stays visible, with its slot tag`, map.queue);
    // Main viewer: no Crew section.
    check(viewer && !viewer.crewSection, `${tag}: the main viewer has no Crew section`, viewer ? viewer.text.slice(0, 80) : "no viewer");

    if (name === "busy") {
      // Drill-down: a run node and a provider node each open the executor popup.
      for (const [what, selector, title] of [["run node", '[data-run="qa--fx-token-scan"]', "Claude Code"], ["provider node", '[data-provider="codex"] .dispatch-provider-button', "Codex"]]) {
        await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);
        const opened = await until(`[...document.querySelectorAll('[role="dialog"]')].some((d) => /dispatch telemetry/i.test(d.innerText) && d.innerText.toLowerCase().includes(${JSON.stringify(title.toLowerCase())}) && !/Loading/i.test(d.innerText))`);
        await painted();
        const dialog = await evalJs(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => /dispatch telemetry/i.test(x.innerText)); return d ? d.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300) : null; })()`);
        check(opened && !!dialog, `${tag}: a ${what} opens the executor drill-down`, dialog?.slice(0, 120));
        if (what === "run node") {
          const { result } = await send("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(path.join(OUT, `busy-${vp.name}-drill-down-from-run-node.png`), Buffer.from(result.data, "base64"));
          out.drillDownShot = `busy-${vp.name}-drill-down-from-run-node.png`;
        }
        await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) || true`);
        check(await until(`![...document.querySelectorAll('[role="dialog"]')].some((d) => /dispatch telemetry/i.test(d.innerText))`, 10_000), `${tag}: the drill-down closes again`);
      }
    }
  }
}
check(exceptions.length === 0, "no uncaught page exception during the run", exceptions.slice(0, 3).join(" | "));

report.failures = failures;
fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
ws.close();
await teardown();
console.log(failures.length ? `CHECK_RESULT fail (${failures.length}): ${failures.join("; ")}` : `CHECK_RESULT pass (${LABEL}); screenshots and report.json in ${OUT}`);
process.exit(failures.length ? 1 : 0);
