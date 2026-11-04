/**
 * Delivery outbox semantics against an isolated NEXUS_DB_PATH. The Praxis
 * relay is a stub, so nothing here can reach the live conversation; the chat
 * persistence is the real facade on the temporary database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let db;
let workspace;
let createDocumentReviewDelivery;
let MAX_AUTO_ATTEMPTS;

function queueSubmission(overrides = {}) {
    const store = db.documentReviews;
    const doc = store.insertDocument({ title: 'Readiness', path: '/tmp/readiness.md', project_id: 'proj-1', task_id: 'task-1', kind: 'report' });
    const revision = store.insertRevision({ document_id: doc.id, content_hash: 'abc', content: '# Readiness', byte_length: 11, line_count: 1 });
    const review = store.insertReview({ document_id: doc.id, revision_id: revision.id, reviewer_id: 'local_user', status: 'submitted', submitted_at: new Date().toISOString() });
    return store.insertSubmission({
        review_id: review.id, document_id: doc.id, revision_id: revision.id,
        payload: { submission_id: 'x', document: { id: doc.id, title: 'Readiness', project_id: 'proj-1' }, review_url: `https://nexus.vibeshiftai.com/documents/${doc.id}`, comments: [] },
        message_text: '[DOCUMENT REVIEW] Robert finished reviewing "Readiness".',
        ...overrides,
    });
}

function clock(start = Date.now()) {
    let current = start;
    return { now: () => new Date(current), advance(ms) { current += ms; } };
}

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doc-delivery-'));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    jest.resetModules();
    db = require('../../db');
    ({ createDocumentReviewDelivery, MAX_AUTO_ATTEMPTS } = require('../services/document-review-delivery'));
});

afterEach(() => {
    delete process.env.NEXUS_DB_PATH;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});


function eventFor(sub) {
    return { type: 'document.review_submitted', schema_version: 1, event_id: `docreview:${sub.id}`,
        document_id: sub.document_id, revision_id: sub.revision_id, submission_id: sub.id };
}
function receipt(event) { return { ...event, status: 'received', received_at: new Date().toISOString() }; }
async function messages() { return db.getChatMessages((await db.getActiveConversation('praxis')).id); }

test('notifies with identifiers only and never writes or emits chat content', async () => {
    const relay = jest.fn(async event => receipt(event));
    const io = { emit: jest.fn() };
    const worker = createDocumentReviewDelivery({ db, io, relay, intervalMs: 0 });
    const sub = queueSubmission({ message_text: 'Private full review text' });
    const result = await worker.deliver(sub.id);
    expect(result.delivery_status).toBe('delivered');
    expect(result.receipt).toMatchObject({ transport: 'notification', event_id: `docreview:${sub.id}`, submission_id: sub.id });
    expect(relay.mock.calls[0][0]).toEqual(eventFor(sub));
    expect(JSON.stringify(relay.mock.calls)).not.toContain('Private full review text');
    expect(await messages()).toEqual([]);
    expect(io.emit).not.toHaveBeenCalled();
});

test('concurrent and repeated deliveries share one notification', async () => {
    let release;
    const relay = jest.fn(event => new Promise(resolve => { release = () => resolve(receipt(event)); }));
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    const sub = queueSubmission();
    const a = worker.deliver(sub.id), b = worker.deliver(sub.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    expect((await Promise.all([a, b])).map(x => x.delivery_status)).toEqual(['delivered', 'delivered']);
    await worker.deliver(sub.id);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(await messages()).toEqual([]);
});

test('historical saved chat reply is adopted without replaying or rewriting chat', async () => {
    const relay = jest.fn();
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    const sub = queueSubmission();
    const conversation = await db.getActiveConversation('praxis');
    await db.saveChatMessage({ id: `docreview:${sub.id}:reply`, conversation_id: conversation.id, role: 'assistant', content: 'stored earlier', mode: 'praxis' });
    const result = await worker.deliver(sub.id);
    expect(result.delivery_status).toBe('delivered');
    expect(result.receipt.assistant_message_id).toBe(`docreview:${sub.id}:reply`);
    expect(relay).not.toHaveBeenCalled();
    expect(await messages()).toHaveLength(1);
});

test('transport failure retries with the same identifier-only event and retained payload', async () => {
    const time = clock();
    const relay = jest.fn().mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'PRAXIS_UNREACHABLE' })).mockImplementation(async event => receipt(event));
    const worker = createDocumentReviewDelivery({ db, relay, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    const failed = await worker.deliver(sub.id);
    expect(failed.next_attempt_at).toBe(new Date(time.now().getTime() + 1000).toISOString());
    expect(failed.payload).toEqual(sub.payload);
    expect(await worker.tick()).toEqual([]);
    time.advance(1500);
    expect((await worker.tick())[0].delivery_status).toBe('delivered');
    expect(relay.mock.calls.map(call => call[0])).toEqual([eventFor(sub), eventFor(sub)]);
    expect(relay.mock.calls.map(call => call[1].idempotencyKey)).toEqual([`docreview:${sub.id}`, `docreview:${sub.id}`]);
    expect(await messages()).toEqual([]);
});

test.each([
    {},
    { status: 'received' },
    { event_id: 'wrong' },
    { submission_id: 'wrong' },
    { document_id: 'wrong' },
    { revision_id: 'wrong' },
    { received_at: 'invalid' },
    { status: 'invented' },
])('refuses a missing or mismatched durable receipt (%j)', async patch => {
    const relay = jest.fn(async event => Object.keys(patch).length ? { ...receipt(event), ...patch } : {});
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0, log: { error() {} } });
    const sub = queueSubmission();
    const result = await worker.deliver(sub.id);
    if (Object.keys(patch).length === 1 && patch.status === 'received') {
        expect(result.delivery_status).toBe('delivered');
    } else {
        expect(result.delivery_status).toBe('failed');
        expect(result.receipt).toBeNull();
        expect(result.last_error).toContain('receipt');
    }
    expect(await messages()).toEqual([]);
});

test('automatic retries are bounded; explicit retry retains the event id', async () => {
    const time = clock();
    const relay = jest.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'PRAXIS_TIMEOUT' }));
    const worker = createDocumentReviewDelivery({ db, relay, now: time.now, intervalMs: 0, backoffMs: [1], log: { error() {} } });
    expect(await worker.tick()).toEqual([]);
    const sub = queueSubmission();
    for (let i = 0; i < MAX_AUTO_ATTEMPTS + 2; i++) { await worker.tick(); time.advance(10); }
    expect(relay).toHaveBeenCalledTimes(MAX_AUTO_ATTEMPTS);
    expect(db.documentReviews.getSubmission(sub.id).next_attempt_at).toBeNull();
    relay.mockImplementation(async event => receipt(event));
    expect((await worker.deliver(sub.id)).delivery_status).toBe('delivered');
});

test('interrupted legacy delivery migrates to reference notification on recovery', async () => {
    const relay = jest.fn(async event => ({ ...receipt(event), duplicate: true }));
    const sub = queueSubmission({ delivery_status: 'relaying', delivery_attempts: 1, next_attempt_at: null });
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    expect(worker.reconcileInterrupted()).toHaveLength(1);
    expect((await worker.tick())[0].delivery_status).toBe('delivered');
    expect(relay.mock.calls[0][0]).toEqual(eventFor(sub));
    expect(await messages()).toEqual([]);
});

test('interrupted deliveries beyond the cap wait for explicit retry', async () => {
    const relay = jest.fn();
    const sub = queueSubmission({ delivery_status: 'relaying', delivery_attempts: MAX_AUTO_ATTEMPTS, next_attempt_at: null });
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    worker.reconcileInterrupted();
    expect(db.documentReviews.getSubmission(sub.id).last_error).toContain('exhausted');
    expect(await worker.tick()).toEqual([]);
    expect(relay).not.toHaveBeenCalled();
});
