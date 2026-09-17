// READ-ONLY look at the live cockpit (http://localhost:3000, the origin the
// Mac bridge app loads): how the transcript renders the report link Praxis
// posted, and how the source task page links the report. Navigates and reads
// the DOM only — nothing is typed, clicked, opened or sent (opening the
// navigation menu is UI state, no request). Exits non-zero when an entry is
// missing, an href is not the in-app reviewer path, or a link would open a new
// window — so a regression fails the check instead of hiding in the log.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.NEXUS_LIVE_BASE || "http://localhost:3000";
const DOC = process.env.NEXUS_LIVE_DOC || "bb977fdf-5496-48bb-98bb-031421cc9c1a";
const TASK = process.env.NEXUS_LIVE_TASK || "6f6017f3-a752-417f-a3a7-28602892c4f2";
const OUT = process.env.NEXUS_LIVE_SHOTS || null;
if (OUT) mkdirSync(OUT, { recursive: true });
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9334 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "nexus-live-link-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
let version = null;
for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => { if (!OUT) return; const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, "base64")); };
const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return true; await sleep(300); } return false; };
const REVIEWER_PATH = `/documents/${DOC}`;
const inApp = (link) => link.href === REVIEWER_PATH && link.target === null;
const observed = {};
const findLinks = `(() => [...document.querySelectorAll('a')].filter(a => (a.getAttribute('href') || '').includes(${JSON.stringify(DOC)})).map(a => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent.trim().slice(0, 80), inTranscript: !!a.closest('[data-message-row], [data-transcript], article, main') })))()`;
try {
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/` });
  const found = await waitFor(`${findLinks}.length > 0`, 45000);
  observed.bridge = { origin: await evalJs("location.origin"), found, links: await evalJs(findLinks) };
  console.log("LIVE_BRIDGE", JSON.stringify(observed.bridge));
  await shot("live-1440-chat-link");
  // The navigation menu is UI state only (no request is made by opening it).
  await evalJs("document.querySelector('button[aria-label=\"Open navigation menu\"]')?.click()");
  const menu = await waitFor("!!document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]')", 10000);
  observed.menu = { found: menu, entry: await evalJs("document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]')?.textContent.trim() ?? null") };
  console.log("LIVE_MENU", JSON.stringify(observed.menu));
  await sleep(900);
  await shot("live-1440-menu");
  await evalJs("document.querySelector('[role=\"dialog\"] button')?.click()");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: `${BASE}/` });
  const foundPhone = await waitFor(`${findLinks}.length > 0`, 45000);
  observed.bridgePhone = { found: foundPhone, links: await evalJs(findLinks) };
  console.log("LIVE_BRIDGE_390", JSON.stringify(observed.bridgePhone));
  await shot("live-390-chat-link");
  await evalJs("document.querySelector('button[aria-label=\"Open navigation menu\"]')?.click()");
  const menuPhone = await waitFor("!!document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]')", 10000);
  await sleep(900);
  observed.menuPhone = { found: menuPhone, entry: await evalJs("document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]')?.textContent.trim() ?? null"), visible: await evalJs("(() => { const a = document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]'); if (!a) return false; const r = a.getBoundingClientRect(); return r.width > 0 && r.x >= 0 && r.x < window.innerWidth; })()") };
  console.log("LIVE_MENU_390", JSON.stringify(observed.menuPhone));
  await shot("live-390-menu");
  await evalJs("document.querySelector('[role=\"dialog\"] button')?.click()");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/task/${TASK}` });
  const panel = await waitFor("!!document.querySelector('[data-review-documents-panel] a')", 45000);
  observed.taskPanel = { found: panel, links: await evalJs("[...document.querySelectorAll('[data-review-documents-panel] a')].map(a => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent.trim() }))") };
  console.log("LIVE_TASK_PANEL", JSON.stringify(observed.taskPanel));
  await shot("live-1440-task-panel");
  await send("Page.navigate", { url: `${BASE}/documents` });
  const index = await waitFor(`!!document.querySelector('[data-documents-index] [data-document-id=${JSON.stringify(DOC)}]')`, 45000);
  observed.index = { found: index, row: await evalJs(`(() => { const li = document.querySelector('[data-document-id=${JSON.stringify(DOC)}]'); if (!li) return null; const a = li.querySelector('a[data-review-link]'); return { title: li.querySelector('a').textContent.trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), label: a.textContent.trim(), text: li.textContent.replace(/\\s+/g, ' ').slice(0, 300) }; })()`) };
  console.log("LIVE_INDEX", JSON.stringify(observed.index));
  await shot("live-1440-index");

  // ── Assertions: every route into the report stays in the Dashboard's session ──
  assert.equal(observed.bridge.found, true, `no transcript link to ${DOC} on the loaded bridge (message not in the loaded conversation?)`);
  assert.ok(observed.bridge.links.every(inApp), `desktop transcript link(s) not in-app: ${JSON.stringify(observed.bridge.links)}`);
  assert.equal(observed.bridgePhone.found, true, `no transcript link to ${DOC} at 390px`);
  assert.ok(observed.bridgePhone.links.every(inApp), `phone transcript link(s) not in-app: ${JSON.stringify(observed.bridgePhone.links)}`);
  assert.equal(observed.menu.found, true, "Documents entry missing from the desktop navigation menu");
  assert.match(observed.menu.entry ?? "", /Documents/, `unexpected menu entry label: ${observed.menu.entry}`);
  assert.equal(observed.menuPhone.found, true, "Documents entry missing from the phone navigation menu");
  assert.equal(observed.menuPhone.visible, true, "Documents entry is off-screen at 390px");
  assert.equal(observed.taskPanel.found, true, `task ${TASK} shows no Documents-for-review panel link`);
  assert.ok(observed.taskPanel.links.some(inApp), `task panel has no in-app link to ${DOC}: ${JSON.stringify(observed.taskPanel.links)}`);
  assert.ok(observed.taskPanel.links.every((l) => l.target === null), "a task panel link would open a new window");
  assert.equal(observed.index.found, true, `/documents does not list ${DOC}`);
  assert.equal(observed.index.row?.href, REVIEWER_PATH, `index row href is ${observed.index.row?.href}`);
  assert.equal(observed.index.row?.target, null, "index row link would open a new window");
  console.log("LIVE_LINK_CHECK_OK");
} finally {
  ws.close(); chrome.kill();
}
