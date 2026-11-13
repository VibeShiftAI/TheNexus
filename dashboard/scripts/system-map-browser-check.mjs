#!/usr/bin/env node
/**
 * Browser check for the System Map page (app/system-map, task 42df7682).
 *
 * One foreground process owns the whole stack and stops it on exit:
 *   - a throwaway API on CHECK_API_PORT that mounts the real
 *     server/routes/system-map.js router, reading the map that is in the
 *     vault now. A switch only this script can reach decides whether a read
 *     carries an operator session; switched off, the route's real authority
 *     check answers, so the refusal the page shows is the real one. The API
 *     records every request it receives.
 *   - a second `next dev` on CHECK_PORT with its own dist dir, proxying /api
 *     to that throwaway API (set CHECK_BASE to reuse a server already up).
 *   - headless Chrome over CDP.
 *
 * It then proves, in a real browser against the live map: the stamp and
 * facts hash equal the vault file's, the six views render, a component's
 * detail lists purpose, size, activity, routes, jobs and both directions with
 * source locations, the page works from the keyboard, at phone width and in
 * both themes, and the page reads the map once on load and once per Refresh
 * with nothing in between and nothing that writes. The browser cannot reach
 * the live API on :4000 directly; the throwaway API passes the shell's own
 * reads (health, counts) through to it and forwards nothing that writes.
 *
 *   CHECK_OUT=/path/out node scripts/system-map-browser-check.mjs
 *
 * Env: CHECK_OUT (./.system-map-check), CHECK_PORT (3107), CHECK_API_PORT
 * (4397), CHECK_BASE (use a running dashboard whose /api reaches
 * CHECK_API_PORT), CHECK_IDLE_MS (20000), CHECK_CHROME. Exits 1 on a failed check.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = resolve(HERE, "..");
const REPO = resolve(DASHBOARD, "..");
const requireRepo = createRequire(join(REPO, "server", "server.js"));

const CHROME = [
    process.env.CHECK_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }

const OUT = resolve(process.env.CHECK_OUT || ".system-map-check");
const PORT = Number(process.env.CHECK_PORT || 3107);
const API_PORT = Number(process.env.CHECK_API_PORT || 4397);
const BASE = (process.env.CHECK_BASE || `http://localhost:${PORT}`).replace(/\/$/, "");
const IDLE_MS = Number(process.env.CHECK_IDLE_MS || 20000);
const DIST = ".next-system-map-check";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The map in the vault now ────────────────────────────────────────────────
const { vaultRoot } = requireRepo("./lib/vault-paths");
const VAULT_MAP = join(vaultRoot(), "system-map", "system-map.json");
const vaultBytes = readFileSync(VAULT_MAP);
const vaultMap = JSON.parse(vaultBytes.toString("utf8"));

// A component with everything the detail has to show: routes, jobs, and links both ways.
function pickSubject(map) {
    const routes = new Map(), jobs = new Map(), outs = new Map(), ins = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const r of map.catalogs.routes || []) if (r.owner) bump(routes, r.owner);
    for (const c of map.catalogs.crons || []) if (c.owner) bump(jobs, c.owner);
    for (const e of map.edges) { bump(outs, e.from); bump(ins, e.to); }
    const full = map.nodes.filter((n) => n.level === 2 && n.purpose && routes.get(n.id) && jobs.get(n.id) && outs.get(n.id) && ins.get(n.id));
    full.sort((a, b) => (routes.get(a.id) + jobs.get(a.id)) - (routes.get(b.id) + jobs.get(b.id)) || a.id.localeCompare(b.id));
    return full[0] || null;
}
const subject = pickSubject(vaultMap);
if (!subject) { console.error("The vault map has no component with routes, jobs and links both ways."); process.exit(2); }

// ── Throwaway API: the real router, a recorded request log ──────────────────
const express = requireRepo("express");
const createSystemMapRouter = requireRepo("./routes/system-map");
const { createDocumentDecisionAuthority } = requireRepo("./services/document-decision-authority");
const realAuthority = createDocumentDecisionAuthority();
let operatorSession = true;
const apiLog = [];
const api = express();
api.use((req, _res, next) => { apiLog.push({ method: req.method, path: req.path, at: Date.now() }); next(); });
api.use("/api/system-map", createSystemMapRouter({
    authorize: (req) => (operatorSession ? { ok: true, actor: { authority: "access_user", id: "browser-check" } } : realAuthority(req)),
}));
// Everything else the dashboard shell asks for (health, inbox counts, presence)
// is the shell's own traffic, not this page's. Reads are passed to the running
// Nexus API so the chrome around the map looks as it does in use; anything
// that is not a read is answered here and never forwarded.
const LIVE_API = (process.env.CHECK_LIVE_API || "http://127.0.0.1:4000").replace(/\/$/, "");
api.use(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return res.status(204).end();
    if (/\/(stream|events)(\/|$)/.test(req.path) || req.headers.accept === "text/event-stream") return res.status(204).end();
    try {
        const upstream = await fetch(`${LIVE_API}${req.originalUrl}`, { headers: { accept: req.headers.accept || "*/*" }, signal: AbortSignal.timeout(8000) });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.status(upstream.status).set("Content-Type", upstream.headers.get("content-type") || "application/json").send(body);
    } catch {
        if (req.path === "/api/health") return res.json({ status: "ok" });
        res.status(404).json({ error: "not served by the system-map check" });
    }
});
const apiServer = await new Promise((res, rej) => { const s = api.listen(API_PORT, "127.0.0.1", () => res(s)); s.on("error", rej); });

// ── Dashboard ───────────────────────────────────────────────────────────────
const cleanup = [() => apiServer.close()];
let cleaned = false;
function stopAll() {
    if (cleaned) return;
    cleaned = true;
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* already gone */ } }
}
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopAll(); process.exit(130); });
process.on("unhandledRejection", (err) => { console.error(err); stopAll(); process.exit(2); });

if (!process.env.CHECK_BASE) {
    // `next dev` with another dist dir appends it to tsconfig.json; put the bytes back afterwards.
    const tsconfig = join(DASHBOARD, "tsconfig.json");
    const keep = join(mkdtempSync(join(tmpdir(), "nexus-system-map-ts-")), "tsconfig.json");
    copyFileSync(tsconfig, keep);
    const next = spawn(process.execPath, [join(DASHBOARD, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT)], {
        cwd: DASHBOARD, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NEXT_DIST_DIR: DIST, NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" },
    });
    let nextOut = "";
    next.stdout.on("data", (d) => { nextOut += d; });
    next.stderr.on("data", (d) => { nextOut += d; });
    cleanup.push(() => {
        try { process.kill(-next.pid, "SIGTERM"); } catch { /* gone */ }
        copyFileSync(keep, tsconfig);
        rmSync(join(DASHBOARD, DIST), { recursive: true, force: true });
    });
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {
        if (next.exitCode !== null) break;
        try { up = (await fetch(`${BASE}/system-map`, { signal: AbortSignal.timeout(60000) })).ok; } catch { await sleep(500); }
    }
    if (!up) { console.error(`next dev did not come up on ${PORT}\n${nextOut.slice(-2000)}`); stopAll(); process.exit(2); }
}

// ── Chrome + CDP ────────────────────────────────────────────────────────────
const cdpPort = 9500 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "nexus-system-map-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
cleanup.push(() => chrome.kill());
let version = null;
for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch { await sleep(200); }
}
if (!version) { console.error("Chrome did not start"); stopAll(); process.exit(2); }
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
const browserLog = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Network.requestWillBeSent") {
        const u = new URL(m.params.request.url);
        if (u.protocol.startsWith("http")) browserLog.push({ method: m.params.request.method, host: u.host, path: u.pathname, at: Date.now() });
    }
};
const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} was not answered in 30s`)); }, 30000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`page eval failed: ${JSON.stringify(r.result.exceptionDetails).slice(0, 500)}`);
    return r.result?.result?.value;
};
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
// The shell around every page talks to the live API directly; this check must not.
await send("Network.setBlockedURLs", { urls: ["*://localhost:4000/*", "*://127.0.0.1:4000/*"] });

const results = [];
const failures = [];
function check(name, ok, detail = "") {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
    if (!ok) failures.push(name);
}
const shots = [];
async function shot(name, { full = false } = {}) {
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    shots.push(`${name}.png`);
}
async function viewport({ width, height, mobile }) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
}
async function waitFor(expression, what, ms = 30000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await evalJs(expression).catch(() => false)) return true;
        await sleep(100);
    }
    check(`waited for ${what}`, false, "timed out");
    return false;
}
async function open(path = "/system-map") {
    await send("Page.navigate", { url: `${BASE}${path}` });
    await waitFor(`document.querySelector('[data-sm-root]') && document.querySelector('[data-sm-refresh]') && !document.querySelector('[data-sm-refresh]').disabled`, `${path} to settle`);
    await sleep(400);
}
const key = async (k, code = k, extra = {}) => {
    const vk = { Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37, End: 35, Home: 36 }[k];
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...extra };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (k === "Enter") await send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(150);
};
const clickAt = async (selector) => {
    const p = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!p) { check(`found ${selector}`, false); return; }
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(350);
};
// Phone steps use the same pointer path: a tap lands on the page as a click.
const tapAt = clickAt;
const OVERFLOW = `(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }))()`;
const mapReads = (log = browserLog) => log.filter((r) => r.path === "/api/system-map");
const tile = `.sm-tile[data-sm-id="${subject.id}"]`;
// WCAG contrast of the map's body text against its own background.
const CONTRAST = `(() => {
  const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const root = document.querySelector('[data-sm-root]');
  const bg = getComputedStyle(document.querySelector('.sm-view')).backgroundColor;
  const rootBg = getComputedStyle(root).backgroundColor;
  const back = /rgba?\\(0, 0, 0, 0\\)/.test(bg) ? rootBg : bg;
  const out = { theme: root.getAttribute('data-sm-theme'), background: back };
  for (const [name, sel] of [['text', '.sm-tile'], ['muted', '.sm-stamp'], ['tab', '.sm-tab[aria-selected="true"]']]) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const own = getComputedStyle(el).backgroundColor;
    out[name] = Math.round(ratio(getComputedStyle(el).color, /rgba?\\(0, 0, 0, 0\\)/.test(own) ? back : own) * 100) / 100;
  }
  return out;
})()`;

// ── 1. Desktop, dark: the live map, its stamp, the six views ────────────────
await viewport({ width: 1440, height: 900, mobile: false });
const loadStart = browserLog.length;
await open();
await waitFor(`Boolean(document.querySelector('[data-sm-loaded="true"]'))`, "the map to load");
const stamp = await evalJs(`({ generated: document.querySelector('[data-sm-generated]')?.getAttribute('data-sm-generated'), shown: document.querySelector('[data-sm-stamp]')?.textContent, hash: document.querySelector('[data-sm-hash]')?.textContent, theme: document.querySelector('[data-sm-root]').getAttribute('data-sm-theme') })`);
check("stamp shows when the vault map was generated", stamp.generated === vaultMap.generatedAt, `${stamp.shown}`);
check("stamp shows the vault map's facts hash", stamp.hash === vaultMap.factsHash, `${stamp.hash} vs vault ${vaultMap.factsHash}`);
check("the map opens in the dashboard's dark theme", stamp.theme === "dark");
const tiles = await evalJs(`document.querySelectorAll('.sm-tile[data-sm-id]').length`);
const level2 = vaultMap.nodes.filter((n) => n.level === 2).length;
check("every component in the vault map has a tile", tiles >= level2, `${tiles} tiles, ${level2} components, ${vaultMap.nodes.length} nodes`);
const tabs = await evalJs(`Array.from(document.querySelectorAll('[role=tab]')).map((t) => t.getAttribute('data-sm-tab'))`);
check("six views are offered", JSON.stringify(tabs) === JSON.stringify(["map", "connections", "schedule", "routes", "drift", "boundary"]), tabs.join(", "));
check("one read of the map on load", mapReads(browserLog.slice(loadStart)).length === 1, `${mapReads(browserLog.slice(loadStart)).length} GET /api/system-map`);
let o = await evalJs(OVERFLOW);
check("desktop: no sideways page scroll", o.doc <= o.win, `${o.doc} of ${o.win}`);
let contrast = await evalJs(CONTRAST);
check("dark theme: text contrast at least 4.5:1", contrast.text >= 4.5 && contrast.muted >= 4.5 && contrast.tab >= 4.5, JSON.stringify(contrast));
await shot("desktop-dark-map");

// ── 2. A component's detail ─────────────────────────────────────────────────
await clickAt(tile);
const detail = await evalJs(`(() => {
  const p = document.querySelector('[data-sm-panel]');
  const sec = (k) => p.querySelector('[data-sm-section="' + k + '"]');
  const loc = /[\\w.-]+\\/[\\w./-]+\\.[a-z]+:\\d+/;
  return {
    selected: p.getAttribute('data-sm-selected'), text: p.textContent,
    out: sec('out')?.textContent || '', incoming: sec('in')?.textContent || '',
    outLoc: loc.test(sec('out')?.textContent || ''), inLoc: loc.test(sec('in')?.textContent || ''),
    jobs: sec('jobs')?.textContent || '', routes: sec('routes')?.textContent || '',
    jobsLoc: loc.test(sec('jobs')?.textContent || ''), routesLoc: loc.test(sec('routes')?.textContent || ''),
    facts: p.querySelector('[data-sm-facts]')?.textContent || '',
  };
})()`);
check("selecting a component opens its detail", detail.selected === subject.id, subject.id);
check("detail: purpose, with where it came from", detail.text.includes(subject.purpose) && /Purpose (from|lifted)/.test(detail.text), subject.purpose.slice(0, 70));
check("detail: size and activity", /lines/.test(detail.facts) && /commits, 90 days/.test(detail.facts) && /last commit/.test(detail.facts), detail.facts.slice(0, 120));
check("detail: connections out, with source locations", detail.out.length > 0 && detail.outLoc, detail.out.slice(0, 90));
check("detail: connections in, with source locations", detail.incoming.length > 0 && detail.inLoc, detail.incoming.slice(0, 90));
check("detail: scheduled jobs, with source locations", detail.jobs.length > 0 && detail.jobsLoc, detail.jobs.slice(0, 90));
check("detail: routes, with source locations", detail.routes.length > 0 && detail.routesLoc, detail.routes.slice(0, 90));
await shot("desktop-dark-component-detail");

// ── 3. The other five views ─────────────────────────────────────────────────
const VIEW_TEXT = { connections: /Strongest links/i, schedule: /All jobs/i, routes: /Defined at/i, drift: /warning/i, boundary: /Tunnel|tunnel/ };
for (const name of ["connections", "schedule", "routes", "drift", "boundary"]) {
    await clickAt(`[data-sm-tab="${name}"]`);
    const v = await evalJs(`({ view: document.querySelector('[role=tabpanel]').getAttribute('data-sm-view'), text: document.querySelector('[role=tabpanel]').textContent.slice(0, 6000), length: document.querySelector('[role=tabpanel]').textContent.length, search: location.search })`);
    check(`view: ${name} renders the live map`, v.view === name && VIEW_TEXT[name].test(v.text) && v.length > 400, `${v.length} chars, ${v.search}`);
    o = await evalJs(OVERFLOW);
    check(`view: ${name} has no sideways page scroll (desktop)`, o.doc <= o.win, `${o.doc} of ${o.win}`);
    await evalJs(`window.scrollTo(0, 0)`);
    await shot(`desktop-dark-${name}`);
}
check("moving between views and selecting read nothing more", mapReads(browserLog.slice(loadStart)).length === 1, `${mapReads(browserLog.slice(loadStart)).length} GET /api/system-map`);

// ── 4. Keyboard ─────────────────────────────────────────────────────────────
await open();
await waitFor(`Boolean(document.querySelector('[data-sm-loaded="true"]'))`, "the map to load");
await evalJs(`document.querySelector('[data-sm-tab="map"]').focus()`);
await key("ArrowRight");
let kb = await evalJs(`({ view: document.querySelector('[role=tabpanel]').getAttribute('data-sm-view'), focus: document.activeElement.getAttribute('data-sm-tab') })`);
check("keyboard: Right arrow moves to the next view and takes focus with it", kb.view === "connections" && kb.focus === "connections");
await key("End");
kb = await evalJs(`({ view: document.querySelector('[role=tabpanel]').getAttribute('data-sm-view'), focus: document.activeElement.getAttribute('data-sm-tab') })`);
check("keyboard: End moves to the last view", kb.view === "boundary" && kb.focus === "boundary");
await key("Home");
await evalJs(`document.querySelector(${JSON.stringify(tile)}).focus()`);
const ring = await evalJs(`(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth }; })()`);
check("keyboard: a focused tile shows a focus ring", ring.style !== "none" && parseFloat(ring.width) >= 2, `${ring.style} ${ring.width}`);
await key("Enter");
kb = await evalJs(`({ selected: document.querySelector('[data-sm-panel]').getAttribute('data-sm-selected'), inPanel: Boolean(document.activeElement.closest('[data-sm-panel]')) })`);
check("keyboard: Enter on a tile opens its detail and moves focus into it", kb.selected === subject.id && kb.inPanel);
await shot("desktop-dark-keyboard-detail");
await key("Escape");
await sleep(250);
kb = await evalJs(`({ selected: document.querySelector('[data-sm-panel]').getAttribute('data-sm-selected'), focus: document.activeElement.getAttribute('data-sm-id'), on: document.activeElement.tagName + '.' + document.activeElement.className })`);
check("keyboard: Escape closes the detail and returns focus to the tile", kb.selected === "" && kb.focus === subject.id, JSON.stringify(kb));
// The same from a box in the service diagram, which is an SVG element.
await evalJs(`(window.scrollTo(0, 0), document.querySelector('[data-sm-diagram-node="nexus/api"]').focus())`);
await key("Enter");
kb = await evalJs(`({ selected: document.querySelector('[data-sm-panel]').getAttribute('data-sm-selected'), inPanel: Boolean(document.activeElement.closest('[data-sm-panel]')) })`);
check("keyboard: Enter on a diagram box opens its detail and moves focus into it", kb.selected === "nexus/api" && kb.inPanel, JSON.stringify(kb));
await key("Escape");
await sleep(250);
kb = await evalJs(`({ selected: document.querySelector('[data-sm-panel]').getAttribute('data-sm-selected'), focus: document.activeElement.getAttribute('data-sm-diagram-node') })`);
check("keyboard: Escape returns focus to the diagram box", kb.selected === "" && kb.focus === "nexus/api", JSON.stringify(kb));
const lanes = await evalJs(`(() => { const d = Array.from(document.querySelectorAll('[data-sm-diagram] path')).map((p) => p.getAttribute('d')).filter(Boolean); const seen = new Map(); for (const x of d) seen.set(x, (seen.get(x) || 0) + 1); return { paths: d.length, lines: seen.size, stacked: Array.from(seen.values()).filter((n) => n > 2).length }; })()`);
check("diagram: links in opposite directions are drawn apart", lanes.lines > 0 && lanes.stacked === 0, JSON.stringify(lanes));
// Tab from the top of the page: every stop is a visible control inside the viewport after scrolling.
await evalJs(`(document.activeElement.blur(), window.scrollTo(0, 0))`);
const stops = [];
for (let i = 0; i < 24; i++) {
    await key("Tab");
    stops.push(await evalJs(`(() => { const el = document.activeElement; if (!el || el === document.body) return { tag: 'body', ok: false }; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30), ok: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight, inMap: Boolean(el.closest('[data-sm-root]')) }; })()`));
}
const mapStops = stops.filter((s) => s.inMap);
const hidden = mapStops.filter((s) => !s.ok);
check("keyboard: Tab reaches the map's controls and every stop is visible", mapStops.length >= 8 && hidden.length === 0, `${mapStops.length} of ${stops.length} stops in the map: ${mapStops.slice(0, 8).map((s) => s.label).join(" | ")}${hidden.length ? `; not visible: ${hidden.map((s) => s.label).join(" | ")}` : ""}`);

// ── 5. Light theme, desktop ─────────────────────────────────────────────────
await evalJs(`window.scrollTo(0, 0)`);
await clickAt("[data-sm-theme-toggle]");
contrast = await evalJs(CONTRAST);
check("light theme: the map switches and is remembered", contrast.theme === "light" && (await evalJs(`localStorage.getItem('nexus:system-map-theme')`)) === "light");
check("light theme: text contrast at least 4.5:1", contrast.text >= 4.5 && contrast.muted >= 4.5 && contrast.tab >= 4.5, JSON.stringify(contrast));
await shot("desktop-light-map");
await clickAt(tile);
await shot("desktop-light-component-detail");
await clickAt(tile);

// ── 6. Idle, then Refresh: the request log ──────────────────────────────────
const idleFrom = Date.now();
const apiIdleFrom = apiLog.length;
await sleep(IDLE_MS);
const idleReads = mapReads(browserLog.filter((r) => r.at >= idleFrom));
check(`no read of the map while the page sits open for ${Math.round(IDLE_MS / 1000)}s`, idleReads.length === 0 && apiLog.slice(apiIdleFrom).filter((r) => r.path.startsWith("/api/system-map")).length === 0, `${idleReads.length} from the browser, ${apiLog.slice(apiIdleFrom).filter((r) => r.path.startsWith("/api/system-map")).length} at the API`);
const beforeRefresh = mapReads().length;
await clickAt("[data-sm-refresh]");
await waitFor(`!document.querySelector('[data-sm-refresh]').disabled`, "Refresh to finish");
check("Refresh reads the map exactly once more", mapReads().length === beforeRefresh + 1, `${beforeRefresh} then ${mapReads().length}`);
const mapMethods = [...new Set(apiLog.filter((r) => r.path.startsWith("/api/system-map")).map((r) => r.method))];
check("the API saw only GET for the map", mapMethods.length === 1 && mapMethods[0] === "GET", mapMethods.join(", "));

// ── 7. Phone width, both themes ─────────────────────────────────────────────
await viewport({ width: 390, height: 844, mobile: true });
for (const theme of ["dark", "light"]) {
    await evalJs(`localStorage.setItem('nexus:system-map-theme', ${JSON.stringify(theme)})`);
    await open();
    await waitFor(`Boolean(document.querySelector('[data-sm-loaded="true"]'))`, "the map to load (phone)");
    const t = await evalJs(`document.querySelector('[data-sm-root]').getAttribute('data-sm-theme')`);
    check(`phone ${theme}: theme applied`, t === theme);
    o = await evalJs(OVERFLOW);
    check(`phone ${theme}: no sideways page scroll`, o.doc <= o.win, `${o.doc} of ${o.win}`);
    if (theme === "dark") {
        const small = await evalJs(`Array.from(document.querySelectorAll('[data-sm-root] .sm-tab, [data-sm-root] .sm-btn, [data-sm-root] .sm-chip, [data-sm-root] .sm-tile')).filter((el) => el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return { label: el.textContent.trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((r) => r.h < 44 || r.w < 44)`);
        check("phone: tabs, buttons, filters and tiles are at least 44px to tap", small.length === 0, small.slice(0, 5).map((s) => `${s.label} ${s.w}x${s.h}`).join("; "));
    }
    await shot(`phone-${theme}-map`);
    await tapAt(tile);
    const sheet = await evalJs(`(() => { const p = document.querySelector('[data-sm-panel]'); const r = p.getBoundingClientRect(); return { open: p.getAttribute('data-sm-open'), selected: p.getAttribute('data-sm-selected'), position: getComputedStyle(p).position, w: Math.round(r.width), top: Math.round(r.top), inert: document.querySelector('[role=tablist]').hasAttribute('inert'), inPanel: Boolean(document.activeElement.closest('[data-sm-panel]')), close: (() => { const c = document.querySelector('[data-sm-close]').getBoundingClientRect(); return { w: Math.round(c.width), h: Math.round(c.height), top: Math.round(c.top) }; })() }; })()`);
    check(`phone ${theme}: tapping a component opens its detail over the page`, sheet.open === "true" && sheet.selected === subject.id && sheet.position === "fixed" && sheet.w === 390 && sheet.inert && sheet.inPanel, JSON.stringify(sheet));
    check(`phone ${theme}: the Close button is on screen and 44px`, sheet.close.h >= 44 && sheet.close.w >= 44 && sheet.close.top >= 0 && sheet.close.top < 200, JSON.stringify(sheet.close));
    o = await evalJs(OVERFLOW);
    check(`phone ${theme}: the detail does not scroll sideways`, o.doc <= o.win, `${o.doc} of ${o.win}`);
    await shot(`phone-${theme}-component-detail`);
    await tapAt("[data-sm-close]");
    const closed = await evalJs(`({ open: document.querySelector('[data-sm-panel]').getAttribute('data-sm-open'), inert: document.querySelector('[role=tablist]').hasAttribute('inert') })`);
    check(`phone ${theme}: Close gives the page back`, closed.open === "false" && !closed.inert);
    if (theme === "dark") {
        for (const name of ["connections", "schedule", "routes", "drift", "boundary"]) {
            await tapAt(`[data-sm-tab="${name}"]`);
            const v = await evalJs(`document.querySelector('[role=tabpanel]').getAttribute('data-sm-view')`);
            o = await evalJs(OVERFLOW);
            check(`phone: ${name} view opens with no sideways page scroll`, v === name && o.doc <= o.win, `${o.doc} of ${o.win}`);
            await evalJs(`window.scrollTo(0, 0)`);
            await sleep(150);
            await shot(`phone-dark-${name}`);
        }
    }
}

// ── 8. Without an operator session ──────────────────────────────────────────
operatorSession = false;
const bare = await fetch(`http://127.0.0.1:${API_PORT}/api/system-map`);
const bareBody = await bare.text();
check("the route refuses a request with no sign-in", bare.status === 401 && !bareBody.includes("factsHash") && !bareBody.includes(vaultMap.factsHash), `${bare.status} ${bareBody.slice(0, 80)}`);
await viewport({ width: 1440, height: 900, mobile: false });
await evalJs(`localStorage.setItem('nexus:system-map-theme', 'dark')`);
await open();
const refused = await evalJs(`({ state: document.querySelector('[data-sm-state]')?.getAttribute('data-sm-state'), stamp: Boolean(document.querySelector('[data-sm-stamp]')), tabs: document.querySelectorAll('[role=tab]').length, text: document.querySelector('[data-sm-state]')?.textContent.slice(0, 120) })`);
check("signed out, the page shows the sign-in state and no map", refused.state === "sign-in" && !refused.stamp && refused.tabs === 0, refused.text);
await shot("desktop-signed-out");
operatorSession = true;

// ── Report ──────────────────────────────────────────────────────────────────
const writes = apiLog.filter((r) => r.method !== "GET" && r.method !== "HEAD");
const browserWrites = browserLog.filter((r) => r.path.startsWith("/api/system-map") && r.method !== "GET");
check("no request other than GET reached the map route from the page", browserWrites.length === 0, `${browserWrites.length}`);
const after = readFileSync(VAULT_MAP);
check("the vault map file is byte-identical after the run", Buffer.compare(vaultBytes, after) === 0, `${after.length} bytes`);
const report = {
    task: "42df7682-9abe-4753-a07f-1b295d316852",
    ranAt: new Date().toISOString(),
    base: BASE,
    vaultMap: { file: VAULT_MAP, generatedAt: vaultMap.generatedAt, factsHash: vaultMap.factsHash, nodes: vaultMap.nodes.length, edges: vaultMap.edges.length, bytes: vaultBytes.length },
    subject: { id: subject.id, name: subject.name },
    passed: results.filter((r) => r.ok).length, failed: failures.length, results,
    mapReadsFromBrowser: mapReads().length,
    apiRequests: Object.entries(apiLog.reduce((acc, r) => { const k = `${r.method} ${r.path}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} x ${k}`),
    nonGetRequestsAtApi: writes.map((r) => `${r.method} ${r.path}`),
    screenshots: shots,
};
writeFileSync(join(OUT, "system-map-browser-check.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.passed} passed, ${report.failed} failed; ${shots.length} screenshots in ${OUT}`);
if (writes.length) console.log(`Non-GET requests the dashboard shell sent to the API (none to the map route): ${[...new Set(report.nonGetRequestsAtApi)].join(", ")}`);
ws.close();
stopAll();
process.exit(failures.length ? 1 : 0);
