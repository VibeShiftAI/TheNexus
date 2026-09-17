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

test('delivery lands the verbatim review as a turn in the active Praxis conversation with a receipt', async () => {
    const relay = jest.fn(async () => ({ response: 'Thanks Robert, on it.', voiceData: [] }));
    const emitted = [];
    const worker = createDocumentReviewDelivery({ db, io: { emit: (event, payload) => emitted.push({ event, payload }) }, relay, intervalMs: 0 });
    const sub = queueSubmission();
    const delivered = await worker.deliver(sub.id);
    expect(delivered.delivery_status).toBe('delivered');
    expect(delivered.delivery_attempts).toBe(1);
    expect(delivered.receipt).toMatchObject({ user_message_id: `docreview:${sub.id}`, assistant_message_id: `docreview:${sub.id}:reply` });
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0][0]).toBe(sub.message_text);
    expect(relay.mock.calls[0][1]).toMatchObject({ projectId: 'proj-1' });

    const conversation = await db.getActiveConversation('praxis');
    const messages = await db.getChatMessages(conversation.id);
    expect(messages.map(m => [m.role, m.content])).toEqual([
        ['user', sub.message_text],
        ['assistant', 'Thanks Robert, on it.'],
    ]);
    expect(messages[0].metadata.documentReview).toMatchObject({ submissionId: sub.id, documentTitle: 'Readiness' });
    expect(messages[1].metadata).toMatchObject({ replyTo: `docreview:${sub.id}`, model: 'praxis-agent' });
    expect(emitted.map(e => e.event)).toEqual(['chat-message', 'chat-message']);
    expect(delivered.receipt.conversation_id).toBe(conversation.id);
});

test('concurrent and repeated deliveries of one submission relay exactly once', async () => {
    let release;
    const relay = jest.fn(() => new Promise(resolve => { release = () => resolve({ response: 'ok' }); }));
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    const sub = queueSubmission();
    const a = worker.deliver(sub.id);
    const b = worker.deliver(sub.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(first.delivery_status).toBe('delivered');
    expect(second.delivery_status).toBe('delivered');
    expect(relay).toHaveBeenCalledTimes(1);
    const again = await worker.deliver(sub.id);
    expect(again.delivery_status).toBe('delivered');
    expect(relay).toHaveBeenCalledTimes(1);
    const conversation = await db.getActiveConversation('praxis');
    expect((await db.getChatMessages(conversation.id))).toHaveLength(2);
});

test('response loss recovers from the stored reply without relaying again', async () => {
    const relay = jest.fn(async () => ({ response: 'stored earlier' }));
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    const sub = queueSubmission();
    const conversation = await db.getActiveConversation('praxis');
    await db.saveChatMessage({ id: `docreview:${sub.id}`, conversation_id: conversation.id, role: 'user', content: sub.message_text, mode: 'praxis' });
    await db.saveChatMessage({ id: `docreview:${sub.id}:reply`, conversation_id: conversation.id, role: 'assistant', content: 'stored earlier', mode: 'praxis' });
    const delivered = await worker.deliver(sub.id);
    expect(delivered.delivery_status).toBe('delivered');
    expect(delivered.receipt.assistant_message_id).toBe(`docreview:${sub.id}:reply`);
    expect(relay).not.toHaveBeenCalled();
    expect(await db.getChatMessages(conversation.id)).toHaveLength(2);
});

test('an unreachable Praxis retries with backoff, and the retried turn is byte-identical under the same submission key', async () => {
    const time = clock();
    const unreachable = Object.assign(new Error('fetch failed'), { code: 'PRAXIS_UNREACHABLE' });
    const relay = jest.fn()
        .mockRejectedValueOnce(unreachable)
        .mockResolvedValueOnce({ response: 'back online' });
    const worker = createDocumentReviewDelivery({ db, relay, now: time.now, intervalMs: 0, backoffMs: [1000, 5000] });
    const sub = queueSubmission();

    const failed = await worker.deliver(sub.id);
    expect(failed.delivery_status).toBe('failed');
    expect(failed.delivery_attempts).toBe(1);
    expect(failed.last_error).toContain('fetch failed');
    expect(failed.next_attempt_at).toBe(new Date(time.now().getTime() + 1000).toISOString());

    // Not due yet: the tick leaves it alone.
    expect(await worker.tick()).toEqual([]);
    expect(relay).toHaveBeenCalledTimes(1);
    time.advance(1500);
    const [delivered] = await worker.tick();
    expect(delivered.delivery_status).toBe('delivered');
    expect(delivered.delivery_attempts).toBe(2);
    expect(relay).toHaveBeenCalledTimes(2);
    expect(relay.mock.calls[1][0]).toBe(sub.message_text);
    expect(relay.mock.calls[0][1]).toMatchObject({ idempotencyKey: `docreview:${sub.id}`, attempt: 1 });
    expect(relay.mock.calls[1][1]).toMatchObject({ idempotencyKey: `docreview:${sub.id}`, attempt: 2 });
    const conversation = await db.getActiveConversation('praxis');
    const messages = await db.getChatMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe(sub.message_text);
});

test('a timeout retries automatically under the same key, while a definite rejection waits for an explicit retry', async () => {
    const time = clock();
    const timeout = Object.assign(new Error('Praxis request timed out'), { code: 'PRAXIS_TIMEOUT' });
    const rejected = Object.assign(new Error('Praxis returned 500: Failed to generate response'), { status: 500 });
    const relay = jest.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(rejected).mockResolvedValueOnce({ response: 'third time' });
    const worker = createDocumentReviewDelivery({ db, relay, now: time.now, intervalMs: 0, backoffMs: [1000] });
    const sub = queueSubmission();

    // Timeout: Praxis may still be running the turn; the keyed retry gets the recorded reply or a 409, never a second turn.
    const timedOut = await worker.deliver(sub.id);
    expect(timedOut.delivery_status).toBe('failed');
    expect(timedOut.next_attempt_at).toBe(new Date(time.now().getTime() + 1000).toISOString());
    time.advance(1500);

    // A definite rejection is reported and waits for the operator.
    const [rejectedRow] = await worker.tick();
    expect(rejectedRow.delivery_status).toBe('failed');
    expect(rejectedRow.delivery_attempts).toBe(2);
    expect(rejectedRow.next_attempt_at).toBeNull();
    expect(rejectedRow.last_error).toContain('Praxis returned 500');
    expect(rejectedRow.last_error).toContain('same submission id');
    time.advance(60 * 60 * 1000);
    expect(await worker.tick()).toEqual([]);
    expect(relay).toHaveBeenCalledTimes(2);

    const delivered = await worker.deliver(sub.id);
    expect(delivered.delivery_status).toBe('delivered');
    expect(relay).toHaveBeenCalledTimes(3);
    expect(relay.mock.calls.map(call => call[1].idempotencyKey)).toEqual(Array(3).fill(`docreview:${sub.id}`));
    expect(relay.mock.calls.map(call => call[0])).toEqual(Array(3).fill(sub.message_text));
});

test('automatic retries stop after the cap and a queued row is never relayed before it exists', async () => {
    const time = clock();
    const unreachable = Object.assign(new Error('down'), { code: 'PRAXIS_UNREACHABLE' });
    const relay = jest.fn().mockRejectedValue(unreachable);
    const worker = createDocumentReviewDelivery({ db, relay, now: time.now, intervalMs: 0, backoffMs: [1] });
    expect(await worker.tick()).toEqual([]);
    expect(relay).not.toHaveBeenCalled();
    const sub = queueSubmission();
    for (let i = 0; i < MAX_AUTO_ATTEMPTS + 2; i++) {
        await worker.tick();
        time.advance(10);
    }
    const final = db.documentReviews.getSubmission(sub.id);
    expect(final.delivery_status).toBe('failed');
    expect(final.delivery_attempts).toBe(MAX_AUTO_ATTEMPTS);
    expect(final.next_attempt_at).toBeNull();
    expect(relay).toHaveBeenCalledTimes(MAX_AUTO_ATTEMPTS);
});

test('a relay interrupted by a restart is reported on boot and its receipt recovered under the same key', async () => {
    const relay = jest.fn(async () => ({ response: 'recorded reply', duplicate: true }));
    const sub = queueSubmission({ delivery_status: 'relaying', delivery_attempts: 1, relay_started_at: new Date().toISOString(), next_attempt_at: null });
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 60_000 });
    worker.start();
    try {
        const deadline = Date.now() + 2000;
        while (db.documentReviews.getSubmission(sub.id).delivery_status !== 'delivered' && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    } finally { worker.stop(); }
    const after = db.documentReviews.getSubmission(sub.id);
    expect(after.delivery_status).toBe('delivered');
    expect(after.delivery_attempts).toBe(2);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0][0]).toBe(sub.message_text);
    expect(relay.mock.calls[0][1]).toMatchObject({ idempotencyKey: `docreview:${sub.id}`, attempt: 2 });
    const conversation = await db.getActiveConversation('praxis');
    const messages = await db.getChatMessages(conversation.id);
    expect(messages.map(m => m.content)).toEqual([sub.message_text, 'recorded reply']);
    expect(messages[1].metadata.documentReview).toEqual({ submissionId: sub.id, recoveredReceipt: true });
});

test('an interrupted relay past the automatic cap is reported and waits for an explicit retry', async () => {
    const relay = jest.fn(async () => ({ response: 'should wait' }));
    const sub = queueSubmission({ delivery_status: 'relaying', delivery_attempts: MAX_AUTO_ATTEMPTS, relay_started_at: new Date().toISOString(), next_attempt_at: null });
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    worker.reconcileInterrupted();
    const after = db.documentReviews.getSubmission(sub.id);
    expect(after.delivery_status).toBe('failed');
    expect(after.last_error).toContain('interrupted by a server restart');
    expect(after.last_error).toContain('exhausted');
    expect(after.next_attempt_at).toBeNull();
    expect(await worker.tick()).toEqual([]);
    expect(relay).not.toHaveBeenCalled();
});

test('a reply that cannot be saved is reported rather than claimed delivered', async () => {
    const relay = jest.fn(async () => ({ response: 'answer' }));
    const worker = createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    const sub = queueSubmission();
    const original = db.saveChatMessage;
    let calls = 0;
    db.saveChatMessage = async msg => { calls += 1; return msg.role === 'assistant' ? null : original(msg); };
    try {
        const failed = await worker.deliver(sub.id);
        expect(failed.delivery_status).toBe('failed');
        expect(failed.last_error).toContain('could not be saved');
        expect(calls).toBe(2);
    } finally { db.saveChatMessage = original; }
});
