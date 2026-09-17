// Chrome (CDP) verification of the QA repair on the ISOLATED stack:
// dashboard :3100 → API :4100 (temp DB) → Praxis stand-in :4199.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3100";
const API = "http://127.0.0.1:4100";
const QA_DIR = process.env.NEXUS_REVIEW_QA_DIR;
if (!QA_DIR) throw new Error("Set NEXUS_REVIEW_QA_DIR to a fresh temporary directory (see README.md)");
const OUT = join(QA_DIR, "shots");
const isolation = await (await fetch(`${API}/__qa`)).json();
assert.equal(isolation.qaDirectory, QA_DIR, "refuse to write through a non-fixture API");
mkdirSync(OUT, { recursive: true });
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docs = await (await fetch(`${API}/api/documents?task_id=44444444-4444-4444-8444-444444444444`)).json();
const docId = docs.documents[0].id;
assert.ok(docId, "isolated report was registered");
console.log("DOC", docId);

const port = 9334 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "nexus-verify-"));
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
const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, "base64")); };
const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return true; await sleep(300); } return false; };
const clickText = async (scope, text) => evalJs(`(() => { const b = [...document.querySelectorAll('${scope} button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
const realClick = async (selector, text) => {
  const rect = await evalJs(`(() => { const b = [...document.querySelectorAll('${selector} button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!rect) return null;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  return rect;
};
const cardText = () => evalJs("document.querySelector('[data-submission-card]')?.textContent || ''");
let receiver = null;
try {
  // ── Phone: whole-document note through the visible controls ──
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: `${BASE}/documents/${docId}` });
  await waitFor("!!document.querySelector('[data-document-markdown]')");
  await sleep(500);
  console.log("PHONE_PAGE", await evalJs("({title:document.querySelector('h1')?.textContent, width:document.documentElement.clientWidth, scroll:document.documentElement.scrollWidth, tables:document.querySelectorAll('[data-document-markdown] table').length})"));
  await shot("390");
  await evalJs("document.querySelector('[data-open-review]').click()"); await sleep(300);
  console.log("DRAWER_OPEN", await evalJs("!!document.querySelector('[data-review-drawer]')"));
  await clickText("[data-review-drawer]", "Add a note about the whole document"); await sleep(400);
  console.log("MOBILE_NOTE", await evalJs("(()=>{const t=document.querySelector('[data-composer-sheet] textarea');if(!t)return {composerExists:false};const r=t.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {composerExists:true,hitIsTextarea:hit===t,hitTag:hit?.tagName,hitInReviewDrawer:!!hit?.closest('[data-review-drawer]'),reviewDrawerStillOpen:!!document.querySelector('[data-review-drawer]'),textareaFocused:document.activeElement===t}})()"));
  await shot("390-note");
  await evalJs("document.querySelector('[data-composer-sheet] textarea').focus()");
  await send("Input.insertText", { text: "Isolated phone note: the composer is reachable and saves." });
  await sleep(200);
  console.log("TYPED", await evalJs("document.querySelector('[data-composer-sheet] textarea').value"));
  const saveRect = await realClick("[data-composer-sheet]", "Save comment");
  console.log("SAVE_TAP", saveRect);
  await sleep(1200);
  console.log("MOBILE_SAVED", await evalJs("(()=>({sheetGone:!document.querySelector('[data-composer-sheet]'),drawerOpen:!!document.querySelector('[data-review-drawer]'),noteListed:/Isolated phone note/.test(document.querySelector('[data-review-drawer] [data-comment-list]')?.textContent||''),header:(document.querySelector('[data-review-drawer]')?.textContent.match(/Comments \\(\\d+\\)/)||[])[0],saved:/Saved/.test(document.querySelector('[data-review-drawer]')?.textContent||'')}))()"));
  await shot("390-saved");

  // ── Desktop: finish, outage, automatic retry observed without reload ──
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/documents/${docId}` });
  await waitFor("!!document.querySelector('[data-comment-list]') && /Isolated phone note/.test(document.querySelector('[data-comment-list]').textContent)");
  console.log("DESKTOP_DRAFT_RESUMED", await evalJs("/Isolated phone note/.test(document.querySelector('[data-comment-list]').textContent)"));
  await clickText("[data-review-panel]", "Finish review"); await sleep(300);
  await evalJs("(()=>{const t=document.querySelector('[data-finish-panel] textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,'Isolated summary.'); t.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await sleep(300);
  const before = (await (await fetch(`${API}/__log`)).json()).length;
  await clickText("[data-finish-panel]", "Send to Praxis");
  await waitFor("/retry scheduled/.test(document.querySelector('[data-submission-card]')?.textContent||'')", 15000);
  console.log("FAILED_STATE", (await cardText()).replace(/\s+/g, " ").slice(0, 400));
  await shot("1440-failed");
  receiver = spawn("node", [fileURLToPath(new URL("./receiver.cjs", import.meta.url))], { stdio: "ignore" });
  const delivered = await waitFor("/Delivered to Praxis/.test(document.querySelector('[data-submission-card]')?.textContent||'')", 30000);
  console.log("DELIVERED_WITHOUT_RELOAD", delivered);
  assert.equal(delivered, true);
  console.log("DELIVERED_STATE", (await cardText()).replace(/\s+/g, " ").slice(0, 400));
  await shot("1440-delivered");
  const log = (await (await fetch(`${API}/__log`)).json()).slice(before);
  const counts = { finish: log.filter((e) => new URL(e.url, API).pathname.endsWith("/finish")).length, submissionPolls: log.filter((e) => new URL(e.url, API).pathname.endsWith("/submission")).length, retries: log.filter((e) => new URL(e.url, API).pathname.endsWith("/submission/retry")).length };
  console.log("API_CALLS_SINCE_FINISH", counts);
  assert.equal(counts.finish, 1);
  assert.ok(counts.submissionPolls > 0, "cache-busted submission polls must be counted");
  console.log("RECEIVER", await (await fetch("http://127.0.0.1:4199/__state")).json());
  const sub = await (await fetch(`${API}/api/documents/${docId}`)).json();
  console.log("SERVER_SUBMISSION", { status: sub.review.status, delivery: sub.review.submission.delivery_status, attempts: sub.review.submission.delivery_attempts, receipt: sub.review.submission.receipt });

  // ── Phone again: the delivered state persists on reload ──
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: `${BASE}/documents/${docId}` });
  await waitFor("!!document.querySelector('[data-document-markdown]')");
  await evalJs("document.querySelector('[data-open-review]').click()"); await sleep(400);
  console.log("PHONE_AFTER", await evalJs("(()=>({delivered:/Delivered to Praxis/.test(document.querySelector('[data-review-drawer]')?.textContent||''),finished:/Finished/.test(document.querySelector('[data-review-drawer]')?.textContent||''),scroll:document.documentElement.scrollWidth}))()"));
  await shot("390-delivered");
} finally {
  ws.close(); chrome.kill(); if (receiver) receiver.kill();
}
