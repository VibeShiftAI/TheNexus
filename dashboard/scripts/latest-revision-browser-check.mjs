#!/usr/bin/env node
/**
 * Real-browser check that both ways into a document, the bridge's "Ready for
 * your review" row and a task's Deliverables row, open the latest registered
 * revision after the reader finished a review of an earlier one (task
 * b07f64ad, 2026-10-04). It runs entirely on an isolated stack and leaves
 * nothing running:
 *
 *   - the throwaway API of scripts/decision-session-check-api.cjs (temporary
 *     SQLite, synthetic Praxis receiver, one synthetic brief registered as a
 *     review-required deliverable of a synthetic task);
 *   - `next start` of a separate dist dir built against that API;
 *   - headless Chrome over the DevTools protocol.
 *
 * Flow: review rev 1 in the page (one passage comment, Finish review), then
 * the producer edits the file and re-registers it (same path, same task, so
 * the same document id gets rev 2). Open it from Ready for your review, check
 * the latest bytes and revision identity, the explicit reviewed revision, a
 * typed decision note surviving the switch (never submitted), then go to the
 * task, register rev 3, open it from the task's Deliverables, and go back and
 * forward after rev 4 is registered. No decision is recorded anywhere.
 *
 *   NEXT_DIST_DIR=.next-b07f64ad NEXT_PUBLIC_API_URL=http://127.0.0.1:4399 npm run build
 *   CHECK_DIST=.next-b07f64ad node scripts/latest-revision-browser-check.mjs
 *
 * Env: CHECK_DIST (required: the dist dir built above), CHECK_API_PORT (4399,
 * must match the build), CHECK_PRAXIS_PORT (4398), CHECK_WEB_PORT (3399),
 * CHECK_OUT (a fresh temp dir), CHECK_CHROME. Writes <out>/<step>.png and
 * <out>/report.json; exits 1 on any failed check.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const DIST = process.env.CHECK_DIST;
if (!DIST || !existsSync(join(DASHBOARD, DIST))) { console.error("CHECK_DIST=<dist dir built against the check API> is required."); process.exit(2); }
const API_PORT = Number(process.env.CHECK_API_PORT || 4399);
const PRAXIS_PORT = Number(process.env.CHECK_PRAXIS_PORT || 4398);
const WEB_PORT = Number(process.env.CHECK_WEB_PORT || 3399);
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const OUT = resolve(process.env.CHECK_OUT || mkdtempSync(join(tmpdir(), "nexus-latest-revision-check-")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const stopAll = () => { for (const child of children) { try { child.kill("SIGTERM"); } catch { /* already gone */ } } };
process.on("exit", stopAll);

const failures = [];
const passes = [];
const steps = [];
let step = "start";
const check = (ok, message) => {
    (ok ? passes : failures).push(`${step}: ${message}`);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${step}: ${message}`);
    return ok;
};

// 1. The isolated API (it prints CHECK_* lines once the synthetic brief is registered).
const api = spawn(process.execPath, [join(DASHBOARD, "scripts", "decision-session-check-api.cjs")], {
    cwd: DASHBOARD, env: { ...process.env, CHECK_API_PORT: String(API_PORT), CHECK_PRAXIS_PORT: String(PRAXIS_PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
children.push(api);
const fixture = await new Promise((resolveFixture, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the check API did not report ready:\n${out}`)), 60_000);
    api.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("CHECK_READY=1")) {
            clearTimeout(timer);
            resolveFixture(Object.fromEntries([...out.matchAll(/^(CHECK_[A-Z]+)=(\S+)/gm)].map((m) => [m[1], m[2]])));
        }
    });
    api.stderr.on("data", () => { /* boot diagnostics */ });
    api.on("exit", (code) => reject(new Error(`the check API exited (${code}):\n${out}`)));
});
const DOC = fixture.CHECK_DOC;
const FILE = fixture.CHECK_FILE;
const apiJson = async (path, init) => (await fetch(`${API}${path}`, init)).json();
const registered = (await apiJson(`/api/documents/${DOC}`)).document;
/** The producer's edit plus its re-registration: same path, same task, so the same document id gets a new revision. */
async function registerRevision(line) {
    appendFileSync(FILE, `\n${line}\n`);
    const res = await fetch(`${API}/api/documents`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
            path: FILE, title: registered.title, project_id: registered.project_id, task_id: registered.task_id, kind: registered.kind,
            deliverable: { requires_review: registered.requires_review, purpose: registered.purpose, intended_action: registered.intended_action },
        }),
    });
    const body = await res.json();
    check(res.status === 200 && body.document?.id === DOC, `re-registration kept document ${DOC.slice(0, 8)} (no duplicate): ${res.status}`);
    return body.revision;
}

// 2. The dashboard, from the dist dir built against that API.
const web = spawn(process.execPath, [join(DASHBOARD, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(WEB_PORT)], {
    cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: DIST }, stdio: "ignore",
});
children.push(web);
for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/documents`)).ok) break; } catch { /* not up yet */ }
    await sleep(500);
}

// 3. Headless Chrome.
const debugPort = 9800 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), "nexus-latest-revision-profile-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
children.push(chrome);
let version = null;
for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(200); }
}
if (!version) { console.error("Chrome did not expose its debugging port."); process.exit(2); }
const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const writes = [];
const exceptions = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent" && m.params.request.method !== "GET" && m.params.request.url.includes("/api/documents")) {
        writes.push({ step, method: m.params.request.method, path: new URL(m.params.request.url).pathname });
    }
    if (m.method === "Runtime.exceptionThrown") exceptions.push(`${step}: ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) || m.params.exceptionDetails?.text}`);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(expression, label, timeoutMs = 20_000) {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
        if (await evalJs(expression)) return true;
        await sleep(250);
    }
    return check(false, `timed out waiting for ${label}`);
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const text = (sel) => evalJs(`${q(sel)}?.textContent ?? null`);
const click = async (sel) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`), `clicked ${sel}`);
const clickButton = async (label) => check(await evalJs(`(() => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!el) return false; el.click(); return true; })()`), `clicked "${label}"`);
const typeInto = async (sel, value) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), `typed into ${sel}`);
const headerRev = () => evalJs(`(document.querySelector('header')?.textContent.match(/rev ([0-9a-f]{8})/) || [])[1] ?? null`);
const route = `/documents/${encodeURIComponent(DOC)}`;
async function shot(name) {
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (s.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(s.result.data, "base64"));
}
/** The page is on the document and shows exactly the revision the API calls current. */
async function expectLatest(marker) {
    const current = (await apiJson(`/api/documents/${DOC}`)).revision;
    const short = current.content_hash.slice(0, 8);
    await waitFor(`location.pathname === ${JSON.stringify(route)} && (document.querySelector('header')?.textContent || '').includes('rev ${short}')`, `the document page on rev ${short}`);
    check(await headerRev() === short, `header shows the latest revision rev ${short}`);
    check((await text("article"))?.includes(marker), `latest registered content on screen ("${marker}")`);
    check((await text("[data-decision-card]"))?.includes(`Records your decision on rev ${short}`), `the decision card targets rev ${short}`);
    check(!(await evalJs(`!!${q("[data-decision-blocked]")}`)), "deciding is not blocked on the latest revision");
    steps.push({ step, path: await evalJs("location.pathname"), header_revision: await headerRev(), api_current_revision: current.id, api_current_hash: current.content_hash });
    return current;
}

let exitCode = 0;
try {
    // Rev 1: Robert reads it and finishes a review with one passage comment.
    step = "01-review-rev1";
    await send("Page.navigate", { url: `${BASE}${route}` });
    await waitFor(`!!${q("[data-decision-card]")} && !!${q("#L3 [data-block-comment-button]")}`, "the reviewer on rev 1");
    const rev1 = (await apiJson(`/api/documents/${DOC}`)).revision;
    check(await headerRev() === rev1.content_hash.slice(0, 8), "rev 1 on screen");
    await click("#L3 [data-block-comment-button]");
    await typeInto('textarea[aria-label="Comment text"]', "Synthetic comment on rev 1: summarise instead of listing.");
    await clickButton("Save comment");
    await waitFor(`(${q("[data-comment-list]")}?.textContent || '').includes('Synthetic comment on rev 1')`, "the saved comment");
    await click("[data-finish-button]");
    await clickButton("Send to Praxis");
    await waitFor(`!!${q("[data-submission-card]")}`, "the finished review");
    await shot(step);

    // The requested change is registered as rev 2 of the same document.
    step = "02-register-rev2";
    const rev2 = await registerRevision("Revision two: the requested summaries were added after the review.");
    check(rev2.id !== rev1.id, "a newer revision was registered");

    // Entry point 1: the bridge's Ready for your review.
    step = "03-ready-for-review";
    await send("Page.navigate", { url: `${BASE}/` });
    await waitFor(`!!document.querySelector('[data-ready-for-review] [data-document-id=${JSON.stringify(DOC)}] [data-review-link]')`, "the document in Ready for your review", 45_000);
    check((await evalJs(`document.querySelector('[data-ready-for-review] [data-document-id=${JSON.stringify(DOC)}] [data-review-link]').getAttribute('href')`)) === route, "the row links the stable document URL");
    await evalJs(`document.querySelector('[data-ready-for-review] [data-document-id=${JSON.stringify(DOC)}] [data-review-link]').click()`);
    await expectLatest("Revision two:");
    const banner = await text("[data-changed-banner]");
    check(banner?.includes(`viewing the latest revision (rev ${rev2.content_hash.slice(0, 8)})`) && banner.includes(`you reviewed rev ${rev1.content_hash.slice(0, 8)}`), "the banner names both revisions");
    check((await text("[data-comment-list]"))?.includes("Synthetic comment on rev 1"), "the finished review's comment is still listed");
    await shot(step);

    // Explicit history: the reviewed revision, read-only for decisions.
    step = "04-reviewed-revision";
    await clickButton("View reviewed revision");
    await waitFor(`(document.querySelector('header')?.textContent || '').includes('rev ${rev1.content_hash.slice(0, 8)}')`, "the reviewed revision");
    check(!(await text("article"))?.includes("Revision two:"), "the reviewed bytes, without the later change");
    check(await evalJs(`!!${q("[data-decision-blocked]")}`), "no decision while the reviewed revision is on screen");
    check((await evalJs(`document.querySelector('a[href*="/raw?"]')?.getAttribute('href')`))?.includes(`revision=${rev1.id}`), "Download serves the reviewed revision");
    await shot(step);
    await clickButton("View current file");
    await waitFor(`(document.querySelector('header')?.textContent || '').includes('rev ${rev2.content_hash.slice(0, 8)}')`, "back on the latest revision");

    // Unsaved decision note survives switching views; it is never submitted.
    step = "05-draft-note";
    await click('[data-decision-button="approve"]');
    check((await text("[data-decision-confirm]"))?.includes(`Approve rev ${rev2.content_hash.slice(0, 8)} exactly as shown`), "Approve document names the revision on screen");
    await typeInto("textarea#decision-note", "Synthetic note, never submitted.");
    await clickButton("View reviewed revision");
    await clickButton("View current file");
    check((await evalJs(`${q("textarea#decision-note")}?.value`)) === "Synthetic note, never submitted.", "the typed note is intact after switching views");
    await shot(step);

    // Entry point 2: the task's Deliverables, after rev 3 was registered while Robert was on the task.
    step = "06-task-deliverables";
    await click('header a[href^="/task/"]');
    await waitFor(`location.pathname.startsWith('/task/') && !!document.querySelector('[data-review-documents-panel] [data-document-id=${JSON.stringify(DOC)}] [data-review-link]')`, "the task's Deliverables row", 45_000);
    const rev3 = await registerRevision("Revision three: registered while the task page was open.");
    await evalJs(`document.querySelector('[data-review-documents-panel] [data-document-id=${JSON.stringify(DOC)}] [data-review-link]').click()`);
    const shown3 = await expectLatest("Revision three:");
    check(shown3.id === rev3.id, "the task link opened rev 3");
    await shot(step);

    // Return navigation: back to the task, rev 4 registered, forward to the document.
    step = "07-back-forward";
    await evalJs("history.back()");
    await waitFor("location.pathname.startsWith('/task/')", "the task page after Back");
    const rev4 = await registerRevision("Revision four: registered before returning to the document.");
    await evalJs("history.forward()");
    const shown4 = await expectLatest("Revision four:");
    check(shown4.id === rev4.id, "returning to the document shows rev 4");
    await shot(step);

    // A full reload lands on the same latest revision.
    step = "08-reload";
    await send("Page.reload", { ignoreCache: false });
    await sleep(500);
    await expectLatest("Revision four:");

    step = "09-no-decisions";
    const history = await apiJson(`/api/documents/${DOC}/history`);
    check(history.decisions.length === 0, "no decision was recorded by this check");
    check(history.revisions.length === 4, "four revisions of one document");
    check(!writes.some((w) => w.path.endsWith("/decisions")), "the browser never posted a decision");
    check(exceptions.length === 0, `no uncaught page exceptions${exceptions.length ? `: ${exceptions.join(" | ")}` : ""}`);
} catch (err) {
    check(false, `unexpected error: ${err?.stack || err}`);
} finally {
    if (failures.length) exitCode = 1;
    writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ checked_at: new Date().toISOString(), base: BASE, api: API, document_id: DOC, passes, failures, steps, browser_writes: writes, exceptions }, null, 2)}\n`);
    console.log(`\n${passes.length} passed, ${failures.length} failed. Report: ${join(OUT, "report.json")}`);
    ws.close();
    stopAll();
    await sleep(500);
    process.exit(exitCode);
}
