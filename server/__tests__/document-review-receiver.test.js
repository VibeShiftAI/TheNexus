/**
 * Delivery against an ISOLATED HTTP receiver that speaks the Praxis
 * `/api/document-review-notifications` receipt contract (design doc, "Delivery into the Praxis
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
            const key = typeof body.event_id === 'string' ? body.event_id : null;
            requests.push({ method: req.method, url: req.url, headerKey: req.headers['idempotency-key'] || null, key, body });
            const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
            if (req.method !== 'POST' || req.url !== '/api/document-review-notifications') return json(404, { error: 'not found' });
            const fault = faults.shift();
            if (fault === 'in_progress') return json(409, { error: 'in_progress', idempotency_key: key });
            if (fault === 'claim_failure') return json(503, { error: 'idempotency_storage_unavailable', idempotency_key: key, retryable: true });
            const existing = key ? ledger.get(key) : null;
            if (existing?.state === 'uncertain') return json(409, { error: 'outcome_uncertain', idempotency_key: key, retryable: false });
            if (existing) return json(200, { ...existing.reply, duplicate: true, idempotency_key: key });
            turns.push({ key, event: body });
            if (fault === 'receipt_failure') {
                ledger.set(key, { state: 'uncertain' });
                return json(409, { error: 'outcome_uncertain', idempotency_key: key, retryable: false });
            }
            const reply = { event_id: key, document_id: body.document_id, revision_id: body.revision_id, submission_id: body.submission_id, status: 'received', received_at: new Date().toISOString() };
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
    process.env.PRAXIS_DOCUMENT_NOTIFICATION_TIMEOUT_MS = '5000';
    jest.resetModules();
    db = require('../../db');
    ({ createDocumentReviewDelivery } = require('../services/document-review-delivery'));
});

afterEach(async () => {
    await receiver.close();
    delete process.env.NEXUS_DB_PATH;
    delete process.env.PRAXIS_URL;
    delete process.env.PRAXIS_DOCUMENT_NOTIFICATION_TIMEOUT_MS;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

async function conversationRows() {
    const conversation = await db.getActiveConversation('praxis');
    return db.getChatMessages(conversation.id);
}


test('acceptance followed by response loss recovers the same durable receipt with no chat messages', async () => {
    const time = clock();
    receiver.faults.push('lose');
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    const failed = await worker.deliver(sub.id);
    expect(failed.delivery_status).toBe('failed');
    expect(failed.next_attempt_at).not.toBeNull();
    expect(receiver.turns).toHaveLength(1);
    time.advance(1500);
    const [delivered] = await worker.tick();
    expect(delivered.delivery_status).toBe('delivered');
    expect(delivered.receipt).toMatchObject({ transport: 'notification', event_id: `docreview:${sub.id}` });
    expect(receiver.turns).toHaveLength(1);
    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests[1].body).toEqual(receiver.requests[0].body);
    expect(receiver.requests[0].body).toEqual({ type: 'document.review_submitted', schema_version: 1, event_id: `docreview:${sub.id}`, document_id: sub.document_id, revision_id: sub.revision_id, submission_id: sub.id });
    expect(receiver.requests.map(r => r.headerKey)).toEqual([`docreview:${sub.id}`, `docreview:${sub.id}`]);
    expect(await conversationRows()).toEqual([]);
});

test('a restarted outbox recovers a notification accepted before response loss', async () => {
    const time = clock();
    receiver.faults.push('lose');
    const first = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    expect((await first.deliver(sub.id)).delivery_status).toBe('failed');
    const restarted = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    time.advance(1500);
    expect((await restarted.tick())[0].delivery_status).toBe('delivered');
    expect(receiver.turns).toHaveLength(1);
    expect(await conversationRows()).toEqual([]);
});

test('a process that died mid-notification recovers its persisted receiver receipt', async () => {
    const time = clock();
    const sub = queueSubmission({ delivery_status: 'relaying', delivery_attempts: 1, relay_started_at: time.now().toISOString(), next_attempt_at: null });
    receiver.ledger.set(`docreview:${sub.id}`, { state: 'completed', reply: { event_id: `docreview:${sub.id}`, document_id: sub.document_id, revision_id: sub.revision_id, submission_id: sub.id, status: 'received', received_at: time.now().toISOString() } });
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, log: { error() {} } });
    expect(worker.reconcileInterrupted()).toHaveLength(1);
    expect((await worker.tick())[0].delivery_status).toBe('delivered');
    expect(receiver.turns).toHaveLength(0);
    expect(receiver.requests).toHaveLength(1);
    expect(await conversationRows()).toEqual([]);
});

test('receiver storage unavailable retries safely before acknowledging notification', async () => {
    const time = clock();
    receiver.faults.push('claim_failure');
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    const failed = await worker.deliver(sub.id);
    expect(failed.delivery_status).toBe('failed');
    expect(failed.receipt).toBeNull();
    expect(receiver.turns).toHaveLength(0);
    time.advance(1500);
    expect((await worker.tick())[0].delivery_status).toBe('delivered');
    expect(receiver.turns).toHaveLength(1);
    expect(await conversationRows()).toEqual([]);
});

test('a permanent rejection retains the full feedback locally and waits for explicit retry', async () => {
    const time = clock();
    receiver.faults.push('receipt_failure');
    const worker = createDocumentReviewDelivery({ db, now: time.now, intervalMs: 0, backoffMs: [1000], log: { error() {} } });
    const sub = queueSubmission();
    const failed = await worker.deliver(sub.id);
    expect(failed.delivery_status).toBe('failed');
    expect(failed.next_attempt_at).toBeNull();
    expect(failed.receipt).toBeNull();
    expect(failed.payload).toEqual(sub.payload);
    expect(failed.message_text).toBe(sub.message_text);
    time.advance(60000);
    expect(await worker.tick()).toEqual([]);
    expect((await worker.deliver(sub.id)).delivery_status).toBe('failed');
    expect(receiver.turns).toHaveLength(1);
    expect(await conversationRows()).toEqual([]);
});
