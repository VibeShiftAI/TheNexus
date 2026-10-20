// Chrome (CDP) check that the document review's Finish review and Send to Praxis stay visible and reachable by
// pointer, keyboard and touch while the audio mini player, the voice dock and the feedback launcher are on screen,
// and that those floating controls stay reachable themselves (task 7fe1005f). Runs on the ISOLATED stack only:
// api.cjs (:4100, temp DB), receiver.cjs (:4199), `next dev` on :3100 and headless Chrome, all stopped at the end.
//
//   node scripts/document-review-qa/verify-floating-controls.mjs
//
// The feedback launcher is the travel shell's vibeshiftai widget, injected only on https pages. The check mounts a
// stand-in with the widget's own host id, class and launcher CSS (feedback-widget/src/ui.ts) instead of loading the
// widget, so nothing can be sent to the feedback service. Audio is a generated silent WAV played through the
// CortexProvider's own playChatAudio. Send to Praxis is hit-tested and never clicked; the run ends by asserting the
// isolated API holds no finished review and the Praxis stand-in received nothing. Screenshots land in <QA_DIR>/shots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const QA_DIR = process.env.NEXUS_REVIEW_QA_DIR || mkdtempSync(join(tmpdir(), "nexus-floating-controls-qa-"));
// NEXUS_QA_DASHBOARD_DIR points the dashboard at another checkout (a `git archive` of the baseline with its own
// node_modules copy) to record the before state with the same checks.
const DASHBOARD = process.env.NEXUS_QA_DASHBOARD_DIR || join(ROOT, "dashboard");
const TSCONFIG = join(DASHBOARD, "tsconfig.json");
const tsconfigBefore = readFileSync(TSCONFIG);
const BASE = "http://127.0.0.1:3100";
const API = "http://127.0.0.1:4100";
const OUT = join(QA_DIR, "shots");
mkdirSync(OUT, { recursive: true });
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => existsSync(p));
if (!CHROME) throw new Error("Chrome or Chromium is required in /Applications");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, value) => console.log(tag, typeof value === "string" ? value : JSON.stringify(value));

// Desktop at the screenshot's proportions (2418x778 device pixels at 2x), standard, short and display-scaled windows,
// and phones upright, scaled and on their side.
const CASES = [
  { name: "desktop-screenshot-1209x389@2x", width: 1209, height: 389, dpr: 2, scale: 1 },
  { name: "desktop-1440x900", width: 1440, height: 900, dpr: 1, scale: 1 },
  { name: "desktop-short-1280x560", width: 1280, height: 560, dpr: 1, scale: 1 },
  { name: "desktop-1512x900-scale125", width: 1512, height: 900, dpr: 2, scale: 1.25 },
  { name: "desktop-short-1600x720-scale150", width: 1600, height: 720, dpr: 1, scale: 1.5 },
  // The screenshot's height at 125% and 150% leaves less room than the rail's minimum (QA round 1, 2026-10-20).
  { name: "desktop-screenshot-height-1209x389-scale125", width: 1209, height: 389, dpr: 2, scale: 1.25 },
  { name: "desktop-screenshot-height-1600x389-scale150", width: 1600, height: 389, dpr: 1, scale: 1.5 },
  { name: "desktop-1440x900-no-launcher-dock-collapsed", width: 1440, height: 900, dpr: 1, scale: 1, launcher: false, collapsed: true },
  { name: "phone-390x844", width: 390, height: 844, dpr: 3, scale: 1, mobile: true },
  { name: "phone-390x844-scale125", width: 390, height: 844, dpr: 3, scale: 1.25, mobile: true },
  { name: "phone-landscape-844x390", width: 844, height: 390, dpr: 3, scale: 1, mobile: true },
];

// ── The stack ──
const children = [];
function child(name, cmd, args, opts) {
  const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  proc.stderr.on("data", (d) => process.stdout.write(`[${name}!] ${d}`));
  children.push(proc);
  return proc;
}
async function waitHttp(url, ms, okWhen = (r) => r.ok) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (okWhen(r)) return r; last = `${r.status}`; } catch (err) { last = err.message; }
    await sleep(750);
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}
const stop = () => { for (const proc of children.splice(0)) { try { proc.kill("SIGTERM"); } catch { /* already gone */ } } };
/** Put dashboard/tsconfig.json back when `next dev` only added its dist-dir entries; anything else that changed it stays. */
function restoreTsconfig() {
  let current;
  try { current = readFileSync(TSCONFIG, "utf8"); } catch { return; }
  const before = tsconfigBefore.toString("utf8");
  if (current === before) return;
  const trailing = (s) => s.replace(/,(\s*[\]}])/g, "$1");
  const stripped = current.split("\n").filter((line) => !line.includes(".next-document-review-qa/")).join("\n");
  if (trailing(stripped) === trailing(before)) {
    writeFileSync(TSCONFIG, tsconfigBefore);
    log("TSCONFIG_RESTORED", "dashboard/tsconfig.json is back to its bytes from before the run");
  } else {
    log("TSCONFIG_LEFT_AS_IS", "dashboard/tsconfig.json changed beyond the dist-dir entries during the run; not touched");
  }
}
log("QA_DIR", QA_DIR);
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

// ── In-page helpers (installed after every navigation) ──
const PAGE_HELPERS = String.raw`
window.__qa = {
  describe(el) {
    if (!el) return "nothing";
    if (el.id === "praxis-feedback-host") return "feedback launcher";
    const label = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"));
    const region = el.closest && el.closest('[aria-label="Global voice controls"]') ? "voice dock" : el.closest && el.closest("[data-floating-audio]") ? "audio player" : "";
    return [el.tagName.toLowerCase(), label, region, (el.textContent || "").trim().slice(0, 30)].filter(Boolean).join(" | ");
  },
  /** Every sample point of el must hit el itself: the centre, four inner points and (for square controls) four corners,
   *  set in from each corner far enough to sit inside its rounding at the current display scale. */
  hit(el, corners = true) {
    const r = el.getBoundingClientRect();
    const fr = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    const pts = fr.map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]);
    const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const k = 3 + (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) * zoom * 0.3;
    if (corners) pts.push([r.left + k, r.top + k], [r.right - k, r.top + k], [r.left + k, r.bottom - k], [r.right - k, r.bottom - k]);
    const misses = [];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) { misses.push({ x: Math.round(x), y: Math.round(y), by: "outside the window" }); continue; }
      let h = document.elementFromPoint(x, y);
      const root = el.getRootNode();
      if (h && root !== document && h.shadowRoot === root) h = root.elementFromPoint(x, y);
      if (!(h === el || el.contains(h))) misses.push({ x: Math.round(x), y: Math.round(y), by: this.describe(h) });
    }
    return { rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }, ok: misses.length === 0, misses };
  },
  visible(selector, scope = document) { return [...scope.querySelectorAll(selector)].find((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden") || null; },
  button(scope, text) { return [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === text && b.getClientRects().length > 0) || null; },
  /** The travel shell's feedback widget, reduced to its launcher: same host id, class, CSS and label (feedback-widget/src/ui.ts). */
  mountLauncher() {
    if (document.getElementById("praxis-feedback-host")) return true;
    const host = document.createElement("div"); host.id = "praxis-feedback-host";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ".launcher { position: fixed; bottom: 14px; right: 14px; z-index: 2147483000; width: 48px; height: 48px; border-radius: 50%; background: #22d3ee; color: #fff; border: 0; box-shadow: 0 4px 14px rgba(0,0,0,.35); }";
    const button = document.createElement("button"); button.className = "launcher"; button.type = "button";
    button.setAttribute("aria-label", "Send feedback to Praxis"); button.title = "Send feedback to Praxis";
    button.addEventListener("click", () => { window.__launcherClicks = (window.__launcherClicks || 0) + 1; });
    shadow.append(style, button); document.body.appendChild(host);
    return true;
  },
  launcher() { return document.getElementById("praxis-feedback-host")?.shadowRoot?.querySelector(".launcher") || null; },
  /** CortexProvider's playChatAudio, reached through React's fiber tree: the same call a chat audio button makes. */
  playAudio() {
    const el = document.querySelector("main");
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let fiber = el[key], play = null;
    while (fiber && !play) { const v = fiber.memoizedProps && fiber.memoizedProps.value; if (v && typeof v.playChatAudio === "function") play = v.playChatAudio; fiber = fiber.return; }
    if (!play) return false;
    const rate = 8000, seconds = 250, bytes = rate * seconds, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + bytes, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, "data"); v.setUint32(40, bytes, true);
    new Uint8Array(buf, 44).fill(128);
    play({ key: "qa-floating-controls", src: URL.createObjectURL(new Blob([buf], { type: "audio/wav" })), mimeType: "audio/wav", name: "Praxis morning status report", kind: "full_status_report" });
    return true;
  },
  audioPlayer() { return document.querySelector('[aria-label="Stop and dismiss"]')?.parentElement || null; },
  vars() { const s = document.documentElement.style; return Object.fromEntries(["--nexus-floating-bottom", "--nexus-floating-overlay-bottom", "--nexus-audio-bottom", "--nexus-audio-right", "--nexus-voice-bottom", "--nexus-voice-right", "--nexus-ticker-right"].map((n) => [n, s.getPropertyValue(n)])); },
  /** The floating controls must not cover one another. */
  overlaps() {
    const boxes = [["audio player", this.audioPlayer()], ["voice dock", document.querySelector('[aria-label="Global voice controls"]')], ["feedback launcher", this.launcher()]].filter(([, el]) => el).map(([name, el]) => [name, el.getBoundingClientRect()]);
    const found = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [a, ra] = boxes[i], [b, rb] = boxes[j];
      if (ra.left < rb.right - 0.5 && rb.left < ra.right - 0.5 && ra.top < rb.bottom - 0.5 && rb.top < ra.bottom - 0.5) found.push(a + " / " + b);
    }
    return found;
  },
};
true`;

let chrome = null;
let ws = null;
const failures = [];
const check = (label, ok, detail) => { log(ok ? "OK" : "FAIL", { check: label, ...(detail === undefined ? {} : { detail }) }); if (!ok) failures.push(label); };
try {
  child("api", process.execPath, [join(HERE, "api.cjs")], { cwd: ROOT, env: { ...process.env, NEXUS_REVIEW_QA_DIR: QA_DIR } });
  child("receiver", process.execPath, [join(HERE, "receiver.cjs")], { cwd: ROOT, env: process.env });
  child("next", "npm", ["run", "dev", "--", "--port", "3100"], { cwd: DASHBOARD, env: { ...process.env, NEXT_PUBLIC_API_URL: API, NEXT_DIST_DIR: ".next-document-review-qa", BROWSER: "none" } });
  const isolation = await (await waitHttp(`${API}/__qa`, 60_000)).json();
  assert.equal(isolation.qaDirectory, QA_DIR, "refuse to write through a non-fixture API");
  const docs = await (await waitHttp(`${API}/api/documents?task_id=44444444-4444-4444-8444-444444444444`, 60_000, (r) => r.ok)).json();
  const docId = docs.documents[0]?.id;
  assert.ok(docId, "isolated report was registered");
  log("DOC", docId);
  await waitHttp(`${BASE}/documents/${docId}`, 240_000, (r) => r.status === 200);
  const PAGE = `${BASE}/documents/${docId}`;

  // ── Chrome ──
  const port = 9334 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "nexus-verify-floating-"));
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  log("CHROME", version?.Browser);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let nextId = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable"); await send("Runtime.enable");
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`page error: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, "base64")); };
  const waitFor = async (expr, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return true; await sleep(250); } return false; };
  const settle = () => evalJs("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 250))))");
  /** Centre of an element in CSS pixels of the window, for real input events. */
  const centre = async (expr) => evalJs(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const mouseClick = async (expr) => {
    const p = await centre(expr); if (!p) return check(`click target present: ${expr}`, false);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    await settle();
  };
  const tap = async (expr) => { const p = await centre(expr); if (!p) return check(`tap target present: ${expr}`, false); await send("Input.synthesizeTapGesture", { x: p.x, y: p.y, duration: 50, tapCount: 1, gestureSourceType: "touch" }); await sleep(250); await settle(); };
  const pressEnter = async () => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r", unmodifiedText: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await settle();
  };
  const hit = async (expr, label, corners = true) => {
    const r = await evalJs(`(() => { const el = ${expr}; return el ? window.__qa.hit(el, ${corners}) : null; })()`);
    check(label, !!r?.ok, r ?? "element not found");
    return r;
  };

  // ── Audio keeps playing across client navigation ──
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: PAGE });
  assert.ok(await waitFor("!!document.querySelector('[data-document-markdown]') && !!document.querySelector('main')"), "review page rendered");
  await evalJs(PAGE_HELPERS);
  assert.ok(await evalJs("window.__qa.playAudio()"), "reached playChatAudio");
  assert.ok(await waitFor("!!window.__qa.audioPlayer()"), "mini player shown");
  await sleep(2500);
  const clock = () => evalJs("window.__qa.audioPlayer()?.textContent.match(/(\\d+:\\d\\d) \\/ (\\d+:\\d\\d)/)?.slice(1) ?? null");
  const before = await clock();
  await evalJs("window.next.router.push('/documents')");
  assert.ok(await waitFor("location.pathname === '/documents'"), "navigated to the documents list");
  await sleep(2000);
  const onList = await evalJs("({ player: !!document.querySelector('[aria-label=\"Stop and dismiss\"]'), name: document.querySelector('[aria-label=\"Stop and dismiss\"]')?.parentElement.textContent.includes('Praxis morning status report') })");
  await evalJs(`window.next.router.push(${JSON.stringify(new URL(PAGE).pathname)})`);
  assert.ok(await waitFor("!!document.querySelector('[data-document-markdown]')"), "back on the review");
  await sleep(1500);
  const after = await clock();
  const secs = (t) => (t ? t.split(":").reduce((m, s) => m * 60 + Number(s), 0) : -1);
  log("AUDIO_ACROSS_NAVIGATION", { before, on_documents_list: onList, after });
  check("audio player survives client navigation to /documents and back, still playing", onList.player && onList.name && secs(after?.[0]) > secs(before?.[0]) && secs(before?.[0]) >= 1, { before, after });

  // ── Each window ──
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const only = process.env.NEXUS_QA_ONLY ? new RegExp(process.env.NEXUS_QA_ONLY) : null;
  for (const c of CASES.filter((k) => !only || only.test(k.name))) {
    log("CASE", c);
    await send("Emulation.setDeviceMetricsOverride", { width: c.width, height: c.height, deviceScaleFactor: c.dpr, mobile: !!c.mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: !!c.mobile, maxTouchPoints: c.mobile ? 5 : 1 });
    await evalJs(`localStorage.setItem("nexus.displayScale", "${c.scale}"); localStorage.setItem("nexus.voice.dock.collapsed", "${c.collapsed ? 1 : 0}"); true`);
    await send("Page.navigate", { url: PAGE });
    assert.ok(await waitFor("!!document.querySelector('[data-document-markdown]') && !!document.querySelector('main')"), "review page rendered");
    await evalJs(PAGE_HELPERS);
    if (c.launcher !== false) await evalJs("window.__qa.mountLauncher()");
    assert.ok(await evalJs("window.__qa.playAudio()"), "reached playChatAudio");
    assert.ok(await waitFor("!!window.__qa.audioPlayer()"), "mini player shown");
    await sleep(600); await settle();
    const scale = await evalJs("getComputedStyle(document.body).zoom");
    log("STACK", { scale, vars: await evalJs("window.__qa.vars()"), overlaps: await evalJs("window.__qa.overlaps()") });
    log("LAYOUT", await evalJs(`(() => { const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
      return { innerHeight, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, header: r(document.querySelector('header')),
        rail: r(window.__qa.visible('[data-review-panel]')?.parentElement), audio: r(window.__qa.audioPlayer()), dock: r(document.querySelector('[aria-label="Global voice controls"]')),
        clientWidth: document.documentElement.clientWidth,
        pageScale: visualViewport.scale, scrollWidth: document.documentElement.scrollWidth,
        // Elements past the right edge that no scrolling or clipping ancestor contains: what widens the page.
        widest: [...document.querySelectorAll('body *')].map((el) => [el, el.getBoundingClientRect()]).filter(([el, b]) => {
            if (b.right <= document.documentElement.clientWidth + 1 || b.width === 0) return false;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (s.overflowX !== 'visible' || s.position === 'fixed') return false; }
            return getComputedStyle(el).position !== 'fixed';
          }).sort((a, b) => b[1].right - a[1].right).slice(0, 4).map(([el, b]) => el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 70) + ' right=' + Math.round(b.right)) }; })()`));
    check(`${c.name}: display scale applied`, Number(scale) === c.scale, scale);
    // Fixed controls are laid out against the layout viewport; if overflow widens it past the window they fall off screen.
    const viewport = (await send("Page.getLayoutMetrics")).result.cssLayoutViewport;
    check(`${c.name}: layout viewport is the window (${c.width}x${c.height})`, viewport.clientWidth === c.width && viewport.clientHeight === c.height, viewport);
    if (!c.mobile) {
      // A sticky review rail must end above every floating control, before and after the page scrolls. When the window
      // leaves less than the rail's 8rem minimum between the header and the controls, the rail scrolls with the page
      // instead, and its end must scroll clear of the controls and of the header.
      const railClear = () => evalJs(`(() => { const el = window.__qa.visible('[data-review-panel]').parentElement; const rail = el.getBoundingClientRect();
        const tops = [window.__qa.audioPlayer(), document.querySelector('[aria-label="Global voice controls"]'), window.__qa.launcher(), document.querySelector('[aria-label="Open full event log"]')?.closest('.fixed')]
          .filter(Boolean).map((el) => el.getBoundingClientRect()).filter((r) => r.right > rail.left && r.left < rail.right).map((r) => r.top);
        const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1; const header = document.querySelector('header').getBoundingClientRect().bottom;
        const reserve = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nexus-floating-bottom'));
        return { mode: el.dataset.railPosition, position: getComputedStyle(el).position, roomBelowHeader: Math.round(innerHeight / zoom - (header / zoom + 20) - reserve),
          scrollY: Math.round(scrollY), headerBottom: Math.round(header), railTop: Math.round(rail.top), railBottom: Math.round(rail.bottom), clusterTop: Math.round(Math.min(...tops)), clear: rail.bottom <= Math.min(...tops) }; })()`);
      const atTop = await railClear();
      log("RAIL", atTop);
      check(`${c.name}: review rail is sticky exactly when the window leaves it 8rem above the floating controls`,
        atTop.mode === (atTop.roomBelowHeader < 128 ? "flow" : "sticky") && atTop.position === (atTop.mode === "flow" ? "static" : "sticky"), atTop);
      if (atTop.mode === "sticky") {
        await evalJs("window.scrollTo(0, 700); true"); await settle();
        const scrolled = await railClear();
        await evalJs("window.scrollTo(0, 0); true"); await settle();
        check(`${c.name}: review rail ends above the floating controls, page at the top and scrolled`, atTop.clear && scrolled.clear && Math.abs(atTop.railTop - scrolled.railTop) <= 1, { atTop, scrolled });
      } else {
        await evalJs("window.scrollTo(0, 120); true"); await settle();
        const moved = await railClear();
        await evalJs("window.__qa.visible('[data-review-panel]').parentElement.scrollIntoView({ block: 'end' }); true"); await settle();
        const end = await railClear();
        await evalJs("window.scrollTo(0, 0); true"); await settle();
        check(`${c.name}: review rail scrolls with the page and its end scrolls clear of the floating controls`,
          Math.abs(atTop.railTop - moved.railTop - (moved.scrollY - atTop.scrollY)) <= 1 && end.clear && end.railBottom > end.headerBottom, { atTop, moved, end });
      }
    }
    check(`${c.name}: audio, voice dock and launcher do not overlap`, (await evalJs("window.__qa.overlaps()")).length === 0, await evalJs("window.__qa.overlaps()"));

    // The floating controls themselves, before any drawer covers the page.
    await hit("window.__qa.audioPlayer()?.querySelector('button')", `${c.name}: audio play/pause fully reachable`, false);
    await hit("window.__qa.audioPlayer()?.querySelector('[role=slider]')", `${c.name}: audio seek bar fully reachable`, false);
    await hit("document.querySelector('[aria-label=\"Stop and dismiss\"]')", `${c.name}: audio stop-and-dismiss fully reachable`);
    if (c.launcher !== false) await hit("window.__qa.launcher()", `${c.name}: feedback launcher fully reachable`, false);
    const pip = c.collapsed ? "Expand voice controls" : "Collapse voice controls";
    await hit(`document.querySelector('[aria-label="${pip}"]')`, `${c.name}: voice dock ${c.collapsed ? "expand" : "collapse"} pip fully reachable`);
    if (!c.collapsed) {
      const dockButtons = await evalJs("[...document.querySelectorAll('#global-voice-bar button')].filter((b) => b.getClientRects().length).map((b) => b.getAttribute('aria-label'))");
      for (const label of dockButtons) await hit(`document.querySelector('#global-voice-bar [aria-label="${label}"]')`, `${c.name}: voice dock "${label}" fully reachable`);
    }
    await hit("document.querySelector('[aria-label=\"Text and display size\"]')", `${c.name}: ticker display size control fully reachable`);
    if (!c.collapsed) {
      // The dock's setup popover opens up and left from wherever the dock now sits; it must stay inside the window.
      if (c.mobile) await tap("document.querySelector('[aria-label=\"Voice settings\"]')"); else await mouseClick("document.querySelector('[aria-label=\"Voice settings\"]')");
      const setup = await evalJs(`(() => { const d = document.querySelector('[role="dialog"][aria-label="Talk to Praxis setup"]'); if (!d) return null; const r = d.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
      check(`${c.name}: voice setup popover opens inside the window`, !!setup?.inside, setup);
      await hit("document.querySelector('[aria-label=\"Close voice setup\"]')", `${c.name}: voice setup close button fully reachable`);
      if (c.mobile) await tap("document.querySelector('[aria-label=\"Close voice setup\"]')"); else await mouseClick("document.querySelector('[aria-label=\"Close voice setup\"]')");
      check(`${c.name}: voice setup closes`, await waitFor("!document.querySelector('[aria-label=\"Talk to Praxis setup\"]')", 3000));
    }
    // Real pointer on the floating controls: pause and resume the audio, collapse and expand the dock.
    await waitFor("window.__qa.audioPlayer()?.querySelector('button')?.getAttribute('aria-label') === 'Pause'", 5000);
    if (c.mobile) await tap("window.__qa.audioPlayer()?.querySelector('button')"); else await mouseClick("window.__qa.audioPlayer()?.querySelector('button')");
    const paused = await evalJs("window.__qa.audioPlayer()?.querySelector('button')?.getAttribute('aria-label')");
    check(`${c.name}: audio play/pause responds to ${c.mobile ? "touch" : "pointer"}`, paused === "Play", paused);
    if (c.mobile) await tap(`document.querySelector('[aria-label="${pip}"]')`); else await mouseClick(`document.querySelector('[aria-label="${pip}"]')`);
    const toggled = c.collapsed ? "Collapse voice controls" : "Expand voice controls";
    check(`${c.name}: voice dock pip responds to ${c.mobile ? "touch" : "pointer"}`, await waitFor(`!!document.querySelector('[aria-label="${toggled}"]')`, 3000));
    await settle();
    check(`${c.name}: after the dock ${c.collapsed ? "expands" : "collapses"} the stack still does not overlap`, (await evalJs("window.__qa.overlaps()")).length === 0, await evalJs("window.__qa.overlaps()"));
    await hit(`document.querySelector('[aria-label="${toggled}"]')`, `${c.name}: voice dock pip reachable after toggling`);
    if (c.mobile) await tap(`document.querySelector('[aria-label="${toggled}"]')`); else await mouseClick(`document.querySelector('[aria-label="${toggled}"]')`);
    await settle();

    // The review actions.
    let scope = "document";
    if (c.mobile) {
      await tap("document.querySelector('[data-open-review]')");
      const drawer = await waitFor("!!document.querySelector('[data-review-drawer]')", 5000);
      check(`${c.name}: Review & decide opens the review drawer by touch`, drawer);
      if (!drawer) continue;
      scope = "document.querySelector('[data-review-drawer]')";
      await hit(`${scope}.querySelector('[aria-label="Close"]')`, `${c.name}: review drawer close button fully reachable`);
    }
    const finishExpr = `window.__qa.visible('[data-finish-button]', ${scope})`;
    if (c.mobile) {
      await evalJs(`${finishExpr}?.scrollIntoView({ block: "nearest" }); true`); await settle();
      await shot(`${c.name}-finish`);
      await hit(finishExpr, `${c.name}: Finish review fully visible and on top after scrolling to it`);
      await tap(finishExpr);
      const opened = await waitFor(`!!${scope}.querySelector('[data-finish-panel]')`, 3000);
      check(`${c.name}: Finish review opens on touch`, opened);
      if (!opened) continue;
    } else {
      // Keyboard: focus scrolls it into view, Enter opens the finish panel.
      await evalJs(`${finishExpr}?.focus(); true`); await settle();
      await shot(`${c.name}-finish`);
      await hit(finishExpr, `${c.name}: Finish review fully visible and on top once focused`);
      check(`${c.name}: Finish review holds keyboard focus`, await evalJs(`document.activeElement === ${finishExpr}`));
      await pressEnter();
      const opened = await waitFor(`!!${scope}.querySelector('[data-finish-panel]')`, 3000);
      check(`${c.name}: Finish review opens from the keyboard`, opened);
      if (!opened) continue;
    }
    const sendExpr = `window.__qa.button(${scope}, "Send to Praxis")`;
    const keepExpr = `window.__qa.button(${scope}, "Keep reviewing")`;
    await evalJs(`${sendExpr}?.${c.mobile ? 'scrollIntoView({ block: "nearest" })' : "focus()"}; true`); await settle();
    await shot(`${c.name}-send`);
    await hit(sendExpr, `${c.name}: Send to Praxis fully visible and on top (hit-tested, not clicked)`);
    await hit(keepExpr, `${c.name}: Keep reviewing fully visible and on top`);
    if (c.mobile) await tap(keepExpr); else await mouseClick(keepExpr);
    check(`${c.name}: Keep reviewing closes the panel by ${c.mobile ? "touch" : "pointer"}`, await waitFor(`!${scope}.querySelector('[data-finish-panel]') && !!${finishExpr}`, 3000));
    if (!c.mobile) {
      // Pointer: Finish review clicked where it sits.
      await evalJs(`${finishExpr}?.scrollIntoView({ block: "nearest" }); true`); await settle();
      await hit(finishExpr, `${c.name}: Finish review fully visible and on top for the pointer`);
      await mouseClick(finishExpr);
      check(`${c.name}: Finish review opens on pointer click`, await waitFor(`!!${scope}.querySelector('[data-finish-panel]')`, 3000));
      await evalJs(`${keepExpr}?.scrollIntoView({ block: "nearest" }); true`); await settle();
      await mouseClick(keepExpr);
    } else {
      await evalJs(`${scope}.querySelector('[aria-label="Close"]').scrollIntoView({ block: "nearest" }); true`); await settle();
      await tap(`${scope}.querySelector('[aria-label="Close"]')`);
      check(`${c.name}: review drawer closes by touch`, await waitFor("!document.querySelector('[data-review-drawer]')", 3000));
    }
  }

  // ── Nothing was finished, sent or approved ──
  const review = (await (await fetch(`${API}/api/documents/${docId}`)).json()).review;
  const receiver = await (await fetch("http://127.0.0.1:4199/__state")).json();
  const apiLog = await (await fetch(`${API}/__log`)).json();
  const writes = apiLog.filter((e) => e.method !== "GET");
  log("NOTHING_SENT", { review_status: review?.status ?? null, receiver_turns: receiver.turns.length, api_writes: writes.map((e) => `${e.method} ${e.url}`) });
  check("no review was finished, approved or delivered", (review === null || review?.status === "draft") && receiver.turns.length === 0 && !writes.some((e) => /finish|submit|approv|decision/i.test(e.url)));
  console.log(failures.length ? `RESULT FAIL (${failures.length}): ${failures.join("; ")}` : "RESULT PASS");
  process.exitCode = failures.length ? 1 : 0;
} finally {
  try { ws?.close(); } catch { /* closing */ }
  try { chrome?.kill("SIGTERM"); } catch { /* closing */ }
  stop();
  await sleep(1500); // let `next dev` exit before its tsconfig edit is undone
  restoreTsconfig();
}
