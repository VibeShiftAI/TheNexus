#!/usr/bin/env node
/**
 * Drives the real localhost:3000 dashboard in a fresh headless Chrome profile.
 * CDP intercepts EVERY browser /api/ request: affected APIs go to an isolated
 * in-memory Nexus fixture; all others get inert responses. Socket.IO is blocked.
 * No live credential, database, Praxis action or email transport is used.
 * The script awaits and closes both its browser and fixture API before exiting.
 * Run from the repo root: node dashboard/scripts/local-operator-browser-check.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const REPO = path.resolve(__dirname, '../..');
const { initializeDocumentReviews, createDocumentReviewStore } = require(path.join(REPO, 'db/document-reviews'));
const KEY = 'browser-fixture-operator-'.repeat(3);
const RELAY_KEY = 'browser-fixture-relay-'.repeat(3);
const ORIGIN = 'http://localhost:3000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { synthetic: true, origin: ORIGIN, checks: [], mailActions: [], decisions: [], errors: [] };
let server, chrome, ws, raw, root;
async function main() {
    process.env.NEXUS_LOCAL_OPERATOR_SESSIONS = '1';
    process.env.NEXUS_LOCAL_OPERATOR_UID = '501';
    process.env.NEXUS_LOCAL_OPERATOR_CHROME = '1';
    // Only OS attestation is substituted. Real production rejects this
    // headless/CDP profile; peer.test and live probes check that boundary.
    require(path.join(REPO, 'server/services/local-operator-peer')).createLocalOperatorPeerVerifier = () => async () => 'mac-chrome';
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = KEY;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = 'browser-fixture-executor-'.repeat(3);
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = 'browser-fixture-runtime-'.repeat(3);
    process.env.PRAXIS_OPERATOR_KEY = RELAY_KEY;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-local-browser-')));
    raw = new Database(':memory:'); initializeDocumentReviews(raw);
    const store = createDocumentReviewStore(raw);
    const project = { id: 'fixture-project', name: 'Local operator verification', path: root };
    const task = { id: 'fixture-task', name: 'Synthetic only', project_id: project.id };
    const db = { documentReviews: store, getProjects: async () => [project], getProject: async id => id === project.id ? project : null, getTask: async id => id === task.id ? task : null };
    const drafts = ['edit-send', 'cancel'].map((id, index) => ({
        id: `md_fixture_${index}`, source: { kind: 'gmail', id }, to: 'recipient@example.invalid', cc: ['operator@example.invalid'],
        subject: `Synthetic ${id}`, body: 'Synthetic body; never transported.', status: 'draft', version: `v${index}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const app = express(); app.use(express.json());
    app.use(require('cors')({ origin: ORIGIN }));
    app.use((req, _res, next) => { req.user = { id: 'local_user', is_service: false }; next(); });
    app.use('/api/operator-session', require(path.join(REPO, 'server/routes/operator-session'))());
    app.use('/api/documents', require(path.join(REPO, 'server/routes/documents'))({ db }));
    app.use('/api/praxis/mailbox/drafts-review', require(path.join(REPO, 'server/routes/mail-draft-review'))({
        relay: async (url, options) => {
            if (options.method === 'GET') return { status: 200, json: async () => ({ items: drafts.filter(d => url.includes('folder=cancelled') ? d.status === 'cancelled' : d.status === 'draft'), counts: { drafts: drafts.filter(d => d.status === 'draft').length, cancelled: drafts.filter(d => d.status === 'cancelled').length } }) };
            const draft = drafts.find(d => d.id === url.split('/').pop()); assert.ok(draft);
            const fields = Object.fromEntries(options.headers['X-Praxis-Operator-Provenance'].split(';').slice(1).map(v => v.split('=')));
            const message = JSON.stringify({ purpose: 'mail-draft-review', id: draft.id, body: options.body });
            const digest = crypto.createHash('sha256').update(message).digest('hex');
            const expected = crypto.createHmac('sha256', RELAY_KEY).update(`praxis-operator-provenance/v1\n${fields.surface}\n${fields.ts}\n${fields.nonce}\n${digest}`).digest('hex');
            assert.equal(fields.sig, expected); assert.equal(fields.surface, 'mail-drafts');
            assert.equal(options.body.version, draft.version);
            const action = options.body.action;
            if (action === 'edit') { draft.body = options.body.body; draft.subject = options.body.subject; }
            else draft.status = action === 'approve_send' ? 'sent' : 'cancelled';
            draft.version = crypto.randomUUID();
            draft.decision = { actor: 'operator:' + fields.surface, action };
            report.mailActions.push(draft.decision);
            return { status: 200, json: async () => ({ draft }) };
        },
    }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    const docs = [];
    for (const name of ['approve', 'request_changes']) {
        const file = path.join(root, name + '.md'); fs.writeFileSync(file, '# Synthetic operator review\n\nNo client work.\n', 'utf8');
        const response = await fetch(apiBase + '/api/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file, title: `Synthetic ${name}`, project_id: project.id, task_id: task.id, deliverable: { requires_review: true, intended_action: 'none' } }) });
        assert.equal(response.status, 201); docs.push((await response.json()).document.id);
    }
    const profile = path.join(root, 'chrome'); fs.mkdirSync(profile);
    chrome = spawn(process.env.CHECK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(profile, 'DevToolsActivePort')); i++) await sleep(100);
    const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => { ws.onopen = resolve; });
    let nextId = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = async event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const waiter = pending.get(message.id); pending.delete(message.id);
            message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); return;
        }
        if (message.method === 'Fetch.requestPaused') {
            const { requestId, request } = message.params;
            try {
                const url = new URL(request.url);
                let status = 200, body = JSON.stringify({ items: [], counts: { drafts: 0, cancelled: 0 } }), headers = [{ name: 'Content-Type', value: 'application/json' }];
                if (/^\/api\/(operator-session|documents|praxis\/mailbox\/drafts-review)(\/|$)/.test(url.pathname)) {
                    const response = await fetch(apiBase + url.pathname + url.search, { method: request.method, headers: request.headers, ...(request.postData ? { body: request.postData } : {}) });
                    status = response.status; body = await response.text();
                    headers = [...response.headers].filter(([name]) => !['connection', 'transfer-encoding', 'content-length', 'content-encoding'].includes(name)).map(([name, value]) => ({ name, value }));
                }
                await send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(body).toString('base64') });
            } catch (error) {
                // Navigation cancels outstanding polls; CDP then invalidates
                // their interception ids. This is not an API failure.
                if (/Invalid InterceptionId/.test(error.message)) return;
                report.errors.push('intercept: ' + error.message);
                await send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
            }
        }
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*socket.io*'] });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/*' }] });
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result?.value;
    };
    const wait = async (expression, label) => {
        for (let i = 0; i < 160; i++) { if (await evaluate(`!!(${expression})`)) return; await sleep(250); }
        throw new Error(`Timeout: ${label}; page=${await evaluate('document.body.innerText.slice(-2000)')}`);
    };
    const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    const click = async label => { await wait(`!!${button(label)} && !${button(label)}.disabled`, label); await evaluate(`${button(label)}.click()`); };
    const input = async (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    const navigate = async route => { await send('Page.navigate', { url: ORIGIN + route }); await wait('document.readyState === "complete"', route); };
    // The root session component establishes proof without any sign-in UI.
    await navigate('/mail?folder=drafts');
    await wait(`document.querySelector('[data-draft-id="runtime:md_fixture_0"]')`, 'mail draft fixture');
    await evaluate(`document.querySelector('[data-draft-id="runtime:md_fixture_0"]').click()`);
    await wait('document.querySelector("[aria-label=Subject]")', 'mail editor');
    await input('[aria-label=Subject]', 'Edited synthetic subject');
    assert.equal(await evaluate('!!document.querySelector("input[type=password]") || [...document.querySelectorAll("button")].some(b => b.textContent === "Operator sign-in")'), false);
    assert.equal(await evaluate('document.querySelector("[aria-label=Subject]").value'), 'Edited synthetic subject');
    report.checks.push('no operator sign-in UI; unsaved mail edit survives automatic bootstrap');
    await click('Save changes'); await wait('!document.body.innerText.includes("Saving") && !!document.querySelector("[aria-label=Subject]") && [...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Approve and send" && !b.disabled)', 'saved mail');
    await click('Approve and send'); await wait(`!document.querySelector('[data-draft-id="runtime:md_fixture_0"]')`, 'synthetic sent draft removed');
    await evaluate(`document.querySelector('[data-draft-id="runtime:md_fixture_1"]').click()`); await click('Cancel send');
    await wait(`!document.querySelector('[data-draft-id="runtime:md_fixture_1"]')`, 'cancelled draft removed');
    for (const [index, kind] of ['approve', 'request_changes'].entries()) {
        await navigate('/documents/' + docs[index]);
        await wait(`document.querySelector('[data-decision-button="${kind}"]')`, 'document decision');
        await evaluate(`document.querySelector('[data-decision-button="${kind}"]').click()`);
        await wait('document.querySelector("#decision-note")', 'decision note');
        await input('#decision-note', 'Synthetic note retained through automatic bootstrap');
        assert.equal(await evaluate('document.querySelector("#decision-note").value'), 'Synthetic note retained through automatic bootstrap');
        await evaluate('document.querySelector("[data-decision-submit]").click()');
        await wait('document.querySelector("[data-decision-notice=ok]")', 'recorded document decision');
    }
    report.decisions = raw.prepare('SELECT decision, authority, recorded_by, actor_id FROM review_document_decisions ORDER BY created_at').all();
    assert.equal(report.decisions.length, 2);
    assert.ok(report.decisions.every(d => d.authority === 'operator_credential' && d.recorded_by === 'operator'));
    report.checks.push('approve and request changes recorded in isolated document ledger; automatic bootstrap preserves notes');
    await evaluate("fetch('/api/operator-session', {method:'DELETE',headers:{'X-Nexus-Local-Proof':localStorage.getItem('nexus:local-operator-proof')}}).then(r => r.json())");
    const refused = await evaluate(`fetch('/api/documents/${docs[0]}/decisions', {method:'POST',headers:{'Content-Type':'application/json','X-Nexus-Local-Proof':localStorage.getItem('nexus:local-operator-proof')},body:JSON.stringify({decision:'approve'})}).then(async r => ({status:r.status,body:await r.json()}))`);
    assert.equal(refused.status, 403); assert.equal(refused.body.code, 'operator_required');
    report.checks.push('explicit revocation refuses subsequent document decisions: 403 operator_required');
    assert.deepEqual(report.mailActions.map(a => a.action), ['edit', 'approve_send', 'cancel']);
    assert.equal(report.errors.length, 0);
}
main().catch(error => { report.errors.push(error.message); process.exitCode = 1; }).finally(async () => {
    ws?.close();
    if (chrome && chrome.exitCode === null) { const stopped = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await stopped; }
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    raw?.close();
    const output = process.env.CHECK_REPORT || '/tmp/nexus-local-operator-browser.json';
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
    if (root) {
        // Chrome's helper processes can finish flushing after its main exit.
        await sleep(300);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    console.log(JSON.stringify(report, null, 2));
});
