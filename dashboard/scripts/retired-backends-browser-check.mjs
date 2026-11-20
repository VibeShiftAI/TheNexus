#!/usr/bin/env node
/**
 * Real-browser check for task 62b7c967 (2026-11-19): the dashboard no longer
 * calls the retired LangGraph terminal or artifact-comment backends, and the
 * comment surfaces still in use behave as before.
 *
 * One foreground process owns the stack and tears it down by process group:
 *   - scripts/retired-backends-check-api.cjs: the real documents and tasks
 *     routers on a temporary SQLite database for the comment fixtures; every
 *     other /api path is passed through to CHECK_UPSTREAM_API, an isolated
 *     local Nexus instance supplied for the check;
 *   - `next dev --webpack` from CHECK_DASHBOARD (default: this checkout) on an
 *     OS-assigned port, NEXT_PUBLIC_API_URL pointing at that API, dist dir
 *     .next-verify-retired. Webpack, not Turbopack: a Praxis worktree links
 *     dashboard/node_modules from the shared checkout and Turbopack refuses a
 *     symlink that leaves the repo root;
 *   - headless Chrome over CDP.
 *
 * Historical clients hardcode the shared localhost port for chat and sockets.
 * Chrome maps those connections to the same isolated upstream as the proxy.
 *
 * No step waits a fixed time. Readiness comes from the children themselves
 * (the API's CHECK_READY line, next dev's "Ready in" line, Chrome's "DevTools
 * listening on" line; any of them exiting first fails the run), a page is
 * "settled" when its load event has fired and every request the current
 * document has in flight after a painted frame has finished (a poller's repeat
 * of a path already waited on is not waited on again, so polling cannot hold a
 * step open), and teardown waits for each process group to close its output.
 * Where the page's own handling of a response is what matters (B's
 * stored-transcript fallback), the step waits for the provider's console
 * warning that announces it, then for a painted frame.
 *
 * Per viewport (desktop and phone):
 *   A. stale thread id: browser storage holds cortex_thread_id before the
 *      page loads. Records every request: none may go to /api/terminal,
 *      /api/artifacts or /api/comments, and none may fail. The key must be
 *      gone afterwards. Screenshot of the chat surface.
 *   B. old plan card: browser storage holds an old transcript
 *      (cortex_chat_history) with a final PLAN_DRAFT card, and /api/chat/active
 *      is answered 503 by CDP so the provider takes its stored-history
 *      fallback (the one path that still carries plan cards; the server
 *      transcript never stored artifacts). The card must show with no
 *      Approve / Critique control; "Open Full View" must open the plan with
 *      only a close control. Screenshots of the card and the full view.
 * Once, at desktop width:
 *   C. document-review comments, through the review UI on the fixture
 *      document: leave a passage comment, see it listed and stored on the
 *      review, reload and see it again, resolve it. Screenshots.
 *   D. task-feature comments: the dashboard mounts no page for them
 *      (AnnotatedMarkdown is only used by DetailDrawer, which nothing
 *      imports), so the page calls the feature-comment routes of
 *      server/routes/tasks.js through the dashboard's own /api proxy (GET,
 *      POST, PATCH on the seeded comment) plus the path the dashboard client
 *      requests (dashboard/src/lib/nexus/timeline.ts getInlineComments), and
 *      records every answer.
 *   With CHECK_COMPARE=<report.json of another run>, the C and D outcomes must
 *   equal that run's: run once on a baseline tree, once on this one. C's
 *   retired-route list is not part of that comparison (it is checked on its
 *   own; on the baseline tree it lists /api/terminal/state, because that tree
 *   keeps the stale thread id A leaves in storage).
 *
 *   export CHECK_UPSTREAM_API=http://127.0.0.1:<isolated-api-port>
 *   node scripts/retired-backends-browser-check.mjs
 *   CHECK_LABEL=before CHECK_DASHBOARD=<baseline>/dashboard CHECK_SERVER_ROOT=<baseline> node scripts/retired-backends-browser-check.mjs
 *   CHECK_COMPARE=<out>/before/report.json node scripts/retired-backends-browser-check.mjs
 *
 * Env: CHECK_LABEL (after), CHECK_OUT (docs/reviews/2026-11-19-retired-backend-calls),
 * CHECK_DASHBOARD, CHECK_SERVER_ROOT (repo whose db/ and server/ the API loads),
 * CHECK_COMPARE, CHECK_WEB_SECURITY=1 (keep CORS on), CHECK_CHROME, CHECK_TRACE=1
 * (print in-flight requests while settling). Writes <out>/<label>/*.png and
 * report.json; exits 1 on any failed assertion.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const NEXUS = path.resolve(here, "..", "..");
const DASHBOARD = path.resolve(process.env.CHECK_DASHBOARD || path.join(NEXUS, "dashboard"));
const LABEL = process.env.CHECK_LABEL || "after";
const OUT = path.join(path.resolve(process.env.CHECK_OUT || path.join(NEXUS, "docs/reviews/2026-11-19-retired-backend-calls")), LABEL);
const COMPARE = process.env.CHECK_COMPARE ? JSON.parse(fs.readFileSync(path.resolve(process.env.CHECK_COMPARE), "utf8")) : null;
const TRACE = process.env.CHECK_TRACE === "1";
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const RETIRED = /\/api\/(terminal\b|artifacts\/|comments\/)/;
const THREAD_KEY = "cortex_thread_id";
const STALE_THREAD = "legacy-langgraph-thread-0001";
const PLAN_TITLE = "Synthetic legacy plan (verification fixture)";
const OLD_HISTORY = [
  { role: "user", content: "Plan the fixture work", timestamp: "2026-06-30T14:00:00.000Z" },
  {
    role: "assistant", content: "✅ Final Plan for Review", timestamp: "2026-06-30T14:01:00.000Z",
    artifact: {
      type: "PLAN_DRAFT",
      data: {
        title: PLAN_TITLE, version: 2, is_final: true, thread_id: STALE_THREAD,
        markdown: "# Fixture plan\n\n1. Read the brief\n2. Make the change\n3. Verify it",
        rationale: "Old LangGraph plan kept in browser history; shown read-only.",
      },
    },
  },
];
const REVIEW_COMMENT = "Synthetic review comment (retired-backends check): this paragraph reads fine.";
const FEATURE_COMMENT = "Synthetic feature comment (retired-backends check)";
// Widths are the two the repo's layout audit covers (scripts/responsive-audit.mjs:43,
// "390,1440"). Phone height and scale match the other phone checks
// (scripts/intake-backlog-panel-browser-check.mjs:56, 390x844 at 2x, the iPhone
// 12-15 CSS viewport); 1440x900 is the 16:10 desktop of that width.
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

// ── children: started detached (own process group), ready on a printed line ──
const children = [];
function start(name, cmd, args, opts, readyLine) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const logPath = path.join(os.tmpdir(), `nexus-retired-${name}.log`);
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
    child.on("exit", (code, signal) => reject(new Error(`${name} exited (${signal || code}) before it was ready; log: ${logPath}`)));
  });
  ready.catch(() => {});
  const entry = { name, child, closed, ready, logPath };
  children.push(entry);
  return entry;
}

let tsconfigSnapshot = null;
let profile = null;
let fixture = null;
const distDir = ".next-verify-retired";
async function teardown() {
  for (const { child, closed } of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    }
    // "close" fires once every process holding the child's stdout/stderr has
    // exited, i.e. the whole group is gone and nothing still writes the
    // dist dir or the profile.
    await closed;
  }
  if (tsconfigSnapshot) {
    fs.writeFileSync(path.join(DASHBOARD, "tsconfig.json"), tsconfigSnapshot);
    fs.rmSync(path.join(DASHBOARD, distDir), { recursive: true, force: true });
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  if (fixture?.dir) fs.rmSync(fixture.dir, { recursive: true, force: true });
}
const abort = async (message) => { console.error(message); await teardown(); process.exit(2); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort(`stopped by ${signal}`));

// ── stack ──
const api = start("api", process.execPath, [path.join(here, "retired-backends-check-api.cjs")],
  { env: { ...process.env, ...(process.env.CHECK_SERVER_ROOT ? { CHECK_SERVER_ROOT: path.resolve(process.env.CHECK_SERVER_ROOT) } : {}) } }, /CHECK_READY (\{.*\})\n/);
try { fixture = JSON.parse((await api.ready)[1]); } catch (err) { await abort(err.message); }
console.log(`CHECK_API ${fixture.api} (db/server from ${fixture.serverRoot}; other paths -> ${fixture.upstream})`);

const devPort = await freePort();
tsconfigSnapshot = fs.readFileSync(path.join(DASHBOARD, "tsconfig.json"));
const dev = start("next-dev", "npx", ["next", "dev", "--webpack", "-p", String(devPort)],
  { cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: distDir, NEXUS_API_URL: fixture.api, NEXT_PUBLIC_API_URL: fixture.api } }, /\bReady in\b/);
try { await dev.ready; } catch (err) { await abort(err.message); }
const BASE = `http://localhost:${devPort}`;
console.log(`CHECK_BASE ${BASE} (${LABEL}; dashboard ${DASHBOARD})`);

profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retired-chrome-"));
const isolatedPeer = new URL(fixture.upstream).host;
const chrome = start("chrome", CHROME, [
  `--host-resolver-rules=MAP localhost:4000 ${isolatedPeer}, MAP 127.0.0.1:4000 ${isolatedPeer}`,"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", ...(process.env.CHECK_WEB_SECURITY === "1" ? [] : ["--disable-web-security"]),
  "--autoplay-policy=user-gesture-required", "about:blank"], {}, /DevTools listening on (ws:\/\/\S+)/);
let browserWs;
try { browserWs = new URL((await chrome.ready)[1]); } catch (err) { await abort(err.message); }
const target = await (await fetch(`http://${browserWs.host}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  for (const fn of [...listeners]) fn(m);
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const once = (method) => new Promise((resolve) => {
  const fn = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(fn), 1); resolve(m.params); } };
  listeners.push(fn);
});
/** Resolves on the first console call whose text matches `pattern` (Runtime.consoleAPICalled). */
const consoleSignal = (pattern) => new Promise((resolve) => {
  const fn = (m) => {
    if (m.method !== "Runtime.consoleAPICalled") return;
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (pattern.test(text)) { listeners.splice(listeners.indexOf(fn), 1); resolve(text); }
  };
  listeners.push(fn);
});
const evalJs = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const { result } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data, "base64"));
  return name;
};

// ── network log and in-flight tracking ──
let requests = new Map();
/** requestId -> { key: "METHOD path", loaderId, finished: Promise, resolve } for tracked requests not yet finished. */
const inflight = new Map();
/**
 * The main frame's current document. Chrome does not always report a request
 * of a torn-down document as finished or failed, so only requests of the
 * current document are waited on.
 */
let currentLoader = null;
// Long-lived by design, never "finished": the socket.io long-poll, EventSource
// and WebSocket streams, and any response served as text/event-stream.
const tracked = (p) => /^https?:/.test(p.request.url) && !["EventSource", "WebSocket"].includes(p.type) && !/\/socket\.io\//.test(p.request.url);
const done = (id) => {
  const entry = inflight.get(id);
  if (!entry) return;
  inflight.delete(id);
  entry.resolve();
  if (TRACE) console.log(`  - ${entry.key} (${inflight.size} in flight)`);
};
listeners.push((m) => {
  const p = m.params;
  if (m.method === "Network.requestWillBeSent") {
    requests.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, status: null, failed: null, canceled: false });
    if (tracked(p) && !inflight.has(p.requestId)) {
      // Keyed without the query: the pollers add a cache-buster (_cb=<time>) to every repeat.
      const entry = { key: `${p.request.method} ${p.request.url.split("?")[0]}`, loaderId: p.loaderId };
      entry.finished = new Promise((r) => (entry.resolve = r));
      inflight.set(p.requestId, entry);
      if (TRACE) console.log(`  + ${entry.key}`);
    }
  } else if (m.method === "Page.frameNavigated" && !p.frame.parentId) {
    currentLoader = p.frame.loaderId;
  } else if (m.method === "Network.responseReceived") {
    if (requests.has(p.requestId)) requests.get(p.requestId).status = p.response.status;
    if (p.response.mimeType === "text/event-stream") done(p.requestId);
  } else if (m.method === "Network.loadingFinished") {
    done(p.requestId);
  } else if (m.method === "Network.loadingFailed") {
    if (requests.has(p.requestId)) { const r = requests.get(p.requestId); r.failed = p.errorText; r.canceled = !!p.canceled; }
    done(p.requestId);
  } else if (m.method === "Fetch.requestPaused") {
    // Scenario B: answer the server transcript with 503 so the provider
    // falls back to the transcript kept in browser storage.
    send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 503, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from('{"error":"simulated: server transcript unavailable"}').toString("base64") });
  }
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

/**
 * Two animation frames: the first callback runs before the next paint, the
 * second after it, so whatever the page committed before the call is on screen.
 */
const painted = () => evalJs("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
/**
 * Wait for every request the page has in flight after a painted frame, then
 * look again (a response may start the next request). Each "METHOD path" is
 * waited on once per call: the dashboard's pollers repeat the same requests
 * forever, and their first answer is what the step needs.
 */
async function settle() {
  const waited = new Set();
  for (;;) {
    await painted();
    const wave = [...inflight.values()].filter((e) => e.loaderId === currentLoader && !waited.has(e.key));
    if (!wave.length) return;
    for (const e of wave) waited.add(e.key);
    if (TRACE) console.log(`  waiting on ${wave.map((e) => e.key).join(" | ")}`);
    await Promise.all(wave.map((e) => e.finished));
  }
}
async function navigate(url) {
  inflight.clear();
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await settle();
}
async function reload() {
  inflight.clear();
  const loaded = once("Page.loadEventFired");
  await send("Page.reload", { ignoreCache: false });
  await loaded;
  await settle();
}

const summarize = () => {
  const list = [...requests.values()].filter((r) => /^https?:/.test(r.url));
  const bad = list.filter((r) => (r.status !== null && r.status >= 400) || (r.failed && !r.canceled));
  const canceled = list.filter((r) => r.canceled);
  const retired = list.filter((r) => RETIRED.test(r.url));
  const writes = list.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method));
  return { total: list.length, bad, canceled, retired, writes, list };
};
const fmt = (r) => `${r.method} ${r.url} -> ${r.status ?? r.failed}`;

// Warm-up: compile both routes once so first-compile reloads do not land in a scenario.
await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height, deviceScaleFactor: VIEWPORTS[0].scale, mobile: false });
await navigate(`${BASE}/`);
await navigate(`${BASE}/documents/${encodeURIComponent(fixture.documentId)}`);

const report = {
  base: BASE, label: LABEL, at: new Date().toISOString(), dashboard: DASHBOARD, api: { serverRoot: fixture.serverRoot, upstream: fixture.upstream },
  webSecurityDisabled: process.env.CHECK_WEB_SECURITY !== "1", viewports: {},
};

for (const vp of VIEWPORTS) {
  await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile });
  const out = (report.viewports[vp.name] = {});

  // ── A: stale thread id ──
  const { identifier: seedA } = (await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem(${JSON.stringify(THREAD_KEY)}, ${JSON.stringify(STALE_THREAD)}); localStorage.removeItem('cortex_chat_history'); } catch {}`,
  })).result;
  requests = new Map();
  await navigate(`${BASE}/`);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedA });
  const keyAfter = await evalJs(`localStorage.getItem(${JSON.stringify(THREAD_KEY)})`);
  const chatShown = await evalJs(`!!document.querySelector('[data-message-row]') || /Praxis/.test(document.body.innerText)`);
  const a = summarize();
  out.staleThread = {
    requests: a.total, retiredRequests: a.retired.map(fmt), failedRequests: a.bad.map(fmt),
    canceledRequests: a.canceled.map((r) => `${r.method} ${r.url} (${r.failed})`), nonGetRequests: a.writes.map(fmt),
    threadKeyAfterLoad: keyAfter, chatShown,
    screenshot: await shot(`A-${vp.name}-chat-with-stale-thread-id.png`),
  };
  check(a.retired.length === 0, `${vp.name} A: no request to a retired route`, out.staleThread.retiredRequests.join(" | ") || `${a.total} requests`);
  check(a.bad.length === 0, `${vp.name} A: no failed request`, out.staleThread.failedRequests.join(" | ") || "0 failed");
  check(keyAfter === null, `${vp.name} A: stale ${THREAD_KEY} removed`, `after load: ${JSON.stringify(keyAfter)}`);

  // ── B: old plan card ──
  const { identifier: seedB } = (await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem('cortex_chat_history', ${JSON.stringify(JSON.stringify(OLD_HISTORY))}); } catch {}`,
  })).result;
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/chat/active*", requestStage: "Request" }] });
  requests = new Map();
  // The network log reports the 503 before the page's own code has handled
  // it, so wait for the provider's fallback itself: cortex-provider.tsx warns
  // "Failed to load chat history from server" right before it loads the
  // stored transcript (same line in the baseline tree), then for a painted frame.
  const fallbackRan = consoleSignal(/Failed to load chat history from server/);
  await navigate(`${BASE}/`);
  out.transcriptFallback = await fallbackRan;
  await painted();
  const card = await evalJs(`(() => {
    const h = [...document.querySelectorAll('h3')].find((el) => el.textContent.includes(${JSON.stringify(PLAN_TITLE)}));
    if (!h) return null;
    const box = h.closest('div.rounded-lg');
    box.scrollIntoView({ block: 'center' });
    return { heading: h.textContent.trim(), buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()), text: box.innerText };
  })()`);
  out.planCard = card;
  check(!!card, `${vp.name} B: old plan card displays`, card ? card.heading : "card not found");
  if (card) {
    check(card.buttons.length === 1 && card.buttons[0] === "Open Full View", `${vp.name} B: card has no approve/critique control`, `buttons: ${JSON.stringify(card.buttons)}`);
    check(!/Approve|Critique/.test(card.text), `${vp.name} B: no approve/critique wording on the card`);
  }
  await painted();
  out.planCardScreenshot = await shot(`B-${vp.name}-old-plan-card.png`);
  const opened = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open Full View');
    if (!btn) return false; btn.click(); return true;
  })()`);
  await painted();
  const modal = await evalJs(`(() => {
    const m = document.querySelector('div.fixed.inset-0.z-\\\\[100\\\\]');
    if (!m) return null;
    return { title: m.querySelector('h2')?.textContent.trim(), buttons: [...m.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim() || '(icon)'), text: m.innerText };
  })()`);
  out.fullView = modal;
  check(opened && !!modal, `${vp.name} B: full plan view opens`, modal?.title);
  if (modal) {
    check(modal.buttons.length === 1, `${vp.name} B: full view has only its close control`, `buttons: ${JSON.stringify(modal.buttons)}`);
    check(/Read the brief/.test(modal.text) && !/Approve|Request Revisions/.test(modal.text), `${vp.name} B: full view shows the plan, no approve/revise action`);
  }
  out.fullViewScreenshot = await shot(`B-${vp.name}-old-plan-full-view.png`);
  const b = summarize();
  out.planCardRun = { retiredRequests: b.retired.map(fmt), failedRequests: b.bad.map(fmt) };
  check(b.retired.length === 0, `${vp.name} B: no request to a retired route`);
  const unexpected = b.bad.filter((r) => !/\/api\/chat\/active/.test(r.url));
  check(unexpected.length === 0, `${vp.name} B: only the simulated transcript 503 failed`, out.planCardRun.failedRequests.join(" | "));
  await send("Fetch.disable");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedB });
  await evalJs(`localStorage.removeItem('cortex_chat_history')`);
}

// ── C: document-review comments (desktop) ──
const desktop = VIEWPORTS[0];
await send("Emulation.setDeviceMetricsOverride", { width: desktop.width, height: desktop.height, deviceScaleFactor: desktop.scale, mobile: false });
await send("Emulation.setTouchEmulationEnabled", { enabled: false });
const docRoute = `${BASE}/documents/${encodeURIComponent(fixture.documentId)}`;
const apiJson = async (p) => { const r = await fetch(`${fixture.api}${p}`); return r.json(); };
const commentListed = () => evalJs(`(document.querySelector('[data-comment-list]')?.textContent || '').includes(${JSON.stringify(REVIEW_COMMENT)})`);
const clickFirst = (sel) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
const c = {};
requests = new Map();
await navigate(docRoute);
c.documentShown = await evalJs(`document.body.innerText.includes(${JSON.stringify(fixture.documentTitle)})`);
c.commentButton = await clickFirst("[data-block-comment-button]");
await settle();
c.composerOpen = await evalJs(`!!document.querySelector('[data-composer] textarea')`);
// A keystroke's path into a controlled field: the native value setter, then a bubbling input event.
c.typed = await evalJs(`(() => { const el = document.querySelector('[data-composer] textarea'); if (!el) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(REVIEW_COMMENT)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await painted();
c.saveClicked = await evalJs(`(() => { const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save comment'); if (!el) return false; el.click(); return true; })()`);
await settle();
c.listedAfterSave = await commentListed();
const stored = (await apiJson(`/api/documents/${fixture.documentId}`)).review;
const storedComment = stored?.comments?.find((x) => x.body === REVIEW_COMMENT) || null;
c.storedOnReview = !!storedComment;
c.storedKind = storedComment?.kind ?? null;
c.reviewStatus = stored?.status ?? null;
report.commentScreenshot = await shot("C-desktop-document-review-comment.png");
await reload();
c.listedAfterReload = await commentListed();
c.resolveClicked = await evalJs(`(() => {
  const item = [...document.querySelectorAll('[data-comment-list] li')].find((li) => li.textContent.includes(${JSON.stringify(REVIEW_COMMENT)}));
  const btn = item?.querySelector('[data-comment-resolve]');
  if (!btn) return false; btn.click(); return true;
})()`);
await settle();
c.resolvedInUi = await evalJs(`(() => {
  const item = [...document.querySelectorAll('[data-comment-list] li')].find((li) => li.textContent.includes(${JSON.stringify(REVIEW_COMMENT)}));
  return item?.querySelector('[data-comment-resolve]')?.getAttribute('aria-pressed') === 'true';
})()`);
const afterResolve = (await apiJson(`/api/documents/${fixture.documentId}`)).review;
c.resolvedStored = !!afterResolve?.comments?.find((x) => x.body === REVIEW_COMMENT)?.resolved_at;
report.resolvedScreenshot = await shot("C-desktop-document-review-comment-resolved.png");
const cNet = summarize();
c.documentRequestsFailed = cNet.list.filter((r) => /\/api\/documents/.test(r.url) && ((r.status !== null && r.status >= 400) || (r.failed && !r.canceled))).map(fmt);
c.retiredRequests = cNet.retired.map(fmt);
c.documentWrites = cNet.writes.filter((r) => /\/api\/documents/.test(r.url)).map(fmt);
report.documentReviewComments = c;
check(c.documentShown, "C: the fixture document opens in the review page");
check(c.commentButton && c.composerOpen, "C: the passage comment composer opens");
check(c.typed && c.saveClicked && c.listedAfterSave, "C: the saved comment is listed");
check(c.storedOnReview, "C: the comment is stored on the review", `kind ${c.storedKind}, review ${c.reviewStatus}`);
check(c.listedAfterReload, "C: the comment is still listed after a reload");
check(c.resolveClicked && c.resolvedInUi && c.resolvedStored, "C: resolving the comment shows and stores it as resolved");
check(c.documentRequestsFailed.length === 0, "C: no document-review request failed", c.documentRequestsFailed.join(" | "));
check(c.retiredRequests.length === 0, "C: no request to a retired route");

// ── D: task-feature comments, through the dashboard's /api proxy ──
const featureCalls = await evalJs(`(async () => {
  const call = async (label, method, url, body) => {
    const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { label, method, path: url, status: r.status, body: json, text: json ? null : text.trim().split('\\n').find((l) => l.includes('Cannot')) || text.trim() };
  };
  const p = ${JSON.stringify(`/api/projects/${fixture.projectId}`)};
  const t = ${JSON.stringify(fixture.taskId)};
  return [
    await call('list (server route)', 'GET', p + '/features/' + t + '/comments'),
    await call('add (server route)', 'POST', p + '/features/' + t + '/comments', { stage: 'plan', content: ${JSON.stringify(FEATURE_COMMENT)} }),
    await call('resolve seeded (server route)', 'PATCH', p + '/features/' + t + '/comments/' + ${JSON.stringify(fixture.featureCommentId)}, { resolved: true }),
    await call('list (dashboard client path, timeline.ts getInlineComments)', 'GET', p + '/tasks/' + t + '/comments'),
  ];
})()`);
const scrub = (s) => String(s).replaceAll(fixture.projectId, "<project>").replaceAll(fixture.taskId, "<task>").replaceAll(fixture.featureCommentId, "<seeded comment>");
report.featureComments = (featureCalls || []).map((x) => ({ ...x, path: scrub(x.path), text: x.text ? scrub(x.text) : null }));
for (const x of report.featureComments) console.log(`  D ${x.label}: ${x.method} ${x.path} -> ${x.status} ${x.body ? JSON.stringify(x.body) : x.text}`);
check(report.featureComments.length === 4 && report.featureComments.every((x) => Number.isInteger(x.status)), "D: every feature-comment call was answered");

// Outcomes without ids or timestamps, so two runs on two trees compare. The
// retired-route list stays out: it is what this task removes (checked above as
// "C: no request to a retired route"), not how the comments behave. On the
// baseline tree it is not empty, because that tree never clears the stale
// thread id scenario A leaves in storage.
report.commentOutcomes = {
  documentReview: Object.fromEntries(Object.entries(c).filter(([k]) => !["documentWrites", "retiredRequests"].includes(k))),
  featureComments: report.featureComments.map((x) => ({
    label: x.label, status: x.status, error: x.body?.error ?? null, success: x.body?.success ?? null,
    comments: Array.isArray(x.body?.comments) ? x.body.comments.length : null, text: x.text,
  })),
};
if (COMPARE) {
  report.comparedWith = { label: COMPARE.label, dashboard: COMPARE.dashboard, serverRoot: COMPARE.api?.serverRoot, at: COMPARE.at };
  check(JSON.stringify(COMPARE.commentOutcomes?.documentReview) === JSON.stringify(report.commentOutcomes.documentReview),
    `C: document-review comment outcomes equal the ${COMPARE.label} run`);
  check(JSON.stringify(COMPARE.commentOutcomes?.featureComments) === JSON.stringify(report.commentOutcomes.featureComments),
    `D: task-feature comment answers equal the ${COMPARE.label} run`);
}

report.failures = failures;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`CHECK_REPORT ${path.join(OUT, "report.json")}`);
console.log(failures.length ? `CHECK_RESULT FAIL (${failures.length})` : "CHECK_RESULT PASS");
ws.close();
await teardown();
process.exit(failures.length ? 1 : 0);
