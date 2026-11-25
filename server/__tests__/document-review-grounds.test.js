/**
 * Review grounds (task dcc2a7be, contract docs/contracts/document-review-deliverables.md §15).
 *
 * Robert's ruling of 2026-11-25 ("go with C"): a document reaches Needs your review only when something is waiting
 * on it: an active task on its waiting-task list, an unanswered decision item on its current version, an intended
 * action of send, publish or implement, or his own request. A registration asking for review stores what it named
 * and the read returns the grounds in force; one with no ground in force is never refused, it is registered as
 * reference through the retirement record and the response says why. The Reviews list splits Needs your review by
 * ground. The one-time re-sort moves documents with nothing waiting to Reference under a named ground citing his
 * ruling, writes no decision row, and request-review puts one back.
 *
 * Isolated NEXUS_DB_PATH, blob directory and project root; synthetic tasks, chat messages and documents; delivery is a
 * stub and the operator credential a synthetic test value. Nothing here reaches the live database, Praxis or a real
 * review.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const { robertAsks } = require('./helpers/review-ground');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-grounds-0123456789';
const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
/** Produced the documents, completed. */
const SOURCE_TASK = '66666666-6666-4666-8666-66666666666a';
/** An active task that cannot proceed until Robert decides. */
const WAITER_TASK = '66666666-6666-4666-8666-66666666666b';
/** A second active task, completed during a test. */
const LATER_TASK = '66666666-6666-4666-8666-66666666666c';
/** The task that carries out the re-sort. */
const RESORT_TASK = '66666666-6666-4666-8666-66666666666d';
const V1 = '# Launch brief\n\nFirst draft of the launch plan.\n';
const V2 = '# Launch brief\n\nSecond draft of the launch plan.\n';
const DECISION_ITEMS = [{
    id: 'launch-date', question: 'Which launch date should the plan use?', recommendation: 'March 3, before the trade show',
    options: [
        { id: 'march-3', label: 'March 3', action: 'Schedule the launch for March 3' },
        { id: 'march-10', label: 'March 10', action: 'Schedule the launch for March 10' },
    ],
}];

let db;
let base;
let server;
let workspace;
let projectRoot;

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
const store = () => db.documentReviews;

function writeFile(name, content) {
    const file = path.join(projectRoot, 'docs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

/** A declared deliverable. Unlike the other suites' fixtures, nothing is named as waiting unless the test names it. */
function register(file, { key = 'launch-brief', requires_review = true, intended_action = 'none', blocking_task_ids, review_ground, metadata } = {}) {
    return api('POST', '/api/documents', {
        path: file, title: 'Launch brief', project_id: PROJECT_ID, task_id: SOURCE_TASK, kind: 'document',
        ...(metadata ? { metadata } : {}),
        deliverable: {
            key, purpose: 'Decide whether the launch plan is ready', requires_review, intended_action,
            ...(blocking_task_ids ? { blocking_task_ids } : {}), ...(review_ground !== undefined ? { review_ground } : {}),
        },
    });
}

const read = id => api('GET', `/api/documents/${id}`).then(r => { expect(r.status).toBe(200); return r.json; });
const listIds = query => api('GET', `/api/documents?${query}`).then(r => { expect(r.status).toBe(200); return r.json.documents.map(d => d.id); });
const countsOf = () => api('GET', '/api/documents/counts').then(r => { expect(r.status).toBe(200); return r.json; });

function decisionRows(documentId) {
    const raw = new Database(process.env.NEXUS_DB_PATH);
    try { return raw.prepare('SELECT id FROM review_document_decisions WHERE document_id = ?').all(documentId); } finally { raw.close(); }
}

/** A document waiting for review from before grounds existed: review requested, nothing recorded about why. */
async function legacyWaiting(name = 'legacy.md', key = 'legacy-brief') {
    const registered = await register(writeFile(name, V1), { key, requires_review: false });
    expect(registered.status).toBe(201);
    store().updateDocument(registered.json.document.id, { requires_review: true });
    expect(store().getReviewStatus(registered.json.document.id)).toBe('needs_review');
    return registered.json;
}

async function draftWithComment(documentId) {
    const opened = await api('POST', `/api/documents/${documentId}/reviews`, {});
    expect(opened.status).toBe(201);
    expect((await api('POST', `/api/documents/reviews/${opened.json.review.id}/comments`, { kind: 'document', body: 'A thought I have not sent yet.' })).status).toBe(201);
    return opened.json.review;
}

/** Praxis's receipt rule (src/documents/delivery.ts receiptFor): a reference receipt for a review declaration needs its revision-bound retirement. */
function praxisAcceptsReference(response) {
    const { receipt, retirement } = response;
    return receipt.review_status === 'reference' && receipt.requires_review === true
        && retirement?.state === 'retired' && retirement.previous?.current_revision_id === receipt.revision_id
        && retirement.previous?.requires_review === true && /^[a-zA-Z0-9_-]+$/.test(retirement.id);
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-grounds-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_REVIEW_BLOB_DIR = path.join(workspace, 'review-blobs');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Launch');
    fs.mkdirSync(projectRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'Launch plan', path: projectRoot });
    await db.createTask({ id: SOURCE_TASK, project_id: PROJECT_ID, name: 'Draft the launch brief', status: 'completed' });
    await db.createTask({ id: WAITER_TASK, project_id: PROJECT_ID, name: 'Ship the launch', status: 'in_progress' });
    await db.createTask({ id: LATER_TASK, project_id: PROJECT_ID, name: 'Book the venue', status: 'in_progress' });
    await db.createTask({ id: RESORT_TASK, project_id: PROJECT_ID, name: 'Re-sort the Reviews list', status: 'in_progress' });
    const createDocumentsRouter = require('../routes/documents');
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/documents', (req, _res, next) => {
        req.user = { id: String(req.headers['x-test-user'] || 'local_user'), role: 'admin', is_service: false };
        next();
    });
    app.use('/api/documents', createDocumentsRouter({ db, delivery: { deliver: jest.fn(async () => null) } }));
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

describe('a request for review with a ground in force lands in Needs your review, stored and read back (criterion 1)', () => {
    test('task: an active task on its waiting-task list cannot proceed until Robert decides', async () => {
        const registered = await register(writeFile('brief.md', V1), { blocking_task_ids: [WAITER_TASK], review_ground: { type: 'task', task_ids: [WAITER_TASK] } });
        expect(registered.status).toBe(201);
        expect(registered.json.review_ground).toMatchObject({
            outcome: 'waiting', held: [{ type: 'task', task_ids: [WAITER_TASK] }], rejected: [],
            in_force: [{ type: 'task', task_ids: [WAITER_TASK], tasks: [{ id: WAITER_TASK, title: 'Ship the launch', task_path: `/task/${WAITER_TASK}` }], summary: 'Task “Ship the launch” is waiting on your review.' }],
        });
        expect(registered.json.receipt.review_status).toBe('needs_review');
        expect(registered.json.retirement).toBeNull();
        const id = registered.json.document.id;
        const page = await read(id);
        expect(page.document.review_ground).toMatchObject({ grounds: [{ type: 'task', task_ids: [WAITER_TASK] }], rejected: [], registration_id: registered.json.receipt.id, revision_id: registered.json.revision.id });
        expect(page.review_grounds).toEqual([expect.objectContaining({ type: 'task', task_ids: [WAITER_TASK] })]);
        expect(page.ground_in_force).toBe(true);
        expect(page.review_status).toBe('needs_review');
        // Without task_ids the ground is the waiting-task list as declared.
        const listed = await register(writeFile('brief-2.md', V2), { key: 'brief-2', blocking_task_ids: [WAITER_TASK], review_ground: { type: 'task' } });
        expect(listed.json.review_ground).toMatchObject({ outcome: 'waiting', held: [{ type: 'task' }] });
        // Robert editing the waiting tasks of a document a task holds records no request of his: the task is the ground.
        const edited = await api('POST', `/api/documents/${id}/request-review`, { blocking_task_ids: [WAITER_TASK] });
        expect(edited.status).toBe(200);
        expect(edited.json.review_grounds.map(g => g.type)).toEqual(['task']);
        // The ground lapses with the task.
        await db.updateTask(WAITER_TASK, { status: 'completed' });
        expect((await read(id)).review_grounds).toEqual([]);
    });

    test('decision: an unanswered decision item on this version; the ground lapses once his answers are sent', async () => {
        const registered = await register(writeFile('brief.md', V1), { metadata: { decision_items: DECISION_ITEMS }, review_ground: { type: 'decision', decision_ids: ['launch-date'] } });
        expect(registered.status).toBe(201);
        expect(registered.json.review_ground).toMatchObject({
            outcome: 'waiting', held: [{ type: 'decision', decision_ids: ['launch-date'] }],
            in_force: [{ type: 'decision', source: 'declared', decision_ids: ['launch-date'], declared_count: 1, summary: '1 decision is waiting for your answer.' }],
        });
        const id = registered.json.document.id;
        expect((await read(id)).document.review_ground.grounds).toEqual([{ type: 'decision', decision_ids: ['launch-date'], registration_id: registered.json.receipt.id, recorded_at: expect.any(String) }]);
        expect(await listIds('status=needs_review&ground=in_force')).toEqual([id]);
        // His answers sent in a finished review of this version answer the decision: nothing is waiting on it now.
        store().insertReview({ document_id: id, revision_id: registered.json.revision.id, reviewer_id: 'local_user', status: 'submitted',
            decision_answers: [{ decision_id: 'launch-date', answer: 'march-3' }], submitted_at: new Date().toISOString() });
        expect((await read(id)).review_grounds).toEqual([]);
        expect(await listIds('status=needs_review&ground=none')).toEqual([id]);
        // A decision id this version does not declare does not hold.
        const unknown = await register(writeFile('other.md', V2), { key: 'other', metadata: { decision_items: DECISION_ITEMS }, review_ground: { type: 'decision', decision_ids: ['budget'] } });
        expect(unknown.json.review_ground.rejected).toEqual([{ type: 'decision', reason: 'Not declared on this version: budget' }]);
        // It still lands waiting: the declared decision is in force whatever the caller named.
        expect(unknown.json.review_ground.outcome).toBe('waiting');
    });

    test('gated action: an intended action of send, publish or implement, named or not', async () => {
        const named = await register(writeFile('post.md', V1), { key: 'post', intended_action: 'publish', review_ground: { type: 'gated_action', intended_action: 'publish' } });
        expect(named.status).toBe(201);
        expect(named.json.review_ground).toMatchObject({
            outcome: 'waiting', held: [{ type: 'gated_action', intended_action: 'publish' }],
            in_force: [{ type: 'gated_action', intended_action: 'publish', summary: 'Your approval is what allows it to be published.' }],
        });
        expect((await read(named.json.document.id)).document.review_ground.grounds).toEqual([{ type: 'gated_action', intended_action: 'publish', registration_id: named.json.receipt.id, recorded_at: expect.any(String) }]);
        // A caller that names nothing keeps working when a ground is in force.
        const unnamed = await register(writeFile('mail.md', V2), { key: 'mail', intended_action: 'send' });
        expect(unnamed.json.review_ground).toMatchObject({ outcome: 'waiting', named: [], in_force: [{ type: 'gated_action', intended_action: 'send' }] });
        expect(unnamed.json.receipt.review_status).toBe('needs_review');
        // Naming the wrong action does not hold, but the document's own action still does.
        const wrong = await register(writeFile('plan.md', V1), { key: 'plan', intended_action: 'implement', review_ground: { type: 'gated_action', intended_action: 'send' } });
        expect(wrong.json.review_ground).toMatchObject({ outcome: 'waiting', rejected: [{ type: 'gated_action', reason: 'The document’s intended action is implement, not send' }] });
    });

    test('his own request: a saved chat message of his, until he records a decision after it', async () => {
        const ask = await robertAsks(db, 'Show me the launch brief before we book anything.');
        const file = writeFile('brief.md', V1);
        const registered = await register(file, { review_ground: ask });
        expect(registered.status).toBe(201);
        expect(registered.json.review_ground).toMatchObject({
            outcome: 'waiting', held: [{ type: 'operator_request', via: 'chat', message_ref: ask.message_ref }],
            in_force: [{ type: 'operator_request', via: 'chat', message_ref: ask.message_ref, summary: 'You asked to see it in chat.' }],
        });
        const id = registered.json.document.id;
        const page = await read(id);
        expect(page.document.review_ground.grounds).toEqual([expect.objectContaining({ type: 'operator_request', via: 'chat', message_ref: ask.message_ref })]);
        expect(page.review_grounds.map(g => g.summary)).toEqual(['You asked to see it in chat.']);
        // His approval answers the request: a new version citing the same message is registered as reference, with why.
        expect((await api('POST', `/api/documents/${id}/decisions`, { decision: 'approve', revision_id: registered.json.revision.id }, operator)).status).toBe(201);
        fs.writeFileSync(file, V2);
        const later = await register(file, { review_ground: ask });
        expect(later.status).toBe(200);
        expect(later.json.review_ground.outcome).toBe('reference');
        expect(later.json.review_ground.rejected).toEqual([{ type: 'operator_request', reason: expect.stringMatching(/sent before the latest decision on this document/) }]);
        expect(later.json.retirement).toMatchObject({ action: 'retired', source: 'no_review_ground', ground: { code: 'invalid_review_ground' } });
        expect(praxisAcceptsReference(later.json)).toBe(true);
        // A request of his made since lands it in Needs your review (the same bytes, reopened by the ground).
        const again = await register(file, { review_ground: await robertAsks(db, 'Show me the second draft too.') });
        expect(again.json.review_ground.outcome).toBe('waiting');
        expect(again.json.retirement).toMatchObject({ action: 'reopened_by_ground', state: 'reopened' });
        expect(store().getReviewStatus(id)).toBe('needs_review');
    });
});

describe('a request for review with no valid ground is registered as reference, never refused (criterion 2)', () => {
    test('no review_ground field: reference with the reason, through a retirement Praxis verifies, and no decision row', async () => {
        const registered = await register(writeFile('report.md', V1));
        expect(registered.status).toBe(201);
        const { review_ground: ground, receipt, retirement } = registered.json;
        expect(ground).toMatchObject({ outcome: 'reference', named: [], held: [], rejected: [], in_force: [] });
        expect(ground.message).toMatch(/without naming anything waiting on it/);
        expect(ground.message).toMatch(/deliverable\.review_ground/);
        expect(receipt).toMatchObject({ review_status: 'reference', requires_review: true });
        expect(retirement).toMatchObject({
            action: 'retired', state: 'retired', source: 'no_review_ground', trigger: 'no_review_ground', registration_id: receipt.id, task_id: SOURCE_TASK,
            ground: { type: 'no_review_ground', code: 'no_review_ground', registration_id: receipt.id, revision_id: receipt.revision_id, rejected: [] },
            previous: { requires_review: true, review_status: 'needs_review', current_revision_id: receipt.revision_id },
        });
        expect(retirement.reason).toMatch(/^Registered as reference: registration .* asked for your review without naming anything waiting on it/);
        expect(praxisAcceptsReference(registered.json)).toBe(true);
        const id = registered.json.document.id;
        expect(decisionRows(id)).toEqual([]);
        const page = await read(id);
        expect(page).toMatchObject({ review_status: 'reference', review_grounds: [], ground_in_force: false, retirement: { id: retirement.id, state: 'retired', source: 'no_review_ground' } });
        expect(await listIds('status=needs_review')).toEqual([]);
        expect(await listIds('status=reference')).toEqual([id]);
        // The existing request-review call puts it back, as his own request.
        const back = await api('POST', `/api/documents/${id}/request-review`, {});
        expect(back.json).toMatchObject({ review_status: 'needs_review', ground_in_force: true, retirement: { action: 'reopened', reopened_via: 'request_review' } });
        expect(back.json.review_grounds).toEqual([expect.objectContaining({ type: 'operator_request', via: 'request_review', summary: 'You put it in your review queue yourself.' })]);
        expect(await listIds('status=needs_review&ground=in_force')).toEqual([id]);
        expect(decisionRows(id)).toEqual([]);
    });

    test('each named ground that does not hold is answered with its reason', async () => {
        const assistantConversation = await db.createConversation('praxis');
        const assistantMessage = await db.saveChatMessage({ conversation_id: assistantConversation.id, role: 'assistant', content: 'I will put it in your queue.' });
        const registered = await register(writeFile('report.md', V1), { review_ground: [
            { type: 'task' },
            { type: 'decision' },
            { type: 'gated_action' },
            { type: 'operator_request', message_ref: `nexus://conversation/${assistantConversation.id}/message/${assistantMessage.id}` },
            { type: 'operator_request', message_ref: 'nexus://conversation/missing/message/missing' },
            { type: 'operator_request', message_ref: 'not a reference' },
            { type: 'approve_as_ready' },
        ] });
        expect(registered.status).toBe(201);
        const { review_ground: ground, retirement } = registered.json;
        expect(ground.outcome).toBe('reference');
        expect(ground.held).toEqual([]);
        expect(ground.rejected).toEqual(expect.arrayContaining([
            { type: 'task', reason: 'No active task is on this document’s waiting-task list (deliverable.blocking_task_ids)' },
            { type: 'decision', reason: 'No decision item declared on this version is waiting for an answer' },
            { type: 'gated_action', reason: 'The document’s intended action is none, so no approval gates an action' },
            { type: 'operator_request', reason: `Message ${assistantMessage.id} is not Robert’s own message (its role is assistant)` },
            { type: 'operator_request', reason: 'No saved Nexus chat message has the reference nexus://conversation/missing/message/missing' },
            { type: 'operator_request', reason: 'An operator request cites Robert’s saved chat message as nexus://conversation/<id>/message/<id>' },
            { type: 'approve_as_ready', reason: expect.stringMatching(/^A review ground is an object whose type is one of task, decision, gated_action, operator_request/) },
        ]));
        expect(ground.rejected).toHaveLength(7);
        expect(retirement).toMatchObject({ action: 'retired', source: 'no_review_ground', ground: { code: 'invalid_review_ground' } });
        expect(retirement.reason).toMatch(/the ground it named does not hold \(.*No active task is on this document’s waiting-task list/);
        expect(praxisAcceptsReference(registered.json)).toBe(true);
        expect(decisionRows(registered.json.document.id)).toEqual([]);
        // The stored record keeps the reasons for the review page.
        expect((await read(registered.json.document.id)).document.review_ground.rejected).toHaveLength(7);
        // A waiting task that is not active does not hold either.
        const done = await register(writeFile('done.md', V2), { key: 'done', blocking_task_ids: [SOURCE_TASK], review_ground: { type: 'task', task_ids: [SOURCE_TASK] } });
        expect(done.json.review_ground).toMatchObject({ outcome: 'reference', rejected: [{ type: 'task', reason: 'None of the named tasks is an active task on this document’s waiting-task list (deliverable.blocking_task_ids)' }] });
    });

    test('a review ground needs a request for review', async () => {
        const refused = await register(writeFile('report.md', V1), { requires_review: false, review_ground: { type: 'task' } });
        expect(refused.status).toBe(400);
        expect(refused.json.error).toMatch(/needs requires_review true/);
        // A reference registration names nothing and is answered as before.
        const reference = await register(writeFile('report.md', V1), { requires_review: false });
        expect(reference.status).toBe(201);
        expect(reference.json).toMatchObject({ review_ground: null, retirement: null, receipt: { review_status: 'reference', requires_review: false } });
    });
});

describe('revisions, replays and guards', () => {
    test('a revision of a document already waiting under a recorded ground keeps it waiting, listed under the separate filter', async () => {
        const file = writeFile('brief.md', V1);
        const first = await register(file, { blocking_task_ids: [LATER_TASK], review_ground: { type: 'task' } });
        expect(first.json.review_ground.outcome).toBe('waiting');
        const id = first.json.document.id;
        await db.updateTask(LATER_TASK, { status: 'completed' });
        fs.writeFileSync(file, V2);
        const revision = await register(file, { blocking_task_ids: [LATER_TASK] });
        expect(revision.status).toBe(200);
        expect(revision.json.review_ground).toMatchObject({ outcome: 'kept_waiting', in_force: [] });
        expect(revision.json.review_ground.message).toMatch(/Tagged, nothing waiting/);
        expect(revision.json.retirement).toBeNull();
        expect(store().getReviewStatus(id)).toBe('needs_review');
        expect(await listIds('status=needs_review&ground=none')).toEqual([id]);
        expect(await listIds('status=needs_review&ground=in_force')).toEqual([]);
        // A ground in force before the revision and still in force (his request) keeps it in the default view.
        const ask = await robertAsks(db);
        const other = await register(writeFile('other.md', V1), { key: 'other', review_ground: ask });
        fs.writeFileSync(path.join(projectRoot, 'docs', 'other.md'), V2);
        const otherRevision = await register(path.join(projectRoot, 'docs', 'other.md'), { key: 'other' });
        expect(otherRevision.json.review_ground).toMatchObject({ outcome: 'waiting', in_force: [{ type: 'operator_request', via: 'chat', message_ref: ask.message_ref }] });
        expect((await read(other.json.document.id)).document.review_ground.grounds).toEqual([expect.objectContaining({ via: 'chat', message_ref: ask.message_ref })]);
    });

    test('a ground named later brings back the same bytes moved to Reference; retries and callers naming nothing leave it waiting', async () => {
        const file = writeFile('brief.md', V1);
        const first = await register(file);
        expect(first.json.review_ground.outcome).toBe('reference');
        const id = first.json.document.id;
        // A byte-identical retry returns the first receipt and stays in Reference.
        const replay = await register(file);
        expect(replay.json).toMatchObject({ duplicate: true, receipt: { id: first.json.receipt.id, review_status: 'reference' }, review_ground: { outcome: 'reference' }, retirement: { action: 'kept', id: first.json.retirement.id } });
        expect(praxisAcceptsReference(replay.json)).toBe(true);
        expect(store().listRetirements(id)).toHaveLength(1);
        // The same bytes with a ground that holds are back in the queue, the retirement recorded as reopened.
        const grounded = await register(file, { blocking_task_ids: [WAITER_TASK], review_ground: { type: 'task' } });
        expect(grounded.json.review_ground).toMatchObject({ outcome: 'waiting', held: [{ type: 'task' }] });
        expect(grounded.json.retirement).toMatchObject({ action: 'reopened_by_ground', id: first.json.retirement.id, state: 'reopened', reopened_via: 'registration' });
        expect(store().getReviewStatus(id)).toBe('needs_review');
        // Retrying the grounded registration returns its receipt and changes nothing.
        const retried = await register(file, { blocking_task_ids: [WAITER_TASK], review_ground: { type: 'task' } });
        expect(retried.json).toMatchObject({ duplicate: true, receipt: { id: grounded.json.receipt.id }, review_ground: { outcome: 'waiting' } });
        // A caller that names nothing registers the same bytes again (a new registration: the document's waiting-task
        // list is part of the declaration). Nothing moves and the ground it is waiting under stays recorded.
        const unnamed = await register(file);
        expect(unnamed.json.duplicate).toBe(false);
        expect(unnamed.json.review_ground).toMatchObject({ outcome: 'waiting', named: [], in_force: [{ type: 'task', task_ids: [WAITER_TASK] }] });
        expect((await read(id)).document.review_ground).toMatchObject({ grounds: [{ type: 'task', registration_id: grounded.json.receipt.id }], registration_id: grounded.json.receipt.id });
        expect(store().listRetirements(id)).toHaveLength(1);
        expect(decisionRows(id)).toEqual([]);
    });

    test('a ground recorded before the document last left the queue does not keep a later revision waiting', async () => {
        const file = writeFile('brief.md', V1);
        const first = await register(file, { blocking_task_ids: [LATER_TASK], review_ground: { type: 'task' } });
        const id = first.json.document.id;
        expect(first.json.review_ground.outcome).toBe('waiting');
        // The task finishes and the document moves to Reference.
        await db.updateTask(LATER_TASK, { status: 'completed' });
        expect(store().retireOnGround({ target: store().getDocument(id), ground: { type: 'review_resort', message_ref: 'nexus://conversation/c/message/m', task_id: RESORT_TASK, finding: 'Nothing waits on it.' } })).toMatchObject({ trigger: 'review_resort' });
        // A draft comment of Robert's keeps the next revision waiting, with nothing in force.
        const draft = await draftWithComment(id);
        fs.writeFileSync(file, V2);
        const guarded = await register(file, { blocking_task_ids: [LATER_TASK] });
        expect(guarded.json.review_ground).toMatchObject({ outcome: 'left_waiting', reasons: [{ code: 'draft_comments' }] });
        // The task ground recorded before the move is still in the record but no longer places it in the queue: once
        // the draft comment is gone, the next revision with nothing named moves it to Reference.
        expect((await read(id)).document.review_ground.grounds).toEqual([expect.objectContaining({ type: 'task', registration_id: first.json.receipt.id })]);
        const comments = store().listComments(draft.id);
        for (const comment of comments) expect((await api('DELETE', `/api/documents/reviews/${draft.id}/comments/${comment.id}`)).status).toBe(200);
        fs.writeFileSync(file, '# Launch brief\n\nThird draft of the launch plan.\n');
        const third = await register(file, { blocking_task_ids: [LATER_TASK] });
        expect(third.json.review_ground.outcome).toBe('reference');
        expect(third.json.retirement).toMatchObject({ action: 'retired', source: 'no_review_ground' });
        expect(praxisAcceptsReference(third.json)).toBe(true);
    });

    test('a guard keeps an ungrounded document waiting and the response says why; one without a guard moves on its next registration', async () => {
        const guarded = await legacyWaiting('guarded.md', 'guarded');
        await draftWithComment(guarded.document.id);
        fs.writeFileSync(path.join(projectRoot, 'docs', 'guarded.md'), V2);
        const revision = await register(path.join(projectRoot, 'docs', 'guarded.md'), { key: 'guarded' });
        expect(revision.json.review_ground).toMatchObject({ outcome: 'left_waiting', reasons: [{ code: 'draft_comments' }] });
        expect(revision.json.review_ground.message).toMatch(/stays in Needs your review because It has review work not yet submitted/);
        expect(store().getReviewStatus(guarded.document.id)).toBe('needs_review');
        expect(store().listRetirements(guarded.document.id)).toEqual([]);
        const plain = await legacyWaiting('plain.md', 'plain');
        fs.writeFileSync(path.join(projectRoot, 'docs', 'plain.md'), V2);
        const moved = await register(path.join(projectRoot, 'docs', 'plain.md'), { key: 'plain' });
        expect(moved.json.review_ground.outcome).toBe('reference');
        expect(praxisAcceptsReference(moved.json)).toBe(true);
    });
});

describe('the Reviews list splits Needs your review by ground (criterion 3, the API side)', () => {
    test('ground=in_force and ground=none, their counts, each row saying what is waiting, and refusals', async () => {
        const grounded = await register(writeFile('grounded.md', V1), { key: 'grounded', blocking_task_ids: [WAITER_TASK], review_ground: { type: 'task' } });
        const tagged = await legacyWaiting('tagged.md', 'tagged');
        const reference = await register(writeFile('reference.md', V2), { key: 'reference', requires_review: false });
        expect(await listIds('status=needs_review&ground=in_force')).toEqual([grounded.json.document.id]);
        expect(await listIds('status=needs_review&ground=none')).toEqual([tagged.document.id]);
        expect((await listIds('status=needs_review')).sort()).toEqual([grounded.json.document.id, tagged.document.id].sort());
        const page = await api('GET', '/api/documents?status=needs_review&ground=in_force');
        expect(page.json).toMatchObject({ status: 'needs_review', ground: 'in_force', total: 1 });
        const [row] = page.json.documents;
        expect(row).toMatchObject({ ground_in_force: true, review_grounds: [{ type: 'task', task_ids: [WAITER_TASK], summary: 'Task “Ship the launch” is waiting on your review.' }] });
        for (const flag of ['ground_task', 'ground_decision', 'ground_action', 'ground_request']) expect(row).not.toHaveProperty(flag);
        const none = await api('GET', '/api/documents?status=needs_review&ground=none');
        expect(none.json.documents[0]).toMatchObject({ id: tagged.document.id, ground_in_force: false, review_grounds: [] });
        const all = await api('GET', '/api/documents?status=all');
        expect(all.json.ground).toBeNull();
        expect(all.json.documents.find(d => d.id === reference.json.document.id)).toMatchObject({ review_grounds: [], ground_in_force: false });
        const counts = await countsOf();
        expect(counts.counts).toMatchObject({ needs_review: 2, reference: 1 });
        expect(counts.grounds).toEqual({ needs_review: { in_force: 1, none: 1 } });
        for (const query of ['ground=in_force', 'status=approved&ground=none', 'status=all&ground=in_force', 'status=needs_review&ground=everything']) {
            const refused = await api('GET', `/api/documents?${query}`);
            expect(refused.status).toBe(400);
            expect(refused.json.code).toBe('invalid_query');
        }
    });
});

describe('the one-time re-sort ground (criterion 4)', () => {
    const RULING = 'nexus://conversation/a821fe1e-4d76-4a3f-82e1-8872be4ac289/message/8f6068f1-bbe7-4200-b59c-9d9bebf27469';
    const resortGround = finding => ({ type: 'review_resort', message_ref: RULING, task_id: RESORT_TASK, finding });

    test('moves a document with nothing waiting to Reference citing his ruling, with no decision row; request-review puts it back; a replay never moves it again', async () => {
        const waiting = await legacyWaiting();
        const id = waiting.document.id;
        expect(await listIds('status=needs_review&ground=none')).toEqual([id]);
        const rt = store().retireOnGround({ target: store().getDocument(id), ground: resortGround('A finished report with no decision in it.') });
        expect(rt).toMatchObject({ trigger: 'review_resort', task_id: RESORT_TASK, registration_id: null, replaced_by_document_id: null,
            ground: { type: 'review_resort', message_ref: RULING, finding: 'A finished report with no decision in it.' },
            previous: { requires_review: true, review_status: 'needs_review', list_bucket: 'needs_review', current_revision_id: waiting.revision.id } });
        expect(decisionRows(id)).toEqual([]);
        const page = await read(id);
        expect(page).toMatchObject({ review_status: 'reference', retirement: { source: 'review_resort', state: 'retired', task_id: RESORT_TASK } });
        expect(page.retirement.reason).toBe(`Re-sorted to Reference under your ruling (${RULING}): nothing was waiting on it. A finished report with no decision in it.`);
        expect(await listIds('status=needs_review')).toEqual([]);
        // One call puts it back, into the default view, as his own request.
        const back = await api('POST', `/api/documents/${id}/request-review`, {});
        expect(back.status).toBe(200);
        expect(back.json).toMatchObject({ review_status: 'needs_review', ground_in_force: true, retirement: { action: 'reopened', id: rt.id, reopened_via: 'request_review', source: 'review_resort' } });
        expect(await listIds('status=needs_review&ground=in_force')).toEqual([id]);
        expect((await read(id)).retirement).toBeNull();
        // The re-sort run again cannot move it a second time: the ruling is cited once per document.
        expect(store().retireOnGround({ target: store().getDocument(id), ground: resortGround('Again.') })).toBeNull();
        expect(store().getReviewStatus(id)).toBe('needs_review');
        expect(store().listRetirements(id)).toHaveLength(1);
        expect(decisionRows(id)).toEqual([]);
        // A later registration naming a ground also reopens a re-sorted document carrying the same bytes.
        const other = await legacyWaiting('other.md', 'other');
        store().retireOnGround({ target: store().getDocument(other.document.id), ground: resortGround('Nothing waits on it.') });
        const named = await register(path.join(projectRoot, 'docs', 'other.md'), { key: 'other', review_ground: await robertAsks(db) });
        expect(named.json).toMatchObject({ review_ground: { outcome: 'waiting' }, retirement: { action: 'reopened_by_ground', source: 'review_resort' } });
    });

    test('a put-back by the request-review of code from before recorded requests counts as his request until he decides', async () => {
        const putBackAsBefore = (id, via) => store().transaction(() => {
            // What the request-review route did before review grounds: back in the queue and the retirement reopened,
            // with no request recorded in the ground record (the live API runs that code until it restarts).
            store().updateDocument(id, { requires_review: true });
            return store().reopenRetirement(id, 'local_user', via);
        });
        const waiting = await legacyWaiting();
        const id = waiting.document.id;
        const rt = store().retireOnGround({ target: store().getDocument(id), ground: resortGround('Nothing waits on it.') });
        expect(putBackAsBefore(id, 'request_review')).toMatchObject({ id: rt.id, reopened_via: 'request_review' });
        expect(store().getDocument(id).review_ground).toBeNull();
        expect(store().getDocumentListRow(id)).toMatchObject({ ground_request: true, ground_in_force: true });
        expect(await listIds('status=needs_review&ground=in_force')).toEqual([id]);
        expect(await listIds('status=needs_review&ground=none')).toEqual([]);
        expect((await countsOf()).grounds).toEqual({ needs_review: { in_force: 1, none: 0 } });
        const page = await read(id);
        expect(page.review_grounds).toEqual([{ type: 'operator_request', via: 'request_review', requested_at: store().listRetirements(id)[0].reopened_at,
            requested_by: 'local_user', retirement_id: rt.id, summary: 'You put it in your review queue yourself.' }]);
        // Asking again on the current code names the request once.
        expect((await api('POST', `/api/documents/${id}/request-review`, {})).status).toBe(200);
        expect((await read(id)).review_grounds.map(g => g.via)).toEqual(['request_review']);
        // His decision after it answers the request, as it does a recorded one.
        expect((await api('POST', `/api/documents/${id}/decisions`, { decision: 'approve', revision_id: waiting.revision.id }, operator)).status).toBe(201);
        expect(store().getDocumentListRow(id)).toMatchObject({ ground_request: false, ground_in_force: false, review_status: 'approved' });
        expect(decisionRows(id)).toHaveLength(1);
        // A retirement reopened by a registration is not his request.
        const other = await legacyWaiting('other.md', 'other');
        store().retireOnGround({ target: store().getDocument(other.document.id), ground: resortGround('Nothing waits on it.') });
        expect(putBackAsBefore(other.document.id, 'registration')).toMatchObject({ reopened_via: 'registration' });
        expect(store().getDocumentListRow(other.document.id)).toMatchObject({ ground_request: false, ground_in_force: false });
        expect(await listIds('status=needs_review&ground=none')).toEqual([other.document.id]);
    });

    test('a decision the re-sort records from the brief keeps the document in the default view until Robert decides', async () => {
        const groundRecord = require('../services/document-review-grounds');
        const recordDecision = (id, revisionId, question) => store().transaction(() => groundRecord.writeGroundRecord(store(), id, { actorId: 'review_resort', add: [{
            type: 'decision', source: 'review_resort', revision_id: revisionId, question, recommendation: 'Send it today.',
            options: [{ label: 'Approve it', action: 'The page is cleared to go out' }], ruling: RULING, task_id: RESORT_TASK,
        }] }));
        const waiting = await legacyWaiting();
        const id = waiting.document.id;
        recordDecision(id, waiting.revision.id, 'Is the page ready to send?');
        expect(await listIds('status=needs_review&ground=in_force')).toEqual([id]);
        expect((await read(id)).review_grounds).toEqual([expect.objectContaining({
            type: 'decision', source: 'review_resort', question: 'Is the page ready to send?', recommendation: 'Send it today.', ruling: RULING,
            summary: 'A decision is waiting for your answer: Is the page ready to send?',
        })]);
        expect(decisionRows(id)).toEqual([]);
        // It was asked of that version: a new version naming nothing stays waiting under the recorded ground, listed
        // under the separate filter until something is waiting on the new version.
        fs.writeFileSync(path.join(projectRoot, 'docs', 'legacy.md'), V2);
        const revision = await register(path.join(projectRoot, 'docs', 'legacy.md'), { key: 'legacy-brief' });
        expect(revision.json.review_ground.outcome).toBe('kept_waiting');
        expect(await listIds('status=needs_review&ground=none')).toEqual([id]);
        // Robert's decision answers it.
        const other = await legacyWaiting('other.md', 'other');
        recordDecision(other.document.id, other.revision.id, 'Should the run go ahead?');
        expect(store().getDocumentListRow(other.document.id)).toMatchObject({ ground_decision: true, ground_in_force: true });
        expect((await api('POST', `/api/documents/${other.document.id}/decisions`, { decision: 'approve', revision_id: other.revision.id }, operator)).status).toBe(201);
        expect(store().getDocumentListRow(other.document.id)).toMatchObject({ ground_decision: false, ground_in_force: false, review_status: 'approved' });
    });

    test('a guarded document is not moved, and an incomplete citation moves nothing', async () => {
        const guarded = await legacyWaiting('guarded.md', 'guarded');
        await draftWithComment(guarded.document.id);
        expect(store().retireOnGround({ target: store().getDocument(guarded.document.id), ground: resortGround('Nothing waits on it.') })).toBeNull();
        expect(store().getReviewStatus(guarded.document.id)).toBe('needs_review');
        const plain = await legacyWaiting('plain.md', 'plain');
        for (const ground of [
            { ...resortGround('x'), message_ref: 'chat says so' },
            { ...resortGround('x'), task_id: '' },
            { ...resortGround(''), finding: '' },
        ]) expect(store().retireOnGround({ target: store().getDocument(plain.document.id), ground })).toBeNull();
        expect(store().listRetirements(plain.document.id)).toEqual([]);
        expect(store().getReviewStatus(plain.document.id)).toBe('needs_review');
    });

    test('a retirement table from before these grounds is rebuilt once to take them, keeping its records and order', async () => {
        const waiting = await legacyWaiting();
        const raw = new Database(process.env.NEXUS_DB_PATH);
        try {
            // The table, indexes and triggers as the previous release (a5463aed) created them: its CHECK and citation
            // index name only the grounds that existed then.
            const citation = "CASE trigger WHEN 'chat_ruling' THEN json_extract(ground, '$.message_ref') WHEN 'purpose_changed' THEN json_extract(ground, '$.registration_id') WHEN 'revision_task_cancelled' THEN json_extract(ground, '$.replacement_id') END";
            const nowIso = new Date().toISOString();
            raw.exec(`DROP TABLE review_document_retirements;
                CREATE TABLE review_document_retirements (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
                    replaced_by_document_id TEXT,
                    replaced_by_revision_id TEXT,
                    supersession_id TEXT,
                    registration_id TEXT,
                    task_id TEXT,
                    named_by TEXT,
                    named_value TEXT,
                    trigger TEXT NOT NULL CHECK (trigger IN ('registration', 'review_requested', 'ready', 'chat_ruling', 'purpose_changed', 'revision_task_cancelled')),
                    retired_by TEXT NOT NULL,
                    retired_at TEXT NOT NULL,
                    previous TEXT NOT NULL,
                    reopened_at TEXT,
                    reopened_by TEXT,
                    reopened_via TEXT CHECK (reopened_via IS NULL OR reopened_via IN ('request_review', 'registration')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    ground TEXT,
                    CHECK (CASE WHEN trigger IN ('registration', 'review_requested', 'ready')
                        THEN ground IS NULL AND replaced_by_document_id IS NOT NULL AND supersession_id IS NOT NULL AND named_by IS NOT NULL AND named_value IS NOT NULL
                        ELSE ground IS NOT NULL AND json_extract(ground, '$.type') IS trigger AND (${citation}) IS NOT NULL
                        END)
                );
                CREATE UNIQUE INDEX idx_review_document_retirements_open ON review_document_retirements(document_id) WHERE reopened_at IS NULL;
                CREATE INDEX idx_review_document_retirements_document ON review_document_retirements(document_id, retired_at);
                CREATE INDEX idx_review_document_retirements_replaced_by ON review_document_retirements(replaced_by_document_id);
                CREATE UNIQUE INDEX idx_review_document_retirements_ground ON review_document_retirements(document_id, trigger, (${citation})) WHERE ground IS NOT NULL;
                CREATE TRIGGER review_document_retirements_immutable
                    BEFORE UPDATE OF id, document_id, replaced_by_document_id, replaced_by_revision_id, supersession_id, registration_id,
                        task_id, named_by, named_value, trigger, retired_by, retired_at, previous, created_at, ground
                    ON review_document_retirements
                    BEGIN SELECT RAISE(ABORT, 'a retirement record is immutable; only its reopening is recorded'); END;
                CREATE TRIGGER review_document_retirements_reopen_once
                    BEFORE UPDATE OF reopened_at, reopened_by, reopened_via ON review_document_retirements
                    WHEN OLD.reopened_at IS NOT NULL
                    BEGIN SELECT RAISE(ABORT, 'a retirement is reopened once'); END;`);
            raw.prepare(`INSERT INTO review_document_retirements (id, document_id, trigger, retired_by, retired_at, previous, created_at, updated_at, ground, reopened_at, reopened_by, reopened_via)
                VALUES ('old-chat', ?, 'chat_ruling', 'praxis', ?, '{"requires_review":true}', ?, ?, ?, ?, 'Robert', 'request_review')`)
                .run(waiting.document.id, nowIso, nowIso, nowIso, JSON.stringify({ type: 'chat_ruling', message_ref: RULING, answers: [{ decision_id: 'a', answer: 'b', message_ref: RULING }] }), nowIso);
            expect(() => raw.prepare(`INSERT INTO review_document_retirements (id, document_id, trigger, retired_by, retired_at, previous, created_at, updated_at, ground)
                VALUES ('new', ?, 'review_resort', 'praxis', ?, '{}', ?, ?, ?)`).run(waiting.document.id, nowIso, nowIso, nowIso, JSON.stringify(resortGround('x')))).toThrow(/CHECK/);
        } finally { raw.close(); }
        const { initializeDocumentRetirements } = require('../../db/document-retirements');
        const migrate = new Database(process.env.NEXUS_DB_PATH);
        try {
            initializeDocumentRetirements(migrate);
            initializeDocumentRetirements(migrate);
            expect(migrate.prepare('SELECT id, trigger, reopened_via FROM review_document_retirements').all()).toEqual([{ id: 'old-chat', trigger: 'chat_ruling', reopened_via: 'request_review' }]);
        } finally { migrate.close(); }
        const rt = store().retireOnGround({ target: store().getDocument(waiting.document.id), ground: resortGround('Nothing waits on it.') });
        expect(rt).toMatchObject({ trigger: 'review_resort' });
        expect(store().listRetirements(waiting.document.id).map(r => r.id)).toEqual([rt.id, 'old-chat']);
    });
});
