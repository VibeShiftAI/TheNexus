#!/usr/bin/env node
/**
 * Real-browser check of the initial backlog receipt on the intake panel (task
 * 3adfd298, 2026-11-14): what the project page shows for an accepted intake
 * whose backlog is not recorded, generated, existing, partial or deferred, and
 * for an intake that is not accepted yet, at desktop and phone width.
 *
 * One foreground process owns the whole stack and stops it on exit:
 *   - the real API (server/server.js) on CHECK_API_PORT with a temporary SQLite
 *     database, its own project root and review-blob dir, an empty fleet env
 *     file and PRAXIS_URL pointed at a closed port;
 *   - `next start` of a dist dir built against that API;
 *   - headless Chrome over the DevTools protocol. The shell's socket client
 *     targets the live API on :4000 from any local origin, so the browser is
 *     barred from that origin and the attempts are counted in the report.
 *
 * The intakes are seeded through the real intake routes (create, prepare,
 * accept, record_backlog), so the page renders what the API stored. Each
 * expected sentence is built from the receipt the API returns, not from a
 * copy of the seed. Widths are compared with the viewport this script
 * configures, because a phone browser widens its window to fit content that
 * overflows.
 *
 *   cd dashboard
 *   NEXT_DIST_DIR=.next-intake-backlog NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 npm run build
 *   CHECK_DIST=.next-intake-backlog CHECK_OUT=/path/out node scripts/intake-backlog-panel-browser-check.mjs
 *
 * The build appends the dist dir's types to tsconfig.json; put that file back
 * afterwards. Env: CHECK_DIST (required), CHECK_API_PORT (4299, must match the
 * build), CHECK_WEB_PORT (3299), CHECK_OUT (a fresh temp dir), CHECK_CHROME.
 * Writes <out>/<nn>-<case>-<viewport>.png and <out>/report.json; exits 1 on a
 * failed check.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(DASHBOARD, "..");
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const DIST = process.env.CHECK_DIST;
if (!DIST || !existsSync(join(DASHBOARD, DIST))) { console.error("CHECK_DIST=<dist dir built against the check API> is required."); process.exit(2); }
const API_PORT = Number(process.env.CHECK_API_PORT || 4299);
const WEB_PORT = Number(process.env.CHECK_WEB_PORT || 3299);
const API = `http://127.0.0.1:${API_PORT}`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const OUT = resolve(process.env.CHECK_OUT || mkdtempSync(join(tmpdir(), "nexus-intake-backlog-panel-check-")));
mkdirSync(OUT, { recursive: true });
const TMP = mkdtempSync(join(tmpdir(), "nexus-intake-backlog-panel-"));
const DESKTOP = { name: "desktop", width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false };
const PHONE = { name: "phone", width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = []; // { child, group }: group is true for a child that leads its own process group
const signalChild = ({ child, group }) => { try { if (group) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* already gone */ } };
const removeTmp = () => { try { rmSync(TMP, { recursive: true, force: true }); return true; } catch { return false; } };
let stopped = false;
/** Last resort on any exit path: signal every child and remove the temp dir. */
function stopAll() {
    if (stopped) return;
    stopped = true;
    for (const entry of children) signalChild(entry);
    removeTmp();
}
/** The orderly end: stop each child, wait until it is gone, then remove the temp dir. */
async function shutdown() {
    for (const entry of [...children].reverse()) {
        if (entry.child.exitCode !== null || entry.child.signalCode !== null) continue;
        const gone = new Promise((done) => entry.child.once("exit", done));
        signalChild(entry);
        await Promise.race([gone, sleep(8000)]);
    }
    for (let attempt = 0; attempt < 10 && !removeTmp(); attempt++) await sleep(300);
    stopped = true;
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopAll(); process.exit(130); });
process.on("unhandledRejection", (error) => { console.error(error); stopAll(); process.exit(2); });

const failures = [];
const passes = [];
let step = "start";
const check = (ok, message) => {
    (ok ? passes : failures).push(`${step}: ${message}`);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${step}: ${message}`);
    return ok;
};

// 1. The real API on a temporary database. Its environment is built here, not inherited, so no
//    live endpoint or key from this shell reaches it. The shell polls the knowledge activity feed,
//    which would read the vault, the praxis-mind ledger and the Cortex gateway: each is pointed at
//    an empty or closed place, so the footer ticker shows no real file name.
mkdirSync(join(TMP, "projects"), { recursive: true });
mkdirSync(join(TMP, "vault"), { recursive: true });
writeFileSync(join(TMP, "empty-fleet-env"), "");
const apiLog = [];
const api = spawn(process.execPath, ["server/server.js"], {
    cwd: REPO,
    env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: String(API_PORT), NEXUS_DB_PATH: join(TMP, "nexus.db"),
        PROJECT_ROOT: join(TMP, "projects"), NEXUS_REVIEW_BLOB_DIR: join(TMP, "review-blobs"), NEXUS_PRESENTATION_RECEIVER_PORT: "",
        PRAXIS_URL: "http://127.0.0.1:9", FLEET_ENV_PATH: join(TMP, "empty-fleet-env"),
        NEXUS_VAULT_ROOT: join(TMP, "vault"), PRAXIS_MIND_LEDGER_DB: join(TMP, "no-ledger.sqlite"), CORTEX_GATEWAY_URL: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
});
children.push({ child: api, group: false });
api.stdout.on("data", (chunk) => apiLog.push(String(chunk)));
api.stderr.on("data", (chunk) => apiLog.push(String(chunk)));
async function waitForHttp(url, label, child) {
    for (let waited = 0; waited < 90_000; waited += 250) {
        if (child.exitCode !== null) throw new Error(`${label} exited early (code ${child.exitCode})\n${apiLog.join("").split("\n").slice(-20).join("\n")}`);
        try { if ((await fetch(url)).ok) return; } catch { /* not listening yet */ }
        await sleep(250);
    }
    throw new Error(`${label} did not answer on ${url} within 90s`);
}
await waitForHttp(`${API}/api/health`, "the check API", api);

// 2. Seed one intake per receipt state through the real routes.
const call = async (method, path, body) => {
    const response = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
};
const expectOk = (result, what) => {
    if (result.status >= 300) throw new Error(`${what} failed (${result.status}): ${JSON.stringify(result.body)}`);
    return result.body;
};
const BRIEF = { purpose: "Reduce waste and make tools accessible", outcome: "Neighbors can coordinate shared tools", beneficiary: "Our neighborhood", scope: "Tool lending pilot", success_criteria: ["A neighbor completes a loan"], decision_owner: "Robert" };
const NEED = { id: "owner", kind: "information", description: "Choose the pilot owner", knowledge: { question: "Who owns the pilot?", purpose: "Identify authority", satisfaction_test: "Owner explicitly confirms", resolution: { method: "human", owner: "Robert", next_action: "Ask Robert" } } };
const operate = async (snapshot, action, rest = {}) => expectOk(
    await call("POST", `/api/projects/${snapshot.project.id}/intake/operations`, { operation_id: randomUUID(), expected_revision: snapshot.intake.revision, action, ...rest }),
    `${action} on ${snapshot.project.name}`);
async function prepared(label) {
    const created = expectOk(await call("POST", "/api/projects/intake", { operation_id: randomUUID(), name: `Receipt check: ${label}`, problem: "Help neighbors share tools", source_ref: "chat:check-original" }), `create ${label}`);
    return operate(created, "prepare", { brief: BRIEF, needs: [NEED] });
}
async function accepted(label) {
    const ready = await prepared(label);
    const snapshot = await operate(ready, "accept", { source_ref: "chat:check-accept", next_step: "Plan the pilot", brief_revision: ready.intake.brief_revision });
    await sleep(15); // intake stamps run a millisecond apart; a task filed next has to count as later
    return snapshot;
}
const slot = (n, rest = {}) => ({
    slot: n, name: `Stage ${n}: pilot step ${n}`, description: `What: deliver step ${n} of the pilot. Why: the accepted next step needs it.`,
    antigravity_payload: { prompt: `Deliver step ${n} of the pilot`, acceptance_criteria: [`Step ${n} is demonstrated`] }, ...rest,
});
const HOLD_REASON = "Robert asked to hold the first tasks until the venue for the pilot is confirmed and the insurance question is answered";
const HOLD_REF = "nexus://conversation/receipt-check/message/hold-until-the-venue-is-confirmed";

step = "seed";
const seeds = {};
seeds["not-recorded"] = await accepted("not recorded");
seeds.generated = await operate(await accepted("generated"), "record_backlog", { status: "generated", proposals: [slot(1), slot(2, { dependencies: [1] })] });
{
    const base = await accepted("existing");
    const filed = expectOk(await call("POST", "/api/tasks/batch", { project_id: base.project.id, tasks: [{ name: "Plan the pilot route", description: "Filed before the receipt, as a plain task.", status: "idea", antigravity_payload: { prompt: "Plan the route", acceptance_criteria: ["The route is written down"] } }] }), "the plain task for existing");
    const taskId = filed.tasks?.[0]?.id;
    if (!taskId) throw new Error(`the plain task's id was not in the reply: ${JSON.stringify(filed)}`);
    seeds.existing = await operate(base, "record_backlog", { status: "existing", task_ids: [taskId] });
}
seeds.partial = await operate(await accepted("partial"), "record_backlog", { status: "generated", proposals: [slot(1)], remaining: [slot(2, { dependencies: [1] }), slot(3, { dependencies: [2] })] });
seeds.deferred = await operate(await accepted("deferred"), "record_backlog", { status: "deferred", reason: HOLD_REASON, source_ref: HOLD_REF });
seeds.interviewing = await operate(await prepared("interviewing"), "start");

/** What the page has to say for a handed-off intake, derived from what the API stored. */
function expected(snapshot) {
    if (snapshot.intake.state !== "handed_off") return null;
    const acceptance = snapshot.intake.acceptance;
    const accepted = `Accepted brief version ${acceptance.brief_revision}. Next step: ${acceptance.next_step}`;
    const receipt = snapshot.backlog;
    if (!receipt) {
        return { state: "not-recorded", label: "backlog: not recorded", accepted, box: ["Initial backlog not recorded: no tasks have been filed or named for this acceptance, and no deferral is recorded."] };
    }
    const filed = receipt.task_ids.length;
    const label = receipt.status === "deferred" ? `backlog: deferred (${receipt.reason})`
        : receipt.status === "partial" ? `backlog: partial, ${filed} of ${filed + receipt.remaining.length}`
            : `backlog: ${filed} ${filed === 1 ? "task" : "tasks"}`;
    return {
        state: "recorded", label, accepted,
        box: [
            `Initial ${label}, recorded against brief version ${receipt.brief_revision}.`,
            ...(receipt.status === "deferred" ? [`Deferral reference: ${receipt.source_ref}`] : []),
            ...(receipt.remaining.length ? ["Planned and not filed yet:", ...receipt.remaining.map((body) => `Slot ${body.slot}: ${body.name}`)] : []),
        ],
    };
}
const cases = [];
for (const [name, seeded] of Object.entries(seeds)) {
    const read = expectOk(await call("GET", `/api/projects/${seeded.project.id}/intake`), `read ${name}`);
    cases.push({ name, id: read.project.id, snapshot: read, expected: expected(read) });
}
const byName = Object.fromEntries(cases.map((entry) => [entry.name, entry]));
check(byName["not-recorded"].snapshot.backlog === null && byName["not-recorded"].snapshot.open_task_count === 0, "API: the accepted intake with no receipt reads backlog null and open_task_count 0");
check(!("backlog" in byName["not-recorded"].snapshot.intake.acceptance), "API: its stored acceptance has no backlog key, as every acceptance recorded before receipts existed");
check(byName.generated.snapshot.backlog?.status === "generated" && byName.generated.snapshot.backlog.task_ids.length === 2 && byName.generated.snapshot.open_task_count === 2, "API: generated receipt names the two tasks it created");
check(byName.existing.snapshot.backlog?.status === "existing" && byName.existing.snapshot.backlog.task_ids.length === 1, "API: existing receipt names the one task already on the board");
check(byName.partial.snapshot.backlog?.status === "partial" && byName.partial.snapshot.backlog.task_ids.length === 1 && byName.partial.snapshot.backlog.remaining.length === 2, "API: a receipt with unfiled slots is stored as partial (1 filed, 2 remaining)");
check(byName.deferred.snapshot.backlog?.status === "deferred" && byName.deferred.snapshot.backlog.reason === HOLD_REASON && byName.deferred.snapshot.backlog.source_ref === HOLD_REF, "API: the deferral is stored with its reason and source");
check(byName.interviewing.snapshot.intake.state === "interviewing" && !("backlog" in byName.interviewing.snapshot), "API: an intake that is not accepted carries no backlog field");

// 3. The dashboard, from the dist dir built against that API.
const web = spawn(process.execPath, [join(DASHBOARD, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(WEB_PORT)], {
    cwd: DASHBOARD, env: { ...process.env, NEXT_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore", detached: true,
});
children.push({ child: web, group: true });
await waitForHttp(`${BASE}/project/${cases[0].id}`, "the dashboard", web);

// 4. Headless Chrome.
const debugPort = 9800 + Math.floor(Math.random() * 150);
const profile = join(TMP, "chrome-profile");
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--window-size=${DESKTOP.width},${DESKTOP.height}`, "about:blank"], { stdio: "ignore" });
children.push({ child: chrome, group: false });
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
const requested = new Map(); // requestId -> { step, method, url }
const traffic = [];          // every request the page made, by step
const exceptions = [];
ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    if (message.method === "Network.requestWillBeSent") {
        const entry = { step, method: message.params.request.method, url: message.params.request.url, blocked: false };
        requested.set(message.params.requestId, entry);
        traffic.push(entry);
    }
    if (message.method === "Network.loadingFailed" && message.params.blockedReason === "inspector" && requested.has(message.params.requestId)) {
        requested.get(message.params.requestId).blocked = true;
    }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(`${step}: ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text}`);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*://localhost:4000/*", "*://127.0.0.1:4000/*"] });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
async function waitFor(expression, label, timeoutMs = 45_000) {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
        if (await evalJs(expression)) return true;
        await sleep(250);
    }
    return check(false, `timed out waiting for ${label}`);
}
const setViewport = (viewport) => send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: viewport.mobile });
async function shot(name) {
    const capture = await send("Page.captureScreenshot", { format: "png" });
    if (capture.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(capture.result.data, "base64"));
    return `${name}.png`;
}

/** Everything the checks read from the panel, measured in the page. */
const MEASURE = `(() => {
    const panel = document.querySelector('section[aria-label="Project intake"]');
    if (!panel) return null;
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const colorOf = (className) => { const probe = document.createElement('span'); probe.className = className; panel.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; };
    const line = panel.querySelector('header p');
    const span = panel.querySelector('[data-intake-backlog]');
    const box = [...panel.querySelectorAll('div')].find((el) => el.firstElementChild?.tagName === 'P' && el.firstElementChild.textContent.startsWith('Accepted brief version'));
    const visible = [...panel.querySelectorAll('*')].filter((el) => el.getClientRects().length > 0);
    const widest = visible.reduce((best, el) => (el.getBoundingClientRect().right > best.right ? { right: el.getBoundingClientRect().right, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim() } : best), { right: 0, tag: '', text: '' });
    const clipped = visible.filter((el) => el.children.length === 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible').map((el) => (el.textContent || '').trim());
    const warning = box ? [...box.querySelectorAll('p')].find((el) => el.textContent.startsWith('Initial backlog not recorded')) : null;
    return {
        line: line.textContent, lineColor: getComputedStyle(line).color, lineClipped: line.scrollWidth > line.clientWidth + 1,
        span: span ? { state: span.getAttribute('data-intake-backlog'), text: span.textContent, color: getComputedStyle(span).color, weight: Number(getComputedStyle(span).fontWeight), rect: rect(span) } : null,
        amber300: colorOf('text-amber-300'), amber200: colorOf('text-amber-200'),
        box: box ? { lines: [...box.querySelectorAll('p, li')].map((el) => el.textContent.trim()), color: getComputedStyle(box).color, rect: rect(box) } : null,
        warningColor: warning ? getComputedStyle(warning).color : null,
        panel: rect(panel), widestRight: Math.round(widest.right), widestElement: widest.tag + ': ' + widest.text, clipped,
        documentScrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    };
})()`;
/** Scroll an element to the top of the viewport, just below whatever bar is pinned there. */
const scrollBelowBar = (selectorJs) => evalJs(`(() => {
    const el = ${selectorJs};
    if (!el) return false;
    window.scrollTo(0, Math.max(0, window.scrollY + el.getBoundingClientRect().top - 12));
    const pinned = [...document.querySelectorAll('body *')].filter((node) => {
        const position = getComputedStyle(node).position;
        if (position !== 'fixed' && position !== 'sticky') return false;
        const r = node.getBoundingClientRect();
        return r.top <= 1 && r.bottom > 0 && r.bottom < window.innerHeight / 2 && r.width >= window.innerWidth * 0.9;
    });
    window.scrollBy(0, -Math.max(0, ...pinned.map((node) => node.getBoundingClientRect().bottom)));
    return true;
})()`);
const PANEL = `document.querySelector('section[aria-label="Project intake"]')`;
const BOX = `[...document.querySelectorAll('section[aria-label="Project intake"] div')].find((el) => el.firstElementChild?.tagName === 'P' && el.firstElementChild.textContent.startsWith('Accepted brief version'))`;

const observed = [];
let exitCode = 0;
try {
    let index = 0;
    for (const entry of cases) {
        index += 1;
        const prefix = `${String(index).padStart(2, "0")}-${entry.name}`;
        for (const viewport of [DESKTOP, PHONE]) {
            step = `${prefix}-${viewport.name}`;
            await setViewport(viewport);
            await send("Page.navigate", { url: `${BASE}/project/${entry.id}` });
            if (!(await waitFor(`!!${PANEL}`, "the intake panel"))) continue;
            await sleep(400);
            // Measured and photographed as the page opens: the panel starts under the top bar, state line in view.
            await evalJs("window.scrollTo(0, 0)");
            const m = await evalJs(MEASURE);
            const shots = [await shot(step)];
            check(m.span ? m.span.rect.top >= 0 && m.span.rect.bottom <= viewport.height : m.panel.top < viewport.height, "the panel's state line is on screen when the page opens");
            const want = entry.expected;
            if (!want) {
                check(m.line === "Conversation in progress" && m.span === null, `no backlog state before acceptance: the line reads "${m.line}"`);
                check(m.box === null, "no acceptance box before acceptance");
            } else {
                check(m.line === `Accepted for planning · ${want.label}`, `the state line reads "${m.line}"`);
                check(m.span?.state === want.state && m.span.text === want.label, `data-intake-backlog="${m.span?.state}" with the text "${m.span?.text}"`);
                if (want.state === "not-recorded") {
                    check(m.span.color === m.amber300 && m.span.color !== m.lineColor, `"not recorded" is in the warning colour (${m.span.color}), not the line's colour (${m.lineColor})`);
                    check(m.span.weight >= 600, `"not recorded" is semibold (font-weight ${m.span.weight})`);
                    check(m.warningColor === m.amber200 && m.warningColor !== m.box.color, `the acceptance box states it in amber (${m.warningColor}), not the box colour (${m.box?.color})`);
                } else {
                    check(m.span.color === m.lineColor && m.span.color !== m.amber300, `a recorded receipt keeps the line's colour (${m.span.color})`);
                }
                check(m.box?.lines[0] === want.accepted, `the acceptance box opens with "${m.box?.lines[0]}"`);
                for (const sentence of want.box) check(m.box?.lines.includes(sentence), `the acceptance box says "${sentence}"`);
                if (want.state === "recorded") check(!m.box.lines.some((line) => line.startsWith("Initial backlog not recorded")), "no not-recorded warning beside a recorded receipt");
                // The acceptance box gets its own picture only where the first one does not already hold all of it.
                if (m.box.rect.bottom > viewport.height) {
                    await scrollBelowBar(BOX);
                    await sleep(150);
                    shots.push(await shot(`${step}-acceptance`));
                }
            }
            // Layout, against the configured width.
            check(m.documentScrollWidth <= viewport.width, `the page does not scroll sideways (document width ${m.documentScrollWidth}px in a ${viewport.width}px viewport)`);
            check(m.panel.left >= 0 && m.widestRight <= viewport.width, `nothing in the panel reaches past the ${viewport.width}px viewport (widest right edge ${m.widestRight}px)`);
            check(m.clipped.length === 0 && !m.lineClipped, `no text in the panel is clipped${m.clipped.length ? `: ${JSON.stringify(m.clipped)}` : ""}`);
            observed.push({ case: entry.name, viewport: viewport.name, project_id: entry.id, screenshots: shots, page: m });
        }
    }

    step = "traffic";
    const pageOrigin = new URL(BASE).origin;
    const own = traffic.filter((entry) => entry.url.startsWith(pageOrigin));
    const live = traffic.filter((entry) => /^https?:\/\/(localhost|127\.0\.0\.1):4000\//.test(entry.url));
    const elsewhere = traffic.filter((entry) => !entry.url.startsWith(pageOrigin) && !live.includes(entry) && /^https?:/.test(entry.url));
    const writes = traffic.filter((entry) => entry.method !== "GET" && !entry.blocked);
    check(cases.every((entry) => own.some((request) => new URL(request.url).pathname === `/api/projects/${entry.id}`)), "each page read its project through the dashboard's own /api proxy");
    check(live.every((entry) => entry.blocked), `the browser never reached the live API: ${live.length} attempts on :4000, all blocked`);
    check(!traffic.some((entry) => /\/intake(\/|$|\?)/.test(new URL(entry.url).pathname) && entry.method !== "GET"), "opening the pages sent no intake operation");
    check(exceptions.length === 0, `no uncaught page error${exceptions.length ? `: ${exceptions[0]}` : ""}`);
    const after = [];
    for (const entry of cases) after.push((await call("GET", `/api/projects/${entry.id}/intake`)).body);
    check(JSON.stringify(after) === JSON.stringify(cases.map((entry) => entry.snapshot)), "every intake reads the same after the pages were opened as before");

    writeFileSync(join(OUT, "report.json"), `${JSON.stringify({
        task: "3adfd298-e3ab-40da-b3ec-11ab448c220f",
        script: "dashboard/scripts/intake-backlog-panel-browser-check.mjs",
        ran_at: new Date().toISOString(),
        stack: { api: `server/server.js on ${API} with a temporary database`, dashboard: `next start of ${DIST} on ${BASE}`, browser: version.Browser, viewports: [DESKTOP, PHONE] },
        passed: passes.length, failed: failures.length, failures, passes,
        cases: cases.map((entry) => ({
            case: entry.name, project_id: entry.id, intake_state: entry.snapshot.intake.state,
            api: { open_task_count: entry.snapshot.open_task_count ?? null, backlog: entry.snapshot.backlog ?? null },
            expected_on_page: entry.expected,
        })),
        observed,
        traffic: {
            requests: traffic.length, to_the_dashboard_origin: own.length, attempts_on_live_4000_all_blocked: live.length,
            to_any_other_origin: [...new Set(elsewhere.map((entry) => `${entry.method} ${new URL(entry.url).origin}`))],
            writes_from_the_page: [...new Set(writes.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`))],
            // Every API route the pages read through the proxy, ids folded, so the reads are on the record.
            api_routes_read: [...new Set(own.filter((entry) => new URL(entry.url).pathname.startsWith("/api/"))
                .map((entry) => `${entry.method} ${new URL(entry.url).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")}`))].sort(),
        },
        notes: [
            "Praxis is not part of this stack and the live API is barred, so the shell shows 'no signal' and 'Request status unavailable'.",
            "The API's vault root, praxis-mind ledger and Cortex gateway point at an empty directory, a missing file and a closed port.",
        ],
        page_errors: exceptions,
    }, null, 2)}\n`);
} catch (error) {
    console.error(error);
    exitCode = 2;
} finally {
    try { ws.close(); } catch { /* already closed */ }
    await shutdown();
}
console.log(`\n${passes.length} passed, ${failures.length} failed. Output: ${OUT}`);
console.log(`stack stopped; temp dir removed: ${!existsSync(TMP)}`);
process.exit(exitCode || (failures.length ? 1 : 0));
