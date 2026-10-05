#!/usr/bin/env node
/**
 * Real-browser check of document decisions through a session, on an isolated
 * stack (task a1cc8616, 2026-10-04). It drives /documents/<id> in headless
 * Chrome the way the Nexus shells do, with the Cloudflare Access assertion
 * injected on the wire exactly where the edge injects it (an extra request
 * header, never page code), and asserts the whole flow Robert hit:
 *
 *   1. a passage comment saves from the plain session (no operator sign-in);
 *   2. Request changes with a note is refused without a session: with the old
 *      client's placeholder bearer emulated, the exact screenshot refusal
 *      (operator credential not configured); without it, operator_required.
 *      Nothing is recorded, the note stays in the textarea and on the device;
 *   3. a reload brings the note back, announced, with its revision and attempt;
 *   4. after the file changed, the note says which revision it was written
 *      for and the decision targets the revision on screen;
 *   5. with a verified session (plus the placeholder bearer, as a stale tab
 *      would send) the decision records on that exact revision with the note;
 *      the review and its comment stay pinned to the earlier revision;
 *   6. a trusted device session approves (access_device);
 *   7. a session that also carries an executor header is refused;
 *   8. Finish review submits once and the synthetic receiver confirms delivery.
 *
 *   node scripts/decision-session-check-api.cjs            # prints CHECK_* lines
 *   NEXT_DIST_DIR=.next-verify NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 npm run build
 *   NEXT_DIST_DIR=.next-verify npx next start -p 3299
 *   CHECK_BASE=http://127.0.0.1:3299 CHECK_DIR=<dir> CHECK_DOC=<id> node scripts/decision-session-browser-check.mjs
 *
 * Env: CHECK_BASE (http://127.0.0.1:3299), CHECK_API (http://127.0.0.1:4299),
 * CHECK_PRAXIS (http://127.0.0.1:4300), CHECK_DIR (the API script's temp dir:
 * holds the fixture file and the two synthetic session tokens), CHECK_DOC
 * (required), CHECK_OUT (<CHECK_DIR>/browser-check), CHECK_CHROME.
 * Writes <out>/<step>.png and <out>/report.json; exits 1 on any failed assertion.
 * Every request the page makes to another origin is listed in the report.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const DOC = process.env.CHECK_DOC;
const DIR = process.env.CHECK_DIR;
if (!DOC || !DIR) { console.error("CHECK_DOC=<document id> and CHECK_DIR=<api temp dir> are required."); process.exit(2); }
const BASE = (process.env.CHECK_BASE || "http://127.0.0.1:3299").replace(/\/$/, "");
const API = (process.env.CHECK_API || "http://127.0.0.1:4299").replace(/\/$/, "");
const PRAXIS = (process.env.CHECK_PRAXIS || "http://127.0.0.1:4300").replace(/\/$/, "");
const OUT = resolve(process.env.CHECK_OUT || join(DIR, "browser-check"));
const FILE = join(DIR, "docs", "synthetic-client-brief.md");
const userToken = readFileSync(join(DIR, "operator-session.jwt"), "utf8").trim();
const deviceToken = readFileSync(join(DIR, "device-session.jwt"), "utf8").trim();
const NOTE = 'Change the "identity" column in the table below to be a summary of the documents instead of just listing what documents are available.';
const COMMENT = "Synthetic comment: summarise each document here instead of listing it.";
const SUMMARY = "Synthetic summary for the isolated delivery check.";
const DRAFT_KEY = `nexus:document-decision-note:${DOC}`;
const route = `/documents/${encodeURIComponent(DOC)}`;
mkdirSync(OUT, { recursive: true });

const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "nexus-decision-check-profile-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); }
}
if (!version) { chrome.kill(); console.error("Chrome did not expose its debugging port."); process.exit(2); }
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const requests = [];
const exceptions = [];
let step = "start";
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") {
        const { url, method, headers } = m.params.request;
        requests.push({ step, method, url, path: new URL(url).pathname, authorization: Object.keys(headers).some((h) => h.toLowerCase() === "authorization"), assertion: Object.keys(headers).some((h) => h.toLowerCase() === "cf-access-jwt-assertion") });
    }
    if (m.method === "Runtime.exceptionThrown") exceptions.push(`${step}: ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) || m.params.exceptionDetails?.text}`);
};
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
/** What the edge would add to every request from this session; {} is the plain Mac-app session. */
const session = (headers) => send("Network.setExtraHTTPHeaders", { headers });

const failures = [];
const fail = (message) => { failures.push(`${step}: ${message}`); console.log(`  FAIL ${step}: ${message}`); };
const check = (ok, message) => { if (!ok) fail(message); return ok; };
async function waitFor(expression, label, timeoutMs = 20000) {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
        if (await evalJs(expression)) return true;
        await sleep(250);
    }
    fail(`timed out waiting for ${label}`);
    return false;
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const text = async (sel) => (await evalJs(`${q(sel)}?.textContent ?? null`));
const exists = async (sel) => Boolean(await evalJs(`!!${q(sel)}`));
const click = async (sel) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; el.click(); return true; })()`), `clickable ${sel}`);
const clickButton = async (label) => check(await evalJs(`(() => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!el) return false; el.click(); return true; })()`), `button "${label}"`);
/** Type into a controlled field the way a keystroke does: native setter plus a bubbling input event. */
const typeInto = async (sel, value) => check(await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), `field ${sel}`);
const value = async (sel) => evalJs(`${q(sel)}?.value ?? null`);
const stored = async () => evalJs(`localStorage.getItem(${JSON.stringify(DRAFT_KEY)}) || sessionStorage.getItem(${JSON.stringify(DRAFT_KEY)})`);
async function shot(name) {
    const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (s.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(s.result.data, "base64"));
}
async function open() {
    await send("Page.navigate", { url: `${BASE}${route}` });
    await waitFor(`!!document.querySelector('[data-decision-card]') && !document.querySelector('[data-decision-card="unavailable"]')`, "the decision card");
}
/** After a decision or a reload the reader may reopen on the revision the review is pinned to; decisions need the current file. */
async function viewCurrentFile() {
    if (await exists("[data-decision-blocked]")) {
        await clickButton("View current file");
        await waitFor(`(${q("[data-decision-card]")}?.textContent || '').includes('Records your decision on rev')`, "the current-file decision card");
    }
}
async function reload() {
    await send("Page.reload", { ignoreCache: false });
    await sleep(500);
    await waitFor(`!!document.querySelector('[data-decision-card]')`, "the decision card after reload");
}
const api = async (path) => { const r = await fetch(`${API}${path}`); return { status: r.status, body: await r.json().catch(() => null) }; };
const history = async () => (await api(`/api/documents/${DOC}/history`)).body;
const report = { base: BASE, api: API, doc: DOC, startedAt: new Date().toISOString(), steps: {} };
const record = (name, facts) => { report.steps[name] = facts; console.log(`${name}: ${JSON.stringify(facts)}`); };

try {
    // Plain session, as the Mac app: no assertion, no bearer.
    step = "01-open";
    await session({});
    await open();
    const before = await history();
    const rev1 = before.current_revision_id;
    record(step, { status: await text("header [data-document-status]"), card: await evalJs(`${q("[data-decision-card]")}.dataset.decisionCard`), revisions: before.revisions.length, decisions: before.decisions.length });
    check(before.decisions.length === 0 && before.reviews.length === 0, "the fixture starts with no decision and no review");
    await shot(step);

    step = "02-comment";
    await click("[data-block-comment-button]");
    await waitFor(`!!document.querySelector('[data-composer] textarea')`, "the comment composer");
    await typeInto("[data-composer] textarea", COMMENT);
    await clickButton("Save comment");
    await waitFor(`(${q("[data-comment-list]")}?.textContent || '').includes(${JSON.stringify(COMMENT)})`, "the saved comment");
    const afterComment = (await api(`/api/documents/${DOC}`)).body;
    record(step, { reviewId: afterComment.review?.id, reviewRevision: afterComment.review?.revision_id, comments: afterComment.review?.comments?.length, status: afterComment.review?.status });
    check(afterComment.review?.revision_id === rev1 && afterComment.review?.comments?.length === 1, "the comment saved on a draft review pinned to the first revision");
    await shot(step);

    // A healthy store and an absent optional note must not be diagnosed as storage failure.
    step = "02b-empty-note";
    await session({ authorization: "Bearer local-dev-token" });
    check(await evalJs(`(() => { localStorage.setItem('healthy-probe', 'works'); const ok = localStorage.getItem('healthy-probe') === 'works'; localStorage.removeItem('healthy-probe'); return ok; })()`), "local storage works before blank-note refusals");
    const emptyNotices = {};
    for (const kind of ["approve", "request_changes"]) {
        await click(`[data-decision-button="${kind}"]`);
        await waitFor(`!!${q("textarea#decision-note")}`, "the empty optional note");
        check((await value("textarea#decision-note")) === "", "no note was typed");
        await click("[data-decision-submit]");
        await waitFor(`!!${q('[data-decision-notice="error"]')}`, "the blank-note refusal");
        const notice = await text('[data-decision-notice="error"]');
        check(!/note|storage/i.test(notice) && /Reload the app/.test(notice), "blank note keeps reload guidance without storage or note claims");
        emptyNotices[kind] = notice;
        await clickButton("Cancel");
    }
    record(step, emptyNotices);
    check((await history()).decisions.length === 0, "blank-note refusals recorded nothing");

    // No storage at all: the recovery must require copying while leaving the note editable.
    step = "03a-both-stores-unavailable";
    await session({ authorization: "Bearer local-dev-token" });
    await evalJs(`window.originalDraftSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new DOMException('quota', 'QuotaExceededError'); }`);
    await click('[data-decision-button="request_changes"]');
    await waitFor(`!!${q("textarea#decision-note")}`, "the decision note field");
    await typeInto("textarea#decision-note", NOTE);
    await click("[data-decision-submit]");
    await waitFor(`!!${q('[data-decision-notice="error"]')}`, "the storage failure notice");
    const unavailableNotice = await text('[data-decision-notice="error"]');
    check(/Copy your note before reloading/.test(unavailableNotice), "copy-before-reload guidance when both stores fail");
    check(!/kept on this device/.test(unavailableNotice), "no false persistence promise");
    check((await value("textarea#decision-note")) === NOTE && (await stored()) === null, "note remains editable, no persisted copy");
    record(step, { notice: unavailableNotice, noteKept: (await value("textarea#decision-note")) === NOTE, persisted: await stored() });
    await shot(step);
    await typeInto("textarea#decision-note", "");
    await evalJs(`Storage.prototype.setItem = window.originalDraftSetItem; delete window.originalDraftSetItem`);
    // Local quota failure through the recovery reload: prove sessionStorage restores the note.
    const quotaScript = `(() => { const original = Storage.prototype.setItem; window.originalDraftQuotaSetItem = original; Storage.prototype.setItem = function(k,v) { if (this === localStorage) throw new DOMException('quota', 'QuotaExceededError'); return original.call(this,k,v); }; })()`;
    const quotaInjection = await send("Page.addScriptToEvaluateOnNewDocument", { source: quotaScript });
    await evalJs(quotaScript);

    // The screenshot condition: the old client's placeholder bearer, no operator sign-in.
    step = "03-refused-placeholder-bearer";
    await session({ authorization: "Bearer local-dev-token" });
    await click('[data-decision-button="request_changes"]');
    await waitFor(`!!${q("textarea#decision-note")}`, "the decision note field");
    await typeInto("textarea#decision-note", NOTE);
    await click("[data-decision-submit]");
    await waitFor(`!!${q('[data-decision-notice="error"]')}`, "the refusal notice");
    let notice = await text('[data-decision-notice="error"]');
    record(step, { notice, noteKept: (await value("textarea#decision-note")) === NOTE, stored: JSON.parse((await stored()) || "null")?.revision_id ?? null, decisions: (await history()).decisions.length });
    check(/no operator sign-in, so the request fell back to a credential this Nexus does not have configured/.test(notice), "the screenshot refusal names the credential path with the reason");
    check(/Nothing was recorded and your note is kept on this device\. Reload the app and try again/.test(notice), "the refusal says nothing was recorded, the note is kept, and what to do");
    check((await value("textarea#decision-note")) === NOTE, "the note stays in the textarea");
    check(JSON.parse((await stored()) || "null")?.note === NOTE, "the note is kept on the device");
    check(await evalJs(`localStorage.getItem(${JSON.stringify(DRAFT_KEY)}) === null && JSON.parse(sessionStorage.getItem(${JSON.stringify(DRAFT_KEY)}))?.note === ${JSON.stringify(NOTE)}`), "sessionStorage preserved the note after localStorage quota failure");
    check((await history()).decisions.length === 0, "nothing was recorded");
    await shot(step);

    // The new client alone: no bearer, no session.
    step = "04-refused-no-session";
    await session({});
    await click("[data-decision-submit]");
    await waitFor(`(${q('[data-decision-notice="error"]')}?.textContent || '').includes('verified operator session')`, "the operator_required notice");
    notice = await text('[data-decision-notice="error"]');
    record(step, { notice, decisions: (await history()).decisions.length });
    check(/needs Robert’s verified operator session or operator credential; this request carries neither\. Nothing was recorded/.test(notice), "operator_required is explained and nothing recorded");
    check((await value("textarea#decision-note")) === NOTE, "the note is still there");
    await shot(step);

    step = "05-reload-recovers-note";
    await reload();
    await waitFor(`!!${q('[data-decision-draft="request_changes"]')}`, "the kept-note announcement");
    const announcement = await text('[data-decision-draft="request_changes"]');
    await click('[data-decision-button="request_changes"]');
    await waitFor(`!!${q("textarea#decision-note")}`, "the reopened note field");
    const restoredNote = await value("textarea#decision-note");
    const origin = await text('[data-decision-note-origin="restored"]');
    record(step, { announcement, restoredNote: restoredNote === NOTE, origin });
    check(/written for rev [0-9a-f]{8}, is kept on this device; open Request changes to continue/.test(announcement || ""), "the announcement names the revision and the button");
    check(restoredNote === NOTE, "the note is back after the reload");
    check(/Unsaved note restored from .+, written for rev [0-9a-f]{8}\./.test(origin || ""), "the panel says the note was restored and for which revision");
    await shot(step);

    // Later steps exercise healthy localStorage again, including after subsequent navigation.
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: quotaInjection.result.identifier });
    await evalJs(`Storage.prototype.setItem = window.originalDraftQuotaSetItem; delete window.originalDraftQuotaSetItem`);
    check(await evalJs(`(() => { localStorage.setItem('healthy-probe', 'works'); const ok = localStorage.getItem('healthy-probe') === 'works'; localStorage.removeItem('healthy-probe'); return ok; })()`), "localStorage restored after quota recovery check");

    // The producer changes the file: the next load captures a new revision.
    step = "06-file-changed";
    appendFileSync(FILE, "\n\nAddendum: the producer changed the brief after the review started.\n");
    await reload();
    await waitFor(`!!${q("[data-changed-banner]")}`, "the changed banner");
    await viewCurrentFile();
    await waitFor(`(${q("[data-decision-card]")}?.textContent || '').includes('Records your decision on rev')`, "the current-file decision card");
    const afterChange = await history();
    const rev2 = afterChange.current_revision_id;
    check(rev2 !== rev1 && afterChange.revisions.length === 2, "a second revision was captured");
    const hint = await text("[data-decision-draft]");
    await click('[data-decision-button="request_changes"]');
    await waitFor(`!!${q('[data-decision-note-origin="moved"]')}`, "the moved-origin line");
    const moved = await text('[data-decision-note-origin="moved"]');
    record(step, { rev1, rev2, hint, moved, note: (await value("textarea#decision-note")) === NOTE });
    check(/written for rev [0-9a-f]{8}; you are now deciding on rev [0-9a-f]{8}, so check that it still applies/.test(moved || ""), "the note names the revision it was written for and the one on screen");
    check((await value("textarea#decision-note")) === NOTE, "the note itself is unchanged");
    await shot(step);

    // Robert's verified session; the placeholder bearer rides along as a stale tab would send it.
    step = "07-session-records-request-changes";
    await session({ "cf-access-jwt-assertion": userToken, authorization: "Bearer local-dev-token" });
    await click("[data-decision-submit]");
    await waitFor(`!!${q('[data-decision-notice="ok"]')}`, "the recorded notice");
    const okNotice = await text('[data-decision-notice="ok"]');
    const afterDecision = await history();
    const decision = afterDecision.decisions.at(-1);
    const page = (await api(`/api/documents/${DOC}`)).body;
    record(step, { okNotice, decision: decision && { revision_id: decision.revision_id, authority: decision.authority, note: decision.note === NOTE, decision: decision.decision }, reviewRevision: afterDecision.reviews[0]?.revision_id, status: await text("header [data-document-status]"), stored: await stored() });
    check(/Changes requested rev [0-9a-f]{8}\. Nothing was sent or published\./.test(okNotice || ""), "the card reports the recorded decision");
    check(afterDecision.decisions.length === 1 && decision.decision === "request_changes" && decision.revision_id === rev2 && decision.authority === "access_user" && decision.note === NOTE, "one request_changes on the exact current revision, by the session, with the note");
    check(decision.content_hash === afterDecision.revisions.find((r) => r.id === rev2)?.content_hash, "the decision carries the current revision's content hash");
    check(afterDecision.reviews.length === 1 && afterDecision.reviews[0].revision_id === rev1 && afterDecision.reviews[0].comment_count === 1, "the review and its comment stay pinned to the first revision");
    check(page.review?.comments?.[0]?.body === COMMENT, "the comment text is intact");
    check((await stored()) === null, "the kept note is cleared once recorded");
    check((await text("header [data-document-status]")) === "Document: changes requested", "the header shows the document decision");
    await shot(step);

    step = "08-device-session-approves";
    await session({ "cf-access-jwt-assertion": deviceToken });
    await viewCurrentFile();
    await click('[data-decision-button="approve"]');
    await waitFor(`!!${q('[data-decision-confirm="approve"]')}`, "the approve panel");
    await click("[data-decision-submit]");
    await waitFor(`(${q('[data-decision-notice="ok"]')}?.textContent || '').trim().startsWith('Approved')`, "the approved notice");
    const afterApprove = await history();
    const approval = afterApprove.decisions.at(-1);
    record(step, { notice: await text('[data-decision-notice="ok"]'), approval: approval && { revision_id: approval.revision_id, authority: approval.authority, decision: approval.decision }, status: await text("header [data-document-status]") });
    check(afterApprove.decisions.length === 2 && approval.decision === "approve" && approval.revision_id === rev2 && approval.authority === "access_device", "the trusted device session approved the current revision");
    await shot(step);

    step = "09-executor-header-refused";
    await session({ "cf-access-jwt-assertion": userToken, "x-praxis-bridge-token": "synthetic-executor" });
    await viewCurrentFile();
    await click('[data-decision-button="request_changes"]');
    await waitFor(`!!${q('[data-decision-confirm="request_changes"]')}`, "the request-changes panel");
    await typeInto("textarea#decision-note", "Executor-shaped request; must be refused.");
    check(await evalJs(`JSON.parse(localStorage.getItem(${JSON.stringify(DRAFT_KEY)}))?.note === "Executor-shaped request; must be refused."`), "later note writes use healthy localStorage");
    await click("[data-decision-submit]");
    await waitFor(`!!${q('[data-decision-notice="error"]')}`, "the executor refusal");
    const refused = await text('[data-decision-notice="error"]');
    record(step, { notice: refused, decisions: (await history()).decisions.length });
    check((await history()).decisions.length === 2, "an executor-shaped request records nothing even with a session token");
    check(/Nothing was recorded/.test(refused || ""), "the refusal says nothing was recorded");
    // A note typed in this mount is announced once the panel closes; Discard note removes it from the device.
    await clickButton("Cancel");
    await waitFor(`!!${q("[data-decision-draft-discard]")}`, "the kept-note announcement with its discard control");
    await click("[data-decision-draft-discard]");
    check((await stored()) === null, "discarding clears the device copy");
    await shot(step);

    // Finish review is feedback only; it needs no operator session.
    step = "10-finish-review-delivers";
    await session({});
    await click("[data-finish-button]");
    await waitFor(`!!${q("[data-finish-panel]")}`, "the finish panel");
    await typeInto("textarea#review-summary-final", SUMMARY);
    await clickButton("Send to Praxis");
    await waitFor(`!!${q("[data-submission-card]")}`, "the submission card");
    const reviewId = afterComment.review.id;
    let submission = null;
    for (let i = 0; i < 40 && submission?.delivery_status !== "delivered"; i++) {
        submission = (await api(`/api/documents/reviews/${reviewId}/submission`)).body?.submission ?? null;
        if (submission?.delivery_status !== "delivered") await sleep(500);
    }
    await waitFor(`(() => { const t = ${q("[data-submission-card]")}?.textContent || ''; return /Delivered/.test(t) && !/Queued for delivery/.test(t); })()`, "the delivered state on the card");
    const relays = (await (await fetch(`${PRAXIS}/__relays`)).json());
    const finalHistory = await history();
    record(step, { submission: submission && { id: submission.id, delivery_status: submission.delivery_status, attempts: submission.delivery_attempts, receipt: Boolean(submission.receipt) }, relays: relays.map((r) => r.idempotencyKey), card: (await text("[data-submission-card]"))?.slice(0, 160), decisions: finalHistory.decisions.length });
    check(submission?.delivery_status === "delivered", "the submission was delivered to the synthetic receiver");
    check(relays.length === 1 && relays[0].idempotencyKey === `docreview:${submission?.id}`, "exactly one relay, keyed by the submission");
    check(finalHistory.decisions.length === 2, "Finish review recorded no decision");
    check(finalHistory.reviews[0].status === "submitted" && finalHistory.reviews[0].revision_id === rev1, "the submitted review is still the one pinned to the first revision");
    await shot(step);
} catch (err) {
    fail(`threw: ${err?.stack || err}`);
} finally {
    step = "end";
    const apiRequests = requests.filter((r) => r.url.startsWith(`${BASE}/api/`));
    const foreign = [...new Set(requests.filter((r) => !r.url.startsWith(BASE)).map((r) => new URL(r.url).origin))];
    const documentRequests = apiRequests.filter((r) => r.path.startsWith("/api/documents"));
    // Only the steps that deliberately emulate the old client or a stale tab may carry a bearer on a document request.
    const allowed = new Set(["02b-empty-note", "03a-both-stores-unavailable", "03-refused-placeholder-bearer", "07-session-records-request-changes"]);
    const bearerOnDocuments = documentRequests.filter((r) => r.authorization && !allowed.has(r.step)).map((r) => `${r.step} ${r.method} ${r.path}`);
    // Other page code still uses the shared helper's placeholder bearer (follow-up noted in the task record); listed, not failed.
    const bearerElsewhere = [...new Set(apiRequests.filter((r) => r.authorization && !r.path.startsWith("/api/documents") && !allowed.has(r.step)).map((r) => `${r.method} ${r.path}`))];
    const foreignRequests = [...new Set(requests.filter((r) => !r.url.startsWith(BASE)).map((r) => `${r.method} ${r.url.replace(/\?.*$/, "")}`))];
    report.network = { apiRequests: apiRequests.length, documentRequests: documentRequests.length, bearerOnDocuments, bearerElsewhere, otherOrigins: foreign, foreignRequests, exceptions };
    if (bearerOnDocuments.length) failures.push(`end: a document request carried an Authorization header outside the emulation steps (${bearerOnDocuments.join(", ")})`);
    if (exceptions.length) failures.push(`end: unexpected page exceptions (${exceptions.join("; ")})`);
    report.failures = failures;
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
    try { ws.close(); } catch { /* closing */ }
    chrome.kill();
    console.log(`other origins contacted: ${foreign.length ? foreignRequests.join(", ") : "none"}; placeholder bearer still sent by other page code on: ${bearerElsewhere.length ? bearerElsewhere.join(", ") : "none"}; page exceptions: ${exceptions.length}`);
    console.log(failures.length ? `FAILED (${failures.length}):\n  ${failures.join("\n  ")}` : "ALL CHECKS PASSED");
    console.log(`report: ${join(OUT, "report.json")}`);
    process.exit(failures.length ? 1 : 0);
}
