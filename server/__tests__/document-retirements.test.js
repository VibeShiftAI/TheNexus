/**
 * Retiring a review document when its replacement is registered (task
 * d9f46e2f, contract docs/contracts/document-review-deliverables.md §13).
 *
 * A registration, plain or declared, names the waiting documents it replaces
 * by document id, deliverable key or exact path. Robert's ruling (2026-11-19,
 * option A): the names apply only once the replacing document is itself
 * waiting for his review and ready to view; until then they are pending. A
 * retired document moves to Reference with no decision recorded and its
 * intended action untouched, records what replaced it, and comes back with the
 * existing request-review call. Guards keep a named document waiting and say
 * why. Nothing is ever matched by title, project or age.
 *
 * Isolated NEXUS_DB_PATH, blob directory and project root; synthetic tasks,
 * documents and fixtures; delivery is a stub and the operator credential a
 * synthetic test value. Nothing here reaches the live database, Praxis or a
 * real review.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-retirements-0123456789';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-33333333333b';
/** Produced the original brief, completed. */
const OLD_TASK = '44444444-4444-4444-8444-44444444444a';
/** Produced the replacement brief, completed. */
const NEW_TASK = '44444444-4444-4444-8444-44444444444b';
/** An active task waiting on a document. */
const WAITER_TASK = '44444444-4444-4444-8444-44444444444c';
/** A completed task listed as waiting: inactive, so it does not hold a document. */
const DONE_TASK = '44444444-4444-4444-8444-44444444444d';
/** A task in another project (the modular template replaced documents across projects). */
const OTHER_TASK = '44444444-4444-4444-8444-44444444444e';
const V1 = '# Launch brief\n\nFirst draft of the launch plan.\n';
const V2 = '# Launch brief\n\nSecond draft: the launch plan, rewritten.\n';
const REASON_CODES = reasons => reasons.map(r => r.code).sort();

let db;
let base;
let server;
let workspace;
let projectRoot;
let otherRoot;
let delivery;

async function api(method, url, body, { user = 'local_user', headers = {} } = {}) {
    const response = await nativeFetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': user, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, json: type.includes('application/json') ? await response.json() : await response.text() };
}

const operator = { headers: { authorization: `Bearer ${OPERATOR_KEY}` } };

function writeFile(name, content, root = projectRoot) {
    const file = path.join(root, 'docs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

/** A declared deliverable (the producer's registration, with its receipt). */
function register(file, { key, task_id = OLD_TASK, project_id = PROJECT_ID, title = 'Launch brief', requires_review = true, intended_action = 'none', blocking_task_ids, replaces } = {}) {
    return api('POST', '/api/documents', {
        path: file, title, project_id, task_id, kind: 'document',
        deliverable: {
            purpose: 'Decide whether the launch plan is ready', requires_review, intended_action,
            ...(key ? { key } : {}), ...(blocking_task_ids ? { blocking_task_ids } : {}),
        },
        ...(replaces !== undefined ? { replaces } : {}),
    });
}

/** A plain registration (no deliverable block): never requests review by itself. */
const plain = (file, extra = {}) => api('POST', '/api/documents', { path: file, ...extra });
const read = id => api('GET', `/api/documents/${id}`).then(r => { expect(r.status).toBe(200); return r.json; });
const counts = () => api('GET', '/api/documents/counts').then(r => r.json.counts);
const listIds = status => api('GET', `/api/documents?status=${status}&limit=100`).then(r => r.json.documents.map(d => d.id));
const requestReview = (id, body = {}) => api('POST', `/api/documents/${id}/request-review`, body);
const store = () => db.documentReviews;

/** A waiting document from the original task. */
async function original(name = 'brief-v1.md', options = {}) {
    const registered = await register(writeFile(name, V1), { key: 'launch-brief-v1', ...options });
    expect(registered.status).toBe(201);
    return registered.json;
}

/** The replacement, from its own task, naming what it replaces. */
async function replacement(replaces, { name = 'brief-v2.md', content = V2, ...options } = {}) {
    const registered = await register(writeFile(name, content), { key: 'launch-brief-v2', task_id: NEW_TASK, replaces, ...options });
    expect([200, 201]).toContain(registered.status);
    return registered.json;
}

function rawDb() {
    return new Database(process.env.NEXUS_DB_PATH);
}

function decisionRows(documentId) {
    const raw = rawDb();
    try { return raw.prepare('SELECT * FROM review_document_decisions WHERE document_id = ?').all(documentId); } finally { raw.close(); }
}

async function draftWithComment(documentId, user = 'local_user', body = 'A thought I have not sent yet.') {
    const opened = await api('POST', `/api/documents/${documentId}/reviews`, {}, { user });
    expect(opened.status).toBe(201);
    expect((await api('POST', `/api/documents/reviews/${opened.json.review.id}/comments`, { kind: 'document', body }, { user })).status).toBe(201);
    return opened.json.review;
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-retirements-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_REVIEW_BLOB_DIR = path.join(workspace, 'review-blobs');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Launch');
    otherRoot = path.join(workspace, 'Template');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(otherRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'Launch plan', path: projectRoot });
    await db.upsertProject({ id: OTHER_PROJECT_ID, name: 'Modular template', path: otherRoot });
    await db.createTask({ id: OLD_TASK, project_id: PROJECT_ID, name: 'Draft the launch brief', status: 'completed' });
    await db.createTask({ id: NEW_TASK, project_id: PROJECT_ID, name: 'Rewrite the launch brief', status: 'completed' });
    await db.createTask({ id: WAITER_TASK, project_id: PROJECT_ID, name: 'Ship the launch', status: 'in_progress' });
    await db.createTask({ id: DONE_TASK, project_id: PROJECT_ID, name: 'Book the venue', status: 'completed' });
    await db.createTask({ id: OTHER_TASK, project_id: OTHER_PROJECT_ID, name: 'Build the modular template', status: 'completed' });
    delivery = { deliver: jest.fn(async () => null) };
    const createDocumentsRouter = require('../routes/documents');
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/documents', (req, _res, next) => {
        req.user = { id: String(req.headers['x-test-user'] || 'local_user'), role: 'admin', is_service: false };
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
    jest.restoreAllMocks();
    delete process.env.NEXUS_DB_PATH;
    delete process.env.NEXUS_REVIEW_BLOB_DIR;
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

describe('a replacement that is waiting for review and ready retires what it names', () => {
    test('the named document leaves Needs your review for Reference in the same registration, and the counts follow (criterion 1)', async () => {
        const old = await original();
        expect(await counts()).toMatchObject({ needs_review: 1, reference: 0 });

        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        expect(next.replaces).toHaveLength(1);
        expect(next.replaces[0]).toMatchObject({
            source: 'registration', named_as: { deliverable_key: 'launch-brief-v1' }, outcome: 'retired', reasons: [],
            target: { document_id: old.document.id, title: 'Launch brief', review_status: 'reference', review_path: `/documents/${old.document.id}` },
            registration_id: next.receipt.id, task_id: NEW_TASK, retirement: { state: 'retired', trigger: 'registration' },
        });
        // Same operation: the old document is already in Reference when the registration answers.
        expect(store().getDocument(old.document.id).requires_review).toBe(false);
        expect(await counts()).toMatchObject({ needs_review: 1, reference: 1, changes_requested: 0 });
        expect(await listIds('needs_review')).toEqual([next.document.id]);
        expect(await listIds('reference')).toEqual([old.document.id]);
    });

    test('the record says what replaced it, when, by which registration and task; no decision is recorded and the intended action is not carried out (criterion 2)', async () => {
        const old = await original('brief-v1.md', { intended_action: 'send' });
        const before = new Date().toISOString();
        const next = await replacement([{ document_id: old.document.id }]);
        const page = await read(old.document.id);
        expect(page.review_status).toBe('reference');
        expect(page.current_decision).toBeNull();
        expect(page.retirement).toMatchObject({
            source: 'replacement', state: 'retired', trigger: 'registration',
            replaced_by: { document_id: next.document.id, exists: true, review_path: `/documents/${next.document.id}` },
            replaced_by_revision_id: next.revision.id, registration_id: next.receipt.id, task_id: NEW_TASK,
            task_path: `/task/${NEW_TASK}`, named_as: { document_id: old.document.id }, retired_by: 'local_user',
            previous: { requires_review: true, review_status: 'needs_review', list_bucket: 'needs_review', intended_action: 'send', blocking_task_ids: [], current_revision_id: old.revision.id },
            reopened_at: null,
        });
        expect(page.retirement.retired_at >= before).toBe(true);
        expect(page.retirement.reason).toMatch(/without a decision: nothing was approved, no changes were requested and its intended action was not carried out/);
        // No approval, change request or other decision; nothing delivered; no outgoing message; the declaration is untouched.
        expect(decisionRows(old.document.id)).toEqual([]);
        expect(delivery.deliver).not.toHaveBeenCalled();
        expect(page.outgoing).toBeNull();
        expect(page.document.intended_action).toBe('send');
        // And a retired document takes no decision, so its action can never start from it.
        const refused = await api('POST', `/api/documents/${old.document.id}/decisions`, { decision: 'approve', revision_id: old.revision.id }, operator);
        expect(refused).toMatchObject({ status: 409, json: { code: 'review_not_required' } });
        expect(decisionRows(old.document.id)).toEqual([]);
    });

    test('the retired page links to what replaced it and the replacing page lists what it retired (criterion 3)', async () => {
        const old = await original();
        const next = await replacement([{ path: path.join(projectRoot, 'docs', 'brief-v1.md') }]);
        const retiredPage = await read(old.document.id);
        expect(retiredPage.retirement.replaced_by).toEqual({ document_id: next.document.id, title: 'Launch brief', exists: true, review_path: `/documents/${next.document.id}`, review_status: 'needs_review' });
        expect(retiredPage.retirement_history).toHaveLength(1);
        expect(retiredPage.replaces).toEqual([]);
        const replacingPage = await read(next.document.id);
        expect(replacingPage.retirement).toBeNull();
        expect(replacingPage.replaces).toEqual([expect.objectContaining({
            outcome: 'retired', named_as: { path: path.join(projectRoot, 'docs', 'brief-v1.md') },
            target: expect.objectContaining({ document_id: old.document.id, review_path: `/documents/${old.document.id}`, review_status: 'reference' }),
            retirement: expect.objectContaining({ state: 'retired' }),
        })]);
    });

    test('a document in another project is retired by exact name (the modular template case), never by project', async () => {
        const old = await original();
        const template = await register(writeFile('template.md', '# Modular template\n', otherRoot), {
            key: 'modular-template', task_id: OTHER_TASK, project_id: OTHER_PROJECT_ID, title: 'Modular template', replaces: [{ document_id: old.document.id }],
        });
        expect(template.status).toBe(201);
        expect(template.json.replaces[0]).toMatchObject({ outcome: 'retired', target: { document_id: old.document.id } });
    });

    test('a changes-requested document is retired too, and its earlier state is recorded', async () => {
        const old = await original();
        const decided = await api('POST', `/api/documents/${old.document.id}/decisions`, { decision: 'request_changes', revision_id: old.revision.id, note: 'Rework the plan.' }, operator);
        expect(decided.status).toBe(201);
        expect(await counts()).toMatchObject({ changes_requested: 1 });
        await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        const page = await read(old.document.id);
        expect(page.retirement.previous).toMatchObject({ review_status: 'changes_requested', list_bucket: 'changes_requested' });
        expect(await counts()).toMatchObject({ changes_requested: 0, needs_review: 1, reference: 1 });
        // The change request stays exactly as it was: retiring adds no decision.
        expect(decisionRows(old.document.id).map(d => d.decision)).toEqual(['request_changes']);
    });
});

describe('guards leave a named document waiting and say why, to the caller and on the replacing page (criterion 4)', () => {
    async function expectLeftWaiting(old, next, codes) {
        expect(next.replaces[0]).toMatchObject({ outcome: 'left_waiting', target: { document_id: old.document.id } });
        expect(REASON_CODES(next.replaces[0].reasons)).toEqual([...codes].sort());
        for (const r of next.replaces[0].reasons) expect(r.message).toEqual(expect.any(String));
        expect(store().getDocument(old.document.id).requires_review).toBe(true);
        expect(store().findOpenRetirement(old.document.id)).toBeNull();
        const replacingPage = await read(next.document.id);
        expect(replacingPage.replaces[0]).toMatchObject({ outcome: 'left_waiting', reasons: next.replaces[0].reasons });
        // The named document's own page says who named it and why it stayed.
        const namedPage = await read(old.document.id);
        expect(namedPage.retirement).toBeNull();
        expect(namedPage.named_as_replaced).toEqual([expect.objectContaining({
            outcome: 'left_waiting', reasons: next.replaces[0].reasons,
            replacing: expect.objectContaining({ document_id: next.document.id, review_path: `/documents/${next.document.id}` }),
        })]);
        return replacingPage;
    }

    test('unsubmitted draft comments', async () => {
        const old = await original();
        await draftWithComment(old.document.id);
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        await expectLeftWaiting(old, next, ['draft_comments']);
        expect(next.replaces[0].reasons[0].message).toMatch(/1 comment in 1 draft/);
        // The draft and its comment are untouched.
        expect(store().listUnsubmittedDrafts(old.document.id)).toHaveLength(1);
    });

    test('an empty draft (opened, nothing written) does not hold a document', async () => {
        const old = await original();
        expect((await api('POST', `/api/documents/${old.document.id}/reviews`, {})).status).toBe(201);
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        expect(next.replaces[0].outcome).toBe('retired');
    });

    test('active waiting tasks (a completed waiting task does not hold it)', async () => {
        const old = await original('brief-v1.md', { blocking_task_ids: [WAITER_TASK, DONE_TASK] });
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        await expectLeftWaiting(old, next, ['waiting_tasks']);
        expect(next.replaces[0].reasons[0]).toMatchObject({ task_ids: [WAITER_TASK] });
        expect(next.replaces[0].reasons[0].message).toMatch(/Ship the launch/);
    });

    test('an outgoing message that is not sent (a sent one does not hold it)', async () => {
        const old = await original('brief-v1.md', { intended_action: 'send' });
        const raw = rawDb();
        const insert = status => raw.prepare(`INSERT OR REPLACE INTO review_document_outgoing (document_id, delivery_id, revision_id, content_hash, envelope_hash, envelope, provenance, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(old.document.id, `delivery-${status}`, old.revision.id, old.revision.content_hash, 'e'.repeat(64),
            JSON.stringify({ subject: 'Synthetic', text: 'Synthetic' }), JSON.stringify({ project_id: PROJECT_ID, task_id: OLD_TASK }), status, new Date().toISOString(), new Date().toISOString());
        try {
            insert('draft');
            const next = await replacement([{ document_id: old.document.id }]);
            await expectLeftWaiting(old, next, ['outgoing_unsent']);
            expect(next.replaces[0].reasons[0]).toMatchObject({ outgoing_status: 'draft' });
            insert('sent');
        } finally { raw.close(); }
        // Named again by a later registration once the message is sent: nothing holds it now.
        const again = await replacement([{ document_id: old.document.id }]);
        expect(again.replaces[0].outcome).toBe('retired');
        expect(store().getOutgoing(old.document.id).status).toBe('sent');
    });

    test('open replacement work', async () => {
        const old = await original();
        store().insertReplacement({ document_id: old.document.id, base_revision_id: old.revision.id, client_request_id: 'synthetic-req-1', task_id: WAITER_TASK, state: 'accepted', accepted_by: 'local_user' });
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        await expectLeftWaiting(old, next, ['replacement_in_progress']);
        expect(next.replaces[0].reasons[0]).toMatchObject({ replacement_state: 'accepted', task_id: WAITER_TASK });
    });

    test("an agent's review waiting for Robert's choices", async () => {
        const old = await original();
        const raw = rawDb();
        try {
            raw.prepare('INSERT INTO document_agent_reviews (id, document_id, client_request_id, data) VALUES (?, ?, ?, ?)')
                .run('agent-review-1', old.document.id, 'synthetic-agent-1', JSON.stringify({ id: 'agent-review-1', status: 'submitted', base_revision_id: old.revision.id }));
        } finally { raw.close(); }
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        await expectLeftWaiting(old, next, ['agent_review_waiting']);
    });

    test('every reason is listed when several apply', async () => {
        const old = await original('brief-v1.md', { blocking_task_ids: [WAITER_TASK] });
        await draftWithComment(old.document.id);
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        await expectLeftWaiting(old, next, ['draft_comments', 'waiting_tasks']);
    });

    test('a document left waiting is retired when a later registration names it again after the reason clears', async () => {
        const old = await original('brief-v1.md', { blocking_task_ids: [WAITER_TASK] });
        const first = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        expect(first.replaces[0].outcome).toBe('left_waiting');
        // Lists and counts do not retire a left-waiting name on their own.
        await db.updateTask(WAITER_TASK, { status: 'completed' });
        expect(await counts()).toMatchObject({ needs_review: 2 });
        expect(store().getDocument(old.document.id).requires_review).toBe(true);
        const second = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        expect(second.duplicate).toBe(true);
        expect(second.replaces[0]).toMatchObject({ outcome: 'retired', reasons: [] });
        expect(await counts()).toMatchObject({ needs_review: 1, reference: 1 });
    });
});

describe('the existing request-review call reopens a retired document (criterion 5)', () => {
    test('it returns to its earlier state: requires review, its waiting tasks and its change request', async () => {
        const old = await original('brief-v1.md', { blocking_task_ids: [DONE_TASK] });
        expect((await api('POST', `/api/documents/${old.document.id}/decisions`, { decision: 'request_changes', revision_id: old.revision.id, note: 'Rework.' }, operator)).status).toBe(201);
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        expect(next.replaces[0].outcome).toBe('retired');
        expect(await counts()).toMatchObject({ changes_requested: 0, reference: 1 });

        const reopened = await requestReview(old.document.id);
        expect(reopened.status).toBe(200);
        expect(reopened.json).toMatchObject({
            review_status: 'changes_requested',
            document: { requires_review: true, blocking_task_ids: [DONE_TASK], intended_action: 'none' },
            retirement: { action: 'reopened', state: 'reopened', reopened_by: 'local_user', reopened_via: 'request_review', replaced_by: { document_id: next.document.id } },
        });
        expect(await counts()).toMatchObject({ changes_requested: 1, needs_review: 1, reference: 0 });
        const page = await read(old.document.id);
        expect(page.retirement).toBeNull();
        expect(page.retirement_history).toEqual([expect.objectContaining({ state: 'reopened', reopened_via: 'request_review', previous: expect.objectContaining({ review_status: 'changes_requested' }) })]);
        expect(page.current_decision).toMatchObject({ decision: 'request_changes' });
        expect(decisionRows(old.document.id)).toHaveLength(1);

        // A retired name is final: naming it again does not retire it a second time behind Robert's back.
        const again = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        expect(again.replaces[0]).toMatchObject({ outcome: 'retired', retirement: { state: 'reopened' } });
        expect(store().getDocument(old.document.id).requires_review).toBe(true);
        expect(await counts()).toMatchObject({ changes_requested: 1 });
    });

    test('a replay of the retired document\'s own registration keeps it in Reference; new bytes for review bring it back', async () => {
        const old = await original();
        await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        const file = path.join(projectRoot, 'docs', 'brief-v1.md');
        const replay = await register(file, { key: 'launch-brief-v1' });
        expect(replay.status).toBe(200);
        expect(replay.json.retirement).toMatchObject({ action: 'kept', state: 'retired' });
        expect(replay.json.document.requires_review).toBe(false);
        expect(await counts()).toMatchObject({ needs_review: 1, reference: 1 });

        fs.writeFileSync(file, `${V1}\nA new section added later.\n`);
        const revised = await register(file, { key: 'launch-brief-v1' });
        expect(revised.json.retirement).toMatchObject({ action: 'reopened_by_registration', state: 'reopened', reopened_via: 'registration' });
        expect(revised.json.document.requires_review).toBe(true);
        expect(await counts()).toMatchObject({ needs_review: 2, reference: 0 });
    });
});

describe('names that retire nothing are reported, and the registration still succeeds (criterion 6)', () => {
    test('missing, out of the queue, the document itself, and an ambiguous path', async () => {
        const reference = await plain(writeFile('notes.md', '# Notes\n'), { task_id: OLD_TASK });
        expect(reference.status).toBe(201);
        const approved = await register(writeFile('approved.md', '# Approved plan\n'), { key: 'approved-plan' });
        expect((await api('POST', `/api/documents/${approved.json.document.id}/decisions`, { decision: 'approve', revision_id: approved.json.revision.id }, operator)).status).toBe(201);
        const shared = writeFile('shared.md', '# Shared\n');
        expect((await plain(shared, { task_id: OLD_TASK })).status).toBe(201);
        expect((await plain(shared, { task_id: WAITER_TASK })).status).toBe(201);
        const missingPath = path.join(projectRoot, 'docs', 'never-registered.md');

        const next = await register(writeFile('brief-v2.md', V2), {
            key: 'launch-brief-v2', task_id: NEW_TASK,
            replaces: [
                { document_id: '00000000-0000-4000-8000-000000000000' }, { deliverable_key: 'no-such-key' }, { path: missingPath },
                { document_id: reference.json.document.id }, { deliverable_key: 'approved-plan' },
                { deliverable_key: 'launch-brief-v2' }, { path: shared },
            ],
        });
        expect(next.status).toBe(201);
        const outcomes = next.json.replaces.map(r => [Object.keys(r.named_as)[0], r.outcome]);
        expect(outcomes).toEqual([
            ['document_id', 'not_found'], ['deliverable_key', 'not_found'], ['path', 'not_found'],
            ['document_id', 'not_waiting'], ['deliverable_key', 'not_waiting'],
            ['deliverable_key', 'self'], ['path', 'ambiguous'],
        ]);
        const byOutcome = Object.fromEntries(next.json.replaces.map(r => [`${Object.keys(r.named_as)[0]}:${r.outcome}`, r]));
        expect(byOutcome['document_id:not_waiting'].reasons[0].code).toBe('reference');
        expect(byOutcome['deliverable_key:not_waiting'].reasons[0].code).toBe('approved');
        expect(byOutcome['path:ambiguous'].candidates).toHaveLength(2);
        expect(next.json.replaces.every(r => r.reasons.length === 1 && r.reasons[0].message)).toBe(true);
        expect(store().getDocument(reference.json.document.id).requires_review).toBe(false);
        expect(store().getReviewStatus(approved.json.document.id)).toBe('approved');
        expect(store().listRetirements(approved.json.document.id)).toEqual([]);
    });

    test('a document already retired by another replacement is reported as not waiting', async () => {
        const old = await original();
        await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        const third = await register(writeFile('brief-v3.md', '# Launch brief\n\nThird draft.\n'), { key: 'launch-brief-v3', task_id: NEW_TASK, replaces: [{ document_id: old.document.id }] });
        expect(third.json.replaces[0]).toMatchObject({ outcome: 'not_waiting', reasons: [{ code: 'already_retired' }] });
        expect(store().listRetirements(old.document.id)).toHaveLength(1);
    });

    test('a malformed replaces list is refused before anything is registered', async () => {
        for (const replaces of [{ document_id: 'x' }, [{ title: 'Launch brief' }], [{ document_id: 'a', deliverable_key: 'b' }], [{ path: 'relative/brief.md' }], [{ document_id: '' }]]) {
            const refused = await register(writeFile('brief-v2.md', V2), { key: 'launch-brief-v2', task_id: NEW_TASK, replaces });
            expect(refused).toMatchObject({ status: 400, json: { code: 'invalid_replaces' } });
            const refusedPlain = await plain(writeFile('plain.md', '# Plain\n'), { replaces });
            expect(refusedPlain).toMatchObject({ status: 400, json: { code: 'invalid_replaces' } });
        }
        expect(store().findDocumentByKey('launch-brief-v2')).toBeNull();
        expect(await counts()).toMatchObject({ needs_review: 0, reference: 0 });
    });
});

describe('the manual closes of 2026-11-18/19 read in the same form (criterion 7)', () => {
    test('a review_closed stamp shows its reason and replacement on the review page, and the replacing page lists it', async () => {
        const old = await original();
        const next = await replacement([]);
        const stamp = {
            at: '2026-11-18T21:04:00.000Z', by: 'praxis-claude-code:manual-close',
            reason: 'Superseded by the rewritten launch brief; closed by hand without review. Not an approval.',
            previous: { requires_review: true, intended_action: 'none' }, superseded_by: next.document.id,
        };
        // Fixture: the shape the manual closes wrote (requires_review cleared, the stamp in metadata).
        store().updateDocument(old.document.id, { requires_review: false, metadata: { ...(old.document.metadata || {}), review_closed: stamp } });

        const page = await read(old.document.id);
        expect(page.retirement).toEqual(expect.objectContaining({
            source: 'manual', state: 'retired', retired_at: stamp.at, retired_by: stamp.by, reason: stamp.reason, trigger: 'manual',
            replaced_by: { document_id: next.document.id, title: 'Launch brief', exists: true, review_path: `/documents/${next.document.id}`, review_status: 'needs_review' },
            previous: stamp.previous,
        }));
        // Same keys as a registration's retirement, so the page renders both alike.
        const registered = await original('other-v1.md', { key: 'other-v1' });
        await register(writeFile('other-v2.md', '# Other\n\nv2\n'), { key: 'other-v2', task_id: NEW_TASK, replaces: [{ deliverable_key: 'other-v1' }] });
        expect(Object.keys(page.retirement).sort()).toEqual(Object.keys((await read(registered.document.id)).retirement).sort());

        const replacingPage = await read(next.document.id);
        expect(replacingPage.replaces).toEqual([expect.objectContaining({
            source: 'manual', outcome: 'retired', target: expect.objectContaining({ document_id: old.document.id, review_path: `/documents/${old.document.id}` }),
            retirement: expect.objectContaining({ state: 'retired', trigger: 'manual', reason: stamp.reason }),
        })]);

        // Reopened with the same request-review call; the stamp is kept as history, never rewritten.
        expect((await requestReview(old.document.id)).status).toBe(200);
        const reopened = await read(old.document.id);
        expect(reopened.retirement).toBeNull();
        expect(reopened.retirement_history).toEqual([expect.objectContaining({ source: 'manual', state: 'reopened' })]);
        expect(reopened.document.metadata.review_closed).toEqual(stamp);
    });

    test('a stamp without a replacement shows its reason with no link', async () => {
        const old = await original();
        store().updateDocument(old.document.id, { requires_review: false, metadata: { review_closed: { at: '2026-11-19T09:00:00.000Z', by: 'operator', reason: 'Closed by hand: obsolete.' } } });
        const page = await read(old.document.id);
        expect(page.retirement).toMatchObject({ source: 'manual', reason: 'Closed by hand: obsolete.', replaced_by: null });
    });
});

describe('the rule: exact names only, and only once the replacement waits for review and is ready (criterion 8, Robert\'s ruling)', () => {
    test('nothing is retired on title, project or age similarity', async () => {
        const old = await original();
        // Same title, same project, same task lineage, registered later, a successor in every human sense, but it names nothing.
        const later = await register(writeFile('brief-final.md', V2), { key: 'launch-brief-final', task_id: NEW_TASK });
        expect(later.status).toBe(201);
        expect(later.json.replaces).toEqual([]);
        expect(store().getDocument(old.document.id).requires_review).toBe(true);
        expect(await counts()).toMatchObject({ needs_review: 2, reference: 0 });
        // Naming by title is not a form the API accepts.
        expect(await register(writeFile('brief-final.md', V2), { key: 'launch-brief-final', task_id: NEW_TASK, replaces: [{ title: 'Launch brief' }] }))
            .toMatchObject({ status: 400, json: { code: 'invalid_replaces' } });
    });

    test('a reference-only registration never retires anything; its names stay pending', async () => {
        const old = await original();
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }], { requires_review: false });
        expect(next.replaces[0]).toMatchObject({ outcome: 'pending', target: { document_id: old.document.id }, reasons: [{ code: 'replacement_not_in_queue' }] });
        expect(next.replaces[0].reasons[0].message).toMatch(/not waiting for your review/);
        // Lists and counts re-check pending names and still retire nothing.
        expect(await counts()).toMatchObject({ needs_review: 1, reference: 1 });
        expect(store().getDocument(old.document.id).requires_review).toBe(true);
        const namedPage = await read(old.document.id);
        expect(namedPage.named_as_replaced).toEqual([expect.objectContaining({ outcome: 'pending', replacing: expect.objectContaining({ document_id: next.document.id }) })]);
    });

    test('a plain registration names what it replaces; the names apply when review of it is requested', async () => {
        const old = await original();
        const plainNext = await plain(writeFile('brief-v2.md', V2), { task_id: NEW_TASK, title: 'Launch brief', replaces: [{ deliverable_key: 'launch-brief-v1' }] });
        expect(plainNext.status).toBe(201);
        expect(plainNext.json.replaces[0]).toMatchObject({ outcome: 'pending', registration_id: null, task_id: NEW_TASK, reasons: [{ code: 'replacement_not_in_queue' }] });
        expect(store().getDocument(old.document.id).requires_review).toBe(true);

        const requested = await requestReview(plainNext.json.document.id);
        expect(requested.status).toBe(200);
        expect(requested.json.retirement).toBeNull();
        expect(requested.json.replaces[0]).toMatchObject({ outcome: 'retired', retirement: { trigger: 'review_requested' } });
        expect(await counts()).toMatchObject({ needs_review: 1, reference: 1 });
        expect((await read(old.document.id)).retirement).toMatchObject({ trigger: 'review_requested', registration_id: null, task_id: NEW_TASK });
    });

    test('a visual replacement that is not ready to view keeps its names pending', async () => {
        const old = await original();
        // Bytes with an image extension that no browser can decode: registered, but not ready to view.
        const image = writeFile('launch-board.png', 'not really a png, just text');
        const registered = await register(image, { key: 'launch-board', task_id: NEW_TASK, title: 'Launch board', replaces: [{ deliverable_key: 'launch-brief-v1' }] });
        expect(registered.status).toBe(201);
        expect(registered.json.replaces[0]).toMatchObject({ outcome: 'pending', reasons: [{ code: 'replacement_not_ready', gate: 'revision_not_ready' }] });
        expect(registered.json.replaces[0].reasons[0].message).toMatch(/not ready to view yet \(0\/1 required assets servable\)/);
        expect(await counts()).toMatchObject({ needs_review: 2 });
        expect(store().getDocument(old.document.id).requires_review).toBe(true);
    });

    test('pending names apply on the next list or count read once the replacement waits for review', async () => {
        const old = await original();
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }], { requires_review: false });
        expect(next.replaces[0].outcome).toBe('pending');
        // Fixture: the replacing document enters the queue by a path that is not a registration or review request here.
        store().updateDocument(next.document.id, { requires_review: true });
        expect(await counts()).toMatchObject({ needs_review: 1, reference: 1 });
        expect(store().getDocument(old.document.id).requires_review).toBe(false);
        expect((await read(old.document.id)).retirement).toMatchObject({ trigger: 'ready', replaced_by: { document_id: next.document.id } });
    });
});

describe('the store: retirement records and the rule underneath the route (criterion 8)', () => {
    function doc(fields = {}) {
        const id = fields.id || require('crypto').randomUUID();
        return store().insertDocument({
            id, title: 'Launch brief', path: path.join(projectRoot, 'docs', `${id}.md`), project_id: PROJECT_ID, task_id: OLD_TASK,
            registered_by: 'test', requires_review: true, ...fields,
        });
    }
    const declare = (successor, named_by, named_value) => store().declareSupersession({ document_id: successor.id, named_by, named_value, declared_by: 'test', task_id: NEW_TASK });

    test('retirementCheck judges only the named document\'s own state', () => {
        const waiting = doc();
        expect(store().retirementCheck(waiting)).toMatchObject({ outcome: 'retirable', bucket: 'needs_review' });
        expect(store().retirementCheck(doc({ requires_review: false }))).toMatchObject({ outcome: 'not_waiting', reasons: [{ code: 'reference' }] });
        const held = doc({ blocking_task_ids: [WAITER_TASK] });
        expect(store().retirementCheck(held)).toMatchObject({ outcome: 'left_waiting', reasons: [{ code: 'waiting_tasks', task_ids: [WAITER_TASK] }] });
    });

    test('retireDocument clears only requires_review, records the previous state and writes no decision', () => {
        const target = doc({ blocking_task_ids: [DONE_TASK], intended_action: 'publish', deliverable_key: 'store-v1' });
        const successor = doc({ task_id: NEW_TASK });
        const name = declare(successor, 'deliverable_key', 'store-v1');
        const check = store().retirementCheck(target);
        const rt = store().retireDocument({ target, successor, supersession: name, trigger: 'registration', bucket: check.bucket });
        expect(rt).toMatchObject({ document_id: target.id, replaced_by_document_id: successor.id, supersession_id: name.id, task_id: NEW_TASK, named_by: 'deliverable_key', named_value: 'store-v1', trigger: 'registration', retired_by: 'test', reopened_at: null });
        expect(rt.previous).toEqual({ requires_review: true, review_status: 'needs_review', list_bucket: 'needs_review', blocking_task_ids: [DONE_TASK], intended_action: 'publish', current_revision_id: null });
        const after = store().getDocument(target.id);
        expect(after).toMatchObject({ requires_review: false, blocking_task_ids: [DONE_TASK], intended_action: 'publish' });
        expect(store().getSupersession(name.id)).toMatchObject({ outcome: 'retired', retirement_id: rt.id, target_document_id: target.id });
        expect(decisionRows(target.id)).toEqual([]);
        // One retirement in force per document.
        expect(() => store().retireDocument({ target, successor, supersession: name, trigger: 'registration', bucket: 'needs_review' })).toThrow(/UNIQUE/);
    });

    test('the record is immutable and its reopening is written once', () => {
        const target = doc();
        const successor = doc();
        const rt = store().retireDocument({ target, successor, supersession: declare(successor, 'document_id', target.id), trigger: 'ready', bucket: 'needs_review' });
        const raw = rawDb();
        try {
            expect(() => raw.prepare('UPDATE review_document_retirements SET retired_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', rt.id)).toThrow(/immutable/);
            expect(() => raw.prepare('UPDATE review_document_retirements SET previous = ? WHERE id = ?').run('{}', rt.id)).toThrow(/immutable/);
            expect(store().reopenRetirement(target.id, 'robert', 'request_review')).toMatchObject({ reopened_by: 'robert', reopened_via: 'request_review' });
            expect(() => raw.prepare('UPDATE review_document_retirements SET reopened_by = ? WHERE id = ?').run('someone-else', rt.id)).toThrow(/reopened once/);
        } finally { raw.close(); }
        expect(store().reopenRetirement(target.id, 'robert')).toBeNull();
        expect(store().listRetirements(target.id)).toHaveLength(1);
    });

    test('declaring a name again resets it to pending, except a retired name, which is final', () => {
        const successor = doc();
        const first = declare(successor, 'deliverable_key', 'gone');
        store().settleSupersession(first.id, { outcome: 'not_found', reasons: [{ code: 'not_found', message: 'none' }] });
        expect(declare(successor, 'deliverable_key', 'gone')).toMatchObject({ id: first.id, outcome: 'pending', reasons: [] });
        expect(() => store().settleSupersession(first.id, { outcome: 'retired' })).toThrow(/cannot settle/);
        const target = doc();
        const name = declare(successor, 'document_id', target.id);
        store().retireDocument({ target, successor, supersession: name, trigger: 'registration', bucket: 'needs_review' });
        store().reopenRetirement(target.id, 'robert');
        expect(declare(successor, 'document_id', target.id)).toMatchObject({ id: name.id, outcome: 'retired' });
        expect(store().settleSupersession(name.id, { outcome: 'pending' })).toMatchObject({ outcome: 'retired' });
        expect(store().listPendingSuccessorIds()).toEqual([successor.id]);
    });

    test('paths match exactly (one document per task), and manual closes are found by their superseded_by', () => {
        const shared = path.join(projectRoot, 'docs', 'shared.md');
        const a = doc({ path: shared, task_id: OLD_TASK });
        const b = doc({ path: shared, task_id: NEW_TASK });
        expect(store().findDocumentsByPath(shared).map(d => d.id).sort()).toEqual([a.id, b.id].sort());
        expect(store().findDocumentsByPath(`${shared}x`)).toEqual([]);
        const closed = doc({ requires_review: false, metadata: { review_closed: { at: '2026-11-19T00:00:00.000Z', superseded_by: a.id } } });
        expect(store().listManualClosesReplacedBy(a.id).map(d => d.id)).toEqual([closed.id]);
        expect(store().listManualClosesReplacedBy(b.id)).toEqual([]);
    });
});

describe('review repairs (code-review gate, 2026-11-19)', () => {
    test('new bytes a page read captured after the retirement still bring the document back when registered for review', async () => {
        const old = await original();
        await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        const file = path.join(projectRoot, 'docs', 'brief-v1.md');
        fs.writeFileSync(file, `${V1}\nRevised after it was retired.\n`);
        // Opening the retired page captures the new bytes as its current revision.
        const page = await read(old.document.id);
        expect(page.revision.id).not.toBe(old.revision.id);
        expect(page.retirement).toMatchObject({ state: 'retired' });
        const revised = await register(file, { key: 'launch-brief-v1' });
        expect(revised.json.retirement).toMatchObject({ action: 'reopened_by_registration', reopened_via: 'registration' });
        expect(revised.json.document.requires_review).toBe(true);
    });

    test('a new version at the same path under a new task retires the old one by path, not ambiguous', async () => {
        const shared = writeFile('brief.md', V1);
        const old = await register(shared, { key: 'launch-brief-v1' });
        expect(old.status).toBe(201);
        fs.writeFileSync(shared, V2);
        const next = await register(shared, { key: 'launch-brief-v2', task_id: NEW_TASK, replaces: [{ path: shared }] });
        expect(next.status).toBe(201);
        expect(next.json.document.id).not.toBe(old.json.document.id);
        expect(next.json.replaces[0]).toMatchObject({ outcome: 'retired', target: { document_id: old.json.document.id }, candidates: [] });
        // A path that only the replacing document holds names itself.
        const alone = await register(writeFile('alone.md', '# Alone\n'), { key: 'alone', task_id: NEW_TASK, replaces: [{ path: path.join(projectRoot, 'docs', 'alone.md') }] });
        expect(alone.json.replaces[0]).toMatchObject({ outcome: 'self' });
    });

    test('a reference document listed In progress by replacement work is not waiting; a failed attempt is worded as such', async () => {
        const reference = await register(writeFile('ref.md', '# Reference notes\n'), { key: 'ref-notes', requires_review: false });
        store().insertReplacement({ document_id: reference.json.document.id, base_revision_id: reference.json.revision.id, client_request_id: 'synthetic-ref-1', task_id: WAITER_TASK, state: 'running', accepted_by: 'local_user' });
        const failedOld = await original();
        store().insertReplacement({ document_id: failedOld.document.id, base_revision_id: failedOld.revision.id, result_revision_id: failedOld.revision.id, client_request_id: 'synthetic-failed-1', task_id: WAITER_TASK, state: 'failed', accepted_by: 'local_user' });
        const next = await replacement([{ deliverable_key: 'ref-notes' }, { deliverable_key: 'launch-brief-v1' }]);
        expect(next.replaces[0]).toMatchObject({ outcome: 'not_waiting', reasons: [{ code: 'reference' }] });
        expect(next.replaces[1]).toMatchObject({ outcome: 'left_waiting', reasons: [{ code: 'replacement_failed', replacement_state: 'failed' }] });
        expect(next.replaces[1].reasons[0].message).toMatch(/came from replacement work that failed .*until a recovery delivers a new version/);
    });

    test('a draft holding only a summary is named as such, not as zero comments', async () => {
        const old = await original();
        const opened = await api('POST', `/api/documents/${old.document.id}/reviews`, {});
        expect((await api('PATCH', `/api/documents/reviews/${opened.json.review.id}`, { summary: 'Half-written overall note.' })).status).toBe(200);
        const next = await replacement([{ deliverable_key: 'launch-brief-v1' }]);
        expect(next.replaces[0]).toMatchObject({ outcome: 'left_waiting', reasons: [{ code: 'draft_comments', comment_count: 0 }] });
        expect(next.replaces[0].reasons[0].message).toMatch(/\(a summary in 1 draft\)/);
        expect(next.replaces[0].reasons[0].message).not.toMatch(/0 comments/);
    });
});
