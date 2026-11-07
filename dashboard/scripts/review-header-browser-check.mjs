#!/usr/bin/env node
/**
 * Review header check (task 3f8d291a): loads one document review page in headless Chrome at desktop
 * (display scale 100%, 125%, 150%), tablet (768px) and phone (375px), saves screenshots, and measures
 * what the reader cares about:
 *
 *  - which elements stay pinned while the page scrolls (header, brief), and how tall the pinned part is;
 *  - whether the brief scrolls away (its bottom passes the header's bottom after a scroll);
 *  - where the rails stick relative to the header's bottom edge (no overlap);
 *  - horizontal overflow (document scrollWidth against the viewport);
 *  - on phone and tablet, the height of every visible tap target in the header, brief, phone bar and the
 *    review drawer's decision buttons, and whether a floating control covers Approve / Request changes
 *    once they are scrolled into view (elementFromPoint at the centre and the four inset corners).
 *
 *   node scripts/review-header-browser-check.mjs <documentId> <outDir> [label]
 *
 * Env: CHECK_BASE (http://localhost:3000), CHECK_SETTLE_MS (9000), CHECK_CHROME, CHECK_CONFIGS (comma list of
 * config names below). Writes <outDir>/<label>-<config>-{top,scrolled,drawer}.png and <outDir>/<label>-report.json.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [documentId, outArg, label = "check"] = process.argv.slice(2);
if (!documentId || !outArg) {
    console.error("usage: review-header-browser-check.mjs <documentId> <outDir> [label]");
    process.exit(2);
}
const CHROME = [process.env.CHECK_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error("No Chrome binary found; set CHECK_CHROME."); process.exit(2); }
const BASE = (process.env.CHECK_BASE || "http://localhost:3000").replace(/\/$/, "");
const SETTLE_MS = Number(process.env.CHECK_SETTLE_MS || 9000);
const OUT = resolve(outArg);
mkdirSync(OUT, { recursive: true });

// Robert's screenshot: a 2940x1694 capture of a 1470x847 CSS-pixel window at device scale 2.
const ALL_CONFIGS = [
    { name: "desktop-100", width: 1470, height: 847, dpr: 2, mobile: false, scale: 1 },
    { name: "desktop-125", width: 1470, height: 847, dpr: 2, mobile: false, scale: 1.25 },
    { name: "desktop-150", width: 1470, height: 847, dpr: 2, mobile: false, scale: 1.5 },
    { name: "tablet-768", width: 768, height: 1024, dpr: 2, mobile: true, scale: 1 },
    { name: "phone-375", width: 375, height: 812, dpr: 3, mobile: true, scale: 1 },
];
const wanted = (process.env.CHECK_CONFIGS || "").split(",").map((s) => s.trim()).filter(Boolean);
const CONFIGS = wanted.length ? ALL_CONFIGS.filter((c) => wanted.includes(c.name)) : ALL_CONFIGS;

const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "nexus-review-header-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
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
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Runtime.enable");
const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
};
const shot = async (file) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (s.result?.data) writeFileSync(join(OUT, file), Buffer.from(s.result.data, "base64"));
    return file;
};

// Runs in the page. Rects are viewport CSS pixels; under the body zoom they stay comparable with each other.
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const page = document.querySelector('[data-document-review-page]');
  const header = page && page.querySelector('header');
  const brief = document.querySelector('[data-human-brief]');
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height), width: Math.round(b.width) }; };
  const pinnedAncestor = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'sticky' || pos === 'fixed') return { tag: p.tagName.toLowerCase(), position: pos }; } return null; };
  const rails = [...document.querySelectorAll('[data-rail-position]')].map((el) => ({ mode: el.getAttribute('data-rail-position'), rect: r(el), position: getComputedStyle(el).position, top: getComputedStyle(el).top, visible: el.getBoundingClientRect().height > 0 }));
  // Fixed or sticky elements in view that are not the page's own header: the floating controls and the phone bar.
  const floating = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0 || b.bottom <= 0 || b.top >= vh || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    if (el.parentElement && getComputedStyle(el.parentElement).position === 'fixed') continue;
    floating.push({ label: (el.getAttribute('aria-label') || el.getAttribute('data-phone-bar') !== null && 'phone-bar' || el.className.toString().slice(0, 60)), rect: r(el) });
  }
  const pinnedTop = header && getComputedStyle(header).position === 'sticky' ? r(header).bottom : 0;
  return {
    viewport: { width: vw, height: vh, scrollY: Math.round(window.scrollY), zoom: parseFloat(getComputedStyle(document.body).zoom) || 1 },
    overflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw, horizontal: document.documentElement.scrollWidth > vw },
    header: header ? { rect: r(header), position: getComputedStyle(header).position, containsBrief: !!(brief && header.contains(brief)) } : null,
    brief: brief ? { rect: r(brief), pinnedBy: pinnedAncestor(brief), collapsed: brief.getAttribute('data-brief-collapsed') } : null,
    pinnedTop,
    railTopVar: page ? getComputedStyle(page).getPropertyValue('--review-rail-top').trim() : null,
    rails,
    floating,
  };
})()`;

const TAPS = `(() => {
  const sel = ['[data-document-review-page] header a', '[data-document-review-page] header button', '[data-brief-toggle]', '[data-phone-bar] button', '[data-review-drawer] [data-decision-button]', '[data-review-drawer] button[aria-label="Close"]'];
  const out = [];
  for (const el of document.querySelectorAll(sel.join(','))) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
    out.push({ text: (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 32), height: Math.round(b.height * zoom), width: Math.round(b.width * zoom) });
  }
  return out;
})()`;

// Scrolls each decision button into the middle of its scroller, then asks the browser what is on top of it.
const DECISION_COVER = (scope) => `(async () => {
  const out = [];
  for (const el of document.querySelectorAll('${scope} [data-decision-button]')) {
    el.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 300));
    const b = el.getBoundingClientRect();
    const pts = [[b.left + b.width / 2, b.top + b.height / 2], [b.left + 3, b.top + 3], [b.right - 3, b.top + 3], [b.left + 3, b.bottom - 3], [b.right - 3, b.bottom - 3]];
    const covered = pts.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && !el.contains(hit) ? (hit.closest('[aria-label]')?.getAttribute('aria-label') || hit.tagName.toLowerCase() + '.' + String(hit.className).slice(0, 40)) : null; }).filter(Boolean);
    out.push({ button: el.getAttribute('data-decision-button'), rect: { top: Math.round(b.top), bottom: Math.round(b.bottom) }, covered });
  }
  return out;
})()`;

const report = { documentId, base: BASE, label, capturedAt: new Date().toISOString(), configs: [] };
for (const cfg of CONFIGS) {
    await send("Emulation.setDeviceMetricsOverride", { width: cfg.width, height: cfg.height, deviceScaleFactor: cfg.dpr, mobile: cfg.mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: cfg.mobile });
    // The display scale is a per-browser setting in localStorage (components/display-scale.tsx); set it on the origin first.
    await send("Page.navigate", { url: `${BASE}/documents` });
    await sleep(1500);
    await evalJs(`localStorage.setItem('nexus.displayScale', '${cfg.scale}'); true`);
    await send("Page.navigate", { url: `${BASE}/documents/${documentId}` });
    await sleep(SETTLE_MS);
    const entry = { ...cfg, shots: [] };
    entry.top = await evalJs(MEASURE);
    entry.shots.push(await shot(`${label}-${cfg.name}-top.png`));
    // Scroll past the brief: far enough that a brief in the page flow has left the screen.
    await evalJs(`window.scrollTo(0, 700); true`);
    await sleep(800);
    entry.scrolled = await evalJs(MEASURE);
    entry.shots.push(await shot(`${label}-${cfg.name}-scrolled.png`));
    const s = entry.scrolled;
    entry.findings = {
        briefPinned: !!(s.brief && s.brief.pinnedBy),
        briefScrolledAway: s.brief ? s.brief.rect.bottom <= Math.max(s.pinnedTop, 0) : null,
        pinnedHeight: s.pinnedTop,
        pinnedShare: Math.round((s.pinnedTop / s.viewport.height) * 100) / 100,
        railOverlap: s.rails.filter((x) => x.visible && x.position === "sticky").map((x) => x.rect.top - s.pinnedTop),
        horizontalOverflow: entry.top.overflow.horizontal || s.overflow.horizontal,
    };
    if (cfg.mobile) {
        entry.taps = await evalJs(TAPS);
        await evalJs(`window.scrollTo(0, 0); document.querySelector('[data-open-review]')?.click(); true`);
        await sleep(1200);
        entry.drawerCover = await evalJs(DECISION_COVER("[data-review-drawer]"));
        entry.drawerTaps = await evalJs(TAPS);
        entry.shots.push(await shot(`${label}-${cfg.name}-drawer.png`));
        // The drawer scrolled to its end: its last control (Finish review) must clear every floating control.
        entry.drawerEnd = await evalJs(`(async () => {
          const d = document.querySelector('[data-review-drawer]');
          if (!d) return null;
          d.scrollTop = d.scrollHeight;
          await new Promise((r) => setTimeout(r, 300));
          const last = [...d.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height > 0).pop();
          const b = last.getBoundingClientRect();
          const pts = [[b.left + b.width / 2, b.top + b.height / 2], [b.left + 3, b.top + 3], [b.right - 3, b.top + 3], [b.left + 3, b.bottom - 3], [b.right - 3, b.bottom - 3]];
          const covered = pts.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && !last.contains(hit) ? hit.tagName.toLowerCase() : null; }).filter(Boolean);
          return { button: (last.textContent || '').trim().slice(0, 30), covered };
        })()`);
        entry.shots.push(await shot(`${label}-${cfg.name}-drawer-end.png`));
        entry.findings.drawerEndCovered = entry.drawerEnd && entry.drawerEnd.covered.length ? entry.drawerEnd : null;
        entry.findings.smallTaps = [...entry.taps, ...entry.drawerTaps].filter((t) => t.height < 44);
        entry.findings.decisionCovered = entry.drawerCover.filter((d) => d.covered.length);
        await evalJs(`document.querySelector('[data-review-drawer]')?.parentElement?.querySelector('button[aria-label="Close review"]')?.click(); true`);
    } else {
        entry.railCover = await evalJs(DECISION_COVER("[data-rail-position]"));
        entry.findings.decisionCovered = entry.railCover.filter((d) => d.covered.length);
    }
    report.configs.push(entry);
    console.log(`${cfg.name.padEnd(12)} ${JSON.stringify(entry.findings)}`);
}
writeFileSync(join(OUT, `${label}-report.json`), JSON.stringify(report, null, 2) + "\n");
ws.close();
chrome.kill();
console.log(`report: ${join(OUT, `${label}-report.json`)}`);
