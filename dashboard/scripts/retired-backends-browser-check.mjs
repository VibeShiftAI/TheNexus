#!/usr/bin/env node
/**
 * Real-browser check for task 62b7c967 (2026-11-19): the dashboard no longer
 * calls the retired LangGraph terminal or artifact-comment backends.
 *
 * One foreground process owns the stack and tears it down by child PID:
 *   - unless CHECK_BASE is given, a second `next dev --webpack` from THIS
 *     checkout on a free port (NEXT_DIST_DIR=.next-verify-retired), proxying
 *     /api to the default API (live :4000, read-only page loads). Webpack, not
 *     Turbopack: a Praxis worktree links dashboard/node_modules from the shared
 *     checkout and Turbopack refuses a symlink that leaves the repo root;
 *   - headless Chrome over CDP at desktop (1440x900) and phone (390x844).
 *
 * The chat provider calls http://localhost:4000 directly whenever the page
 * host is localhost, and the live API's CORS list only admits :3000, so the
 * isolated tab runs with --disable-web-security. That changes nothing the
 * check measures; it only lets a second origin read what :3000 reads.
 *
 * Per viewport:
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
 *
 *   node scripts/retired-backends-browser-check.mjs
 *   CHECK_BASE=http://localhost:3000 CHECK_LABEL=before node scripts/retired-backends-browser-check.mjs
 *
 * Env: CHECK_BASE (skip the dev server), CHECK_LABEL (after), CHECK_WEB_SECURITY=1
 * (keep CORS on; only meaningful at the :3000 origin the API admits), CHECK_OUT
 * (docs/reviews/2026-11-19-retired-backend-calls), CHECK_CHROME,
 * CHECK_SETTLE_MS (12000). Writes <out>/<label>/*.png and report.json;
 * exits 1 on any failed assertion.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(here, "..");
const NEXUS = path.resolve(DASHBOARD, "..");
const LABEL = process.env.CHECK_LABEL || "after";
const OUT = path.join(path.resolve(process.env.CHECK_OUT || path.join(NEXUS, "docs/reviews/2026-11-19-retired-backend-calls")), LABEL);
const SETTLE_MS = Number(process.env.CHECK_SETTLE_MS || 12000);
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? "CHECK_OK  " : "CHECK_FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

// ── stack ──
const children = [];
let tsconfigSnapshot = null;
let profile = null;
const distDir = ".next-verify-retired";
let BASE = process.env.CHECK_BASE?.replace(/\/$/, "");
if (!BASE) {
  const port = await freePort();
  tsconfigSnapshot = fs.readFileSync(path.join(DASHBOARD, "tsconfig.json"));
  const dev = spawn("npx", ["next", "dev", "--webpack", "-p", String(port)], {
    cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: distDir }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  children.push(dev);
  const devLog = fs.createWriteStream(path.join(os.tmpdir(), "nexus-retired-next-dev.log"));
  dev.stdout.pipe(devLog); dev.stderr.pipe(devLog);
  BASE = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await fetch(`${BASE}/`)).status < 500; } catch { /* not listening yet */ }
    if (!up) await sleep(1000);
  }
  if (!up) { console.error("next dev did not come up"); await teardown(); process.exit(2); }
}
console.log(`CHECK_BASE ${BASE} (${LABEL})`);

const cdpPort = await freePort();
profile = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-retired-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--hide-scrollbars", ...(process.env.CHECK_WEB_SECURITY === "1" ? [] : ["--disable-web-security"]), "--autoplay-policy=user-gesture-required", "about:blank"], { stdio: "ignore" });
children.push(chrome);

async function teardown() {
  for (const c of children) {
    try { process.kill(-c.pid, "SIGTERM"); } catch { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  }
  await sleep(1500);
  if (tsconfigSnapshot) {
    fs.writeFileSync(path.join(DASHBOARD, "tsconfig.json"), tsconfigSnapshot);
    fs.rmSync(path.join(DASHBOARD, distDir), { recursive: true, force: true });
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
}

let version = null;
for (let i = 0; i < 50 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch { await sleep(200); }
}
if (!version) { console.error("Chrome did not expose its debugging port."); await teardown(); process.exit(2); }
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  for (const fn of listeners) fn(m);
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const { result } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data, "base64"));
  return name;
};

// ── network log ──
let requests = new Map();
listeners.push((m) => {
  const p = m.params;
  if (m.method === "Network.requestWillBeSent") {
    requests.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, status: null, failed: null, canceled: false });
  } else if (m.method === "Network.responseReceived" && requests.has(p.requestId)) {
    requests.get(p.requestId).status = p.response.status;
  } else if (m.method === "Network.loadingFailed" && requests.has(p.requestId)) {
    const r = requests.get(p.requestId); r.failed = p.errorText; r.canceled = !!p.canceled;
  } else if (m.method === "Fetch.requestPaused") {
    // Scenario B: answer the server transcript with 503 so the provider
    // falls back to the transcript kept in browser storage.
    send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 503, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from('{"error":"simulated: server transcript unavailable"}').toString("base64") });
  }
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

const summarize = () => {
  const list = [...requests.values()].filter((r) => /^https?:/.test(r.url));
  const bad = list.filter((r) => (r.status !== null && r.status >= 400) || (r.failed && !r.canceled));
  const canceled = list.filter((r) => r.canceled);
  const retired = list.filter((r) => RETIRED.test(r.url));
  const writes = list.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method));
  return { total: list.length, bad, canceled, retired, writes, list };
};

// Warm-up: compile the home route once so the timed runs measure the page.
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${BASE}/` });
await sleep(SETTLE_MS * 2);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, scale: 1, mobile: false },
  { name: "phone", width: 390, height: 844, scale: 2, mobile: true },
];
const report = { base: BASE, label: LABEL, at: new Date().toISOString(), webSecurityDisabled: process.env.CHECK_WEB_SECURITY !== "1", viewports: {} };

for (const vp of VIEWPORTS) {
  await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile });
  const out = (report.viewports[vp.name] = {});

  // ── A: stale thread id ──
  const { identifier: seedA } = (await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem(${JSON.stringify(THREAD_KEY)}, ${JSON.stringify(STALE_THREAD)}); localStorage.removeItem('cortex_chat_history'); } catch {}`,
  })).result;
  requests = new Map();
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(SETTLE_MS);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedA });
  const keyAfter = await evalJs(`localStorage.getItem(${JSON.stringify(THREAD_KEY)})`);
  const chatShown = await evalJs(`!!document.querySelector('[data-message-row]') || /Praxis/.test(document.body.innerText)`);
  const a = summarize();
  out.staleThread = {
    requests: a.total, retiredRequests: a.retired.map((r) => `${r.method} ${r.url} -> ${r.status ?? r.failed}`),
    failedRequests: a.bad.map((r) => `${r.method} ${r.url} -> ${r.status ?? r.failed}`),
    canceledRequests: a.canceled.map((r) => `${r.method} ${r.url} (${r.failed})`),
    nonGetRequests: a.writes.map((r) => `${r.method} ${r.url} -> ${r.status ?? r.failed}`),
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
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(SETTLE_MS);
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
  await sleep(500);
  out.planCardScreenshot = await shot(`B-${vp.name}-old-plan-card.png`);
  const opened = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open Full View');
    if (!btn) return false; btn.click(); return true;
  })()`);
  await sleep(1500);
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
  out.planCardRun = {
    retiredRequests: b.retired.map((r) => `${r.method} ${r.url} -> ${r.status ?? r.failed}`),
    failedRequests: b.bad.map((r) => `${r.method} ${r.url} -> ${r.status ?? r.failed}`),
  };
  check(b.retired.length === 0, `${vp.name} B: no request to a retired route`);
  const unexpected = b.bad.filter((r) => !/\/api\/chat\/active/.test(r.url));
  check(unexpected.length === 0, `${vp.name} B: only the simulated transcript 503 failed`, out.planCardRun.failedRequests.join(" | "));
  await send("Fetch.disable");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedB });
  await evalJs(`localStorage.removeItem('cortex_chat_history')`);
}

report.failures = failures;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`CHECK_REPORT ${path.join(OUT, "report.json")}`);
console.log(failures.length ? `CHECK_RESULT FAIL (${failures.length})` : "CHECK_RESULT PASS");
ws.close();
await teardown();
process.exit(failures.length ? 1 : 0);
