/** Automatic local bootstrap (OS peer fixture), authority, document ledger and signed mail relay; synthetic data only. */
jest.mock('../services/local-operator-peer', () => ({
    ...jest.requireActual('../services/local-operator-peer'),
    createLocalOperatorPeerVerifier: () => async () => 'mac-chrome',
}));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const express = require('express');
const Database = require('better-sqlite3');
const { initializeDocumentReviews, createDocumentReviewStore } = require('../../db/document-reviews');
const KEY = 'synthetic-operator-'.repeat(4);
const RELAY_KEY = 'synthetic-relay-'.repeat(4);
const ORIGIN = 'http://localhost:3000';
let server, base, raw, root, store, doc, revision, calls, originalEnv;
const clientProofs = new Map();
async function api(method, url, body, headers = {}) {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(headers.cookie && clientProofs.has(headers.cookie) ? { 'x-nexus-local-proof': clientProofs.get(headers.cookie) } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.NEXUS_LOCAL_OPERATOR_SESSIONS = '1';
    process.env.NEXUS_LOCAL_OPERATOR_UID = '501';
    process.env.NEXUS_LOCAL_OPERATOR_CHROME = '1';
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = KEY;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = 'synthetic-executor-'.repeat(4);
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = 'synthetic-runtime-'.repeat(4);
    process.env.PRAXIS_OPERATOR_KEY = RELAY_KEY;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-local-operator-')));
    const file = path.join(root, 'fixture.md'); fs.writeFileSync(file, '# Synthetic review\n', 'utf8');
    raw = new Database(':memory:'); initializeDocumentReviews(raw); store = createDocumentReviewStore(raw);
    const project = { id: 'project-1', name: 'Synthetic', path: root };
    const task = { id: 'task-1', project_id: project.id, name: 'Synthetic review' };
    const db = { documentReviews: store, getProjects: async () => [project], getProject: async id => id === project.id ? project : null, getTask: async id => id === task.id ? task : null };
    const app = express(); app.use(express.json());
    // The real production stub/mount list; no synthetic operator user.
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    vm.runInNewContext(source.slice(source.indexOf('function authenticate(req, res, next)'), source.indexOf("app.use('/api/write-leases'")), { app });
    app.use('/api/operator-session', require('../routes/operator-session')());
    app.use('/api/documents', require('../routes/documents')({ db }));
    calls = [];
    app.use('/api/praxis/mailbox/drafts-review', require('../routes/mail-draft-review')({
        relay: async (url, options) => {
            const proof = options.headers['X-Praxis-Operator-Provenance'];
            const parts = Object.fromEntries(proof.split(';').slice(1).map(v => v.split('=')));
            const message = JSON.stringify({ purpose: 'mail-draft-review', id: url.split('/').pop(), body: options.body });
            const digest = crypto.createHash('sha256').update(message, 'utf8').digest('hex');
            const expected = crypto.createHmac('sha256', RELAY_KEY).update(`praxis-operator-provenance/v1\n${parts.surface}\n${parts.ts}\n${parts.nonce}\n${digest}`, 'utf8').digest('hex');
            expect(parts.sig).toBe(expected); expect(parts.surface).toBe('mail-drafts');
            calls.push(options.body.action);
            return { status: 200, json: async () => ({ decision: { actor: 'operator:' + parts.surface } }) };
        },
    }));
    const authenticate = require('../services/operator-access').createOperatorAuthenticator();
    app.post('/chat-authority', async (req, res) => res.json({ operator: await authenticate(req) }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const registration = await api('POST', '/api/documents', { path: file, title: 'Synthetic', project_id: project.id, task_id: task.id, deliverable: { key: 'fixture', requires_review: true, intended_action: 'none' } });
    expect(registration.status).toBe(201); doc = registration.json.document; revision = registration.json.revision;
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close(); fs.rmSync(root, { recursive: true, force: true }); process.env = originalEnv;
});
async function bootstrap() {
    const result = await api('POST', '/api/operator-session/bootstrap', undefined);
    expect(result.status).toBe(201); clientProofs.set(result.cookie, result.json.proof); return result.cookie;
}
test.each(['approve', 'request_changes'])('local session records %s as a direct operator decision in the real ledger', async decision => {
    const cookie = await bootstrap();
    const result = await api('POST', `/api/documents/${doc.id}/decisions`, { revision_id: revision.id, decision, note: 'Synthetic decision' }, { cookie, authorization: 'Bearer local-dev-token' });
    expect(result.status).toBe(201);
    expect(result.json.decision).toMatchObject({ authority: 'operator_credential', recorded_by: 'operator', actor_id: 'local_user' });
    const read = await api('GET', `/api/documents/${doc.id}`);
    expect(read.json.current_decision.id).toBe(result.json.decision.id);
});
test.each(['edit', 'approve_send', 'cancel'])('local session %s reaches the mail relay with a valid body-bound operator:mail-drafts proof', async action => {
    const cookie = await bootstrap();
    const result = await api('POST', '/api/praxis/mailbox/drafts-review/md_fixture', { action, version: 'fixture', subject: 'Synthetic', body: 'Not sent' }, { cookie });
    expect(result.status).toBe(200); expect(result.json.decision.actor).toBe('operator:mail-drafts'); expect(calls).toEqual([action]);
});
test('shared chat authenticator accepts the signed local session and refuses it after logout', async () => {
    const cookie = await bootstrap();
    expect((await api('POST', '/chat-authority', {}, { cookie })).json.operator).toBe(true);
    await api('DELETE', '/api/operator-session', undefined, { cookie });
    expect((await api('POST', '/chat-authority', {}, { cookie })).json.operator).toBe(false);
});
test.each([
    ['plain loopback / QA reviewer', {}],
    ['placeholder bearer', { authorization: 'Bearer local-dev-token' }],
    ['runtime', { authorization: 'Bearer ' + 'synthetic-runtime-'.repeat(4) }],
    ['executor', { authorization: 'Bearer ' + 'synthetic-executor-'.repeat(4) }],
    ['bridge', { 'x-praxis-bridge-token': 'machine' }],
])('%s remains refused by documents and mail without direct operator proof', async (name, headers) => {
    const result = await api('POST', `/api/documents/${doc.id}/decisions`, { decision: 'approve', revision_id: revision.id }, headers);
    expect(result.status).toBe(403);
    expect(result.json.code).toBe(name === 'executor' ? 'executor_provenance_required' : 'operator_required');
    const mail = await api('POST', '/api/praxis/mailbox/drafts-review/md_fixture', { action: 'approve_send', version: 'fixture' }, headers);
    expect(mail.status).toBe(403); expect(mail.json.code).toBe('operator_required'); expect(calls).toHaveLength(0);
});

test('an invalid Access assertion cannot fall back to a valid local cookie', async () => {
    const cookie = await bootstrap();
    const result = await api('POST', `/api/documents/${doc.id}/decisions`, { decision: 'approve', revision_id: revision.id }, { cookie, 'cf-access-jwt-assertion': 'forged' });
    expect(result.status).toBe(403); expect(result.json.code).toBe('operator_required');
});

test.each(['user', 'device'])('valid Access %s keeps precedence over a malformed local cookie', async kind => {
    const access = require('./helpers/operator-access');
    const restore = access.configure({ deviceIds: access.deviceId });
    const nativeFetch = global.fetch;
    global.fetch = async (url, options) => String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks } : nativeFetch(url, options);
    try {
        // Fresh authority sees the fixture configuration; existing route
        // instances intentionally pin their Access configuration at creation.
        const authenticate = require('../services/operator-access').createOperatorAuthenticator();
        const headers = { cookie: 'nexus_local_operator=forged', 'cf-access-jwt-assertion': kind === 'user' ? access.token() : access.serviceToken() };
        expect(await authenticate.inspect({ get: name => headers[name.toLowerCase()] })).toMatchObject({ operator: true, identity: kind });
    } finally { global.fetch = nativeFetch; restore(); }
});
