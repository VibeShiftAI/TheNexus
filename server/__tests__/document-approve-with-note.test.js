/**
 * "Approve with changes" means approved (task 282c64fa, 2026-11-23).
 *
 * Finishing a review with the checkbox records Robert's own approval of the
 * exact revision he read, with his summary and comments as its note. It opens
 * no replacement work, produces no new version and never returns the document
 * to needs_review. A review finished under the old rule keeps the lifecycle it
 * started with, and stored executor-recorded approvals stay readable.
 *
 * Isolated NEXUS_DB_PATH and temporary project roots. Delivery is a stub, the
 * Cloudflare Access signing keys are a local fixture and every credential is a
 * synthetic test value: nothing here reaches the live database or Praxis.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const Database = require('better-sqlite3');
const access = require('./helpers/operator-access');
const { markFinishedUnderOldRule } = require('./helpers/legacy-approval-grant');
const { robertAsks } = require('./helpers/review-ground');

const nativeFetch = global.fetch;
const OPERATOR_KEY = 'operator-test-credential-0123456789abcdef';
const DOCUMENT_KEY = 'document-executor-test-credential-0123456789';
const RUNTIME_KEY = 'runtime-test-credential-0123456789abcdefgh';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_TASK = '22222222-2222-4222-8222-22222222222a';
const WORK_TASK = '22222222-2222-4222-8222-22222222222b';
const EXECUTOR = { id: 'praxis-claude-code:test-executor', task_id: WORK_TASK, execution_id: 'exec-0001' };
const BODY = '# Working steps\n\nFirst paragraph.\n\nThe second paragraph.\n';
const SUMMARY = 'Approved. Separately, remove the boilerplate sentence from the chat.';
const NOTE = [
    SUMMARY,
    '',
    'Comments (2):',
    '1. Whole document: Clear enough.',
    '2. On line 5 ("The second paragraph."): Keep this one.',
    '   Reply: On reflection, yes.',
].join('\n');

let db;
let base;
let server;
let workspace;
let projectRoot;
let delivery;
let restoreAccess;
/** Robert's chat request to see the design (saved per test): the review ground registrations name (contract §15). */
let askGround;

async function api(method, url, body, { user = 'local_user', headers = {} } = {}) {
    const response = await nativeFetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': user, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, json: type.includes('application/json') ? await response.json() : await response.text() };
}

const session = { headers: { 'cf-access-jwt-assertion': access.token() } };
const device = { headers: { 'cf-access-jwt-assertion': access.serviceToken() } };
const operator = { headers: { authorization: `Bearer ${OPERATOR_KEY}` } };
const executorCredential = { headers: { authorization: `Bearer ${DOCUMENT_KEY}` } };
const runtime = { headers: { authorization: `Bearer ${RUNTIME_KEY}` } };
const unsigned = {};

function writeDoc(name, content = BODY) {
    const file = path.join(projectRoot, 'docs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

/** A request for review names Robert's own request as its ground (contract §15) unless the deliverable names another. */
function register(file, { task_id = SOURCE_TASK, deliverable = {}, ...extra } = {}) {
    const declared = { purpose: 'Decide whether the design is right', requires_review: true, intended_action: 'none', ...deliverable };
    return api('POST', '/api/documents', {
        path: file, title: 'Chat working steps', project_id: PROJECT_ID, task_id, kind: 'design',
        deliverable: declared.requires_review && declared.review_ground === undefined ? { ...declared, review_ground: askGround } : declared,
        ...extra,
    });
}

async function setup(name = 'steps.md', content = BODY, options = {}) {
    const file = writeDoc(name, content);
    const registered = await register(file, options);
    expect(registered.status).toBe(201);
    return { file, document: registered.json.document, v1: registered.json.revision };
}

const read = documentId => api('GET', `/api/documents/${documentId}`).then(r => r.json);
const history = documentId => api('GET', `/api/documents/${documentId}/history`).then(r => r.json);
const reviewOf = reviewId => api('GET', `/api/documents/reviews/${reviewId}`).then(r => r.json.review);
const comment = (reviewId, body) => api('POST', `/api/documents/reviews/${reviewId}/comments`, body);
const finish = (reviewId, body, options = session) => api('POST', `/api/documents/reviews/${reviewId}/finish`, body, options);
const approveWithNote = (reviewId, summary = SUMMARY, options = session) => finish(reviewId, { summary, approve_after_changes: true }, options);
const accept = (documentId, body) => api('POST', `/api/documents/${documentId}/replacements`, body);
const report = (documentId, replacementId, body) => api('PATCH', `/api/documents/${documentId}/replacements/${replacementId}`, body);
const decide = (documentId, body, options = operator) => api('POST', `/api/documents/${documentId}/decisions`, body, options);
const fullSubmission = reviewId => api('GET', `/api/documents/reviews/${reviewId}/submission?full=1`).then(r => r.json.submission);
const linkWork = (documentId, submission, client = submission.id) => accept(documentId, { client_request_id: client, source: { submission_id: submission.id }, task_id: WORK_TASK, execution_id: 'exec-0001' });

async function open(documentId) {
    const opened = await api('POST', `/api/documents/${documentId}/reviews`);
    expect(opened.status).toBe(201);
    return opened.json.review;
}

/** A round with a whole-document comment, a passage comment and a reply: everything the note has to keep. */
async function reviewWithComments(documentId) {
    const review = await open(documentId);
    expect((await comment(review.id, { kind: 'document', body: 'Clear enough.' })).status).toBe(201);
    const passage = await comment(review.id, { kind: 'passage', start_line: 5, end_line: 5, quote: 'The second paragraph.', body: 'Keep this one.' });
    expect(passage.status).toBe(201);
    expect((await comment(review.id, { kind: 'document', parent_id: passage.json.comment.id, body: 'On reflection, yes.' })).status).toBe(201);
    return review;
}

/**
 * A review finished before this change: the row and its payload carry the old
 * approve-after-changes grant and no approval was recorded at finish.
 */
async function finishedUnderTheOldRule(documentId, summary = 'Trim the second paragraph, then mark this approved.') {
    const review = await open(documentId);
    expect((await finish(review.id, { summary })).status).toBe(202);
    const submission = markFinishedUnderOldRule(db.documentReviews, review.id);
    return { review: db.documentReviews.getReview(review.id), submission };
}

function submissionsFor(reviewId) {
    const raw = new Database(process.env.NEXUS_DB_PATH, { readonly: true });
    try {
        return raw.prepare('SELECT COUNT(*) AS n FROM document_review_submissions WHERE review_id = ?').get(reviewId).n;
    } finally {
        raw.close();
    }
}

function png(width, height, rgb) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
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
    const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, () => Buffer.from(rgb))]);
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function designPackage() {
    const dir = path.join(projectRoot, 'docs', 'design');
    fs.mkdirSync(path.join(dir, 'export'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'export', 'a.png'), png(2, 2, [1, 2, 3]));
    fs.writeFileSync(path.join(dir, 'export', 'b.png'), png(2, 2, [4, 5, 6]));
    const file = path.join(dir, 'steps.design.json');
    fs.writeFileSync(file, JSON.stringify({
        format: 'nexus-design-package/1', title: 'Working steps', summary: 'Two directions.',
        directions: [{ id: '1a', title: 'Hairline', recommended: true }, { id: '1b', title: 'Masthead' }],
        screens: [
            { id: 'S1-a', title: 'Steps', direction: '1a', appearance: 'light', file: 'export/a.png' },
            { id: 'S1-b', title: 'Steps', direction: '1b', appearance: 'light', file: 'export/b.png' },
        ],
    }, null, 2));
    return file;
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-approve-with-note-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = OPERATOR_KEY;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = DOCUMENT_KEY;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = RUNTIME_KEY;
    restoreAccess = access.configure({ deviceIds: access.deviceId });
    global.fetch = jest.fn(async (url, init) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks }
        : nativeFetch(url, init)));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Project');
    fs.mkdirSync(projectRoot, { recursive: true });
    await db.upsertProject({ id: PROJECT_ID, name: 'Praxis', path: projectRoot, description: 'Existing scope' });
    await db.createTask({ id: SOURCE_TASK, project_id: PROJECT_ID, name: 'Chat steps design', status: 'completed' });
    await db.createTask({ id: WORK_TASK, project_id: PROJECT_ID, name: 'Revise the design', status: 'in_progress' });
    askGround = await robertAsks(db, 'Show me the chat working steps design.');
    delivery = { deliver: jest.fn(async () => null) };
    const createDocumentsRouter = require('../routes/documents');
    const { createAgentReviewsRouter } = require('../routes/document-agent-reviews');
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/documents', (req, _res, next) => {
        req.user = { id: String(req.headers['x-test-user'] || 'local_user'), role: 'admin' };
        next();
    });
    app.use('/api/documents', createAgentReviewsRouter({ db }));
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
    delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

// ── Criterion 1: the old rule opened revision work from this submission; the new rule opens none ──

test('finishing with the checkbox approves the reviewed version, and the same submission opens no replacement work', async () => {
    const { document, v1 } = await setup();
    const review = await reviewWithComments(document.id);
    const finished = await approveWithNote(review.id);
    expect(finished.status).toBe(202);
    const { submission } = finished.json;

    // What Praxis did with this submission under the old rule: link replacement work to it.
    const linked = await linkWork(document.id, submission);
    const after = await read(document.id);
    const record = await history(document.id);
    expect({
        revision_work: { status: linked.status, code: linked.json.code ?? null, replacements: record.replacements.length },
        document: { review_status: after.review_status, current_revision_id: after.revision.id, versions: record.revisions.length, reviewable: after.reviewable.ok },
        decisions: record.decisions.map(d => ({ decision: d.decision, revision_id: d.revision_id, recorded_by: d.recorded_by, authority: d.authority })),
    }).toEqual({
        revision_work: { status: 409, code: 'source_not_change_request', replacements: 0 },
        document: { review_status: 'approved', current_revision_id: v1.id, versions: 1, reviewable: true },
        decisions: [{ decision: 'approve', revision_id: v1.id, recorded_by: 'operator', authority: 'access_user' }],
    });
    // The identifier-only notification still goes out, once.
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(submission.id);
    // The log names the approval and its proof.
    const logged = console.log.mock.calls.map(call => call.join(' ')).filter(line => line.includes('finished with approval of revision'));
    expect(logged).toEqual([expect.stringContaining(`review ${review.id} finished with approval of revision ${v1.id} recorded (authority=access_user, submission=${submission.id})`)]);
});

// ── Criteria 2 and 3: the approval is his, on the exact revision, and the note is on every read path ──

test('his summary and every comment stay with the approval on the document read, its history and the review package', async () => {
    const { document, v1 } = await setup();
    const review = await reviewWithComments(document.id);
    const finished = await approveWithNote(review.id);
    expect(finished.status).toBe(202);
    const decisionId = finished.json.review.approval_decision_id;
    expect(typeof decisionId).toBe('string');
    expect(finished.json.review).toMatchObject({ status: 'submitted', submitted_authority: 'access_user', approval_delegated: false });

    const page = await read(document.id);
    expect(page.review_status).toBe('approved');
    expect(page.document.current_revision_id).toBe(v1.id);
    expect(page.current_decision).toMatchObject({
        id: decisionId, decision: 'approve', revision_id: v1.id, content_hash: v1.content_hash, actor_id: 'local_user', authority: 'access_user',
        recorded_by: 'operator', note: NOTE, applies_to_current_revision: true,
        provenance: { source: { kind: 'review_finish', review_id: review.id, submission_id: finished.json.submission.id, revision_id: v1.id, summary: SUMMARY } },
    });
    expect(page.current_decision.provenance.source.comments.map(c => c.body)).toEqual(['Clear enough.', 'Keep this one.', 'On reflection, yes.']);

    const record = await history(document.id);
    expect(record.decisions).toEqual([expect.objectContaining({ id: decisionId, note: NOTE })]);

    // The in-force check a downstream consumer reads, and the package Praxis fetches from the identifier-only notification.
    const check = await api('GET', `/api/documents/${document.id}/decisions/${decisionId}`);
    expect(check.json).toMatchObject({ in_force: true, approved: true, decision: { note: NOTE } });
    const pkg = await api('GET', `/api/documents/${document.id}/submissions/${finished.json.submission.id}/package`, undefined, runtime);
    expect(pkg.status).toBe(200);
    expect(pkg.json.decisions).toEqual([expect.objectContaining({ id: decisionId, decision: 'approve', note: NOTE })]);
    expect(pkg.json.feedback).toMatchObject({
        approval_delegated: false,
        approval: { decision_id: decisionId, decision: 'approve', revision_id: v1.id, content_hash: v1.content_hash, authority: 'access_user', note: NOTE },
    });

    // The saved relay text says what happened and no longer promises an executor or a revision.
    const stored = await fullSubmission(review.id);
    expect(stored.message_text).toContain('**Approved by Robert**');
    expect(stored.message_text).toContain('His summary and comments stay with the approval as its note.');
    expect(stored.message_text).not.toContain('Approval delegated');
    expect(stored.message_text).not.toContain('record-document-approval');
    expect(stored.message_text).not.toContain('Replacement work for this review');
});

test('an approval with no summary and no comments carries an empty note', async () => {
    const { document, v1 } = await setup();
    const review = await open(document.id);
    const finished = await finish(review.id, { approve_after_changes: true });
    expect(finished.status).toBe(202);
    expect((await read(document.id)).current_decision).toMatchObject({ decision: 'approve', revision_id: v1.id, note: '' });
    const stored = await fullSubmission(review.id);
    expect(stored.payload.approval).toMatchObject({ note: '' });
    // The relay text does not claim a note he never wrote.
    expect(stored.message_text).toContain('**Approved by Robert**');
    expect(stored.message_text).not.toMatch(/as its note/);
});

test('every proof Robert has records the approval as his, and the note keeps a long summary whole', async () => {
    const long = `${'A sentence that has to survive. '.repeat(600)}The end.`;
    expect(long.length).toBeGreaterThan(19000);
    for (const [name, options, authority] of [['a.md', device, 'access_device'], ['b.md', operator, 'operator_credential']]) {
        const { document } = await setup(name);
        const review = await open(document.id);
        const finished = await approveWithNote(review.id, long, options);
        expect(finished.status).toBe(202);
        expect((await read(document.id)).current_decision).toMatchObject({ authority, recorded_by: 'operator', note: long.trim() });
    }
});

// ── The safeguards are structural: one approval per submission, however often it is replayed ──

test('a replayed or racing finish records one approval, and the approval key cannot be used by a direct decision', async () => {
    const { document, v1 } = await setup();
    const review = await open(document.id);
    const raced = await Promise.all([approveWithNote(review.id), approveWithNote(review.id), approveWithNote(review.id)]);
    expect(raced.map(r => r.status).sort()).toEqual([200, 200, 202]);
    expect(new Set(raced.map(r => r.json.submission.id)).size).toBe(1);
    const replay = await approveWithNote(review.id);
    expect(replay).toMatchObject({ status: 200, json: { duplicate: true } });
    expect(replay.json.submission.id).toBe(raced[0].json.submission.id);
    expect((await history(document.id)).decisions).toHaveLength(1);
    expect(submissionsFor(review.id)).toBe(1);

    const forged = await decide(document.id, { decision: 'approve', revision_id: v1.id, client_decision_id: `review-finish:${review.id}` });
    expect(forged).toMatchObject({ status: 400, json: { code: 'invalid_decision' } });
    const other = await decide(document.id, { decision: 'approve', revision_id: v1.id, client_decision_id: 'review-finish:another-round' });
    expect(other).toMatchObject({ status: 400, json: { code: 'invalid_decision' } });
    expect((await history(document.id)).decisions).toHaveLength(1);
});

// ── The same requirements the grant had: his own proof, the bytes he read, a version open to review ──

test('only Robert\'s own proof can approve at finish; every other caller is refused and the draft survives', async () => {
    const { document } = await setup();
    const review = await open(document.id);
    await comment(review.id, { kind: 'document', body: 'Still mine.' });
    for (const [label, options, status, code] of [
        ['the shared local_user', unsigned, 403, 'operator_required'],
        ['the document executor credential', executorCredential, 403, 'operator_required'],
        ['the runtime key', runtime, 403, 'operator_required'],
        ['a session behind the bridge token', { headers: { ...session.headers, 'x-praxis-bridge-token': 'bridge' } }, 403, 'operator_required'],
        ['a cross-site request', { headers: { ...session.headers, 'sec-fetch-site': 'cross-site' } }, 403, 'cross_site'],
    ]) {
        const refused = await approveWithNote(review.id, SUMMARY, options);
        expect({ label, status: refused.status, code: refused.json.code }).toEqual({ label, status, code });
    }
    expect(await reviewOf(review.id)).toMatchObject({ status: 'draft', approval_delegated: false, submission: null });
    expect((await history(document.id)).decisions).toEqual([]);
    expect(delivery.deliver).not.toHaveBeenCalled();
});

test('an approval rests on the exact bytes he read: stale, missing and closed versions are refused and his draft is kept', async () => {
    // The file changed after he opened the round.
    const stale = await setup('stale.md');
    const staleReview = await open(stale.document.id);
    await comment(staleReview.id, { kind: 'document', body: 'A comment on the old bytes.' });
    fs.writeFileSync(stale.file, '# Working steps\n\nSomeone edited this.\n');
    const refusedStale = await approveWithNote(staleReview.id);
    expect(refusedStale).toMatchObject({ status: 409, json: { code: 'stale_revision' } });
    expect(await reviewOf(staleReview.id)).toMatchObject({ status: 'draft', submission: null });
    expect((await history(stale.document.id)).decisions).toEqual([]);

    // The file cannot be read right now.
    const missing = await setup('missing.md');
    const missingReview = await open(missing.document.id);
    fs.rmSync(missing.file);
    const refusedMissing = await approveWithNote(missingReview.id);
    expect(refusedMissing).toMatchObject({ status: 409, json: { code: 'file_unavailable' } });
    expect(await reviewOf(missingReview.id)).toMatchObject({ status: 'draft' });
    fs.writeFileSync(missing.file, BODY);
    expect((await approveWithNote(missingReview.id)).status).toBe(202);
    expect((await history(missing.document.id)).decisions).toHaveLength(1);

    // A reference document takes no review decision.
    const reference = await setup('reference.md', BODY, { deliverable: { requires_review: false } });
    const referenceReview = await open(reference.document.id);
    const refusedReference = await approveWithNote(referenceReview.id);
    expect(refusedReference).toMatchObject({ status: 409, json: { code: 'review_not_required' } });
    expect(await reviewOf(referenceReview.id)).toMatchObject({ status: 'draft' });

    // Replacement work accepted meanwhile closed his round.
    const closed = await setup('closed.md');
    const asked = await open(closed.document.id);
    const requested = await finish(asked.id, { summary: 'Please rewrite this.' });
    await decide(closed.document.id, { decision: 'request_changes', revision_id: closed.v1.id, note: 'Please rewrite this.' });
    const draft = await open(closed.document.id);
    expect((await accept(closed.document.id, { client_request_id: 'work', source: { submission_id: requested.json.submission.id }, task_id: WORK_TASK })).status).toBe(201);
    expect((await approveWithNote(draft.id)).status).toBe(409);
    expect((await history(closed.document.id)).decisions.map(d => d.decision)).toEqual(['request_changes']);
});

test('a package with two design directions needs a chosen direction; once he chose one the finish keeps it', async () => {
    const registered = await register(designPackage(), { kind: 'design' });
    expect(registered.status).toBe(201);
    const { document, revision } = registered.json;
    const review = await open(document.id);
    const refused = await approveWithNote(review.id);
    expect(refused).toMatchObject({ status: 400, json: { code: 'selection_required', directions: ['1a', '1b'] } });
    expect(await reviewOf(review.id)).toMatchObject({ status: 'draft' });
    expect((await history(document.id)).decisions).toEqual([]);

    expect((await decide(document.id, { decision: 'approve', revision_id: revision.id, selection: { direction: '1b' } })).status).toBe(201);
    const finished = await approveWithNote(review.id, 'Masthead it is. The caption should say less.');
    expect(finished.status).toBe(202);
    const decisions = (await history(document.id)).decisions;
    expect(decisions).toHaveLength(2);
    const approval = decisions.find(d => d.id === finished.json.review.approval_decision_id);
    expect(approval).toMatchObject({ decision: 'approve', selection: { direction: '1b' }, note: 'Masthead it is. The caption should say less.' });
    expect((await fullSubmission(review.id)).payload.selected_direction).toBe('1b');
});

test('a decision or requirement that changes while the finish runs wins: nothing is approved and the draft is kept', async () => {
    const store = db.documentReviews;
    /** Runs `change` just before the finish opens its transaction, after every earlier check passed. */
    const beforeTheFinishCommits = change => {
        const real = store.transaction.bind(store);
        jest.spyOn(store, 'transaction').mockImplementationOnce(fn => { change(); store.transaction.mockRestore(); return real(fn); });
    };

    const registered = await register(designPackage(), { kind: 'design' });
    expect(registered.status).toBe(201);
    const { document, revision } = registered.json;
    const review = await open(document.id);
    expect((await decide(document.id, { decision: 'approve', revision_id: revision.id, selection: { direction: '1b' } })).status).toBe(201);
    beforeTheFinishCommits(() => store.insertDecision({
        document_id: document.id, revision_id: revision.id, content_hash: revision.content_hash, decision: 'approve', actor_id: 'local_user',
        authority: 'operator_credential', note: '', intended_action: 'none', selection: { direction: '1a' }, recorded_by: 'operator',
    }));
    const changedDirection = await approveWithNote(review.id);
    expect(changedDirection).toMatchObject({ status: 409, json: { code: 'decisions_changed', nothing_recorded: true } });
    expect(await reviewOf(review.id)).toMatchObject({ status: 'draft', approval_decision_id: null });
    expect((await history(document.id)).decisions.map(d => d.selection?.direction)).toEqual(['1b', '1a']);

    const plain = await setup('now-reference.md');
    const plainReview = await open(plain.document.id);
    beforeTheFinishCommits(() => store.updateDocument(plain.document.id, { requires_review: 0 }));
    const noLongerNeeded = await approveWithNote(plainReview.id);
    expect(noLongerNeeded).toMatchObject({ status: 409, json: { code: 'review_not_required', nothing_recorded: true } });
    expect(await reviewOf(plainReview.id)).toMatchObject({ status: 'draft', approval_decision_id: null });
    expect((await history(plain.document.id)).decisions).toEqual([]);
    expect(submissionsFor(plainReview.id)).toBe(0);
});

// ── Criterion 6: request_changes and plain feedback are unchanged ──

test('a finish without the checkbox stays feedback: no decision, no authority for an executor', async () => {
    const { document, file } = await setup();
    const review = await open(document.id);
    const finished = await finish(review.id, { summary: 'Looks right, I want to read it once more.' }, session);
    expect(finished.status).toBe(202);
    expect(finished.json.review).toMatchObject({ status: 'submitted', approval_delegated: false, approval_decision_id: null, submitted_authority: null });
    expect(await read(document.id)).toMatchObject({ review_status: 'needs_review', current_decision: null });
    expect((await fullSubmission(review.id)).payload.approval ?? null).toBeNull();
    fs.writeFileSync(file, '# Working steps\n\nA later version.\n');
    const v2 = (await read(document.id)).revision;
    const attempt = await decide(document.id, {
        decision: 'approve', revision_id: v2.id, executor: { ...EXECUTOR, source_submission_id: finished.json.submission.id },
    }, executorCredential);
    expect(attempt).toMatchObject({ status: 403, json: { code: 'source_review_not_delegated' } });
    expect((await history(document.id)).decisions).toEqual([]);
});

test('a request_changes decision made after an approval with a note still opens exactly one replacement', async () => {
    const { document, v1 } = await setup();
    const first = await open(document.id);
    const approved = await approveWithNote(first.id);
    expect(approved.status).toBe(202);
    // He changes his mind: a new round and an explicit request for changes on the same version.
    const second = await open(document.id);
    const changes = await decide(document.id, { decision: 'request_changes', revision_id: v1.id, note: 'On second thought, rewrite the opening.' });
    expect(changes.status).toBe(201);
    const finished = await finish(second.id, { summary: 'On second thought, rewrite the opening.' });
    expect(finished.status).toBe(202);
    // The approved round itself never becomes the source of that work, even with the request for changes now in force.
    expect(await linkWork(document.id, approved.json.submission, 'citing-the-approval')).toMatchObject({ status: 409, json: { code: 'source_not_change_request' } });
    expect((await history(document.id)).replacements).toEqual([]);
    const linked = await accept(document.id, { client_request_id: finished.json.submission.id, source: { submission_id: finished.json.submission.id, decision_id: changes.json.decision.id }, task_id: WORK_TASK });
    expect(linked.status).toBe(201);
    const again = await accept(document.id, { client_request_id: finished.json.submission.id, source: { submission_id: finished.json.submission.id, decision_id: changes.json.decision.id }, task_id: WORK_TASK });
    expect(again).toMatchObject({ status: 200, json: { duplicate: true, replacement: { id: linked.json.replacement.id } } });
    expect((await history(document.id)).replacements).toHaveLength(1);
});

// ── Criterion 7: work in flight under the old rule finishes as it started; stored approvals stay readable ──

test('a delegated review finished under the old rule keeps its replacement lifecycle and its executor-recorded approval', async () => {
    const { document, file, v1 } = await setup('legacy.md');
    const { review, submission } = await finishedUnderTheOldRule(document.id);

    const accepted = await linkWork(document.id, submission);
    expect(accepted.status).toBe(201);
    const rp = accepted.json.replacement;
    expect(rp.source).toMatchObject({ submission_id: submission.id, review_id: review.id, decision_id: null, authority: 'access_user' });
    // A retry of the same acceptance is the same work item: nothing is orphaned or duplicated.
    expect(await linkWork(document.id, submission)).toMatchObject({ status: 200, json: { duplicate: true, replacement: { id: rp.id } } });
    expect((await history(document.id)).replacements).toHaveLength(1);

    fs.writeFileSync(file, '# Working steps\n\nTrimmed as he asked.\n');
    const v2 = (await register(file, { task_id: WORK_TASK })).json.revision;
    expect(v2.id).not.toBe(v1.id);
    expect((await report(document.id, rp.id, { state: 'qa_passed', qa_state: 'passed' })).json.replacement.state).toBe('ready');

    const recorded = await decide(document.id, {
        decision: 'approve', revision_id: v2.id, content_hash: v2.content_hash, client_decision_id: 'exec-1',
        executor: { ...EXECUTOR, source_submission_id: submission.id },
    }, executorCredential);
    expect(recorded).toMatchObject({
        status: 201,
        json: {
            review_status: 'approved',
            decision: {
                decision: 'approve', revision_id: v2.id, recorded_by: 'executor', authority: 'document_executor_credential',
                provenance: { executor: { id: EXECUTOR.id }, source: { review_id: review.id, submission_id: submission.id, delegation: { approval_delegated: true, authority: 'access_user' } } },
            },
        },
    });
    const decisionId = recorded.json.decision.id;
    expect((await api('GET', `/api/documents/${document.id}/decisions/${decisionId}`)).json).toMatchObject({ in_force: true, approved: true, decision: { recorded_by: 'executor' } });
    expect((await history(document.id)).decisions).toEqual([expect.objectContaining({ id: decisionId, recorded_by: 'executor', provenance: expect.objectContaining({ executor: expect.objectContaining({ id: EXECUTOR.id }) }) })]);
    expect((await reviewOf(review.id))).toMatchObject({ approval_delegated: true, approval_decision_id: null });
});

test('a review approved at finish can never be cited for an executor-recorded approval of a later version', async () => {
    const { document, file } = await setup();
    const review = await open(document.id);
    const finished = await approveWithNote(review.id);
    expect(finished.status).toBe(202);
    fs.writeFileSync(file, '# Working steps\n\nA later version nobody reviewed.\n');
    const v2 = (await read(document.id)).revision;
    const attempt = await decide(document.id, {
        decision: 'approve', revision_id: v2.id, executor: { ...EXECUTOR, source_submission_id: finished.json.submission.id },
    }, executorCredential);
    expect(attempt).toMatchObject({ status: 403, json: { code: 'source_review_not_delegated' } });
    expect((await history(document.id)).decisions).toHaveLength(1);
});
