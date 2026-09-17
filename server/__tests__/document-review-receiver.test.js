/**
 * Delivery against an ISOLATED HTTP receiver that speaks the Praxis
 * `/api/chat` idempotency contract (design doc, "Delivery into the Praxis
 * conversation"): the real `relayToPraxis` + `praxisFetch` run end to end over
 * 127.0.0.1 with PRAXIS_URL pointed at the receiver, and the receiver scripts
 * faults (response loss after acceptance, an in-progress turn) so acceptance
 * followed by response loss, a worker restart and receipt recovery are
 * observable. The receiver is the only "Praxis" here; nothing can reach the
 * live daemon or the live conversation (temporary NEXUS_DB_PATH).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let db;
let workspace;
let createDocumentReviewDelivery;
let receiver;

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

/**
 * Minimal Praxis stand-in. A request carrying an idempotency key is processed
 * at most once: a completed key answers the stored reply with `duplicate:
 * true`, an in-progress key answers 409. `faults` scripts the NEXT requests:
 * 'lose' processes the turn and then destroys the socket before any byte of
 * the response is written (acceptance followed by response loss);
 * 'in_progress' answers 409 without processing.
 */
function startReceiver() {
    const ledger = new Map();
    const turns = [];
    const requests = [];
    const faults = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : {};
            const key = typeof body.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key : null;
            requests.push({ method: req.method, url: req.url, headerKey: req.headers['idempotency-key'] || null, key, body });
            const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
            if (req.method !== 'POST' || req.url !== '/api/chat') return json(404, { error: 'not found' });
            const fault = faults.shift();
            if (fault === 'in_progress') return json(409, { error: 'in_progress', idempotency_key: key });
            if (fault === 'claim_failure') return json(503, { error: 'idempotency_storage_unavailable', idempotency_key: key, retryable: true });
            const existing = key ? ledger.get(key) : null;
            if (existing?.state === 'uncertain') return json(409, { error: 'outcome_uncertain', idempotency_key: key, retryable: false });
            if (existing) return json(200, { ...existing.reply, duplicate: true, idempotency_key: key });
            turns.push({ key, message: body.message, projectId: body.projectId, attempt: body.attempt });
            if (fault === 'receipt_failure') {
                ledger.set(key, { state: 'uncertain' });
                return json(409, { error: 'outcome_uncertain', idempotency_key: key, retryable: false });
            }
            const reply = { response: `Thanks, reviewed turn ${turns.length}.`, mode: 'praxis', voiceData: [] };
            if (key) ledger.set(key, { state: 'completed', reply });
            if (fault === 'lose') { req.socket.destroy(); return; }
            return json(200, reply);
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            ledger, turns, requests, faults,
            url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
        }));
    });
}

beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doc-receiver-'));
    process.env.NEXUS_DB_PATH = path.join(workspace, 'nexus.db');
    receiver = await startReceiver();
    process.env.PRAXIS_URL = receiver.url;
    process.env.PRAXIS_CHAT_TIMEOUT_MS = '5000';
    jest.resetModules();
    db = require('../../db');
    ({ createDocumentReviewDelivery } = require('../services/document-review-delivery'));
});

afterEach(async () => {
    await receiver.close();
    delete process.env.NEXUS_DB_PATH;
    delete process.env.PRAXIS_URL;
    delete process.env.PRAXIS_CHAT_TIMEOUT_MS;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

async function conversationRows() {
    const conversation = await db.getActiveConversation('praxis');
    return db.getChatMessages(conversation.id);
}

test('acceptance followed by response loss recovers the same reply through the submission key instead of a second turn', async () => {
    const time = clock();
    receiver.faults.push('lose');
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();

    const failed = await worker.deliver(sub.id);
    expect(failed.delivery_status).toBe('failed');
    expect(failed.delivery_attempts).toBe(1);
    expect(failed.next_attempt_at).toBe(new Date(time.now().getTime() + 1000).toISOString());
    expect(receiver.turns).toHaveLength(1);

    time.advance(1500);
    const [delivered] = await worker.tick();
    expect(delivered.delivery_status).toBe('delivered');
    expect(delivered.delivery_attempts).toBe(2);
    expect(delivered.receipt).toMatchObject({ user_message_id: `docreview:${sub.id}`, assistant_message_id: `docreview:${sub.id}:reply` });

    // Praxis processed the review exactly once; the retry carried the same key and the identical turn.
    expect(receiver.turns).toHaveLength(1);
    expect(receiver.requests).toHaveLength(2);
    const key = `docreview:${sub.id}`;
    expect(receiver.requests.map(r => r.key)).toEqual([key, key]);
    expect(receiver.requests.map(r => r.headerKey)).toEqual([key, key]);
    expect(receiver.requests[1].body.message).toBe(receiver.requests[0].body.message);
    expect(receiver.requests[0].body.message).toBe(sub.message_text);
    expect(receiver.requests.map(r => r.body.attempt)).toEqual([1, 2]);
    expect(receiver.requests[0].body.projectId).toBe('proj-1');

    const rows = await conversationRows();
    expect(rows.map(m => [m.role, m.content])).toEqual([
        ['user', sub.message_text],
        ['assistant', 'Thanks, reviewed turn 1.'],
    ]);
});

test('a worker restart between acceptance and the retry still recovers the receipt under the same key', async () => {
    const time = clock();
    receiver.faults.push('lose');
    const first = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    expect((await first.deliver(sub.id)).delivery_status).toBe('failed');

    // New process: no in-memory state, only the outbox row and the receiver's ledger.
    const restarted = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    expect(restarted.reconcileInterrupted()).toEqual([]);
    time.advance(1500);
    const [delivered] = await restarted.tick();
    expect(delivered.delivery_status).toBe('delivered');
    expect(receiver.turns).toHaveLength(1);
    expect(receiver.requests.map(r => r.key)).toEqual([`docreview:${sub.id}`, `docreview:${sub.id}`]);
    expect(await conversationRows()).toHaveLength(2);
});

test('a process that died mid-relay recovers the receipt on boot without re-running the turn', async () => {
    const time = clock();
    // Praxis accepted and answered, but this process died before reading the reply: the row is still `relaying`.
    const sub = queueSubmission({ delivery_status: 'relaying', delivery_attempts: 1, relay_started_at: time.now().toISOString(), next_attempt_at: null });
    receiver.ledger.set(`docreview:${sub.id}`, { state: 'completed', reply: { response: 'Answered before the restart', mode: 'praxis', voiceData: [] } });
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, log: { error() {} } });

    const interrupted = worker.reconcileInterrupted();
    expect(interrupted.map(s => s.id)).toEqual([sub.id]);
    const reconciled = db.documentReviews.getSubmission(sub.id);
    expect(reconciled.delivery_status).toBe('failed');
    expect(reconciled.last_error).toMatch(/interrupted by a server restart/);
    expect(reconciled.next_attempt_at).not.toBeNull();

    const [delivered] = await worker.tick();
    expect(delivered.delivery_status).toBe('delivered');
    expect(receiver.turns).toHaveLength(0);
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0].key).toBe(`docreview:${sub.id}`);
    const rows = await conversationRows();
    expect(rows.map(m => m.content)).toEqual([sub.message_text, 'Answered before the restart']);
});

test('an in-progress turn answers 409 and the worker waits for the receipt instead of sending again', async () => {
    const time = clock();
    receiver.faults.push('lose', 'in_progress');
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    expect((await worker.deliver(sub.id)).delivery_status).toBe('failed');

    time.advance(1500);
    const [waiting] = await worker.tick();
    expect(waiting.delivery_status).toBe('failed');
    expect(waiting.delivery_attempts).toBe(2);
    expect(waiting.last_error).toMatch(/still processing/i);
    expect(waiting.next_attempt_at).not.toBeNull();
    expect(receiver.turns).toHaveLength(1);

    time.advance(1500);
    const [delivered] = await worker.tick();
    expect(delivered.delivery_status).toBe('delivered');
    expect(delivered.delivery_attempts).toBe(3);
    expect(receiver.turns).toHaveLength(1);
    expect(receiver.requests).toHaveLength(3);
    expect(await conversationRows()).toHaveLength(2);
});

test('a healthy receiver delivers in one keyed request', async () => {
    const worker = createDocumentReviewDelivery({ db, intervalMs: 0, log: { error() {} } });
    const sub = queueSubmission();
    const delivered = await worker.deliver(sub.id);
    expect(delivered.delivery_status).toBe('delivered');
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0].headerKey).toBe(`docreview:${sub.id}`);
    expect(receiver.requests[0].body).toMatchObject({ message: sub.message_text, projectId: 'proj-1', idempotency_key: `docreview:${sub.id}`, attempt: 1 });
    expect((await conversationRows()).map(m => m.content)).toEqual([sub.message_text, 'Thanks, reviewed turn 1.']);
});

test('a refused durable claim retries safely with the same key after storage recovers', async () => {
    const time = clock();
    receiver.faults.push('claim_failure');
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    const failed = await worker.deliver(sub.id);
    expect(failed.delivery_status).toBe('failed');
    expect(failed.receipt).toBeNull();
    expect(failed.next_attempt_at).not.toBeNull();
    expect(receiver.turns).toHaveLength(0);
    time.advance(1500);
    expect((await worker.tick())[0].delivery_status).toBe('delivered');
    expect(receiver.turns).toHaveLength(1);
    expect(receiver.requests.map(r => r.key)).toEqual([`docreview:${sub.id}`, `docreview:${sub.id}`]);
});

test('an uncertain receiver outcome preserves feedback without a receipt or automatic replay', async () => {
    const time = clock();
    receiver.faults.push('receipt_failure');
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    const failed = await worker.deliver(sub.id);
    expect(failed.delivery_status).toBe('failed');
    expect(failed.last_error).toContain('outcome_uncertain');
    expect(failed.next_attempt_at).toBeNull();
    expect(failed.receipt).toBeNull();
    expect(failed.payload).toEqual(sub.payload);
    expect(failed.message_text).toBe(sub.message_text);
    time.advance(60000);
    const restarted = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, log: { error() {} } });
    restarted.reconcileInterrupted();
    expect(await restarted.tick()).toEqual([]);
    expect(receiver.requests).toHaveLength(1);
    // An explicit retry may ask again, but cannot turn uncertainty into another run.
    expect((await restarted.deliver(sub.id)).delivery_status).toBe('failed');
    expect(receiver.turns).toHaveLength(1);
    expect((await conversationRows()).map(row => [row.role, row.content])).toEqual([['user', sub.message_text]]);
});
