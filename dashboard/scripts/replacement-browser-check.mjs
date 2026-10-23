#!/usr/bin/env node
/**
 * Real-browser check of the version lifecycle (contract §12, task 6b46dcc8,
 * 2026-10-23) on desktop and phone widths. It runs entirely on an isolated
 * stack and leaves nothing running:
 *
 *   - the throwaway API of scripts/decision-session-check-api.cjs (temporary
 *     SQLite, synthetic Praxis receiver, one synthetic brief registered as a
 *     review-required deliverable of a completed synthetic task);
 *   - `next start` of a separate dist dir built against that API;
 *   - headless Chrome over the DevTools protocol.
 *
 * Flow: finish a review of v1 in the page, start a second (draft) round, then
 * accept replacement work for the finished review through the API (the way
 * Praxis will). Reload: the draft round is superseded and read-only, the
 * decision is blocked with the reason, the banner names the work and its task,
 * and the Reviews queue lists the document under Being revised; the same on a
 * phone viewport with the Review & decide drawer. A decision attempted with a
 * verified session is refused (nothing recorded). Then the producer registers
 * v2 under the work's task and reports QA passed: the work is ready, v2 is
 * current and reviewable, and the history lists versions and the attempt.
 * Then (QA repair round, contract §12.5) a review of v2 becomes a second piece
 * of work whose producer registers v3 and reports failure: v3's bytes are
 * current but closed, the banner says so on desktop and phone, the queue keeps
 * the document under Being revised, a plain re-acceptance is refused, and an
 * explicit recovery citing the v2 review delivers v4 and reopens review. No
 * decision is recorded anywhere; nothing is sent beyond the synthetic receiver.
 *
 *   NEXT_DIST_DIR=.next-6b46dcc8 NEXT_PUBLIC_API_URL=http://127.0.0.1:4499 npm run build
 *   CHECK_DIST=.next-6b46dcc8 node scripts/replacement-browser-check.mjs
 *
 * Env: CHECK_DIST (required: the dist dir built above), CHECK_API_PORT (4499,
 * must match the build), CHECK_PRAXIS_PORT (4498), CHECK_WEB_PORT (3499),
 * CHECK_OUT (a fresh temp dir), CHECK_CHROME. Writes <out>/<step>.png and
 * <out>/report.json; exits 1 on any failed check.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const DIST = process.env.CHECK_DIST;
if (!DIST || !existsSync(join(DASHBOARD, DIST))) { console.error("CHECK_DIST=<dist dir built against the check API> is required."); process.exit(2); }
const API_PORT = Number(process.env.CHECK_API_PORT || 4499);
const PRAXIS_PORT = Number(process.env.CHECK_PRAXIS_PORT || 4498);
const WEB_PORT = Number(process.env.CHECK_WEB_PORT || 3499);
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const OUT = resolve(process.env.CHECK_OUT || mkdtempSync(join(tmpdir(), "nexus-replacement-check-")));
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
const sessionToken = readFileSync(join(fixture.CHECK_DIR, "operator-session.jwt"), "utf8").trim();
const apiCall = async (path, init = {}) => {
    const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
    return { status: res.status, json: await res.json().catch(() => null) };
};
const apiJson = async (path) => (await apiCall(path)).json;
const registered = (await apiJson(`/api/documents/${DOC}`)).document;
// The work task: a separate, still-running task of the same project (the completed source task would reconcile the work closed).
const workTask = await apiCall("/api/tasks", { method: "POST", body: JSON.stringify({ project_id: registered.project_id, name: "Revise the synthetic brief (replacement work)", description: "verification fixture for scripts/replacement-browser-check.mjs", status: "in_progress", priority: 2 }) });
const WORK_TASK = workTask.json?.id || workTask.json?.task?.id || null;
/** The producer's edit plus its registration under the work's task: same path, so the same document gets the next version. */
async function registerRevision(line, taskId) {
    appendFileSync(FILE, `\n${line}\n`);
    const res = await apiCall("/api/documents", {
        method: "POST",
        body: JSON.stringify({
            path: FILE, title: registered.title, project_id: registered.project_id, task_id: taskId, kind: registered.kind,
            deliverable: { requires_review: registered.requires_review, purpose: registered.purpose, intended_action: registered.intended_action },
        }),
    });
    check(res.status === 200 && res.json?.document?.id === DOC, `registration under task ${String(taskId).slice(0, 8)} kept document ${DOC.slice(0, 8)}: ${res.status}`);
    return res.json;
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
const profile = mkdtempSync(join(tmpdir(), "nexus-replacement-profile-"));
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
const desktop = () => send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
const phone = () => send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await desktop();
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
const attr = (sel, name) => evalJs(`${q(sel)}?.getAttribute(${JSON.stringify(name)}) ?? null`);
const count = (sel) => evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const click = async (sel) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`), `clicked ${sel}`);
const clickButton = async (label) => check(await evalJs(`(() => { const el = [...document.querySelectorAll('button')].find(b => ${label instanceof RegExp ? `${label.toString()}.test(b.textContent.trim())` : `b.textContent.trim() === ${JSON.stringify(label)}`}); if (!el) return false; el.click(); return true; })()`), `clicked "${label}"`);
const typeInto = async (sel, value) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), `typed into ${sel}`);
const headerChip = () => text("[data-revision-chip]");
const route = `/documents/${encodeURIComponent(DOC)}`;
async function shot(name) {
    const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (s.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(s.result.data, "base64"));
}
async function open(path, readyExpr, label) {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(readyExpr, label, 45_000);
}
const record = async (extra = {}) => steps.push({ step, path: await evalJs("location.pathname"), header_chip: await headerChip(), ...extra });

let exitCode = 0;
// The second work item (registers v3, then fails) and the recovery (delivers v4): created in steps 13 and 17, named in the report.
let WORK_TASK_2 = null;
let WORK_TASK_3 = null;
try {
    check(Boolean(WORK_TASK), `a running work task exists for the replacement (${workTask.status})`);

    // v1: Robert finishes a review with one passage comment, then opens a second round (a draft) with a whole-document note.
    step = "01-finish-review-v1";
    await open(route, `!!${q("[data-decision-card]")} && !!${q("#L3 [data-block-comment-button]")}`, "the reviewer on v1");
    const read1 = await apiJson(`/api/documents/${DOC}`);
    check((await headerChip())?.includes(`v1 · rev ${read1.revision.content_hash.slice(0, 8)}`), "the header names version 1 and its revision");
    check(read1.reviewable?.ok === true && read1.replacement === null, "v1 is reviewable with no replacement work");
    await click("#L3 [data-block-comment-button]");
    await typeInto('textarea[aria-label="Comment text"]', "Synthetic comment on v1: the pending row is wrong.");
    await clickButton("Save comment");
    await waitFor(`(${q("[data-comment-list]")}?.textContent || '').includes('Synthetic comment on v1')`, "the saved comment");
    await click("[data-finish-button]");
    await clickButton("Send to Praxis");
    await waitFor(`!!${q("[data-submission-card]")}`, "the finished review");
    const finished = (await apiJson(`/api/documents/${DOC}`)).review;
    check(finished?.status === "submitted" && Boolean(finished.submission?.id), "round 1 is finished with a submission");
    await shot(step);
    await record({ submission_id: finished?.submission?.id ?? null });

    step = "02-second-round-draft";
    await clickButton(/^Start a new review/);
    await waitFor(`${q("[data-review-round]")}?.dataset.reviewRound === 'draft'`, "a second, draft round");
    await clickButton(/^Add a note about the whole/);
    await typeInto('textarea[aria-label="Comment text"]', "Second-round note, never sent: this is the draft the replacement will close.");
    await clickButton("Save comment");
    await waitFor(`(${q("[data-comment-list]")}?.textContent || '').includes('Second-round note')`, "the draft's note");
    const draft = (await apiJson(`/api/documents/${DOC}`)).review;
    check(draft?.status === "draft" && draft.id !== finished.id, "the second round is an open draft");
    await record({ draft_review_id: draft?.id ?? null });

    // Praxis accepts the finished review as replacement work (contract §12.3): the draft is superseded, v1 closes to review.
    step = "03-accept-replacement";
    const accepted = await apiCall(`/api/documents/${DOC}/replacements`, { method: "POST", body: JSON.stringify({ client_request_id: `check-${finished.submission.id}`, source: { submission_id: finished.submission.id }, task_id: WORK_TASK, state: "running", detail: "synthetic revision work" }) });
    check(accepted.status === 201 && accepted.json?.replacement?.state === "running", `acceptance recorded: ${accepted.status} ${accepted.json?.code ?? accepted.json?.replacement?.state ?? ""}`);
    check(Array.isArray(accepted.json?.superseded_reviews) && accepted.json.superseded_reviews.includes(draft.id), "the open draft was superseded by the acceptance");
    const replay = await apiCall(`/api/documents/${DOC}/replacements`, { method: "POST", body: JSON.stringify({ client_request_id: `check-${finished.submission.id}`, source: { submission_id: finished.submission.id }, task_id: WORK_TASK, state: "running", detail: "synthetic revision work" }) });
    check(replay.status === 200 && replay.json?.duplicate === true && replay.json.replacement.id === accepted.json.replacement.id, "a replay of the acceptance is a duplicate, not a second item");
    const RP = accepted.json.replacement.id;
    await record({ replacement_id: RP, task_id: WORK_TASK });

    // Desktop: the closed version.
    step = "04-desktop-closed";
    await send("Page.reload", { ignoreCache: false });
    await waitFor(`${q("[data-replacement-banner]")}?.dataset.replacementBanner === 'running'`, "the replacement banner");
    check((await text("[data-replacement-banner]"))?.includes("You are reading the current version (v1)"), "the banner says which version is on screen and that it is current");
    check((await attr("[data-replacement-banner] [data-replacement-task-link]", "href")) === `/task/${WORK_TASK}`, "the banner links the work task in-app");
    check((await attr("[data-decision-card] [data-decision-blocked]", "data-decision-blocked")) === "replacement_in_progress", "the decision is blocked with the reason");
    check((await count("[data-decision-card] [data-decision-button]")) === 0, "no decision buttons on a version being replaced");
    check((await attr("[data-review-round]", "data-review-round")) === "superseded", "the second round shows as superseded");
    check((await text("[data-review-superseded]"))?.includes("not sent"), "the superseded round says its comment was not sent");
    check((await text("[data-comment-list]"))?.includes("Second-round note"), "the superseded round's note is still readable");
    check(!(await evalJs(`!!${q("[data-finish-button]")}`)), "nothing to finish on a superseded round");
    check(!(await evalJs(`[...document.querySelectorAll('button')].some(b => /^Start a new review/.test(b.textContent.trim()))`)), "no new round can start while the version is closed");
    check((await attr("[data-review-closed]", "data-review-closed")) === "replacement_in_progress", "the panel explains why no round can start");
    await shot(step);
    await record();

    step = "05-desktop-history";
    await click("[data-decision-card] [data-history-toggle]");
    await waitFor(`!!${q("[data-history-replacements]")}`, "the history's revision work");
    check((await count("[data-history-version='1']")) >= 1, "history numbers the version");
    check((await attr("[data-history-replacement]", "data-history-replacement")) === "running", "history lists the open attempt");
    check((await attr("[data-history-feedback='superseded']", "data-history-feedback")) === "superseded", "history labels the superseded round");
    await shot(step);

    // A decision attempted with a verified session while the work is open: refused, nothing recorded.
    step = "06-decision-refused";
    const refused = await apiCall(`/api/documents/${DOC}/decisions`, { method: "POST", headers: { "cf-access-jwt-assertion": sessionToken }, body: JSON.stringify({ decision: "approve", revision_id: read1.revision.id, content_hash: read1.revision.content_hash, client_decision_id: "check-refused-1" }) });
    check(refused.status === 409 && refused.json?.code === "replacement_in_progress", `a decision on the closed version is refused: ${refused.status} ${refused.json?.code}`);
    const stale = await apiCall(`/api/documents/${DOC}/reviews`, { method: "POST", body: JSON.stringify({ revision_id: read1.revision.id }) });
    check(stale.status === 409 && stale.json?.code === "replacement_in_progress", `a new round on the closed version is refused: ${stale.status} ${stale.json?.code}`);

    // Phone: the same closed state, in the article and in the Review & decide drawer.
    step = "07-phone-closed";
    await phone();
    await send("Page.reload", { ignoreCache: false });
    await waitFor(`${q("[data-replacement-banner]")}?.dataset.replacementBanner === 'running'`, "the banner on the phone");
    check((await evalJs(`(() => { const el = ${q("[data-replacement-banner]")}; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.width <= 390; })()`)), "the banner is laid out inside the phone viewport");
    check((await evalJs(`(() => { const el = ${q("[data-open-review]")}; if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`)), "the phone shows the Review & decide button");
    await shot(step);
    step = "08-phone-drawer";
    await click("[data-open-review]");
    await waitFor(`!!${q("[data-review-drawer]")}`, "the drawer");
    check((await attr("[data-review-drawer] [data-decision-blocked]", "data-decision-blocked")) === "replacement_in_progress", "the drawer's decision is blocked with the reason");
    check((await count("[data-review-drawer] [data-decision-button]")) === 0, "no decision buttons in the drawer");
    check((await attr("[data-review-drawer] [data-review-round]", "data-review-round")) === "superseded", "the drawer shows the superseded round");
    check((await attr("[data-review-drawer] [data-review-closed]", "data-review-closed")) === "replacement_in_progress", "the drawer explains why no round can start");
    check((await attr("[data-review-drawer] [data-replacement-note]", "data-replacement-note")) === "running", "the drawer's decision card names the work");
    await shot(step);
    await record();

    // The Reviews queue: Being revised, with the badge; not under Needs your review.
    step = "09-queue-being-revised";
    await desktop();
    await open("/documents?status=in_progress", `!!document.querySelector('[data-document-id=${JSON.stringify(DOC)}] [data-replacement-badge]')`, "the document under Being revised");
    check((await attr(`[data-document-id="${DOC}"] [data-replacement-badge]`, "data-replacement-badge")) === "running", "the row carries the replacement badge");
    check((await text(`[data-document-id="${DOC}"] [data-document-version]`))?.startsWith("v1 · rev "), "the row names version 1");
    check((await text("[data-status-tab='in_progress'] [data-status-count]")) === "1", "Being revised counts the one document");
    check((await text("[data-status-tab='needs_review'] [data-status-count]")) === "0", "Needs your review does not count it");
    await shot(step);
    await record();

    // The producer registers v2 under the work's task (the result, implemented) and reports QA passed (ready, verified).
    step = "10-result-and-ready";
    const v2 = await registerRevision("Revision two: the pending row now reads installed and verified.", WORK_TASK);
    check(v2?.receipt?.replacement?.id === RP && v2.receipt.replacement.state === "implemented", `the receipt names the work as implemented (${v2?.receipt?.replacement?.state})`);
    const early = await apiCall(`/api/documents/${DOC}/decisions`, { method: "POST", headers: { "cf-access-jwt-assertion": sessionToken }, body: JSON.stringify({ decision: "approve", revision_id: v2.revision.id, content_hash: v2.revision.content_hash, client_decision_id: "check-refused-2" }) });
    check(early.status === 409 && early.json?.code === "replacement_in_progress", `v2 is not reviewable before QA passes: ${early.status} ${early.json?.code}`);
    const ready = await apiCall(`/api/documents/${DOC}/replacements/${RP}`, { method: "PATCH", body: JSON.stringify({ state: "qa_passed", qa_state: "passed" }) });
    check(ready.status === 200 && ready.json?.replacement?.state === "ready" && ready.json.reviewable === true, `QA passed on the current result makes the work ready: ${ready.status} ${ready.json?.replacement?.state}`);
    const detail = await apiJson(`/api/documents/${DOC}/replacements/${RP}`);
    check(detail.result_is_current === true && detail.result_is_ready === true && detail.replacement.result_revision_id === v2.revision.id, "the item's result is the current, ready revision");

    step = "11-desktop-ready";
    await open(route, `(${q("[data-revision-chip]")}?.textContent || '').includes('v2 · rev ${v2.revision.content_hash.slice(0, 8)}')`, "the reader on v2");
    check(!(await evalJs(`!!${q("[data-replacement-banner]")}`)), "no replacement banner once the new version is ready");
    check(!(await evalJs(`!!${q("[data-decision-card] [data-decision-blocked]")}`)), "the decision is open on v2");
    check((await count("[data-decision-card] [data-decision-button]")) === 2, "approve and request-changes are offered on v2");
    check((await text("article"))?.includes("Revision two:"), "v2's bytes are on screen");
    check((await evalJs(`[...document.querySelectorAll('button')].some(b => /^Start a new review/.test(b.textContent.trim()))`)), "a new round may start on v2");
    check((await text("[data-decision-card]"))?.includes(`Records your decision on rev ${v2.revision.content_hash.slice(0, 8)}`), "deciding targets v2 exactly");
    await shot(step);
    await record();

    // QA repair round (contract §12.5): a review of v2 becomes a second piece of work whose producer registers v3 and then fails.
    // v3's bytes are current but were never declared ready, so the version is closed until an explicit recovery delivers v4.
    step = "12-finish-review-v2";
    await clickButton(/^Start a new review/);
    await waitFor(`${q("[data-review-round]")}?.dataset.reviewRound === 'draft'`, "a draft round on v2");
    await clickButton(/^Add a note about the whole/);
    await typeInto('textarea[aria-label="Comment text"]', "Synthetic comment on v2: the verified row needs a date.");
    await clickButton("Save comment");
    await waitFor(`(${q("[data-comment-list]")}?.textContent || '').includes('Synthetic comment on v2')`, "the saved v2 comment");
    await click("[data-finish-button]");
    await clickButton("Send to Praxis");
    await waitFor(`${q("[data-review-round]")}?.dataset.reviewRound === 'finished'`, "the finished v2 round");
    const finished2 = (await apiJson(`/api/documents/${DOC}`)).review;
    check(finished2?.status === "submitted" && finished2.revision_id === v2.revision.id && Boolean(finished2.submission?.id), "the round on v2 is finished with a submission");
    await record({ submission_id: finished2?.submission?.id ?? null });

    step = "13-second-work-fails-after-registering-v3";
    const workTask2 = await apiCall("/api/tasks", { method: "POST", body: JSON.stringify({ project_id: registered.project_id, name: "Revise the synthetic brief again (attempt that fails)", description: "verification fixture for scripts/replacement-browser-check.mjs", status: "in_progress", priority: 2 }) });
    WORK_TASK_2 = workTask2.json?.id || workTask2.json?.task?.id || null;
    check(Boolean(WORK_TASK_2), `a second running work task exists (${workTask2.status})`);
    const accepted2 = await apiCall(`/api/documents/${DOC}/replacements`, { method: "POST", body: JSON.stringify({ client_request_id: `check-${finished2.submission.id}`, source: { submission_id: finished2.submission.id }, task_id: WORK_TASK_2, state: "running", detail: "second synthetic revision" }) });
    check(accepted2.status === 201 && accepted2.json?.replacement?.base_revision_id === v2.revision.id && accepted2.json.replacement.attempt === 1, `the v2 review is accepted as new work on v2: ${accepted2.status} ${accepted2.json?.code ?? ""}`);
    const RP2 = accepted2.json?.replacement?.id;
    const v3 = await registerRevision("Revision three: registered by an attempt that then failed.", WORK_TASK_2);
    check(v3?.receipt?.replacement?.id === RP2 && v3.receipt.replacement.state === "implemented", `v3 is the second item's result (${v3?.receipt?.replacement?.state})`);
    const failed = await apiCall(`/api/documents/${DOC}/replacements/${RP2}`, { method: "PATCH", body: JSON.stringify({ state: "failed", qa_state: "failed", detail: "synthetic QA failure after registering v3" }) });
    check(failed.status === 200 && failed.json?.replacement?.state === "failed" && failed.json.reviewable === false, `the attempt fails after registering v3 and the version stays closed: ${failed.status} ${failed.json?.replacement?.state} reviewable=${failed.json?.reviewable}`);
    const closedDoc = await apiJson(`/api/documents/${DOC}`);
    check(closedDoc.revision?.id === v3.revision.id && closedDoc.reviewable?.ok === false && closedDoc.reviewable.reason === "replacement_failed", `v3 is current but closed (${closedDoc.reviewable?.reason})`);
    const onFailed = await apiCall(`/api/documents/${DOC}/decisions`, { method: "POST", headers: { "cf-access-jwt-assertion": sessionToken }, body: JSON.stringify({ decision: "approve", revision_id: v3.revision.id, content_hash: v3.revision.content_hash, client_decision_id: "check-refused-3" }) });
    check(onFailed.status === 409 && onFailed.json?.code === "replacement_failed", `a decision on the failed bytes is refused: ${onFailed.status} ${onFailed.json?.code}`);
    const roundOnFailed = await apiCall(`/api/documents/${DOC}/reviews`, { method: "POST", body: JSON.stringify({ revision_id: v3.revision.id }) });
    check(roundOnFailed.status === 409 && roundOnFailed.json?.code === "replacement_failed", `a new round on the failed bytes is refused: ${roundOnFailed.status} ${roundOnFailed.json?.code}`);
    await record({ replacement_id: RP2, task_id: WORK_TASK_2 });

    step = "14-desktop-failed-result";
    await open(route, `${q("[data-replacement-banner]")}?.dataset.replacementBanner === 'failed'`, "the failed-attempt banner on v3");
    check((await headerChip())?.includes(`v3 · rev ${v3.revision.content_hash.slice(0, 8)}`), "the header names version 3, the failed bytes");
    const bannerText = await text("[data-replacement-banner]");
    check(Boolean(bannerText?.includes("You are reading the bytes that attempt registered (v3)") && bannerText.includes("never declared ready")), "the banner says these are the attempt's unaccepted bytes and that they take no review");
    check(Boolean(bannerText?.includes("explicit recovery")), "the banner says review reopens only on a recovered version");
    check((await attr("[data-replacement-banner] [data-replacement-task-link]", "href")) === `/task/${WORK_TASK_2}`, "the banner links the failed attempt's task");
    check((await attr("[data-decision-card] [data-decision-blocked]", "data-decision-blocked")) === "replacement_failed", "the decision is blocked by the failure");
    check((await count("[data-decision-card] [data-decision-button]")) === 0, "no decision buttons on failed bytes");
    check((await attr("[data-decision-card] [data-replacement-note]", "data-replacement-note")) === "failed", "the decision card names the failed attempt");
    check(!(await evalJs(`[...document.querySelectorAll('button')].some(b => /^Start a new review/.test(b.textContent.trim()))`)), "no new round can start on failed bytes");
    check((await attr("[data-review-closed]", "data-review-closed")) === "replacement_failed", "the panel explains the closure");
    check((await text("article"))?.includes("Revision three:"), "v3's bytes are what is on screen");
    await shot(step);
    await record();

    step = "15-phone-failed-result";
    await phone();
    await send("Page.reload", { ignoreCache: false });
    await waitFor(`${q("[data-replacement-banner]")}?.dataset.replacementBanner === 'failed'`, "the failed banner on the phone");
    await click("[data-open-review]");
    await waitFor(`!!${q("[data-review-drawer]")}`, "the drawer");
    check((await attr("[data-review-drawer] [data-decision-blocked]", "data-decision-blocked")) === "replacement_failed", "the drawer's decision is blocked by the failure");
    check((await count("[data-review-drawer] [data-decision-button]")) === 0, "no decision buttons in the drawer");
    check((await attr("[data-review-drawer] [data-review-closed]", "data-review-closed")) === "replacement_failed", "the drawer explains the closure");
    check((await attr("[data-review-drawer] [data-replacement-note]", "data-replacement-note")) === "failed", "the drawer's decision card names the failed attempt");
    await shot(step);
    await record();

    step = "16-queue-failed-result";
    await desktop();
    await open("/documents?status=in_progress", `!!document.querySelector('[data-document-id=${JSON.stringify(DOC)}] [data-replacement-badge]')`, "the document under Being revised while closed by a failure");
    check((await attr(`[data-document-id="${DOC}"] [data-replacement-badge]`, "data-replacement-badge")) === "failed", "the row carries the failed badge");
    check((await text(`[data-document-id="${DOC}"] [data-document-version]`))?.startsWith("v3 · rev "), "the row names version 3");
    check((await text("[data-status-tab='in_progress'] [data-status-count]")) === "1", "Being revised counts the closed document");
    check((await text("[data-status-tab='needs_review'] [data-status-count]")) === "0", "Needs your review does not offer the failed bytes");
    await shot(step);
    await record();

    step = "17-recovery-delivers-v4";
    const plain = await apiCall(`/api/documents/${DOC}/replacements`, { method: "POST", body: JSON.stringify({ client_request_id: `check-${finished2.submission.id}-again`, source: { submission_id: finished2.submission.id }, task_id: WORK_TASK_2, state: "running" }) });
    check(plain.status === 409 && plain.json?.code === "recovery_required", `a plain re-acceptance must name the attempt it recovers: ${plain.status} ${plain.json?.code}`);
    const workTask3 = await apiCall("/api/tasks", { method: "POST", body: JSON.stringify({ project_id: registered.project_id, name: "Recover the synthetic brief revision", description: "verification fixture for scripts/replacement-browser-check.mjs", status: "in_progress", priority: 2 }) });
    WORK_TASK_3 = workTask3.json?.id || workTask3.json?.task?.id || null;
    const recovery = await apiCall(`/api/documents/${DOC}/replacements`, { method: "POST", body: JSON.stringify({ client_request_id: `check-${finished2.submission.id}-recovery`, source: { submission_id: finished2.submission.id }, recovers_replacement_id: RP2, task_id: WORK_TASK_3, state: "running", detail: "recovery after the failed v3" }) });
    check(recovery.status === 201 && recovery.json?.replacement?.attempt === 2 && recovery.json.replacement.base_revision_id === v3.revision.id, `the recovery citing the v2 review is attempt 2 on top of v3: ${recovery.status} ${recovery.json?.code ?? ""}`);
    const RP3 = recovery.json?.replacement?.id;
    const v4 = await registerRevision("Revision four: delivered by the recovery and verified.", WORK_TASK_3);
    check(v4?.receipt?.replacement?.id === RP3 && v4.receipt.replacement.state === "implemented", `v4 is the recovery's result (${v4?.receipt?.replacement?.state})`);
    const ready2 = await apiCall(`/api/documents/${DOC}/replacements/${RP3}`, { method: "PATCH", body: JSON.stringify({ state: "qa_passed", qa_state: "passed" }) });
    check(ready2.status === 200 && ready2.json?.replacement?.state === "ready" && ready2.json.reviewable === true, `QA passed on v4 reopens review: ${ready2.status} ${ready2.json?.replacement?.state}`);
    const staleCite = await apiCall(`/api/documents/${DOC}/replacements`, { method: "POST", body: JSON.stringify({ client_request_id: `check-${finished2.submission.id}-stale`, source: { submission_id: finished2.submission.id }, recovers_replacement_id: RP3, task_id: WORK_TASK_3, state: "running" }) });
    check(staleCite.status === 409 && staleCite.json?.code === "source_not_current" && staleCite.json.authority_revision_id === v4.revision.id, `once v4 is ready the v2 review no longer authorizes work: ${staleCite.status} ${staleCite.json?.code} authority=${String(staleCite.json?.authority_revision_id).slice(0, 8)}`);
    await record({ replacement_id: RP3, task_id: WORK_TASK_3 });

    step = "18-desktop-recovered";
    await open(route, `(${q("[data-revision-chip]")}?.textContent || '').includes('v4 · rev ${v4.revision.content_hash.slice(0, 8)}')`, "the reader on v4");
    check(!(await evalJs(`!!${q("[data-replacement-banner]")}`)), "no banner once the recovery is ready");
    check(!(await evalJs(`!!${q("[data-decision-card] [data-decision-blocked]")}`)), "the decision is open on v4");
    check((await count("[data-decision-card] [data-decision-button]")) === 2, "approve and request-changes are offered on v4");
    check((await text("article"))?.includes("Revision four:"), "v4's bytes are on screen");
    check((await evalJs(`[...document.querySelectorAll('button')].some(b => /^Start a new review/.test(b.textContent.trim()))`)), "a new round may start on v4");
    await click("[data-decision-card] [data-history-toggle]");
    await waitFor(`!!${q("[data-history-replacements]")}`, "the history's revision work");
    check((await count("[data-history-version='3']")) >= 1 && (await count("[data-history-version='4']")) >= 1, "history numbers the failed version and the recovered one");
    check((await count("[data-history-replacement='failed']")) === 1 && (await count("[data-history-replacement='ready']")) === 2, "history lists the failed attempt and both ready ones");
    await shot(step);
    await record();

    step = "19-no-decisions";
    const history = await apiJson(`/api/documents/${DOC}/history`);
    check(history.decisions.length === 0, "no decision was recorded by this check");
    check(history.current_version === 4 && history.revisions.length === 4, "four versions of one document, v4 current");
    check(history.replacements.length === 3 && history.replacements.filter((r) => r.state === "ready").length === 2 && history.replacements.some((r) => r.state === "failed" && r.result_revision_id === v3.revision.id), "three attempts: two ready, one failed with v3 as its unaccepted result");
    check(history.reviews.some((r) => r.status === "superseded" && r.closed_reason === "superseded") && history.reviews.filter((r) => r.status === "submitted").length === 2, "the two finished rounds and the superseded round are all history");
    check(!writes.some((w) => w.path.endsWith("/decisions")), "the browser never posted a decision");
    check(exceptions.length === 0, `no uncaught page exceptions${exceptions.length ? `: ${exceptions.join(" | ")}` : ""}`);
    const relays = await (await fetch(`http://127.0.0.1:${PRAXIS_PORT}/__relays`)).json();
    check(relays.length === 2, `exactly two review relays reached the synthetic receiver (${relays.length})`);
} catch (err) {
    check(false, `unexpected error: ${err?.stack || err}`);
} finally {
    if (failures.length) exitCode = 1;
    writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ checked_at: new Date().toISOString(), base: BASE, api: API, document_id: DOC, work_task: WORK_TASK, work_task_2: WORK_TASK_2, work_task_3: WORK_TASK_3, passes, failures, steps, browser_writes: writes, exceptions }, null, 2)}\n`);
    console.log(`\n${passes.length} passed, ${failures.length} failed. Report: ${join(OUT, "report.json")}`);
    ws.close();
    stopAll();
    await sleep(500);
    process.exit(exitCode);
}
