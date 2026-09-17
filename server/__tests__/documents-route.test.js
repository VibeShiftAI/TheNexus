/**
 * Document review API against an isolated NEXUS_DB_PATH and a temporary
 * project root. No live chat, no live Praxis: delivery is a stub that records
 * calls, so pre-submit behaviour and finish semantics are observable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

let db;
let base;
let server;
let workspace;
let projectRoot;
let reportPath;
let delivery;
let app;

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT = ['# Readiness report', '', 'Intro paragraph with **bold** text.', '', '## Findings', '', '| Step | State |', '|---|---|', '| 1 | done |', '', '- item one', '- item two', ''].join('\n');

async function api(method, url, body, { user = 'local_user' } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, json: payload, headers: response.headers };
}

beforeEach(async () => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doc-route-')));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    jest.resetModules();
    db = require('../../db');
    projectRoot = path.join(workspace, 'Praxis');
    fs.mkdirSync(path.join(projectRoot, 'docs', 'reports'), { recursive: true });
    reportPath = path.join(projectRoot, 'docs', 'reports', 'readiness.md');
    fs.writeFileSync(reportPath, CONTENT);
    await db.upsertProject({ id: PROJECT_ID, name: 'Praxis', path: projectRoot });
    await db.createTask({ id: TASK_ID, project_id: PROJECT_ID, name: 'Verify repairs', status: 'completed', metadata: { status_message: 'QA passed (cross-executor review)' } });
    delivery = { calls: [], deliver: jest.fn(async id => { delivery.calls.push(id); return null; }) };
    const createDocumentsRouter = require('../routes/documents');
    app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/documents', (req, _res, next) => {
        const user = req.headers['x-test-user'];
        if (user) req.user = { id: String(user), role: 'admin', is_service: false };
        next();
    });
    app.use('/api/documents', createDocumentsRouter({ db, delivery }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    delete process.env.NEXUS_DB_PATH;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

async function register(extra = {}) {
    return api('POST', '/api/documents', { path: reportPath, title: 'Readiness report', project_id: PROJECT_ID, task_id: TASK_ID, kind: 'report', metadata: { as_of: '2026-09-10' }, ...extra });
}

test('every route requires an authenticated user', async () => {
    expect((await api('POST', '/api/documents', { path: reportPath }, { user: null })).status).toBe(401);
    expect((await api('GET', '/api/documents', undefined, { user: null })).status).toBe(401);
    expect((await api('GET', '/api/documents/nope', undefined, { user: null })).status).toBe(401);
});

test('registration is bounded to project roots and Markdown files, and is idempotent per path and task', async () => {
    const outside = path.join(workspace, 'outside.md');
    fs.writeFileSync(outside, '# outside');
    expect((await api('POST', '/api/documents', { path: outside })).status).toBe(403);
    expect((await api('POST', '/api/documents', { path: path.join(projectRoot, 'docs', '..', '..', 'outside.md') })).status).toBe(403);
    fs.symlinkSync(outside, path.join(projectRoot, 'docs', 'escape.md'));
    expect((await api('POST', '/api/documents', { path: path.join(projectRoot, 'docs', 'escape.md') }))).toMatchObject({ status: 403, json: { code: 'symlink_escape' } });
    fs.writeFileSync(path.join(projectRoot, 'docs', 'notes.txt'), 'plain');
    expect((await api('POST', '/api/documents', { path: path.join(projectRoot, 'docs', 'notes.txt') })).status).toBe(415);
    expect((await api('POST', '/api/documents', { path: path.join(projectRoot, 'docs', 'missing.md') })).status).toBe(404);
    expect((await api('POST', '/api/documents', { path: reportPath, task_id: 'no-such-task' })).status).toBe(404);
    expect((await api('POST', '/api/documents', { path: reportPath, project_id: 'no-such-project' })).status).toBe(404);
    expect((await api('POST', '/api/documents', { path: reportPath, kind: 'weird' })).status).toBe(400);
    expect((await api('POST', '/api/documents', {})).status).toBe(400);

    const first = await register();
    expect(first.status).toBe(201);
    expect(first.json.document).toMatchObject({ title: 'Readiness report', path: reportPath, project_id: PROJECT_ID, task_id: TASK_ID, kind: 'report', root_project_id: PROJECT_ID });
    expect(first.json.revision.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.json.review_url).toBe(`https://nexus.vibeshiftai.com/documents/${first.json.document.id}`);

    const again = await register({ title: 'Readiness report (renamed)' });
    expect(again.status).toBe(200);
    expect(again.json.document.id).toBe(first.json.document.id);
    expect(again.json.document.title).toBe('Readiness report (renamed)');
    expect(again.json.document.metadata).toEqual({ as_of: '2026-09-10' });

    const list = await api('GET', `/api/documents?task_id=${TASK_ID}`);
    expect(list.json.documents).toHaveLength(1);
    expect(list.json.documents[0]).toMatchObject({ id: first.json.document.id, review_state: null });
    expect(list.json.documents[0].current_revision.content_hash).toBe(first.json.revision.content_hash);
    expect((await api('GET', '/api/documents?task_id=other')).json.documents).toEqual([]);
});

test('reading serves the actual content with source task state, and raw/download expose the Markdown source', async () => {
    const { json: { document } } = await register();
    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.status).toBe(200);
    expect(read.json.content).toBe(CONTENT);
    expect(read.json.file_state).toBe('ok');
    expect(read.json.source.task).toMatchObject({ id: TASK_ID, title: 'Verify repairs', status: 'completed', status_message: 'QA passed (cross-executor review)' });
    expect(read.json.source.project).toMatchObject({ id: PROJECT_ID, name: 'Praxis' });
    expect(read.json.review).toBeNull();
    expect(read.json.links.review_url).toBe(`https://nexus.vibeshiftai.com/documents/${document.id}`);

    const raw = await api('GET', `/api/documents/${document.id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toContain('text/markdown');
    expect(raw.headers.get('content-disposition')).toBe('inline; filename="readiness.md"');
    expect(raw.json).toBe(CONTENT);
    const download = await api('GET', `/api/documents/${document.id}/raw?download=1`);
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="readiness.md"');
    expect((await api('GET', '/api/documents/does-not-exist')).status).toBe(404);
});

test('drafts persist server-side with verified anchors, dedupe by client id, and survive a second client session', async () => {
    const { json: { document } } = await register();
    const opened = await api('POST', `/api/documents/${document.id}/reviews`);
    expect(opened.status).toBe(201);
    const review = opened.json.review;
    expect(review).toMatchObject({ status: 'draft', document_changed: false, comments: [] });
    expect((await api('POST', `/api/documents/${document.id}/reviews`)).json.review.id).toBe(review.id);

    expect(delivery.calls).toEqual([]);
    const tableQuote = '| Step | State |\n|---|---|\n| 1 | done |';
    const bad = await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-bad', kind: 'passage', start_line: 7, end_line: 9, quote: 'not the table', body: 'x' });
    expect(bad).toMatchObject({ status: 409, json: { code: 'anchor_mismatch' } });
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'passage', start_line: 40, end_line: 41, quote: 'x', body: 'x' })).status).toBe(409);
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'passage', start_line: 7, end_line: 9, quote: tableQuote, body: '   ' })).status).toBe(400);
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'sideways', body: 'x' })).status).toBe(400);

    const created = await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-1', kind: 'passage', start_line: 7, end_line: 9, quote: tableQuote, selection: 'done', body: 'Step 1 needs evidence.' });
    expect(created.status).toBe(201);
    expect(created.json.comment).toMatchObject({ kind: 'passage', start_line: 7, end_line: 9, quote: tableQuote, selection: 'done', body: 'Step 1 needs evidence.', anchor: { state: 'intact' } });
    expect(created.json.comment.block_hash).toMatch(/^[0-9a-f]{64}$/);
    const replay = await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-1', kind: 'passage', start_line: 7, end_line: 9, quote: tableQuote, body: 'Step 1 needs evidence.' });
    expect(replay.status).toBe(200);
    expect(replay.json.duplicate).toBe(true);
    expect(replay.json.comment.id).toBe(created.json.comment.id);

    const note = await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-2', kind: 'document', body: 'Overall the report reads well.' });
    expect(note.status).toBe(201);
    expect(note.json.comment.anchor).toEqual({ state: 'document', current_start_line: null });
    expect((await api('PATCH', `/api/documents/reviews/${review.id}`, { summary: 'Draft summary' })).json.review.summary).toBe('Draft summary');
    const edited = await api('PATCH', `/api/documents/reviews/${review.id}/comments/${note.json.comment.id}`, { body: 'Overall the report reads well; add dates.' });
    expect(edited.json.comment.body).toBe('Overall the report reads well; add dates.');

    // A different reviewer cannot see or touch this draft.
    expect((await api('GET', `/api/documents/reviews/${review.id}`, undefined, { user: 'someone-else' })).status).toBe(404);
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'hi' }, { user: 'someone-else' })).status).toBe(404);

    // A second client session (fresh GET of the document) sees the same draft.
    const second = await api('GET', `/api/documents/${document.id}`);
    expect(second.json.review.id).toBe(review.id);
    expect(second.json.review.summary).toBe('Draft summary');
    expect(second.json.review.comments.map(c => c.id).sort()).toEqual([created.json.comment.id, note.json.comment.id].sort());

    const removed = await api('DELETE', `/api/documents/reviews/${review.id}/comments/${note.json.comment.id}`);
    expect(removed.status).toBe(200);
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review.comments).toHaveLength(1);
    expect(delivery.calls).toEqual([]);
});

test('a changed document keeps the review pinned and reports moved and orphaned anchors honestly', async () => {
    const { json: { document, revision } } = await register();
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    const tableQuote = '| Step | State |\n|---|---|\n| 1 | done |';
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'passage', start_line: 7, end_line: 9, quote: tableQuote, body: 'table' });
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'passage', start_line: 3, end_line: 3, quote: 'Intro paragraph with **bold** text.', body: 'intro' });

    fs.writeFileSync(reportPath, `Preface added.\n\n${CONTENT.replace('Intro paragraph with **bold** text.', 'Intro rewritten.')}`);
    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.json.revision.id).not.toBe(revision.id);
    expect(read.json.content.startsWith('Preface added.')).toBe(true);
    expect(read.json.review.revision_id).toBe(revision.id);
    expect(read.json.review.document_changed).toBe(true);
    expect(read.json.review.pinned_content).toBe(CONTENT);
    expect(read.json.review.pinned_revision.content_hash).toBe(revision.content_hash);
    const states = Object.fromEntries(read.json.review.comments.map(c => [c.body, c.anchor]));
    expect(states.table).toEqual({ state: 'moved', current_start_line: 9 });
    expect(states.intro).toEqual({ state: 'orphaned', current_start_line: null });
    // The stored comment anchors were not relocated.
    expect(read.json.review.comments.find(c => c.body === 'table').start_line).toBe(7);

    // New comments still verify against the PINNED revision, not the new file.
    const stillPinned = await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'passage', start_line: 1, end_line: 1, quote: '# Readiness report', body: 'title' });
    expect(stillPinned.status).toBe(201);
    const pinnedRaw = await api('GET', `/api/documents/${document.id}/raw?revision=${revision.id}`);
    expect(pinnedRaw.json).toBe(CONTENT);
    expect((await api('GET', `/api/documents/${document.id}/revisions/${revision.id}`)).json.content).toBe(CONTENT);
});

test('a missing or escaped file after registration is reported, and the stored revision still serves', async () => {
    const { json: { document } } = await register();
    fs.rmSync(reportPath);
    const read = await api('GET', `/api/documents/${document.id}`);
    expect(read.status).toBe(200);
    expect(read.json.file_state).toBe('not_found');
    expect(read.json.content).toBe(CONTENT);
    fs.writeFileSync(path.join(workspace, 'evil.md'), '# swapped');
    fs.symlinkSync(path.join(workspace, 'evil.md'), reportPath);
    const escaped = await api('GET', `/api/documents/${document.id}`);
    expect(escaped.json.file_state).toBe('symlink_escape');
    expect(escaped.json.content).toBe(CONTENT);
});

test('finish is idempotent, freezes the review, snapshots verbatim feedback and queues exactly one delivery', async () => {
    const { json: { document, revision } } = await register();
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'passage', start_line: 1, end_line: 1, quote: '# Readiness report', body: 'Title could carry the date.' });
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect((await api('GET', `/api/documents/reviews/${review.id}/submission`)).status).toBe(404);

    const [first, second] = await Promise.all([
        api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Looks ready.' }),
        api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Looks ready.' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 202]);
    expect(first.json.submission.id).toBe(second.json.submission.id);
    expect(first.json.review.status).toBe('submitted');
    expect(first.json.review.summary).toBe('Looks ready.');
    const third = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'changed my mind' });
    expect(third.status).toBe(200);
    expect(third.json.duplicate).toBe(true);
    expect(third.json.review.summary).toBe('Looks ready.');
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(first.json.submission.id);

    const submission = (await api('GET', `/api/documents/reviews/${review.id}/submission?full=1`)).json.submission;
    expect(submission).toMatchObject({ delivery_status: 'queued', delivery_attempts: 0, revision_id: revision.id, review_url: `https://nexus.vibeshiftai.com/documents/${document.id}` });
    expect(submission.payload.comments[0]).toMatchObject({ kind: 'passage', start_line: 1, end_line: 1, quote: '# Readiness report', body: 'Title could carry the date.' });
    expect(submission.payload.revision.content_hash).toBe(revision.content_hash);
    expect(submission.payload.source.task).toMatchObject({ id: TASK_ID, title: 'Verify repairs' });
    expect(submission.message_text).toContain('Robert: Title could carry the date.');
    expect(submission.message_text).toContain(`Review link: https://nexus.vibeshiftai.com/documents/${document.id}`);

    // Frozen: no more edits, but the document and the task are untouched.
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { kind: 'document', body: 'late' })).status).toBe(409);
    expect((await api('PATCH', `/api/documents/reviews/${review.id}`, { summary: 'late' })).status).toBe(409);
    expect(fs.readFileSync(reportPath, 'utf8')).toBe(CONTENT);
    expect((await db.getTask(TASK_ID)).status).toBe('completed');
    const listed = (await api('GET', `/api/documents?task_id=${TASK_ID}`)).json.documents[0];
    expect(listed.review_state).toMatchObject({ review_id: review.id, status: 'submitted', comment_count: 1, delivery_status: 'queued' });
    // The document view now reports the submitted review, and a new draft can be opened afterwards.
    expect((await api('GET', `/api/documents/${document.id}`)).json.review.status).toBe('submitted');
    const fresh = await api('POST', `/api/documents/${document.id}/reviews`);
    expect(fresh.status).toBe(201);
    expect(fresh.json.review.id).not.toBe(review.id);
});

test('a review can be finished with zero comments and an empty summary', async () => {
    const { json: { document } } = await register();
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    const done = await api('POST', `/api/documents/reviews/${review.id}/finish`, {});
    expect(done.status).toBe(202);
    expect(done.json.submission.delivery_status).toBe('queued');
    const submission = (await api('GET', `/api/documents/reviews/${review.id}/submission?full=1`)).json.submission;
    expect(submission.payload.comments).toEqual([]);
    expect(submission.message_text).toContain('Robert finished the review without adding comments.');
});

test('retry only re-queues an unfinished delivery and reports a delivered one as final', async () => {
    const { json: { document } } = await register();
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    const finished = await api('POST', `/api/documents/reviews/${review.id}/finish`, {});
    db.documentReviews.updateSubmission(finished.json.submission.id, { delivery_status: 'failed', last_error: 'Praxis unreachable' });
    const retried = await api('POST', `/api/documents/reviews/${review.id}/submission/retry`);
    expect(retried.status).toBe(202);
    expect(retried.json.retried).toBe(true);
    expect(delivery.deliver).toHaveBeenCalledTimes(2);
    db.documentReviews.updateSubmission(finished.json.submission.id, { delivery_status: 'delivered', delivered_at: new Date().toISOString() });
    const final = await api('POST', `/api/documents/reviews/${review.id}/submission/retry`);
    expect(final.status).toBe(200);
    expect(final.json.retried).toBe(false);
    expect(delivery.deliver).toHaveBeenCalledTimes(2);
});

// ── Fault injection (QA regression, 2026-09-10) ─────────────────────────
// A storage fault must never leave a half-written review behind: the failing
// request answers 500, everything saved before it is still there, and a
// finish that could not persist its submission rolls the whole transaction
// back (review still a draft, no submission, no delivery).

test('a storage fault while saving a comment answers 500 and leaves earlier feedback intact', async () => {
    const { json: { document } } = await register();
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-1', kind: 'document', body: 'First note.' })).status).toBe(201);

    const store = db.documentReviews;
    const realInsertComment = store.insertComment;
    store.insertComment = () => { throw new Error('SQLITE_IOERR: disk I/O error'); };
    let failed;
    try {
        failed = await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-2', kind: 'document', body: 'Second note.' });
    } finally {
        store.insertComment = realInsertComment;
    }
    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: 'Failed to save comment' });

    const after = (await api('GET', `/api/documents/reviews/${review.id}`)).json.review;
    expect(after.status).toBe('draft');
    expect(after.comments.map(c => c.body)).toEqual(['First note.']);
    expect(store.findCommentByClientId(review.id, 'c-2')).toBeNull();

    // The same client id retries cleanly: no phantom duplicate from the failed write.
    const retried = await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-2', kind: 'document', body: 'Second note.' });
    expect(retried.status).toBe(201);
    expect(retried.json.duplicate).toBeUndefined();
    expect((await api('GET', `/api/documents/reviews/${review.id}`)).json.review.comments.map(c => c.body)).toEqual(['First note.', 'Second note.']);
    expect(delivery.deliver).not.toHaveBeenCalled();
});

test('a storage fault while finishing rolls the transaction back: draft preserved, no submission, nothing delivered', async () => {
    const { json: { document } } = await register();
    const review = (await api('POST', `/api/documents/${document.id}/reviews`)).json.review;
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-1', kind: 'passage', start_line: 1, end_line: 1, quote: '# Readiness report', body: 'Title could carry the date.' })).status).toBe(201);
    expect((await api('PATCH', `/api/documents/reviews/${review.id}`, { summary: 'Draft summary' })).status).toBe(200);

    const store = db.documentReviews;
    const realInsertSubmission = store.insertSubmission;
    store.insertSubmission = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
    let failed;
    try {
        failed = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Final words' });
    } finally {
        store.insertSubmission = realInsertSubmission;
    }
    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: 'Failed to finish review' });

    // Rollback: the status/summary update that ran inside the same transaction is gone too.
    const row = store.getReview(review.id);
    expect(row.status).toBe('draft');
    expect(row.submitted_at).toBeNull();
    expect(row.summary).toBe('Draft summary');
    expect(store.getSubmissionForReview(review.id)).toBeNull();
    const view = (await api('GET', `/api/documents/reviews/${review.id}`)).json.review;
    expect(view).toMatchObject({ status: 'draft', submission: null });
    expect(view.comments.map(c => c.body)).toEqual(['Title could carry the date.']);
    expect((await api('GET', `/api/documents/reviews/${review.id}/submission`)).status).toBe(404);
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect((await api('GET', `/api/documents?task_id=${TASK_ID}`)).json.documents[0].review_state).toMatchObject({ review_id: review.id, status: 'draft', delivery_status: null });

    // Still a draft: editable, and a later finish succeeds exactly once with everything intact.
    expect((await api('POST', `/api/documents/reviews/${review.id}/comments`, { client_id: 'c-2', kind: 'document', body: 'Still editable after the fault.' })).status).toBe(201);
    const done = await api('POST', `/api/documents/reviews/${review.id}/finish`, { summary: 'Final words' });
    expect(done.status).toBe(202);
    expect(done.json.review).toMatchObject({ status: 'submitted', summary: 'Final words' });
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(done.json.submission.id);
    const submission = (await api('GET', `/api/documents/reviews/${review.id}/submission?full=1`)).json.submission;
    expect(submission.payload.comments.map(c => c.body)).toEqual(['Title could carry the date.', 'Still editable after the fault.']);
    expect(submission.payload.summary).toBe('Final words');
});
