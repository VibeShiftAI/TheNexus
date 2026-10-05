/**
 * Declared deliverables, revision-pinned review decisions and the paged
 * review queue (contract: docs/contracts/document-review-deliverables.md).
 *
 * Isolated NEXUS_DB_PATH and temporary project roots. Delivery is a stub that
 * records calls, the Cloudflare Access signing keys are a local fixture, and
 * the operator credential is a synthetic test value: nothing here reaches the
 * live database, Praxis, Cloudflare or a mail transport.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const access = require('./helpers/operator-access');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-0123456789abcdef';
const RUNTIME_KEY = 'runtime-test-credential-0123456789abcdefgh';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const TASK_A = '22222222-2222-4222-8222-22222222222a';
const TASK_B = '22222222-2222-4222-8222-22222222222b';
const OTHER_TASK = '44444444-4444-4444-8444-444444444444';

let db;
let base;
let server;
let workspace;
let projectRoot;
let otherRoot;
let delivery;
let restoreAccess;

async function api(method, url, body, { user = 'local_user', headers = {} } = {}) {
    const all = { 'content-type': 'application/json', ...headers };
    if (user) all['x-test-user'] = user;
    const response = await nativeFetch(base + url, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, json: type.includes('application/json') ? await response.json() : await response.text() };
}

const operator = { headers: { authorization: `Bearer ${OPERATOR_KEY}` } };

function writeDoc(name, content, root = projectRoot) {
    const file = path.join(root, 'docs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function declared(file, { deliverable = {}, ...extra } = {}) {
    return {
        path: file, title: 'Launch plan', project_id: PROJECT_ID, task_id: TASK_A, kind: 'plan',
        deliverable: { purpose: 'Decide whether the launch plan is ready', requires_review: true, intended_action: 'implement', ...deliverable },
        ...extra,
    };
}

async function register(file, options) {
    return api('POST', '/api/documents', declared(file, options));
}

async function decide(documentId, revisionId, decision = 'approve', extra = {}, options = operator) {
    return api('POST', `/api/documents/${documentId}/decisions`, { decision, revision_id: revisionId, ...extra }, options);
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-deliverables-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = RUNTIME_KEY;
    restoreAccess = access.configure({ deviceIds: access.deviceId });
    // Only the Access signing-key fetch is faked; the test's own HTTP calls use the native fetch.
    global.fetch = jest.fn(async (url, init) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks }
        : nativeFetch(url, init)));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Praxis');
    otherRoot = path.join(workspace, 'Other');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(otherRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'Praxis', path: projectRoot });
    await db.upsertProject({ id: OTHER_PROJECT_ID, name: 'Other', path: otherRoot });
    await db.createTask({ id: TASK_A, project_id: PROJECT_ID, name: 'Draft the launch plan', status: 'in_progress' });
    await db.createTask({ id: TASK_B, project_id: PROJECT_ID, name: 'Revise the launch plan', status: 'in_progress' });
    await db.createTask({ id: OTHER_TASK, project_id: OTHER_PROJECT_ID, name: 'Unrelated', status: 'in_progress' });
    delivery = { deliver: jest.fn(async () => null) };
    const createDocumentsRouter = require('../routes/documents');
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/documents', (req, _res, next) => {
        const user = req.headers['x-test-user'];
        if (user) req.user = { id: String(user), role: 'admin', is_service: req.headers['x-test-service'] === '1' };
        next();
    });
    app.use('/api/documents', createDocumentsRouter({ db, delivery }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    restoreAccess();
    jest.restoreAllMocks();
    delete process.env.NEXUS_DB_PATH;
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

// ── Criterion 2: declared fields are validated against the real file, root and association ──

test('a declared deliverable needs a real readable Markdown file inside a project root and an exact project/task match', async () => {
    const good = writeDoc('plan.md', '# Plan\n\nReady.\n');
    const outside = path.join(workspace, 'outside.md');
    fs.writeFileSync(outside, '# outside');
    fs.symlinkSync(outside, path.join(projectRoot, 'docs', 'escape.md'));
    const badUtf8 = writeDoc('bad.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const locked = writeDoc('locked.md', '# locked');
    fs.chmodSync(locked, 0o000);
    writeDoc('notes.txt', 'plain');

    const refusals = [
        [{ path: path.join(projectRoot, 'docs', 'missing.md') }, 404, 'not_found'],
        [{ path: badUtf8 }, 422, 'invalid_encoding'],
        [{ path: locked }, 500, 'unreadable'],
        [{ path: outside }, 403, 'outside_roots'],
        [{ path: path.join(projectRoot, 'docs', 'escape.md') }, 403, 'symlink_escape'],
        [{ path: path.join(projectRoot, 'docs', 'notes.txt') }, 415, 'not_markdown'],
        [{ path: good, task_id: OTHER_TASK }, 422, 'association_mismatch'],
        [{ path: good, project_id: OTHER_PROJECT_ID }, 422, 'association_mismatch'],
        [{ path: good, task_id: 'no-such-task' }, 404, 'task_not_found'],
        [{ path: good, project_id: 'no-such-project' }, 404, 'project_not_found'],
        [{ path: good, project_id: undefined }, 400, 'invalid_deliverable'],
        [{ path: good, title: undefined }, 400, 'invalid_deliverable'],
        [{ path: good, task_id: undefined }, 400, 'invalid_deliverable'],
        [{ path: good, kind: 'weird' }, 400, 'invalid_deliverable'],
        [{ path: good, expected_content_hash: 'f'.repeat(64) }, 409, 'content_mismatch'],
        [{ path: good, deliverable: { requiresReview: true } }, 400, 'invalid_deliverable'],
        [{ path: good, deliverable: { requires_review: 'yes' } }, 400, 'invalid_deliverable'],
        [{ path: good, deliverable: { purpose: '   ' } }, 400, 'invalid_deliverable'],
        [{ path: good, deliverable: { intended_action: 'email' } }, 400, 'invalid_deliverable'],
        [{ path: good, deliverable: { requires_review: false, intended_action: 'send' } }, 400, 'invalid_deliverable'],
        [{ path: good, deliverable: { key: 'path:/forged' } }, 400, 'invalid_deliverable'],
        [{ path: good, task_id: undefined, deliverable: { source: { type: 'chat' } } }, 400, 'invalid_deliverable'],
        [{ path: good, deliverable: { source: { type: 'email', conversation_id: 'c' } } }, 400, 'invalid_deliverable'],
    ];
    for (const [override, status, code] of refusals) {
        const { deliverable, ...rest } = override;
        const body = declared(good, { deliverable });
        Object.assign(body, rest);
        for (const [key, value] of Object.entries(rest)) if (value === undefined) delete body[key];
        const response = await api('POST', '/api/documents', body);
        expect({ override: Object.keys(override), status: response.status, code: response.json.code })
            .toEqual({ override: Object.keys(override), status, code });
        expect(response.json.receipt).toBeUndefined();
    }
    // Nothing was written by any refusal: no document, no revision, no receipt.
    expect((await api('GET', '/api/documents/counts')).json.counts.all).toBe(0);
    fs.chmodSync(locked, 0o600);

    const ok = await register(good, { expected_content_hash: require('../services/document-registry').sha256('# Plan\n\nReady.\n') });
    expect(ok.status).toBe(201);
    expect(ok.json.receipt).toMatchObject({
        document_id: ok.json.document.id, revision_id: ok.json.revision.id, content_hash: ok.json.revision.content_hash,
        path: good, project_id: PROJECT_ID, task_id: TASK_A, root_project_id: PROJECT_ID, title: 'Launch plan',
        purpose: 'Decide whether the launch plan is ready', kind: 'plan', requires_review: true, intended_action: 'implement',
        document_created: true, revision_created: true, review_status: 'needs_review',
        review_path: `/documents/${ok.json.document.id}`, deliverable_key: `path:${good}`,
    });
    expect(ok.json.receipt.raw_path).toBe(`/api/documents/${ok.json.document.id}/raw?revision=${ok.json.revision.id}`);
    expect(ok.json.review_path).toBe(`/documents/${ok.json.document.id}`);
    // The receipt's revision is the exact bytes read: its raw source matches.
    expect((await api('GET', ok.json.receipt.raw_path)).json).toBe('# Plan\n\nReady.\n');
});

test('a chat deliverable may omit the task but must name its conversation; a reference deliverable needs no decision', async () => {
    const file = writeDoc('chat-note.md', '# Chat note\n');
    const chat = await register(file, { task_id: undefined, deliverable: { requires_review: false, intended_action: 'none', source: { type: 'chat', conversation_id: 'conv-1', message_id: 'msg-1' } } });
    expect(chat.status).toBe(201);
    expect(chat.json.document).toMatchObject({ task_id: null, requires_review: false, intended_action: 'none' });
    expect(chat.json.receipt).toMatchObject({ task_id: null, requires_review: false, review_status: 'reference', source: { type: 'chat', conversation_id: 'conv-1', message_id: 'msg-1' } });
    const read = await api('GET', `/api/documents/${chat.json.document.id}`);
    expect(read.json).toMatchObject({ review_status: 'reference', current_decision: null });
    expect(read.json.links.review_path).toBe(`/documents/${chat.json.document.id}`);
    const refused = await decide(chat.json.document.id, chat.json.revision.id);
    expect(refused).toMatchObject({ status: 409, json: { code: 'review_not_required' } });
});

// ── Criterion 3: stable identity, revision reuse and history across retries and handoffs ──

test('repeat registration reuses the document, revision and receipt; changed content adds a revision and keeps history', async () => {
    const file = writeDoc('plan.md', '# Plan v1\n\nFirst.\n');
    const first = await register(file, { deliverable: { key: 'launch-plan' } });
    expect(first.status).toBe(201);
    const docId = first.json.document.id;
    const retry = await register(file, { deliverable: { key: 'launch-plan' } });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ created: false, duplicate: true });
    expect(retry.json.document.id).toBe(docId);
    expect(retry.json.revision.id).toBe(first.json.revision.id);
    expect(retry.json.receipt.id).toBe(first.json.receipt.id);

    // A feedback round on v1 stays attached to v1.
    const review = (await api('POST', `/api/documents/${docId}/reviews`)).json.review;
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'passage', start_line: 1, end_line: 1, quote: '# Plan v1', body: 'Rename.' });

    fs.writeFileSync(file, '# Plan v2\n\nSecond.\n');
    const changed = await register(file, { deliverable: { key: 'launch-plan' } });
    expect(changed.status).toBe(200);
    expect(changed.json.document.id).toBe(docId);
    expect(changed.json.revision.id).not.toBe(first.json.revision.id);
    expect(changed.json.receipt).toMatchObject({ revision_created: true, document_created: false });

    const history = (await api('GET', `/api/documents/${docId}/history`)).json;
    expect(history.revisions.map(r => r.id)).toEqual([first.json.revision.id, changed.json.revision.id]);
    expect(history.current_revision_id).toBe(changed.json.revision.id);
    expect(history.registrations.map(r => r.id)).toEqual([first.json.receipt.id, changed.json.receipt.id]);
    expect(history.reviews).toEqual([expect.objectContaining({ id: review.id, revision_id: first.json.revision.id, comment_count: 1 })]);
    expect((await api('GET', `/api/documents/${docId}/revisions/${first.json.revision.id}`)).json.content).toBe('# Plan v1\n\nFirst.\n');
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review.comments.map(c => c.body)).toEqual(['Rename.']);
    expect((await api('GET', '/api/documents/counts')).json.counts.all).toBe(1);
});

test('the same declared identity handed from chat to task to another task stays one document, listed under each task', async () => {
    const file = writeDoc('handoff.md', '# Handoff\n');
    const chat = await register(file, { task_id: undefined, deliverable: { key: 'handoff-brief', source: { type: 'chat', conversation_id: 'conv-9' } } });
    expect(chat.status).toBe(201);
    const docId = chat.json.document.id;
    const chatRetry = await register(file, { task_id: undefined, deliverable: { key: 'handoff-brief', source: { type: 'chat', conversation_id: 'conv-9' } } });
    expect(chatRetry.json).toMatchObject({ duplicate: true, created: false });

    const taskA = await register(file, { deliverable: { key: 'handoff-brief', source: { type: 'task', execution_id: 'exec-1' } } });
    expect(taskA.status).toBe(200);
    expect(taskA.json.document).toMatchObject({ id: docId, task_id: TASK_A });
    expect(taskA.json.revision.id).toBe(chat.json.revision.id);
    expect(taskA.json.receipt).toMatchObject({ task_id: TASK_A, revision_created: false, document_created: false });

    fs.writeFileSync(file, '# Handoff\n\nRevised by task B.\n');
    const taskB = await register(file, { task_id: TASK_B, deliverable: { key: 'handoff-brief' } });
    expect(taskB.json.document).toMatchObject({ id: docId, task_id: TASK_A });
    expect(taskB.json.receipt).toMatchObject({ task_id: TASK_B, revision_created: true });

    for (const task of [TASK_A, TASK_B]) {
        const listed = (await api('GET', `/api/documents?task_id=${task}`)).json;
        expect(listed).toMatchObject({ total: 1 });
        expect(listed.documents[0].id).toBe(docId);
    }
    const history = (await api('GET', `/api/documents/${docId}/history`)).json;
    expect(history.revisions).toHaveLength(2);
    expect(history.registrations.map(r => [r.task_id, r.source?.type || null])).toEqual([[null, 'chat'], [TASK_A, 'task'], [TASK_B, null]]);
    expect((await api('GET', '/api/documents/counts')).json.counts.all).toBe(1);
});

test('without a key the canonical file is the identity; a legacy registration is adopted rather than duplicated', async () => {
    const file = writeDoc('legacy.md', '# Legacy\n');
    const legacy = await api('POST', '/api/documents', { path: file, task_id: TASK_A, title: 'Legacy report' });
    expect(legacy.status).toBe(201);
    expect(legacy.json.document).toMatchObject({ requires_review: false, intended_action: 'none', deliverable_key: null });
    const review = (await api('POST', `/api/documents/${legacy.json.document.id}/reviews`)).json.review;
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'Earlier note.' });

    const adopted = await register(file);
    expect(adopted.status).toBe(200);
    expect(adopted.json.document).toMatchObject({ id: legacy.json.document.id, requires_review: true, deliverable_key: `path:${file}` });
    expect(adopted.json.revision.id).toBe(legacy.json.revision.id);
    const viaOtherTask = await register(file, { task_id: TASK_B });
    expect(viaOtherTask.json.document.id).toBe(legacy.json.document.id);
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review.comments.map(c => c.body)).toEqual(['Earlier note.']);

    // A different declared key cannot take over a file+task slot that another identity holds.
    const clash = await register(file, { deliverable: { key: 'someone-else' } });
    expect(clash).toMatchObject({ status: 409, json: { code: 'identity_conflict' } });
    // A declared identity may move to a new file; the document follows it.
    const moved = writeDoc('moved.md', '# Moved\n');
    const keyed = await register(writeDoc('keyed.md', '# Keyed\n'), { deliverable: { key: 'moving-doc' } });
    const followed = await register(moved, { deliverable: { key: 'moving-doc' } });
    expect(followed.json.document).toMatchObject({ id: keyed.json.document.id, path: moved });
    expect((await api('GET', `/api/documents/${keyed.json.document.id}/history`)).json.revisions).toHaveLength(2);
});

// ── Criterion 4: operator-only, revision-pinned decisions; nothing else approves or sends ──

test('decisions refuse every non-operator caller, including identical replays of an accepted decision', async () => {
    const file = writeDoc('plan.md', '# Plan\n');
    const { json: { document, revision } } = await register(file);
    const deny = [
        [{ user: null }, 401, undefined],
        [{ headers: { 'x-test-service': '1' } }, 403, 'operator_required'],
        [{}, 403, 'operator_required'],
        [{ headers: { authorization: `Bearer ${RUNTIME_KEY}` } }, 403, 'operator_required'],
        [{ headers: { authorization: 'Bearer not-the-operator-credential-0000000000' } }, 403, 'operator_required'],
        [{ headers: { authorization: `Bearer ${OPERATOR_KEY}`, 'x-praxis-bridge-token': 'bridge' } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': access.token({ email: 'someone@example.test' }) } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': access.token(), 'cf-access-client-id': 'executor' } }, 403, 'operator_required'],
        [{ headers: { ...operator.headers, 'sec-fetch-site': 'cross-site' } }, 403, 'cross_site'],
    ];
    const attempt = options => decide(document.id, revision.id, 'approve', { client_decision_id: 'robert-1' }, options);
    for (const [options, status, code] of deny) {
        const response = await attempt(options);
        expect({ options, status: response.status, code: response.json.code }).toEqual({ options, status, code });
    }
    const unsigned = await attempt({});
    expect(unsigned.json.reason).toBe('assertion-missing');

    const accepted = await attempt(operator);
    expect(accepted.status).toBe(201);
    expect(accepted.json.decision).toMatchObject({ decision: 'approve', revision_id: revision.id, content_hash: revision.content_hash, actor_id: 'local_user', authority: 'operator_credential' });
    // Replaying the accepted request still needs operator authority.
    for (const [options, status] of deny) expect((await attempt(options)).status).toBe(status);
    const replay = await attempt(operator);
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true, decision: { id: accepted.json.decision.id } } });
    const reused = await decide(document.id, revision.id, 'request_changes', { client_decision_id: 'robert-1' });
    expect(reused).toMatchObject({ status: 409, json: { code: 'idempotency_key_reused' } });
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions).toHaveLength(1);

    // Unconfigured operator credential fails closed.
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    expect(await decide(document.id, revision.id, 'request_changes')).toMatchObject({ status: 503, json: { code: 'operator_credential_unconfigured' } });
});

test('a verified Access operator session (person or pinned device) can decide; the authority is recorded', async () => {
    const file = writeDoc('plan.md', '# Plan\n');
    const { json: { document, revision } } = await register(file);
    const person = await decide(document.id, revision.id, 'request_changes', { note: 'Tighten scope.' }, { headers: { 'cf-access-jwt-assertion': access.token() } });
    expect(person.status).toBe(201);
    expect(person.json.decision).toMatchObject({ decision: 'request_changes', authority: 'access_user', note: 'Tighten scope.' });
    expect(person.json.review_status).toBe('changes_requested');
    const device = await decide(document.id, revision.id, 'approve', {}, { headers: { 'cf-access-jwt-assertion': access.serviceToken() } });
    expect(device.status).toBe(201);
    expect(device.json.decision.authority).toBe('access_device');
    expect(device.json.review_status).toBe('approved');
});

test('a decision names the exact current revision; new bytes conflict and never inherit an approval', async () => {
    const file = writeDoc('plan.md', '# Plan v1\n');
    const { json: { document, revision: v1 } } = await register(file, { deliverable: { intended_action: 'send' } });
    expect((await decide(document.id, undefined)).status).toBe(400);
    expect((await decide(document.id, v1.id, 'reject')).status).toBe(400);
    expect((await decide(document.id, v1.id, 'approve', { content_hash: '0'.repeat(64) })).json.code).toBe('content_mismatch');
    const other = await register(writeDoc('other.md', '# Other\n'));
    expect((await decide(document.id, other.json.revision.id)).status).toBe(404);

    // The file changed on disk after Robert opened v1: approving v1 is a conflict, nothing is recorded.
    fs.writeFileSync(file, '# Plan v2 (new bytes)\n');
    const stale = await decide(document.id, v1.id, 'approve', { content_hash: v1.content_hash });
    expect(stale).toMatchObject({ status: 409, json: { code: 'stale_revision', revision_id: v1.id } });
    const v2 = stale.json.current_revision;
    expect(v2.id).not.toBe(v1.id);
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions).toEqual([]);

    const approved = await decide(document.id, v2.id, 'approve', { content_hash: v2.content_hash });
    expect(approved.status).toBe(201);
    expect(approved.json.decision.intended_action).toBe('send');
    const check = await api('GET', `/api/documents/${document.id}/decisions/${approved.json.decision.id}`);
    expect(check.json).toMatchObject({ in_force: true, approved: true, reason: null, revision: { id: v2.id } });
    expect(check.json.links.raw_path).toBe(`/api/documents/${document.id}/raw?revision=${v2.id}`);

    // Newer bytes invalidate the approval for the document and for a downstream sender's check.
    fs.writeFileSync(file, '# Plan v3\n');
    const reread = await api('GET', `/api/documents/${document.id}`);
    expect(reread.json.review_status).toBe('needs_review');
    expect(reread.json.current_decision).toMatchObject({ id: approved.json.decision.id, applies_to_current_revision: false });
    const after = await api('GET', `/api/documents/${document.id}/decisions/${approved.json.decision.id}`);
    expect(after.json).toMatchObject({ in_force: false, approved: false, reason: 'document_changed' });
    const later = await decide(document.id, reread.json.revision.id, 'request_changes');
    expect((await api('GET', `/api/documents/${document.id}/decisions/${approved.json.decision.id}`)).json.reason).toBe('superseded');
    expect((await api('GET', `/api/documents/${document.id}/decisions/${later.json.decision.id}`)).json).toMatchObject({ in_force: true, approved: false });
    // A missing file cannot be decided on.
    fs.rmSync(file);
    expect((await decide(document.id, reread.json.revision.id)).json).toMatchObject({ code: 'file_unavailable' });
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions.map(d => d.decision)).toEqual(['approve', 'request_changes']);
    expect(delivery.deliver).not.toHaveBeenCalled();
});

test('comments, Finish review and a QA-passed task never approve; an approval sends nothing', async () => {
    const file = writeDoc('plan.md', '# Plan\n');
    const { json: { document, revision } } = await register(file, { deliverable: { intended_action: 'send' } });
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'Looks good, approve and send it.' });
    const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Approved, send it.' });
    expect(finished.status).toBe(202);
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(finished.json.submission.id);
    await db.updateTask(TASK_A, { status: 'completed', metadata: { status_message: 'QA passed (cross-executor review)' } });

    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json).toMatchObject({ review_status: 'needs_review', current_decision: null });
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions).toEqual([]);
    expect((await api('GET', '/api/documents/counts')).json.counts).toMatchObject({ needs_review: 1, approved: 0 });

    const approved = await decide(document.id, revision.id);
    expect(approved.status).toBe(201);
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect((await db.getTask(TASK_A)).status).toBe('completed');
    expect(fs.readFileSync(file, 'utf8')).toBe('# Plan\n');
});

// ── Criterion 5: server-side filters, pagination and truthful counts past 100 documents ──

test('status filters, pagination and counts agree across 130 synthetic documents, and reference documents stay in All', async () => {
    const ids = { reference: [], review: [] };
    for (let i = 0; i < 130; i++) {
        const isReference = i % 13 < 4; // 40 reference, 90 review-required
        const file = writeDoc(`batch/doc-${String(i).padStart(3, '0')}.md`, `# Document ${i}\n`);
        const response = await register(file, {
            title: `Synthetic ${i}${i % 10 === 0 ? ' quarterly' : ''}`,
            task_id: i % 2 ? TASK_A : TASK_B,
            kind: i % 3 ? 'plan' : 'report',
            deliverable: isReference ? { requires_review: false, intended_action: 'none' } : {},
        });
        expect(response.status).toBe(201);
        (isReference ? ids.reference : ids.review).push({ id: response.json.document.id, revision: response.json.revision.id, file });
    }
    expect(ids.reference).toHaveLength(40);
    const approved = ids.review.slice(0, 25);
    const changes = ids.review.slice(25, 40);
    for (const doc of approved) expect((await decide(doc.id, doc.revision)).status).toBe(201);
    for (const doc of changes) expect((await decide(doc.id, doc.revision, 'request_changes')).status).toBe(201);
    // Five approved documents get new bytes through re-registration: they need review again.
    for (const doc of approved.slice(0, 5)) {
        fs.writeFileSync(doc.file, '# Revised\n');
        expect((await register(doc.file, { task_id: TASK_A })).json.receipt.review_status).toBe('needs_review');
    }

    const counts = (await api('GET', '/api/documents/counts')).json.counts;
    expect(counts).toEqual({ needs_review: 55, changes_requested: 15, approved: 20, reference: 40, all: 130 });

    async function collect(query, limit = 50) {
        const seen = [];
        let offset = 0;
        let total = null;
        for (;;) {
            const page = (await api('GET', `/api/documents?${query}&limit=${limit}&offset=${offset}`)).json;
            if (total === null) total = page.total;
            expect(page.total).toBe(total);
            seen.push(...page.documents);
            if (!page.has_more) break;
            offset += limit;
        }
        expect(new Set(seen.map(d => d.id)).size).toBe(seen.length);
        expect(seen.length).toBe(total);
        return seen;
    }
    const byStatus = {};
    for (const status of ['needs_review', 'changes_requested', 'approved', 'reference', 'all']) {
        byStatus[status] = await collect(`status=${status}`);
        expect(byStatus[status]).toHaveLength(counts[status]);
        if (status !== 'all') expect(byStatus[status].every(d => d.review_status === status)).toBe(true);
    }
    expect(new Set(byStatus.reference.map(d => d.id))).toEqual(new Set(ids.reference.map(d => d.id)));
    expect(byStatus.all.map(d => d.id).filter(id => ids.reference.some(r => r.id === id))).toHaveLength(40);
    // Newest first, and the default page keeps the legacy 100-item shape.
    const legacy = (await api('GET', '/api/documents')).json;
    expect(legacy).toMatchObject({ total: 130, limit: 100, offset: 0, has_more: true, status: 'all' });
    expect(legacy.documents).toHaveLength(100);
    expect(legacy.documents[0].review_path).toBe(`/documents/${legacy.documents[0].id}`);
    expect(legacy.documents.map(d => d.created_at)).toEqual([...legacy.documents.map(d => d.created_at)].sort().reverse());

    // Filters narrow list and counts identically.
    for (const query of [`task_id=${TASK_A}`, 'kind=report', 'q=quarterly', `project_id=${PROJECT_ID}&kind=plan`]) {
        const filtered = (await api('GET', `/api/documents/counts?${query}`)).json.counts;
        for (const status of ['needs_review', 'changes_requested', 'approved', 'reference', 'all']) {
            expect((await api('GET', `/api/documents?${query}&status=${status}&limit=1`)).json.total).toBe(filtered[status]);
        }
    }
    expect((await api('GET', '/api/documents/counts?q=quarterly')).json.counts.all).toBe(13);
    expect((await api('GET', `/api/documents/counts?project_id=${OTHER_PROJECT_ID}`)).json.counts.all).toBe(0);
    expect((await api('GET', '/api/documents?q=100%25')).json.total).toBe(0);
    for (const bad of ['status=pending', 'limit=0', 'limit=201', 'limit=ten', 'offset=-1', 'kind=weird', 'status=all&status=approved']) {
        expect({ bad, status: (await api('GET', `/api/documents?${bad}`)).status }).toEqual({ bad, status: 400 });
    }
});

// ── QA repair 2026-10-02: exact delivered bytes, and one consistent producer per document ──

const sha256Bytes = bytes => require('crypto').createHash('sha256').update(bytes).digest('hex');
const LF_BYTES = Buffer.from('# Brief\n\nFirst line\nSecond line\n');
const CRLF_BYTES = Buffer.from('# Brief\r\n\r\nFirst line\r\nSecond line\r\n');
const BOM_BYTES = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), LF_BYTES]);

/** The raw route's body as bytes (Response.text() would drop a BOM) and its revision header. */
async function rawBytes(rawPath) {
    const response = await nativeFetch(base + rawPath, { headers: { 'x-test-user': 'local_user' } });
    return { bytes: Buffer.from(await response.arrayBuffer()), header: response.headers.get('x-document-revision') };
}

test('expected_content_hash and the receipt bind to the exact file bytes, and raw_path serves those bytes, for CRLF and BOM files', async () => {
    const crlf = writeDoc('exact/crlf.md', CRLF_BYTES);
    const lfHashOnCrlf = await register(crlf, { expected_content_hash: sha256Bytes(LF_BYTES) });
    expect(lfHashOnCrlf.status).toBe(409);
    expect(lfHashOnCrlf.json).toMatchObject({ code: 'content_mismatch', content_hash: sha256Bytes(CRLF_BYTES) });
    expect((await api('GET', '/api/documents?q=crlf.md')).json.total).toBe(0);

    const accepted = await register(crlf, { expected_content_hash: sha256Bytes(CRLF_BYTES) });
    expect(accepted.status).toBe(201);
    expect(accepted.json.receipt).toMatchObject({ content_hash: sha256Bytes(CRLF_BYTES), byte_length: CRLF_BYTES.length });
    const servedCrlf = await rawBytes(accepted.json.receipt.raw_path);
    expect(servedCrlf.bytes.equals(CRLF_BYTES)).toBe(true);
    expect(servedCrlf.header).toBe(sha256Bytes(CRLF_BYTES));

    const bom = writeDoc('exact/bom.md', BOM_BYTES);
    const withBom = await register(bom, { expected_content_hash: sha256Bytes(BOM_BYTES) });
    expect(withBom.status).toBe(201);
    expect(withBom.json.receipt.content_hash).toBe(sha256Bytes(BOM_BYTES));
    const servedBom = await rawBytes(withBom.json.receipt.raw_path);
    expect(servedBom.bytes.equals(BOM_BYTES)).toBe(true);
    expect(servedBom.header).toBe(sha256Bytes(BOM_BYTES));
    // The reviewer keeps the normalized text it anchors comments to.
    expect((await api('GET', `/api/documents/${withBom.json.document.id}`)).json.content).toBe(LF_BYTES.toString('utf8'));
});

test('a CRLF or BOM change is a new revision: the earlier approval conflicts and stops being in force, and identical bytes reuse their revision', async () => {
    const file = writeDoc('exact/brief.md', LF_BYTES);
    const first = await register(file);
    const { document } = first.json;
    const v1 = first.json.revision;
    const approval = await decide(document.id, v1.id, 'approve', { content_hash: sha256Bytes(LF_BYTES) });
    expect(approval.status).toBe(201);

    fs.writeFileSync(file, CRLF_BYTES);
    const check = (await api('GET', `/api/documents/${document.id}/decisions/${approval.json.decision.id}`)).json;
    expect(check).toMatchObject({ approved: false, in_force: false, reason: 'document_changed' });
    const stale = await decide(document.id, v1.id, 'approve', { note: 'retry on old bytes' });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('stale_revision');
    expect(stale.json.current_revision.content_hash).toBe(sha256Bytes(CRLF_BYTES));

    const crlf = await register(file);
    expect(crlf.json).toMatchObject({ duplicate: false, receipt: { revision_created: false, review_status: 'needs_review', content_hash: sha256Bytes(CRLF_BYTES) } });
    expect(crlf.json.revision.id).not.toBe(v1.id);

    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), CRLF_BYTES]));
    const bom = await register(file);
    expect(bom.json.receipt).toMatchObject({ revision_created: true, review_status: 'needs_review' });
    const v3 = bom.json.revision;
    const approveV3 = await decide(document.id, v3.id);
    expect(approveV3.json.review_status).toBe('approved');

    fs.writeFileSync(file, CRLF_BYTES);
    const back = await register(file);
    expect(back.json.revision.id).toBe(crlf.json.revision.id);
    expect(back.json.receipt).toMatchObject({ revision_created: false, review_status: 'needs_review' });
    expect((await api('GET', `/api/documents/${document.id}/decisions/${approveV3.json.decision.id}`)).json)
        .toMatchObject({ approved: false, reason: 'document_changed' });

    const history = (await api('GET', `/api/documents/${document.id}/history`)).json;
    expect(history.revisions.map(r => r.id)).toEqual([v1.id, crlf.json.revision.id, v3.id]);
    expect(history.decisions.map(d => d.revision_id)).toEqual([v1.id, v3.id]);
    expect(delivery.deliver).not.toHaveBeenCalled();
});

test('a legacy registration keeps its line-normalized identity: a CRLF-only change stays one revision', async () => {
    const file = writeDoc('exact/legacy.md', LF_BYTES);
    const legacy = await api('POST', '/api/documents', { path: file, task_id: TASK_A });
    expect(legacy.status).toBe(201);
    fs.writeFileSync(file, CRLF_BYTES);
    const read = (await api('GET', `/api/documents/${legacy.json.document.id}`)).json;
    expect(read.revision.id).toBe(legacy.json.revision.id);
    expect(read.review_status).toBe('reference');
    expect((await api('GET', `/api/documents/${legacy.json.document.id}/history`)).json.revisions).toHaveLength(1);
    const served = await rawBytes(`/api/documents/${legacy.json.document.id}/raw`);
    expect(served.bytes.equals(LF_BYTES)).toBe(true);
    expect(served.header).toBe(sha256Bytes(LF_BYTES));
});

test('a declared identity re-registered from another project keeps its own project/task pair and is found through the receipt', async () => {
    const file = writeDoc('handoff/shared.md', '# Shared\n');
    const first = await register(file, { deliverable: { key: 'praxis:shared-brief' } });
    expect(first.status).toBe(201);
    const moved = await register(file, { project_id: OTHER_PROJECT_ID, task_id: OTHER_TASK, deliverable: { key: 'praxis:shared-brief' } });
    expect(moved.status).toBe(200);
    expect(moved.json.document).toMatchObject({ id: first.json.document.id, project_id: PROJECT_ID, task_id: TASK_A });
    expect(moved.json.receipt).toMatchObject({ project_id: OTHER_PROJECT_ID, task_id: OTHER_TASK, revision_created: false });
    expect((await db.getTask(moved.json.document.task_id)).project_id).toBe(moved.json.document.project_id);

    for (const query of [`project_id=${PROJECT_ID}&task_id=${TASK_A}`, `project_id=${OTHER_PROJECT_ID}&task_id=${OTHER_TASK}`, `project_id=${OTHER_PROJECT_ID}`]) {
        expect({ query, total: (await api('GET', `/api/documents?${query}`)).json.total }).toEqual({ query, total: 1 });
        expect({ query, all: (await api('GET', `/api/documents/counts?${query}`)).json.counts.all }).toEqual({ query, all: 1 });
    }
    const history = (await api('GET', `/api/documents/${first.json.document.id}/history`)).json;
    expect(history.registrations.map(r => [r.project_id, r.task_id])).toEqual([[PROJECT_ID, TASK_A], [OTHER_PROJECT_ID, OTHER_TASK]]);

    // A chat-era document takes its first task's project together with the task, so the pair stays consistent.
    const chatFile = writeDoc('handoff/chat.md', '# From chat\n');
    const chat = await register(chatFile, { task_id: null, deliverable: { key: 'chat:brief', source: { type: 'chat', conversation_id: 'conv-9' } } });
    expect(chat.json.document).toMatchObject({ project_id: PROJECT_ID, task_id: null });
    const adopted = await register(chatFile, { project_id: OTHER_PROJECT_ID, task_id: OTHER_TASK, deliverable: { key: 'chat:brief' } });
    expect(adopted.json.document).toMatchObject({ id: chat.json.document.id, project_id: OTHER_PROJECT_ID, task_id: OTHER_TASK });
    expect((await api('GET', `/api/documents?project_id=${PROJECT_ID}&q=chat.md`)).json.total).toBe(1);
});

// ── 2026-10-04 (task a1cc8616): Robert's Request changes refused as operator_credential_unconfigured ──
// The dashboard's shared fetch helper (dashboard/src/lib/auth.ts via nexus/shared.ts)
// sent `Authorization: Bearer local-dev-token` with every call. The authority
// consulted that header before the Access session, so a browser decision with a
// verified session was answered 503 (no operator key on the host) or 403 (a key
// provisioned), and the session itself was never inspected.
const DASHBOARD_PLACEHOLDER = { authorization: 'Bearer local-dev-token' };

test('a verified Access session decides although the dashboard attaches its placeholder bearer; the review stays pinned to the older revision', async () => {
    const file = writeDoc('brief.md', '# Brief v1\n\n| identity | documents |\n');
    const { json: { document, revision: v1 } } = await register(file, { deliverable: { intended_action: 'send' } });
    // Robert opened his review on v1 ...
    const review = (await api('POST', `/api/documents/${document.id}/reviews`, {}, { headers: DASHBOARD_PLACEHOLDER })).json.review;
    expect(review.revision_id).toBe(v1.id);
    // ... the producer rewrote the file, and he read the current revision (v2) under the changed banner.
    fs.writeFileSync(file, '# Brief v2\n\n| identity | documents |\n\nMore.\n');
    const reread = await api('GET', `/api/documents/${document.id}`, undefined, { headers: DASHBOARD_PLACEHOLDER });
    const v2 = reread.json.revision;
    expect(v2.id).not.toBe(v1.id);
    expect(reread.json.review).toMatchObject({ id: review.id, revision_id: v1.id, document_changed: true });

    const note = 'Change the "identity" column in the table below to be a summary of the documents instead of just listing what documents are available.';
    const session = { headers: { 'cf-access-jwt-assertion': access.token(), ...DASHBOARD_PLACEHOLDER } };

    // The live condition: no operator key on the host. Before the fix this answered 503 operator_credential_unconfigured.
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    const recorded = await decide(document.id, v2.id, 'request_changes', { content_hash: v2.content_hash, note, client_decision_id: 'robert-rc-1' }, session);
    expect(recorded.status).toBe(201);
    expect(recorded.json.decision).toMatchObject({ decision: 'request_changes', revision_id: v2.id, content_hash: v2.content_hash, note, authority: 'access_user', actor_id: 'local_user' });
    expect(recorded.json.review_status).toBe('changes_requested');

    // A provisioned key does not change the answer: the placeholder is not that key, and the session still decides (before the fix: 403).
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    const approved = await decide(document.id, v2.id, 'approve', { client_decision_id: 'robert-ap-1' }, session);
    expect(approved).toMatchObject({ status: 201, json: { decision: { authority: 'access_user', revision_id: v2.id } } });
    const device = await decide(document.id, v2.id, 'request_changes', { client_decision_id: 'robert-dev-1' },
        { headers: { 'cf-access-jwt-assertion': access.serviceToken(), ...DASHBOARD_PLACEHOLDER } });
    expect(device).toMatchObject({ status: 201, json: { decision: { authority: 'access_device', revision_id: v2.id } } });

    // Every decision names v2 exactly; the review and its comments stay on v1, and v1 itself can no longer be decided.
    const history = (await api('GET', `/api/documents/${document.id}/history`)).json;
    expect(history.decisions.map(d => d.revision_id)).toEqual([v2.id, v2.id, v2.id]);
    expect(history.reviews).toEqual([expect.objectContaining({ id: review.id, revision_id: v1.id })]);
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review).toMatchObject({ id: review.id, revision_id: v1.id, document_changed: true });
    expect(await decide(document.id, v1.id, 'approve', { client_decision_id: 'robert-old-1' }, session)).toMatchObject({ status: 409, json: { code: 'stale_revision', revision_id: v1.id } });
    expect(delivery.deliver).not.toHaveBeenCalled();
});

test('the placeholder bearer confers nothing by itself, every refusal survives the session-first order, and comments and Finish review never needed it', async () => {
    const file = writeDoc('plan.md', '# Plan\n');
    const { json: { document, revision } } = await register(file);
    const attempt = options => decide(document.id, revision.id, 'request_changes', { client_decision_id: 'robert-2' }, options);

    // The Mac app or an unsigned local caller with the placeholder: the bearer path, failing closed and naming what the session lacked.
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    expect(await attempt({ headers: DASHBOARD_PLACEHOLDER })).toMatchObject({ status: 503, json: { code: 'operator_credential_unconfigured', reason: 'assertion-missing' } });
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    expect(await attempt({ headers: DASHBOARD_PLACEHOLDER })).toMatchObject({ status: 403, json: { code: 'operator_required', reason: 'assertion-missing' } });

    const deny = [
        [{ headers: { ...DASHBOARD_PLACEHOLDER, 'x-test-service': '1' } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': access.token(), 'x-praxis-bridge-token': 'bridge' } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': access.token(), 'cf-access-client-id': 'executor' } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': access.token({ email: 'someone@example.test' }), ...DASHBOARD_PLACEHOLDER } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': access.serviceToken({ common_name: 'ffffffffffffffffffffffffffffffff.access' }), authorization: `Bearer ${RUNTIME_KEY}` } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': 'not.a.token', ...DASHBOARD_PLACEHOLDER } }, 403, 'operator_required'],
        [{ headers: { 'cf-access-jwt-assertion': access.token(), 'sec-fetch-site': 'cross-site' } }, 403, 'cross_site'],
    ];
    for (const [options, status, code] of deny) {
        const response = await attempt(options);
        expect({ options, status: response.status, code: response.json.code }).toEqual({ options, status, code });
    }
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions).toEqual([]);

    // Comments and Finish review are the reviewer's own feedback, not a decision: the same placeholder-carrying session saves them with no operator proof.
    const review = (await api('POST', `/api/documents/${document.id}/reviews`, {}, { headers: DASHBOARD_PLACEHOLDER })).json.review;
    const comment = await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-1', kind: 'document', body: 'Summarise the documents in the identity column.' }, { headers: DASHBOARD_PLACEHOLDER });
    expect(comment.status).toBe(201);
    const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'See the comment.' }, { headers: DASHBOARD_PLACEHOLDER });
    expect(finished.status).toBe(202);
    expect(finished.json.review).toMatchObject({ status: 'submitted', revision_id: revision.id });
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions).toEqual([]);

    // The operator credential still works on its own for a trusted tool that has no session.
    expect(await attempt(operator)).toMatchObject({ status: 201, json: { decision: { authority: 'operator_credential' } } });
});
