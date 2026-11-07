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
 *  - on phone and tablet, the width and height of every visible control on the review surface (header, brief,
 *    viewer toolbars and tabs, lightbox, navigator and review drawers, decision and finish confirmations, history,
 *    composer), flagged when either is under 44px; targets whose boxes overlap; elements past either viewport edge in
 *    every one of those states; and whether a floating control covers Approve / Request changes once they are
 *    scrolled into view (elementFromPoint at the centre and the four inset corners). Links in running text and the
 *    line-number gutter of text and code files are listed apart as exempt (WCAG 2.5.8's inline exception).
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

// In-page helper (needs `vw`): does an ancestor that sits inside the viewport scroll or clip this element sideways, so
// what reaches past the screen edge stays reachable (a code block, the filmstrip)? An ancestor whose overflow-x is
// only "auto" because its overflow-y is (CSS turns visible into auto when the other axis scrolls: the drawers and
// sheets) does not count, unless it asks for horizontal overflow itself (an overflow-x-*, overflow-auto or
// overflow-hidden class, or a <pre>, which globals.css scrolls).
const HELD = `const held = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible') continue;
      const coerced = cs.overflowX === 'auto' && cs.overflowY !== 'visible' && p.tagName !== 'PRE' && !/(^|\\s)(overflow-x-|overflow-auto|overflow-hidden|overflow-clip)/.test(String(p.className));
      const pb = p.getBoundingClientRect();
      if (!coerced && pb.left >= -1 && pb.right <= vw + 1) return true;
    }
    return false;
  };`;

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
  // Below 768px html and body clip horizontal overflow, so scrollWidth can hide it: also list elements that reach past
  // either viewport edge without a horizontally scrolling or clipping ancestor to hold them.
  const pastEdge = [];
  ${HELD}
  for (const el of document.querySelectorAll('[data-document-review-page] *, [data-lightbox] *')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0 || (b.right <= vw + 1 && b.left >= -1)) continue;
    if (el.closest('[aria-hidden=true]') || getComputedStyle(el).visibility === 'hidden' || held(el)) continue;
    pastEdge.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 60), left: Math.round(b.left), right: Math.round(b.right) });
    if (pastEdge.length >= 10) break;
  }
  const pinnedTop = header && getComputedStyle(header).position === 'sticky' ? r(header).bottom : 0;
  return {
    viewport: { width: vw, height: vh, scrollY: Math.round(window.scrollY), zoom: parseFloat(getComputedStyle(document.body).zoom) || 1 },
    overflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw, horizontal: document.documentElement.scrollWidth > vw || pastEdge.length > 0, pastEdge },
    header: header ? { rect: r(header), position: getComputedStyle(header).position, containsBrief: !!(brief && header.contains(brief)) } : null,
    brief: brief ? { rect: r(brief), pinnedBy: pinnedAncestor(brief), collapsed: brief.getAttribute('data-brief-collapsed') } : null,
    pinnedTop,
    railTopVar: page ? getComputedStyle(page).getPropertyValue('--review-rail-top').trim() : null,
    rails,
    floating,
  };
})()`;

// Every visible control on the review surface, both dimensions (QA round 1: the old probe looked only at the header,
// the phone bar and the decision buttons, and only at height). Scope: the review page (header, brief, stage, viewer
// toolbars, phone bar, navigator and review drawers, composer sheet, evidence drawer) and the portaled lightbox.
// A checkbox or radio inside a label is measured by its label, the real target. Links inside running text are
// reported apart as inlineExempt (WCAG 2.5.8's inline exception); controls inside iframes are document content.
const TAPS = (state, scope = "[data-document-review-page], [data-lightbox]") => `(() => {
  const SEL = 'button, a[href], select, input:not([type=hidden]), textarea, summary, [role=button], [role=tab], [role=link], [role=checkbox], [role=radio]';
  const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const taps = [], inlineExempt = [], seen = new Set(), rects = [];
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.tagName.toLowerCase()).trim().replace(/\\s+/g, ' ').slice(0, 40);
  const dataKeys = (el) => [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')).slice(0, 2).join(' ');
  for (const root of document.querySelectorAll(${JSON.stringify(scope)})) for (const found of root.querySelectorAll(SEL)) {
    let el = found;
    if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label')) el = el.closest('label');
    if (seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    // Content of a closed <details> keeps a layout box in Chrome (content-visibility: hidden) but is not shown.
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) continue;
    // Image pins and video markers keep their visual box and take taps through a 44px hit square ([data-tap-area]).
    const area = el.querySelector(':scope > [data-tap-area]');
    const ab = area && getComputedStyle(area).display !== 'none' ? area.getBoundingClientRect() : null;
    const eb = el.getBoundingClientRect();
    const b = ab ? { width: Math.max(eb.width, ab.width), height: Math.max(eb.height, ab.height) } : eb;
    if (b.width <= 2 || b.height <= 2) continue; // screen-reader-only or not rendered
    const row = { state: ${JSON.stringify(state)}, tag: el.tagName.toLowerCase(), text: name(el), data: dataKeys(el), width: Math.round(b.width * zoom), height: Math.round(b.height * zoom) };
    const host = el.parentElement && el.parentElement.closest('p, li, td, blockquote, dd');
    const inProse = cs.display === 'inline' && host && (host.textContent || '').trim().length > (el.textContent || '').trim().length + 12;
    // A code or text line-number gutter is sized by the line it numbers (WCAG 2.5.8's line-height exception).
    if (el.matches('[data-line-gutter]')) row.reason = 'line-gutter';
    else if (inProse) row.reason = 'inline-link';
    (row.reason ? inlineExempt : taps).push(row);
    if (!row.reason) rects.push({ el, row, r: ab && (ab.width > eb.width || ab.height > eb.height) ? ab : eb });
  }
  // Two targets whose boxes overlap share the overlap, so neither gets its full 44px there. Full-screen backdrops
  // (the dim layer behind a drawer, which closes it) are left out; so are a control and one nested inside it, and a
  // page control passing under a fixed bar (it scrolls clear; the decision-cover checks cover Approve and Finish).
  const overlaps = [], vh = document.documentElement.clientHeight;
  const big = (r) => r.width * r.height > 0.5 * document.documentElement.clientWidth * vh;
  const fixedHost = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return p; return null; };
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], c = rects[j];
    if (big(a.r) || big(c.r) || a.el.contains(c.el) || c.el.contains(a.el) || fixedHost(a.el) !== fixedHost(c.el)) continue;
    const w = Math.min(a.r.right, c.r.right) - Math.max(a.r.left, c.r.left), h = Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top);
    if (w > 1 && h > 1 && overlaps.length < 10) overlaps.push({ state: ${JSON.stringify(state)}, a: a.row.text, b: c.row.text, overlap: Math.round(w * zoom) + 'x' + Math.round(h * zoom), rects: [a.r, c.r].map((x) => [x.top, x.bottom, x.left, x.right].map(Math.round)) });
  }
  // The same past-the-edge test as MEASURE, for the state's own scope (drawers, panels and tabs that open later).
  const vw = document.documentElement.clientWidth, pastEdge = [];
  ${HELD}
  for (const root of document.querySelectorAll(${JSON.stringify(scope)})) for (const el of root.querySelectorAll('*')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0 || (b.right <= vw + 1 && b.left >= -1) || el.closest('[aria-hidden=true]') || held(el)) continue;
    pastEdge.push({ state: ${JSON.stringify(state)}, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 60), left: Math.round(b.left), right: Math.round(b.right) });
    if (pastEdge.length >= 5) break;
  }
  return { taps, inlineExempt, overlaps, pastEdge, scrollWidth: document.documentElement.scrollWidth, clientWidth: vw };
})()`;

// Clicks the first match (optionally the one whose text includes a phrase) and reports whether it found one.
const click = (selector, text) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getBoundingClientRect().height > 0);
  const el = ${text ? `els.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}))` : "els[0]"};
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
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
        // Walk the expanded states a reviewer reaches, measuring the controls each one adds. Nothing is submitted:
        // decisions and Finish review only open their confirmation panels, which are then cancelled.
        const states = [];
        const measure = async (state, scope) => { const r = await evalJs(TAPS(state, scope)); states.push(state); return r; };
        const runs = [];
        runs.push(await measure("page"));
        if (await evalJs(click("[data-brief-toggle]"))) { await sleep(500); runs.push(await measure("brief-expanded", "[data-human-brief]")); await evalJs(click("[data-brief-toggle]")); }
        // Every design-package tab (the viewer's other panels have their own controls).
        const tabs = await evalJs(`[...document.querySelectorAll('[data-design-tab]')].map((e) => e.getAttribute('data-design-tab'))`) || [];
        for (const t of tabs) { await evalJs(click(`[data-design-tab="${t}"]`)); await sleep(700); runs.push(await measure(`design-tab-${t}`, "[data-document-review-page] article")); }
        if (tabs.length) await evalJs(click(`[data-design-tab="${tabs[0]}"]`));
        if (await evalJs(click("[data-open-fullscreen]"))) { await sleep(800); runs.push(await measure("lightbox", "[data-lightbox]")); entry.shots.push(await shot(`${label}-${cfg.name}-lightbox.png`)); await evalJs(click("[data-lightbox-close]")); await sleep(400); }
        if (await evalJs(click("[data-open-navigator]"))) { await sleep(800); runs.push(await measure("navigator", "[role=dialog]")); entry.shots.push(await shot(`${label}-${cfg.name}-navigator.png`)); await evalJs(click("[role=dialog] button[aria-label=Close]")); await sleep(400); }
        entry.taps = runs.flatMap((r) => r.taps);
        entry.inlineExempt = runs.flatMap((r) => r.inlineExempt);
        await evalJs(`window.scrollTo(0, 0); document.querySelector('[data-open-review]')?.click(); true`);
        await sleep(1200);
        entry.drawerCover = await evalJs(DECISION_COVER("[data-review-drawer]"));
        const drawerRuns = [await measure("review-drawer", "[data-review-drawer]")];
        entry.shots.push(await shot(`${label}-${cfg.name}-drawer.png`));
        if (await evalJs(click("[data-review-drawer] [data-history-toggle]"))) { await sleep(1500); drawerRuns.push(await measure("history-open", "[data-review-drawer]")); }
        for (const kind of ["approve", "request_changes"]) {
            if (!(await evalJs(click(`[data-review-drawer] [data-decision-button="${kind}"]`)))) continue;
            await sleep(600);
            drawerRuns.push(await measure(`confirm-${kind}`, `[data-review-drawer] [data-decision-confirm]`));
            entry.shots.push(await shot(`${label}-${cfg.name}-confirm-${kind}.png`));
            await evalJs(click("[data-review-drawer] [data-decision-confirm] button", "Cancel"));
            await sleep(400);
        }
        if (await evalJs(click("[data-review-drawer] [data-finish-button]"))) {
            await sleep(600);
            drawerRuns.push(await measure("finish-panel", "[data-review-drawer] [data-finish-panel]"));
            entry.shots.push(await shot(`${label}-${cfg.name}-finish-panel.png`));
            await evalJs(click("[data-review-drawer] [data-finish-panel] button", "Keep reviewing"));
            await sleep(400);
        }
        if (await evalJs(click("[data-review-drawer] button", "Add a note"))) {
            await sleep(800);
            drawerRuns.push(await measure("composer", "[data-composer-sheet], [data-review-drawer] [data-composer]"));
            entry.shots.push(await shot(`${label}-${cfg.name}-composer.png`));
            await evalJs(click("[data-composer] button", "Cancel"));
            await sleep(400);
        }
        entry.statesMeasured = states;
        entry.drawerTaps = drawerRuns.flatMap((r) => r.taps);
        entry.inlineExempt.push(...drawerRuns.flatMap((r) => r.inlineExempt));
        if (!(await evalJs(`!!document.querySelector('[data-review-drawer]')`))) { await evalJs(`document.querySelector('[data-open-review]')?.click(); true`); await sleep(1000); }
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
        // Both dimensions; one row per distinct control (the same control seen in two states is listed once).
        const small = new Map();
        for (const t of [...entry.taps, ...entry.drawerTaps]) if (t.width < 44 || t.height < 44) { const k = `${t.tag}|${t.text}|${t.data}`; if (!small.has(k)) small.set(k, t); }
        entry.findings.tapsMeasured = entry.taps.length + entry.drawerTaps.length;
        entry.findings.smallTaps = [...small.values()];
        // Horizontal overflow in any expanded state (the page, brief, tabs, lightbox, drawers, panels, composer).
        const stateRuns = [...runs, ...drawerRuns];
        entry.findings.overlappingTaps = stateRuns.flatMap((r) => r.overlaps);
        entry.findings.exemptTaps = entry.inlineExempt.length;
        entry.findings.stateOverflow = [...stateRuns.flatMap((r) => r.pastEdge), ...stateRuns.filter((r) => r.scrollWidth > r.clientWidth).map((r) => ({ scrollWidth: r.scrollWidth }))];
        entry.findings.horizontalOverflow = entry.findings.horizontalOverflow || entry.findings.stateOverflow.length > 0;
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
