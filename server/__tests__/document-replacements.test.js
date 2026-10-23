/**
 * Versions, the current revision and replacement work (contract §12, task
 * 6b46dcc8). Accepting an authorized change request links it to exactly one
 * revision work item, supersedes pending feedback drafts (comments kept),
 * closes the old version to new reviews, decisions and edits, and reopens the
 * document only on a registered result that is the current ready revision,
 * or on an explicit failure or cancellation. Recovery is a new, versioned
 * attempt that names the failed one.
 *
 * Isolated NEXUS_DB_PATH and a temporary project root; synthetic tasks,
 * documents and fixtures. Delivery is a stub, the Access signing keys are a
 * local fixture and both credentials are synthetic test values: nothing here
 * reaches the live database, Praxis, Cloudflare, a mail transport or a real
 * review.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const access = require('./helpers/operator-access');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-0123456789abcdef';
const DOCUMENT_KEY = 'document-executor-test-credential-0123456789';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
/** Produced the document and completed before Robert asked for changes (the a1680783 incident shape). */
const SOURCE_TASK = '22222222-2222-4222-8222-22222222222a';
/** The revision work item Praxis links the request to. */
const WORK_TASK = '22222222-2222-4222-8222-22222222222b';
const OTHER_TASK = '22222222-2222-4222-8222-22222222222c';
const RECOVERY_TASK = '22222222-2222-4222-8222-22222222222d';
const V1 = '# Client install status\n\n| Client | State |\n|---|---|\n| HWC | installed |\n';
const V2 = '# Client install status\n\n| Client | State |\n|---|---|\n| HWC | installed, verified 2026-10-23 |\n';
const V3 = `${V2}\nNotes: verification log attached.\n`;
const EXECUTOR = { id: 'praxis-claude-code:test-executor', task_id: WORK_TASK, execution_id: 'exec-0001', authorization_ref: 'ask-robert-81299292-0878-4db1-a108-a14cc332f5dc' };

let db;
let base;
let server;
let workspace;
let projectRoot;
let delivery;
let restoreAccess;

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
const executorCredential = { headers: { authorization: `Bearer ${DOCUMENT_KEY}` } };
const session = { headers: { 'cf-access-jwt-assertion': access.token() } };

function writeDoc(name, content) {
    const file = path.join(projectRoot, 'docs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

/** A declared deliverable registered by a task (the producer's receipt). */
function register(file, { task_id = SOURCE_TASK, deliverable = {}, ...extra } = {}) {
    return api('POST', '/api/documents', {
        path: file, title: 'Client install status', project_id: PROJECT_ID, task_id, kind: 'report',
        deliverable: { purpose: 'Decide whether the install status is accurate', requires_review: true, intended_action: 'none', ...deliverable },
        ...extra,
    });
}

async function setup(name, content = V1) {
    const file = writeDoc(name, content);
    const registered = await register(file);
    expect(registered.status).toBe(201);
    return { file, document: registered.json.document, v1: registered.json.revision };
}

/** Robert's feedback round from his verified session: open, comment, finish (202). */
async function finishReview(documentId, { summary = 'Fix the HWC row: it is installed and verified.', comment = 'This row is out of date.', grant = false, user = 'local_user', options = session } = {}) {
    const opened = await api('POST', `/api/documents/${documentId}/reviews`, {}, { user });
    expect(opened.status).toBe(201);
    const review = opened.json.review;
    if (comment) expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: comment }, { user })).status).toBe(201);
    const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary, ...(grant ? { approve_after_changes: true } : {}) }, { user, ...options });
    expect(finished.status).toBe(202);
    return { review: finished.json.review, submission: finished.json.submission };
}

function decide(documentId, revisionId, decision = 'request_changes', extra = {}, options = operator) {
    return api('POST', `/api/documents/${documentId}/decisions`, { decision, revision_id: revisionId, ...extra }, options);
}

/** A second reviewer's pending draft with one comment: the kind of round an acceptance supersedes. */
async function draftWithComment(documentId, user, body = 'Pending thought from a second reviewer.') {
    const opened = await api('POST', `/api/documents/${documentId}/reviews`, {}, { user });
    expect(opened.status).toBe(201);
    expect((await api('POST', `/api/documents/reviews/${opened.json.review.id}/comments`, { kind: 'document', body }, { user })).status).toBe(201);
    return opened.json.review;
}

const accept = (documentId, body, options = {}) => api('POST', `/api/documents/${documentId}/replacements`, body, options);
const report = (documentId, replacementId, body) => api('PATCH', `/api/documents/${documentId}/replacements/${replacementId}`, body);
const read = documentId => api('GET', `/api/documents/${documentId}`);
const history = documentId => api('GET', `/api/documents/${documentId}/history`).then(r => r.json);
const counts = (query = '') => api('GET', `/api/documents/counts${query}`).then(r => r.json.counts);
const listIds = query => api('GET', `/api/documents?${query}`).then(r => r.json.documents.map(d => d.id));

/** The incident shape: the producing task completed, Robert reviewed and requested changes afterwards. */
async function requestedChanges(name) {
    const fixture = await setup(name);
    const round = await finishReview(fixture.document.id);
    const decision = await decide(fixture.document.id, fixture.v1.id, 'request_changes', { note: 'Update the HWC row.' });
    expect(decision.status).toBe(201);
    return { ...fixture, ...round, decision: decision.json.decision };
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-replacements-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = DOCUMENT_KEY;
    restoreAccess = access.configure({ deviceIds: access.deviceId });
    // Only the Access signing-key fetch is faked; the test's own HTTP calls use the native fetch.
    global.fetch = jest.fn(async (url, init) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks }
        : nativeFetch(url, init)));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'HWC');
    fs.mkdirSync(projectRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'HWC client install', path: projectRoot });
    await db.createTask({ id: SOURCE_TASK, project_id: PROJECT_ID, name: 'Report client install status', status: 'completed' });
    await db.createTask({ id: WORK_TASK, project_id: PROJECT_ID, name: 'Revise the install status report', status: 'in_progress' });
    await db.createTask({ id: OTHER_TASK, project_id: PROJECT_ID, name: 'Another revision task', status: 'in_progress' });
    await db.createTask({ id: RECOVERY_TASK, project_id: PROJECT_ID, name: 'Retry the revision', status: 'in_progress' });
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
    restoreAccess();
    jest.restoreAllMocks();
    delete process.env.NEXUS_DB_PATH;
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    delete process.env.NEXUS_DOCUMENT_APPROVAL_KEY;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('a change request after the source task completed links to exactly one work item, supersedes pending drafts and closes the old version to review actions', async () => {
    const { document, v1, review, submission, decision } = await requestedChanges('a.md');
    const pending = await draftWithComment(document.id, 'second-reviewer');
    expect((await read(document.id)).json).toMatchObject({ reviewable: { ok: true, reason: null }, replacement: null, review_status: 'changes_requested', version: { current_revision_id: v1.id, current_version: 1, revision_count: 1 } });

    const accepted = await accept(document.id, { client_request_id: 'praxis-req-1', source: { submission_id: submission.id, decision_id: decision.id }, task_id: WORK_TASK, execution_id: 'exec-1' });
    expect(accepted.status).toBe(201);
    expect(accepted.json).toMatchObject({ duplicate: false, review_status: 'changes_requested', reviewable: false, superseded_reviews: [pending.id] });
    const rp = accepted.json.replacement;
    expect(rp).toMatchObject({
        state: 'accepted', open: true, terminal: false, attempt: 1, base_revision_id: v1.id, result_revision_id: null, task_id: WORK_TASK, execution_id: 'exec-1',
        client_request_id: 'praxis-req-1', accepted_by: 'local_user', recovers_replacement_id: null, qa_state: null, completed_at: null,
        source: { submission_id: submission.id, review_id: review.id, decision_id: decision.id, authority: 'operator_credential', submission_delivery_status: 'queued' },
        superseded_review_ids: [pending.id],
        links: { task_path: `/task/${WORK_TASK}`, review_path: `/documents/${document.id}`, result_raw_path: null, self_path: `/api/documents/${document.id}/replacements/${rp.id}` },
    });

    // The finished review is history, not superseded; the pending draft is closed read-only with its comment kept.
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review).toMatchObject({ status: 'submitted', closed_reason: null, replacement_id: null });
    const superseded = (await api('GET', `/api/documents/reviews/${pending.id}`, undefined, { user: 'second-reviewer' })).json.review;
    expect(superseded).toMatchObject({ status: 'superseded', closed_reason: 'superseded', replacement_id: rp.id, is_current_revision: true });
    expect(superseded.closed_at).toBeTruthy();
    expect(superseded.comments.map(c => c.body)).toEqual(['Pending thought from a second reviewer.']);
    const refused = { status: 409, json: { code: 'review_superseded', replacement: { id: rp.id } } };
    expect(await api('POST', `/api/documents/reviews/${pending.id}/comments`, { kind: 'document', body: 'late' }, { user: 'second-reviewer' })).toMatchObject(refused);
    expect(await api('PATCH', `/api/documents/reviews/${pending.id}`, { summary: 'late' }, { user: 'second-reviewer' })).toMatchObject(refused);
    expect(await api('PATCH', `/api/documents/reviews/${pending.id}/comments/${superseded.comments[0].id}`, { body: 'late edit' }, { user: 'second-reviewer' })).toMatchObject(refused);
    expect(await api('DELETE', `/api/documents/reviews/${pending.id}/comments/${superseded.comments[0].id}`, undefined, { user: 'second-reviewer' })).toMatchObject(refused);
    expect(await api('POST', `/api/documents/reviews/${pending.id}/finish`, { summary: 'late' }, { user: 'second-reviewer', ...session })).toMatchObject(refused);
    expect((await api('GET', `/api/documents/reviews/${pending.id}`, undefined, { user: 'second-reviewer' })).json.review.comments).toHaveLength(1);
    expect(db.documentReviews.getSubmissionForReview(pending.id)).toBeFalsy();

    // The old version takes no new review, decision or edit, from any tab or caller; the bytes are untouched.
    const closed = { status: 409, json: { code: 'replacement_in_progress', replacement: { id: rp.id, state: 'accepted' } } };
    expect(await api('POST', `/api/documents/${document.id}/reviews`, {}, { user: 'third-reviewer' })).toMatchObject(closed);
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v1.id })).toMatchObject(closed);
    expect(await decide(document.id, v1.id, 'approve')).toMatchObject(closed);
    expect(await decide(document.id, v1.id, 'request_changes', { note: 'again' })).toMatchObject(closed);
    expect(await api('PUT', `/api/documents/${document.id}/content`, { base_revision_id: v1.id, content: `${V1}\nedit\n`, client_edit_id: 'edit-1' }, session)).toMatchObject(closed);
    expect((await api('GET', `/api/documents/${document.id}/raw`)).json).toBe(V1);
    expect(db.documentReviews.listDecisions(document.id)).toHaveLength(1);

    // Reader, list, counts, history and the consumer check agree.
    const detail = (await read(document.id)).json;
    expect(detail.reviewable).toEqual({ ok: false, reason: 'replacement_in_progress', replacement_id: rp.id });
    expect(detail.replacement).toMatchObject({ id: rp.id, state: 'accepted', open: true });
    expect(detail.review_status).toBe('changes_requested');
    expect(detail.revision.version).toBe(1);
    expect(await counts()).toEqual({ needs_review: 0, changes_requested: 0, approved: 0, reference: 0, in_progress: 1, all: 1 });
    expect(await listIds('status=in_progress')).toEqual([document.id]);
    expect(await listIds('status=changes_requested')).toEqual([]);
    expect(await listIds('status=all')).toEqual([document.id]);
    const row = (await api('GET', '/api/documents?status=in_progress')).json.documents[0];
    expect(row).toMatchObject({ id: document.id, reviewable: false, replacement: { id: rp.id, state: 'accepted', task_id: WORK_TASK, attempt: 1, open: true }, review_status: 'changes_requested' });
    const h = await history(document.id);
    expect(h).toMatchObject({ current_version: 1, reviewable: false, current_revision_id: v1.id });
    expect(h.revisions.map(r => [r.version, r.is_current])).toEqual([[1, true]]);
    expect(h.reviews.find(r => r.id === pending.id)).toMatchObject({ status: 'superseded', closed_reason: 'superseded', replacement_id: rp.id, is_current_revision: true });
    expect(h.reviews.find(r => r.id === review.id)).toMatchObject({ status: 'submitted', closed_reason: null });
    expect(h.replacements.map(r => r.id)).toEqual([rp.id]);
    const listed = (await api('GET', `/api/documents/${document.id}/replacements`)).json;
    expect(listed).toMatchObject({ document_id: document.id, current_revision_id: v1.id, reviewable: false, open: { id: rp.id } });
    expect(listed.replacements.map(r => r.id)).toEqual([rp.id]);
    const check = (await api('GET', `/api/documents/${document.id}/replacements/${rp.id}`)).json;
    expect(check).toMatchObject({ is_latest: true, result_is_current: false, result_is_ready: false, result_revision: null, reviewable: false, file_state: 'ok', review_status: 'changes_requested', replacement: { id: rp.id } });
    expect(check.base_revision.id).toBe(v1.id);
    expect(check.current_revision).toMatchObject({ id: v1.id, version: 1 });
    expect((await api('GET', `/api/documents/${document.id}/replacements/no-such-item`)).status).toBe(404);

    // Replays and duplicates: the same key and source is the same acceptance; a reused key or a second item for the same request is refused.
    const replay = await accept(document.id, { client_request_id: 'praxis-req-1', source: { submission_id: submission.id, decision_id: decision.id }, task_id: WORK_TASK });
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true, replacement: { id: rp.id }, superseded_reviews: [pending.id] } });
    expect(await accept(document.id, { client_request_id: 'praxis-req-1', source: { decision_id: decision.id } })).toMatchObject({ status: 409, json: { code: 'idempotency_key_reused', replacement: { id: rp.id } } });
    expect(await accept(document.id, { client_request_id: 'praxis-req-2', source: { submission_id: submission.id } })).toMatchObject({ status: 409, json: { code: 'replacement_exists', replacement: { id: rp.id } } });
    expect(await accept(document.id, { client_request_id: 'praxis-req-3', source: { decision_id: decision.id } })).toMatchObject({ status: 409, json: { code: 'replacement_exists' } });
    expect(db.documentReviews.listReplacements(document.id)).toHaveLength(1);
});

test('concurrent and replayed acceptances yield exactly one work item, and a race with a finish or a decision has one winner', async () => {
    const { document, submission, decision } = await requestedChanges('b.md');
    const pending = await draftWithComment(document.id, 'second-reviewer');
    const source = { submission_id: submission.id, decision_id: decision.id };
    const results = await Promise.all([
        ...[1, 2, 3].map(() => accept(document.id, { client_request_id: 'same-key', source, task_id: WORK_TASK })),
        ...['k-a', 'k-b', 'k-c'].map(key => accept(document.id, { client_request_id: key, source, task_id: WORK_TASK })),
    ]);
    const created = results.filter(r => r.status === 201);
    expect(created).toHaveLength(1);
    const id = created[0].json.replacement.id;
    for (const r of results) {
        if (r.status === 201) continue;
        if (r.status === 200) expect(r.json).toMatchObject({ duplicate: true, replacement: { id } });
        else {
            expect(r.status).toBe(409);
            expect(['replacement_exists', 'replacement_in_progress']).toContain(r.json.code);
            expect(r.json.replacement.id).toBe(id);
        }
    }
    expect(db.documentReviews.listReplacements(document.id)).toHaveLength(1);
    expect(db.documentReviews.getReview(pending.id)).toMatchObject({ status: 'superseded', replacement_id: id });

    // A finish and an acceptance in flight together: either the round was finished before the work closed it, or it was superseded and nothing was submitted.
    const second = await requestedChanges('b-finish.md');
    const draft = await draftWithComment(second.document.id, 'local_user');
    const [finished, acceptedRace] = await Promise.all([
        api('POST', `/api/documents/reviews/${draft.id}/finish`, { summary: 'Second round' }, session),
        accept(second.document.id, { client_request_id: 'race', source: { decision_id: second.decision.id }, task_id: WORK_TASK }),
    ]);
    expect(acceptedRace.status).toBe(201);
    const after = db.documentReviews.getReview(draft.id);
    if (finished.status === 202) {
        expect(after.status).toBe('submitted');
        expect(acceptedRace.json.superseded_reviews).toEqual([]);
    } else {
        expect(finished).toMatchObject({ status: 409, json: { code: 'review_superseded' } });
        expect(after).toMatchObject({ status: 'superseded', replacement_id: acceptedRace.json.replacement.id });
        expect(acceptedRace.json.superseded_reviews).toEqual([draft.id]);
        expect(db.documentReviews.getSubmissionForReview(draft.id)).toBeFalsy();
    }

    // A decision and an acceptance in flight together: the decision wins (the cited request is then superseded) or the acceptance does (the decision is refused).
    const third = await requestedChanges('b-decide.md');
    const [decided, acceptedThird] = await Promise.all([
        decide(third.document.id, third.v1.id, 'approve'),
        accept(third.document.id, { client_request_id: 'race', source: { decision_id: third.decision.id }, task_id: WORK_TASK }),
    ]);
    expect([decided.status, acceptedThird.status].filter(s => s === 201)).toHaveLength(1);
    if (acceptedThird.status === 201) expect(decided).toMatchObject({ status: 409, json: { code: 'replacement_in_progress' } });
    else expect(acceptedThird).toMatchObject({ status: 409, json: { code: 'source_superseded' } });
});

test('only current, change-requesting authority opens work; stale, approving, unfinished or foreign sources are refused and nothing is recorded', async () => {
    const { document, file, v1, submission, decision } = await requestedChanges('c.md');
    const invalid = { status: 400, json: { code: 'invalid_replacement' } };
    expect(await accept(document.id, { source: { decision_id: decision.id } })).toMatchObject(invalid);
    expect(await accept(document.id, { client_request_id: 'k', source: {} })).toMatchObject(invalid);
    expect(await accept(document.id, { client_request_id: 'k' })).toMatchObject(invalid);
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id }, bogus: 1 })).toMatchObject(invalid);
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id, extra: 1 } })).toMatchObject(invalid);
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id }, state: 'ready' })).toMatchObject(invalid);
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id }, detail: 'x'.repeat(2001) })).toMatchObject(invalid);
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id }, task_id: 'no-such-task' })).toMatchObject({ status: 404, json: { code: 'task_not_found' } });
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: 'no-such-decision' } })).toMatchObject({ status: 404, json: { code: 'source_not_found' } });
    expect(await accept(document.id, { client_request_id: 'k', source: { submission_id: 'no-such-submission' } })).toMatchObject({ status: 404, json: { code: 'source_not_found' } });
    expect(await accept(document.id, { client_request_id: 'k', source: { review_id: 'no-such-review' } })).toMatchObject({ status: 404, json: { code: 'source_not_found' } });
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id } }, { headers: { 'sec-fetch-site': 'cross-site' } })).toMatchObject({ status: 403, json: { code: 'cross_site' } });
    expect((await accept('no-such-document', { client_request_id: 'k', source: { decision_id: decision.id } })).status).toBe(404);

    // Another document's authority never carries over, and a submission and review that disagree are refused.
    const other = await requestedChanges('c-other.md');
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: other.decision.id } })).toMatchObject({ status: 404, json: { code: 'source_not_found' } });
    expect(await accept(document.id, { client_request_id: 'k', source: { submission_id: other.submission.id } })).toMatchObject({ status: 404, json: { code: 'source_not_found' } });
    expect(await accept(document.id, { client_request_id: 'k', source: { submission_id: submission.id, review_id: other.review.id } })).toMatchObject(invalid);

    // An unfinished draft authorizes nothing; an approval is not a change request (approval without edits creates no work).
    const draft = await draftWithComment(document.id, 'second-reviewer');
    expect(await accept(document.id, { client_request_id: 'k', source: { review_id: draft.id } })).toMatchObject({ status: 409, json: { code: 'source_review_not_submitted', review_id: draft.id } });
    const approved = await decide(document.id, v1.id, 'approve');
    expect(approved.status).toBe(201);
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: approved.json.decision.id } })).toMatchObject({ status: 409, json: { code: 'source_not_change_request' } });
    // The earlier request is no longer the latest decision: it does not authorize work any more.
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id } })).toMatchObject({ status: 409, json: { code: 'source_superseded', decision: { id: approved.json.decision.id } } });

    // New bytes: authority pinned to the first version is stale for the second and is never reused.
    fs.writeFileSync(file, V2);
    const v2 = (await read(document.id)).json.revision;
    expect(v2.id).not.toBe(v1.id);
    expect(v2.version).toBe(2);
    expect(await accept(document.id, { client_request_id: 'k', source: { submission_id: submission.id } })).toMatchObject({ status: 409, json: { code: 'source_not_current', source_revision_id: v1.id, current_revision: { id: v2.id, version: 2 } } });
    const changesOnV2 = await decide(document.id, v2.id, 'request_changes', { note: 'Still wrong.' });
    expect(changesOnV2.status).toBe(201);
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: decision.id } })).toMatchObject({ status: 409, json: { code: 'source_not_current', source_revision_id: v1.id } });

    // Nothing was recorded by any refusal; the document stays reviewable as is and the draft is untouched.
    expect(db.documentReviews.listReplacements(document.id)).toEqual([]);
    expect((await read(document.id)).json.reviewable).toMatchObject({ ok: true, reason: null });
    expect(db.documentReviews.getReview(draft.id).status).toBe('draft');
    expect(await counts()).toMatchObject({ in_progress: 0, changes_requested: 2, all: 2 });
    // The decision on the current version does authorize work.
    expect(await accept(document.id, { client_request_id: 'k', source: { decision_id: changesOnV2.json.decision.id }, task_id: WORK_TASK })).toMatchObject({ status: 201, json: { replacement: { base_revision_id: v2.id, superseded_review_ids: [draft.id] } } });
});

test('a registration under the work task names the result; a QA pass on the current ready result completes the work and only the new version is reviewable', async () => {
    const { document, file, v1, submission, decision } = await requestedChanges('d.md');
    const rp = (await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id, decision_id: decision.id }, task_id: WORK_TASK, execution_id: 'exec-1' })).json.replacement;

    // Progress reports are separate from chat delivery and from the task's own board status.
    expect((await report(document.id, rp.id, { state: 'queued' })).json.replacement).toMatchObject({ state: 'queued', open: true });
    expect((await report(document.id, rp.id, { state: 'held', detail: 'Waiting on a scope ruling' })).json.replacement).toMatchObject({ state: 'held', detail: 'Waiting on a scope ruling' });
    expect((await report(document.id, rp.id, { state: 'running', execution_id: 'exec-2' })).json.replacement).toMatchObject({ state: 'running', execution_id: 'exec-2' });
    expect(await report(document.id, rp.id, {})).toMatchObject({ status: 400, json: { code: 'invalid_replacement' } });
    expect(await report(document.id, rp.id, { state: 'sideways' })).toMatchObject({ status: 400, json: { code: 'invalid_replacement' } });
    expect(await report(document.id, rp.id, { qa_state: 'maybe' })).toMatchObject({ status: 400, json: { code: 'invalid_replacement' } });
    expect(await report(document.id, rp.id, { task_id: OTHER_TASK })).toMatchObject({ status: 409, json: { code: 'task_already_linked' } });
    expect(await report(document.id, rp.id, { task_id: WORK_TASK })).toMatchObject({ status: 200, json: { duplicate: true } });
    expect((await report(document.id, 'no-such-item', { state: 'running' })).status).toBe(404);
    expect((await api('PATCH', `/api/documents/${document.id}/replacements/${rp.id}`, { state: 'running' }, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    // `ready` is verified, never trusted: nothing is registered yet.
    expect(await report(document.id, rp.id, { state: 'ready' })).toMatchObject({ status: 409, json: { code: 'result_not_ready', reason: 'no_result' } });
    expect(db.documentReviews.getReplacement(rp.id).state).toBe('running');

    // The work task registers the new bytes: the result is linked and the item is implemented, still not reviewable.
    fs.writeFileSync(file, V2);
    const registered = await register(file, { task_id: WORK_TASK });
    expect([200, 201]).toContain(registered.status);
    const v2 = registered.json.revision;
    expect(v2.id).not.toBe(v1.id);
    expect(registered.json.receipt).toMatchObject({ review_status: 'needs_review', revision_created: true, replacement: { id: rp.id, state: 'implemented', task_id: WORK_TASK } });
    expect((await read(document.id)).json).toMatchObject({ reviewable: { ok: false, reason: 'replacement_in_progress' }, replacement: { id: rp.id, state: 'implemented', result_revision_id: v2.id }, review_status: 'needs_review', version: { current_version: 2, revision_count: 2 } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v2.id })).toMatchObject({ status: 409, json: { code: 'replacement_in_progress' } });
    expect(await counts()).toMatchObject({ in_progress: 1, needs_review: 0, all: 1 });
    expect((await api('GET', `/api/documents/${document.id}/replacements/${rp.id}`)).json).toMatchObject({ result_is_current: true, result_is_ready: true, reviewable: false, replacement: { state: 'implemented' }, result_revision: { id: v2.id } });

    // QA passes: the result is current and ready, so the item completes and the new version opens for review.
    const passed = await report(document.id, rp.id, { state: 'qa_passed', qa_state: 'passed' });
    expect(passed.status).toBe(200);
    expect(passed.json).toMatchObject({ reviewable: true, review_status: 'needs_review', replacement: { state: 'ready', terminal: true, open: false, qa_state: 'passed', result_revision_id: v2.id } });
    expect(passed.json.replacement.completed_at).toBeTruthy();
    expect(passed.json.replacement.links.result_raw_path).toBe(`/api/documents/${document.id}/raw?revision=${v2.id}`);
    expect(await counts()).toMatchObject({ in_progress: 0, needs_review: 1, all: 1 });
    expect(await listIds('status=needs_review')).toEqual([document.id]);
    expect((await api('GET', '/api/documents?status=needs_review')).json.documents[0]).toMatchObject({ reviewable: true, replacement: null });
    const detail = (await read(document.id)).json;
    expect(detail).toMatchObject({ reviewable: { ok: true }, replacement: { id: rp.id, state: 'ready', terminal: true } });

    // A stale tab still naming the first version cannot open a review; the current version can, once per reviewer.
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v1.id })).toMatchObject({ status: 409, json: { code: 'stale_revision', revision_id: v1.id, current_revision: { id: v2.id, version: 2 } } });
    const opened = await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v2.id });
    expect(opened).toMatchObject({ status: 201, json: { created: true, review: { revision_id: v2.id, status: 'draft', is_current_revision: true } } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v2.id })).toMatchObject({ status: 200, json: { created: false, review: { id: opened.json.review.id } } });
    // Decisions: the old revision stays refused, the exact new revision takes one.
    expect(await decide(document.id, v1.id, 'approve')).toMatchObject({ status: 409, json: { code: 'stale_revision' } });
    expect(await decide(document.id, v2.id, 'approve', { content_hash: v2.content_hash })).toMatchObject({ status: 201, json: { review_status: 'approved' } });

    // The closed item is history: an identical report replays, anything else is refused.
    expect(await report(document.id, rp.id, { state: 'ready' })).toMatchObject({ status: 200, json: { duplicate: true } });
    expect(await report(document.id, rp.id, { state: 'running' })).toMatchObject({ status: 409, json: { code: 'replacement_closed' } });
    expect(await report(document.id, rp.id, { detail: 'rewrite history' })).toMatchObject({ status: 409, json: { code: 'replacement_closed' } });
    const h = await history(document.id);
    expect(h.revisions.map(r => [r.version, r.is_current])).toEqual([[1, false], [2, true]]);
    expect(h.replacements).toHaveLength(1);
    expect(h.replacements[0]).toMatchObject({ id: rp.id, state: 'ready', base_revision_id: v1.id, result_revision_id: v2.id });
    expect(h.current_version).toBe(2);
    expect(h.reviewable).toBe(true);
});

test('bytes captured by a plain read are never a result, and ready requires the registered result to be the current revision', async () => {
    const { document, file, v1, decision } = await requestedChanges('e.md');
    const rp = (await accept(document.id, { client_request_id: 'req', source: { decision_id: decision.id }, task_id: WORK_TASK })).json.replacement;

    // The executor is mid-write: a read captures the partial bytes as a revision, but the work item has no result.
    fs.writeFileSync(file, V2.slice(0, 40));
    const partial = (await read(document.id)).json;
    expect(partial.revision.id).not.toBe(v1.id);
    expect(partial.revision.version).toBe(2);
    expect(partial.replacement).toMatchObject({ id: rp.id, state: 'accepted', result_revision_id: null });
    expect(partial.reviewable.ok).toBe(false);
    expect(await report(document.id, rp.id, { state: 'ready' })).toMatchObject({ status: 409, json: { code: 'result_not_ready', reason: 'no_result' } });
    expect(await report(document.id, rp.id, { state: 'implemented', revision_id: v1.id })).toMatchObject({ status: 409, json: { code: 'result_is_base' } });
    expect(await report(document.id, rp.id, { revision_id: 'no-such-revision' })).toMatchObject({ status: 404, json: { code: 'revision_not_found' } });
    expect(db.documentReviews.getReplacement(rp.id)).toMatchObject({ state: 'accepted', result_revision_id: null });

    // The work names the partial capture explicitly, then the final bytes land: the named result is no longer current, so it is not ready.
    expect((await report(document.id, rp.id, { state: 'implemented', revision_id: partial.revision.id })).json.replacement).toMatchObject({ state: 'implemented', result_revision_id: partial.revision.id });
    fs.writeFileSync(file, V3);
    const v3 = (await read(document.id)).json.revision;
    expect(v3.version).toBe(3);
    expect(await report(document.id, rp.id, { state: 'ready' })).toMatchObject({ status: 409, json: { code: 'result_not_ready', reason: 'result_not_current', current_revision: { id: v3.id, version: 3 } } });
    expect(db.documentReviews.getReplacement(rp.id).state).toBe('implemented');

    // Registering the final bytes under the work task moves the result to them; ready is now verified against the current revision.
    const registered = await register(file, { task_id: WORK_TASK });
    expect(registered.json.revision.id).toBe(v3.id);
    expect(registered.json.receipt.replacement).toMatchObject({ id: rp.id, state: 'implemented' });
    expect(db.documentReviews.getReplacement(rp.id).result_revision_id).toBe(v3.id);
    expect(await report(document.id, rp.id, { state: 'ready' })).toMatchObject({ status: 200, json: { reviewable: true, replacement: { state: 'ready', result_revision_id: v3.id } } });
    expect((await read(document.id)).json).toMatchObject({ version: { current_version: 3, revision_count: 3 }, reviewable: { ok: true } });
    expect((await api('GET', `/api/documents/${document.id}/raw`)).json).toBe(V3);
});

test('the linked task closing reconciles the work: completed with a current result is ready, completed without one fails, cancelled cancels; recovery is an explicit new attempt', async () => {
    // Completed with the registered current result: ready, observed on the next read without a report.
    const a = await requestedChanges('f-a.md');
    const rpA = (await accept(a.document.id, { client_request_id: 'req', source: { decision_id: a.decision.id }, task_id: WORK_TASK })).json.replacement;
    fs.writeFileSync(a.file, V2);
    await register(a.file, { task_id: WORK_TASK });
    expect(db.documentReviews.getReplacement(rpA.id).state).toBe('implemented');
    await db.updateTask(WORK_TASK, { status: 'completed' });
    expect((await read(a.document.id)).json).toMatchObject({ reviewable: { ok: true }, review_status: 'needs_review', replacement: { id: rpA.id, state: 'ready', terminal: true } });

    // Completed without registering anything: failed, explicitly. The old version is reviewable again, with the failure on record and its decision unchanged.
    const b = await requestedChanges('f-b.md');
    const rpB = (await accept(b.document.id, { client_request_id: 'req', source: { submission_id: b.submission.id }, task_id: OTHER_TASK })).json.replacement;
    await db.updateTask(OTHER_TASK, { status: 'completed' });
    const afterB = (await read(b.document.id)).json;
    expect(afterB.replacement).toMatchObject({ id: rpB.id, state: 'failed', terminal: true });
    expect(afterB.replacement.detail).toMatch(/without registering a new revision/);
    expect(afterB.replacement.completed_at).toBeTruthy();
    expect(afterB.reviewable).toMatchObject({ ok: true });
    expect(afterB.review_status).toBe('changes_requested');
    expect(await counts()).toMatchObject({ in_progress: 0, changes_requested: 1, needs_review: 1, all: 2 });
    expect((await api('GET', '/api/documents?status=changes_requested')).json.documents[0]).toMatchObject({ id: b.document.id, reviewable: true, replacement: null });

    // Recovery must name the failed item; it is attempt 2 of the same request and closes the document again.
    expect(await accept(b.document.id, { client_request_id: 'req-2', source: { submission_id: b.submission.id } })).toMatchObject({ status: 409, json: { code: 'recovery_required', replacement: { id: rpB.id, state: 'failed' } } });
    expect(await accept(b.document.id, { client_request_id: 'req-2', source: { submission_id: b.submission.id }, recovers_replacement_id: 'nope' })).toMatchObject({ status: 409, json: { code: 'invalid_recovery' } });
    const recovered = await accept(b.document.id, { client_request_id: 'req-2', source: { submission_id: b.submission.id }, recovers_replacement_id: rpB.id });
    expect(recovered).toMatchObject({ status: 201, json: { replacement: { attempt: 2, recovers_replacement_id: rpB.id, state: 'accepted', task_id: null } } });
    expect((await read(b.document.id)).json.reviewable.ok).toBe(false);
    // The task is linked once, later; a second task is refused.
    expect((await report(b.document.id, recovered.json.replacement.id, { task_id: RECOVERY_TASK, state: 'queued' })).json.replacement).toMatchObject({ task_id: RECOVERY_TASK, state: 'queued', links: { task_path: `/task/${RECOVERY_TASK}` } });
    expect(await report(b.document.id, recovered.json.replacement.id, { task_id: WORK_TASK })).toMatchObject({ status: 409, json: { code: 'task_already_linked' } });
    expect(await report(b.document.id, recovered.json.replacement.id, { task_id: 'no-such-task' })).toMatchObject({ status: 409, json: { code: 'task_already_linked' } });
    // The linked task is cancelled: the work is cancelled on the next read and the document reopens, explicitly.
    await db.updateTask(RECOVERY_TASK, { status: 'cancelled' });
    expect((await read(b.document.id)).json).toMatchObject({ replacement: { state: 'cancelled', attempt: 2 }, reviewable: { ok: true } });

    // An explicit cancel report does the same; a closed item takes no further reports.
    const c = await requestedChanges('f-c.md');
    const rpC = (await accept(c.document.id, { client_request_id: 'req', source: { decision_id: c.decision.id } })).json.replacement;
    expect((await report(c.document.id, rpC.id, { state: 'cancelled', detail: 'Robert withdrew the request' })).json).toMatchObject({ reviewable: true, replacement: { state: 'cancelled', detail: 'Robert withdrew the request' } });
    expect(await report(c.document.id, rpC.id, { state: 'running' })).toMatchObject({ status: 409, json: { code: 'replacement_closed' } });
    // A failed attempt may also be reported directly, and its result is kept for the record.
    const d = await requestedChanges('f-d.md');
    const rpD = (await accept(d.document.id, { client_request_id: 'req', source: { decision_id: d.decision.id } })).json.replacement;
    expect((await report(d.document.id, rpD.id, { state: 'failed', detail: 'Build broke', qa_state: 'failed' })).json.replacement).toMatchObject({ state: 'failed', qa_state: 'failed', terminal: true });
    expect(await report(d.document.id, rpD.id, { revision_id: d.v1.id })).toMatchObject({ status: 409, json: { code: 'result_is_base' } });

    const h = await history(b.document.id);
    expect(h.replacements.map(r => [r.attempt, r.state, r.recovers_replacement_id])).toEqual([[2, 'cancelled', rpB.id], [1, 'failed', null]]);
    expect(h.reviewable).toBe(true);
    expect(await counts()).toMatchObject({ in_progress: 0, all: 4 });
});

test('the submission payload names the replacements endpoint, and an executor records the delegated approval on the exact new revision only once the work is ready', async () => {
    const { document, file, v1 } = await setup('g.md');
    const { review, submission } = await finishReview(document.id, { summary: 'just make this one change and then mark this document approved', grant: true });
    expect(review.approval_delegated).toBe(true);
    const stored = db.documentReviews.getSubmission(submission.id);
    expect(stored.payload.replacements_path).toBe(`/api/documents/${document.id}/replacements`);
    expect(stored.message_text).toContain(`POST /api/documents/${document.id}/replacements`);
    expect(stored.message_text).toContain(`source.submission_id: ${submission.id}`);
    expect(stored.message_text).toContain('a chat reply does not');

    const accepted = await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id }, task_id: WORK_TASK, execution_id: 'exec-0001' });
    expect(accepted.status).toBe(201);
    const rp = accepted.json.replacement;
    expect(rp.source).toMatchObject({ submission_id: submission.id, review_id: review.id, decision_id: null, authority: 'access_user', submission_delivery_status: 'queued' });
    expect(accepted.json.review_status).toBe('needs_review');

    fs.writeFileSync(file, V2);
    const v2 = (await register(file, { task_id: WORK_TASK })).json.revision;
    const executor = { executor: { ...EXECUTOR, source_submission_id: submission.id } };
    // The executor cannot record the approval while the work is open: the new version is not reviewable before QA passes.
    const early = await decide(document.id, v2.id, 'approve', { content_hash: v2.content_hash, client_decision_id: 'exec-1', ...executor }, executorCredential);
    expect(early).toMatchObject({ status: 409, json: { code: 'replacement_in_progress', replacement: { id: rp.id, state: 'implemented' } } });
    expect(db.documentReviews.listDecisions(document.id)).toEqual([]);
    expect((await report(document.id, rp.id, { state: 'qa_passed', qa_state: 'passed' })).json.replacement.state).toBe('ready');
    const recorded = await decide(document.id, v2.id, 'approve', { content_hash: v2.content_hash, client_decision_id: 'exec-1', ...executor }, executorCredential);
    expect(recorded).toMatchObject({ status: 201, json: { review_status: 'approved', decision: { decision: 'approve', revision_id: v2.id, content_hash: v2.content_hash, authority: 'document_executor_credential' } } });
    // The old revision takes no approval afterwards (the executor provenance check names the reviewed revision before the stale check does), and the receipt of the new one names the completed work.
    const oldRevision = await decide(document.id, v1.id, 'approve', { content_hash: v1.content_hash, client_decision_id: 'exec-2', ...executor }, executorCredential);
    expect(oldRevision.status).toBe(409);
    expect(['source_review_revision', 'stale_revision']).toContain(oldRevision.json.code);
    expect(db.documentReviews.listDecisions(document.id)).toHaveLength(1);
    // A byte-identical re-registration replays the first receipt (its revision_created stays true) and names the completed work; nothing new is created.
    const again = await register(file, { task_id: WORK_TASK });
    expect(again.json).toMatchObject({ duplicate: true, receipt: { revision_id: v2.id, review_status: 'approved', replacement: { id: rp.id, state: 'ready' } } });
    expect(db.documentReviews.listRevisionMeta(document.id)).toHaveLength(2);
});

test('lists, counts and detail agree across documents in every bucket; the in_progress bucket holds only open work', async () => {
    const open = await requestedChanges('h-open.md');
    const rp = (await accept(open.document.id, { client_request_id: 'req', source: { decision_id: open.decision.id }, task_id: WORK_TASK })).json.replacement;
    const waiting = await setup('h-waiting.md');
    const approved = await setup('h-approved.md');
    expect((await decide(approved.document.id, approved.v1.id, 'approve')).status).toBe(201);
    const changes = await requestedChanges('h-changes.md');
    const reference = await register(writeDoc('h-reference.md', V1), { deliverable: { requires_review: false } });
    expect(reference.status).toBe(201);

    expect(await counts()).toEqual({ needs_review: 1, changes_requested: 1, approved: 1, reference: 1, in_progress: 1, all: 5 });
    expect(await counts(`?project_id=${PROJECT_ID}`)).toEqual({ needs_review: 1, changes_requested: 1, approved: 1, reference: 1, in_progress: 1, all: 5 });
    expect(await counts('?q=install')).toMatchObject({ in_progress: 1, all: 5 });
    expect(await listIds('status=in_progress')).toEqual([open.document.id]);
    expect(await listIds('status=changes_requested')).toEqual([changes.document.id]);
    expect(await listIds('status=needs_review')).toEqual([waiting.document.id]);
    expect(await listIds('status=approved')).toEqual([approved.document.id]);
    expect(await listIds('status=reference')).toEqual([reference.json.document.id]);
    expect((await api('GET', '/api/documents?status=in_progress&limit=1&offset=0')).json).toMatchObject({ total: 1, has_more: false, status: 'in_progress' });
    const all = (await api('GET', '/api/documents?status=all')).json;
    expect(all.total).toBe(5);
    expect(all.documents.map(d => [d.id, d.reviewable, d.replacement?.state ?? null]).sort()).toEqual([
        [open.document.id, false, 'accepted'], [waiting.document.id, true, null], [approved.document.id, true, null], [changes.document.id, true, null], [reference.json.document.id, true, null],
    ].sort());
    expect((await api('GET', '/api/documents?status=bogus')).status).toBe(400);
    // The row, the detail and the history name the same open item.
    const row = all.documents.find(d => d.id === open.document.id);
    expect(row.replacement).toEqual({ id: rp.id, state: 'accepted', task_id: WORK_TASK, attempt: 1, open: true });
    expect((await read(open.document.id)).json.replacement.id).toBe(rp.id);
    expect((await history(open.document.id)).replacements[0].id).toBe(rp.id);
});

// ── QA repair round (2026-10-23): the concurrency and lifecycle defects an independent probe reproduced ──────────────────

/** Freeze the next task lookup for `taskId` until `release()`, so a request sits between its awaits and its write while another lands. */
function holdTaskLookup(taskId) {
    const original = db.getTask;
    let release;
    let signal;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { signal = resolve; });
    let intercepted = false;
    db.getTask = async function (id) {
        const task = await original.call(db, id);
        if (id === taskId && !intercepted) { intercepted = true; signal(); await gate; }
        return task;
    };
    return { entered, release, restore() { db.getTask = original; } };
}

test('a review racing a result promotion cannot open on the revision it overtook: currency is re-read inside the insert', async () => {
    const { document, file, v1, submission } = await requestedChanges('race-promotion.md');
    const rp = (await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id }, task_id: WORK_TASK })).json.replacement;
    // The review request is frozen in its reconcile step (the task lookup), having already captured v1 as current.
    const hold = holdTaskLookup(WORK_TASK);
    const pending = api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v1.id });
    await hold.entered;
    // Meanwhile the work registers v2 and declares it ready: v2 is the current, reviewable version now.
    fs.writeFileSync(file, V2);
    const v2 = (await register(file, { task_id: WORK_TASK })).json.revision;
    expect((await report(document.id, rp.id, { state: 'ready' })).json.replacement.state).toBe('ready');
    hold.release();
    const opened = await pending;
    hold.restore();
    expect(opened).toMatchObject({ status: 409, json: { code: 'stale_revision', revision_id: v1.id, current_revision: { id: v2.id, version: 2 } } });
    // No round exists on the overtaken revision; the next attempt opens on v2.
    expect((await history(document.id)).reviews.filter(r => r.status === 'draft')).toEqual([]);
    expect((await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v2.id })).json.review.revision_id).toBe(v2.id);
});

test('a failed attempt whose registered bytes are the current revision closes the version until an explicit recovery delivers a new one; the recovery cites the last reviewable version', async () => {
    const { document, file, submission, decision } = await requestedChanges('failed-result.md');
    const rp = (await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id }, task_id: WORK_TASK })).json.replacement;
    fs.writeFileSync(file, V2);
    const v2 = (await register(file, { task_id: WORK_TASK })).json.revision;
    expect(db.documentReviews.getReplacement(rp.id)).toMatchObject({ state: 'implemented', result_revision_id: v2.id });
    // QA rejects the new bytes: the attempt fails with its result on record, and v2, never declared ready, is closed.
    const failed = await report(document.id, rp.id, { state: 'failed', qa_state: 'failed', detail: 'QA rejected the new bytes' });
    expect(failed).toMatchObject({ status: 200, json: { reviewable: false, replacement: { state: 'failed', qa_state: 'failed', result_revision_id: v2.id } } });
    const detail = (await read(document.id)).json;
    expect(detail).toMatchObject({ revision: { id: v2.id, version: 2 }, reviewable: { ok: false, reason: 'replacement_failed', replacement_id: rp.id }, replacement: { id: rp.id, state: 'failed' } });
    // Neither a review nor a decision nor an edit touches the failed bytes; nothing is recorded.
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v2.id })).toMatchObject({ status: 409, json: { code: 'replacement_failed', replacement: { id: rp.id, state: 'failed' } } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, {}, { user: 'second_reviewer' })).toMatchObject({ status: 409, json: { code: 'replacement_failed' } });
    expect(await decide(document.id, v2.id, 'approve')).toMatchObject({ status: 409, json: { code: 'replacement_failed' } });
    expect(await api('PUT', `/api/documents/${document.id}/content`, { content: V3, base_revision_id: v2.id, summary: 'fix' }, operator)).toMatchObject({ status: 409, json: { code: 'replacement_failed' } });
    expect(db.documentReviews.listDecisions(document.id)).toHaveLength(1);
    expect(await history(document.id)).toMatchObject({ reviewable: false, current_version: 2 });
    // Lists and counts agree: the document sits in no review bucket, and its row names the failed attempt and is not reviewable.
    expect(await counts()).toMatchObject({ in_progress: 1, needs_review: 0, changes_requested: 0, all: 1 });
    expect((await api('GET', '/api/documents?status=in_progress')).json.documents[0]).toMatchObject({ id: document.id, reviewable: false, replacement: { id: rp.id, state: 'failed', open: false } });
    // The old authority is not reused silently: a plain re-acceptance must name the failed attempt.
    expect(await accept(document.id, { client_request_id: 'req-2', source: { submission_id: submission.id } })).toMatchObject({ status: 409, json: { code: 'recovery_required', replacement: { id: rp.id } } });
    // Explicit recovery cites the same review (pinned to v1, the last reviewable version) and replaces the failed bytes: attempt 2 on base v2.
    const recovered = await accept(document.id, { client_request_id: 'req-2', source: { submission_id: submission.id }, recovers_replacement_id: rp.id, task_id: RECOVERY_TASK });
    expect(recovered).toMatchObject({ status: 201, json: { reviewable: false, replacement: { attempt: 2, recovers_replacement_id: rp.id, base_revision_id: v2.id, state: 'accepted', task_id: RECOVERY_TASK } } });
    expect((await read(document.id)).json.reviewable).toMatchObject({ ok: false, reason: 'replacement_in_progress', replacement_id: recovered.json.replacement.id });
    // Its result reopens the document on v3; v2 stays on record as the failed attempt's result.
    fs.writeFileSync(file, V3);
    const v3 = (await register(file, { task_id: RECOVERY_TASK })).json.revision;
    expect(await report(document.id, recovered.json.replacement.id, { state: 'qa_passed', qa_state: 'passed' })).toMatchObject({ status: 200, json: { reviewable: true, replacement: { state: 'ready', result_revision_id: v3.id } } });
    expect((await read(document.id)).json).toMatchObject({ revision: { id: v3.id, version: 3 }, reviewable: { ok: true }, review_status: 'needs_review' });
    expect((await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v3.id })).json.review.revision_id).toBe(v3.id);
    expect(await counts()).toMatchObject({ in_progress: 0, needs_review: 1, all: 1 });
    const h = await history(document.id);
    expect(h.revisions.map(r => [r.version, r.is_current])).toEqual([[1, false], [2, false], [3, true]]);
    expect(h.replacements.map(r => [r.attempt, r.state, r.result_revision_id])).toEqual([[2, 'ready', v3.id], [1, 'failed', v2.id]]);
    // Once v3 is the reviewable version, the v1 decision is stale authority and starts no further work.
    expect(await accept(document.id, { client_request_id: 'req-3', source: { decision_id: decision.id } })).toMatchObject({ status: 409, json: { code: 'source_not_current', authority_revision_id: v3.id } });
});

test('a recovery that fails before registering anything leaves the closure with the attempt whose bytes are current: detail, refusals and the list row name that attempt, and the next recovery names the latest one', async () => {
    const { document, file, submission } = await requestedChanges('failed-recovery.md');
    const first = (await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id }, task_id: WORK_TASK })).json.replacement;
    fs.writeFileSync(file, V2);
    const v2 = (await register(file, { task_id: WORK_TASK })).json.revision;
    expect(await report(document.id, first.id, { state: 'failed', qa_state: 'failed', detail: 'QA rejected the new bytes' })).toMatchObject({ status: 200, json: { reviewable: false } });
    // The recovery is accepted on base v2, then fails before it registers anything.
    const second = (await accept(document.id, { client_request_id: 'req-2', source: { submission_id: submission.id }, recovers_replacement_id: first.id, task_id: RECOVERY_TASK })).json.replacement;
    expect(second).toMatchObject({ attempt: 2, base_revision_id: v2.id, result_revision_id: null });
    expect(await report(document.id, second.id, { state: 'failed', detail: 'the recovery crashed before registering anything' })).toMatchObject({ status: 200, json: { reviewable: false, replacement: { id: second.id, state: 'failed', result_revision_id: null } } });
    // v2 is still current and still closed by the first attempt: the reader, the refusals and the list row all name that attempt, not the latest one.
    expect((await read(document.id)).json).toMatchObject({ revision: { id: v2.id, version: 2 }, reviewable: { ok: false, reason: 'replacement_failed', replacement_id: first.id }, replacement: { id: first.id, state: 'failed', result_revision_id: v2.id, attempt: 1 } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, {})).toMatchObject({ status: 409, json: { code: 'replacement_failed', replacement: { id: first.id } } });
    expect((await api('GET', '/api/documents?status=in_progress')).json.documents[0]).toMatchObject({ id: document.id, reviewable: false, replacement: { id: first.id, state: 'failed', open: false } });
    expect(await counts()).toMatchObject({ in_progress: 1, needs_review: 0, changes_requested: 0, all: 1 });
    // History keeps both attempts; the next recovery must name the latest attempt for the source (the failed recovery), not the first.
    expect((await history(document.id)).replacements.map(r => [r.attempt, r.state, r.result_revision_id])).toEqual([[2, 'failed', null], [1, 'failed', v2.id]]);
    expect(await accept(document.id, { client_request_id: 'req-3', source: { submission_id: submission.id }, recovers_replacement_id: first.id, task_id: OTHER_TASK })).toMatchObject({ status: 409, json: { code: 'invalid_recovery' } });
    const third = await accept(document.id, { client_request_id: 'req-3b', source: { submission_id: submission.id }, recovers_replacement_id: second.id, task_id: OTHER_TASK });
    expect(third).toMatchObject({ status: 201, json: { replacement: { attempt: 3, base_revision_id: v2.id, state: 'accepted' } } });
    // With work open again the reader names the open item.
    expect((await read(document.id)).json).toMatchObject({ reviewable: { ok: false, reason: 'replacement_in_progress', replacement_id: third.json.replacement.id }, replacement: { id: third.json.replacement.id, state: 'accepted' } });
});

test('simultaneous task links: exactly one task links, the other report is refused with the linked task, and the same task again is a no-op', async () => {
    const { document, submission } = await requestedChanges('race-link.md');
    const rp = (await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id } })).json.replacement;
    // Both reports pass the pre-check (no task yet) and both pause in the task lookup; the write transaction decides.
    const original = db.getTask;
    let arrivals = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    db.getTask = async function (id) {
        const task = await original.call(db, id);
        if ((id === WORK_TASK || id === OTHER_TASK) && arrivals < 2) { arrivals += 1; if (arrivals === 2) release(); await barrier; }
        return task;
    };
    const results = await Promise.all([report(document.id, rp.id, { task_id: WORK_TASK }), report(document.id, rp.id, { task_id: OTHER_TASK })]);
    db.getTask = original;
    const won = results.find(r => r.status === 200);
    const lost = results.find(r => r.status === 409);
    expect(Boolean(won && lost)).toBe(true);
    const winner = won.json.replacement.task_id;
    expect(lost.json).toMatchObject({ code: 'task_already_linked', replacement: { id: rp.id, task_id: winner } });
    expect(db.documentReviews.getReplacement(rp.id).task_id).toBe(winner);
    expect(await report(document.id, rp.id, { task_id: winner })).toMatchObject({ status: 200, json: { duplicate: true, replacement: { task_id: winner } } });
    expect(await report(document.id, rp.id, { task_id: winner === WORK_TASK ? OTHER_TASK : WORK_TASK })).toMatchObject({ status: 409, json: { code: 'task_already_linked' } });
});

test('lists and counts reconcile a completed task before any document is opened, and agree with the detail read afterwards', async () => {
    const { document, file, submission } = await requestedChanges('reconcile-list.md');
    const rp = (await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id }, task_id: WORK_TASK })).json.replacement;
    fs.writeFileSync(file, V2);
    const v2 = (await register(file, { task_id: WORK_TASK })).json.revision;
    await db.updateTask(WORK_TASK, { status: 'completed' });
    // Nothing has read the document since the task closed: the counts alone reconcile the work to ready.
    const before = await counts();
    expect(before).toMatchObject({ in_progress: 0, needs_review: 1, all: 1 });
    expect(db.documentReviews.getReplacement(rp.id)).toMatchObject({ state: 'ready', result_revision_id: v2.id });
    const listed = (await api('GET', '/api/documents?status=needs_review')).json.documents;
    expect(listed.map(d => [d.id, d.reviewable, d.replacement])).toEqual([[document.id, true, null]]);
    expect(await listIds('status=in_progress')).toEqual([]);
    // The project view and the detail read agree, and opening the document changes no count.
    expect(await counts(`?project_id=${PROJECT_ID}`)).toEqual(before);
    expect((await read(document.id)).json).toMatchObject({ reviewable: { ok: true }, replacement: { id: rp.id, state: 'ready' } });
    expect(await counts()).toEqual(before);

    // A second document whose task completed without a result fails on the same list read and lists under its decision again.
    const other = await requestedChanges('reconcile-list-2.md');
    const rpOther = (await accept(other.document.id, { client_request_id: 'req', source: { submission_id: other.submission.id }, task_id: OTHER_TASK })).json.replacement;
    await db.updateTask(OTHER_TASK, { status: 'completed' });
    expect(await counts()).toMatchObject({ in_progress: 0, needs_review: 1, changes_requested: 1, all: 2 });
    expect(db.documentReviews.getReplacement(rpOther.id)).toMatchObject({ state: 'failed' });
    expect(await listIds('status=changes_requested')).toEqual([other.document.id]);
});

// Task 9f4477b5 (QA follow-up of 6b46dcc8): POST /:id/reviews answers for the version, not only when no draft exists yet.
test('no draft survives into open or failed work: acceptance closes a draft pinned to an older revision too, and the open route refuses even a draft that bypassed it', async () => {
    const { document, file, v1 } = await setup('draft-survival.md');
    // A second reviewer's round is opened on v1, then a plain capture (no replacement work) moves the document to v2.
    const older = await draftWithComment(document.id, 'second-reviewer');
    expect(older.revision_id).toBe(v1.id);
    fs.writeFileSync(file, V2);
    const v2 = (await read(document.id)).json.revision;
    expect(v2.version).toBe(2);
    // Robert reviews v2 and requests changes; Praxis accepts the work.
    const { submission } = await finishReview(document.id);
    expect(submission.revision_id).toBe(v2.id);
    expect((await decide(document.id, v2.id, 'request_changes', { note: 'Update the HWC row.' })).status).toBe(201);
    const accepted = await accept(document.id, { client_request_id: 'req', source: { submission_id: submission.id }, task_id: WORK_TASK });
    expect(accepted.status).toBe(201);
    const rp = accepted.json.replacement;
    // The acceptance closed the draft pinned to v1, not only drafts on v2: the second reviewer has no open draft left.
    expect(accepted.json.superseded_reviews).toEqual([older.id]);
    expect(db.documentReviews.getReview(older.id)).toMatchObject({ status: 'superseded', closed_reason: 'superseded', replacement_id: rp.id });
    expect(db.documentReviews.findOpenDraft(document.id, 'second-reviewer')).toBeFalsy();
    const inProgress = await api('POST', `/api/documents/${document.id}/reviews`, {}, { user: 'second-reviewer' });
    expect(inProgress).toMatchObject({ status: 409, json: { code: 'replacement_in_progress', replacement: { id: rp.id } } });
    // The refusal qualifies the reopening: only work that ends before registering a revision reopens this version.
    expect(inProgress.json.error).toMatch(/not reviewable until the new version is ready\. If the work fails or is cancelled before registering a new revision, this version reopens; if it registered one first, review waits for an explicit recovery attempt \(recovers_replacement_id\)\. Nothing was recorded/);
    expect(inProgress.json.error).not.toMatch(/ready or the work fails or is cancelled/);

    // A draft that bypassed the acceptance (written straight to the store) is refused, not handed back writable, with or without revision_id.
    const stray = db.documentReviews.insertReview({ document_id: document.id, revision_id: v2.id, reviewer_id: 'stray-reviewer' });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, {}, { user: 'stray-reviewer' })).toMatchObject({ status: 409, json: { code: 'replacement_in_progress', replacement: { id: rp.id } } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v2.id }, { user: 'stray-reviewer' })).toMatchObject({ status: 409, json: { code: 'replacement_in_progress' } });

    // The work registers v3 and then fails: its unaccepted result keeps the version closed, for the stray draft as for anyone.
    fs.writeFileSync(file, V3);
    const v3 = (await register(file, { task_id: WORK_TASK })).json.revision;
    expect(await report(document.id, rp.id, { state: 'failed', detail: 'QA rejected the new bytes' })).toMatchObject({ status: 200, json: { reviewable: false, replacement: { state: 'failed', result_revision_id: v3.id } } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, {}, { user: 'stray-reviewer' })).toMatchObject({ status: 409, json: { code: 'replacement_failed', replacement: { id: rp.id } } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v3.id }, { user: 'second-reviewer' })).toMatchObject({ status: 409, json: { code: 'replacement_failed' } });
    // No refusal opened or touched a round: the only draft is the stray row, unchanged.
    expect(db.documentReviews.listOpenDrafts(document.id).map(r => r.id)).toEqual([stray.id]);
    expect(db.documentReviews.getReview(stray.id).updated_at).toBe(stray.updated_at);
});

test('a draft left on an older revision by a plain capture is returned pinned to that revision and flagged, a new round opens only on the current one, and finishing it authorizes no work', async () => {
    const { document, file, v1 } = await setup('draft-plain-capture.md');
    const opened = await api('POST', `/api/documents/${document.id}/reviews`, {});
    expect(opened).toMatchObject({ status: 201, json: { created: true, review: { revision_id: v1.id, is_current_revision: true, document_changed: false } } });
    const draft = opened.json.review;
    expect((await api('POST', `/api/documents/reviews/${draft.id}/comments`, { kind: 'document', body: 'Started on v1.' })).status).toBe(201);
    // The file changes on disk and a read captures v2; no replacement work exists, so v2 is current and reviewable.
    fs.writeFileSync(file, V2);
    const detail = (await read(document.id)).json;
    const v2 = detail.revision;
    expect(detail).toMatchObject({ revision: { version: 2 }, reviewable: { ok: true }, replacement: null });

    // The open draft is returned as the caller's round, labelled with its own revision, never relabelled as v2.
    for (const body of [{}, { revision_id: v2.id }]) {
        const again = await api('POST', `/api/documents/${document.id}/reviews`, body);
        expect(again).toMatchObject({ status: 200, json: { created: false, review: { id: draft.id, status: 'draft', revision_id: v1.id, pinned_revision: { id: v1.id, version: 1 }, is_current_revision: false, document_changed: true, pinned_content: V1 } } });
    }
    // A tab still showing v1 is stale; another reviewer's new round opens on v2 only.
    expect(await api('POST', `/api/documents/${document.id}/reviews`, { revision_id: v1.id })).toMatchObject({ status: 409, json: { code: 'stale_revision', current_revision: { id: v2.id } } });
    expect(await api('POST', `/api/documents/${document.id}/reviews`, {}, { user: 'second-reviewer' })).toMatchObject({ status: 201, json: { review: { revision_id: v2.id, is_current_revision: true } } });

    // Finishing the v1 round is feedback on v1: it opens no work on v2 and records no decision on v1.
    const finished = await api('POST', `/api/documents/reviews/${draft.id}/finish`, { summary: 'Feedback on what I read.' }, session);
    expect(finished).toMatchObject({ status: 202, json: { submission: { revision_id: v1.id } } });
    expect(await accept(document.id, { client_request_id: 'req', source: { submission_id: finished.json.submission.id } })).toMatchObject({ status: 409, json: { code: 'source_not_current', source_revision_id: v1.id, authority_revision_id: v2.id } });
    expect(await decide(document.id, v1.id, 'request_changes', { note: 'on v1' })).toMatchObject({ status: 409, json: { code: 'stale_revision' } });
    expect(db.documentReviews.listReplacements(document.id)).toHaveLength(0);
    expect(db.documentReviews.listDecisions(document.id)).toHaveLength(0);
});
