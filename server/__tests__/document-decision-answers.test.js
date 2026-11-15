/**
 * Structured document decisions answered in the viewer (task 50aa5747; the
 * contract is Praxis/docs/document-decisions.md): Robert answers each declared
 * decision on his draft round, Finish review sends the answers as
 * feedback.decision_answers in the canonical submission, and Praxis is told
 * through the identifier-only document.review_submitted event.
 *
 * Isolated NEXUS_DB_PATH and temporary project roots. The Praxis relay is a
 * stub inside the real delivery worker, the Cloudflare Access signing keys are
 * a local fixture and the credentials are synthetic: nothing here reaches the
 * live database, Praxis or Cloudflare.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const access = require('./helpers/operator-access');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-0123456789abcdef';
const DOCUMENT_KEY = 'document-executor-test-credential-0123456789';
const RUNTIME_KEY = 'runtime-test-credential-0123456789abcdefgh';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_A = '22222222-2222-4222-8222-22222222222a';

/** Robert's proofs and the callers that are not Robert. */
const operator = { headers: { authorization: `Bearer ${OPERATOR_KEY}` } };
const session = { headers: { 'cf-access-jwt-assertion': access.token() } };
const executorCredential = { headers: { authorization: `Bearer ${DOCUMENT_KEY}` } };
const runtime = { headers: { authorization: `Bearer ${RUNTIME_KEY}` } };
const unsigned = {};

const ITEMS = [
    {
        id: 'rollout', question: 'Which rollout should begin?', recommendation: 'Begin the pilot.',
        options: [{ id: 'pilot', label: 'Pilot', action: 'Prepare the pilot task.' }, { id: 'hold', label: 'Hold', action: 'Keep rollout on hold.' }],
    },
    {
        id: 'wording', question: 'Does the launch note change?', recommendation: 'Keep it as written.',
        options: [
            { id: 'keep', label: 'Keep as written', action: 'Leave the document exactly as it is; do not edit, publish or send it.' },
            { id: 'revise', label: 'Revise', action: 'Revise the launch note.' },
        ],
    },
    { id: 'budget', question: 'What budget cap applies to the pilot?', recommendation: 'Cap it at 5,000 USD.', action: 'Record the cap in the pilot plan.' },
];

let db;
let base;
let server;
let workspace;
let projectRoot;
let relay;
let worker;
let restoreAccess;

async function api(method, url, body, { user = 'local_user', headers = {} } = {}) {
    const all = { ...headers };
    if (body !== undefined) all['content-type'] = 'application/json';
    if (user) all['x-test-user'] = user;
    const response = await nativeFetch(base + url, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, json: type.includes('application/json') ? await response.json() : await response.text() };
}

function writeDoc(name, content) {
    const file = path.join(projectRoot, 'docs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function register(file, { metadata, title = 'Launch plan', kind = 'plan' } = {}) {
    return api('POST', '/api/documents', {
        path: file, title, project_id: PROJECT_ID, task_id: TASK_A, kind,
        ...(metadata ? { metadata } : {}),
        deliverable: { purpose: 'Decide the launch', requires_review: true, intended_action: 'implement' },
    });
}

async function openReview(documentId, revisionId) {
    const opened = await api('POST', `/api/documents/${documentId}/reviews`, revisionId ? { revision_id: revisionId } : {});
    expect([200, 201]).toContain(opened.status);
    return opened.json.review;
}

function answer(reviewId, decisionId, value, revisionId, options = operator, extra = {}) {
    return api('PUT', `/api/documents/reviews/${reviewId}/decision-answers/${decisionId}`, { answer: value, revision_id: revisionId, ...extra }, options);
}

function finish(reviewId, body = {}, options = operator) {
    return api('POST', `/api/documents/reviews/${reviewId}/finish`, body, options);
}

async function readReview(reviewId) {
    return (await api('GET', `/api/documents/reviews/${reviewId}`)).json.review;
}

async function fullSubmission(reviewId) {
    return (await api('GET', `/api/documents/reviews/${reviewId}/submission?full=1`)).json.submission;
}

/** Wait for the finish route's fire-and-forget delivery to land. */
async function settle() {
    for (let i = 0; i < 50 && !relay.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setImmediate(resolve));
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-decision-answers-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = DOCUMENT_KEY;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = RUNTIME_KEY;
    restoreAccess = access.configure({ deviceIds: access.deviceId });
    global.fetch = jest.fn(async (url, init) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks }
        : nativeFetch(url, init)));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Praxis');
    fs.mkdirSync(projectRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'Praxis', path: projectRoot });
    await db.createTask({ id: TASK_A, project_id: PROJECT_ID, name: 'Draft the launch plan', status: 'in_progress' });
    // The real outbox with a stub relay: what Praxis would receive, and how often.
    relay = jest.fn(async event => ({ ...event, status: 'received', received_at: new Date().toISOString() }));
    const { createDocumentReviewDelivery } = require('../services/document-review-delivery');
    worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0, log: { log() {}, warn() {}, error() {} } });
    const createDocumentsRouter = require('../routes/documents');
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/documents', (req, _res, next) => {
        const user = req.headers['x-test-user'];
        if (user) req.user = { id: String(user), role: 'admin', is_service: req.headers['x-test-service'] === '1' };
        next();
    });
    app.use('/api/documents', createDocumentsRouter({ db, delivery: worker }));
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
    delete process.env.NEXUS_DOCUMENT_APPROVAL_KEY;
    delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

// ── Criterion 1: each decision reaches the viewer with its recommendation and answers ──

test('registration binds decision_items to the revision it recorded, and the viewer read carries each question, recommendation and option', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n\nPilot in March.\n');
    // A producer cannot pre-bind items to a revision of its choosing: the stamp is Nexus's own.
    const registered = await register(file, { metadata: { decision_items: ITEMS, decision_items_revision_id: 'forged-revision' } });
    expect(registered.status).toBe(201);
    const { document, revision } = registered.json;
    expect(document.metadata.decision_items_revision_id).toBe(revision.id);

    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json.decision_items).toEqual({ revision_id: revision.id, answerable: true, items: ITEMS, sent_answers: [] });
    expect(read.json.decision_items.items[0]).toMatchObject({ recommendation: 'Begin the pilot.', options: [{ id: 'pilot', label: 'Pilot' }, { id: 'hold', label: 'Hold' }] });
    expect(read.json.decision_items.items[2]).toEqual(expect.objectContaining({ action: 'Record the cap in the pilot plan.' }));
    expect(read.json.decision_items.items[2].options).toBeUndefined();

    // A document without decision_items reads exactly as before.
    const plain = await register(writeDoc('notes.md', '# Notes\n'), { title: 'Notes' });
    expect((await api('GET', `/api/documents/${plain.json.document.id}`)).json.decision_items).toBeNull();
});

// ── Criterion 2: canonical answers with exact identity, carried to Praxis by the existing notification ──

test('two decisions are answered independently and Finish sends canonical feedback.decision_answers bound to the exact revision, hash and operator', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n\nPilot in March.\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    const review = await openReview(document.id, revision.id);

    // Two answers saved at the same moment both land: neither overwrites the other.
    const [rollout, wording] = await Promise.all([
        answer(review.id, 'rollout', 'Hold', revision.id),
        answer(review.id, 'wording', 'keep', revision.id, operator, { content_hash: revision.content_hash }),
    ]);
    expect(rollout).toMatchObject({ status: 200, json: { answer: { decision_id: 'rollout', answer: 'hold', answered_by: 'local_user', authority: 'operator_credential' } } });
    expect(wording).toMatchObject({ status: 200, json: { answer: { decision_id: 'wording', answer: 'keep' } } });
    expect((await readReview(review.id)).decision_answers.map(a => [a.decision_id, a.answer]).sort()).toEqual([['rollout', 'hold'], ['wording', 'keep']]);

    // Changing one answer leaves the other alone; saving the same answer again is a replay.
    const changed = await answer(review.id, 'rollout', 'pilot', revision.id);
    expect(changed.json.decision_answers.map(a => [a.decision_id, a.answer]).sort()).toEqual([['rollout', 'pilot'], ['wording', 'keep']]);
    const replay = await answer(review.id, 'rollout', 'Pilot', revision.id);
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true, answer: { answer: 'pilot', answered_at: changed.json.answer.answered_at } } });
    const free = await answer(review.id, 'budget', '  Cap it at 4,000 USD for March.  ', revision.id, session);
    expect(free.json.answer).toMatchObject({ answer: 'Cap it at 4,000 USD for March.', authority: 'access_user' });
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'The March date reads well.' });

    const finished = await finish(review.id, { summary: 'Answers below.' });
    expect(finished.status).toBe(202);
    expect(finished.json.review).toMatchObject({ status: 'submitted', submitted_authority: 'operator_credential', approval_delegated: false });
    const submission = await fullSubmission(review.id);
    expect(submission.revision_id).toBe(revision.id);
    // The contract's shape, in declaration order, with the exact revision, hash, source and operator proof beside it.
    expect(submission.payload.decision_answers).toEqual([
        { decision_id: 'rollout', answer: 'pilot' },
        { decision_id: 'wording', answer: 'keep' },
        { decision_id: 'budget', answer: 'Cap it at 4,000 USD for March.' },
    ]);
    expect(submission.payload).toMatchObject({
        submission_id: submission.id, review_id: review.id, reviewer_id: 'local_user', submitted_authority: 'operator_credential',
        document: { id: document.id, project_id: PROJECT_ID, task_id: TASK_A },
        revision: { id: revision.id, content_hash: revision.content_hash },
        source: { task: { id: TASK_A }, project: { id: PROJECT_ID } },
        approval_delegated: false, change_requests: [],
    });
    expect(submission.payload.decision_items.map(item => item.id)).toEqual(['rollout', 'wording', 'budget']);
    expect(submission.message_text).toContain('**Decision answers (3)**');
    expect(submission.message_text).toContain('Answer: Pilot (pilot). Action: Prepare the pilot task.');
    expect(submission.message_text).toContain('An answer is not a document edit, approval, publication or send.');

    // Praxis reads the answers from the package the notification points at, with the revision it must verify.
    const pkg = await api('GET', `/api/documents/${document.id}/submissions/${submission.id}/package`, undefined, runtime);
    expect(pkg.status).toBe(200);
    expect(pkg.json).toMatchObject({ submission_id: submission.id, document_id: document.id, revision_id: revision.id, current_revision_id: revision.id });
    expect(pkg.json.feedback.decision_answers).toEqual(submission.payload.decision_answers);
    expect(pkg.json.revision.content_hash).toBe(revision.content_hash);

    // The existing notification: identifiers only, never the answers themselves.
    await settle();
    expect(relay).toHaveBeenCalledTimes(1);
    const [event, options] = relay.mock.calls[0];
    expect(event).toEqual({ type: 'document.review_submitted', schema_version: 1, event_id: `docreview:${submission.id}`, document_id: document.id, revision_id: revision.id, submission_id: submission.id });
    expect(options).toMatchObject({ idempotencyKey: `docreview:${submission.id}` });
    expect(JSON.stringify(event)).not.toContain('pilot');

    // Replays: a repeated finish returns the same submission, a repeated delivery sends nothing new, and the answers are frozen.
    const again = await finish(review.id, { summary: 'Answers below.' });
    expect(again).toMatchObject({ status: 200, json: { duplicate: true, submission: { id: submission.id } } });
    await worker.deliver(submission.id);
    expect(relay).toHaveBeenCalledTimes(1);
    expect((await fullSubmission(review.id)).payload.decision_answers).toEqual(submission.payload.decision_answers);
    expect(await answer(review.id, 'rollout', 'hold', revision.id)).toMatchObject({ status: 409, json: { code: 'review_submitted' } });
    expect(await api('DELETE', `/api/documents/reviews/${review.id}/decision-answers/rollout`, undefined, operator)).toMatchObject({ status: 409, json: { code: 'review_submitted' } });
});

// ── Criterion 3: answers are not edits, approvals, publication or sending ──

test('an answer creates no revision, editorial decision, approval, send grant or replacement, even with an option that forbids edits', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n\nPilot in March.\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    const before = await api('GET', `/api/documents/${document.id}`);
    expect(before.json.review_status).toBe('needs_review');
    const review = await openReview(document.id, revision.id);
    expect((await answer(review.id, 'wording', 'keep', revision.id)).status).toBe(200);
    expect((await finish(review.id, {})).status).toBe(202);

    const after = await api('GET', `/api/documents/${document.id}`);
    const history = (await api('GET', `/api/documents/${document.id}/history`)).json;
    expect(after.json.revision.id).toBe(revision.id);
    expect(history.revisions).toHaveLength(1);
    expect(history.decisions).toEqual([]);
    expect(after.json).toMatchObject({ review_status: 'needs_review', current_decision: null, replacement: null });
    expect(after.json.outgoing ?? null).toBeNull();
    expect(after.json.reviewable.ok).toBe(true);
    const submission = await fullSubmission(review.id);
    expect(submission.payload).toMatchObject({ decision_answers: [{ decision_id: 'wording', answer: 'keep' }], approval_delegated: false, change_requests: [], decisions: [] });
    // The chosen action travels verbatim so Praxis carries out exactly that: leave the document as it is.
    expect(submission.message_text).toContain('Action: Leave the document exactly as it is; do not edit, publish or send it.');
    expect(submission.message_text).not.toMatch(/Approval delegated/);
    // Nothing reached the bytes on disk either.
    expect(fs.readFileSync(file, 'utf8')).toBe('# Launch plan\n\nPilot in March.\n');
});

test('answering and sending answers need Robert\'s own proof; the shared local_user, the executor and the runtime are refused', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    const review = await openReview(document.id, revision.id);
    const refusals = [
        ['the shared local_user', unsigned, 403, 'operator_required'],
        ['the document executor credential', executorCredential, 403, 'operator_required'],
        ['the runtime key', runtime, 403, 'operator_required'],
        ['a cross-site request', { headers: { ...session.headers, 'sec-fetch-site': 'cross-site' } }, 403, 'cross_site'],
    ];
    for (const [label, options, status, code] of refusals) {
        const response = await answer(review.id, 'rollout', 'pilot', revision.id, options);
        expect({ label, status: response.status, code: response.json.code }).toEqual({ label, status, code });
    }
    expect((await readReview(review.id)).decision_answers).toEqual([]);

    // Answers saved by Robert are not sent by an unsigned finish: the round stays an editable draft with its answers.
    expect((await answer(review.id, 'rollout', 'pilot', revision.id, session)).status).toBe(200);
    for (const [label, options, status, code] of refusals) {
        const response = await finish(review.id, {}, options);
        expect({ label, status: response.status, code: response.json.code }).toEqual({ label, status, code });
    }
    expect(await readReview(review.id)).toMatchObject({ status: 'draft', submission: null, decision_answers: [{ decision_id: 'rollout', answer: 'pilot' }] });
    expect(relay).not.toHaveBeenCalled();
    expect((await finish(review.id, {}, session)).json.review).toMatchObject({ status: 'submitted', submitted_authority: 'access_user' });
});

test('a stale revision is refused at save and at finish; nothing is sent and the draft keeps its answers until they are cleared', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n\nPilot in March.\n');
    const { json: { document, revision: v1 } } = await register(file, { metadata: { decision_items: ITEMS } });
    const review = await openReview(document.id, v1.id);
    expect((await answer(review.id, 'rollout', 'pilot', v1.id)).status).toBe(200);
    expect(await answer(review.id, 'wording', 'keep', v1.id, operator, { content_hash: 'f'.repeat(64) })).toMatchObject({ status: 409, json: { code: 'content_mismatch' } });

    // A new revision registered without decisions: the old questions do not carry over to it.
    fs.writeFileSync(file, '# Launch plan\n\nPilot in April.\n');
    const v2 = (await register(file)).json.revision;
    expect(v2.id).not.toBe(v1.id);
    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json.decision_items).toMatchObject({ revision_id: v1.id, answerable: false });

    const staleSave = await answer(review.id, 'wording', 'keep', v1.id);
    expect(staleSave).toMatchObject({ status: 409, json: { code: 'stale_revision', answered_revision_id: v1.id, current_revision_id: v2.id } });
    const currentCited = await answer(review.id, 'wording', 'keep', v2.id);
    expect(currentCited).toMatchObject({ status: 409, json: { code: 'stale_revision', answered_revision_id: v1.id, review_revision_id: v1.id, current_revision_id: v2.id } });
    const staleFinish = await finish(review.id, { summary: 'Go with the pilot.' });
    expect(staleFinish).toMatchObject({ status: 409, json: { code: 'stale_revision', review_revision_id: v1.id, current_revision_id: v2.id } });
    expect(await readReview(review.id)).toMatchObject({ status: 'draft', submission: null, decision_answers: [{ decision_id: 'rollout', answer: 'pilot' }], stale_answers: [{ decision_id: 'rollout', answer: 'pilot', reason: 'revision_changed' }] });
    expect(relay).not.toHaveBeenCalled();

    // Clearing the answer lets the earlier round's comments go out as before, with no answers in them.
    const cleared = await api('DELETE', `/api/documents/reviews/${review.id}/decision-answers/rollout`, undefined, operator);
    expect(cleared).toMatchObject({ status: 200, json: { cleared: true, decision_answers: [] } });
    const legacy = await finish(review.id, { summary: 'Comments on the March version.' }, unsigned);
    expect(legacy.status).toBe(202);
    expect('decision_answers' in (await fullSubmission(review.id)).payload).toBe(false);

    // A revision that declares new decisions makes them answerable on that revision only.
    fs.writeFileSync(file, '# Launch plan\n\nPilot in May.\n');
    const v3 = (await register(file, { metadata: { decision_items: [ITEMS[0]] } })).json.revision;
    const fresh = await api('GET', `/api/documents/${document.id}`);
    expect(fresh.json.decision_items).toEqual({ revision_id: v3.id, answerable: true, items: [ITEMS[0]], sent_answers: [] });
    const next = await openReview(document.id, v3.id);
    expect((await answer(next.id, 'rollout', 'hold', v3.id)).status).toBe(200);
    expect(await answer(next.id, 'wording', 'keep', v3.id)).toMatchObject({ status: 404, json: { code: 'unknown_decision', decision_ids: ['rollout'] } });
});

test('unknown decisions, answers outside the options, malformed lists and items without a bound revision are refused', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    const review = await openReview(document.id, revision.id);
    expect(await answer(review.id, 'nope', 'pilot', revision.id)).toMatchObject({ status: 404, json: { code: 'unknown_decision' } });
    expect(await answer(review.id, 'rollout', 'maybe', revision.id)).toMatchObject({ status: 400, json: { code: 'invalid_answer', options: ['pilot', 'hold'] } });
    expect(await answer(review.id, 'budget', '   ', revision.id)).toMatchObject({ status: 400, json: { code: 'invalid_answer' } });
    expect(await answer(review.id, 'budget', 'x'.repeat(20001), revision.id)).toMatchObject({ status: 400, json: { code: 'invalid_answer' } });
    expect(await answer(review.id, 'rollout', 'pilot', undefined)).toMatchObject({ status: 400, json: { code: 'revision_required' } });

    // Items stored before Nexus bound them to a revision are shown but cannot be answered here.
    const store = db.documentReviews;
    const legacy = await register(writeDoc('legacy.md', '# Legacy\n'), { title: 'Legacy' });
    store.updateDocument(legacy.json.document.id, { metadata: { decision_items: ITEMS } });
    const legacyRead = await api('GET', `/api/documents/${legacy.json.document.id}`);
    expect(legacyRead.json.decision_items).toMatchObject({ revision_id: null, answerable: false });
    const legacyReview = await openReview(legacy.json.document.id, legacy.json.revision.id);
    expect(await answer(legacyReview.id, 'rollout', 'pilot', legacy.json.revision.id)).toMatchObject({ status: 409, json: { code: 'decisions_not_current' } });

    // A malformed list (a duplicate id here) is refused at registration on both paths, as Praxis would refuse it too.
    const badFile = writeDoc('bad.md', '# Bad\n');
    expect(await register(badFile, { title: 'Bad', metadata: { decision_items: [ITEMS[0], ITEMS[0]] } })).toMatchObject({ status: 400, json: { code: 'invalid_decision_items' } });
    const legacyBad = await api('POST', '/api/documents', { path: badFile, title: 'Bad', metadata: { decision_items: [{ ...ITEMS[0], options: [] }] } });
    expect(legacyBad).toMatchObject({ status: 400, json: { code: 'invalid_decision_items' } });
    expect((await api('GET', '/api/documents?status=all')).json.documents.map(d => d.title)).not.toContain('Bad');
});

test('definitions are immutable for a revision: a changed action, question or empty list on the same bytes is refused before and after a save, on both registration paths, and Finish sends what Robert answered', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    // Same decision and option ids, different meaning: the QA reproduction's "Cancel the pilot task." and a reworded question.
    const changedAction = structuredClone(ITEMS);
    changedAction[0].options[0].action = 'Cancel the pilot task.';
    changedAction[0].recommendation = 'Cancel the pilot.';
    const changedQuestion = structuredClone(ITEMS);
    changedQuestion[1].question = 'Should the launch note be withdrawn?';
    const legacyPath = items => api('POST', '/api/documents', { path: file, title: 'Launch plan', project_id: PROJECT_ID, task_id: TASK_A, metadata: { decision_items: items } });
    const bound = async () => (await api('GET', `/api/documents/${document.id}`)).json.decision_items;
    const refusedChanges = async stage => {
        for (const [label, attempt] of [
            ['declared, changed action', () => register(file, { metadata: { decision_items: changedAction } })],
            ['declared, changed question', () => register(file, { metadata: { decision_items: changedQuestion } })],
            ['declared, empty list', () => register(file, { metadata: { decision_items: [] } })],
            ['legacy, changed action', () => legacyPath(changedAction)],
            ['legacy, empty list', () => legacyPath([])],
        ]) {
            const response = await attempt();
            expect({ stage, label, status: response.status, code: response.json.code }).toEqual({ stage, label, status: 409, code: 'decision_items_changed' });
        }
        expect(await bound()).toMatchObject({ revision_id: revision.id, answerable: true, items: ITEMS });
    };

    // Before any answer is saved.
    await refusedChanges('before save');
    // A refused malformed list and an identical retry change nothing either.
    expect(await register(file, { metadata: { decision_items: [{ id: 'rollout' }] } })).toMatchObject({ status: 400, json: { code: 'invalid_decision_items' } });
    const retry = await register(file, { metadata: { decision_items: structuredClone(ITEMS) } });
    expect(retry.status).toBe(200);
    expect(retry.json.revision.id).toBe(revision.id);

    // The saved answer records the definition it was given against.
    const review = await openReview(document.id, revision.id);
    const saved = await answer(review.id, 'rollout', 'pilot', revision.id);
    expect(saved.status).toBe(200);
    expect(saved.json.answer.definition_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await readReview(review.id)).stale_answers).toEqual([]);

    // Between save and Finish.
    await refusedChanges('between save and finish');
    const finished = await finish(review.id, { summary: 'Pilot.' });
    expect(finished.status).toBe(202);
    const submission = await fullSubmission(review.id);
    expect(submission.payload.decision_answers).toEqual([{ decision_id: 'rollout', answer: 'pilot' }]);
    expect(submission.payload.decision_items).toEqual([ITEMS[0]]);
    expect(submission.message_text).toContain('Action: Prepare the pilot task.');
    expect(submission.message_text).not.toContain('Cancel the pilot');

    // New definitions need new bytes: a new revision may replace them, and a later one may clear them.
    fs.writeFileSync(file, '# Launch plan\n\nRevised.\n');
    const replaced = await register(file, { metadata: { decision_items: changedAction } });
    expect(replaced.status).toBe(200);
    expect(replaced.json.revision.id).not.toBe(revision.id);
    expect(await bound()).toMatchObject({ revision_id: replaced.json.revision.id, answerable: true, items: changedAction });
    fs.writeFileSync(file, '# Launch plan\n\nRevised again.\n');
    expect((await register(file, { metadata: { decision_items: [] } })).status).toBe(200);
    expect(await bound()).toBeNull();
});

test.each([
    ['declared', 'same definitions', ITEMS], ['legacy', 'same definitions', ITEMS],
    ['declared', 'empty definitions', []], ['legacy', 'empty definitions', []],
    ['declared', 'changed definitions', null], ['legacy', 'changed definitions', null],
])('historical revision definitions survive %s registration with intervening %s, before and after answering', async (registrationPath, _label, interimItems) => {
    const file = writeDoc('round-trip.md', '# Original\n');
    const registerItems = items => registrationPath === 'declared'
        ? register(file, { metadata: { decision_items: items } })
        : api('POST', '/api/documents', { path: file, title: 'Round trip', project_id: PROJECT_ID, task_id: TASK_A, metadata: { decision_items: items } });
    const first = await registerItems(ITEMS);
    expect(first.status).toBe(201);
    const { document, revision } = first.json;
    const viewed = (await api('GET', `/api/documents/${document.id}`)).json;
    const review = await openReview(document.id, revision.id);
    const changedAction = structuredClone(ITEMS);
    changedAction[0].options[0].action = 'Cancel the pilot task.';
    const changedQuestion = structuredClone(ITEMS);
    changedQuestion[0].question = 'Should the pilot be cancelled?';

    for (const stage of ['before answer', 'after answer']) {
        fs.writeFileSync(file, '# Intermediate\n', 'utf8');
        // Even an empty decision list must not erase the original definition.
        const interim = await registerItems(interimItems ?? changedAction);
        expect(interim.status).toBe(200);
        expect(interim.json.revision.id).not.toBe(revision.id);
        const before = db.documentReviews.getDocument(document.id);
        fs.writeFileSync(file, '# Original\n', 'utf8');
        for (const items of [changedAction, changedQuestion, []]) {
            const rejected = await registerItems(items);
            expect({ stage, status: rejected.status, code: rejected.json.code }).toEqual({ stage, status: 409, code: 'decision_items_changed' });
            expect(db.documentReviews.getDocument(document.id)).toEqual(before);
        }
        // The original viewer cannot save or finish against the intervening
        // revision's definitions after the rejected replacement.
        expect([404, 409]).toContain((await answer(review.id, 'rollout', 'pilot', revision.id)).status);
        if (stage === 'after answer') expect((await finish(review.id)).status).toBe(409);
        // Returning the original definition is a valid retry of the original revision.
        const restored = await registerItems(ITEMS);
        expect(restored.status).toBe(200);
        expect(restored.json.revision.id).toBe(viewed.revision.id);
        expect(restored.json.revision.content_hash).toBe(viewed.revision.content_hash);
        expect((await answer(review.id, 'rollout', 'pilot', revision.id, operator, { content_hash: viewed.revision.content_hash })).status).toBe(200);
    }
    expect((await finish(review.id)).status).toBe(202);
    const submission = await fullSubmission(review.id);
    expect(submission.payload.decision_items).toEqual([ITEMS[0]]);
    expect(submission.payload.decision_answers).toEqual([{ decision_id: 'rollout', answer: 'pilot' }]);
    expect(submission.message_text).not.toContain('Cancel the pilot');
    expect(db.documentReviews.listRevisionMeta(document.id)).toHaveLength(2);
});

test.each(['declared', 'legacy'])('a viewer capture before %s registration still permits the first definitions on new bytes', async registrationPath => {
    const file = writeDoc('capture-first.md', '# Original\n');
    const registerItems = () => registrationPath === 'declared'
        ? register(file, { metadata: { decision_items: ITEMS } })
        : api('POST', '/api/documents', { path: file, project_id: PROJECT_ID, task_id: TASK_A, metadata: { decision_items: ITEMS } });
    const original = await registerItems();
    fs.writeFileSync(file, '# Captured before registration\n', 'utf8');
    const captured = await api('GET', `/api/documents/${original.json.document.id}`);
    expect(captured.json.revision.id).not.toBe(original.json.revision.id);
    // A restart does not turn a new, never-declared capture into lost history.
    const sqlite = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    try { require('../../db/document-reviews').initializeDocumentReviews(sqlite); }
    finally { sqlite.close(); }
    const registered = await registerItems();
    expect(registered.status).toBe(200);
    expect(registered.json.revision.id).toBe(captured.json.revision.id);
    expect((await api('GET', `/api/documents/${original.json.document.id}`)).json.decision_items).toMatchObject({ answerable: true, items: ITEMS });
});

test('existing bindings migrate durably, including empty definitions; unknown older definitions cannot be replaced', async () => {
    const file = writeDoc('existing.md', '# Existing\n');
    const original = await register(file, { metadata: { decision_items: ITEMS } });
    const empty = await register(writeDoc('empty.md', '# Empty\n'), { metadata: { decision_items: [] } });
    // Simulate the previous schema: only the currently bound definitions survived.
    const sqlite = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    const { initializeDocumentReviews } = require('../../db/document-reviews');
    try {
        sqlite.exec('DROP TABLE review_document_decision_definitions');
        initializeDocumentReviews(sqlite);
        expect(db.documentReviews.getDecisionDefinitions(original.json.revision.id)).toEqual(ITEMS);
        expect(db.documentReviews.getDecisionDefinitions(empty.json.revision.id)).toEqual([]);
        expect(await register(empty.json.document.path, { metadata: { decision_items: ITEMS } })).toMatchObject({ status: 409 });
        fs.writeFileSync(file, '# Later\n', 'utf8');
        expect((await register(file, { metadata: { decision_items: [] } })).status).toBe(200);
        // A restart must not replace history with the new current metadata.
        initializeDocumentReviews(sqlite);
        fs.writeFileSync(file, '# Existing\n', 'utf8');
        expect(await register(file, { metadata: { decision_items: [] } })).toMatchObject({ status: 409, json: { code: 'decision_items_changed' } });
        expect((await register(file, { metadata: { decision_items: ITEMS } })).json.revision.id).toBe(original.json.revision.id);

        // A historical revision lost before this repair cannot be reconstructed
        // from a producer's newly supplied definitions. Refuse instead of guessing.
        fs.writeFileSync(file, '# Later\n', 'utf8');
        await register(file, { metadata: { decision_items: [] } });
        sqlite.exec('DROP TABLE review_document_decision_definitions');
        initializeDocumentReviews(sqlite);
        fs.writeFileSync(file, '# Existing\n', 'utf8');
        const unknown = await register(file, { metadata: { decision_items: ITEMS } });
        expect(unknown).toMatchObject({ status: 409, json: { code: 'decision_items_changed' } });
        expect(unknown.json.error).toContain('original definitions were not retained');
    } finally {
        sqlite.close();
    }
});

test.each(['declared', 'legacy'])('the upgrade marks only documents that carried decision_items as unknown, so a never-declared document takes its first %s declaration on unchanged bytes', async registrationPath => {
    const registerFile = (file, metadata) => registrationPath === 'declared'
        ? register(file, metadata ? { metadata } : {})
        : api('POST', '/api/documents', { path: file, title: 'Launch plan', project_id: PROJECT_ID, task_id: TASK_A, ...(metadata ? { metadata } : {}) });
    // Pre-upgrade documents that never declared decisions: one with no metadata, one with other metadata only.
    const plainFile = writeDoc('plain.md', '# Plain\n');
    const plain = await registerFile(plainFile);
    const otherFile = writeDoc('other.md', '# Other\n');
    const other = await registerFile(otherFile, { audience: 'board' });
    // A document that did declare decisions, with an earlier revision whose binding the old schema lost.
    const declaredFile = writeDoc('declared.md', '# Declared\n');
    const declared = await registerFile(declaredFile, { decision_items: ITEMS });
    const changedAction = structuredClone(ITEMS);
    changedAction[0].options[0].action = 'Cancel the pilot task.';
    fs.writeFileSync(declaredFile, '# Declared, revised\n', 'utf8');
    const revised = await registerFile(declaredFile, { decision_items: changedAction });
    for (const response of [plain, other, declared, revised]) expect([200, 201]).toContain(response.status);
    expect(revised.json.revision.id).not.toBe(declared.json.revision.id);

    // Simulate the restart that activates the ledger on a database the previous schema wrote.
    const sqlite = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    try {
        sqlite.exec('DROP TABLE review_document_decision_definitions');
        require('../../db/document-reviews').initializeDocumentReviews(sqlite);
        const marked = sqlite.prepare(`SELECT r.document_id, x.decision_items FROM review_document_decision_definitions x
            JOIN review_document_revisions r ON r.id = x.revision_id`).all();
        // The backfill touches only the declaring document: its bound revision keeps its items, the earlier one is unknown.
        expect(marked.map(row => row.document_id)).toEqual([declared.json.document.id, declared.json.document.id]);
        expect(db.documentReviews.getDecisionDefinitions(revised.json.revision.id)).toEqual(changedAction);
        expect(db.documentReviews.getDecisionDefinitions(declared.json.revision.id)).toBeNull();
        expect(db.documentReviews.getDecisionDefinitions(plain.json.revision.id)).toBeUndefined();
        expect(db.documentReviews.getDecisionDefinitions(other.json.revision.id)).toBeUndefined();
    } finally {
        sqlite.close();
    }

    // Unchanged pre-upgrade bytes of never-declared documents take their first declaration.
    for (const [file, before] of [[plainFile, plain], [otherFile, other]]) {
        const first = await registerFile(file, { decision_items: ITEMS });
        expect({ file, status: first.status }).toEqual({ file, status: 200 });
        expect(first.json.revision.id).toBe(before.json.revision.id);
        expect(first.json.revision.content_hash).toBe(before.json.revision.content_hash);
        expect((await api('GET', `/api/documents/${before.json.document.id}`)).json.decision_items)
            .toMatchObject({ revision_id: before.json.revision.id, answerable: true, items: ITEMS });
        expect(db.documentReviews.getDecisionDefinitions(before.json.revision.id)).toEqual(ITEMS);
        // Once declared, the definitions are immutable like any other.
        expect(await registerFile(file, { decision_items: changedAction })).toMatchObject({ status: 409, json: { code: 'decision_items_changed' } });
    }

    // The declaring document keeps its protection: its lost earlier definitions are not replaced on the same bytes.
    fs.writeFileSync(declaredFile, '# Declared\n', 'utf8');
    const unknown = await registerFile(declaredFile, { decision_items: ITEMS });
    expect(unknown).toMatchObject({ status: 409, json: { code: 'decision_items_changed' } });
    expect(unknown.json.error).toContain('original definitions were not retained');
});

test('answers whose definition changed or vanished are listed as stale with a reason, Finish refuses them, and clearing or re-answering recovers a Finish that keeps the comments', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    const store = db.documentReviews;
    const review = await openReview(document.id, revision.id);
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'The pilot section reads well.' });
    const first = await answer(review.id, 'rollout', 'pilot', revision.id);
    expect(first.status).toBe(200);
    expect((await answer(review.id, 'wording', 'keep', revision.id)).status).toBe(200);
    const stamped = items => ({ decision_items: items, decision_items_revision_id: revision.id });

    // An answer saved before definitions were recorded proves nothing about what was read, so it cannot be sent.
    const draft = store.getReview(review.id);
    store.updateReview(review.id, { decision_answers: [...draft.decision_answers, { decision_id: 'budget', answer: 'Cap it at 4,000 USD.', answered_at: draft.updated_at, answered_by: 'local_user', authority: 'operator_credential' }] });
    expect((await readReview(review.id)).stale_answers).toEqual([{ decision_id: 'budget', answer: 'Cap it at 4,000 USD.', reason: 'definition_changed' }]);
    expect(await finish(review.id, {})).toMatchObject({ status: 409, json: { code: 'decisions_changed', stale_answers: [{ decision_id: 'budget', reason: 'definition_changed' }] } });
    expect((await api('DELETE', `/api/documents/reviews/${review.id}/decision-answers/budget`, undefined, operator)).status).toBe(200);

    // A definition changed behind the route (same ids, new action): the answer is stale, and re-answering reconfirms it against what is shown now.
    const changed = structuredClone(ITEMS);
    changed[0].options[0].action = 'Cancel the pilot task.';
    store.updateDocument(document.id, { metadata: stamped(changed) });
    expect((await readReview(review.id)).stale_answers).toEqual([{ decision_id: 'rollout', answer: 'pilot', reason: 'definition_changed' }]);
    expect(await finish(review.id, {})).toMatchObject({ status: 409, json: { code: 'decisions_changed', decision_id: 'rollout' } });
    const reconfirmed = await answer(review.id, 'rollout', 'pilot', revision.id);
    expect(reconfirmed.status).toBe(200);
    expect(reconfirmed.json.duplicate).toBeUndefined();
    expect(reconfirmed.json.answer.definition_hash).not.toBe(first.json.answer.definition_hash);
    expect((await readReview(review.id)).stale_answers).toEqual([]);

    // Every decision removed: both answers are orphaned, Finish refuses, the draft keeps them, and nothing is relayed.
    store.updateDocument(document.id, { metadata: stamped([]) });
    expect((await api('GET', `/api/documents/${document.id}`)).json.decision_items).toBeNull();
    const orphaned = await readReview(review.id);
    expect([...orphaned.stale_answers].sort((a, b) => a.decision_id.localeCompare(b.decision_id))).toEqual([
        { decision_id: 'rollout', answer: 'pilot', reason: 'decisions_unavailable' },
        { decision_id: 'wording', answer: 'keep', reason: 'decisions_unavailable' },
    ]);
    expect(await finish(review.id, { summary: 'Pilot.' })).toMatchObject({ status: 409, json: { code: 'decisions_changed' } });
    expect(await readReview(review.id)).toMatchObject({ status: 'draft', submission: null });
    expect(relay).not.toHaveBeenCalled();

    // Clearing the orphaned answers recovers: Finish succeeds with the comment and without any answer.
    for (const id of ['rollout', 'wording']) {
        expect((await api('DELETE', `/api/documents/reviews/${review.id}/decision-answers/${id}`, undefined, operator)).status).toBe(200);
    }
    const recovered = await finish(review.id, { summary: 'Pilot.' });
    expect(recovered.status).toBe(202);
    const payload = (await fullSubmission(review.id)).payload;
    expect(payload.comments.map(c => c.body)).toEqual(['The pilot section reads well.']);
    expect('decision_answers' in payload).toBe(false);
    expect(recovered.json.review.stale_answers).toEqual([]);
});

test('a later round on the same revision sees what earlier rounds sent, the latest answer per decision', async () => {
    const file = writeDoc('plan.md', '# Launch plan\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    const first = await openReview(document.id, revision.id);
    expect((await answer(first.id, 'rollout', 'pilot', revision.id)).status).toBe(200);
    expect((await answer(first.id, 'budget', 'Cap it at 4,000 USD.', revision.id)).status).toBe(200);
    expect((await finish(first.id, {})).status).toBe(202);
    const afterFirst = (await api('GET', `/api/documents/${document.id}`)).json.decision_items;
    expect(afterFirst.answerable).toBe(true);
    expect(afterFirst.sent_answers.map(a => [a.decision_id, a.answer, a.review_id])).toEqual([['rollout', 'pilot', first.id], ['budget', 'Cap it at 4,000 USD.', first.id]]);

    // The second round answers the rest and changes its mind on one; the later answer wins, the untouched one stays.
    const second = await openReview(document.id, revision.id);
    expect(second.id).not.toBe(first.id);
    expect((await answer(second.id, 'rollout', 'hold', revision.id)).status).toBe(200);
    expect((await answer(second.id, 'wording', 'keep', revision.id)).status).toBe(200);
    expect((await api('GET', `/api/documents/${document.id}`)).json.decision_items.sent_answers).toHaveLength(2); // drafts are not sent answers
    expect((await finish(second.id, {})).status).toBe(202);
    const afterSecond = (await api('GET', `/api/documents/${document.id}`)).json.decision_items.sent_answers;
    expect(Object.fromEntries(afterSecond.map(a => [a.decision_id, [a.answer, a.review_id]]))).toEqual({
        rollout: ['hold', second.id], wording: ['keep', second.id], budget: ['Cap it at 4,000 USD.', first.id],
    });
});

test('a finish that only answers decisions records Robert\'s proof but never delegates approval to an executor', async () => {
    const TASK_B = '22222222-2222-4222-8222-22222222222b';
    await db.createTask({ id: TASK_B, project_id: PROJECT_ID, name: 'Carry out the answers', status: 'in_progress' });
    const file = writeDoc('plan.md', '# Launch plan\n\nPilot in March.\n');
    const { json: { document, revision } } = await register(file, { metadata: { decision_items: ITEMS } });
    const review = await openReview(document.id, revision.id);
    expect((await answer(review.id, 'rollout', 'pilot', revision.id)).status).toBe(200);
    const finished = await finish(review.id, { summary: 'Pilot, and approve it when done.' });
    expect(finished.json.review).toMatchObject({ submitted_authority: 'operator_credential', approval_delegated: false });
    const submission = await fullSubmission(review.id);

    // The executor carries out the answer and writes a new revision; citing the answers round as approval is refused.
    fs.writeFileSync(file, '# Launch plan\n\nPilot in March, prepared.\n');
    const v2 = (await register(file)).json.revision;
    const attempt = await api('POST', `/api/documents/${document.id}/decisions`, {
        decision: 'approve', revision_id: v2.id,
        executor: { id: 'praxis-claude-code:test-executor', task_id: TASK_B, execution_id: 'exec-0001', source_submission_id: submission.id, authorization_ref: 'ask-robert-test' },
    }, executorCredential);
    expect(attempt).toMatchObject({ status: 403, json: { code: 'source_review_not_delegated', submitted_authority: 'operator_credential', approval_delegated: false } });
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions).toEqual([]);
});

test('a legacy finish without decisions is unchanged, and editorial approval with a design direction still works beside answers', async () => {
    // Legacy: no decision_items, an unsigned finish of comments, the payload as before.
    const plain = await register(writeDoc('notes.md', '# Notes\n'), { title: 'Notes' });
    const legacyReview = await openReview(plain.json.document.id, plain.json.revision.id);
    await api('POST', `/api/documents/reviews/${legacyReview.id}/comments`, { kind: 'document', body: 'Fine.' });
    const legacy = await finish(legacyReview.id, { summary: 'Fine.' }, unsigned);
    expect(legacy.status).toBe(202);
    expect(legacy.json.review).toMatchObject({ submitted_authority: null, decision_answers: [] });
    const legacyPayload = (await fullSubmission(legacyReview.id)).payload;
    expect('decision_answers' in legacyPayload).toBe(false);
    expect('decision_items' in legacyPayload).toBe(false);
    expect((await fullSubmission(legacyReview.id)).message_text).not.toContain('Decision answers');

    // A design package with two directions and a decision: approving needs a direction; answering the decision does not.
    const designDir = path.join(projectRoot, 'docs', 'design');
    fs.mkdirSync(path.join(designDir, 'export'), { recursive: true });
    fs.writeFileSync(path.join(designDir, 'export', 'a.png'), png(2, 2, [1, 2, 3]));
    fs.writeFileSync(path.join(designDir, 'export', 'b.png'), png(2, 2, [4, 5, 6]));
    const manifest = {
        format: 'nexus-design-package/1', title: 'Statement redesign', summary: 'Two directions.',
        directions: [{ id: '1a', title: 'Hairline', recommended: true }, { id: '1b', title: 'Masthead' }],
        screens: [
            { id: 'S1-a', title: 'Statement', direction: '1a', appearance: 'light', file: 'export/a.png' },
            { id: 'S1-b', title: 'Statement', direction: '1b', appearance: 'light', file: 'export/b.png' },
        ],
    };
    const manifestFile = path.join(designDir, 'statement.design.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const design = await register(manifestFile, { title: 'Statement redesign', kind: 'design', metadata: { decision_items: [ITEMS[0]] } });
    expect(design.status).toBe(201);
    const { document, revision } = design.json;
    const review = await openReview(document.id, revision.id);
    expect((await answer(review.id, 'rollout', 'pilot', revision.id)).status).toBe(200);
    // The answer did not approve: the document still needs review and approving still requires choosing a direction.
    expect((await api('GET', `/api/documents/${document.id}`)).json.review_status).toBe('needs_review');
    const noDirection = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id }, operator);
    expect(noDirection).toMatchObject({ status: 400, json: { code: 'selection_required' } });
    const approved = await api('POST', `/api/documents/${document.id}/decisions`, { decision: 'approve', revision_id: revision.id, selection: { direction: '1a' } }, operator);
    expect(approved).toMatchObject({ status: 201, json: { review_status: 'approved', decision: { selection: { direction: '1a' } } } });

    const finished = await finish(review.id, { summary: 'Direction 1a; pilot.' });
    expect(finished.status).toBe(202);
    const payload = (await fullSubmission(review.id)).payload;
    // Three separate channels, each kept apart: the editorial decision, the design direction and the decision answer.
    expect(payload.decisions.map(d => [d.decision, d.selection])).toEqual([['approve', { direction: '1a' }]]);
    expect(payload.selected_direction).toBe('1a');
    expect(payload.decision_answers).toEqual([{ decision_id: 'rollout', answer: 'pilot' }]);
    expect((await api('GET', `/api/documents/${document.id}/history`)).json.decisions).toHaveLength(1);
});

function png(width, height, rgb) {
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    const crc32 = buf => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
        return Buffer.concat([len, typed, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}
