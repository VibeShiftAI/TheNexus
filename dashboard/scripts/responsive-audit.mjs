#!/usr/bin/env node
/**
 * Responsive audit: loads dashboard routes in headless Chrome at phone and
 * desktop widths, measures horizontal overflow (document scrollWidth vs
 * viewport, plus the elements whose right edge escapes an unclipped ancestor),
 * and saves a screenshot per route/width. Used to prove the phone layout for
 * the Android shell (docs/mobile-shell.md) without a device.
 *
 *   node scripts/responsive-audit.mjs                # :3000, 390 and 1440
 *   AUDIT_ROUTES=/,/inbox AUDIT_WIDTHS=390 node scripts/responsive-audit.mjs
 *
 * Env: AUDIT_BASE (http://localhost:3000), AUDIT_OUT (./.responsive-audit),
 * AUDIT_ROUTES (comma list), AUDIT_WIDTHS (comma list), AUDIT_SETTLE_MS (7000),
 * AUDIT_ALL_OFFENDERS=1 to list every element past the viewport (including
 * clipped and off-screen ones) with a JSON detail line, AUDIT_PRE_JS to run a
 * JS expression on the page before measuring (for bisecting a fix),
 * AUDIT_CHROME (path to a Chrome/Chromium binary), AUDIT_STRICT=1 to exit 1
 * when any phone-width route still scrolls horizontally.
 * Writes <out>/report.json and <out>/<width>_<route>.png.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME_CANDIDATES = [
    process.env.AUDIT_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
    console.error("No Chrome binary found; set AUDIT_CHROME.");
    process.exit(2);
}

const BASE = (process.env.AUDIT_BASE || "http://localhost:3000").replace(/\/$/, "");
const OUT = resolve(process.env.AUDIT_OUT || ".responsive-audit");
const DEFAULT_ROUTES = "/,/task-board,/inbox,/ops,/council,/model-control,/system-monitor,/activity,/academy,/codex,/knowledge-ingestion,/intake-reports,/studio,/calendar,/mail";
const routes = (process.env.AUDIT_ROUTES || DEFAULT_ROUTES).split(",").map((r) => r.trim()).filter(Boolean);
const widths = (process.env.AUDIT_WIDTHS || "390,1440").split(",").map(Number);
const SETTLE_MS = Number(process.env.AUDIT_SETTLE_MS || 7000);
const PHONE_MAX = 800;

mkdirSync(OUT, { recursive: true });
const port = 9334 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "nexus-audit-"));
const chrome = spawn(
    CHROME,
    ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"],
    { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let version = null;
for (let i = 0; i < 50 && !version; i++) {
    try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
        await sleep(200);
    }
}
if (!version) {
    chrome.kill();
    console.error("Chrome did not expose its debugging port.");
    process.exit(2);
}
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const pending = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
    }
};
const send = (method, params = {}) =>
    new Promise((res) => {
        const id = ++nextId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
    });
await send("Page.enable");
await send("Runtime.enable");
const evalJs = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

const OVERFLOW_JS = `(() => {
  const iw = document.documentElement.clientWidth;
  const bad = [];
  const ALL = ${process.env.AUDIT_ALL_OFFENDERS ? "true" : "false"};
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!ALL && (r.width === 0 || r.height === 0)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' && r.right <= iw + 1) continue;
    if (r.right > iw + 1 && (ALL || r.left < iw)) {
      let clipped = false, p = el.parentElement;
      while (p && p !== document.body) {
        const pc = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(pc.overflowX)) { clipped = true; break; }
        p = p.parentElement;
      }
      if (!clipped || ALL) bad.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.baseVal === undefined ? String(el.className) : '').slice(0, 90),
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height),
        text: (el.textContent || '').trim().slice(0, 40),
        clipped,
      });
    }
  }
  const textOverflow = [];
  if (ALL) {
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' || el.clientWidth === 0) continue;
      if (el.scrollWidth > el.clientWidth + 2) {
        const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
        const r = el.getBoundingClientRect();
        textOverflow.push({ tag: el.tagName.toLowerCase(), cls: (el.className && el.className.baseVal === undefined ? String(el.className) : '').slice(0, 80), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, left: Math.round(r.left), hasText, text: (el.textContent || '').trim().slice(0, 60) });
      }
    }
  }
  return JSON.stringify({
    textOverflow: textOverflow.slice(0, 40),
    scrollWidth: document.documentElement.scrollWidth, clientWidth: iw,
    bodyScrollWidth: document.body.scrollWidth, offenders: bad.slice(0, ALL ? 60 : 12), count: bad.length,
    title: document.title,
    innerWidth: window.innerWidth,
    visualWidth: window.visualViewport ? Math.round(window.visualViewport.width) : null,
    visualScale: window.visualViewport ? window.visualViewport.scale : null,
  });
})()`;

const report = [];
for (const width of widths) {
    const phone = width < PHONE_MAX;
    await send("Emulation.setDeviceMetricsOverride", { width, height: phone ? 844 : 900, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
    await send("Emulation.setTouchEmulationEnabled", { enabled: phone });
    for (const route of routes) {
        await send("Page.navigate", { url: BASE + route });
        await sleep(SETTLE_MS);
        if (process.env.AUDIT_PRE_JS) { await evalJs(process.env.AUDIT_PRE_JS); await sleep(500); }
        const raw = await evalJs(OVERFLOW_JS);
        const data = raw ? JSON.parse(raw) : { error: "no-eval" };
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const name = `${width}${route === "/" ? "_home" : route.replace(/[^a-z0-9]+/gi, "_")}.png`;
        if (shot.result?.data) writeFileSync(join(OUT, name), Buffer.from(shot.result.data, "base64"));
        const overflow = data.scrollWidth > data.clientWidth;
        report.push({ width, route, ...data, overflow, shot: name });
        const worst = (data.offenders || []).slice(0, 3).map((o) => `${o.tag}.${o.cls.split(" ").slice(0, 3).join(".")}→${o.right}`).join(" | ");
        console.log(`${String(width).padStart(5)} ${route.padEnd(22)} scrollWidth ${String(data.scrollWidth).padStart(5)}/${data.clientWidth} ${overflow ? "OVERFLOW" : "ok      "} offenders ${data.count ?? "?"} ${worst}`);
        if (process.env.AUDIT_ALL_OFFENDERS) console.log("   detail", JSON.stringify({ innerWidth: data.innerWidth, visualWidth: data.visualWidth, visualScale: data.visualScale, offenders: data.offenders, textOverflow: data.textOverflow }));
    }
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
ws.close();
chrome.kill();

const failing = report.filter((r) => r.width < PHONE_MAX && r.overflow);
console.log(`\n${report.length} route/width checks; ${failing.length} phone-width overflow(s). Report: ${join(OUT, "report.json")}`);
if (process.env.AUDIT_STRICT && failing.length) process.exit(1);
