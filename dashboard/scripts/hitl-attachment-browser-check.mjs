#!/usr/bin/env node
/**
 * Phone-width, real-browser check of photo attachments on inbox answers, on
 * an isolated stack (task 0df94949, 2026-10-24). One foreground process owns
 * everything and tears it down by child PID:
 *
 *   - a throwaway Praxis HITL service (Praxis scripts/hitl-answer-attachments-fixture.ts,
 *     sandboxed stores, follow-up agent replaced by a recorder);
 *   - a throwaway Nexus API on a sqlite `.backup` copy of nexus.db with its own
 *     chat-files store, pointed at that fixture (PRAXIS_URL);
 *   - a second `next dev` (NEXT_DIST_DIR=.next-verify-hitl) proxying /api to it;
 *   - headless Chrome over CDP emulating a 390x844 phone.
 *
 * What it drives and asserts (each step prints a CHECK_* line):
 *   1. /inbox#<card> shows the ask_robert card with the Photo button;
 *   2. a screenshot is picked: chip with thumbnail, name and size;
 *   3. it is removed before sending; picked again; the answer is typed;
 *   4. Send uploads through the Nexus upload API and resolves the card; the
 *      history shows the photo link after a reload;
 *   5. the saved Praxis resolution carries the reference (payload.attachments)
 *      and the note in freeText with the local file and the Nexus URL; the
 *      recorded follow-up prompt names the task, the subject and the URL;
 *      the bytes served at the URL and on disk equal the picked file; a
 *      repeated submit delivers no second follow-up;
 *   6. a PDF and a 26 MB file are refused in words, the typed answer kept;
 *   7. a non-image named .png is refused by the Nexus guard (400) with the
 *      answer and chip kept and the card still pending; removing it and
 *      sending text-only resolves with no payload;
 *   8. a choice card resolves by tapping an option with no payload;
 *   9. the live data/chat-files store is untouched.
 *
 *   node scripts/hitl-attachment-browser-check.mjs
 *
 * Env: CHECK_OUT (docs/reviews/2026-10-24-hitl-answer-attachments), CHECK_CHROME,
 * CHECK_PRAXIS_REPO (../Praxis), CHECK_SOURCE_DB (../nexus.db), CHECK_KEEP=1
 * keeps the temp dir. Writes <out>/screenshots/*.png and <out>/report.json;
 * exits 1 on any failed assertion.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(here, "..");
const NEXUS = path.resolve(DASHBOARD, "..");
const PRAXIS = path.resolve(process.env.CHECK_PRAXIS_REPO || path.join(NEXUS, "..", "Praxis"));
const OUT = path.resolve(process.env.CHECK_OUT || path.join(NEXUS, "docs/reviews/2026-10-24-hitl-answer-attachments"));
const SHOTS = path.join(OUT, "screenshots");
const SOURCE_DB = path.resolve(process.env.CHECK_SOURCE_DB || path.join(NEXUS, "nexus.db"));
const LIVE_CHAT_FILES = path.join(NEXUS, "data", "chat-files");
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const KEEP = process.env.CHECK_KEEP === "1";
const TASK_ID = "d88e7186-9e9a-4535-961c-fa24cf9e17a4";
const SUBJECT = "Status report email: Gmail screenshot (isolated fixture)";
const ANSWER = "Gmail looks good: one column, full-width buttons, nothing sideways.";

fs.mkdirSync(SHOTS, { recursive: true });
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-hitl-attachments-")));
const chatFiles = path.join(tmp, "chat-files");
const praxisData = path.join(tmp, "praxis-data");
const fixtures = path.join(tmp, "fixtures");
for (const dir of [chatFiles, praxisData, fixtures]) fs.mkdirSync(dir, { recursive: true });
const dbCopy = path.join(tmp, "nexus.db");
execFileSync("sqlite3", [SOURCE_DB, `.backup '${dbCopy}'`]);
const liveStoreBefore = fs.readdirSync(LIVE_CHAT_FILES).sort();
const tsconfigPath = path.join(DASHBOARD, "tsconfig.json");
const nextEnvPath = path.join(DASHBOARD, "next-env.d.ts");
const tsconfigBefore = fs.readFileSync(tsconfigPath);
const nextEnvBefore = fs.existsSync(nextEnvPath) ? fs.readFileSync(nextEnvPath) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
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
    await sleep(400);
  }
  throw new Error(`${label} did not come up within ${timeoutMs} ms`);
}

const report = { when: new Date().toISOString(), ports: { fixture: fixturePort, api: apiPort, next: nextPort }, tmp, steps: [], failures: [] };
let step = "setup";
const fail = (message) => { report.failures.push(`${step}: ${message}`); console.log(`  FAIL ${step}: ${message}`); };
const check = (ok, message) => { if (!ok) fail(message); return ok; };
const note = (label, detail) => { report.steps.push({ step, label, detail }); console.log(`CHECK_${step.toUpperCase().replace(/[^A-Z0-9]+/g, "_")} ${label}${detail !== undefined ? ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };

let ws = null;
let chrome = null;
try {
  // ── Stack ─────────────────────────────────────────────────────────────
  const emptyFleetEnv = path.join(tmp, "empty-fleet-env");
  fs.writeFileSync(emptyFleetEnv, "");
  run("fixture", path.join(PRAXIS, "node_modules", ".bin", "tsx"), ["scripts/hitl-answer-attachments-fixture.ts"], {
    cwd: PRAXIS,
    env: { ...process.env, PRAXIS_DATA_DIR: praxisData, PRAXIS_NEXUS_CHAT_FILES_DIR: chatFiles, NEXUS_API_URL: API, FIXTURE_PORT: String(fixturePort), PRAXIS_TEST: "1", FLEET_ENV_PATH: emptyFleetEnv },
  });
  await waitHttp(`${FIXTURE}/hitl/pending`, "the Praxis fixture", 60_000);
  run("api", process.execPath, ["server/server.js"], {
    cwd: NEXUS,
    env: { ...process.env, PORT: String(apiPort), NEXUS_DB_PATH: dbCopy, NEXUS_CHAT_FILES_DIR: chatFiles, NEXUS_REVIEW_BLOB_DIR: path.join(tmp, "review-blobs"), PRAXIS_URL: FIXTURE, FLEET_ENV_PATH: emptyFleetEnv },
  });
  await waitHttp(`${API}/api/health`, "the throwaway Nexus API", 60_000);
  run("next", path.join(DASHBOARD, "node_modules", ".bin", "next"), ["dev", "-p", String(nextPort), "-H", "127.0.0.1"], {
    cwd: DASHBOARD,
    env: { ...process.env, NEXT_DIST_DIR: ".next-verify-hitl", NEXT_PUBLIC_API_URL: API, PORT: String(nextPort) },
  });
  await waitHttp(`${BASE}/inbox`, "the isolated dashboard", 240_000);
  note("stack_up", { fixture: FIXTURE, api: API, dashboard: BASE });

  // Cards: the photo question (same task and wording as the real one), a
  // text question for the refusal paths, and a choice card.
  const card = async (body) => (await (await fetch(`${FIXTURE}/__fixture/cards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()).id;
  const photoCard = await card({ kind: "ask-robert", subject: SUBJECT, body: "Attach a screenshot of the Gmail rendering.", taskId: TASK_ID, question: "Gmail app, either message: one column, no sideways scrolling, full-width buttons? Attach a screenshot." });
  const textCard = await card({ kind: "ask-robert", subject: "Which layout did the client approve? (isolated fixture)", body: "Pick one.", taskId: "fixture-layout-task", question: "Which layout did the client approve?" });
  const choiceCard = await card({ kind: "choice", question: "Approve the isolated fixture plan?", options: ["approve", "reject"] });
  check(Boolean(photoCard && textCard && choiceCard), "fixture cards were created");
  const viaNexus = await (await fetch(`${API}/api/praxis/hitl/pending`)).json();
  check((viaNexus.requests ?? []).some((r) => r.id === photoCard), "the Nexus API lists the fixture card through the proxy");

  // ── Browser ───────────────────────────────────────────────────────────
  const profile = path.join(tmp, "chrome-profile");
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--window-size=390,844", "about:blank"], { stdio: "ignore" });
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
  const apiCalls = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") {
      const { url, method } = m.params.request;
      if (url.includes("/api/")) apiCalls.push({ step, method, path: new URL(url).pathname });
    }
    if (m.method === "Runtime.exceptionThrown") exceptions.push(`${step}: ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) || m.params.exceptionDetails?.text}`);
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("DOM.enable");
  const phone = () => send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await phone();
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" });
  const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  async function waitFor(expression, label, timeoutMs = 30_000) {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
      if (await evalJs(expression)) return true;
      await sleep(250);
    }
    fail(`timed out waiting for ${label}`);
    return false;
  }
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const qa = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})]`;
  const text = async (sel) => evalJs(`${q(sel)}?.textContent ?? null`);
  const exists = async (sel) => Boolean(await evalJs(`!!${q(sel)}`));
  const click = async (sel) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`), `clickable ${sel}`);
  const clickButton = async (scope, label) => check(await evalJs(`(() => { const el = ${qa(`${scope} button`)}.find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`), `button "${label}" in ${scope}`);
  const typeInto = async (sel, value) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), `field ${sel}`);
  const value = async (sel) => evalJs(`${q(sel)}?.value ?? null`);
  const chips = async (scope) => evalJs(`${qa(`${scope} [data-hitl-attachment]`)}.map(li => li.getAttribute('data-hitl-attachment'))`);
  const chipText = async (scope) => evalJs(`${qa(`${scope} [data-hitl-attachment]`)}.map(li => li.textContent.replace(/\\s+/g, ' ').trim())`);
  const noticeOf = async (scope) => text(`${scope} [data-hitl-attach-error]`);
  async function pickFiles(scope, files) {
    const doc = await send("DOM.getDocument", { depth: 0 });
    const found = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: `${scope} [data-hitl-attach-input]` });
    if (!check(found.result?.nodeId, `file input in ${scope}`)) return;
    await send("DOM.setFileInputFiles", { nodeId: found.result.nodeId, files });
  }
  let shotIndex = 0;
  async function shot(name) {
    const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = `${String(++shotIndex).padStart(2, "0")}-${name}.png`;
    if (s.result?.data) fs.writeFileSync(path.join(SHOTS, file), Buffer.from(s.result.data, "base64"));
    return path.join(SHOTS, file);
  }
  const scrollTo = async (sel) => evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`);
  const scope = `#hitl-${CSS_escape(photoCard)}`;
  function CSS_escape(id) { return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1"); }

  // 1. The card at phone width.
  step = "open";
  await send("Page.navigate", { url: `${BASE}/inbox#${encodeURIComponent(photoCard)}` });
  await waitFor(`!!${q(`${scope} [data-hitl-attach-input]`)}`, "the photo card with its file input", 120_000);
  await sleep(800);
  await scrollTo(`${scope} textarea`);
  const viewport = await evalJs("JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })");
  check(JSON.parse(viewport).w === 390, `phone viewport (${viewport})`);
  check(await exists(`${scope} [data-hitl-attach-button]`), "the Photo button is on the card");
  check(await evalJs(`(() => { const b = ${q(`${scope} [data-hitl-attach-button]`)}; if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height >= 36 && r.right <= innerWidth; })()`), "the Photo button is visible and inside the phone viewport");
  const sendDisabled = await evalJs(`${qa(`${scope} button`)}.find(b => b.textContent.trim() === 'Send Answer')?.disabled`);
  check(sendDisabled === true, "Send is disabled with nothing to send");
  const firstShot = await shot("inbox-card-phone");
  note("card_visible", { viewport: JSON.parse(viewport), screenshot: path.basename(firstShot) });

  // Fixture files: a real PNG (the screenshot just taken), a PDF, a 26 MB
  // image, and text wearing a .png name.
  const photoPath = path.join(fixtures, "gmail-screenshot.png");
  fs.copyFileSync(firstShot, photoPath);
  const photoBytes = fs.readFileSync(photoPath);
  const pdfPath = path.join(fixtures, "notes.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.4\n% not a photo\n");
  const hugePath = path.join(fixtures, "huge.png");
  fs.writeFileSync(hugePath, Buffer.alloc(26 * 1024 * 1024));
  const fakePath = path.join(fixtures, "fake.png");
  fs.writeFileSync(fakePath, "this is not an image, whatever its name says\n");

  // 2. Pick the screenshot.
  step = "pick";
  await pickFiles(scope, [photoPath]);
  await waitFor(`${qa(`${scope} [data-hitl-attachment]`)}.length === 1`, "the photo chip");
  check(JSON.stringify(await chips(scope)) === JSON.stringify(["gmail-screenshot.png"]), `one chip named gmail-screenshot.png (${JSON.stringify(await chips(scope))})`);
  check(await evalJs(`(() => { const img = ${q(`${scope} [data-hitl-attachment] img`)}; return !!img && img.naturalWidth > 0; })()`), "the chip shows a decoded thumbnail");
  const chipLabel = (await chipText(scope))?.[0] ?? "";
  check(/gmail-screenshot\.png/.test(chipLabel) && /\d+(\.\d+)? (KB|MB|B)/.test(chipLabel), `the chip names the file and its size (${chipLabel})`);
  check(await evalJs(`${qa(`${scope} button`)}.find(b => b.textContent.trim() === 'Send Answer')?.disabled`) === false, "Send is enabled once a photo is attached");
  await scrollTo(`${scope} [data-hitl-attachments]`);
  note("photo_picked", { chip: chipLabel, screenshot: path.basename(await shot("photo-picked")) });

  // 3. Remove it, pick again, type the answer.
  step = "remove";
  await click(`${scope} button[aria-label="Remove gmail-screenshot.png"]`);
  await waitFor(`${qa(`${scope} [data-hitl-attachment]`)}.length === 0`, "the chip to go away");
  check(await evalJs(`${qa(`${scope} button`)}.find(b => b.textContent.trim() === 'Send Answer')?.disabled`) === true, "Send is disabled again after removing the only photo");
  note("photo_removed", { chips: await chips(scope), screenshot: path.basename(await shot("photo-removed")) });
  step = "compose";
  await pickFiles(scope, [photoPath]);
  await waitFor(`${qa(`${scope} [data-hitl-attachment]`)}.length === 1`, "the photo chip again");
  await typeInto(`${scope} textarea`, ANSWER);
  check((await value(`${scope} textarea`)) === ANSWER, "the typed answer is in the composer");
  await scrollTo(`${scope} textarea`);
  note("ready_to_send", { chips: await chips(scope), screenshot: path.basename(await shot("answer-and-photo-ready")) });

  // 4. Send.
  step = "send";
  const uploadsBefore = fs.readdirSync(chatFiles).length;
  await clickButton(scope, "Send Answer");
  await waitFor(`!${q(scope)} || !!${q(`${scope} [data-hitl-attach-error]`)}`, "the card to resolve", 60_000);
  check(!(await exists(`${scope} [data-hitl-attach-error]`)), `no error on the card (${await noticeOf(scope)})`);
  check(!(await exists(scope)), "the resolved card left the pending list");
  const stored = fs.readdirSync(chatFiles).filter((f) => !f.startsWith("."));
  check(stored.length === uploadsBefore + 1, `exactly one file landed in the isolated store (${stored.join(", ")})`);
  await shot("after-send");
  await send("Page.reload", { ignoreCache: false });
  // Resolved history sits behind the "Resolved · N" toggle, collapsed by default.
  const openHistory = async () => {
    await waitFor(`${qa("button")}.some(b => b.textContent.trim().startsWith('Resolved ·'))`, "the Resolved history toggle", 60_000);
    if (!(await exists("[data-hitl-history-photos] a"))) {
      await evalJs(`(() => { const b = ${qa("button")}.find(b => b.textContent.trim().startsWith('Resolved ·')); if (b) b.click(); return !!b; })()`);
    }
    await waitFor(`!!${q("[data-hitl-history-photos] a")}`, "the history link to the photo", 60_000);
  };
  await openHistory();
  const historyLink = await evalJs(`(() => { const a = ${q("[data-hitl-history-photos] a")}; return a ? { href: a.getAttribute('href'), text: a.textContent.trim(), target: a.target } : null; })()`);
  await scrollTo("[data-hitl-history-photos]");
  note("history_shows_photo", { link: historyLink, screenshot: path.basename(await shot("history-with-photo-link")) });

  // 5. What Praxis saved, what the follow-up saw, what the URL serves.
  step = "praxis";
  const saved = await (await fetch(`${FIXTURE}/__fixture/hitl/${encodeURIComponent(photoCard)}`)).json();
  const attachments = saved.resolution?.payload?.attachments ?? [];
  check(attachments.length === 1, `one attachment saved on the resolution (${JSON.stringify(attachments)})`);
  const ref = attachments[0] ?? {};
  check(/^[0-9a-f-]{36}$/.test(ref.fileId ?? ""), `the saved fileId is the upload id (${ref.fileId})`);
  check(ref.url === `/api/chat/files/${ref.fileId}` && ref.mimeType === "image/png" && ref.originalName === "gmail-screenshot.png" && ref.size === photoBytes.length, `the saved reference is rebuilt from the store (${JSON.stringify(ref)})`);
  check(saved.resolution?.resolvedBy === "robert", `operator identity kept (${saved.resolution?.resolvedBy})`);
  const localPath = path.join(chatFiles, `${ref.fileId}.png`);
  const freeText = saved.resolution?.freeText ?? "";
  check(freeText.startsWith(ANSWER), "the saved text starts with the typed answer");
  check(freeText.includes(`Attached photo (1):`) && freeText.includes(`file ${localPath}`) && freeText.includes(`url ${API}/api/chat/files/${ref.fileId}`), `the saved text carries the note with the local file and the Nexus URL:\n${freeText}`);
  check(historyLink?.href === ref.url, `the history link targets the saved URL (${historyLink?.href})`);
  const served = await fetch(`${API}${ref.url}`);
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check(served.status === 200 && served.headers.get("content-type") === "image/png", `the Nexus API serves the photo (${served.status} ${served.headers.get("content-type")})`);
  check(sha256(servedBytes) === sha256(photoBytes), "served bytes equal the picked file");
  check(fs.existsSync(localPath) && sha256(fs.readFileSync(localPath)) === sha256(photoBytes), "the local file named in the note equals the picked file");
  const proxied = await (await fetch(`${API}/api/praxis/hitl/${encodeURIComponent(photoCard)}`)).json();
  check(JSON.stringify(proxied.resolution?.payload?.attachments) === JSON.stringify(attachments), "the resolution read back through the Nexus proxy carries the same reference");
  let state = await (await fetch(`${FIXTURE}/__fixture/state`)).json();
  const followUps = state.prompts.filter((p) => p.prompt.includes(photoCard));
  check(followUps.length === 1, `exactly one follow-up prompt for the photo card (${followUps.length})`);
  const prompt = followUps[0]?.prompt ?? "";
  check(prompt.includes(`Nexus Task ID: \`${TASK_ID}\``), "the follow-up names the task");
  check(prompt.includes(SUBJECT), "the follow-up names the question subject");
  check(prompt.includes(`url ${API}/api/chat/files/${ref.fileId}`) && prompt.includes(`file ${localPath}`), "the follow-up carries the photo URL and local file");
  check(prompt.includes(ANSWER), "the follow-up carries the typed answer");
  const query = state.queries.find((item) => item.id === photoCard);
  check(query?.status === "answered" && String(query?.answers?.answers?.q1 ?? "").includes("Attached photo (1)"), `the human query is answered with the note on q1 (${query?.status})`);
  // A repeated submit (double tap, retry) goes through the Nexus guard again and delivers nothing twice.
  const again = await fetch(`${API}/api/praxis/hitl/${encodeURIComponent(photoCard)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ freeText: ANSWER, payload: { attachments: [ref] } }) });
  await sleep(500);
  state = await (await fetch(`${FIXTURE}/__fixture/state`)).json();
  check(again.status === 200 && state.prompts.filter((p) => p.prompt.includes(photoCard)).length === 1, `a repeated submit is accepted without a second follow-up (${again.status})`);
  note("praxis_saved", { fileId: ref.fileId, freeText, followUpChars: prompt.length, sha256: sha256(photoBytes) });
  fs.writeFileSync(path.join(OUT, "follow-up-prompt.txt"), prompt);
  fs.writeFileSync(path.join(OUT, "saved-resolution.json"), JSON.stringify({ request: saved, humanQuery: query }, null, 2));

  // 6. Refusals in the browser, answer kept.
  step = "refuse";
  const scope2 = `#hitl-${CSS_escape(textCard)}`;
  await send("Page.navigate", { url: `${BASE}/inbox#${encodeURIComponent(textCard)}` });
  await waitFor(`!!${q(`${scope2} [data-hitl-attach-input]`)}`, "the text card", 60_000);
  await sleep(500);
  await typeInto(`${scope2} textarea`, "The second one.");
  await pickFiles(scope2, [pdfPath]);
  await waitFor(`!!${q(`${scope2} [data-hitl-attach-error]`)}`, "the PDF refusal");
  const pdfNotice = await noticeOf(scope2);
  check(/"notes\.pdf" is not a photo or screenshot/.test(pdfNotice ?? ""), `the PDF is refused in words (${pdfNotice})`);
  check(JSON.stringify(await chips(scope2)) === "[]", "no chip for the PDF");
  await scrollTo(`${scope2} [data-hitl-attach-error]`);
  await shot("refused-pdf");
  await pickFiles(scope2, [hugePath]);
  await waitFor(`(${q(`${scope2} [data-hitl-attach-error]`)}?.textContent || '').includes('26.0 MB')`, "the oversized refusal");
  const hugeNotice = await noticeOf(scope2);
  check(/"huge\.png" is 26\.0 MB; photos up to 25\.0 MB can be attached/.test(hugeNotice ?? ""), `the 26 MB file is refused in words (${hugeNotice})`);
  check((await value(`${scope2} textarea`)) === "The second one.", "the typed answer survived both refusals");
  check(fs.readdirSync(chatFiles).filter((f) => !f.startsWith(".")).length === stored.length, "refused files never reached the store");
  note("client_refusals", { pdf: pdfNotice, oversized: hugeNotice, screenshot: path.basename(await shot("refused-oversized")) });

  // 7. The server-side guard: text named .png uploads but is refused as an attachment.
  step = "guard";
  await pickFiles(scope2, [fakePath]);
  await waitFor(`${qa(`${scope2} [data-hitl-attachment]`)}.length === 1`, "the fake.png chip");
  await clickButton(scope2, "Send Answer");
  await waitFor(`(${q(`${scope2} [data-hitl-attach-error]`)}?.textContent || '').includes('not sent')`, "the guard refusal on the card", 60_000);
  const guardNotice = await noticeOf(scope2);
  check(/Your answer was not sent \(The attached file is not a readable image\)\. It is still here; try again\./.test(guardNotice ?? ""), `the Nexus guard refusal is shown in words (${guardNotice})`);
  check((await value(`${scope2} textarea`)) === "The second one.", "the typed answer is still on the card after the 400");
  check(JSON.stringify(await chips(scope2)) === JSON.stringify(["fake.png"]), "the refused chip is still on the card to remove");
  check(await exists(scope2), "the card is still pending in the list");
  const stillPending = await (await fetch(`${FIXTURE}/__fixture/hitl/${encodeURIComponent(textCard)}`)).json();
  check(!stillPending.resolution, "Praxis has no resolution for the card");
  await scrollTo(`${scope2} [data-hitl-attach-error]`);
  note("server_guard", { notice: guardNotice, screenshot: path.basename(await shot("guard-refused-kept-answer")) });
  // Remove the bad file and send the text alone.
  step = "text_only";
  await click(`${scope2} button[aria-label="Remove fake.png"]`);
  await waitFor(`${qa(`${scope2} [data-hitl-attachment]`)}.length === 0`, "the fake chip to go away");
  await clickButton(scope2, "Send Answer");
  await waitFor(`!${q(scope2)}`, "the text card to resolve", 60_000);
  const textSaved = await (await fetch(`${FIXTURE}/__fixture/hitl/${encodeURIComponent(textCard)}`)).json();
  check(textSaved.resolution?.freeText === "The second one." && !("payload" in (textSaved.resolution ?? {})), `text-only answer saved unchanged (${JSON.stringify(textSaved.resolution)})`);
  state = await (await fetch(`${FIXTURE}/__fixture/state`)).json();
  const textFollowUps = state.prompts.filter((p) => p.prompt.includes(textCard));
  check(textFollowUps.length === 1 && !textFollowUps[0].prompt.includes("Attached photo"), "one follow-up without any attachment note");
  note("text_only_sent", { resolution: textSaved.resolution, screenshot: path.basename(await shot("text-only-sent")) });

  // 8. A choice card.
  step = "choice";
  const scope3 = `#hitl-${CSS_escape(choiceCard)}`;
  await send("Page.navigate", { url: `${BASE}/inbox#${encodeURIComponent(choiceCard)}` });
  await waitFor(`!!${q(`${scope3} textarea`)}`, "the choice card", 60_000);
  await sleep(500);
  await scrollTo(`${scope3} textarea`);
  await shot("choice-card");
  await clickButton(scope3, "approve");
  await waitFor(`!${q(scope3)}`, "the choice card to resolve", 60_000);
  const choiceSaved = await (await fetch(`${FIXTURE}/__fixture/hitl/${encodeURIComponent(choiceCard)}`)).json();
  check(choiceSaved.resolution?.choice === "approve" && !("payload" in (choiceSaved.resolution ?? {})), `choice saved unchanged (${JSON.stringify(choiceSaved.resolution)})`);
  state = await (await fetch(`${FIXTURE}/__fixture/state`)).json();
  check(state.prompts.filter((p) => p.prompt.includes(choiceCard)).length === 1, "one resume prompt for the choice card");
  note("choice_sent", { resolution: choiceSaved.resolution, screenshot: path.basename(await shot("choice-sent")) });

  // One desktop frame of the same inbox, for scale.
  step = "desktop";
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/inbox` });
  await openHistory();
  await scrollTo("[data-hitl-history-photos]");
  note("desktop_frame", { screenshot: path.basename(await shot("desktop-history")) });
  await phone();

  // 9. Isolation.
  step = "isolation";
  const liveStoreAfter = fs.readdirSync(LIVE_CHAT_FILES).sort();
  check(JSON.stringify(liveStoreAfter) === JSON.stringify(liveStoreBefore), "the live data/chat-files store is untouched");
  const livePending = await (await fetch(`${FIXTURE}/hitl/pending`)).json();
  check(!(livePending.requests ?? []).some((r) => r.id === photoCard || r.id === textCard || r.id === choiceCard), "every fixture card is resolved");
  const uploads = apiCalls.filter((c) => c.path === "/api/chat/files/upload");
  // Two uploads in the whole run: the photo (picked twice, sent once) and
  // fake.png; the PDF and the 26 MB file were refused before any request.
  check(uploads.length === 2, `the page uploaded through /api/chat/files/upload exactly twice (${uploads.length})`);
  report.apiCalls = apiCalls;
  report.exceptions = exceptions;
  check(exceptions.length === 0, `no page exceptions (${exceptions.join(" | ")})`);
  note("isolation", { liveStoreFiles: liveStoreBefore.length, uploads: uploads.length });
} catch (error) {
  fail(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  try { ws?.close(); } catch { /* closing */ }
  chrome?.kill("SIGTERM");
  for (const { child } of children.reverse()) child.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  for (const { child } of children) {
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  fs.writeFileSync(tsconfigPath, tsconfigBefore);
  if (nextEnvBefore) fs.writeFileSync(nextEnvPath, nextEnvBefore);
  for (const [name, content] of Object.entries(logs)) fs.writeFileSync(path.join(tmp, `${name}-output.txt`), content);
  report.ok = report.failures.length === 0;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(report.ok ? `CHECK_RESULT ok (${report.steps.length} steps, screenshots in ${SHOTS})` : `CHECK_RESULT FAIL\n${report.failures.join("\n")}\n(stack output kept in ${tmp})`);
  if (report.ok && !KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(report.ok ? 0 : 1);
}
