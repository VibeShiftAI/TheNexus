/** Isolated real-browser receiver verification. Synthetic registry/JWT fixtures; never a production cast or Windows proof. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const express = require('express');
const esbuild = require('../../dashboard/node_modules/esbuild');
const { createCanvas } = require('@napi-rs/canvas');
const access = require('../../server/__tests__/helpers/operator-access');
const { createPresentationService } = require('../../server/services/presentations');
const createRouter = require('../../server/routes/presentations');
const { createPresentationReceiverApp } = require('../../server/presentation-receiver');
const root = path.resolve(__dirname, '../..');
const evidence = path.join(root, 'docs/reviews/travel-displays-evidence');
fs.mkdirSync(evidence, { recursive: true });
const scratchRoot = path.join(root, 'data/presentation-captures');
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'browser-'));
const log = []; const record = (name, value) => { const line = `${name} ${JSON.stringify(value)}`; log.push(line); console.log(line); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceDevice = { id: 'windows:fixture-only', name: 'Simulated Windows controller on Mac', platform: 'windows' };
const docs = new Map(), revisions = new Map(), assets = new Map();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function register(kind, mime, bytes) {
  const id = `fixture-${kind}`, revisionId = `${id}-revision-1`, file = path.join(scratch, id);
  fs.writeFileSync(file, bytes); const hash = digest(bytes);
  docs.set(id, { id, title: `Travel review · ${kind}`, current_revision_id: revisionId });
  revisions.set(revisionId, { id: revisionId, document_id: id, content_hash: hash, content: kind === 'markdown' ? bytes.toString('utf8') : null, byte_length: bytes.length, media_type: kind, mime_type: mime });
  assets.set(revisionId, [{ asset_key: 'primary', role: 'primary', path: file, content_hash: hash, byte_length: bytes.length, media_type: kind, mime_type: mime }]);
  return { kind: 'document', documentId: id, revisionId, contentHash: hash };
}
function pdf() {
  const stream = 'BT /F1 28 Tf 60 700 Td (Exact revision PDF) Tj 0 -50 Td /F1 16 Tf (Read-only display fixture) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(out); out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
(async () => {
  let controller, receiver, service, chrome, ws; const nativeFetch = global.fetch; const restore = access.configure();
  global.fetch = async (url, options) => url === `${access.issuer}/cdn-cgi/access/certs` ? { ok: true, json: async () => access.jwks } : nativeFetch(url, options);
  try {
    const image = createCanvas(960, 540), context = image.getContext('2d');
    context.fillStyle = '#10253c'; context.fillRect(0, 0, 960, 540); context.fillStyle = '#78e3f2'; context.font = '48px sans-serif'; context.fillText('Exact image revision', 70, 210); context.fillStyle = '#ffffff'; context.font = '24px sans-serif'; context.fillText('Selected view only', 70, 270);
    const png = image.toBuffer('image/png'); const imagePath = path.join(scratch, 'video-image.png'); fs.writeFileSync(imagePath, png);
    const videoPath = path.join(scratch, 'fixture.mp4');
    execFileSync(require('@ffmpeg-installer/ffmpeg').path, ['-loglevel', 'error', '-loop', '1', '-i', imagePath, '-t', '2', '-r', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
    const views = [
      ['ambient', { kind: 'ambient' }], ['focus', { kind: 'focus', mode: 'active' }], ['board', { kind: 'focus', mode: 'board' }], ['day-plan', { kind: 'day-plan', date: '2026-10-20' }],
      ['markdown', register('markdown', 'text/markdown', Buffer.from('# Review the journey\n\nOnly this exact revision appears on the external screen.\n\n| Check | Result |\n|---|---|\n| Identity | Pinned |\n| Controls | On your laptop |\n\n[Inbox](/api/private) ![Unselected](/api/private)\n\n```mermaid\nflowchart TD\nA@{img:"/api/private",label:"Unselected"}\n```\n'))],
      ['image', register('image', 'image/png', png)], ['pdf', register('pdf', 'application/pdf', pdf())], ['video', register('video', 'video/mp4', fs.readFileSync(videoPath))],
    ];
    const db = { getProjects: async () => [{ id: 'p', name: 'The Nexus' }], getTasks: async () => [{ id: 't1', name: 'Review the travel display plan', status: 'in_progress' }, { id: 't2', name: 'Prepare tomorrow’s work', status: 'todo' }, { id: 't3', name: 'Record verification evidence', status: 'completed' }], getCalendarEvents: async () => [{ id: 'event', title: 'Review documents before departure', start_time: '2026-10-20T14:00:00Z', end_time: '2026-10-20T14:30:00Z', status: 'scheduled' }], documentReviews: { getDocument: id => docs.get(id), getRevision: id => revisions.get(id), listRevisionAssets: id => assets.get(id) || [] } };
    service = createPresentationService({ db, captureRoot: scratch, readActivity: async () => null });
    const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    // This fixture substitutes only the OS bridge; production React + HTTP/auth routers are exercised.
    const harnessDir = path.join(scratch, 'controller'); fs.mkdirSync(harnessDir);
    await esbuild.build({ absWorkingDir: path.join(root, 'dashboard'), stdin: { contents: `import {createRoot} from 'react-dom/client'; import {TravelPresentationLauncher,PresentDocumentButton} from './src/components/presentation/presentation-controller'; createRoot(document.getElementById('root')).render(<><TravelPresentationLauncher/><PresentDocumentButton documentId="fixture-markdown" revisionId="fixture-markdown-revision-1" contentHash="${views.find(v=>v[0]==='markdown')[1].contentHash}"/></>);`, resolveDir: path.join(root, 'dashboard'), loader: 'tsx' }, outfile: path.join(harnessDir, 'controller.js'), bundle: true, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture-native-bridge', setup(build) {
      build.onResolve({ filter: /presentation-native$/ }, () => ({ path: 'fixture-native-bridge', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `let session=null; export const displayShellAvailable=()=>true; export async function requestNativeDisplay(c){ if(c.action==='discover') return {ok:true,inventory:{version:1,sourceDevice:${JSON.stringify(sourceDevice)},observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString(),status:'available',limitations:['Simulated native bridge; not Windows proof.'],targets:[{id:'fixture-monitor',name:'Fixture external monitor',sourceDeviceId:'windows:fixture-only',method:'windows-monitor',availability:'available',observedAt:new Date().toISOString(),capabilities:['ambient','focus','document','day-plan'],limitations:[]}]}}; if(c.action==='start') session=c.sessionId; if(c.action==='stop')session=null; return {ok:true,sessionId:session,state:session?'active':'stopped'}; }` }));
    } }] });
    fs.writeFileSync(path.join(harnessDir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/presentation/app.css"></head><body><div id="root"></div><script type="module" src="/controller.js"></script></body></html>', 'utf8');
    const app = express();
    app.use((req, _res, next) => { if (req.get('cookie') === 'qa_controller=synthetic') req.headers['cf-access-jwt-assertion'] = access.token(); next(); });
    app.use('/api/presentations', createRouter({ service }));
    app.use('/presentation', express.static(path.join(root, 'dashboard/public/presentation')));
    app.use(express.static(harnessDir)); controller = await listen(app);
    const receiverRequests = [];
    const receiverApp = express(); receiverApp.use((req, _res, next) => { receiverRequests.push({ path: req.path, cookie: Boolean(req.get('cookie')), operator: Boolean(req.get('cf-access-jwt-assertion')) }); next(); }); receiverApp.use(createPresentationReceiverApp({ service })); receiver = await listen(receiverApp);
    const controllerBase = `http://127.0.0.1:${controller.address().port}`, receiverBase = `http://127.0.0.1:${receiver.address().port}`;
    const controllerRequest = async (url, body, method = 'POST') => { const response = await nativeFetch(controllerBase + '/api/presentations' + url, { method, headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': access.token() }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data; };
    const chromePath = process.env.NEXUS_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    assert.ok(fs.existsSync(chromePath), 'Provide an existing Chrome binary; this script installs nothing.');
    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(scratch, 'chrome-profile')}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    const activePortFile = path.join(scratch, 'chrome-profile/DevToolsActivePort');
    for (let i = 0; !fs.existsSync(activePortFile) && i < 100; i++) await sleep(100);
    const port = fs.readFileSync(activePortFile, 'utf8').split('\n')[0];
    const version = await (await nativeFetch(`http://127.0.0.1:${port}/json/version`)).json();
    const target = await (await nativeFetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => { ws.onopen = resolve; });
    let sequence = 0; const pending = new Map(); const consoleErrors = [];
    ws.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); } else if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000); pending.set(id, message => { clearTimeout(timeout); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result?.value; };
    const waitFor = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); } throw new Error(`Browser condition failed: ${expression}`); };
    const shot = async name => { const result = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(result.data, 'base64')); };
    await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    record('ENVIRONMENT', { date: new Date().toISOString(), host: process.platform, browser: version.Browser, viewport: '1440x1000', fixtures: true, windowsRuntime: false, physicalDevices: false });
    for (const [name, view] of views) {
      await send('Page.navigate', { url: receiverBase + '/presentation/index.html' }); await waitFor('!!document.querySelector("form button")');
      await evaluate('document.querySelector("form").requestSubmit()'); await waitFor('!!document.querySelector(".presentation-code")');
      const code = await evaluate('document.querySelector(".presentation-code").textContent');
      const claimed = await controllerRequest(`/pairings/${code}/claim`, { sourceDevice, view });
      await waitFor(`document.querySelector('[data-presentation-kind]')?.getAttribute('data-presentation-kind') === ${JSON.stringify(view.kind)}`);
      if (name === 'image') await waitFor('document.querySelector("[data-image-viewer] img")?.naturalWidth > 0');
      if (name === 'video') await waitFor('document.querySelector("video")?.readyState >= 2');
      if (name === 'pdf') { await waitFor('!!document.querySelector("iframe")'); await sleep(1200); }
      const observed = await evaluate('({kind:document.querySelector("[data-presentation-kind]")?.dataset.presentationKind,readOnly:document.body.textContent.includes("Read-only presentation"),links:document.querySelectorAll("a").length,reviewControls:document.querySelectorAll("[data-block-comment-button],textarea,[data-pdf-comment]").length,overflow:document.documentElement.scrollWidth>innerWidth,imageWidth:document.querySelector("[data-image-viewer] img")?.naturalWidth,videoReady:document.querySelector("video")?.readyState,pdfInert:document.querySelector("iframe")?.inert,localStorage:localStorage.length})');
      assert.equal(observed.readOnly, true); assert.equal(observed.reviewControls, 0); assert.equal(observed.links, 0); assert.equal(observed.overflow, false); assert.equal(observed.localStorage, 0);
      if (name === 'markdown') {
        docs.get(view.documentId).current_revision_id = 'newer-fixture-revision';
        await waitFor('document.body.textContent.includes("A newer revision exists")');
        assert.equal(await evaluate(`document.body.textContent.includes(${JSON.stringify(view.revisionId)}) && document.body.textContent.includes(${JSON.stringify(view.contentHash)})`), true);
      }
      await shot(name); record(`VIEW_${name.toUpperCase()}`, observed);
      await controllerRequest(`/sessions/${claimed.session.id}`, undefined, 'DELETE');
      await waitFor('document.body.textContent.includes("Presentation unavailable")');
      assert.equal(await evaluate('!!document.querySelector("[data-presentation-kind],video,iframe,[data-image-viewer]")'), false);
      record(`STOP_${name.toUpperCase()}`, { blanked: true });
    }
    await shot('stopped');
    await send('Network.setCookie', { name: 'qa_controller', value: 'synthetic', url: controllerBase });
    await send('Page.navigate', { url: controllerBase + '/index.html' });
    await waitFor('!![...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Displays")');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Displays").click()');
    await waitFor('!!document.querySelector("input[type=radio]")');
    await evaluate('document.querySelector("input[type=radio]").click()');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Present on selected display").click()');
    await waitFor('document.body.textContent.includes("Windows confirmed the presentation window")');
    assert.ok(service.sessions().some(s=>s.method==='windows-monitor'&&s.state==='active'));
    await shot('controller-fixture');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Stop / revoke").click()');
    await waitFor('document.body.textContent.includes("Presentation stopped and receiver access revoked")');
    assert.ok(service.sessions().filter(s=>s.method==='windows-monitor').every(s=>s.state==='stopped'));
    record('CONTROLLER_UI', { selectStartStop: 'PASS', nativeBridge: 'simulated', httpOperatorJwt: 'synthetic signed fixture' });
    assert.ok(receiverRequests.every(request => !request.cookie && !request.operator));
    assert.ok(!receiverRequests.some(request => request.path === '/api/private'));
    assert.deepEqual(consoleErrors, []);
    const denied = await nativeFetch(receiverBase + '/api/tasks'); assert.equal(denied.status, 404);
    record('ISOLATION', { requests: receiverRequests.length, operatorCredentials: false, unselectedResources: false, generalApiStatus: denied.status, consoleErrors });
    record('RESULT', 'PASS: eight selected views/media variants and eight controller revocations in real Chromium; no native/hardware claim.');
  } finally {
    ws?.close();
    if (chrome && chrome.exitCode === null) { const exit = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await exit; }
    for (const server of [receiver, controller]) if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    service?.close(); global.fetch = nativeFetch; restore();
    fs.writeFileSync(path.join(evidence, 'browser.log'), log.join('\n') + '\n', 'utf8');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
