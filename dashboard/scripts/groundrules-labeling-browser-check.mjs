#!/usr/bin/env node
/**
 * Real-browser check of the Groundrules blind-labeling interface on an
 * isolated stack (task "Build a guided blind-labeling interface for
 * Groundrules in Nexus", 2026-10-09). One foreground process owns everything
 * it starts: the throwaway API (scripts/groundrules-labeling-check-api.cjs,
 * synthetic packet in a temp gold dir), a `next start` of a verify build on
 * CHECK_PORT, and headless Chrome. All are killed before this exits. Nothing
 * here touches the live :3000, :4000, nexus.db, Praxis, or the real
 * Groundrules gold set.
 *
 * Desktop (1440x1200) journey:
 *   01-task-entry       /task/<id>: the Start card sits ahead of the
 *                       description/source inventory, which is collapsed.
 *   02-start            the card's link opens /task/<id>/labeling; the start
 *                       screen shows counts and digests and no Part B/C text;
 *                       Start needs the operator credential.
 *   03-stage-a-save     passage 1: modality, actor via "Pick words", declared
 *                       none; the chip reads Saved only after the API ack.
 *   04-reload-resume    a reload restores the saved passage from the server.
 *   05-stale-packet     the fixture packet changes on disk: the save is
 *                       refused, the conflict is visible, a deliberate rebind
 *                       carries the answer over as a draft.
 *   06-commit           the review refuses while rows are open, then commits;
 *                       Stage A freezes; nothing from Part B has been fetched.
 *   07-stage-b          the reveal gate is the only way in; the first fetch is
 *                       the recorded exposure; verdicts save.
 *   08-stage-c          Part C opens through its gate; an answer saves.
 *   09-revision         a post-exposure change to a Stage A row is recorded as
 *                       a revision, the blind baseline stays as committed.
 *   10-export           the Stage A export lands in the temp gold dir only.
 * Mobile (390x844, touch):
 *   11-mobile-task      the Start action is inside the first viewport.
 *   12-mobile-form      the form has no horizontal overflow, the bottom nav
 *                       is visible, word picking works by tap.
 *
 *   cd dashboard && NEXT_DIST_DIR=.next-groundrules-verify NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 npm run build
 *   node scripts/groundrules-labeling-browser-check.mjs
 *
 * Env: CHECK_DIST (.next-groundrules-verify), CHECK_PORT (3299), CHECK_API_PORT
 * (4299), CHECK_OUT (temp dir), CHECK_CHROME. Writes <out>/<step>.png and
 * <out>/report.json; exits 1 on any failed check.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const DIST = process.env.CHECK_DIST || ".next-groundrules-verify";
if (!existsSync(join(DASHBOARD, DIST, "BUILD_ID"))) { console.error(`No build at ${DIST}; run the verify build first.`); process.exit(2); }
const PORT = Number(process.env.CHECK_PORT || 3299);
const API_PORT = Number(process.env.CHECK_API_PORT || 4299);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const REAL_GOLD = "/Volumes/Projects/Groundrules.club/data/ledger/gold-set";
const OUT = resolve(process.env.CHECK_OUT || mkdtempSync(join(tmpdir(), "nexus-groundrules-browser-check-")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function child(cmd, args, opts) {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    c.output = "";
    c.stdout.on("data", (d) => { c.output += d; });
    c.stderr.on("data", (d) => { c.output += d; });
    children.push(c);
    return c;
}
async function waitForOutput(c, needle, ms, label) {
    const t0 = Date.now();
    while (!c.output.includes(needle)) {
        if (c.exitCode !== null) throw new Error(`${label} exited early:\n${c.output.slice(-2000)}`);
        if (Date.now() - t0 > ms) throw new Error(`${label} did not print ${JSON.stringify(needle)} in time:\n${c.output.slice(-2000)}`);
        await sleep(200);
    }
}
async function waitForHttp(url, ms, label) {
    const t0 = Date.now();
    for (;;) {
        try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
        if (Date.now() - t0 > ms) throw new Error(`${label} not reachable at ${url}`);
        await sleep(250);
    }
}

// ── Stack ───────────────────────────────────────────────────────────────────
const api = child("node", [join(DASHBOARD, "scripts", "groundrules-labeling-check-api.cjs")], { cwd: resolve(DASHBOARD, ".."), env: { ...process.env, CHECK_API_PORT: String(API_PORT) } });
await waitForOutput(api, "READY", 30000, "check API");
const TASK = api.output.match(/^CHECK_TASK=(.*)$/m)[1];
const KEY = api.output.match(/^CHECK_KEY=(.*)$/m)[1];
const GOLD = api.output.match(/^CHECK_GOLD=(.*)$/m)[1];
const PACKET_SHA = api.output.match(/^CHECK_PACKET_SHA=(.*)$/m)[1];
const next = child(join(DASHBOARD, "node_modules", ".bin", "next"), ["start", "-p", String(PORT)], { cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: DIST, PORT: String(PORT) } });
await waitForHttp(`${BASE}/`, 60000, "next start");

const cdpPort = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "nexus-groundrules-check-profile-"));
const chrome = child(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1200", "about:blank"]);
let version = null;
for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch { await sleep(200); }
}
if (!version) { children.forEach((c) => c.kill()); console.error("Chrome did not expose its debugging port."); process.exit(2); }
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json();
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
        const { url, method } = m.params.request;
        try { requests.push({ step, method, url, origin: new URL(url).origin, path: new URL(url).pathname }); } catch { /* data: urls */ }
    }
    if (m.method === "Runtime.exceptionThrown") exceptions.push(`${step}: ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) || m.params.exceptionDetails?.text}`);
};
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
const desktop = () => send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
const mobile = async () => { await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }); };
await desktop();
const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`page eval failed: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    return r.result?.result?.value;
};

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
const text = async (sel) => evalJs(`${q(sel)}?.textContent ?? null`);
const exists = async (sel) => Boolean(await evalJs(`!!${q(sel)}`));
const attr = async (sel, name) => evalJs(`${q(sel)}?.getAttribute(${JSON.stringify(name)}) ?? null`);
const click = async (sel) => { const ok = await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`); if (!ok) fail(`nothing to click at ${sel}`); await sleep(150); return ok; };
/** Native-setter typing so React's controlled inputs see the change. */
const type = async (sel, value) => { const ok = await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value"); d.set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`); if (!ok) fail(`nothing to type into at ${sel}`); await sleep(100); return ok; };
const select = async (sel, value) => { const ok = await evalJs(`(() => { const el = ${q(sel)}; if (!el) return false; const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value"); d.set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`); if (!ok) fail(`no select at ${sel}`); await sleep(100); return ok; };
const radio = (name, value) => `input[name="${name}"][value="${value}"]`;
const saved = (timeout = 15000) => waitFor(`${q("[data-save-status]")}?.dataset.saveStatus === "saved"`, "the Saved chip (server ack)", timeout);
const bodyHas = (s) => evalJs(`document.body.textContent.includes(${JSON.stringify(s)})`);
const apiLog = async () => (await (await fetch(`${API}/__log`)).json()).log;
const stageBReads = (log) => log.filter((l) => /^GET .*\/stages\/B$/.test(l)).length;
const stageCReads = (log) => log.filter((l) => /^GET .*\/stages\/C$/.test(l)).length;
const reveals = (log, stage) => log.filter((l) => new RegExp(`^POST .*/reveal/${stage}$`).test(l)).length;
// The deliberate reveal (a POST) must precede the one read of that stage.
const revealBeforeRead = (log, stage) => {
  const r = log.findIndex((l) => new RegExp(`^POST .*/reveal/${stage}$`).test(l));
  const g = log.findIndex((l) => new RegExp(`^GET .*/stages/${stage}$`).test(l));
  return r >= 0 && g > r;
};
async function shot(name) {
    const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (s.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(s.result.data, "base64"));
}
async function open(route, readySel, label) {
    await send("Page.navigate", { url: `${BASE}${route}` });
    await waitFor(`!!${q(readySel)}`, label);
}
const report = { base: BASE, api: API, dist: DIST, task: TASK, goldDir: GOLD, packetSha256: PACKET_SHA, startedAt: new Date().toISOString(), steps: {} };
const record = (name, facts) => { report.steps[name] = facts; console.log(`${name}: ${JSON.stringify(facts)}`); };
/** Every form control inside the workbench has a label, aria-label or aria-labelledby. */
const unlabeled = () => evalJs(`[...document.querySelectorAll('[data-stage-a-form] input, [data-stage-a-form] textarea, [data-stage-a-form] select, [data-stage-b-form] input, [data-stage-b-form] textarea, [data-stage-c-form] input, [data-stage-c-form] textarea')].filter(el => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map(el => el.id || el.name || el.tagName)`);

const LABELING = `/task/${TASK}/labeling`;
try {
    // 01: the task page: Start card ahead of the inventory.
    step = "01-task-entry";
    await open(`/task/${TASK}`, "[data-labeling-entry]", "the labeling entry card on the task page");
    await sleep(400);
    const entryFacts = {
        action: await text("[data-labeling-action]"),
        href: await attr("[data-labeling-action]", "href"),
        description: await attr("[data-description]", "data-description"),
        entryBeforeDescription: await evalJs(`(() => { const a = ${q("[data-labeling-entry]")}; const d = ${q("[data-description]")}; return !!(a && d) && Boolean(a.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING); })()`),
        entryTop: await evalJs(`${q("[data-labeling-entry]")}?.getBoundingClientRect().top`),
        inventoryShown: await bodyHas("Source 40: synthetic library act section 40"),
        explanation: await text("[data-labeling-entry] p"),
    };
    record(step, entryFacts);
    check(entryFacts.action?.trim() === "Start labeling" && entryFacts.href === LABELING, "the task page offers one Start labeling action linking to the labeling route");
    check(entryFacts.entryBeforeDescription && entryFacts.description === "collapsed" && !entryFacts.inventoryShown, "the entry card precedes the description, and the source inventory is folded away");
    check(entryFacts.entryTop !== null && entryFacts.entryTop < 1200, "the entry card is inside the first desktop viewport");
    await shot(step);
    await click("[data-description] button");
    await sleep(200);
    check((await attr("[data-description]", "data-description")) === "open" && (await bodyHas("Source 40: synthetic library act section 40")), "the inventory can still be opened on demand");

    // 02: the start screen, credential, session.
    step = "02-start";
    await click("[data-labeling-action]");
    await waitFor(`!!${q("[data-start-card]")}`, "the start screen after the client navigation");
    await sleep(300);
    const startFacts = {
        url: await evalJs("location.pathname"),
        counts: await text("[data-start-card]"),
        bLeak: (await bodyHas("accept or reject")) || (await bodyHas("within ten days after an item becomes overdue")),
        cLeak: await bodyHas("unless the fine is waived"),
        startDisabled: await evalJs(`${q("[data-start-labeling]")}?.disabled`),
        credential: await attr("[data-credential-panel]", "data-credential-panel"),
        digest: await bodyHas(PACKET_SHA.slice(0, 12)),
        definitions: await exists("[data-definitions]"),
    };
    record(step, startFacts);
    check(startFacts.url === LABELING, "the Start action lands on /task/<id>/labeling");
    check(/3 passages in 2 provisions/.test(startFacts.counts || "") && /2 control judgments/.test(startFacts.counts || ""), "the start screen states the packet counts");
    check(!startFacts.bLeak && !startFacts.cLeak, "no Part B or Part C text on screen before Stage A");
    check(startFacts.startDisabled === true && startFacts.credential === "needed", "Start is disabled until the operator credential is set");
    await type("[data-operator-key]", KEY);
    await click("[data-use-key]");
    check((await attr("[data-credential-panel]", "data-credential-panel")) === "set", "the credential panel acknowledges the key");
    await shot(step);
    await click("[data-start-labeling]");
    await waitFor(`!!${q("[data-stage-a-form]")}`, "the first Stage A passage");
    await sleep(300);
    const sessionFacts = { position: await text("[data-position]"), notice: await text("[data-notice]"), bLocked: await attr('[data-stage-tab="B"]', "data-stage-unlocked"), unlabeled: await unlabeled(), passage: await text('[data-passage="row"]') };
    record(`${step}-session`, sessionFacts);
    check(sessionFacts.position === "Passage 1 of 3" && sessionFacts.bLocked === "false", "the session opens on passage 1 with Part B locked");
    check(Array.isArray(sessionFacts.unlabeled) && sessionFacts.unlabeled.length === 0, `every Stage A control is labelled (${JSON.stringify(sessionFacts.unlabeled)})`);
    check(/A card holder may borrow/.test(sessionFacts.passage || ""), "the passage text is on screen");

    // 03: passage 1: save after the server ack.
    step = "03-stage-a-save";
    await click(radio("a-0-modality", "may"));
    await saved();
    const afterFirst = { chip: await text("[data-save-status]"), state: await attr('[data-index-item="lib-loans.limit"]', "data-index-state"), errors: await evalJs(`[...document.querySelectorAll('[data-field-error]')].map(e => e.textContent)`) };
    record(`${step}-draft`, afterFirst);
    check(/Saved/.test(afterFirst.chip || "") && afterFirst.state === "draft", "a partial answer is saved as a draft with a Saved chip");
    check(afterFirst.errors.some((e) => /Quote the exact words/.test(e)), "the missing actor quote is a visible field error");
    await click('[data-pick-for="a-0-actor-quote"]');
    await click('[data-passage="row"] [data-pick-words]');
    await click('[data-passage="row"] button[data-word="0"]');
    await click('[data-passage="row"] button[data-word="2"]');
    const picked = await evalJs(`${q("#a-0-actor-quote")}?.value`);
    check(picked === "A card holder", `picking the first and third words fills the actor quote (got ${JSON.stringify(picked)})`);
    await click(radio("a-0-declared", "none"));
    await saved();
    const complete1 = { state: await attr('[data-index-item="lib-loans.limit"]', "data-index-state"), progress: await text('[data-stage-progress="A"]'), highlighted: await evalJs(`[...document.querySelectorAll('[data-passage="row"] [data-word]')].slice(0,3).every(w => /bg-cyan/.test(w.className))`) };
    record(step, complete1);
    check(complete1.state === "complete" && /1 of 3 complete/.test(complete1.progress || ""), "passage 1 counts as complete once every required field resolves");
    check(complete1.highlighted === true, "the actor quote is highlighted in the passage");
    await shot(step);

    // 04: reload: the server record comes back.
    step = "04-reload-resume";
    await send("Page.reload", { ignoreCache: true });
    await waitFor(`!!${q("[data-stage-a-form]")}`, "the workbench after a reload");
    await sleep(400);
    await click("[data-prev]"); // landing goes to the first open passage (2); step back to 1
    await sleep(200);
    const resumed = { position: await text("[data-position]"), actor: await evalJs(`${q("#a-0-actor-quote")}?.value`), modality: await evalJs(`${q(radio("a-0-modality", "may"))}?.checked`), state: await attr('[data-index-item="lib-loans.limit"]', "data-index-state"), startCard: await exists("[data-start-card]") };
    record(step, resumed);
    check(!resumed.startCard && resumed.position === "Passage 1 of 3" && resumed.actor === "A card holder" && resumed.modality === true && resumed.state === "complete", "the reload resumes the session with passage 1 restored from the server");
    await shot(step);

    // 05: the packet changes on disk; the save is refused; deliberate rebind.
    step = "05-stale-packet";
    const moved = await (await fetch(`${API}/__packet/moved`, { method: "POST" })).json();
    await type("#a-0-notes", "typed after the packet moved");
    await waitFor(`${q("[data-save-status]")}?.dataset.saveStatus === "error"`, "the refused save");
    await waitFor(`!!${q("[data-packet-conflict]")}`, "the packet conflict panel");
    const staleFacts = { newSha: moved.sha256, chip: await text("[data-save-status]"), conflict: await text("[data-packet-conflict]"), rebindDisabled: await evalJs(`${q("[data-rebind]")}?.disabled`), notesKept: await evalJs(`${q("#a-0-notes")}?.value`) };
    record(step, staleFacts);
    check(staleFacts.newSha !== PACKET_SHA && /Not saved/.test(staleFacts.chip || ""), "a save against a changed packet is refused and shown as not saved");
    check(/changed/.test(staleFacts.conflict || "") && staleFacts.rebindDisabled === true, "the conflict names the change and rebinding needs explicit confirmation");
    check(staleFacts.notesKept === "typed after the packet moved", "the unsaved text stays on screen");
    await shot(step);
    await click('[data-packet-conflict] input[type="checkbox"]');
    await click("[data-rebind]");
    await waitFor(`!${q("[data-packet-conflict]")} && !!${q("[data-stage-a-form]")}`, "the rebound session");
    await sleep(300);
    const rebound = { notice: await text("[data-notice]"), state: await attr('[data-index-item="lib-loans.limit"]', "data-index-state") };
    record(`${step}-rebind`, rebound);
    check(/carried over as drafts/.test(rebound.notice || "") && rebound.state === "draft", "the answer is carried into the new session as a draft, not silently re-bound");
    // Re-check passage 1 against the current packet and save it again.
    await click("[data-prev]"); await click("[data-prev]");
    await type("#a-0-notes", "re-checked after rebind");
    await saved();
    check((await attr('[data-index-item="lib-loans.limit"]', "data-index-state")) === "complete", "after review the carried answer is complete again");

    // 06: rows 2 and 3, review, commit.
    step = "06-commit";
    await click("[data-next]");
    await click(radio("a-1-modality", "shall"));
    await type("#a-1-actor-quote", "The library shall");
    await click(radio("a-1-declared", "none"));
    await saved();
    await click("[data-next]");
    await click(radio("a-2-modality", "is"));
    await type("#a-2-actor-quote", "a refusal to renew");
    await click(radio("a-2-declared", "some"));
    await click("[data-add-proposition]");
    await select("#a-2-prop-0-category", "condition");
    await type("#a-2-prop-0-quote", "who has paid every fine");
    await saved();
    await click("[data-unsure] input");
    await saved();
    await click("[data-open-review]");
    await sleep(200);
    const review1 = { text: await text('[data-commit-review="A"]'), unsureState: await attr('[data-review-item="lib-renewal.rule"]', "data-review-state"), commitDisabled: await evalJs(`${q("[data-commit]")}?.disabled`) };
    record(`${step}-refused`, review1);
    check(/1 of 3 items still need work/.test(review1.text || "") && review1.unsureState === "unsure" && review1.commitDisabled === true, "the review refuses to commit while a passage is marked unsure");
    await shot(`${step}-refused`);
    await click('[data-review-item="lib-renewal.rule"] button');
    await click("[data-unsure] input");
    await saved();
    await click("[data-open-review]");
    await sleep(200);
    const logBefore = await apiLog();
    check(stageBReads(logBefore) === 0, "no Part B read has happened before the commit");
    await click("[data-commit]");
    await waitFor(`/Stage A committed/.test(${q("[data-notice]")}?.textContent || "")`, "the commit notice");
    await sleep(300);
    const committed = { notice: await text("[data-notice]"), aProgress: await text('[data-stage-progress="A"]'), bUnlocked: await attr('[data-stage-tab="B"]', "data-stage-unlocked"), cUnlocked: await attr('[data-stage-tab="C"]', "data-stage-unlocked"), frozen: await exists("[data-frozen]"), bReadsAfterCommit: stageBReads(await apiLog()), bLeak: await bodyHas("within ten days after an item becomes overdue") };
    record(step, committed);
    check(/committed/.test(committed.aProgress || "") && committed.bUnlocked === "true" && committed.cUnlocked === "false" && committed.frozen, "the commit freezes Stage A and unlocks Part B only");
    check(committed.bReadsAfterCommit === 0 && !committed.bLeak, "committing does not fetch or show Part B");
    await shot(step);

    // 07: Part B through its gate.
    step = "07-stage-b";
    await click('[data-stage-tab="B"]');
    await sleep(200);
    const gate = { shown: await exists('[data-reveal-gate="B"]'), reads: stageBReads(await apiLog()), reveals: reveals(await apiLog(), "B"), leak: await bodyHas("within ten days after an item becomes overdue") };
    record(`${step}-gate`, gate);
    check(gate.shown && gate.reads === 0 && gate.reveals === 0 && !gate.leak, "the gate is shown and nothing has been revealed or fetched yet");
    await shot(`${step}-gate`);
    await click('[data-open-stage="B"]');
    await waitFor(`!!${q('[data-stage-b-form="ctl-s1"]')}`, "the first control fixture");
    await sleep(300);
    const logB = await apiLog();
    const b = { reads: stageBReads(logB), reveals: reveals(logB, "B"), revealFirst: revealBeforeRead(logB, "B"), position: await text("[data-position]"), reading: await text("[data-committed-reading]"), proposal: await text("[data-proposal]"), keyLeak: await bodyHas("expected"), unlabeled: await unlabeled() };
    record(step, b);
    check(b.reads === 1 && b.reveals === 1 && b.revealFirst && b.position === "Fixture 1 of 2" && /shall/.test(b.reading || "") && /within ten days/.test(b.proposal || ""), "opening the gate is one deliberate reveal followed by the one Part B read; the fixture shows the committed reading and the proposal");
    check(!b.keyLeak, "no answer key or scoring hint on the Part B form");
    check(Array.isArray(b.unlabeled) && b.unlabeled.length === 0, "every Part B control is labelled");
    await click(radio("b-0-verdict", "reject"));
    await saved();
    await click("[data-next]");
    await click(radio("b-1-verdict", "different"));
    await saved();
    await click("[data-open-review]");
    await sleep(200);
    await click("[data-commit]");
    await waitFor(`/Stage B committed/.test(${q("[data-notice]")}?.textContent || "")`, "the Part B commit notice");
    await shot(step);

    // 08: Part C through its gate.
    step = "08-stage-c";
    await click('[data-stage-tab="C"]');
    await sleep(200);
    check((await exists('[data-reveal-gate="C"]')) && stageCReads(await apiLog()) === 0 && reveals(await apiLog(), "C") === 0, "Part C has its own gate and no reveal or read before it");
    await click('[data-open-stage="C"]');
    await waitFor(`!!${q("[data-stage-c-form]")}`, "the pair form");
    await sleep(300);
    const c = { reads: stageCReads(await apiLog()), versions: await evalJs(`[...document.querySelectorAll('[data-version]')].map(v => v.getAttribute('data-version'))`), example: await text("[data-example]"), unlabeled: await unlabeled() };
    record(step, c);
    check(c.reads === 1 && revealBeforeRead(await apiLog(), "C") && JSON.stringify(c.versions) === JSON.stringify(["original", "mutant"]) && /waiver/.test(c.example || ""), "the pair form opens through its own reveal and shows both versions and the worked example");
    await click(radio("c-0-exampleOutcomeSame", "yes"));
    await click(radio("c-0-meaning", "different"));
    await saved();
    const cErrors = await evalJs(`[...document.querySelectorAll('[data-field-error]')].map(e => e.textContent)`);
    check(cErrors.some((e) => /describe a case/.test(e)), "answering different asks for the diverging case");
    await type("#c-0-diverging", "A holder whose fine was waived would still owe it under the mutant.");
    await saved();
    check((await attr('[data-index-item="vpu-s1"]', "data-index-state")) === "complete", "the pair is complete once the diverging case is given");
    await shot(step);

    // 09: a change of mind after exposure is a revision, not an edit.
    step = "09-revision";
    await click('[data-stage-tab="A"]');
    await sleep(200);
    await click("[data-revise]");
    await click(radio("rev-0-modality", "shall"));
    await click("[data-record-revision]");
    await waitFor(`!!${q("[data-revision]")}`, "the recorded revision");
    const rev = { text: await text("[data-revision]"), baselineFrozen: await evalJs(`${q(radio("a-0-modality", "may"))}?.checked`), actorDisabled: await evalJs(`${q("#a-0-actor-quote")}?.disabled`) };
    record(step, rev);
    check(/after exposure to B and C/.test(rev.text || "") && /not blind/.test(rev.text || ""), "the revision carries its exposure provenance and is marked not blind");
    check(rev.baselineFrozen === true && rev.actorDisabled === true, "the committed blind answer stays as committed");
    await shot(step);

    // 10: export to the temp gold dir only.
    step = "10-export";
    await evalJs(`${q("[data-export-panel]")}.open = true`);
    await click('[data-export-button="A"]');
    await waitFor(`!!${q('[data-export="A"] [data-export-result]')}`, "the export result");
    const files = await (await fetch(`${API}/__exports`)).json();
    const exp = { result: await text('[data-export="A"] [data-export-result]'), files: files.files, goldDir: files.goldDir, realGoldLabels: existsSync(join(REAL_GOLD, "labels")), realGoldJudgments: existsSync(join(REAL_GOLD, "judgments")), realGoldPost: existsSync(join(REAL_GOLD, "post-exposure")) };
    record(step, exp);
    check(exp.files.includes("labels/robert.json") && exp.goldDir === GOLD, "the Stage A export is written into the temp gold dir");
    check(!exp.realGoldLabels && !exp.realGoldJudgments && !exp.realGoldPost, "the real Groundrules gold set gained no label, judgment or post-exposure files");
    await shot(step);

    // 11: mobile: the Start action sits in the first viewport.
    step = "11-mobile-task";
    await mobile();
    await open(`/task/${TASK}`, "[data-labeling-entry]", "the task page on a phone");
    await sleep(500);
    const m1 = { actionTop: await evalJs(`${q("[data-labeling-action]")}?.getBoundingClientRect().top`), actionBottom: await evalJs(`${q("[data-labeling-action]")}?.getBoundingClientRect().bottom`), innerHeight: await evalJs("window.innerHeight"), overflow: await evalJs("document.documentElement.scrollWidth - window.innerWidth"), description: await attr("[data-description]", "data-description"), action: await text("[data-labeling-action]") };
    record(step, m1);
    check(m1.actionTop !== null && m1.actionBottom <= m1.innerHeight, "the labeling action is inside the first phone viewport");
    check(m1.overflow <= 0, "the task page has no horizontal overflow on a phone");
    check(m1.action?.trim() === "Continue labeling" && m1.description === "collapsed", "the task page now offers Continue labeling, inventory still folded");
    await shot(step);

    // 12: mobile: the form itself.
    step = "12-mobile-form";
    await click("[data-labeling-action]");
    await waitFor(`!!${q("[data-position]")}`, "the workbench on a phone");
    await sleep(400);
    const landed = await text("[data-position]");
    await click('[data-stage-tab="A"]');
    await waitFor(`!!${q("[data-stage-a-form]")}`, "the Stage A form on a phone");
    await sleep(300);
    const m2 = { landed, overflow: await evalJs("document.documentElement.scrollWidth - window.innerWidth"), nav: await evalJs(`(() => { const n = ${q("[data-mobile-nav]")}; return n ? getComputedStyle(n).display : null; })()`), position: await text("[data-position]"), tapTargets: await evalJs(`[...document.querySelectorAll('[data-mobile-nav] button')].map(b => b.getBoundingClientRect().height)`), formWidth: await evalJs(`${q("[data-stage-a-form]")}?.getBoundingClientRect().width ?? null`), innerWidth: await evalJs("window.innerWidth") };
    record(step, m2);
    check(m2.landed === "Pair 1 of 1", "the phone resumes where the desktop left off (Part C)");
    check(m2.overflow <= 0 && m2.formWidth !== null && m2.formWidth <= m2.innerWidth, "the form fits the phone width");
    check(m2.nav !== null && m2.nav !== "none" && m2.tapTargets.every((h) => h >= 36), "the bottom prev/next bar is visible with tappable buttons");
    await shot(step);
    // The committed stage is read-only; the revision form proves the tap path:
    // open it and pick two words for the actor by tapping them.
    await click("[data-revise]");
    await waitFor(`!!${q("[data-revision-form] [data-pick-for]")}`, "the revision form");
    await click('[data-revision-form] [data-pick-for]');
    await click('[data-revision-form] [data-passage="row"] [data-pick-words]');
    const tapSizes = await evalJs(`[...document.querySelectorAll('[data-revision-form] [data-passage="row"] button[data-word]')].slice(0, 3).map(b => b.getBoundingClientRect().height)`);
    await click('[data-revision-form] [data-passage="row"] button[data-word="0"]');
    await click('[data-revision-form] [data-passage="row"] button[data-word="2"]');
    const tapped = await evalJs(`${q("[data-revision-form] textarea")}?.value ?? null`);
    const m3 = { tapSizes, tapped, overflow: await evalJs("document.documentElement.scrollWidth - window.innerWidth"), unlabeled: await unlabeled() };
    record(`${step}-revision`, m3);
    check(tapped === "A card holder" && tapSizes.every((h) => h >= 24), "tapping the first and third words fills the quote on a phone");
    check(m3.overflow <= 0 && m3.unlabeled.length === 0, "the revision form fits the phone and every control is labelled");
    await shot(`${step}-revision`);
} catch (error) {
    fail(`unexpected error: ${error?.stack || error}`);
} finally {
    let log = null;
    try { log = await apiLog(); } catch { /* stack gone */ }
    const writes = (log || []).filter((l) => !/^GET /.test(l));
    // The dashboard shell opens its Socket.IO feed and the chat drawer's
    // /api/chat/active poll (cortex-provider) against the default API origin
    // on every page; both pre-date this feature and are not part of the
    // check. Anything else reaching outside the stack is a failure.
    const other = requests.filter((r) => r.origin !== BASE && r.origin !== API);
    const otherNonSocket = other.filter((r) => !r.path.startsWith("/socket.io/") && r.path !== "/api/chat/active");
    report.network = {
        pageRequests: requests.length,
        apiWrites: writes,
        stageBReads: log ? stageBReads(log) : null,
        stageCReads: log ? stageCReads(log) : null,
        otherOrigins: [...new Set(other.map((r) => r.origin))],
        otherRequests: [...new Set(other.map((r) => `${r.method} ${r.origin}${r.path}`))],
        exceptions,
    };
    check(otherNonSocket.length === 0, `apart from the shell's Socket.IO feed, the pages contacted no other origin (${[...new Set(otherNonSocket.map((r) => r.origin + r.path))].join(", ")})`);
    check(exceptions.length === 0, `no page exceptions (${exceptions.join(" | ").slice(0, 400)})`);
    report.failures = failures;
    report.finishedAt = new Date().toISOString();
    report.out = OUT;
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
    try { ws.close(); } catch { /* already closed */ }
    for (const c of children) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
    await sleep(500);
    for (const c of children) { if (c.exitCode === null) { try { c.kill("SIGKILL"); } catch { /* gone */ } } }
    console.log(`API writes: ${writes.length}; Part B reads: ${report.network.stageBReads}; Part C reads: ${report.network.stageCReads}; page exceptions: ${exceptions.length}`);
    console.log(failures.length ? `FAILED (${failures.length}):\n  ${failures.join("\n  ")}` : "ALL CHECKS PASSED");
    console.log(`report: ${join(OUT, "report.json")}`);
    process.exit(failures.length ? 1 : 0);
}
