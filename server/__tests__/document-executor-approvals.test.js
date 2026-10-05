/**
 * Executor-recorded document approvals (2026-10-04, task a2553798, repaired
 * the same day after QA): Robert's recurring "Approve with changes" review,
 * recorded by the executor that applied the change, with the document-scoped
 * executor credential and the review it acted on (contract:
 * docs/contracts/document-review-deliverables.md, section 6; pathway:
 * scripts/record-document-approval.js).
 *
 * Two QA findings shaped this suite. The delegation must rest on Robert's
 * explicit, authenticated grant: a review finished by the shared local_user
 * without operator proof, or without the approve-after-changes flag, is
 * feedback and never a source. And the executor's credential must be
 * document-scoped: a different key from Robert's operator credential, refused
 * by the stakeholder decision endpoints and unable to record a direct
 * decision or a grant.
 *
 * Isolated NEXUS_DB_PATH and temporary project roots. Delivery is a stub, the
 * Cloudflare Access signing keys are a local fixture and every credential is a
 * synthetic test value: nothing here reaches the live database, Praxis,
 * Cloudflare or the fleet env file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const access = require('./helpers/operator-access');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-0123456789abcdef';
const DOCUMENT_KEY = 'document-executor-test-credential-0123456789';
const RUNTIME_KEY = 'runtime-test-credential-0123456789abcdefgh';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_A = '22222222-2222-4222-8222-22222222222a';
const TASK_B = '22222222-2222-4222-8222-22222222222b';
const TASK_C = '22222222-2222-4222-8222-22222222222c';
const EXECUTOR = { id: 'praxis-claude-code:test-executor', task_id: TASK_B, execution_id: 'exec-0001' };
const AUTHORIZATION = 'ask-robert-81299292-0878-4db1-a108-a14cc332f5dc';
const INSTRUCTION = 'just make this one change and then mark this document approved';
const REFUSAL = 'Make the correction, but DO NOT approve this document. Return it to Robert for review.';
const SCRIPT = path.resolve(__dirname, '../../scripts/record-document-approval.js');

let db;
let base;
let server;
let workspace;
let projectRoot;
let delivery;
let restoreAccess;
let logSpy;

async function api(method, url, body, { user = 'local_user', headers = {} } = {}) {
    const all = { 'content-type': 'application/json', ...headers };
    if (user) all['x-test-user'] = user;
    const response = await nativeFetch(base + url, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, json: type.includes('application/json') ? await response.json() : await response.text() };
}

/** Robert's operator credential: his own authority (stakeholder approvals, direct document decisions). */
const operator = { headers: { authorization: `Bearer ${OPERATOR_KEY}` } };
/** The document-scoped executor credential: executor-recorded approvals citing his delegating review, nothing else. */
const executorCredential = { headers: { authorization: `Bearer ${DOCUMENT_KEY}` } };
/** Robert's verified Access sessions: a person login and the travel shell's device token. */
const session = { headers: { 'cf-access-jwt-assertion': access.token() } };
const device = { headers: { 'cf-access-jwt-assertion': access.serviceToken() } };
/** The shared local_user every local process carries: no operator proof at all. */
const unsigned = {};

function writeDoc(name, content) {
    const file = path.join(projectRoot, 'docs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

async function register(file, deliverable = {}) {
    return api('POST', '/api/documents', {
        path: file, title: 'Vitality memo', project_id: PROJECT_ID, task_id: TASK_A, kind: 'research',
        deliverable: { purpose: 'Decide whether the memo is ready', requires_review: true, intended_action: 'none', ...deliverable },
    });
}

async function decide(documentId, revisionId, extra = {}, options = operator, decision = 'approve') {
    return api('POST', `/api/documents/${documentId}/decisions`, { decision, revision_id: revisionId, ...extra }, options);
}

function executorFor(submission, extra = {}) {
    return { executor: { ...EXECUTOR, source_submission_id: submission.id, authorization_ref: AUTHORIZATION, ...extra } };
}

/** The executor records Robert's instruction: the document executor credential plus the block citing his submission. */
function recordAsExecutor(documentId, revisionId, submission, extra = {}, options = executorCredential) {
    return decide(documentId, revisionId, { ...executorFor(submission), ...extra }, options, extra.decision || 'approve');
}

/**
 * Robert's review round: open a review on the current revision (every local
 * process opens reviews as local_user), comment, and finish it with his
 * instruction. By default he finishes from his verified session with the
 * approve-after-changes grant; `grant: false` or other `options` model the
 * other callers. Returns the finished review and its submission.
 */
async function instruct(documentId, { summary = INSTRUCTION, comment = 'move this to the bottom as a reference.', grant = true, options = session } = {}) {
    const review = (await api('POST', `/api/documents/${documentId}/reviews`)).json.review;
    if (comment) await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: comment });
    const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary, ...(grant ? { approve_after_changes: true } : {}) }, options);
    expect(finished.status).toBe(202);
    return { review: finished.json.review, submission: finished.json.submission };
}

/** The producer rewrote the file; re-reading the document captures the resulting revision. */
async function rewrite(documentId, file, content) {
    fs.writeFileSync(file, content);
    const read = await api('GET', `/api/documents/${documentId}`);
    return read.json.revision;
}

function history(documentId) {
    return api('GET', `/api/documents/${documentId}/history`).then(r => r.json);
}

function approveLogLines() {
    return logSpy.mock.calls.map(call => call.join(' ')).filter(line => line.includes('[Documents] approve recorded'));
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-executor-approvals-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = DOCUMENT_KEY;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = RUNTIME_KEY;
    restoreAccess = access.configure({ deviceIds: access.deviceId });
    global.fetch = jest.fn(async (url, init) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks }
        : nativeFetch(url, init)));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Joey');
    fs.mkdirSync(projectRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'Joey Health App', path: projectRoot, description: 'Existing scope' });
    await db.createTask({ id: TASK_A, project_id: PROJECT_ID, name: 'Research memo', status: 'completed' });
    await db.createTask({ id: TASK_B, project_id: PROJECT_ID, name: 'Apply the review and record approval', status: 'in_progress' });
    delivery = { deliver: jest.fn(async () => null) };
    const createDocumentsRouter = require('../routes/documents');
    const createStakeholderRouters = require('../routes/stakeholders');
    const app = express();
    app.use(express.json({ strict: false }));
    // Like the server's authenticate middleware, every request is the local_user stub (the script sends no test header).
    app.use('/api/documents', (req, _res, next) => {
        req.user = { id: String(req.headers['x-test-user'] || 'local_user'), role: 'admin', is_service: req.headers['x-test-service'] === '1' };
        next();
    });
    app.use('/api/documents', createDocumentsRouter({ db, delivery }));
    // The product-scope surface the same bearer must never reach.
    const stakeholders = createStakeholderRouters({ db });
    app.use('/api/projects', stakeholders.projects);
    app.use('/api/tasks', stakeholders.tasks);
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

// ── Criterion 2: the instruction and grant survive the edit and the exact resulting revision is approved with provenance ──

test('an executor records Robert\'s "approve with changes" instruction as an approval of the exact resulting revision, carrying the instruction, his grant and the executor', async () => {
    const file = writeDoc('memo.md', '# Memo\n\nProvenance: prepared by the executor.\n\nBody.\n');
    const { json: { document, revision: v1 } } = await register(file);
    const { review, submission } = await instruct(document.id);
    expect(review).toMatchObject({ status: 'submitted', revision_id: v1.id, approval_delegated: true, submitted_authority: 'access_user' });
    // The submission Praxis receives says so, so the follow-up task knows it may record the approval.
    const delivered = (await api('GET', `/api/documents/reviews/${review.id}/submission?full=1`)).json.submission;
    expect(delivered.payload).toMatchObject({ approval_delegated: true, submitted_authority: 'access_user', summary: INSTRUCTION });
    expect(delivered.message_text).toContain('**Approval delegated**');
    expect(delivered.message_text).toContain(`citing submission ${submission.id}`);
    const v2 = await rewrite(document.id, file, '# Memo\n\nBody.\n\n## Reference\n\nProvenance: prepared by the executor.\n');
    expect(v2.id).not.toBe(v1.id);

    const recorded = await recordAsExecutor(document.id, v2.id, submission, { content_hash: v2.content_hash, note: 'Moved the provenance block as instructed.', client_decision_id: 'exec-1' });
    expect(recorded.status).toBe(201);
    expect(recorded.json.review_status).toBe('approved');
    expect(recorded.json.decision).toMatchObject({
        decision: 'approve', revision_id: v2.id, content_hash: v2.content_hash, actor_id: 'local_user',
        authority: 'document_executor_credential', recorded_by: 'executor', note: 'Moved the provenance block as instructed.', intended_action: 'none',
        provenance: {
            executor: { id: EXECUTOR.id, task_id: TASK_B, execution_id: 'exec-0001' },
            source: {
                review_id: review.id, submission_id: submission.id, revision_id: v1.id, revision_hash: v1.content_hash,
                reviewer_id: 'local_user', submitted_at: review.submitted_at, instruction: INSTRUCTION,
                comments: [expect.objectContaining({ kind: 'document', body: 'move this to the bottom as a reference.' })],
                delegation: { approval_delegated: true, authority: 'access_user', granted_at: review.submitted_at },
            },
            authorization_ref: AUTHORIZATION,
        },
    });
    const decisionId = recorded.json.decision.id;

    // The record is readable: the consumer check, the history and the document all agree, and the log names the recorder, never a key.
    const check = await api('GET', `/api/documents/${document.id}/decisions/${decisionId}`);
    expect(check.json).toMatchObject({ in_force: true, approved: true, reason: null, decision: { recorded_by: 'executor' } });
    const after = await history(document.id);
    expect(after.review_status).toBe('approved');
    expect(after.decisions).toEqual([expect.objectContaining({ id: decisionId, recorded_by: 'executor', provenance: expect.objectContaining({ source: expect.objectContaining({ submission_id: submission.id }) }) })]);
    expect((await api('GET', `/api/documents/${document.id}`)).json.current_decision).toMatchObject({ id: decisionId, applies_to_current_revision: true });
    expect(approveLogLines()).toEqual([expect.stringContaining(`(authority=document_executor_credential, recorded_by=executor ${EXECUTOR.id}, source_review=${review.id})`)]);
    const everything = logSpy.mock.calls.map(call => call.join(' ')).join('\n') + JSON.stringify([recorded.json, check.json, after, delivered]);
    expect(everything).not.toContain(OPERATOR_KEY);
    expect(everything).not.toContain(DOCUMENT_KEY);
    expect(logSpy.mock.calls.map(call => call.join(' ')).filter(line => line.includes('finished with approval delegated'))).toEqual([expect.stringContaining(`review ${review.id} finished with approval delegated (authority=access_user, submission=${submission.id})`)]);

    // Retrying is idempotent; the same attempt id for a different recorder or source is refused; the review authorizes one approval only.
    const replay = await recordAsExecutor(document.id, v2.id, submission, { content_hash: v2.content_hash, note: 'Moved the provenance block as instructed.', client_decision_id: 'exec-1' });
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true, decision: { id: decisionId } } });
    const otherExecutor = await recordAsExecutor(document.id, v2.id, submission, { content_hash: v2.content_hash, note: 'Moved the provenance block as instructed.', client_decision_id: 'exec-1', ...executorFor(submission, { id: 'someone-else' }) });
    expect(otherExecutor).toMatchObject({ status: 409, json: { code: 'idempotency_key_reused', decision: { id: decisionId } } });
    const asOperator = await decide(document.id, v2.id, { content_hash: v2.content_hash, note: 'Moved the provenance block as instructed.', client_decision_id: 'exec-1' });
    expect(asOperator).toMatchObject({ status: 409, json: { code: 'idempotency_key_reused' } });
    // Robert's operator credential cannot even replay an executor-recorded decision: the block is not its to carry.
    const operatorWithBlock = await recordAsExecutor(document.id, v2.id, submission, { content_hash: v2.content_hash, client_decision_id: 'exec-1' }, operator);
    expect(operatorWithBlock).toMatchObject({ status: 400, json: { code: 'invalid_provenance' } });
    const again = await recordAsExecutor(document.id, v2.id, submission, { client_decision_id: 'exec-2' });
    expect(again).toMatchObject({ status: 409, json: { code: 'source_review_consumed', decision: { id: decisionId } } });
    expect((await history(document.id)).decisions).toHaveLength(1);
    expect(delivery.deliver).toHaveBeenCalledTimes(1); // Finish review delivered Robert's instruction; the approval sent nothing.
    expect(fs.readFileSync(file, 'utf8')).toContain('## Reference');
});

// ── Criterion 2, QA finding A: the delegation rests on Robert's authenticated, explicit grant ──

test('an unsigned review, or a signed review without the approve-after-changes grant, is feedback and never the source of an executor-recorded approval; the grant itself needs Robert\'s operator proof', async () => {
    const file = writeDoc('memo.md', '# Memo\n\nThe figure in section 2 is wrong.\n');
    const { json: { document } } = await register(file);

    // The QA probe: the shared local_user (any local process) finishes a review that says the opposite of approval.
    const probe = await instruct(document.id, { summary: REFUSAL, grant: false, options: unsigned });
    expect(probe.review).toMatchObject({ status: 'submitted', summary: REFUSAL, approval_delegated: false, submitted_authority: null });
    const v2 = await rewrite(document.id, file, '# Memo\n\nThe figure in section 2 is corrected.\n');
    const executorAttempt = await recordAsExecutor(document.id, v2.id, probe.submission, { content_hash: v2.content_hash });
    expect(executorAttempt).toMatchObject({ status: 403, json: { code: 'source_review_not_delegated', source_review_id: probe.review.id, approval_delegated: false, submitted_authority: null } });
    expect(JSON.stringify(executorAttempt.json)).not.toContain(REFUSAL); // the refusal snapshots nothing of the review into a decision
    // The operator credential with the same block is refused earlier still: it is not the executor's credential.
    expect(await recordAsExecutor(document.id, v2.id, probe.submission, {}, operator)).toMatchObject({ status: 400, json: { code: 'invalid_provenance' } });
    expect(await history(document.id)).toMatchObject({ review_status: 'needs_review', decisions: [] });

    // An unsigned caller cannot grant: the finish is refused and the review stays an editable draft.
    const draft = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    expect(draft.status).toBe('draft');
    const forged = await api('POST', `/api/documents/reviews/${draft.id}/finish`, { summary: INSTRUCTION, approve_after_changes: true }, unsigned);
    expect(forged).toMatchObject({ status: 403, json: { code: 'operator_required' } });
    const grantRefusals = [
        ['the document executor credential (cannot grant to itself)', executorCredential, { approve_after_changes: true }, 403, 'operator_required'],
        ['the runtime key', { headers: { authorization: `Bearer ${RUNTIME_KEY}` } }, { approve_after_changes: true }, 403, 'operator_required'],
        ['a wrong bearer', { headers: { authorization: 'Bearer not-a-credential-000000000000000000000' } }, { approve_after_changes: true }, 403, 'operator_required'],
        ['a session behind the bridge token', { headers: { ...session.headers, 'x-praxis-bridge-token': 'bridge' } }, { approve_after_changes: true }, 403, 'operator_required'],
        ['a session with a service token header', { headers: { ...session.headers, 'cf-access-client-id': 'executor' } }, { approve_after_changes: true }, 403, 'operator_required'],
        ['a service user', { headers: { ...session.headers, 'x-test-service': '1' } }, { approve_after_changes: true }, 403, 'operator_required'],
        ['a cross-site request', { headers: { ...session.headers, 'sec-fetch-site': 'cross-site' } }, { approve_after_changes: true }, 403, 'cross_site'],
        ['a flag that is not a boolean', session, { approve_after_changes: 'yes' }, 400, 'invalid_grant'],
    ];
    for (const [label, options, body, status, code] of grantRefusals) {
        const response = await api('POST', `/api/documents/reviews/${draft.id}/finish`, { summary: INSTRUCTION, ...body }, options);
        expect({ label, status: response.status, code: response.json.code }).toEqual({ label, status, code });
    }
    expect((await api('GET', `/api/documents/reviews/${draft.id}`)).json.review).toMatchObject({ status: 'draft', approval_delegated: false, submitted_authority: null, submission: null });
    expect(delivery.deliver).toHaveBeenCalledTimes(1); // only the unsigned feedback round was delivered

    // Robert's session without the flag is feedback: it never becomes a source either, and records no proof.
    const feedbackOnly = await api('POST', `/api/documents/reviews/${draft.id}/finish`, { summary: 'Looks right, but I want to see it once more before approving.' }, session);
    expect(feedbackOnly.status).toBe(202);
    expect(feedbackOnly.json.review).toMatchObject({ status: 'submitted', approval_delegated: false, submitted_authority: null });
    expect((await api('GET', `/api/documents/reviews/${draft.id}/submission?full=1`)).json.submission.payload).toMatchObject({ approval_delegated: false, submitted_authority: null });
    const v3 = await rewrite(document.id, file, '# Memo\n\nThe figure in section 2 is corrected once more.\n');
    expect(await recordAsExecutor(document.id, v3.id, feedbackOnly.json.submission)).toMatchObject({ status: 403, json: { code: 'source_review_not_delegated', submitted_authority: null } });
    expect((await history(document.id)).decisions).toEqual([]);

    // With the grant from his verified session the same words authorize exactly one executor-recorded approval of the result.
    const granted = await instruct(document.id);
    expect(granted.review).toMatchObject({ approval_delegated: true, submitted_authority: 'access_user' });
    const v4 = await rewrite(document.id, file, '# Memo\n\nThe figure in section 2 is corrected, and moved as asked.\n');
    const recorded = await recordAsExecutor(document.id, v4.id, granted.submission, { content_hash: v4.content_hash });
    expect(recorded.status).toBe(201);
    expect(recorded.json.decision.provenance.source).toMatchObject({ review_id: granted.review.id, instruction: INSTRUCTION, delegation: { approval_delegated: true, authority: 'access_user', granted_at: granted.review.submitted_at } });
    expect((await history(document.id)).decisions.map(d => [d.decision, d.recorded_by, d.authority])).toEqual([['approve', 'executor', 'document_executor_credential']]);

    // The grant is Robert's from any of his proofs: the travel shell's device session and his operator credential record which one.
    const second = (await register(writeDoc('second.md', '# Second v1\n'))).json.document;
    const byDevice = await instruct(second.id, { options: device, comment: null });
    expect(byDevice.review).toMatchObject({ approval_delegated: true, submitted_authority: 'access_device' });
    const w2 = await rewrite(second.id, path.join(projectRoot, 'docs', 'second.md'), '# Second v2\n');
    expect((await recordAsExecutor(second.id, w2.id, byDevice.submission)).json.decision.provenance.source.delegation).toEqual({ approval_delegated: true, authority: 'access_device', granted_at: byDevice.review.submitted_at });
    const third = (await register(writeDoc('third.md', '# Third v1\n'))).json.document;
    const byCredential = await instruct(third.id, { options: operator, comment: null });
    expect(byCredential.review).toMatchObject({ approval_delegated: true, submitted_authority: 'operator_credential' });
    const x2 = await rewrite(third.id, path.join(projectRoot, 'docs', 'third.md'), '# Third v2\n');
    expect((await recordAsExecutor(third.id, x2.id, byCredential.submission)).json.decision.provenance.source.delegation).toMatchObject({ authority: 'operator_credential' });
});

// ── Criterion 3: unauthorized requests are refused, as is a block that does not point at Robert's instruction ──

test('an executor-recorded approval needs the document executor credential and Robert\'s delegating instruction; everything else is refused and nothing is recorded', async () => {
    const file = writeDoc('memo.md', '# Memo v1\n');
    const { json: { document } } = await register(file);
    const other = await register(writeDoc('other.md', '# Other v1\n'));
    const { submission: otherSubmission } = await instruct(other.json.document.id);
    const { review, submission } = await instruct(document.id);
    const v2 = await rewrite(document.id, file, '# Memo v2\n');
    const body = (extra = {}) => ({ content_hash: v2.content_hash, ...executorFor(submission), ...extra });

    const deny = [
        ['no credential', unsigned, {}, 403, 'operator_required'],
        ['a wrong bearer', { headers: { authorization: 'Bearer not-the-document-credential-00000000000' } }, {}, 403, 'operator_required'],
        ['the runtime key', { headers: { authorization: `Bearer ${RUNTIME_KEY}` } }, {}, 403, 'operator_required'],
        ["Robert's operator credential carrying executor provenance", operator, {}, 400, 'invalid_provenance'],
        ['the document credential behind the bridge token', { headers: { ...executorCredential.headers, 'x-praxis-bridge-token': 'bridge' } }, {}, 403, 'operator_required'],
        ['the document credential with a service token header', { headers: { ...executorCredential.headers, 'cf-access-client-id': 'executor' } }, {}, 403, 'operator_required'],
        ['a service user', { headers: { ...executorCredential.headers, 'x-test-service': '1' } }, {}, 403, 'operator_required'],
        ['a verified session carrying executor provenance', session, {}, 400, 'invalid_provenance'],
        ['the document credential without an executor block', executorCredential, { executor: undefined }, 403, 'executor_provenance_required'],
        ['the document credential requesting changes without a block', executorCredential, { executor: undefined, decision: 'request_changes' }, 403, 'executor_provenance_required'],
        ['an executor requesting changes', executorCredential, { decision: 'request_changes' }, 400, 'executor_decision_not_allowed'],
        ['a missing executor id', executorCredential, { executor: { source_submission_id: submission.id } }, 400, 'invalid_provenance'],
        ['an unknown executor field', executorCredential, { executor: { ...EXECUTOR, source_submission_id: submission.id, credential: 'x' } }, 400, 'invalid_provenance'],
        ['no source at all', executorCredential, { executor: { ...EXECUTOR } }, 400, 'invalid_provenance'],
        ['a control character in a field', executorCredential, { executor: { ...EXECUTOR, source_submission_id: submission.id, task_id: 'a\u0000b' } }, 400, 'invalid_provenance'],
        ['an executor block that is not an object', executorCredential, { executor: 'praxis' }, 400, 'invalid_provenance'],
        ['a review and submission that disagree', executorCredential, { executor: { ...EXECUTOR, source_submission_id: submission.id, source_review_id: 'another-review' } }, 400, 'invalid_provenance'],
        ['another document\'s submission', executorCredential, { executor: { ...EXECUTOR, source_submission_id: otherSubmission.id } }, 404, 'source_review_not_found'],
        ['an unknown submission', executorCredential, { executor: { ...EXECUTOR, source_submission_id: 'no-such-submission' } }, 404, 'source_review_not_found'],
        ['an unknown review', executorCredential, { executor: { ...EXECUTOR, source_review_id: 'no-such-review' } }, 404, 'source_review_not_found'],
    ];
    for (const [label, options, extra, status, code] of deny) {
        const response = await decide(document.id, v2.id, body(extra), options, extra.decision || 'approve');
        expect({ label, status: response.status, code: response.json.code }).toEqual({ label, status, code });
    }
    // A review that was never finished is not an instruction.
    const draft = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    expect(draft.status).toBe('draft');
    const unfinished = await decide(document.id, v2.id, body({ executor: { ...EXECUTOR, source_review_id: draft.id } }), executorCredential);
    expect(unfinished).toMatchObject({ status: 409, json: { code: 'source_review_not_submitted' } });
    // Credentials fail closed: an unconfigured document credential is refused, an unconfigured operator credential is reported,
    // and the two keys must differ or neither is accepted.
    delete process.env.NEXUS_DOCUMENT_APPROVAL_KEY;
    expect(await decide(document.id, v2.id, body(), executorCredential)).toMatchObject({ status: 403, json: { code: 'operator_required' } });
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = DOCUMENT_KEY;
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    expect(await decide(document.id, v2.id, { content_hash: v2.content_hash })).toMatchObject({ status: 503, json: { code: 'operator_credential_unconfigured' } });
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = OPERATOR_KEY;
    expect(await decide(document.id, v2.id, { content_hash: v2.content_hash })).toMatchObject({ status: 503, json: { code: 'operator_credential_unconfigured' } });
    expect(await decide(document.id, v2.id, body(), executorCredential)).toMatchObject({ status: 503, json: { code: 'operator_credential_unconfigured' } });
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = DOCUMENT_KEY;

    expect((await history(document.id)).decisions).toEqual([]);
    expect((await history(document.id)).review_status).toBe('needs_review');
    // The review itself is still the one Robert submitted, pinned to v1 and untouched by the refusals.
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review).toMatchObject({ status: 'submitted', summary: INSTRUCTION, document_changed: true, approval_delegated: true });
    // With the document credential and the real instruction the same request records.
    expect((await decide(document.id, v2.id, body(), executorCredential)).status).toBe(201);
});

// ── Criterion 3, QA finding B: the executor's credential is document-scoped ──

test('the document executor credential approves nothing but what Robert delegated: stakeholder decisions and receipts refuse it while the operator credential still decides them, and it cannot record a direct document decision', async () => {
    await db.createTask({ id: TASK_C, project_id: PROJECT_ID, name: 'Widen the product scope', status: 'blocked' });
    const proposed = await api('POST', `/api/tasks/${TASK_C}/stakeholder-proposal`, {
        kind: 'scope_change', member_id: null, content: { field: 'description', before: 'Existing scope', after: 'Much larger product scope', reason: 'Synthetic' },
    });
    expect(proposed.status).toBe(201);
    expect(proposed.json.proposal.state).toBe('proposed');
    const binding = { revision: proposed.json.proposal.revision, content_hash: proposed.json.proposal.content_hash };

    // The QA probe, with the credential the executor script reads: refused, and the proposal is untouched.
    const withDocumentKey = await api('POST', `/api/tasks/${TASK_C}/stakeholder-decision`, { decision: 'approve', ...binding }, executorCredential);
    expect(withDocumentKey.status).toBe(403);
    expect(withDocumentKey.json.error).toMatch(/Robert operator credential required/);
    expect((await api('GET', `/api/tasks/${TASK_C}/stakeholder-proposal`)).json.proposal.state).toBe('proposed');
    expect((await api('POST', `/api/tasks/${TASK_C}/stakeholder-decision`, { decision: 'reject', ...binding }, executorCredential)).status).toBe(403);
    // Nor is it the runtime credential: receipts refuse it too.
    expect((await api('POST', `/api/tasks/${TASK_C}/stakeholder-receipt`, { ...binding, state: 'applied', evidence: 'synthetic' }, executorCredential)).status).toBe(403);
    expect((await api('GET', `/api/tasks/${TASK_C}/stakeholder-proposal`)).json.proposal.state).toBe('proposed');

    // Robert's operator credential still decides product scope, as before.
    const withOperatorKey = await api('POST', `/api/tasks/${TASK_C}/stakeholder-decision`, { decision: 'approve', ...binding }, operator);
    expect(withOperatorKey.status).toBe(200);
    expect(withOperatorKey.json.proposal.state).toBe('approved');
    expect(withOperatorKey.json.proposal.decisions.at(-1)).toMatchObject({ state: 'approved', authority: 'operator_credential' });
    expect(withOperatorKey.json.gate).toMatchObject({ status: 'approved' });

    // On documents the document credential records nothing on its own: no direct approval, no request for changes, no grant.
    const file = writeDoc('memo.md', '# Memo v1\n');
    const { json: { document, revision: v1 } } = await register(file);
    expect(await decide(document.id, v1.id, { content_hash: v1.content_hash }, executorCredential)).toMatchObject({ status: 403, json: { code: 'executor_provenance_required' } });
    expect(await decide(document.id, v1.id, {}, executorCredential, 'request_changes')).toMatchObject({ status: 403, json: { code: 'executor_provenance_required' } });
    const draft = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    expect(await api('POST', `/api/documents/reviews/${draft.id}/finish`, { summary: INSTRUCTION, approve_after_changes: true }, executorCredential)).toMatchObject({ status: 403, json: { code: 'operator_required' } });
    expect(await history(document.id)).toMatchObject({ review_status: 'needs_review', decisions: [] });
    // And the operator credential still records a direct decision on the same document.
    expect((await decide(document.id, v1.id, { content_hash: v1.content_hash })).json.decision).toMatchObject({ authority: 'operator_credential', recorded_by: 'operator' });
});

test('the approval names the revision that resulted from the instruction: the reviewed revision itself, drifted bytes and stale revisions are refused', async () => {
    const file = writeDoc('memo.md', '# Memo v1\n');
    const { json: { document, revision: v1 } } = await register(file, { intended_action: 'implement' });
    const { submission } = await instruct(document.id);

    // Nothing changed yet: approving the very revision Robert reviewed is his own click, not an executor's.
    const unchanged = await recordAsExecutor(document.id, v1.id, submission, { content_hash: v1.content_hash });
    expect(unchanged).toMatchObject({ status: 409, json: { code: 'source_review_revision', source_revision_id: v1.id } });

    const v2 = await rewrite(document.id, file, '# Memo v2\n');
    expect((await recordAsExecutor(document.id, v2.id, submission, { content_hash: v1.content_hash })).json.code).toBe('content_mismatch');
    expect((await recordAsExecutor(document.id, v2.id, submission, { content_hash: '0'.repeat(64) })).json.code).toBe('content_mismatch');
    expect((await recordAsExecutor(document.id, 'no-such-revision', submission)).json.code).toBe('revision_not_found');
    // Approving the reviewed revision after the rewrite is refused on lineage before freshness; without provenance it is simply stale.
    expect((await recordAsExecutor(document.id, v1.id, submission)).json.code).toBe('source_review_revision');
    expect((await decide(document.id, v1.id)).json.code).toBe('stale_revision');

    // The file moved on again before the executor approved v2: the approval is refused and names the current revision.
    fs.writeFileSync(file, '# Memo v3\n');
    const stale = await recordAsExecutor(document.id, v2.id, submission, { content_hash: v2.content_hash });
    expect(stale).toMatchObject({ status: 409, json: { code: 'stale_revision', revision_id: v2.id } });
    const v3 = stale.json.current_revision;
    expect(v3.id).not.toBe(v2.id);
    expect((await history(document.id)).decisions).toEqual([]);

    // The resulting revision, as it stands now, is approved; its intended action is snapshotted.
    const approved = await recordAsExecutor(document.id, v3.id, submission, { content_hash: v3.content_hash });
    expect(approved.status).toBe(201);
    expect(approved.json.decision).toMatchObject({ revision_id: v3.id, recorded_by: 'executor', authority: 'document_executor_credential', intended_action: 'implement' });
    const check = await api('GET', `/api/documents/${document.id}/decisions/${approved.json.decision.id}`);
    expect(check.json).toMatchObject({ approved: true, in_force: true });
    expect(check.json.links.raw_path).toBe(`/api/documents/${document.id}/raw?revision=${v3.id}`);

    // New bytes never inherit the executor-recorded approval either.
    fs.writeFileSync(file, '# Memo v4\n');
    const reread = await api('GET', `/api/documents/${document.id}`);
    expect(reread.json.review_status).toBe('needs_review');
    expect((await api('GET', `/api/documents/${document.id}/decisions/${approved.json.decision.id}`)).json).toMatchObject({ in_force: false, approved: false, reason: 'document_changed' });
    // And the consumed review cannot be cited for the new bytes: Robert has to look again.
    expect((await recordAsExecutor(document.id, reread.json.revision.id, submission)).json.code).toBe('source_review_consumed');
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
});

test('Robert\'s own later decision or a newer review overrides the instruction an executor cites', async () => {
    const file = writeDoc('memo.md', '# Memo v1\n');
    const { json: { document } } = await register(file);
    const { submission: first } = await instruct(document.id);
    const v2 = await rewrite(document.id, file, '# Memo v2\n');

    // Robert looked at the result and asked for more: the executor's citation of the first review is superseded.
    const more = await decide(document.id, v2.id, { note: 'Also fix the heading.' }, session, 'request_changes');
    expect(more.status).toBe(201);
    expect(more.json.decision).toMatchObject({ authority: 'access_user', recorded_by: 'operator', provenance: null });
    const superseded = await recordAsExecutor(document.id, v2.id, first);
    expect(superseded).toMatchObject({ status: 409, json: { code: 'source_review_superseded', decision: { id: more.json.decision.id } } });

    // He reviews v2 with a new instruction; an executor must cite that one, not the first.
    const v3 = await rewrite(document.id, file, '# Memo v3\n');
    const { review: secondReview, submission: second } = await instruct(document.id, { summary: 'Heading fixed too; approve this.', comment: null });
    const v4 = await rewrite(document.id, file, '# Memo v4\n');
    const oldInstruction = await recordAsExecutor(document.id, v4.id, first);
    expect(oldInstruction).toMatchObject({ status: 409, json: { code: 'source_review_superseded' } });
    const latest = await recordAsExecutor(document.id, v4.id, second);
    expect(latest.status).toBe(201);
    expect(latest.json.decision.provenance.source).toMatchObject({ review_id: secondReview.id, revision_id: v3.id, instruction: 'Heading fixed too; approve this.', comments: [] });
    expect((await history(document.id)).decisions.map(d => [d.decision, d.recorded_by])).toEqual([['request_changes', 'operator'], ['approve', 'executor']]);

    // On another document Robert approved the result himself before the executor got to it: the executor reads that back instead of adding a row.
    const file2 = writeDoc('memo2.md', '# Second v1\n');
    const second2 = (await register(file2)).json.document;
    const { submission: sub2 } = await instruct(second2.id);
    const w2 = await rewrite(second2.id, file2, '# Second v2\n');
    const direct = await decide(second2.id, w2.id, {}, device);
    expect(direct.json.decision).toMatchObject({ authority: 'access_device', recorded_by: 'operator' });
    const redundant = await recordAsExecutor(second2.id, w2.id, sub2);
    expect(redundant).toMatchObject({ status: 409, json: { code: 'already_decided', decision: { id: direct.json.decision.id } } });
    expect((await history(second2.id)).decisions).toHaveLength(1);
    expect(delivery.deliver).toHaveBeenCalledTimes(3);
});

// ── Criterion 3: direct operator approvals are unchanged ──

test('direct operator decisions are unchanged: the operator credential alone records a plain operator decision and sessions decide as before', async () => {
    const file = writeDoc('memo.md', '# Memo v1\n');
    const { json: { document, revision: v1 } } = await register(file);
    const direct = await decide(document.id, v1.id, { client_decision_id: 'robert-1' });
    expect(direct.status).toBe(201);
    expect(direct.json.decision).toMatchObject({ authority: 'operator_credential', recorded_by: 'operator', provenance: null, actor_id: 'local_user' });
    expect(direct.json.review_status).toBe('approved');
    expect(await decide(document.id, v1.id, { client_decision_id: 'robert-1' })).toMatchObject({ status: 200, json: { duplicate: true } });
    expect(approveLogLines()).toEqual(['[Documents] approve recorded for ' + document.id + ' revision ' + v1.id + ' (authority=operator_credential)']);

    const v2 = await rewrite(document.id, file, '# Memo v2\n');
    const person = await decide(document.id, v2.id, { note: 'Tighten scope.' }, session, 'request_changes');
    expect(person.json.decision).toMatchObject({ authority: 'access_user', recorded_by: 'operator', provenance: null, note: 'Tighten scope.' });
    const asDevice = await decide(document.id, v2.id, {}, device);
    expect(asDevice.json.decision).toMatchObject({ authority: 'access_device', recorded_by: 'operator', provenance: null });
    expect((await history(document.id)).decisions.map(d => d.recorded_by)).toEqual(['operator', 'operator', 'operator']);
    expect((await api('GET', `/api/documents/${document.id}/decisions/${asDevice.json.decision.id}`)).json).toMatchObject({ approved: true, decision: { recorded_by: 'operator' } });
    // A plain finish from Robert's session is feedback, exactly as before: no grant, no proof recorded, delivered as usual.
    const feedback = await instruct(document.id, { summary: 'One more pass, please.', grant: false, comment: null });
    expect(feedback.review).toMatchObject({ status: 'submitted', approval_delegated: false, submitted_authority: null });
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    // A reference document still takes no decision from anyone, executor block or not.
    const reference = (await register(writeDoc('ref.md', '# Ref\n'), { requires_review: false })).json;
    expect((await decide(reference.document.id, reference.revision.id)).json.code).toBe('review_not_required');
});

// ── Criterion 1 and 4: the supported script is the executor's pathway, and it never prints a credential ──

/** Run the script as a separate process (asynchronously: the API it talks to lives in this process). */
function runScript(args, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT, '--api', base, ...args], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, FLEET_ENV_PATH: path.join(workspace, 'no-such-fleet-env'), ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => {
            let json = null;
            try { json = JSON.parse(stdout); } catch { json = null; }
            resolve({ status, stdout, stderr, json });
        });
    });
}

test('scripts/record-document-approval.js verifies the bytes, records the approval with the document credential and provenance, replays idempotently and never prints a credential', async () => {
    const file = writeDoc('memo.md', '# Memo v1\n\nProvenance line.\n');
    const { json: { document } } = await register(file);
    const { review, submission } = await instruct(document.id);
    const content = '# Memo v1\n\n## Reference\n\nProvenance line.\n';
    const v2 = await rewrite(document.id, file, content);
    const hash = require('crypto').createHash('sha256').update(Buffer.from(content)).digest('hex');
    expect(v2.content_hash).toBe(hash);
    const args = ['--document', document.id, '--source-submission', submission.id, '--executor', EXECUTOR.id, '--task', TASK_B, '--execution', 'exec-0001', '--expect-hash', hash];

    // Without the document credential nothing is attempted; the operator credential in the environment is not read at all.
    const noKey = await runScript(args, { NEXUS_OPERATOR_APPROVAL_KEY: OPERATOR_KEY });
    expect(noKey.status).toBe(2);
    expect(noKey.json).toMatchObject({ outcome: 'credential_unavailable', error: expect.stringContaining('NEXUS_DOCUMENT_APPROVAL_KEY') });
    expect((await history(document.id)).decisions).toEqual([]);

    // A dry run shows exactly what would be sent (no credential in it).
    const dry = await runScript([...args, '--dry-run'], { NEXUS_DOCUMENT_APPROVAL_KEY: DOCUMENT_KEY });
    expect(dry.status).toBe(0);
    expect(dry.json).toMatchObject({ outcome: 'dry_run', credential_available: true, verified: { raw_hash_matches: true, disk_hash_matches: true, expected_hash_matches: true } });
    expect(dry.json.body).toMatchObject({ decision: 'approve', revision_id: v2.id, content_hash: hash, executor: { id: EXECUTOR.id, task_id: TASK_B, execution_id: 'exec-0001', source_submission_id: submission.id, authorization_ref: AUTHORIZATION } });
    expect(dry.stdout + dry.stderr).not.toContain(DOCUMENT_KEY);
    expect((await history(document.id)).decisions).toEqual([]);

    // Robert's operator credential handed to the script as if it were the document credential is refused by the API: wrong key for the block.
    const operatorKey = await runScript(args, { NEXUS_DOCUMENT_APPROVAL_KEY: OPERATOR_KEY });
    expect(operatorKey.status).toBe(1);
    expect(operatorKey.json).toMatchObject({ outcome: 'refused', status: 400, response: { code: 'invalid_provenance' } });
    expect(operatorKey.stdout).not.toContain(OPERATOR_KEY);

    // The real run records the approval and reads it back.
    const run = await runScript(args, { NEXUS_DOCUMENT_APPROVAL_KEY: DOCUMENT_KEY });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({
        outcome: 'recorded', duplicate: false, review_status: 'approved',
        decision: {
            revision_id: v2.id, content_hash: hash, authority: 'document_executor_credential', recorded_by: 'executor',
            provenance: { source: { review_id: review.id, submission_id: submission.id, instruction: INSTRUCTION, delegation: { approval_delegated: true, authority: 'access_user' } } },
        },
        check: { in_force: true, approved: true, reason: null },
        history: { review_status: 'approved', decisions: [{ recorded_by: 'executor', authority: 'document_executor_credential', executor: EXECUTOR.id, source_submission_id: submission.id }] },
    });
    expect(run.stdout).not.toContain(DOCUMENT_KEY);
    expect(run.stdout).not.toContain(OPERATOR_KEY);

    // Running it again is a replay of the same decision, not a second row.
    const again = await runScript(args, { NEXUS_DOCUMENT_APPROVAL_KEY: DOCUMENT_KEY });
    expect(again.status).toBe(0);
    expect(again.json).toMatchObject({ outcome: 'already_recorded', duplicate: true, decision: { id: run.json.decision.id } });
    expect((await history(document.id)).decisions).toHaveLength(1);

    // A wrong credential is refused by the API and reported, with the history readback and still no secret in the output.
    const wrong = await runScript(args, { NEXUS_DOCUMENT_APPROVAL_KEY: 'not-the-document-credential-0000000000' });
    expect(wrong.status).toBe(1);
    expect(wrong.json).toMatchObject({ outcome: 'refused', status: 403, response: { code: 'operator_required' }, history: { decisions: [{ id: run.json.decision.id }] } });
    expect(wrong.stdout).not.toContain('not-the-document-credential');
});

/**
 * A proxy in front of the API that lets one route misbehave: forwards everything
 * to `base`, except that GET /decisions/:id answers as `mode` says.
 */
async function faultyProxy(mode) {
    const proxy = http.createServer(async (req, res) => {
        if (req.method === 'GET' && /\/api\/documents\/[^/]+\/decisions\/[^/]+$/.test(req.url)) {
            if (mode === 'unavailable') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"readback unavailable"}'); }
            if (mode === 'not_in_force') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ in_force: false, approved: false, reason: 'document_changed', file_state: 'ok' })); }
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = { ...req.headers };
        delete headers.host;
        delete headers['content-length'];
        const upstream = await nativeFetch(base + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !['content-encoding', 'transfer-encoding', 'content-length'].includes(k))));
        res.end(body);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${proxy.address().port}`, close: () => new Promise(resolve => proxy.close(resolve)) };
}

test('scripts/record-document-approval.js exits 5 when the approval is recorded but cannot be confirmed in force by the readback', async () => {
    const file = writeDoc('memo.md', '# Memo v1\n');
    const { json: { document } } = await register(file);
    const { submission } = await instruct(document.id);
    const v2 = await rewrite(document.id, file, '# Memo v2\n');
    const args = ['--document', document.id, '--source-submission', submission.id, '--executor', EXECUTOR.id, '--expect-hash', v2.content_hash];
    const env = { NEXUS_DOCUMENT_APPROVAL_KEY: DOCUMENT_KEY };

    // The readback route is down: the row was recorded, the exit code refuses to call it confirmed.
    const down = await faultyProxy('unavailable');
    const unconfirmed = await runScript(['--api', down.url, ...args], env);
    await down.close();
    expect(unconfirmed.status).toBe(5);
    expect(unconfirmed.json).toMatchObject({ outcome: 'recorded', confirmed: false, duplicate: false, check: { status: 503 }, error: expect.stringContaining('could not be confirmed'), history: { decisions: [{ recorded_by: 'executor' }] } });
    const decisionId = unconfirmed.json.decision.id;
    expect((await history(document.id)).decisions.map(d => d.id)).toEqual([decisionId]);

    // The readback answers but says the approval is no longer in force: still exit 5, on the idempotent replay too.
    const stale = await faultyProxy('not_in_force');
    const replay = await runScript(['--api', stale.url, ...args], env);
    await stale.close();
    expect(replay.status).toBe(5);
    expect(replay.json).toMatchObject({ outcome: 'already_recorded', confirmed: false, duplicate: true, decision: { id: decisionId }, check: { status: 200, in_force: false, reason: 'document_changed' } });

    // Straight to the API the same replay is confirmed and exits 0.
    const confirmed = await runScript(args, env);
    expect(confirmed.status).toBe(0);
    expect(confirmed.json).toMatchObject({ outcome: 'already_recorded', confirmed: true, check: { status: 200, in_force: true, approved: true } });
    expect((await history(document.id)).decisions).toHaveLength(1);
    expect(unconfirmed.stdout + replay.stdout + confirmed.stdout).not.toContain(DOCUMENT_KEY);
});

test('scripts/record-document-approval.js stops on drift: the bytes on disk or the producer\'s hash disagree with the current revision', async () => {
    const file = writeDoc('memo.md', '# Memo v1\n');
    const { json: { document } } = await register(file);
    const { submission } = await instruct(document.id);
    const v2 = await rewrite(document.id, file, '# Memo v2\n');
    const args = ['--document', document.id, '--source-submission', submission.id, '--executor', EXECUTOR.id];
    const env = { NEXUS_DOCUMENT_APPROVAL_KEY: DOCUMENT_KEY };

    // The producer's own hash is not the registered revision: nothing is sent.
    const mismatch = await runScript([...args, '--expect-hash', '0'.repeat(64)], env);
    expect(mismatch.status).toBe(3);
    expect(mismatch.json).toMatchObject({ outcome: 'revision_drift', verified: { revision_id: v2.id, expected_hash_matches: false, raw_hash_matches: true } });

    // The script re-reads the document, so an edit between registration and approval becomes the new current revision and the stale hash is refused.
    fs.writeFileSync(file, '# Memo v3 (unregistered edit)\n');
    const stale = await runScript([...args, '--expect-hash', v2.content_hash], env);
    expect(stale.status).toBe(3);
    expect(stale.json.verified.revision_id).not.toBe(v2.id);
    expect(stale.json.verified.expected_hash_matches).toBe(false);
    expect((await history(document.id)).decisions).toEqual([]);

    // Once the executor's hash is the registered current revision, the approval records.
    const current = (await api('GET', `/api/documents/${document.id}`)).json.revision;
    const ok = await runScript([...args, '--expect-hash', current.content_hash], env);
    expect(ok.status).toBe(0);
    expect(ok.json.decision).toMatchObject({ revision_id: current.id, recorded_by: 'executor', authority: 'document_executor_credential' });
    // A refusal with the real credential is reported as such: the review is consumed now.
    const consumed = await runScript([...args, '--client-id', 'second-attempt'], env);
    expect(consumed.status).toBe(1);
    expect(consumed.json).toMatchObject({ outcome: 'refused', status: 409, response: { code: 'source_review_consumed' } });
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
});
