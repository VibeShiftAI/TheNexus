#!/usr/bin/env node
/**
 * Real-browser check of the chat's working steps, at desktop and phone width,
 * on an isolated stack (task eed607d4, 2026-11-23). One foreground process owns
 * everything and stops it by child PID:
 *
 *   - Praxis's real chat, stream and presence routes with the CLI and model
 *     replaced by a script (Praxis scripts/chat-steps-fixture.ts);
 *   - a throwaway Nexus API on a brand-new database, pointed at that fixture;
 *   - a second `next dev` (NEXT_DIST_DIR=.next-verify-steps) proxying /api to it;
 *   - headless Chrome over CDP. The page origin is http://127.0.0.1:<port>, never
 *     the local-operator origin, and Chrome maps localhost:4000 to the throwaway
 *     API, so the page's socket and history calls cannot reach the live one.
 *
 * At each width it asserts (CHECK_* lines):
 *   1. a working indicator with elapsed time before the first step;
 *   2. each step appears in order while the turn is still running;
 *   3. the reply folds them into one line with the measured duration and count;
 *   4. the line expands to the same steps;
 *   5. after a reload the reply stays and no step is shown or saved;
 *   6. a reload during a turn picks it up from the status route, without
 *      resending it, and its reply lands once;
 *   7. a degraded turn and an uncertain turn still say so;
 *   8. the main viewer's left column has no thought stream box while thinking.
 * Then: the planted credentials reached no page, stream, log, database or data
 * folder, and no request reached the live API port.
 *
 *   node scripts/chat-steps-browser-check.mjs
 *
 * Env: CHECK_OUT (evidence folder), CHECK_PACKAGE (review package folder),
 * CHECK_CHROME, CHECK_PRAXIS_REPO (../Praxis), CHECK_KEEP=1 keeps the temp dir.
 * Exits 1 on any failed assertion.
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
const PRAXIS = path.resolve(process.env.CHECK_PRAXIS_REPO || path.join(NEXUS, "..", "Praxis"));
const OUT = path.resolve(process.env.CHECK_OUT || path.join(NEXUS, "docs/reviews/2026-11-23-chat-thought-stream-evidence"));
const PACKAGE = path.resolve(process.env.CHECK_PACKAGE || path.join(NEXUS, "docs/reviews/2026-11-23-chat-thought-stream"));
const SHOTS = path.join(OUT, "screenshots");
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const KEEP = process.env.CHECK_KEEP === "1";
const DIST = ".next-verify-steps";
const RETIRED = "taking longer than expected";
const WIDTHS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const STATION = "#station-core";
const COMPOSER = `${STATION} textarea`;
const SEND = `${STATION} button[aria-label="Send message"]`;
const LIVE = '[data-turn-steps="live"]';
const FOLDED = '[data-turn-steps="folded"]';
const STEP_TEXT = [
  /^Check which files changed$/,
  /^Read .*ai-terminal\.tsx$/,
  /^Reasoning: The turn stream already carries status frames, so the steps can ride on it\. Never echo \[redacted\] or \[redacted\]\.$/,
  /^Ask the task board with \[redacted\], \[redacted\] and \[redacted\]$/,
  /^Search for "status_url"$/,
  /^Run the chat test suite$/,
];
// What the live list must read after each stage of the scripted turn.
const STAGES = [
  ["running"],
  ["done", "running"],
  ["done", "done", "done", "running"],
  ["done", "done", "done", "done", "running"],
  ["done", "done", "done", "done", "done", "running"],
];
const SAVED_NEVER = ["Check which files changed", "Run the chat test suite", "The turn stream already carries", "Ask the task board"];

for (const dir of [SHOTS, PACKAGE]) fs.mkdirSync(dir, { recursive: true });
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-chat-steps-")));
const praxisData = path.join(tmp, "praxis-data");
const chatFiles = path.join(tmp, "chat-files");
for (const dir of [praxisData, chatFiles]) fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(tmp, "nexus.db");
const tsconfigPath = path.join(DASHBOARD, "tsconfig.json");
const nextEnvPath = path.join(DASHBOARD, "next-env.d.ts");
const tsconfigBefore = fs.readFileSync(tsconfigPath);
const nextEnvBefore = fs.existsSync(nextEnvPath) ? fs.readFileSync(nextEnvPath) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});
const [fixturePort, apiPort, nextPort, cdpPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
const FIXTURE = `http://127.0.0.1:${fixturePort}`;
const API = `http://127.0.0.1:${apiPort}`;
const BASE = `http://127.0.0.1:${nextPort}`;

const children = [];
const logs = {};
function run(name, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  logs[name] = "";
  const sink = (chunk) => { logs[name] += chunk.toString(); };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  children.push({ name, child });
  return child;
}
async function waitHttp(url, label, timeoutMs, accept = (r) => r.ok) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const r = await fetch(url); if (accept(r)) return true; } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error(`${label} did not come up within ${timeoutMs} ms`);
}

const report = { when: new Date().toISOString(), ports: { fixture: fixturePort, api: apiPort, next: nextPort }, steps: [], failures: [] };
let step = "setup";
const fail = (message) => { report.failures.push(`${step}: ${message}`); console.log(`  FAIL ${step}: ${message}`); };
const check = (ok, message) => { if (!ok) fail(message); return Boolean(ok); };
const note = (label, detail) => { report.steps.push({ step, label, detail }); console.log(`CHECK_${step.toUpperCase().replace(/[^A-Z0-9]+/g, "_")} ${label}${detail !== undefined ? ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };
const fixture = {
  post: async (route, body = {}) => (await fetch(`${FIXTURE}/__fixture/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json(),
  state: async () => (await fetch(`${FIXTURE}/__fixture/state`)).json(),
};
const advance = () => fixture.post("advance");
const receiptOf = async (key) => {
  const text = await (await fetch(`${API}/api/ai/chat/turns/${encodeURIComponent(key)}`)).text();
  receipts.push(text);
  return JSON.parse(text);
};
const receipts = [];
const secretValues = async () => {
  const state = await fixture.state();
  return [...state.minted, state.planted.grant, state.planted.credential];
};
// A value or its tail counts as a leak; only a count is ever printed.
const leaks = (text, values) => values.filter((value) => value && (text.includes(value) || text.includes(value.slice(-16)))).length;
function readTree(dir) {
  let text = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) text += readTree(full);
    else if (entry.isFile() && fs.statSync(full).size < 32 * 1024 * 1024) text += fs.readFileSync(full, "latin1");
  }
  return text;
}
const readDatabase = () => [dbPath, `${dbPath}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "latin1")).join("\n");
function labelSeconds(label) {
  if (/^Worked for under 1s/.test(label)) return 0;
  const match = label.match(/^Worked for (?:(\d+)m )?(\d+)s/);
  return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : null;
}

let ws = null;
let chrome = null;
try {
  // ── Stack ─────────────────────────────────────────────────────────────
  const emptyFleetEnv = path.join(tmp, "empty-fleet-env");
  fs.writeFileSync(emptyFleetEnv, "");
  run("fixture", path.join(PRAXIS, "node_modules", ".bin", "tsx"), ["scripts/chat-steps-fixture.ts"], {
    cwd: PRAXIS,
    env: { ...process.env, PRAXIS_DATA_DIR: praxisData, NEXUS_API_URL: API, FIXTURE_PORT: String(fixturePort), PRAXIS_TEST: "1", FLEET_ENV_PATH: emptyFleetEnv },
  });
  await waitHttp(`${FIXTURE}/__fixture/state`, "the Praxis fixture", 90_000);
  run("api", process.execPath, ["server/server.js"], {
    cwd: NEXUS,
    env: { ...process.env, PORT: String(apiPort), NEXUS_DB_PATH: dbPath, NEXUS_CHAT_FILES_DIR: chatFiles, NEXUS_REVIEW_BLOB_DIR: path.join(tmp, "review-blobs"), PRAXIS_URL: FIXTURE, FLEET_ENV_PATH: emptyFleetEnv },
  });
  await waitHttp(`${API}/api/health`, "the throwaway Nexus API", 60_000);
  run("next", path.join(DASHBOARD, "node_modules", ".bin", "next"), ["dev", "--webpack", "-p", String(nextPort), "-H", "127.0.0.1"], {
    cwd: DASHBOARD,
    env: { ...process.env, NEXT_DIST_DIR: DIST, NEXT_PUBLIC_API_URL: API, PORT: String(nextPort) },
  });
  await waitHttp(`${BASE}/`, "the isolated dashboard", 300_000);
  note("stack_up", { fixture: FIXTURE, api: API, dashboard: BASE });

  // ── Browser ───────────────────────────────────────────────────────────
  const hostRules = `MAP localhost:4000 127.0.0.1:${apiPort},MAP 127.0.0.1:4000 127.0.0.1:${apiPort}`;
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(tmp, "chrome-profile")}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--disable-web-security", `--host-resolver-rules=${hostRules}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch { await sleep(200); }
  }
  if (!version) throw new Error("Chrome did not expose its debugging port.");
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const chatPosts = [];
  const postIds = new Set();
  const rawBodies = [];
  const remotePorts = new Map();
  let creatingConversation = null;
  let conversationCreated = false;
  let conversationsSet = 0;
  const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") {
      const { url, method, postData } = m.params.request;
      if (method === "POST" && new URL(url).pathname === "/api/ai/chat") {
        postIds.add(m.params.requestId);
        chatPosts.push({ step, key: JSON.parse(postData ?? "{}").clientMessageId });
      }
      // The page refreshes this list right after it has switched to a new conversation.
      if (new URL(url).pathname === "/api/chat/conversations") {
        if (method === "POST") creatingConversation = m.params.requestId;
        else if (conversationCreated) { conversationCreated = false; conversationsSet += 1; }
      }
    }
    if (m.method === "Network.loadingFinished" && m.params.requestId === creatingConversation) {
      creatingConversation = null;
      conversationCreated = true;
    }
    if (m.method === "Network.responseReceived") {
      const port = m.params.response.remotePort;
      if (port) remotePorts.set(port, (remotePorts.get(port) ?? 0) + 1);
    }
    if (m.method === "Network.loadingFinished" && postIds.has(m.params.requestId)) {
      void send("Network.getResponseBody", { requestId: m.params.requestId }).then((r) => { if (r.result?.body) rawBodies.push(r.result.body); });
    }
    if (m.method === "Runtime.exceptionThrown") exceptions.push(`${step}: ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) || m.params.exceptionDetails?.text}`);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable", { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024 });

  const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  async function waitFor(expression, label, timeoutMs = 30_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evalJs(expression)) return true;
      await sleep(100);
    }
    fail(`timed out waiting for ${label}`);
    return false;
  }
  async function waitUntil(test, label, timeoutMs = 30_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await test()) return true;
      await sleep(100);
    }
    fail(`timed out waiting for ${label}`);
    return false;
  }
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const qa = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})]`;
  const count = (sel) => evalJs(`${qa(sel)}.length`);
  const rowsOf = (scope) => evalJs(`[...((${scope})?.querySelectorAll('[data-step-status]') ?? [])].map(li => ({ text: li.textContent.replace(/(running|done|failed|did not finish)$/, ''), status: li.dataset.stepStatus }))`);
  const liveRows = () => rowsOf(q(LIVE));
  const lastFold = `${qa(FOLDED)}.at(-1)`;
  const rowsMatch = (rows, statuses) => rows.length === statuses.length && rows.every((row, i) => row.status === statuses[i] && STEP_TEXT[i].test(row.text));

  async function clean(where) {
    const page = await evalJs("document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })");
    check(typeof page === "string" && page.length > 1000, `${where}: the page could be read`);
    check(leaks(page ?? "", await secretValues()) === 0, `${where}: a planted value is on the page`);
    check(!(page ?? "").toLowerCase().includes(RETIRED), `${where}: the retired message is on the page`);
  }
  async function hydrated() {
    await waitFor(`!window.__checkOld && (() => { const el = ${q(COMPOSER)}; return !!el && Object.keys(el).some(k => k.startsWith('__reactProps')); })()`, "the chat composer to hydrate", 240_000);
    // A shot taken before presence lands would show a false "Offline" core.
    await waitFor(`(${q(".praxis-core-label")}?.textContent ?? 'Offline') !== 'Offline'`, "the core to connect", 30_000);
  }
  async function openHome() {
    await evalJs("window.__checkOld = true");
    await send("Page.navigate", { url: `${BASE}/` });
    await hydrated();
  }
  async function reload() {
    await evalJs("window.__checkOld = true");
    await send("Page.reload", { ignoreCache: false });
    await hydrated();
  }
  async function useWidth(name) {
    const { width, height, deviceScaleFactor, mobile } = WIDTHS[name];
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    await send("Emulation.setUserAgentOverride", { userAgent: mobile ? PHONE_UA : version["User-Agent"].replace("HeadlessChrome", "Chrome") });
  }
  async function sendMessage(text) {
    const before = chatPosts.length;
    check(await evalJs(`(() => { const el = ${q(COMPOSER)}; if (!el) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), "the composer takes text");
    await waitFor(`!!${q(SEND)} && !${q(SEND)}.disabled`, "Send to enable");
    await evalJs(`${q(SEND)}.click()`);
    await waitUntil(() => chatPosts.length > before, "the chat POST");
    return chatPosts.at(-1)?.key;
  }
  async function startFresh() {
    const setBefore = conversationsSet;
    await evalJs(`${q(`${STATION} button[aria-label="New conversation"]`)}?.click()`);
    // The transcript can already be empty, so wait for the switch itself.
    await waitUntil(() => conversationsSet > setBefore, "the new conversation to take effect");
    await waitFor(`${qa(`${STATION} [data-message-row]`)}.length === 0`, "an empty conversation");
  }
  async function keepComposerInView() {
    await evalJs(`${q(COMPOSER)}.scrollIntoView({ block: 'end' })`);
    await evalJs("new Promise(requestAnimationFrame)");
  }
  async function capture(dir, file, name) {
    const shotParams = name === "desktop"
      ? await (async () => {
        // The site header is sticky: from the top of the page it cannot cover the station.
        await evalJs("(window.scrollTo(0, 0), new Promise(requestAnimationFrame))");
        const rect = await evalJs(`(() => { const r = ${q(STATION)}.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
        return { clip: { ...rect, scale: 1 }, captureBeyondViewport: true };
      })()
      : { captureBeyondViewport: false };
    const s = await send("Page.captureScreenshot", { format: "png", ...shotParams });
    check(s.result?.data, `screenshot ${file}`);
    if (s.result?.data) fs.writeFileSync(path.join(dir, file), Buffer.from(s.result.data, "base64"));
    return file;
  }
  const noSideways = () => evalJs("document.documentElement.scrollWidth <= innerWidth");
  const rowsInside = (sel) => evalJs(`${qa(`${sel} [data-step-status]`)}.every(el => { const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5; })`);

  async function runWidth(name) {
    await useWidth(name);

    // 1 and 2. The working indicator, then each step while the turn runs.
    step = `${name}-live`;
    await openHome();
    await startFresh();
    await fixture.post("scenario", { name: "steps" });
    const spawnsBefore = (await fixture.state()).spawns;
    const assistantsBefore = await count(`${STATION} [data-message-row="assistant"]`);
    const key = await sendMessage("Check the chat tests and tell me what you find.");
    await waitFor(`!!${q(`${LIVE} [data-turn-elapsed]`)}`, "the working indicator with elapsed time");
    await waitUntil(async () => (await fixture.state()).waiting, "the turn to reach its first stage");
    check((await liveRows()).length === 0, "no step before the first one arrives");
    const elapsedFirst = await evalJs(`${q(`${LIVE} [data-turn-elapsed]`)}.textContent`);
    check(/^(under 1s|\d+s)$/.test(elapsedFirst ?? ""), `elapsed time reads plainly (${elapsedFirst})`);
    await waitFor(`${q(`${LIVE} [data-turn-elapsed]`)}?.textContent !== ${JSON.stringify(elapsedFirst)}`, "the elapsed time to count up", 5_000);
    const working = await evalJs(`${q(`${LIVE} [role="status"]`)}?.textContent`);
    note("working_indicator", { status: working, elapsed: elapsedFirst, screenshot: await capture(SHOTS, `${name}-working.png`, name) });
    await clean("working indicator");

    const stagesSeen = [];
    for (const statuses of STAGES) {
      await advance();
      await waitUntil(async () => rowsMatch(await liveRows(), statuses), `live steps ${statuses.join(",")}`);
      check(await evalJs(`${qa(`${STATION} [data-message-row="assistant"]`)}.length`) === assistantsBefore, "no reply row while the steps run");
      check((await fixture.state()).waiting, "the turn is still running at this stage");
      stagesSeen.push((await liveRows()).map((row) => row.status[0]).join(""));
      await clean(`stage ${stagesSeen.length}`);
    }
    note("steps_in_order_while_running", { stages: stagesSeen, rows: await liveRows() });
    check(await noSideways(), "no sideways scrolling during the turn");
    check(await rowsInside(LIVE), "every live step sits inside the viewport");
    await evalJs(`${q(LIVE)}.scrollIntoView({ block: 'end' })`);
    await keepComposerInView();
    const liveShot = await capture(PACKAGE, `chat-live-${name}.png`, name);
    note("live_screenshot", liveShot);

    // 3 and 4. The reply folds them; the line expands.
    step = `${name}-fold`;
    await advance();
    await waitFor(`!${q(LIVE)} && ${qa(`${STATION} [data-message-row="assistant"]`)}.length === ${assistantsBefore + 1}`, "the reply and the end of the live panel");
    await waitFor(`${qa(FOLDED)}.length === 1`, "the folded line");
    const label = await evalJs(`${lastFold}.querySelector('button').textContent`);
    const receipt = await receiptOf(key);
    check(/ · 6 steps$/.test(label ?? ""), `the line states the step count (${label})`);
    check(labelSeconds(label) === Math.floor(receipt.duration_ms / 1000), `the line states the measured duration (${label}, ${receipt.duration_ms} ms)`);
    check(receipt.state === "completed" && receipt.step_count === 6, `the turn receipt agrees (${receipt.state}, ${receipt.step_count})`);
    check(await evalJs(`${lastFold}.querySelector('button').getAttribute('aria-expanded')`) === "false", "collapsed by default");
    check((await rowsOf(lastFold)).length === 0, "no step shows while collapsed");
    check(await evalJs(`${lastFold}.nextElementSibling?.getAttribute('data-message-row')`) === "assistant", "the line sits directly above the reply");
    if (name === "phone") check(await evalJs(`${lastFold}.querySelector('button').getBoundingClientRect().height >= 44`), "the line is a 44px tap target on the phone");
    await keepComposerInView();
    note("folded", { label, duration_ms: receipt.duration_ms, step_count: receipt.step_count, screenshot: await capture(PACKAGE, `chat-folded-${name}.png`, name) });
    await evalJs(`${lastFold}.querySelector('button').click()`);
    await waitFor(`${lastFold}.querySelector('button').getAttribute('aria-expanded') === 'true' && ${lastFold}.querySelectorAll('[data-step-status]').length === 6`, "the expanded steps");
    const expanded = await rowsOf(lastFold);
    check(rowsMatch(expanded, ["done", "done", "done", "done", "done", "done"]), `the expanded line lists the same steps in order (${JSON.stringify(expanded)})`);
    check(await noSideways(), "no sideways scrolling with the line open");
    check(await rowsInside(FOLDED), "every expanded step sits inside the viewport");
    await evalJs(`${lastFold}.scrollIntoView({ block: 'nearest' })`);
    await evalJs("new Promise(requestAnimationFrame)");
    note("expanded", { rows: expanded.length, screenshot: await capture(PACKAGE, `chat-expanded-${name}.png`, name) });
    await clean("expanded");
    check((await fixture.state()).spawns === spawnsBefore + 1, "the turn ran once");

    // 5. After a reload the reply stays, the steps do not.
    step = `${name}-reload`;
    await reload();
    await waitFor(`${qa(`${STATION} [data-message-row="assistant"]`)}.length === 1`, "the saved reply after the reload", 60_000);
    check(await count(`${STATION} [data-message-row="user"]`) === 1, "one saved user message");
    check(await count("[data-turn-steps]") === 0, "no step panel or line after the reload");
    const afterReload = await evalJs(`${q(STATION)}.textContent`);
    check(!SAVED_NEVER.some((text) => (afterReload ?? "").includes(text)), "no step text after the reload");
    const db = readDatabase();
    check(db.length > 0 && db.includes("Check the chat tests"), "the database holds the conversation");
    check(!SAVED_NEVER.some((text) => db.includes(text)), "no step text in the database");
    note("reload_keeps_reply_not_steps", { messages: await count(`${STATION} [data-message-row]`), screenshot: await capture(SHOTS, `${name}-after-reload.png`, name) });
    await clean("after reload");

    // 6. A reload during a turn: picked up from the status route, not resent.
    step = `${name}-replay`;
    await fixture.post("scenario", { name: "steps" });
    const postsBefore = chatPosts.length;
    const replayKey = await sendMessage("Run the same check again.");
    const spawnsDuring = spawnsBefore + 2;
    await waitUntil(async () => (await fixture.state()).spawns === spawnsDuring, "the second turn to start");
    for (const statuses of STAGES.slice(0, 3)) {
      await advance();
      await waitUntil(async () => rowsMatch(await liveRows(), statuses), `live steps before the reload ${statuses.join(",")}`);
    }
    await reload();
    await waitUntil(async () => rowsMatch(await liveRows(), STAGES[2]), "the running turn after the reload", 60_000);
    const statusLine = await evalJs(`${q(`${LIVE} [role="status"]`)}?.textContent`);
    check(statusLine === "Praxis is still working on this message.", `the panel says the turn is still running (${statusLine})`);
    check((await receiptOf(replayKey)).state === "in_progress", "the status route reports it in progress");
    await advance();
    await waitUntil(async () => rowsMatch(await liveRows(), STAGES[3]), "a later step, from the status route", 30_000);
    await advance();
    await waitUntil(async () => rowsMatch(await liveRows(), STAGES[4]), "the last step, from the status route", 30_000);
    await clean("replay");
    await advance();
    await waitFor(`!${q(LIVE)} && ${qa(`${STATION} [data-message-row="assistant"]`)}.length === 2`, "the replayed turn's reply", 60_000);
    await waitFor(`${qa(FOLDED)}.length === 1`, "the replayed turn's folded line", 30_000);
    const replayLabel = await evalJs(`${lastFold}.querySelector('button').textContent`);
    check(/ · 6 steps$/.test(replayLabel ?? ""), `the replayed turn folds with its count (${replayLabel})`);
    check(chatPosts.length === postsBefore + 1, "the reload sent nothing again");
    check((await fixture.state()).spawns === spawnsDuring, "the turn was not run again");
    check(await count(`${STATION} [data-message-row="user"]`) === 2, "no duplicate user message");
    note("reload_during_turn", { label: replayLabel, posts: chatPosts.length - postsBefore, screenshot: await capture(SHOTS, `${name}-after-replay.png`, name) });

    // 7. Truly degraded and uncertain turns still say so.
    step = `${name}-degraded`;
    await fixture.post("scenario", { name: "degraded" });
    const repliesBefore = await count(`${STATION} [data-message-row="assistant"]`);
    await sendMessage("Try the fallback.");
    await waitFor(`/fallback agent is taking this message/.test(${q(`${LIVE} [role="alert"]`)}?.textContent ?? '')`, "the degraded notice");
    await waitUntil(async () => (await liveRows()).some((row) => row.text === "Use tool: get_current_time"), "the fallback agent's step");
    const degraded = await evalJs(`${q(`${LIVE} [role="alert"]`)}.textContent`);
    note("degraded_notice", { alert: degraded, screenshot: await capture(SHOTS, `${name}-degraded.png`, name) });
    await clean("degraded");
    await advance();
    await waitFor(`!${q(LIVE)} && ${qa(`${STATION} [data-message-row="assistant"]`)}.length === ${repliesBefore + 1}`, "the fallback reply");
    check((await evalJs(`${q(STATION)}.textContent`)).includes("The fallback agent answered this message."), "the fallback reply is shown");

    step = `${name}-uncertain`;
    await fixture.post("scenario", { name: "uncertain" });
    const beforeUncertain = await count(`${STATION} [data-message-row="assistant"]`);
    await sendMessage("Build it.");
    await waitUntil(async () => (await fixture.state()).waiting, "the uncertain turn to start");
    await advance();
    await waitUntil(async () => (await liveRows()).some((row) => row.text === "Build the dashboard"), "the build step");
    await advance();
    await waitFor(`!${q(LIVE)} && ${qa(`${STATION} [data-message-row="assistant"]`)}.length === ${beforeUncertain + 1}`, "the uncertain reply");
    await waitFor(`/did not finish/.test(${lastFold}?.textContent ?? '')`, "the unfinished step on the folded line");
    const uncertainLine = await evalJs(`${lastFold}.querySelector('button').textContent`);
    check((await evalJs(`${q(STATION)}.textContent`)).includes("Its outcome is unconfirmed"), "the uncertain outcome is stated");
    await keepComposerInView();
    note("uncertain_reply", { line: uncertainLine, screenshot: await capture(SHOTS, `${name}-uncertain.png`, name) });
    await clean("uncertain");

    // 8. The left column, while the core is thinking with a live trace.
    step = `${name}-viewer`;
    await startFresh();
    const core = await fixture.post("core", { active: true });
    check(core.presence?.activity === "thinking" && core.presence?.thinkingTrace, "the fixture's core is thinking with a trace");
    await waitFor(`${q(".praxis-core-label")}?.textContent === 'Thinking'`, "the core to read Thinking", 15_000);
    const column = await evalJs(`${q(".praxis-core-presence")}.textContent`);
    check(!/thought stream/i.test(column ?? ""), "no thought stream box in the left column");
    check(await count('[aria-label="Read full thought trace"]') === 0, "no button opening the thought trace");
    check(!/thought trace/i.test(await evalJs("document.body.textContent") ?? ""), "no thought trace modal");
    check(!(column ?? "").includes("Reading the chat route"), "the trace text is not in the left column");
    // Centered: at the top of the page's scroll the sticky site header covers the core.
    await evalJs(`${q(".praxis-core-presence")}.scrollIntoView({ block: 'center' })`);
    await evalJs("new Promise(requestAnimationFrame)");
    check(await evalJs(`(() => { const r = ${q(".praxis-core-label")}.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit?.closest('.praxis-core-label'); })()`), "the core's label is not covered in the shot");
    note("viewer_left_column", { label: await evalJs(`${q(".praxis-core-label")}.textContent`), screenshot: await capture(PACKAGE, `viewer-left-column-${name}.png`, name) });
    await fixture.post("core", { active: false });
    await waitFor(`${q(".praxis-core-label")}?.textContent !== 'Thinking'`, "the core to leave Thinking", 15_000);
  }

  await runWidth("desktop");
  await runWidth("phone");

  // ── Secrets, across everything the run produced ───────────────────────
  step = "secrets";
  await waitUntil(() => rawBodies.length >= 4, "the finished chat streams", 10_000);
  const values = await secretValues();
  const state = await fixture.state();
  check(state.minted.length >= 8 && new Set(state.minted).size === state.minted.length, `each turn minted its own real token (${state.minted.length})`);
  const streams = rawBodies.join("\n");
  check(streams.includes('"type":"step"') && streams.includes("[redacted]"), "the captured streams carry step frames with the redaction");
  const sources = {
    "chat streams received by the browser": streams,
    "turn status route": receipts.join("\n"),
    "Praxis process output": logs.fixture,
    "Praxis logger": state.logged.join("\n"),
    "global thinking trace": state.traces.join("\n"),
    "Nexus API output": logs.api,
    "dashboard server output": logs.next,
    "Nexus database": readDatabase(),
    "Praxis data folder": readTree(praxisData),
  };
  const scanned = {};
  for (const [where, text] of Object.entries(sources)) {
    const found = leaks(text, values);
    scanned[where] = { bytes: text.length, leaked: found };
    check(found === 0, `${where}: ${found} planted value(s) found`);
  }
  check(scanned["global thinking trace"].bytes > 0 && scanned["Praxis logger"].bytes > 0, "the trace and log scans covered real output");
  note("planted_values_absent", { planted: values.length, scanned });

  step = "isolation";
  check(!remotePorts.has(4000), `no response came from the live API port (${[...remotePorts.keys()].join(",")})`);
  check(remotePorts.has(apiPort), "the page's mapped calls reached the throwaway API");
  check(exceptions.length === 0, `no page exceptions (${exceptions.join(" | ")})`);
  note("isolation", { responsesByPort: Object.fromEntries([...remotePorts].map(([port, n]) => [port === apiPort ? "throwaway-api" : port === nextPort ? "dashboard" : String(port), n])), chatPosts: chatPosts.length });
} catch (error) {
  fail(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  try { ws?.close(); } catch { /* closing */ }
  chrome?.kill("SIGTERM");
  for (const { child } of [...children].reverse()) child.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  for (const { child } of children) {
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  fs.writeFileSync(tsconfigPath, tsconfigBefore);
  if (nextEnvBefore) fs.writeFileSync(nextEnvPath, nextEnvBefore);
  for (const [name, content] of Object.entries(logs)) fs.writeFileSync(path.join(tmp, `${name}-output.txt`), content);
  report.ok = report.failures.length === 0;
  fs.writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(report.ok ? `CHECK_RESULT ok (${report.steps.length} steps)` : `CHECK_RESULT FAIL\n${report.failures.join("\n")}\n(stack output kept in ${tmp})`);
  if (report.ok && !KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(report.ok ? 0 : 1);
}
