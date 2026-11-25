#!/usr/bin/env node
/**
 * Real-browser check for task fa032fc0 (2026-11-24): the local model is chosen
 * under Model Control from LM Studio's own list; a choice made while a local
 * job runs waits for it; every switch is recorded and restores in one action.
 *
 * One foreground process owns the stack and tears it down by process group:
 *   - a fake LM Studio, in this process. GET /api/v1/models answers the listing
 *     below; any other request is recorded and refused, so a load, an unload or
 *     a model call would show in the report and fail the check;
 *   - saved load profiles in a temporary LMSTUDIO_HOME, in LM Studio's format;
 *   - a stand-in for Praxis, in this process, with Praxis's rule
 *     (Praxis src/llm/local-model-selection.ts): a sync reads Nexus's setting
 *     and, when no local work runs, puts a waiting choice into effect through
 *     Nexus's POST /api/model-control/local-model/apply; when its local work
 *     ends it tries again. GET /local-model is its snapshot. The check starts
 *     and ends one local job there;
 *   - a throwaway Nexus API (this checkout's server/server.js) on an empty
 *     temporary SQLite database, with api-network-guard.mjs preloaded;
 *   - next dev --webpack (this checkout's dashboard) on an OS-assigned port,
 *     dist dir .next-verify-local-model;
 *   - headless Chrome over CDP. Host-resolver rules send localhost:3000 to that
 *     next dev and localhost:4000 to the throwaway API, so the page has an
 *     origin the API's Socket.IO accepts (server/server.js ALLOWED_ORIGINS) and
 *     the panel hears model-control:local-model as it does on the cockpit.
 *     The rules are proven first on a port nothing listens on; the panel must
 *     show the fake listing's address before anything is clicked; and every
 *     response the page receives must come from the stack's own ports.
 * Nothing here reads or writes the live board, nexus.db, LM Studio or Praxis.
 *
 * No step waits a fixed time: children are ready on their own printed lines,
 * page states are awaited with a DOM observer (its limit is a failure bound,
 * not a wait), and a screenshot follows a painted frame.
 *
 *   node docs/reviews/2026-11-23-local-model-control-evidence/local-model-browser-check.mjs
 *
 * Writes the three review screenshots to docs/reviews/2026-11-23-local-model-control/,
 * the other screenshots and report.json next to this file; exits 1 on any
 * failed assertion. Env: CHECK_CHROME.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const NEXUS = path.resolve(here, "..", "..", "..");
const DASHBOARD = path.join(NEXUS, "dashboard");
const PACKAGE_DIR = path.join(NEXUS, "docs", "reviews", "2026-11-23-local-model-control");
const OUT = here;
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
fs.mkdirSync(PACKAGE_DIR, { recursive: true });

// The two widths the repo's layout audit covers (dashboard/scripts/responsive-audit.mjs, "390,1440"),
// both at 2x: a Retina Mac window, and the iPhone 12-15 CSS viewport the other phone checks use.
const DESKTOP = { name: "desktop", width: 1440, height: 900, scale: 2, mobile: false };
const PHONE = { name: "phone", width: 390, height: 844, scale: 2, mobile: true };

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "CHECK_OK  " : "CHECK_FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
};
const note = (text) => console.log(`CHECK_NOTE ${text}`);

// ── LM Studio's listing: the rows and order it gave on this machine on 2026-11-24
// (the same rows as server/__tests__/local-model-selection.test.js) ──
const chatModel = (over) => ({ type: "llm", loaded_instances: [], format: "gguf", quantization: { name: "Q4_K_M", bits_per_weight: 4 }, capabilities: { vision: true, trained_for_tool_use: true }, ...over });
const INKLING = chatModel({ key: "thinkingmachines/inkling-2-mini", display_name: "Inkling 2 Mini", publisher: "thinkingmachines", size_bytes: 18119934834, max_context_length: 1048576, params_string: "26.4B",
  capabilities: { vision: true, trained_for_tool_use: false, reasoning: { allowed_options: ["low", "medium", "high", "xhigh"], default: "high" } } });
const QWEN = chatModel({ key: "qwen/qwen3.8-27b", display_name: "Qwen3.8 27B", publisher: "qwen", size_bytes: 16081678492, max_context_length: 262144, params_string: "27B", format: "mlx", quantization: { name: "4bit", bits_per_weight: 4 } });
const GEMMA_QAT = chatModel({ key: "google/gemma-4-31b-qat", display_name: "Gemma 4 31B QAT", publisher: "google", size_bytes: 18851799617, max_context_length: 262144, params_string: "31B", quantization: { name: "Q4_0", bits_per_weight: 4 } });
const GEMMA = chatModel({ key: "google/gemma-4-31b", display_name: "Gemma 4 31B", publisher: "google", size_bytes: 19887882864, max_context_length: 262144, params_string: "31B" });
const NOMIC = { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5", display_name: "Nomic Embed Text v1.5", publisher: "nomic-ai", size_bytes: 84106624, max_context_length: 2048, format: "gguf",
  loaded_instances: [{ id: "text-embedding-nomic-embed-text-v1.5", config: { context_length: 2048 } }] };
// A model downloaded while the cockpit is open (the server test's new-download row).
const MINISTRAL = chatModel({ key: "mistralai/ministral-4-14b", display_name: "Ministral 4 14B", publisher: "mistralai", size_bytes: 8800000000, max_context_length: 131072, params_string: "14B" });
// Saved load contexts as on this machine at the start of the run: both Gemmas and Inkling, none for Qwen.
const SAVED = { [GEMMA_QAT.key]: 131072, [GEMMA.key]: 131072, [INKLING.key]: 131072 };
// Praxis's tested keys (Praxis src/llm/local-model-capabilities.ts, testedLocalModelKeys()).
const TESTED = [GEMMA_QAT.key, GEMMA.key, INKLING.key];
// The Nexus model registry's names for the rows local_default points at: LM Studio's name plus
// " (local)" (db/index.js seeds the Gemma row so; server/services/local-model-selection.js names new
// rows so). The model in effect, a waiting switch and the history use them; the list shows LM Studio's.
const GEMMA_QAT_ROW = "Gemma 4 31B QAT (local)";
const INKLING_ROW = "Inkling 2 Mini (local)";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-local-model-check-")));
const lmsHome = path.join(tmp, "lmstudio-home");
function saveProfile(key, contextLength) {
  const file = path.join(lmsHome, ".internal", "user-concrete-model-default-config", `${key}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ preset: "", operation: { fields: [] }, load: { fields: [{ key: "llm.load.contextLength", value: contextLength }, { key: "llm.load.llama.acceleration.offloadRatio", value: 1 }] } }, null, 2)}\n`);
}
for (const [key, context] of Object.entries(SAVED)) saveProfile(key, context);

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const lmStudio = { listing: [INKLING, QWEN, GEMMA_QAT, GEMMA, NOMIC], requests: [] };
const lmsServer = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://fake").pathname;
  lmStudio.requests.push({ at: new Date().toISOString(), method: req.method, path: pathname });
  res.writeHead(req.method === "GET" && pathname === "/api/v1/models" ? 200 : 403, { "content-type": "application/json" });
  res.end(JSON.stringify(req.method === "GET" && pathname === "/api/v1/models" ? { models: lmStudio.listing } : { error: "the fake LM Studio only lists models" }));
});
const lmsPort = await listen(lmsServer);
const LMS_URL = `http://127.0.0.1:${lmsPort}`;

// ── the Praxis stand-in ──
let API = null;
const praxisLog = [];
const praxisState = { active: GEMMA_QAT.key, since: new Date().toISOString(), pending: null, applying: null, lastSync: null, localWork: [] };
const logPraxis = (line) => { praxisLog.push(`${new Date().toISOString()} ${line}`); };
async function nexus(pathname, init = {}) {
  // 4 s: what Praxis gives each request for this setting (Praxis src/llm/local-model-selection.ts, NEXUS_TIMEOUT_MS).
  const res = await fetch(`${API}/api/model-control/local-model${pathname}`, { ...init, headers: { "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(4_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function plan(current) {
  const p = praxisState.pending;
  if (current.selected && current.active && current.selected !== current.active) {
    if (!p || p.model !== current.selected || p.selectionId !== current.selectionId) {
      praxisState.pending = { model: current.selected, selectionId: current.selectionId, requestedAt: current.requestedAt, surface: current.surface, waitingFor: [], nexusWaitingFor: [] };
    }
    return;
  }
  praxisState.pending = null;
  if (current.active && current.active !== praxisState.active) { praxisState.active = current.active; praxisState.since = new Date().toISOString(); }
}
function tryApply() {
  if (praxisState.applying) return praxisState.applying;
  const p = praxisState.pending;
  if (!p) return Promise.resolve();
  if (praxisState.localWork.length) {
    p.waitingFor = [...praxisState.localWork];
    logPraxis(`the switch to ${p.model} waits for ${praxisState.localWork.map((w) => w.label).join(", ")}; no apply`);
    return Promise.resolve();
  }
  praxisState.applying = (async () => {
    const { status, body } = await nexus("/apply", { method: "POST", body: JSON.stringify({ selectionId: p.selectionId, model: p.model }) });
    logPraxis(`POST /api/model-control/local-model/apply ${p.model} -> ${status}${body?.error ? ` ${body.error}` : ""}`);
    if (status === 200) {
      praxisState.active = body.active;
      praxisState.since = new Date().toISOString();
      if (praxisState.pending === p) praxisState.pending = null;
    } else if (status === 409 && body?.error === "busy") p.nexusWaitingFor = body.waitingFor || [];
    else if (status === 409 && body?.error === "superseded") { if (praxisState.pending === p) praxisState.pending = null; queueMicrotask(() => void sync("superseded")); }
    else p.lastError = `Nexus answered ${status}`;
  })().catch((err) => { p.lastError = String(err?.message || err); }).finally(() => { praxisState.applying = null; });
  return praxisState.applying;
}
async function sync(trigger) {
  const { status, body } = await nexus("/current");
  praxisState.lastSync = { at: new Date().toISOString(), trigger, ok: status === 200 };
  logPraxis(`sync (${trigger}): Nexus answered ${status}, active ${body?.active}, selected ${body?.selected}`);
  if (status === 200 && body) { plan(body); await tryApply(); }
  return snapshot();
}
function snapshot() {
  const p = praxisState.pending;
  return {
    active: praxisState.active, source: "nexus", since: praxisState.since,
    ...(p ? { pending: { model: p.model, selectionId: p.selectionId, requestedAt: p.requestedAt, surface: p.surface, waitingFor: [...praxisState.localWork], nexusWaitingFor: [...p.nexusWaitingFor], applying: praxisState.applying !== null, ...(p.lastError ? { lastError: p.lastError } : {}) } } : {}),
    ...(praxisState.lastSync ? { lastSync: praxisState.lastSync } : {}),
    tested: TESTED,
  };
}
const praxis = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* the sync body only names a reason */ }
  const pathname = new URL(req.url, "http://stand-in").pathname;
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && pathname === "/local-model") return json(200, snapshot());
  if (req.method === "POST" && pathname === "/local-model/sync") return json(200, await sync("Nexus asked"));
  return json(404, { error: "not in the local model stand-in" });
});
const praxisPort = await listen(praxis);
const PRAXIS_URL = `http://127.0.0.1:${praxisPort}`;
const LOCAL_JOB = { kind: "local_job", label: "Nightly transcript summaries", id: "fx-local-job-1" };
function startLocalJob() {
  praxisState.localWork = [{ ...LOCAL_JOB, since: new Date(Date.now() - 4 * 60_000).toISOString() }];
  logPraxis(`local job started: ${LOCAL_JOB.label}`);
}
async function endLocalJob() {
  praxisState.localWork = [];
  logPraxis(`local job ended: ${LOCAL_JOB.label}`);
  if (praxisState.pending) await tryApply(); // Praxis: onLocalWorkSettled(() => tryApply())
}

// A page to prove Chrome's host-resolver rules on a port nothing listens on.
const probeNonce = `local-model-check-${process.pid}-${Date.now()}`;
const probe = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(probeNonce); });
const probePort = await listen(probe);

// ── children: started detached (own process group), ready on a printed line ──
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const children = [];
function start(name, cmd, args, opts, readyLine) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const logPath = path.join(tmp, `${name}.txt`);
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
  children.push({ name, child, closed, logPath });
  return { ready, logPath };
}

const distDir = ".next-verify-local-model";
const restore = ["tsconfig.json", "next-env.d.ts"].map((name) => {
  const file = path.join(DASHBOARD, name);
  return { file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null };
});
let apiLocalModelLines = [];
async function teardown() {
  for (const { child, closed } of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    }
    await closed;
  }
  const apiLog = path.join(tmp, "api.txt");
  if (fs.existsSync(apiLog)) apiLocalModelLines = fs.readFileSync(apiLog, "utf8").split("\n").filter((l) => l.includes("[LocalModel]"));
  children.length = 0;
  for (const server of [praxis, lmsServer, probe]) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  // next dev rewrites these two files for a custom dist dir; put the exact bytes back.
  for (const { file, bytes } of restore) { if (bytes) fs.writeFileSync(file, bytes); else fs.rmSync(file, { force: true }); }
  fs.rmSync(path.join(DASHBOARD, distDir), { recursive: true, force: true });
}
const guardLog = path.join(tmp, "api-network-guard.jsonl");
const readGuard = () => (fs.existsSync(guardLog) ? fs.readFileSync(guardLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const abort = async (message) => { console.error(`CHECK_ABORT ${message}`); await teardown(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort(`stopped by ${signal}`));

const apiPort = await freePort();
API = `http://127.0.0.1:${apiPort}`;
const emptyFleetEnv = path.join(tmp, "empty-fleet-env");
fs.writeFileSync(emptyFleetEnv, "");
const api = start("api", process.execPath, ["--import", pathToFileURL(path.join(here, "api-network-guard.mjs")).href, "server/server.js"], {
  cwd: NEXUS,
  env: {
    ...process.env, PORT: String(apiPort), NEXUS_DB_PATH: path.join(tmp, "nexus.db"), NEXUS_CHAT_FILES_DIR: path.join(tmp, "chat-files"), NEXUS_REVIEW_BLOB_DIR: path.join(tmp, "review-blobs"),
    PRAXIS_URL, FLEET_ENV_PATH: emptyFleetEnv, LMSTUDIO_API_URL: LMS_URL, LOCAL_LLM_URL: `${LMS_URL}/v1`, LMSTUDIO_HOME: lmsHome, NET_GUARD_LOG: guardLog,
  },
}, /Local Nexus running on/);
try { await api.ready; } catch (err) { await abort(err.message); }
console.log(`CHECK_API ${API} (empty temp database; Praxis stand-in ${PRAXIS_URL}; fake LM Studio ${LMS_URL})`);

const devPort = await freePort();
const dev = start("next-dev", "npx", ["next", "dev", "--webpack", "-p", String(devPort)],
  { cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: distDir, NEXUS_API_URL: API, NEXT_PUBLIC_API_URL: API, NEXT_TELEMETRY_DISABLED: "1" } }, /\bReady in\b/);
try { await dev.ready; } catch (err) { await abort(err.message); }
const deadPort = await freePort();
const BASE = "http://localhost:3000";
const rules = [
  `MAP localhost:${deadPort} 127.0.0.1:${probePort}`,
  `MAP localhost:3000 127.0.0.1:${devPort}`, `MAP 127.0.0.1:3000 127.0.0.1:${devPort}`,
  `MAP localhost:4000 127.0.0.1:${apiPort}`, `MAP 127.0.0.1:4000 127.0.0.1:${apiPort}`,
  `MAP localhost:54322 127.0.0.1:${praxisPort}`, `MAP 127.0.0.1:54322 127.0.0.1:${praxisPort}`,
  `MAP localhost:1234 127.0.0.1:${lmsPort}`, `MAP 127.0.0.1:1234 127.0.0.1:${lmsPort}`,
].join(", ");
const chrome = start("chrome", CHROME, [`--host-resolver-rules=${rules}`, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${path.join(tmp, "chrome-profile")}`,
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
const responses = [];
const wsUrls = new Map();
let socketOpen = false;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails?.text);
  if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    responses.push({ url: r.url, status: r.status, ip: r.remoteIPAddress ?? null, port: r.remotePort ?? null });
    if (/:\/\/localhost:4000\/socket\.io\/\?.*\bsid=/.test(r.url) && r.status === 200) socketOpen = true;
  }
  if (m.method === "Network.webSocketCreated") wsUrls.set(m.params.requestId, m.params.url);
  if (m.method === "Network.webSocketHandshakeResponseReceived" && m.params.response.status === 101 && /\/socket\.io\//.test(wsUrls.get(m.params.requestId) || "")) socketOpen = true;
  for (const fn of [...listeners]) fn(m);
};
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const once = (method) => new Promise((resolve) => {
  const fn = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(fn), 1); resolve(m.params); } };
  listeners.push(fn);
});
/** Resolves true once `predicate` (a check-side function) holds after a CDP message; false at `limitMs` (a failure bound). */
const whenSeen = (predicate, limitMs = 60_000) => new Promise((resolve) => {
  if (predicate()) return resolve(true);
  const fn = () => { if (predicate()) { listeners.splice(listeners.indexOf(fn), 1); clearTimeout(limit); resolve(true); } };
  listeners.push(fn);
  const limit = setTimeout(() => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); resolve(predicate()); }, limitMs);
});
const evalJs = async (expression) => {
  const { result } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(`page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

/** Two animation frames: whatever the page committed before the call is on screen. */
const painted = () => evalJs("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
/** True as soon as `predicate` (a page expression) holds, watching the DOM; false if it has not held after `limitMs` (a failure bound). */
const until = (predicate, limitMs = 60_000) => evalJs(`new Promise((resolve) => {
  const holds = () => { try { return Boolean(${predicate}); } catch { return false; } };
  if (holds()) return resolve(true);
  const observer = new MutationObserver(() => { if (holds()) { observer.disconnect(); clearTimeout(limit); resolve(true); } });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const limit = setTimeout(() => { observer.disconnect(); resolve(holds()); }, ${limitMs});
})`);
async function navigate(url) {
  socketOpen = false;
  const loaded = once("Page.loadEventFired");
  const { result } = await send("Page.navigate", { url });
  if (result?.errorText) return result.errorText;
  await loaded;
  return null;
}
async function viewport(vp) {
  await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile });
}
/**
 * Screenshot of the box `boxExpression` returns, whole. The viewport is made as
 * tall as the page for the capture, so nothing has to scroll and the sticky
 * header and the fixed voice bar stay at the page edges.
 */
async function shot(vp, boxExpression, file, pad = 8) {
  const pageHeight = await evalJs("document.documentElement.scrollHeight");
  await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: Math.max(vp.height, pageHeight), deviceScaleFactor: vp.scale, mobile: vp.mobile });
  await evalJs("(scrollTo(0, 0), true)");
  await evalJs("document.fonts.ready.then(() => true)");
  await painted();
  const box = await evalJs(boxExpression);
  let saved = null;
  if (box) {
    const x = Math.max(0, box.x - pad);
    const clip = { x, y: Math.max(0, box.y - pad), width: Math.min(box.width + pad * 2, box.page - x), height: box.height + pad * 2, scale: 1 };
    const { result } = await send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    saved = path.relative(NEXUS, file);
    console.log(`CHECK_SHOT ${saved} (${Math.round(clip.width)}x${Math.round(clip.height)} CSS px at ${vp.scale}x)`);
  } else check(false, `screenshot target for ${path.basename(file)} exists`);
  await viewport(vp);
  await painted();
  return saved;
}
/**
 * Clicks the element `elementExpression` returns, after checking that its centre
 * is on screen with nothing lying over it. Hit test and click run in one page
 * task: panels above this one finish loading at their own pace and move it, so
 * a pointer event sent a moment after the hit test could land elsewhere.
 */
async function clickOn(elementExpression, what) {
  const point = await evalJs(`(() => {
    const el = ${elementExpression};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const hits = !!hit && (hit === el || el.contains(hit));
    if (hits) el.click();
    return { x, y, hits, hit: hit ? hit.tagName.toLowerCase() : null };
  })()`);
  return check(!!point && point.hits, `${what}: the control is on screen, nothing lies over it, and it takes the click`, point ? `hit ${point.hit} at ${Math.round(point.x)},${Math.round(point.y)}` : "not found");
}

/** Everything the assertions need from the local model panel, read in one pass. */
const READ_PANEL = `(() => {
  const root = document.querySelector('[data-local-model]');
  if (!root) return null;
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
  const size = (el) => { const r = el.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) }; };
  const active = root.querySelector('[data-local-model-active]');
  const waiting = root.querySelector('[data-local-model-waiting]');
  return {
    active: active ? { label: text(active.children[1]), model: text(active.children[2]), lines: [...active.children].slice(3).map(text) } : null,
    waiting: waiting ? { role: waiting.getAttribute('role'), heading: text(waiting.firstElementChild), text: text(waiting), work: [...waiting.querySelectorAll('li')].map(text) } : null,
    legend: text(root.querySelector('legend')),
    options: [...root.querySelectorAll('[data-local-model-option]')].map((label) => {
      const input = label.querySelector('input[type="radio"]');
      const body = label.querySelector(':scope > span');
      const head = body ? body.children[0] : null;
      return { key: label.dataset.localModelOption, name: text(head && head.children[0]), badges: head ? [...head.children].slice(1).map(text) : [], facts: text(body && body.children[1]),
        reason: text(label.querySelector('[id^="local-model-reason-"]')), checked: input.checked, disabled: input.disabled, describedBy: input.getAttribute('aria-describedby'), box: size(label) };
    }),
    buttons: [...root.querySelectorAll('button')].map((b) => ({ text: text(b), disabled: b.disabled, box: size(b) })),
    notices: [...root.querySelectorAll('p[role="status"], p[role="alert"]')].map(text),
    alerts: [...root.querySelectorAll('div[role="alert"]')].map(text),
    details: [...root.querySelectorAll('details')].map((d) => ({ summary: text(d.querySelector('summary')), open: d.open, rows: [...d.querySelectorAll('li')].map((li) => [...li.children].map(text)) })),
    box: size(root),
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;
const ALIAS_CARD = "document.querySelector('[data-local-model]')?.closest('.rounded-lg')";
// A role card in the left column of the section that holds the alias manager.
const roleCard = (alias) => `(() => {
  const section = (${ALIAS_CARD})?.closest('section');
  const tag = section && [...section.querySelectorAll('span.font-mono')].find((el) => el.textContent.trim() === '@${alias}' && !el.closest('[data-local-model]'));
  const card = tag && tag.closest('div.rounded');
  return card ? card.textContent.replace(/\\s+/g, ' ').trim() : null;
})()`;
// The Model Control section that holds the alias manager: its top to the bottom of the alias card (both columns on desktop).
const SECTION_BOX = `(() => { const card = ${ALIAS_CARD}; const section = card && card.closest('section'); if (!card || !section) return null;
  const s = section.getBoundingClientRect(); const c = card.getBoundingClientRect();
  return { x: s.left + scrollX, y: s.top + scrollY, width: s.width, height: c.bottom - s.top, page: document.documentElement.scrollWidth }; })()`;
// Where the section's three cells sit: the local-only box, the alias card's cell, the role manager's cell.
const LAYOUT = `(() => { const card = ${ALIAS_CARD}; const section = card && card.closest('section'); if (!section || section.children.length !== 3) return null;
  const [localOnly, aliasCell, roleCell] = [...section.children].map((el) => el.getBoundingClientRect());
  return { localOnlyHeight: Math.round(localOnly.height), aliasCardHeight: Math.round(aliasCell.height), rolesBelowLocalOnly: Math.round(roleCell.top - localOnly.bottom),
    aliasTopOffset: Math.round(aliasCell.top - localOnly.top), aliasBesideRoles: aliasCell.left >= roleCell.right }; })()`;
const CARD_BOX = `(() => { const card = ${ALIAS_CARD}; if (!card) return null; const c = card.getBoundingClientRect();
  return { x: c.left + scrollX, y: c.top + scrollY, width: c.width, height: c.height, page: document.documentElement.scrollWidth }; })()`;
const button = (label) => `[...document.querySelectorAll('[data-local-model] button')].find((b) => b.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)})`;
const summary = (prefix) => `[...document.querySelectorAll('[data-local-model] summary')].find((s) => s.textContent.trim().startsWith(${JSON.stringify(prefix)}))`;
const option = (key) => `document.querySelector('[data-local-model-option=${JSON.stringify(key)}]')`;
const listed = (count) => `document.querySelectorAll('[data-local-model-option]').length === ${count}`;
const activeIs = (label) => `(document.querySelector('[data-local-model-active]')?.children[1]?.textContent.trim() === ${JSON.stringify(label)})`;
const current = async () => (await (await fetch(`${API}/api/model-control/local-model/current`)).json());
const lmsOnlyListed = () => lmStudio.requests.every((r) => r.method === "GET" && r.path === "/api/v1/models");
const TIME = "[A-Z][a-z]{2} \\d{1,2}, \\d{1,2}:\\d{2}\\s?[AP]M";
const report = { at: new Date().toISOString(), base: BASE, ports: { dev: devPort, api: apiPort, praxisStandIn: praxisPort, fakeLmStudio: lmsPort, probe: probePort }, steps: {} };

// ── 0. The host-resolver rules hold before anything loads from localhost:3000 ──
await viewport(DESKTOP);
const probeError = await navigate(`http://localhost:${deadPort}/`);
const probeText = probeError ? `navigation failed: ${probeError}` : await evalJs("document.body ? document.body.innerText.trim() : ''");
if (probeText !== probeNonce) await abort(`Chrome did not apply its host-resolver rules to localhost (read ${JSON.stringify(String(probeText).slice(0, 80))}); stopping before anything loads from localhost:3000.`);
check(true, "Chrome's host-resolver rules hold for localhost: a port nothing listens on reached the probe server");

// ── 1. Desktop: the model in effect and LM Studio's list ──
await navigate(`${BASE}/model-control`);
// The first load includes next dev's first compile of the page; the limit is a failure bound only.
const firstReady = await until(`${listed(4)} && ${activeIs(GEMMA_QAT_ROW)}`, 180_000);
const identity = await evalJs("fetch('/api/model-control/local-model', { cache: 'no-store' }).then((r) => r.json()).then((b) => ({ listing: b.listing, active: b.active && b.active.model }))");
if (identity?.listing?.url !== `${LMS_URL}/api/v1/models`) await abort(`the page is not on the isolated stack (listing ${JSON.stringify(identity?.listing)}); nothing was clicked.`);
check(firstReady, "desktop: the panel lists LM Studio's chat models with the model in effect", `listing ${identity.listing.url}`);
await until(`/Gemma 4 31B QAT/.test(${roleCard("local_default")} || '')`);
const memoryGb = Math.round(os.totalmem() / 2 ** 30);
const EXPECTED_FACTS = {
  [INKLING.key]: "18.1 GB · context 131,072 (saved) · tested handling",
  [QWEN.key]: "16.1 GB · no saved context · conservative defaults",
  [GEMMA_QAT.key]: "18.9 GB · context 131,072 (saved) · tested handling",
  [GEMMA.key]: "19.9 GB · context 131,072 (saved) · tested handling",
};
const QWEN_REASON = `Cannot be chosen. No saved load context in LM Studio, so the context it would load with is not set. Its maximum is 262,144 tokens, which can need more memory than this machine's ${memoryGb} GB. Save a context length for it in LM Studio's load settings to make it selectable.`;
await clickOn(summary("Not offered"), "desktop: the Not offered list");
await until(`${summary("Not offered")}?.parentElement.open === true`);
let panel = await evalJs(READ_PANEL);
report.steps.desktopStart = { panel, localDefaultRole: await evalJs(roleCard("local_default")) };
check(panel.active?.label === GEMMA_QAT_ROW && panel.active?.model === GEMMA_QAT.key, "desktop: Gemma 4 31B QAT is in effect", JSON.stringify(panel.active));
check(/Gemma 4 31B QAT/.test(report.steps.desktopStart.localDefaultRole || ""), "desktop: the @local_default role card resolves to Gemma 4 31B QAT", report.steps.desktopStart.localDefaultRole);
check(panel.legend === "Downloaded chat models in LM Studio (4)" && panel.options.map((o) => o.key).join(",") === [INKLING, QWEN, GEMMA_QAT, GEMMA].map((m) => m.key).join(","), "desktop: the four chat models are offered, in LM Studio's order", panel.legend);
for (const o of panel.options) check(o.facts === EXPECTED_FACTS[o.key], `desktop: ${o.name} shows name, size on disk, saved context and handling`, o.facts);
const qwen = panel.options.find((o) => o.key === QWEN.key);
check(qwen?.disabled && qwen.reason === QWEN_REASON && !!qwen.describedBy, "desktop: Qwen3.8 27B (no saved context) cannot be selected and the panel says what is missing", qwen?.reason);
check(!panel.options.some((o) => o.key === NOMIC.key) && panel.details.some((d) => d.summary === "Not offered (1)" && d.open && JSON.stringify(d.rows) === JSON.stringify([["Nomic Embed Text v1.5", "Embedding model: it makes embeddings, not chat replies."]])),
  "desktop: the embedding model is not offered; it is listed under Not offered with the reason", JSON.stringify(panel.details));
check(panel.options.find((o) => o.key === GEMMA_QAT.key)?.badges.includes("in effect") && panel.buttons.some((b) => b.text === "Gemma 4 31B QAT is in effect" && b.disabled), "desktop: the model in effect is marked and its button says so");
check(panel.pageOverflowX <= 0, "desktop: the page does not scroll sideways", `overflow ${panel.pageOverflowX}px`);
const layout = await evalJs(LAYOUT);
report.steps.desktopStart.layout = layout;
// 32 px: the section's gap-4 plus the role manager's mt-4 (dashboard/src/app/model-control/page.tsx).
check(!!layout && layout.rolesBelowLocalOnly <= 32 && Math.abs(layout.aliasTopOffset) <= 1 && layout.aliasBesideRoles,
  "desktop: the role manager sits right under the local-only box and the tall alias card beside both", JSON.stringify(layout));
report.steps.desktopStart.shot = await shot(DESKTOP, SECTION_BOX, path.join(PACKAGE_DIR, "desktop-model-in-effect-and-list.png"));

// No saved context: a click on the row picks nothing, and Nexus refuses it.
await clickOn(option(QWEN.key), "desktop: the Qwen3.8 27B row");
await painted();
panel = await evalJs(READ_PANEL);
check(!panel.options.find((o) => o.key === QWEN.key)?.checked && panel.buttons.some((b) => b.text === "Gemma 4 31B QAT is in effect"), "desktop: clicking Qwen3.8 27B picks nothing");
const refusals = await evalJs(`Promise.all([${JSON.stringify(QWEN.key)}, ${JSON.stringify(NOMIC.key)}].map((model) => fetch('/api/model-control/local-model', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, surface: 'api' }) }).then(async (r) => ({ model, status: r.status, body: await r.json() }))))`);
report.steps.refusals = refusals;
check(refusals[0].status === 422 && refusals[0].body.error === "no_saved_context", "API: choosing Qwen3.8 27B is refused (422 no_saved_context) and says what is missing", refusals[0].body.message);
check(refusals[1].status === 422 && refusals[1].body.error === "not_a_chat_model", "API: choosing the embedding model is refused (422 not_a_chat_model)", refusals[1].body.message);
check((await current()).active === GEMMA_QAT.key && !(await current()).waiting, "API: the refusals changed nothing");

// ── 2. Phone width ──
await viewport(PHONE);
await navigate(`${BASE}/model-control`);
check(await until(`${listed(4)} && ${activeIs(GEMMA_QAT_ROW)}`), "phone: the panel lists the four chat models with the model in effect");
await clickOn(summary("Not offered"), "phone: the Not offered list");
await until(`${summary("Not offered")}?.parentElement.open === true`);
panel = await evalJs(READ_PANEL);
report.steps.phone = { panel };
check(panel.pageOverflowX <= 0, "phone: the page does not scroll sideways", `overflow ${panel.pageOverflowX}px at ${PHONE.width}px`);
const clipped = panel.options.filter((o) => o.box.left < 0 || o.box.right > PHONE.width);
check(clipped.length === 0, "phone: every option row fits the screen width", `rows ${panel.options.map((o) => `${o.box.width}x${o.box.height}`).join(", ")}`);
for (const o of panel.options) check(o.facts === EXPECTED_FACTS[o.key], `phone: ${o.name} shows the same facts`, o.facts);
note(`phone: tap heights: option rows ${panel.options.map((o) => o.box.height).join("/")} px, buttons ${panel.buttons.map((b) => `${b.text.slice(0, 24)} ${b.box.height}px`).join(", ")}`);
report.steps.phone.shot = await shot(PHONE, CARD_BOX, path.join(PACKAGE_DIR, "phone-model-in-effect-and-list.png"));

// ── 3. Desktop: a different model chosen while a local job runs ──
startLocalJob();
await viewport(DESKTOP);
await navigate(`${BASE}/model-control`);
check(await until(`${listed(4)} && ${activeIs(GEMMA_QAT_ROW)}`), "desktop (job running): the panel is back with Gemma 4 31B QAT in effect");
const socketReady = await whenSeen(() => socketOpen);
check(socketReady, "desktop: the page's Socket.IO connection to the throwaway API is open");
await clickOn(option(INKLING.key), "desktop: the Inkling 2 Mini row");
check(await until(`${button("Use Inkling 2 Mini")} && !${button("Use Inkling 2 Mini")}.disabled`), "desktop: picking Inkling 2 Mini offers 'Use Inkling 2 Mini'");
const lmsBeforeChoice = lmStudio.requests.length;
await clickOn(button("Use Inkling 2 Mini"), "desktop: Use Inkling 2 Mini");
check(await until(`/Switch to Inkling 2 Mini \\(local\\) is waiting/.test(document.querySelector('[data-local-model-waiting]')?.textContent || '') && /Nightly transcript summaries \\(Praxis local job, since /.test(document.querySelector('[data-local-model-waiting]')?.textContent || '')`),
  "desktop: the panel shows the switch waiting for the running local job");
await clickOn(summary("Switch history"), "desktop: the switch history");
await until(`${summary("Switch history")}?.parentElement.open === true`);
panel = await evalJs(READ_PANEL);
const nexusWaiting = await current();
report.steps.waiting = { panel, nexus: nexusWaiting, praxis: snapshot(), lmStudioRequestsDuringChoice: lmStudio.requests.slice(lmsBeforeChoice) };
check(panel.active?.label === GEMMA_QAT_ROW, "desktop: Gemma 4 31B QAT stays in effect while the job runs", JSON.stringify(panel.active));
check(panel.waiting?.role === "status" && new RegExp(`^Nightly transcript summaries \\(Praxis local job, since ${TIME}\\)$`).test(panel.waiting.work[0] || "") && panel.waiting.work.length === 1, "desktop: the waiting box names the job it waits for", panel.waiting?.work.join(" | "));
check(panel.options.find((o) => o.key === INKLING.key)?.badges.includes("waiting") && panel.options.find((o) => o.key === GEMMA_QAT.key)?.badges.includes("in effect"), "desktop: Inkling 2 Mini is marked waiting, Gemma 4 31B QAT in effect");
check(panel.notices.includes("Chose Inkling 2 Mini. Nothing was loaded; the switch waits until no local work runs, then the next local call uses it."), "desktop: the panel says nothing was loaded", panel.notices.join(" | "));
const historyWaiting = panel.details.find((d) => d.summary === "Switch history (1)");
check(!!historyWaiting && historyWaiting.rows[0][0] === "Gemma 4 31B QAT (local) → Inkling 2 Mini (local)" && new RegExp(`^Chosen under Model Control · ${TIME} · waiting for local work$`).test(historyWaiting.rows[0][1]),
  "desktop: the switch is recorded with what, when and from which surface", JSON.stringify(historyWaiting?.rows));
check(nexusWaiting.active === GEMMA_QAT.key && nexusWaiting.selected === INKLING.key && nexusWaiting.waiting === true, "API: Nexus holds Inkling 2 Mini as the waiting choice, Gemma 4 31B QAT in effect", JSON.stringify(nexusWaiting));
check(praxisState.active === GEMMA_QAT.key && snapshot().pending?.model === INKLING.key && !praxisLog.some((l) => l.includes("/apply")), "Praxis stand-in: no apply was asked while its job runs");
check(lmsOnlyListed(), "LM Studio: choosing made no request but listing reads (no load)", lmStudio.requests.slice(lmsBeforeChoice).map((r) => `${r.method} ${r.path}`).join(", "));
report.steps.waiting.shot = await shot(DESKTOP, SECTION_BOX, path.join(PACKAGE_DIR, "desktop-switch-waiting-behind-local-job.png"));
await viewport(PHONE);
await painted();
report.steps.waiting.phoneShot = await shot(PHONE, CARD_BOX, path.join(OUT, "phone-switch-waiting.png"));
await viewport(DESKTOP);
await painted();

// ── 4. Evidence: the job ends, Praxis applies, the panel follows by itself ──
await endLocalJob();
check(await until(`${activeIs(INKLING_ROW)} && !document.querySelector('[data-local-model-waiting]')`), "desktop: after the job ends the panel shows Inkling 2 Mini in effect, without a reload");
panel = await evalJs(READ_PANEL);
const nexusApplied = await current();
report.steps.applied = { panel, nexus: nexusApplied, praxis: snapshot() };
check(new RegExp(`^Chosen under Model Control, in effect from ${TIME}$`).test(panel.active?.lines[0] || ""), "desktop: the panel says when and where it was chosen", panel.active?.lines.join(" | "));
check(new RegExp(` · in effect from ${TIME}$`).test(panel.details.find((d) => d.summary === "Switch history (1)")?.rows[0][1] || ""), "desktop: the history row turns to in effect", JSON.stringify(panel.details.find((d) => d.summary === "Switch history (1)")?.rows));
check(nexusApplied.active === INKLING.key && nexusApplied.waiting === false && praxisState.active === INKLING.key, "API and Praxis stand-in: Inkling 2 Mini is in effect", JSON.stringify(nexusApplied));
check(panel.buttons.some((b) => b.text === "Restore Gemma 4 31B QAT" && !b.disabled), "desktop: the previous choice is one button away");
report.steps.applied.shot = await shot(DESKTOP, SECTION_BOX, path.join(OUT, "desktop-switch-applied-after-job.png"));
await navigate(`${BASE}/model-control`);
const roleFollows = await until(`/Inkling 2 Mini/.test(${roleCard("local_default")} || '')`);
report.steps.applied.localDefaultRole = await evalJs(roleCard("local_default"));
check(roleFollows, "desktop: the @local_default role card now resolves to Inkling 2 Mini", report.steps.applied.localDefaultRole);

// ── 5. Evidence: restore in one action ──
check(await until(`${listed(4)} && ${activeIs(INKLING_ROW)}`), "desktop: the panel is back with Inkling 2 Mini in effect");
await clickOn(button("Restore Gemma 4 31B QAT"), "desktop: Restore Gemma 4 31B QAT");
check(await until(`${activeIs(GEMMA_QAT_ROW)} && /Gemma 4 31B QAT is now the local model/.test(document.querySelector('[data-local-model]').textContent)`), "desktop: one click restores Gemma 4 31B QAT");
await clickOn(summary("Switch history"), "desktop: the switch history");
await until(`${summary("Switch history")}?.parentElement.open === true`);
panel = await evalJs(READ_PANEL);
const nexusRestored = await current();
report.steps.restored = { panel, nexus: nexusRestored, praxis: snapshot() };
const historyRestored = panel.details.find((d) => d.summary === "Switch history (2)");
check(!!historyRestored && historyRestored.rows[0][0] === "Inkling 2 Mini (local) → Gemma 4 31B QAT (local)" && new RegExp(`^Restored under Model Control · ${TIME} · in effect from ${TIME}$`).test(historyRestored.rows[0][1])
  && historyRestored.rows[1][0] === "Gemma 4 31B QAT (local) → Inkling 2 Mini (local)", "desktop: the restore is recorded as its own switch", JSON.stringify(historyRestored?.rows));
check(panel.notices.includes("Gemma 4 31B QAT is now the local model. Nothing was loaded; it loads when a local call next needs it.") && new RegExp(`^Restored under Model Control, in effect from ${TIME}$`).test(panel.active?.lines[0] || ""), "desktop: the panel says the restore loaded nothing", panel.notices.join(" | "));
check(nexusRestored.active === GEMMA_QAT.key && nexusRestored.waiting === false && praxisState.active === GEMMA_QAT.key, "API and Praxis stand-in: Gemma 4 31B QAT is in effect again", JSON.stringify(nexusRestored));
report.steps.restored.shot = await shot(DESKTOP, SECTION_BOX, path.join(OUT, "desktop-restored-in-one-action.png"));

// ── 6. Evidence: a model downloaded in LM Studio appears the next time the page reads the list ──
lmStudio.listing.push(MINISTRAL);
saveProfile(MINISTRAL.key, 32768);
await navigate(`${BASE}/model-control`);
check(await until(`${listed(5)} && !!${option(MINISTRAL.key)}`), "desktop: the newly downloaded Ministral 4 14B is offered");
panel = await evalJs(READ_PANEL);
report.steps.newDownload = { panel };
const ministral = panel.options.find((o) => o.key === MINISTRAL.key);
check(ministral?.facts === "8.8 GB · context 32,768 (saved) · conservative defaults" && !ministral.disabled, "desktop: Ministral 4 14B shows its size, saved context and conservative defaults, and can be chosen", ministral?.facts);
report.steps.newDownload.shot = await shot(DESKTOP, CARD_BOX, path.join(OUT, "desktop-new-download-listed.png"));

// ── 7. Nothing left the stack ──
check(exceptions.length === 0, "no uncaught page exception during the run", exceptions.slice(0, 3).join(" | "));
check(lmsOnlyListed(), "LM Studio: every request in the whole run was a listing read (nothing loaded, unloaded or called)", `${lmStudio.requests.length} GET /api/v1/models`);
const ownPorts = new Set([devPort, apiPort, probePort]);
const remote = responses.filter((r) => /^https?:/.test(r.url) && r.port);
const isLoopback = (ip) => ["127.0.0.1", "::1", "[::1]"].includes(ip);
const strays = remote.filter((r) => isLoopback(r.ip) && !ownPorts.has(r.port));
check(strays.length === 0 && remote.some((r) => r.port === apiPort) && remote.some((r) => r.port === devPort), "browser: every local response came from the stack's own ports, none from the live :3000 or :4000",
  strays.slice(0, 3).map((r) => `${r.url} from ${r.ip}:${r.port}`).join(", ") || `${remote.length} responses from ports ${[...new Set(remote.map((r) => r.port))].join(", ")}`);
for (const r of remote.filter((x) => !isLoopback(x.ip))) note(`browser: external response ${r.url} from ${r.ip}:${r.port}`);
const guard = readGuard();
const refusedByTarget = new Map();
for (const g of guard) { const k = `${g.kind} ${g.target} (${g.why}; from ${g.stack.split(" | ")[0].replace(/^at /, "").replace(NEXUS + path.sep, "")})`; refusedByTarget.set(k, (refusedByTarget.get(k) || 0) + 1); }
for (const [what, count] of refusedByTarget) note(`api-network-guard refused ${count}x ${what}; nothing reached it`);
report.lmStudioRequests = lmStudio.requests;
report.praxisStandInLog = praxisLog;
report.apiNetworkGuardRefusals = guard;
report.browserResponsePorts = Object.fromEntries([...new Set(remote.map((r) => r.port))].map((port) => [port, remote.filter((r) => r.port === port).length]));
report.exceptions = exceptions;

ws.close();
await teardown();
report.apiLocalModelLog = apiLocalModelLines;
report.failures = failures;
fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures.length ? `CHECK_RESULT fail (${failures.length}): ${failures.join("; ")}` : `CHECK_RESULT pass; screenshots in ${path.relative(NEXUS, PACKAGE_DIR)} and ${path.relative(NEXUS, OUT)}, report.json beside this script`);
process.exit(failures.length ? 1 : 0);
