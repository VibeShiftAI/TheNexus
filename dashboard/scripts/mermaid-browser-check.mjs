#!/usr/bin/env node
/**
 * Real-browser check of Mermaid rendering in the document reader
 * (/documents/<id>). The component tests stub Mermaid, so this is the check
 * to run after a `mermaid` upgrade or a change to mermaid-diagram.tsx: it
 * loads the route in headless Chrome at phone and desktop widths, waits for
 * every ```mermaid figure to settle, and records what the page actually did.
 *
 *   # Any registered document on the live dev server (:3000 -> :4000):
 *   CHECK_DOC=<document id> node scripts/mermaid-browser-check.mjs
 *
 *   # The broken/hostile fixture on an isolated stack (no live DB writes):
 *   node scripts/mermaid-check-api.cjs                      # throwaway API on :4100, prints the fixture's id
 *   NEXT_DIST_DIR=.next-ui NEXT_PUBLIC_API_URL=http://127.0.0.1:4100 npx next dev -p 3100
 *   CHECK_BASE=http://127.0.0.1:3100 CHECK_DOC=<id> CHECK_FIXTURE=1 node scripts/mermaid-browser-check.mjs
 *   (afterwards: stop both, `git checkout -- tsconfig.json`, `rm -rf .next-ui`)
 *
 * Env: CHECK_BASE (http://localhost:3000), CHECK_DOC (required), CHECK_WIDTHS
 * (390,1440), CHECK_OUT (./.mermaid-check), CHECK_CHROME (Chrome binary),
 * CHECK_FIXTURE=1 to also assert the fixture's expected outcome (ok, error,
 * ok; hostile labels neutralised), CHECK_NAV=<second document id> to also
 * navigate away and back and assert the diagrams are redrawn with fresh ids.
 * Writes <out>/<width>_<step>.png and <out>/report.json; exits 1 when any
 * assertion fails, so it can gate an upgrade.
 *
 * Always asserted, for every width and step:
 *   - every figure settles (none left "pending") and none holds a <script>,
 *     an on* handler, a javascript: link or a resource-loading tag;
 *   - the four canary globals the fixture tries to set stay unset;
 *   - SVG ids are unique and no element id is duplicated on the page;
 *   - the page does not scroll sideways (figures scroll internally instead);
 *   - each figure sits inside a review block that still has its comment control.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME_CANDIDATES = [
    process.env.CHECK_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
    console.error("No Chrome binary found; set CHECK_CHROME.");
    process.exit(2);
}
const DOC = process.env.CHECK_DOC;
if (!DOC) {
    console.error("CHECK_DOC=<document id> is required.");
    process.exit(2);
}
const BASE = (process.env.CHECK_BASE || "http://localhost:3000").replace(/\/$/, "");
const OUT = resolve(process.env.CHECK_OUT || ".mermaid-check");
const widths = (process.env.CHECK_WIDTHS || "390,1440").split(",").map(Number);
const FIXTURE = process.env.CHECK_FIXTURE === "1";
const NAV = process.env.CHECK_NAV || null;
const route = `/documents/${encodeURIComponent(DOC)}`;

mkdirSync(OUT, { recursive: true });
const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "nexus-mermaid-check-"));
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
const consoleLines = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
    }
    if (m.method === "Runtime.exceptionThrown") {
        consoleLines.push(`exception: ${m.params.exceptionDetails?.exception?.description?.slice(0, 300) || m.params.exceptionDetails?.text}`);
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

const FACTS_JS = `(() => {
  const figs = [...document.querySelectorAll('[data-mermaid-diagram]')];
  const iw = document.documentElement.clientWidth;
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
  const seen = new Set(), dup = new Set();
  for (const id of ids) { if (seen.has(id)) dup.add(id); seen.add(id); }
  return JSON.stringify({
    url: location.pathname,
    figures: figs.map(f => {
      const svg = f.querySelector('svg');
      const block = f.closest('[data-review-block]');
      const r = svg ? svg.getBoundingClientRect() : null;
      const label = svg ? svg.querySelector('.nodeLabel, text') : null;
      return {
        status: f.dataset.mermaidDiagram,
        blockId: block ? block.id : null,
        hasCommentButton: !!block?.querySelector('[data-block-comment-button]'),
        notice: f.querySelector('[data-mermaid-notice]')?.textContent || null,
        svgId: svg ? svg.id : null,
        svgWidth: r ? Math.round(r.width) : null,
        svgHeight: r ? Math.round(r.height) : null,
        figureScrolls: f.scrollWidth > f.clientWidth + 1,
        fontPx: label ? getComputedStyle(label).fontSize : null,
        labels: svg ? [...svg.querySelectorAll('.nodeLabel, text')].map(t => t.textContent.trim()).filter(Boolean).slice(0, 6) : [],
        scripts: svg ? svg.querySelectorAll('script').length : 0,
        onHandlers: svg ? [...svg.querySelectorAll('*')].filter(el => [...el.attributes].some(a => /^on/i.test(a.name))).length : 0,
        jsAnchors: svg ? [...svg.querySelectorAll('a')].filter(a => /javascript:/i.test(a.getAttribute('href') || a.getAttribute('xlink:href') || '')).length : 0,
        loaders: svg ? svg.querySelectorAll('img, iframe, object, embed, video, audio, link').length : 0,
      };
    }),
    duplicateIds: [...dup].slice(0, 10),
    scriptsInArticle: document.querySelectorAll('article script').length,
    canaries: { p1: window.__mermaidPwned || false, p2: window.__mermaidPwned2 || false, p3: window.__mermaidPwned3 || false, raw: window.__rawHtmlPwned || false },
    ordinaryFences: [...document.querySelectorAll('[data-document-markdown] pre code[class*="language-"]')].map(c => c.className),
    captions: [...document.querySelectorAll('[data-document-markdown] p em')].map(e => e.textContent.slice(0, 60)),
    rawHtmlShownAsText: (document.querySelector('[data-document-markdown]')?.textContent || '').includes('<script>window.__rawHtmlPwned'),
    pageScrollWidth: document.documentElement.scrollWidth,
    clientWidth: iw,
  });
})()`;
const SETTLED_JS = `(() => { const f = [...document.querySelectorAll('[data-mermaid-diagram]')]; return f.length > 0 && f.every(x => x.dataset.mermaidDiagram !== 'pending'); })()`;

const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

async function observe(width, step) {
    let settled = false;
    for (let i = 0; i < 60 && !settled; i++) {
        await sleep(500);
        settled = await evalJs(SETTLED_JS);
    }
    await sleep(800);
    const facts = JSON.parse((await evalJs(FACTS_JS)) || "{}");
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const name = `${width}_${step}.png`;
    if (shot.result?.data) writeFileSync(join(OUT, name), Buffer.from(shot.result.data, "base64"));
    const where = `${width}px ${step}`;
    if (!settled) fail(where, "diagrams never settled (no figures, or one is still pending)");
    for (const f of facts.figures || []) {
        if (f.scripts || f.onHandlers || f.jsAnchors || f.loaders) fail(where, `figure ${f.blockId} carries active or resource-loading markup (${JSON.stringify({ scripts: f.scripts, on: f.onHandlers, js: f.jsAnchors, loaders: f.loaders })})`);
        if (!f.blockId || !f.hasCommentButton) fail(where, `figure ${f.blockId || "?"} is not inside a review block with a comment control`);
    }
    if (facts.scriptsInArticle) fail(where, `${facts.scriptsInArticle} script element(s) inside the article`);
    if (Object.values(facts.canaries || {}).some(Boolean)) fail(where, `a canary global fired: ${JSON.stringify(facts.canaries)}`);
    if (facts.duplicateIds?.length) fail(where, `duplicate element ids: ${facts.duplicateIds.join(", ")}`);
    if (facts.pageScrollWidth > facts.clientWidth) fail(where, `page scrolls sideways (${facts.pageScrollWidth}/${facts.clientWidth})`);
    const statuses = (facts.figures || []).map((f) => f.status);
    console.log(`${where}: ${statuses.length} figure(s) [${statuses.join(",")}] ids unique=${facts.duplicateIds?.length === 0} page ${facts.pageScrollWidth}/${facts.clientWidth} shot ${name}`);
    return { width, step, settled, shot: name, ...facts };
}

function assertFixture(entry) {
    const where = `${entry.width}px ${entry.step}`;
    const statuses = entry.figures.map((f) => f.status);
    if (statuses.join(",") !== "ok,error,ok") fail(where, `fixture expected ok,error,ok but saw ${statuses.join(",")}`);
    const broken = entry.figures[1];
    if (!broken || !/did not render \(Parse error/.test(broken.notice || "")) fail(where, `broken fence lacks the parse-error notice (${broken?.notice})`);
    const hostile = entry.figures[2];
    if (hostile && !hostile.labels.some((l) => l.includes("Label with script"))) fail(where, "hostile diagram lost its label text");
    if (hostile && hostile.labels.some((l) => /<script|onerror/i.test(l))) fail(where, "hostile markup survived into a label");
    if (!entry.ordinaryFences.includes("language-js")) fail(where, "ordinary js fence is no longer a code block");
    if (!entry.rawHtmlShownAsText) fail(where, "raw HTML is not shown as text");
    if (entry.captions.length !== 3) fail(where, `expected 3 captions, saw ${entry.captions.length}`);
}

const report = [];
for (const width of widths) {
    const phone = width < 800;
    await send("Emulation.setDeviceMetricsOverride", { width, height: phone ? 844 : 900, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
    await send("Emulation.setTouchEmulationEnabled", { enabled: phone });
    await send("Page.navigate", { url: BASE + route });
    const first = await observe(width, "load");
    if (FIXTURE) assertFixture(first);
    report.push(first);
    if (NAV) {
        // Client-side navigation: the reader's "Documents" link, then the second document, then back.
        const clicked = await evalJs(`(async () => {
            document.querySelector('[data-all-documents-link]')?.click();
            await new Promise(r => setTimeout(r, 3000));
            const a = document.querySelector('a[href="/documents/${NAV}"]');
            if (!a) return 'no link';
            a.click();
            return 'clicked';
        })()`);
        if (clicked !== "clicked") fail(`${width}px nav`, `could not navigate to ${NAV} (${clicked})`);
        const away = await observe(width, "nav-away");
        report.push(away);
        await evalJs(`(async () => { history.go(-2); await new Promise(r => setTimeout(r, 2000)); return location.pathname; })()`);
        const back = await observe(width, "nav-back");
        report.push(back);
        const firstIds = first.figures.map((f) => f.svgId).filter(Boolean);
        const backIds = back.figures.map((f) => f.svgId).filter(Boolean);
        if (back.url !== route) fail(`${width}px nav-back`, `expected ${route}, landed on ${back.url}`);
        if (backIds.length !== firstIds.length) fail(`${width}px nav-back`, `expected ${firstIds.length} diagrams after returning, saw ${backIds.length}`);
        if (backIds.some((id) => firstIds.includes(id))) fail(`${width}px nav-back`, "a diagram reused an SVG id from the first visit");
        if (FIXTURE) assertFixture(back);
    }
}
report.push({ exceptions: consoleLines.slice(0, 40) });
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
ws.close();
chrome.kill();

if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const line of failures) console.error(`  - ${line}`);
    console.error(`Report: ${join(OUT, "report.json")}`);
    process.exit(1);
}
console.log(`\nAll checks passed. Report: ${join(OUT, "report.json")}`);
