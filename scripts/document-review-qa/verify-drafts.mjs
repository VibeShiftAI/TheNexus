// Chrome (CDP) check that unsaved review text survives a page reload, on the
// ISOLATED stack (task 1390fc34). One process owns the whole stack: it spawns
// api.cjs (:4100, temp DB, real documents router), receiver.cjs (:4199),
// `next dev` on :3100 with its own dist dir, and headless Chrome, and stops
// them all at the end. Nothing here touches :3000, :4000 or the live database.
//
//   node scripts/document-review-qa/verify-drafts.mjs
//
// The script makes its own temporary directory (printed as QA_DIR; set
// NEXUS_REVIEW_QA_DIR to choose one). `next dev` appends
// `.next-document-review-qa/**` entries to dashboard/tsconfig.json while it
// runs; the script puts that file's exact bytes back at the end, and leaves it
// alone if anything else changed it meanwhile. Screenshots land in <QA_DIR>/shots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const QA_DIR = process.env.NEXUS_REVIEW_QA_DIR || mkdtempSync(join(tmpdir(), "nexus-document-review-qa-"));
const TSCONFIG = join(ROOT, "dashboard/tsconfig.json");
const tsconfigBefore = readFileSync(TSCONFIG);
const BASE = "http://127.0.0.1:3100";
const API = "http://127.0.0.1:4100";
const OUT = join(QA_DIR, "shots");
mkdirSync(OUT, { recursive: true });
const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => existsSync(p));
if (!CHROME) throw new Error("Chrome or Chromium is required in /Applications");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, value) => console.log(tag, typeof value === "string" ? value : JSON.stringify(value));

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

let chrome = null;
let ws = null;
try {
  child("api", process.execPath, [join(HERE, "api.cjs")], { cwd: ROOT, env: { ...process.env, NEXUS_REVIEW_QA_DIR: QA_DIR } });
  child("receiver", process.execPath, [join(HERE, "receiver.cjs")], { cwd: ROOT, env: process.env });
  child("next", "npm", ["run", "dev", "--", "--port", "3100"], { cwd: join(ROOT, "dashboard"), env: { ...process.env, NEXT_PUBLIC_API_URL: API, NEXT_DIST_DIR: ".next-document-review-qa", BROWSER: "none" } });
  const isolation = await (await waitHttp(`${API}/__qa`, 60_000)).json();
  assert.equal(isolation.qaDirectory, QA_DIR, "refuse to write through a non-fixture API");
  const docs = await (await waitHttp(`${API}/api/documents?task_id=44444444-4444-4444-8444-444444444444`, 60_000, (r) => r.ok)).json();
  const docId = docs.documents[0]?.id;
  assert.ok(docId, "isolated report was registered");
  log("DOC", docId);
  await waitHttp(`${BASE}/documents/${docId}`, 240_000, (r) => r.status === 200);
  const PAGE = `${BASE}/documents/${docId}`;
  const KEY = `nexus:document-review-draft:${docId}`;

  // ── Chrome ──
  const port = 9334 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "nexus-verify-drafts-"));
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
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
  const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, "base64")); };
  const waitFor = async (expr, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return true; await sleep(250); } return false; };
  const navigate = async () => { await send("Page.navigate", { url: PAGE }); assert.ok(await waitFor("!!document.querySelector('[data-document-markdown]')"), "review page rendered"); await sleep(400); };
  /** A real browser reload: the page is torn down and rebuilt from the server, which is what the dev server's full reload does. */
  const reload = async () => {
    await evalJs("window.__beforeReload = true");
    await send("Page.reload", { ignoreCache: true });
    assert.ok(await waitFor("!window.__beforeReload && !!document.querySelector('[data-document-markdown]')"), "page came back after reload");
    await sleep(400);
  };
  const typeInto = async (selector, text) => { assert.ok(await evalJs(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); if (!t) return false; t.focus(); return document.activeElement === t; })()`), `focus ${selector}`); await send("Input.insertText", { text }); await sleep(150); };
  const clickText = async (scope, text) => assert.ok(await evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`), `click "${text}" in ${scope}`);
  const draft = () => evalJs(`JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) ?? 'null')`);
  const serverReview = async () => (await (await fetch(`${API}/api/documents/${docId}`)).json()).review;

  // ── Desktop: a passage comment typed, the page reloads, the text is back with its anchor and id; saving it is one save ──
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate();
  const TEXT1 = "Typed before the reload: name the on-call owner here.";
  assert.ok(await evalJs("(() => { const b = document.querySelector('[data-block-comment-button]'); if (!b) return false; b.click(); return true; })()"), "a passage comment control exists");
  await sleep(200);
  const title1 = await evalJs("document.querySelector('[data-composer] span.font-semibold')?.textContent");
  await typeInto("[data-composer] textarea", TEXT1);
  const draft1 = await draft();
  log("DESKTOP_DRAFT_STORED", { title: title1, text: draft1?.composer?.text, block: draft1?.composer?.block, revision_id: draft1?.revision_id, reviewer_id: draft1?.reviewer_id, client_id: draft1?.composer?.client_id });
  assert.equal(draft1?.composer?.text, TEXT1);
  assert.equal(draft1?.reviewer_id, "local_user", "the API reports the viewer and the draft is bound to it");
  assert.equal((await serverReview()), null, "typing opened no review on the server");
  await reload();
  const restored1 = await evalJs("(() => { const c = document.querySelector('[data-composer]'); return c && { title: c.querySelector('span.font-semibold')?.textContent, value: c.querySelector('textarea').value, hint: c.querySelector('[data-composer-restored]')?.textContent ?? null }; })()");
  log("DESKTOP_RESTORED_AFTER_RELOAD", restored1);
  assert.equal(restored1?.value, TEXT1, "the typed text is back after a real reload");
  assert.equal(restored1?.title, title1, "on the same passage");
  assert.ok(restored1?.hint, "the reader is told it is not saved yet");
  await shot("1440-restored-after-reload");
  await clickText("[data-composer]", "Save comment");
  assert.ok(await waitFor(`/${TEXT1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.test(document.querySelector('[data-comment-list]')?.textContent || '')`), "saved comment listed");
  const after1 = await serverReview();
  const savedComment = after1?.comments.find((c) => c.body === TEXT1);
  log("DESKTOP_SAVED", { client_id: savedComment?.client_id, same_id_as_draft: savedComment?.client_id === draft1.composer.client_id, draft_cleared: (await draft()) === null, comments: after1?.comments.length });
  assert.equal(savedComment?.client_id, draft1.composer.client_id, "the save carried the id minted before the reload");
  assert.equal(await draft(), null, "storage cleared once the server has it");
  await reload();
  const durable = await evalJs(`({ listed: /${TEXT1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.test(document.querySelector('[data-comment-list]')?.textContent || ''), composer: !!document.querySelector('[data-composer]'), recovered: !!document.querySelector('[data-recovered-drafts]') })`);
  log("DESKTOP_SAVED_SURVIVES_RELOAD", durable);
  assert.deepEqual(durable, { listed: true, composer: false, recovered: false });
  await shot("1440-saved-after-reload");

  // ── Desktop: summary typed and the page reloads before the autosave fires ──
  const SUMMARY = "Summary typed just before the reload.";
  await typeInto("#review-summary", SUMMARY);
  await reload();
  const summaryBack = await evalJs("({ value: document.querySelector('#review-summary')?.value, notice: document.querySelector('[data-summary-restored]')?.textContent ?? null })");
  const summaryServerBefore = (await serverReview())?.summary ?? "";
  log("SUMMARY_RESTORED", { ...summaryBack, server_before_save_now: summaryServerBefore });
  assert.equal(summaryBack.value, SUMMARY);
  assert.ok(summaryBack.notice, "the summary notice says it is not saved yet");
  await clickText("[data-summary-restored]", "Save now");
  assert.ok(await waitFor("!document.querySelector('[data-summary-restored]')"), "notice clears after the save");
  assert.equal((await serverReview())?.summary, SUMMARY, "Save now stored the summary");
  log("SUMMARY_SAVED", { server: (await serverReview())?.summary, draft_cleared: (await draft()) === null });

  // ── Phone: a whole-document note in the bottom sheet survives the reload; Cancel discards it ──
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await navigate();
  await evalJs("document.querySelector('[data-open-review]').click()"); await sleep(300);
  await clickText("[data-review-drawer]", "Add a note about the whole document"); await sleep(400);
  const TEXT2 = "Phone note typed before the reload.";
  await typeInto("[data-composer-sheet] textarea", TEXT2);
  await reload();
  const phoneBack = await evalJs("({ value: document.querySelector('[data-composer-sheet] textarea')?.value ?? null, hint: !!document.querySelector('[data-composer-sheet] [data-composer-restored]') })");
  log("PHONE_RESTORED_AFTER_RELOAD", phoneBack);
  assert.equal(phoneBack.value, TEXT2);
  assert.ok(phoneBack.hint);
  await shot("390-restored-after-reload");
  await clickText("[data-composer-sheet]", "Cancel"); await sleep(200);
  log("PHONE_CANCEL_CLEARS", { composer: await evalJs("!!document.querySelector('[data-composer-sheet]')"), draft: await draft() });
  assert.equal(await draft(), null, "Cancel discards the draft");

  // ── Desktop: a passage comment typed on one revision; the file changes; the page comes back on the new revision ──
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate();
  const TEXT3 = "Written against the earlier revision.";
  assert.ok(await evalJs("(() => { const b = document.querySelector('[data-block-comment-button]'); if (!b) return false; b.click(); return true; })()"));
  await sleep(200);
  await typeInto("[data-composer] textarea", TEXT3);
  const draft3 = await draft();
  const report = join(QA_DIR, "Praxis/readiness.md");
  writeFileSync(report, `Preface line added by the drafts check.\n\n${readFileSync(report, "utf8")}`);
  await reload();
  assert.ok(await waitFor("!!document.querySelector('[data-recovered-drafts]')"), "recovered card shown");
  const recovered = await evalJs("(() => { const card = document.querySelector('[data-recovered-drafts]'); const item = card.querySelector('[data-recovered-draft]'); return { composer: !!document.querySelector('[data-composer]'), reason: item?.dataset.recoveredReason, text: item?.querySelector('[data-recovered-text]')?.textContent, where: item?.querySelector('div')?.textContent, changedBanner: !!document.querySelector('[data-changed-banner]') }; })()");
  const liveRevision = (await (await fetch(`${API}/api/documents/${docId}`)).json()).revision.id;
  log("REVISION_CHANGED_RECOVERED", { ...recovered, draft_revision: draft3.revision_id, live_revision: liveRevision });
  assert.equal(recovered.composer, false, "no composer: the anchor belongs to the earlier revision");
  assert.equal(recovered.reason, "revision");
  assert.equal(recovered.text, TEXT3);
  assert.notEqual(draft3.revision_id, liveRevision);
  await shot("1440-recovered-after-revision-change");
  await clickText("[data-recovered-drafts]", "Discard"); await sleep(200);
  log("RECOVERED_DISCARDED", { card: await evalJs("!!document.querySelector('[data-recovered-drafts]')"), draft: await draft() });
  assert.equal(await draft(), null);

  const finalReview = await serverReview();
  log("SERVER_FINAL", { status: finalReview?.status, comments: finalReview?.comments.map((c) => c.body), summary: finalReview?.summary });
  assert.equal(finalReview?.status, "draft", "nothing was finished, sent or approved");
  assert.deepEqual(finalReview?.comments.map((c) => c.body), [TEXT1], "exactly the one comment the reader saved");
  console.log("RESULT PASS");
} finally {
  try { ws?.close(); } catch { /* closing */ }
  try { chrome?.kill("SIGTERM"); } catch { /* closing */ }
  stop();
  await sleep(1500); // let `next dev` exit before its tsconfig edit is undone
  restoreTsconfig();
}
