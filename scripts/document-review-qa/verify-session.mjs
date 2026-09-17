// Chrome (CDP) check that document reviews are reachable INSIDE the Dashboard's
// own session on the ISOLATED stack (dashboard :3100 → API :4100, temp DB):
// menu → Documents → the report → refresh → back, at 1440px and 390px, with a
// marker on `window` proving every hop is a client-side navigation on the same
// origin (no new window, no reload, so no second sign-in). Read-only: it never
// opens a draft, comments or finishes a review, so verify.mjs can run after it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3100";
const API = "http://127.0.0.1:4100";
const QA_DIR = process.env.NEXUS_REVIEW_QA_DIR;
if (!QA_DIR) throw new Error("Set NEXUS_REVIEW_QA_DIR to the fixture API's directory (see README.md)");
const OUT = join(QA_DIR, "shots-session");
const isolation = await (await fetch(`${API}/__qa`)).json();
assert.equal(isolation.qaDirectory, QA_DIR, "refuse to drive a non-fixture API");
mkdirSync(OUT, { recursive: true });
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docs = await (await fetch(`${API}/api/documents?task_id=44444444-4444-4444-8444-444444444444`)).json();
const docId = docs.documents[0].id;
assert.ok(docId, "isolated report was registered");
console.log("DOC", docId);

// Warm the dev server's compiles so page waits measure navigation, not turbopack.
for (const path of ["/", "/documents", `/documents/${docId}`]) {
  const res = await fetch(`${BASE}${path}`);
  console.log("WARM", path, res.status);
  assert.equal(res.status, 200, `direct GET ${path} must be served by the dashboard`);
}

const port = 9334 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "nexus-verify-session-"));
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
const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return true; await sleep(250); } return false; };
const MARKER = `nexus-session-${Date.now()}`;
const state = () => evalJs(`({ path: location.pathname, origin: location.origin, marker: window.__nexusSessionMarker || null, windows: window.__nexusOpenCalls || 0 })`);
const summary = {};
try {
  for (const view of [{ name: "1440", width: 1440, height: 900, mobile: false }, { name: "390", width: 390, height: 844, mobile: true }]) {
    await send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile });
    const r = (summary[view.name] = {});

    // 1. The bridge home, the page Robert's Mac app and phone shell open on.
    await send("Page.navigate", { url: `${BASE}/` });
    assert.ok(await waitFor("!!document.querySelector('button[aria-label=\"Open navigation menu\"]')"), "bridge header rendered");
    await evalJs(`window.__nexusSessionMarker = ${JSON.stringify(MARKER)}; window.__nexusOpenCalls = 0; window.open = () => { window.__nexusOpenCalls += 1; return null; };`);

    // 2. Menu → Documents entry.
    await evalJs("document.querySelector('button[aria-label=\"Open navigation menu\"]').click()");
    assert.ok(await waitFor("!!document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]')", 10000), "Documents entry visible in the menu");
    r.menuEntry = await evalJs("document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]').textContent.trim()");
    await sleep(400);
    await shot(`${view.name}-menu`);
    await evalJs("document.querySelector('[role=\"dialog\"] a[href=\"/documents\"]').click()");
    assert.ok(await waitFor("!!document.querySelector('[data-documents-index]') && location.pathname === '/documents'"), "index reached from the menu");
    assert.ok(await waitFor(`!!document.querySelector('[data-documents-index] [data-document-id="${docId}"]')`), "the isolated report is listed");
    r.index = await state();
    r.indexRow = await evalJs(`(() => { const li = document.querySelector('[data-document-id="${docId}"]'); const a = li.querySelector('a[data-review-link]'); return { title: li.querySelector('a').textContent.trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), label: a.textContent.trim(), state: (li.textContent.match(/Not reviewed yet|Draft[^·]*·[^c]*comments?|Review sent to Praxis|Review finished[^R]*/) || [""])[0].trim() }; })()`);
    await shot(`${view.name}-index`);

    // 3. Index → the report in the shared reviewer.
    await evalJs(`document.querySelector('[data-document-id="${docId}"] a[data-review-link]').click()`);
    assert.ok(await waitFor(`!!document.querySelector('[data-document-review-page] [data-document-markdown]') && location.pathname === '/documents/${docId}'`), "reviewer reached from the index");
    await sleep(500);
    r.reviewer = await state();
    r.reviewerTitle = await evalJs("document.querySelector('[data-document-review-page] h1')?.textContent.trim()");
    r.reviewerCrumb = await evalJs("(() => { const a = document.querySelector('[data-all-documents-link]'); return a ? { href: a.getAttribute('href'), visible: a.getBoundingClientRect().width > 0 } : null; })()");
    r.scrollWidth = await evalJs("({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })");
    await shot(`${view.name}-reviewer`);

    // 4. Refresh keeps the page (a fresh document, same origin, still served).
    await send("Page.reload");
    await sleep(300);
    assert.ok(await waitFor(`!!document.querySelector('[data-document-review-page] [data-document-markdown]') && location.pathname === '/documents/${docId}'`), "reviewer survives a refresh");
    r.afterRefresh = await state();
    r.afterRefresh.navigationStatus = await evalJs("performance.getEntriesByType('navigation')[0]?.responseStatus ?? null");
    r.afterRefresh.title = await evalJs("document.querySelector('[data-document-review-page] h1')?.textContent.trim()");
    // The reload made a fresh document; re-mark it so the hops below prove they are client-side too.
    await evalJs(`window.__nexusSessionMarker = ${JSON.stringify(MARKER)}; window.__nexusOpenCalls = 0; window.open = () => { window.__nexusOpenCalls += 1; return null; };`);

    // 5. The reviewer's Documents crumb, then browser back twice: index → bridge.
    await evalJs("document.querySelector('[data-all-documents-link]').click()");
    assert.ok(await waitFor("!!document.querySelector('[data-documents-index]') && location.pathname === '/documents'"), "crumb returns to the index");
    await evalJs(`document.querySelector('[data-document-id="${docId}"] a[data-review-link]').click()`);
    assert.ok(await waitFor(`location.pathname === '/documents/${docId}' && !!document.querySelector('[data-document-markdown]')`), "reviewer again");
    await evalJs("history.back()");
    assert.ok(await waitFor("location.pathname === '/documents' && !!document.querySelector('[data-documents-index]')", 15000), "back → index");
    r.backToIndex = await state();
    await evalJs("history.back()");
    assert.ok(await waitFor(`location.pathname === '/documents/${docId}'`, 15000), "back → reviewer (crumb hop)");
    await evalJs("history.back()"); await evalJs("history.back()");
    assert.ok(await waitFor("location.pathname === '/' && !!document.querySelector('button[aria-label=\"Open navigation menu\"]')", 20000), "back → bridge");
    r.backToBridge = await state();

  }
  console.log("SESSION_SUMMARY", JSON.stringify(summary, null, 2));
  for (const [name, r] of Object.entries(summary)) {
    assert.equal(r.index.marker, MARKER, `${name}: menu → index was a client-side navigation`);
    assert.equal(r.reviewer.marker, MARKER, `${name}: index → reviewer was a client-side navigation`);
    assert.equal(r.reviewer.origin, BASE, `${name}: reviewer stayed on the dashboard origin`);
    assert.equal(r.reviewer.windows, 0, `${name}: no window.open along the way`);
    assert.equal(r.indexRow.target, null, `${name}: index link is not a new-window link`);
    assert.equal(r.afterRefresh.path, `/documents/${docId}`, `${name}: refresh kept the reviewer`);
    assert.equal(r.backToIndex.marker, MARKER, `${name}: crumb and back were client-side hops`);
    assert.equal(r.backToBridge.marker, MARKER, `${name}: back reached the bridge without a reload`);
    assert.equal(r.backToBridge.path, "/", `${name}: back reached the bridge`);
    assert.equal(r.afterRefresh.navigationStatus, 200, `${name}: refresh was served`);
    assert.match(r.reviewerTitle, /Isolated reliability report/, `${name}: the report rendered through the /api proxy`);
    assert.equal(r.reviewerCrumb?.href, "/documents", `${name}: reviewer links to the index`);
  }
  console.log("SESSION_OK");
} finally {
  ws.close(); chrome.kill();
}
