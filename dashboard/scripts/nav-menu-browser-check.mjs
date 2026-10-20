#!/usr/bin/env node
/**
 * Browser check for THE NEXUS MENU (components/nav-sidebar.tsx, task 91f1f758).
 *
 * Opens the menu on the home page in headless Chrome across a viewport matrix
 * and proves, the way a person would, that every destination and control can
 * be reached: it scrolls the menu with the mouse wheel (touch gestures on the
 * phone sizes), hit-tests each target with elementFromPoint, measures
 * horizontal overflow and page scroll behind the menu, walks it with Tab,
 * closes it with Escape and the backdrop and checks where focus lands.
 *
 * Since Robert's review of 2026-10-20 (task 584f2f1d) the menu has no Active
 * Projects section: the check fails if the menu shows a project link, the
 * heading or its loading/empty text, and if the dashboard's own project grid
 * does not list every fixture project.
 *
 * No backend is needed or touched: every /api/* request is answered from a
 * fixture through CDP request interception, and anything aimed at :4000 or
 * :4299 is blocked, so the live Nexus API never sees a request.
 *
 *   NEXT_DIST_DIR=.next-menu NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 npx next dev -p 3100
 *   CHECK_BASE=http://localhost:3100 CHECK_OUT=/path/out node scripts/nav-menu-browser-check.mjs
 *
 * Env: CHECK_BASE (http://localhost:3100), CHECK_OUT (./.nav-menu-check),
 * CHECK_VIEWPORTS (comma list of names below; default all),
 * CHECK_FIXTURE (default | long | empty | loading), CHECK_SHELL=1 to emulate
 * the Android shell (Connection settings), CHECK_OFFLINE=1 to fail /api/health
 * so the connection banner floats over the page, CHECK_TAG (screenshot prefix),
 * CHECK_REDUCED_MOTION=1 to emulate prefers-reduced-motion and require a still panel,
 * CHECK_INTERACT=0 to skip the keyboard/close checks (before evidence).
 * Exits 1 when a target is unreachable or the page scrolls sideways.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = [
    process.env.CHECK_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) {
    console.error("No Chrome binary found; set CHECK_CHROME.");
    process.exit(2);
}

const BASE = (process.env.CHECK_BASE || "http://localhost:3100").replace(/\/$/, "");
const OUT = resolve(process.env.CHECK_OUT || ".nav-menu-check");
const FIXTURE = process.env.CHECK_FIXTURE || "default";
const SHELL = process.env.CHECK_SHELL === "1";
const TAG = process.env.CHECK_TAG || FIXTURE + (SHELL ? "-shell" : "");
const INTERACT = process.env.CHECK_INTERACT !== "0";

const VIEWPORTS = {
    "1440x900": { width: 1440, height: 900, dpr: 1, mobile: false },
    "1280x720": { width: 1280, height: 720, dpr: 1, mobile: false },
    "1024x600": { width: 1024, height: 600, dpr: 1, mobile: false },
    "390x844": { width: 390, height: 844, dpr: 2, mobile: true },
    "375x667": { width: 375, height: 667, dpr: 2, mobile: true },
    // 1440x900 at 200% browser zoom: half the CSS pixels at twice the density.
    "zoom200": { width: 720, height: 450, dpr: 2, mobile: false },
    // Nexus's own display scale at its maximum (body zoom 1.5) on a laptop.
    "scale150": { width: 1280, height: 720, dpr: 1, mobile: false, displayScale: 1.5 },
    // Phone with the OS text size doubled (root font size 200%).
    "text200": { width: 390, height: 844, dpr: 2, mobile: true, rootFont: "200%" },
    // The narrowest phone in common use with doubled text.
    "320text200": { width: 320, height: 640, dpr: 2, mobile: true, rootFont: "200%" },
};
const selected = (process.env.CHECK_VIEWPORTS || Object.keys(VIEWPORTS).join(",")).split(",").map((s) => s.trim()).filter(Boolean);

// ── Fixtures ────────────────────────────────────────────────────────────────
const TYPES = ["web-app", "tool", "service", "research", "game"];
function projectsFixture() {
    if (FIXTURE === "empty") return [];
    if (FIXTURE === "long") {
        const long = [
            "Praxis Orchestration Runtime and Supervisor Rewrite for the Fleet",
            "AVeryLongProjectNameWithoutAnySpacesThatWouldOverflowANarrowColumnIfNotTruncated",
            "Nexus Mobile Android WebView Shell with Cloudflare Access cookie priming",
        ];
        return Array.from({ length: 42 }, (_, i) => ({
            id: `fixture-${String(i + 1).padStart(2, "0")}`,
            name: i < long.length ? long[i] : `Fixture project ${i + 1} ${"lorem ".repeat(i % 4)}`.trim(),
            path: `/tmp/fixture-${i + 1}`,
            type: TYPES[i % TYPES.length] + (i === 1 ? "-long-type-label" : ""),
        }));
    }
    return ["TheNexus", "Praxis", "TheCortex", "Nexus-Mobile-Android", "shared-mind", "LARS", "Groundrules", "VibeShift Site"].map((name, i) => ({
        id: `fixture-${i + 1}`,
        name,
        path: `/tmp/fixture-${i + 1}`,
        type: TYPES[i % TYPES.length],
    }));
}
const MODEL_STATE = {
    localOnly: { enabled: false, reason: null },
    aliases: [
        { alias: "coder", target: "model:claude-opus-5-5", description: "default coding model", is_active: true },
        { alias: "fast", target: "capability_best:chat", description: null, is_active: true },
        { alias: "local", target: "capability_best:local", description: "offline fallback", is_active: true },
    ],
    projectAliases: [],
    models: [
        { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", provider: "anthropic", family: "opus" },
        { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", provider: "anthropic", family: "sonnet" },
    ],
};

// ── Chrome + CDP ────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const port = 9500 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "nexus-nav-menu-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
// Never leave a headless Chrome behind, whatever ends the run.
process.on("exit", () => chrome.kill());
process.on("unhandledRejection", (err) => { console.error(err); process.exit(2); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); }
}
if (!version) { chrome.kill(); console.error("Chrome did not start"); process.exit(2); }
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    for (const fn of listeners) fn(m);
};
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
    return r.result?.result?.value;
};

const requestLog = [];
const blocked = [];
listeners.push(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const url = new URL(request.url);
    requestLog.push(`${request.method} ${url.host}${url.pathname}`);
    if (url.port === "4000" || url.port === "4299") {
        blocked.push(`${url.host}${url.pathname}`);
        return send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    }
    if (!url.pathname.startsWith("/api/")) return send("Fetch.continueRequest", { requestId });
    let status = 503;
    let body = { error: "fixture: not served" };
    if (url.pathname === "/api/projects") {
        if (FIXTURE === "loading") return; // never answered: the menu stays in its loading state
        status = 200; body = projectsFixture();
    } else if (url.pathname === "/api/model-control/options") {
        status = 200; body = MODEL_STATE;
    } else if (url.pathname === "/api/pins" || url.pathname.endsWith("/pins")) {
        status = 200; body = [];
    } else if (url.pathname === "/api/health" && process.env.CHECK_OFFLINE !== "1") {
        // Healthy unless CHECK_OFFLINE=1, which shows the connection banner over the page.
        status = 200; body = { status: "ok" };
    }
    return send("Fetch.fulfillRequest", {
        requestId,
        responseCode: status,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
    });
});

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*://localhost:4000/*", "*://127.0.0.1:4000/*", "*://127.0.0.1:4299/*"] });
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: process.env.CHECK_REDUCED_MOTION === "1" ? "reduce" : "no-preference" }] });
if (SHELL) {
    await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.__shellMessages = [];
            window.ReactNativeWebView = { postMessage: (d) => window.__shellMessages.push(JSON.parse(d)) };
            window.__NEXUS_MOBILE_SHELL__ = Object.freeze({ platform: "android", appVersion: "0.0.0-fixture", origin: location.origin, capabilities: [] });`,
    });
}

// ── In-page probes ──────────────────────────────────────────────────────────
// Targets the brief names, found by role/label/text so the same probe reads the
// old drawer and the new menu.
const PROBE = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (!dialog) return { error: "no dialog" };
  const byText = (sel, text) => Array.from(dialog.querySelectorAll(sel)).find((el) => el.textContent.trim().replace(/\\s+/g, " ").startsWith(text));
  const projectLinks = Array.from(dialog.querySelectorAll('a[href^="/project/"]'));
  const navLinks = Array.from(dialog.querySelectorAll('nav a'));
  const targets = {
    close: dialog.querySelector('button[aria-label="Close menu"]') || dialog.querySelector('button'),
    firstNav: navLinks[0],
    reviews: byText('a', 'Reviews'),
    lars: byText('a', 'LARS Dashboard'),
    studio: byText('a', 'Studio'),
    lastNav: navLinks[navLinks.length - 1],
    localOnly: dialog.querySelector('button[aria-label="Toggle local-only mode"]'),
    aliasSave: byText('button', 'Save Alias'),
    settings: Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Settings'),
    connection: byText('button', 'Connection settings'),
  };
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = {};
  for (const [name, el] of Object.entries(targets)) {
    if (!el) { out[name] = { present: false }; continue; }
    const r = el.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= vh + 0.5 && r.right <= vw + 0.5;
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    const hitOk = !!hit && (hit === el || el.contains(hit));
    const coveredBy = hitOk || !hit ? null : (hit.closest('[aria-label]')?.getAttribute('aria-label') || hit.tagName.toLowerCase() + '.' + String(hit.className).slice(0, 50));
    out[name] = { present: true, text: el.textContent.trim().slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width), inView, hitOk, coveredBy, reachable: inView && hitOk };
  }
  const dr = dialog.getBoundingClientRect();
  let sideways = [];
  for (const el of dialog.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > Math.min(vw, dr.right) + 1) {
      let clipped = false;
      for (let p = el.parentElement; p && p !== dialog.parentElement; p = p.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; }
      }
      if (!clipped) sideways.push(el.tagName.toLowerCase() + ':' + el.textContent.trim().slice(0, 30));
    }
  }
  // Text wider than its own box spills over neighbours without moving any box edge.
  const spill = Array.from(dialog.querySelectorAll('*')).filter((el) => {
    const cs = getComputedStyle(el);
    if (!el.clientWidth || cs.textOverflow === 'ellipsis' || /(auto|scroll|hidden|clip)/.test(cs.overflowX)) return false;
    return el.scrollWidth > el.clientWidth + 1 && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
  }).map((el) => el.textContent.trim().slice(0, 30) + ':' + el.scrollWidth + '>' + el.clientWidth);
  sideways = sideways.concat(spill.map((s) => 'text spill ' + s));
  const scrollers = [dialog, ...dialog.querySelectorAll('*')].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
    .map((el) => ({ cls: String(el.className).slice(0, 60), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  const nav = dialog.querySelector('nav');
  const navCols = nav ? new Set(navLinks.map((a) => Math.round(a.getBoundingClientRect().left))).size : 0;
  const smallTargets = Array.from(dialog.querySelectorAll('a, button')).filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height < 43.5; }).map((el) => (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 30) + ':' + Math.round(el.getBoundingClientRect().height));
  return {
    dialog: { left: Math.round(dr.left), right: Math.round(dr.right), top: Math.round(dr.top), bottom: Math.round(dr.bottom), width: Math.round(dr.width) },
    labelled: dialog.getAttribute('aria-labelledby') ? (document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent || null) : (dialog.getAttribute('aria-label') || null),
    viewport: { vw, vh, docScrollWidth: document.documentElement.scrollWidth },
    navLinks: navLinks.length, navColumns: navCols, projectLinks: projectLinks.length,
    projectsHeading: /Active Projects/i.test(dialog.textContent),
    loadingText: /Loading projects/.test(dialog.textContent), emptyText: /No active projects/.test(dialog.textContent),
    targets: out, sideways: sideways.slice(0, 8), scrollers, smallTargets: smallTargets.slice(0, 20),
  };
})()`;

const describeActive = `(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; const d = document.querySelector('[role="dialog"][aria-modal="true"]'); return (d && d.contains(a) ? 'menu:' : 'page:') + (a.getAttribute('aria-label') || a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 36) || a.tagName); })()`;
const menuState = `(() => { const d = document.querySelector('[role="dialog"][aria-modal="true"]'); if (!d) return null; const host = d.closest('[data-nav-menu]') || d.parentElement.parentElement; const cs = getComputedStyle(host); const r = d.getBoundingClientRect(); return { visibility: cs.visibility, inert: !!d.closest('[inert]'), onScreen: r.right > 0 && r.left < innerWidth, focusableInside: Array.from(d.querySelectorAll('a,button,input,select')).filter((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[inert]')).length, bodyOverflow: getComputedStyle(document.documentElement).overflow + '/' + getComputedStyle(document.body).overflow, panelTransition: getComputedStyle(d).transitionProperty + ' ' + getComputedStyle(d).transitionDuration }; })()`;

async function key(keyName, { shift = false } = {}) {
    const codes = { Tab: 9, Escape: 27, Enter: 13 };
    const base = { key: keyName, code: keyName, windowsVirtualKeyCode: codes[keyName], modifiers: shift ? 8 : 0 };
    // Enter only activates a focused button when the key event carries its text.
    await send("Input.dispatchKeyEvent", keyName === "Enter" ? { type: "keyDown", text: "\r", ...base } : { type: "rawKeyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(60);
}
async function click(x, y) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function tap(x, y) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function centerOf(expr) {
    return evalJs(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
async function shot(name) {
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (s.result?.data) writeFileSync(join(OUT, name), Buffer.from(s.result.data, "base64"));
    return name;
}
const TRIGGER = `document.querySelector('button[aria-label="Open navigation menu"]')`;

// The 300ms slide-out can run late on a loaded machine; wait for it (up to 3s) rather than a fixed sleep.
async function waitSlidOut() {
    for (let i = 0; i < 30; i++) {
        await sleep(100);
        const s = await evalJs(menuState);
        if (s && !s.onScreen && s.visibility === "hidden") return;
    }
}

async function openMenu(vp) {
    const c = await centerOf(TRIGGER);
    if (!c) throw new Error("menu trigger not found");
    if (vp.mobile) await tap(c.x, c.y); else await click(c.x, c.y);
    await sleep(700);
}

// Scroll the way a person would: wheel over the menu body on desktop, a touch
// drag on the phone sizes. Returns how far the wheel actually moved things.
async function scrollMenu(vp, cx, cy, dy) {
    if (vp.mobile) {
        await send("Input.synthesizeScrollGesture", { x: cx, y: cy, yDistance: -dy, gestureSourceType: "touch", speed: 3000 });
    } else {
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: dy });
    }
    await sleep(250);
}

const report = [];
let failures = 0;
for (const name of selected) {
    const vp = VIEWPORTS[name];
    if (!vp) { console.error(`unknown viewport ${name}`); continue; }
    await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 0 });
    await send("Page.navigate", { url: BASE + "/" });
    for (let i = 0; i < 120; i++) { await sleep(500); if (await evalJs(`!!${TRIGGER}`)) break; }
    await evalJs(`(() => {
      try { localStorage.setItem('nexus.displayScale', '${vp.displayScale || 1}'); } catch {}
      document.body.style.setProperty('--nexus-display-scale', '${vp.displayScale || 1}');
      ${vp.rootFont ? `document.documentElement.style.fontSize = '${vp.rootFont}';` : ""}
      // next dev's own issues badge is dev tooling, not the app; keep it out of hit tests and shots.
      const hide = document.createElement('style');
      hide.textContent = 'nextjs-portal { display: none !important; }';
      document.head.append(hide);
      return true; })()`);
    await sleep(2500);
    const row = { viewport: name, fixture: FIXTURE, shell: SHELL };
    row.closedBefore = await evalJs(menuState);
    // The dashboard's Project Reference grid, outside the menu, is where projects live now.
    row.dashboardProjects = await evalJs(`new Set(Array.from(document.querySelectorAll('a[href^="/project/"]')).filter((a) => !a.closest('[data-nav-menu]')).map((a) => a.getAttribute('href'))).size`);
    // Let the page be scrollable behind the menu so the containment check means something.
    row.pageScrollBefore = await evalJs(`(window.scrollTo(0, 0), document.documentElement.scrollHeight - innerHeight)`);
    await openMenu(vp);
    row.focusAfterOpen = await evalJs(describeActive);
    row.openState = await evalJs(menuState);
    row.atOpen = await evalJs(PROBE);
    row.shots = [await shot(`${TAG}_${name}_open.png`)];

    // Scroll the menu to its end, checking targets after every step.
    const d = row.atOpen.dialog;
    const cx = Math.round(Math.max(d.left, 0) + Math.min(d.width, vp.width) / 2);
    const cy = Math.round(vp.height * 0.55);
    const reached = Object.fromEntries(Object.entries(row.atOpen.targets).map(([k, t]) => [k, !!t.reachable]));
    const covered = {};
    let lastSig = "";
    let still = 0;
    for (let step = 0; step < 60 && still < 3; step++) {
        await scrollMenu(vp, cx, cy, 240);
        const p = await evalJs(PROBE);
        for (const [k, t] of Object.entries(p.targets)) {
            if (t.reachable) reached[k] = true;
            else if (t.present && t.inView && t.coveredBy) covered[k] = t.coveredBy;
        }
        const sig = JSON.stringify(Object.values(p.targets).map((t) => t.top));
        still = sig === lastSig ? still + 1 : 0;
        lastSig = sig;
    }
    row.afterScroll = await evalJs(PROBE);
    row.pageScrollY = await evalJs("Math.round(window.scrollY)");
    row.reached = reached;
    // Only targets that never became reachable count as covered; passing under
    // the pinned header or footer while scrolling is expected.
    row.covered = Object.fromEntries(Object.entries(covered).filter(([k]) => !reached[k]));
    row.shots.push(await shot(`${TAG}_${name}_scrolled.png`));

    if (INTERACT) {
        await key("Escape");
        await waitSlidOut();
        row.escape = { state: await evalJs(menuState), focus: await evalJs(describeActive) };
        // Keyboard open + Tab walk: focus must stay in the menu and visit every target.
        await evalJs(`(${TRIGGER}).focus(), true`);
        await key("Enter");
        await sleep(700);
        row.keyboardOpenFocus = await evalJs(describeActive);
        const walk = [];
        for (let i = 0; i < 60; i++) {
            await key("Tab");
            walk.push(await evalJs(`(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { who: ${describeActive}, visible: r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.height > 0 }; })()`));
        }
        row.tabWalk = { steps: walk.length, leftMenu: walk.filter((w) => !w.who.startsWith("menu:")).map((w) => w.who), hiddenWhileFocused: walk.filter((w) => !w.visible).map((w) => w.who), visited: [...new Set(walk.map((w) => w.who))] };
        await key("Tab", { shift: true });
        row.shiftTab = await evalJs(describeActive);
        // Backdrop: click outside the panel when the panel leaves room for it.
        await key("Escape");
        await sleep(500);
        await openMenu(vp);
        const panel = (await evalJs(PROBE)).dialog;
        if (panel.right < vp.width - 24) {
            const bx = Math.round((panel.right + vp.width) / 2), by = Math.round(vp.height / 2);
            if (vp.mobile) await tap(bx, by); else await click(bx, by);
            await waitSlidOut();
            row.backdrop = { clickedAt: [bx, by], state: await evalJs(menuState), focus: await evalJs(describeActive) };
        } else {
            row.backdrop = { skipped: "panel covers the viewport width; Close button is the dismiss control" };
            await key("Escape");
            await sleep(500);
        }
        if (SHELL) {
            await openMenu(vp);
            const c = await centerOf(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim().startsWith('Connection settings'))`);
            if (c) {
                await evalJs(`(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim().startsWith('Connection settings'))).scrollIntoView({ block: 'nearest' }), true`);
                await sleep(200);
                const c2 = await centerOf(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim().startsWith('Connection settings'))`);
                if (vp.mobile) await tap(c2.x, c2.y); else await click(c2.x, c2.y);
                await sleep(1000);
                row.connectionSettings = { messages: await evalJs("window.__shellMessages.filter((m) => m.type === 'open-settings')"), state: await evalJs(menuState) };
            }
        }
        row.closedAfter = await evalJs(menuState);
    }

    const missing = Object.entries(reached).filter(([k, ok]) => !ok && row.atOpen.targets[k].present).map(([k]) => k);
    const absent = Object.entries(row.atOpen.targets).filter(([, t]) => !t.present).map(([k]) => k);
    row.unreachable = missing;
    row.absent = absent;
    const sideways = row.afterScroll.viewport.docScrollWidth > row.afterScroll.viewport.vw || row.afterScroll.sideways.length > 0;
    const problems = [];
    const shown = [row.atOpen, row.afterScroll];
    if (shown.some((p) => p.projectLinks > 0 || p.projectsHeading || p.loadingText || p.emptyText)) problems.push("menu still shows Active Projects");
    if (FIXTURE !== "loading" && row.dashboardProjects !== projectsFixture().length) problems.push(`dashboard lists ${row.dashboardProjects} of ${projectsFixture().length} projects`);
    if (row.pageScrollY > 0) problems.push("page scrolled behind the menu");
    if (row.closedBefore.focusableInside > 0) problems.push("closed menu is focusable");
    if (vp.mobile && row.atOpen.smallTargets.length) problems.push(`touch targets under 44px: ${row.atOpen.smallTargets.join(",")}`);
    if (process.env.CHECK_REDUCED_MOTION === "1" && !/^none |^\S+ 0s$/.test(row.openState.panelTransition)) problems.push(`panel animates under reduced motion (${row.openState.panelTransition})`);
    if (INTERACT) {
        if (!row.focusAfterOpen.startsWith("menu:")) problems.push(`open left focus on ${row.focusAfterOpen}`);
        if (!row.keyboardOpenFocus.startsWith("menu:")) problems.push(`keyboard open left focus on ${row.keyboardOpenFocus}`);
        if (row.tabWalk.leftMenu.length) problems.push(`Tab left the menu ${row.tabWalk.leftMenu.length}x`);
        if (row.tabWalk.hiddenWhileFocused.length) problems.push(`focused off screen: ${row.tabWalk.hiddenWhileFocused.join(",")}`);
        if (!row.shiftTab.startsWith("menu:")) problems.push(`Shift+Tab left the menu (${row.shiftTab})`);
        if (row.escape.focus !== "page:Open navigation menu" || row.escape.state.focusableInside > 0) problems.push("Escape did not close and return focus");
        if (row.backdrop.state && (row.backdrop.state.onScreen || row.backdrop.focus !== "page:Open navigation menu")) problems.push("backdrop did not close and return focus");
        if (SHELL && !(row.connectionSettings?.messages?.length === 1 && !row.connectionSettings.state.onScreen)) problems.push("Connection settings did not post open-settings and close");
        if (row.closedAfter.focusableInside > 0) problems.push("closed menu is focusable");
    }
    row.problems = problems;
    if (missing.length || sideways || problems.length) failures++;
    report.push(row);
    console.log(`${name.padEnd(9)} ${TAG.padEnd(14)} panel ${d.width}px cols ${row.atOpen.navColumns} links ${row.atOpen.navLinks} menu projects ${row.atOpen.projectLinks} dashboard projects ${row.dashboardProjects}` +
        ` | unreachable: ${missing.join(",") || "none"}${Object.keys(row.covered).length ? " | covered: " + JSON.stringify(row.covered) : ""}` +
        ` | sideways: ${sideways ? "YES " + row.afterScroll.sideways.join(";") : "no"} | pageScrollY ${row.pageScrollY}` +
        (INTERACT ? ` | Tab stops ${row.tabWalk.visited.length}` : "") +
        ` | ${problems.length ? "PROBLEMS: " + problems.join("; ") : "behaviour ok"}`);
}

writeFileSync(join(OUT, `report-${TAG}.json`), JSON.stringify({ base: BASE, fixture: FIXTURE, shell: SHELL, report, blocked: [...new Set(blocked)], apiRequests: [...new Set(requestLog.filter((r) => r.includes("/api/")))] }, null, 2));
ws.close();
chrome.kill();
console.log(`blocked live-API requests: ${[...new Set(blocked)].length}; report ${join(OUT, `report-${TAG}.json`)}`);
process.exit(failures ? 1 : 0);
