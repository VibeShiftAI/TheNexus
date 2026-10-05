#!/usr/bin/env node
/**
 * Real-browser check that Today's Schedule shows chat-dispatched work, on an
 * isolated stack (task "Show chat-dispatched work and its queue in Today's
 * Schedule", 2026-10-04). One foreground process owns everything it starts:
 * the throwaway API + fake Praxis (scripts/schedule-live-work-check-api.cjs),
 * a `next start` of a verify build on CHECK_PORT, and headless Chrome. All
 * three are killed before this exits. Nothing here touches the live :3000,
 * :4000, :54322 or nexus.db.
 *
 * Steps (home `/` is the ScheduleTimeline panel, `/calendar` the grid):
 *   01-home-queue       no day plan + a queue: running, queued #1/#2 and the
 *                       linked successor appear as rows linking to their tasks;
 *                       the queued task that also has a day-plan slot is ONE
 *                       row (badge on the slot); the completed [Ad-hoc] event
 *                       is not doubled; nothing says a board idea is queued.
 *   02-calendar-queue   the /calendar strip lists the same tasks; the slot
 *                       block carries the badge.
 *   03-slot-freed       the fake Praxis moves the queue head into the running
 *                       slot; the home panel follows WITHOUT a reload (live
 *                       refetch or the 60s fallback poll); /calendar agrees.
 *   04-qa               the implementation finished and QA is running: the row
 *                       says so and never says completed or passed.
 *   05-unreachable      Praxis goes away: the last rows stay, marked stale;
 *                       after a reload the panel says the queue is unavailable
 *                       and shows no rows (never "nothing queued").
 *   06-empty            a live read with nothing in flight: the calendar rows
 *                       stand alone and /calendar says nothing is queued.
 *   Network: every API request the pages made is a GET; the throwaway API and
 *   the fake Praxis received no write (only this script's scenario switches).
 *
 *   cd dashboard && NEXT_DIST_DIR=.next-live-work-verify NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 npm run build
 *   node scripts/schedule-live-work-browser-check.mjs
 *
 * Env: CHECK_DIST (.next-live-work-verify), CHECK_PORT (3299), CHECK_API_PORT
 * (4299), CHECK_PRAXIS_PORT (4300), CHECK_OUT (temp dir), CHECK_CHROME.
 * Writes <out>/<step>.png and <out>/report.json; exits 1 on any failed check.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const DIST = process.env.CHECK_DIST || ".next-live-work-verify";
if (!existsSync(join(DASHBOARD, DIST, "BUILD_ID"))) { console.error(`No build at ${DIST}; run the verify build first.`); process.exit(2); }
const PORT = Number(process.env.CHECK_PORT || 3299);
const API_PORT = Number(process.env.CHECK_API_PORT || 4299);
const PRAXIS_PORT = Number(process.env.CHECK_PRAXIS_PORT || 4300);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const PRAXIS = `http://127.0.0.1:${PRAXIS_PORT}`;
const OUT = resolve(process.env.CHECK_OUT || mkdtempSync(join(tmpdir(), "nexus-live-work-browser-check-")));
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
const api = child("node", [join(DASHBOARD, "scripts", "schedule-live-work-check-api.cjs")], { cwd: resolve(DASHBOARD, ".."), env: { ...process.env, CHECK_API_PORT: String(API_PORT), CHECK_PRAXIS_PORT: String(PRAXIS_PORT) } });
await waitForOutput(api, "READY", 20000, "check API");
const ids = JSON.parse(api.output.match(/^CHECK_IDS=(.*)$/m)[1]);
// The seeded titles (ids.json next to the temp db) let the checks name a task
// in the "up next" footer and the title links.
const checkDir = api.output.match(/^CHECK_DIR=(.*)$/m)[1];
ids.titles = JSON.parse(readFileSync(join(checkDir, "ids.json"), "utf8")).titles;
const next = child(join(DASHBOARD, "node_modules", ".bin", "next"), ["start", "-p", String(PORT)], { cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: DIST, PORT: String(PORT) } });
await waitForHttp(`${BASE}/`, 60000, "next start");

const cdpPort = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "nexus-live-work-check-profile-"));
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
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

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
/** [lane, taskId] for every live row on the page, in DOM order. */
const rows = async () => evalJs(`[...document.querySelectorAll('[data-live-row]')].map(el => [el.getAttribute('data-live-row'), el.getAttribute('data-task-id')])`);
const rowText = async (taskId) => text(`[data-live-row][data-task-id="${taskId}"]`);
const rowLink = async (taskId) => evalJs(`${q(`[data-live-row][data-task-id="${taskId}"] a[href="/task/${taskId}"]`)}?.textContent ?? null`);
async function shot(name) {
    const s = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    if (s.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(s.result.data, "base64"));
}
async function open(route, readySel, label) {
    await send("Page.navigate", { url: `${BASE}${route}` });
    await waitFor(`!!${q(readySel)}`, label);
}
// Nexus caches the Praxis read for 3s (fetchDispatchState); wait it out so the
// next page read sees the new scenario rather than the cached one.
const scenario = async (name) => { const r = await fetch(`${PRAXIS}/__scenario/${name}`, { method: "POST" }); check(r.ok, `scenario ${name} accepted`); await sleep(3500); };
const report = { base: BASE, api: API, praxis: PRAXIS, dist: DIST, ids, startedAt: new Date().toISOString(), steps: {} };
const record = (name, facts) => { report.steps[name] = facts; console.log(`${name}: ${JSON.stringify(facts)}`); };

const T = ids;
try {
    // 01 — home panel, no day plan, a queue (scenario "queue" is the default).
    step = "01-home-queue";
    await open("/", "[data-live-row]", "a live row on the home schedule");
    await sleep(500);
    const homeRows = await rows();
    const homeTitles = {};
    for (const id of [T.running, T.queuedCorrection, T.successor]) homeTitles[id] = await rowLink(id);
    const slotBadge = await text(`#sched-${T.slotEvent} [data-live-badge="queued"]`);
    const facts = {
        rows: homeRows,
        links: homeTitles,
        queuedCount: await text("[data-live-queued-count]"),
        q1: await rowText(T.queuedCorrection),
        running: await rowText(T.running),
        waiting: await rowText(T.successor),
        q1Clock: await text(`[data-live-row][data-task-id="${T.queuedCorrection}"] [data-live-clock]`),
        slotBadge,
        adhocBadge: await exists(`#sched-${T.adhocEvent} [data-live-badge]`),
        availability: await evalJs(`${q("[data-live-availability]")}?.dataset.liveAvailability ?? null`),
        header: await evalJs(`(document.body.textContent.match(/\\d+\\/\\d+ done/) || [null])[0]`),
        upNext: await evalJs(`(document.body.textContent.match(/up next:[^·]+· queued #\\d[^\\n]*?frees/) || [null])[0]`),
        slotTitleLink: await text(`#sched-${T.slotEvent} a[href="/task/${T.queuedSlot}"]`),
    };
    record(step, facts);
    check(JSON.stringify(homeRows) === JSON.stringify([["running", T.running], ["queued", T.queuedCorrection], ["waiting", T.successor]]), "running, queued #1 and the waiting successor are rows in that order; the queued task with a slot is not a second row");
    check(Object.values(homeTitles).every((v) => typeof v === "string" && v.length > 0), "every live row title links to /task/<id>");
    check(/queued #1 of 2/.test(facts.q1) && /correction round/.test(facts.q1), "queue head shows its position and correction round");
    check(facts.q1Clock === "#1", "queued row carries its position where a time would be, not an invented clock");
    check(/running · Claude Code · testing/.test(facts.running), "running row names executor and phase");
    check(/waiting on “Synthetic: honor operator-originated contract changes” \(queued #2\)/.test(facts.waiting) && /starts automatically/.test(facts.waiting), "waiting row names its dependency and that dependency's queue position");
    check(/queued #2 of 2/.test(slotBadge || ""), "the day-plan slot for queued #2 carries the queued badge");
    check(facts.adhocBadge === false && !homeRows.some(([, id]) => id === T.done), "the completed [Ad-hoc] event is neither badged nor doubled");
    check(!homeRows.some(([, id]) => id === T.idea) && !(await evalJs(`document.body.textContent.includes(${JSON.stringify("Synthetic: an unscheduled board idea")})`)), "an unscheduled board idea is not shown as queued");
    check(facts.queuedCount === "2 queued" && facts.header === "1/3 done", "header counts the queue separately from calendar completions");
    check(facts.availability === null, "a good read shows no stale/unavailable note");
    check(Boolean(facts.upNext) && facts.upNext.includes(T.titles[T.queuedCorrection]), "the footer names the queue head as up next");
    check(facts.slotTitleLink === `Slot: ${T.titles[T.queuedSlot]}`, "the badged day-plan slot keeps a task link in its title (QA round 1)");
    await shot(step);

    // 02 — /calendar strip and grid badge.
    step = "02-calendar-queue";
    await open("/calendar", "[data-live-work-strip] [data-live-row]", "a live row on /calendar");
    await sleep(300);
    const calRows = await rows();
    const calFacts = {
        rows: calRows,
        queuedCount: await text("[data-live-queued-count]"),
        badge: await text('[data-live-badge="queued"]'),
        waiting: await rowText(T.successor),
        links: { running: await rowLink(T.running), waiting: await rowLink(T.successor) },
        // Scoped to the grid block's heading: the strip's waiting row links to
        // the same task from its dependency list.
        blockTitleLink: await text(`h3 a[href="/task/${T.queuedSlot}"]`),
    };
    record(step, calFacts);
    check(JSON.stringify(calRows) === JSON.stringify(homeRows), "/calendar lists the same live rows as the home panel");
    check(/queued #2 of 2/.test(calFacts.badge || ""), "the grid block for the queued slot carries the badge");
    check(calFacts.queuedCount === "2 queued", "/calendar counts the queue the same way");
    check(calFacts.blockTitleLink === `Slot: ${T.titles[T.queuedSlot]}`, "the badged grid block's title links to the task (QA round 1)");
    await shot(step);

    // 03 — the slot frees: the home panel must follow without a reload.
    step = "03-slot-freed";
    await open("/", "[data-live-row]", "the home schedule again");
    await scenario("slot-freed");
    const followed = await waitFor(`${q(`[data-live-row][data-task-id="${T.queuedCorrection}"]`)}?.getAttribute('data-live-row') === 'running'`, "the queue head to become the running row (live refetch / fallback poll)", 80000);
    const freedRows = await rows();
    const freedFacts = { followedWithoutReload: followed, rows: freedRows, queuedCount: await text("[data-live-queued-count]"), slotBadge: await text(`#sched-${T.slotEvent} [data-live-badge]`), waiting: await rowText(T.successor), finished: await rowText(T.running), upNext: await text("[data-live-up-next]") };
    record(step, freedFacts);
    // Rows sit in time order, so the implementation that finished seconds
    // earlier precedes the run that started after it; the lane is the claim.
    check(freedRows.some(([lane, id]) => lane === "running" && id === T.queuedCorrection) && !freedRows.some(([lane, id]) => lane === "queued" && id === T.queuedCorrection), "the former queue head is now the running row");
    check(/queued #1 of 1/.test(freedFacts.slotBadge || ""), "the remaining queued task moved up to #1 on its slot badge");
    check(/\(queued #1\)/.test(freedFacts.waiting || ""), "the waiting row's dependency now reads queued #1");
    check(freedFacts.queuedCount === "1 queued", "queue count follows");
    check(Boolean(freedFacts.upNext) && freedFacts.upNext.includes(T.titles[T.queuedSlot]) && /queued #1/.test(freedFacts.upNext), "the queue head that sits on a day-plan slot is still announced as up next (QA round 1)");
    check(/implementation finished · QA pending/.test(freedFacts.finished || ""), "the task that just finished reads implementation finished, not completed");
    await shot(step);
    await open("/calendar", "[data-live-work-strip] [data-live-row]", "/calendar after the slot freed");
    const calFreed = await rows();
    record(`${step}-calendar`, { rows: calFreed });
    check(JSON.stringify(calFreed) === JSON.stringify(freedRows), "/calendar agrees after the transition");

    // 04 — QA is running for the finished implementation.
    step = "04-qa";
    await scenario("qa");
    await open("/", "[data-live-row]", "the home schedule in the QA scenario");
    await waitFor(`${q(`[data-live-row][data-task-id="${T.queuedCorrection}"]`)}?.getAttribute('data-live-row') === 'qa'`, "the QA row", 20000);
    const qaFacts = { rows: await rows(), qa: await rowText(T.queuedCorrection) };
    record(step, qaFacts);
    check(/implementation finished · QA running \(Codex\)/.test(qaFacts.qa || ""), "the QA row says implementation finished and QA running");
    check(!/completed|passed/i.test(qaFacts.qa || ""), "nothing claims completion or a pass while QA runs");
    await shot(step);

    // 05 — Praxis unreachable: stale after a good read, unavailable on a fresh load.
    step = "05-unreachable";
    await scenario("unreachable");
    const stale = await waitFor(`!!${q('[data-live-availability="stale"]')}`, "the stale note (live refetch / fallback poll)", 80000);
    const staleFacts = { staleNoteAppeared: stale, note: await text("[data-live-availability]"), rowsKept: await rows() };
    record(step, staleFacts);
    check(/Runtime queue stale · last read/.test(staleFacts.note || "") && /praxis down \(scenario\)|Praxis|503/i.test(staleFacts.note || ""), "the stale note carries the last read time and the reason");
    check(staleFacts.rowsKept.length === qaFacts.rows.length, "the last good rows stay on screen while stale");
    await shot(step);
    step = "05-unreachable-reload";
    await send("Page.reload", { ignoreCache: true });
    await sleep(500);
    await waitFor(`!!${q('[data-live-availability="unavailable"]')}`, "the unavailable note after a reload", 20000);
    const unavailFacts = { note: await text('[data-live-availability="unavailable"]'), rows: await rows(), calendarStillThere: await exists(`#sched-${T.adhocEvent}`), queuedCountShown: await exists("[data-live-queued-count]") };
    record(step, unavailFacts);
    check(/Runtime queue unavailable/.test(unavailFacts.note || "") && /cannot be shown/.test(unavailFacts.note || ""), "a fresh load with no runtime read says the queue cannot be shown");
    check(unavailFacts.rows.length === 0 && unavailFacts.calendarStillThere && !unavailFacts.queuedCountShown, "no live rows and no queue count are shown, the calendar rows remain");
    await shot(step);
    await open("/calendar", "[data-live-work-strip]", "/calendar while unreachable");
    await waitFor(`!!${q('[data-live-availability="unavailable"]')}`, "the unavailable note on /calendar", 20000);
    record(`${step}-calendar`, { note: await text("[data-live-availability]"), rows: await rows() });
    check(!(await evalJs(`document.body.textContent.includes('Nothing running or queued')`)), "/calendar never says nothing is queued while the runtime cannot be read");

    // 06 — nothing in flight: calendar rows alone, said explicitly on /calendar.
    step = "06-empty";
    await scenario("empty");
    await open("/", `#sched-${T.adhocEvent}`, "the home schedule with an empty runtime");
    await sleep(800);
    const emptyFacts = { rows: await rows(), queuedCountShown: await exists("[data-live-queued-count]"), availability: await evalJs(`${q("[data-live-availability]")}?.dataset.liveAvailability ?? null`), header: await evalJs(`(document.body.textContent.match(/\\d+\\/\\d+ done/) || [null])[0]`), slotBadge: await exists(`#sched-${T.slotEvent} [data-live-badge]`) };
    record(step, emptyFacts);
    check(emptyFacts.rows.length === 0 && !emptyFacts.queuedCountShown && emptyFacts.availability === null && !emptyFacts.slotBadge, "an empty live read adds no rows, badges or notes");
    check(emptyFacts.header === "1/3 done", "calendar rows stand alone");
    await shot(step);
    await open("/calendar", "[data-live-work-strip]", "/calendar with an empty runtime");
    await waitFor(`document.body.textContent.includes('Nothing running or queued in the runtime right now')`, "the explicit empty note on /calendar", 20000);
    record(`${step}-calendar`, { queuedCount: await text("[data-live-queued-count]"), rows: await rows() });
    await shot(`${step}-calendar`);
} catch (error) {
    fail(`unexpected error: ${error?.stack || error}`);
} finally {
    // Network truth: the page only ever read. The dashboard reaches the API
    // through Next's /api/* proxy, so API traffic shows up on the page origin.
    const apiRequests = requests.filter((r) => (r.origin === BASE || r.origin === API) && r.path.startsWith("/api/"));
    const nonGet = apiRequests.filter((r) => r.method !== "GET");
    const praxisDirect = requests.filter((r) => r.origin === PRAXIS || r.url.includes(":54322"));
    const otherOrigins = [...new Set(requests.filter((r) => r.origin !== BASE && r.origin !== API).map((r) => r.origin))];
    let praxisLog = null;
    let apiLog = null;
    try { praxisLog = (await (await fetch(`${PRAXIS}/__log`)).json()).log; } catch { /* stack gone */ }
    try { apiLog = (await (await fetch(`${API}/__log`)).json()).log; } catch { /* stack gone */ }
    // Other home-page panels read /api/autonomy through Nexus too; what matters
    // is that nothing WROTE to Praxis (a dispatch, a gate, an approval).
    const praxisWrites = (praxisLog || []).filter((l) => !/^GET /.test(l) && !/^POST \/__scenario\//.test(l));
    const apiWrites = (apiLog || []).filter((l) => !/^GET /.test(l));
    report.network = {
        apiRequests: apiRequests.length,
        apiPaths: [...new Set(apiRequests.map((r) => `${r.method} ${r.path}`))],
        nonGetToApi: nonGet.map((r) => `${r.method} ${r.path}`),
        apiSaw: [...new Set(apiLog || [])],
        apiWrites,
        pageRequestsToPraxis: praxisDirect.length,
        otherOrigins,
        fakePraxisSaw: [...new Set(praxisLog || [])],
        fakePraxisWrites: praxisWrites,
        exceptions,
    };
    check(apiRequests.length > 0 && nonGet.length === 0, "the pages only ever sent GET requests to the API");
    check(apiWrites.length === 0, "the throwaway API received no write");
    check(praxisDirect.length === 0, "the pages never talked to Praxis directly");
    check(praxisWrites.length === 0, "the fake Praxis received no write (nothing dispatched, no gate or approval touched)");
    report.failures = failures;
    report.finishedAt = new Date().toISOString();
    report.out = OUT;
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
    try { ws.close(); } catch { /* already closed */ }
    for (const c of children) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
    await sleep(500);
    for (const c of children) { if (c.exitCode === null) { try { c.kill("SIGKILL"); } catch { /* gone */ } } }
    console.log(`other origins contacted: ${otherOrigins.length ? otherOrigins.join(", ") : "none"}; non-GET to API: ${nonGet.length}; page exceptions: ${exceptions.length}`);
    console.log(failures.length ? `FAILED (${failures.length}):\n  ${failures.join("\n  ")}` : "ALL CHECKS PASSED");
    console.log(`report: ${join(OUT, "report.json")}`);
    process.exit(failures.length ? 1 : 0);
}
