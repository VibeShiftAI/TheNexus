/** Durable identifier-only document-review notification outbox.
 * Nexus owns the immutable feedback. Praxis acknowledges a durable event,
 * then retrieves that feedback and its exact document revision directly.
 * Delivery here means notified, never revision work completed. Historical
 * chat receipts can be adopted during migration; new deliveries never write chat.
 */
const { praxisFetch } = require('./praxis-client');

const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
const DEFAULT_RELAY_TIMEOUT_MS = 30 * 1000;
const MAX_AUTO_ATTEMPTS = 6;
/** Transport failures safe to retry because event receipt is durable and idempotent. */
const RETRYABLE_CODES = new Set(['PRAXIS_UNREACHABLE', 'PRAXIS_TIMEOUT', 'PRAXIS_IN_PROGRESS']);
const EXPLICIT_RETRY_NOTE = ' (retry resends this review under the same submission id; Praxis deduplicates it)';

function relayTimeoutMs() {
    const configured = Number.parseInt(process.env.PRAXIS_DOCUMENT_NOTIFICATION_TIMEOUT_MS || '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RELAY_TIMEOUT_MS;
}

/** The transport never includes document text or comments. */
async function relayToPraxis(event, { idempotencyKey } = {}) {
    const response = await praxisFetch('/api/document-review-notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        body: JSON.stringify(event),
        timeoutMs: relayTimeoutMs(),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        if (response.status === 409 && body?.error === 'in_progress') {
            const error = new Error('Praxis is still receiving this review notification; waiting for its receipt');
            error.status = 409;
            error.code = 'PRAXIS_IN_PROGRESS';
            throw error;
        }
        const error = new Error(`Praxis returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function userMessageId(submissionId) { return `docreview:${submissionId}`; }
function replyMessageId(submissionId) { return `${userMessageId(submissionId)}:reply`; }

function isRetryable(err) {
    return RETRYABLE_CODES.has(err?.code) || (typeof err?.status === 'number' && err.status === 503);
}

function createDocumentReviewDelivery({ db, relay = relayToPraxis, now = () => new Date(), intervalMs = DEFAULT_INTERVAL_MS, backoffMs = DEFAULT_BACKOFF_MS, log = console } = {}) {
    const inflight = new Map();
    let timer = null;
    const store = () => db?.documentReviews;

    function markDelivered(sub, receipt) {
        return store().updateSubmission(sub.id, {
            delivery_status: 'delivered', delivered_at: now().toISOString(),
            last_error: null, next_attempt_at: null, relay_started_at: null,
            receipt: { ...receipt, delivered_at: now().toISOString() },
        });
    }

    function markFailed(sub, message, { retryable }) {
        const attempts = sub.delivery_attempts;
        const canAutoRetry = retryable && attempts < MAX_AUTO_ATTEMPTS;
        const delay = backoffMs[Math.min(Math.max(attempts - 1, 0), backoffMs.length - 1)];
        return store().updateSubmission(sub.id, {
            delivery_status: 'failed',
            delivery_attempts: attempts,
            last_error: message,
            relay_started_at: null,
            next_attempt_at: canAutoRetry ? new Date(now().getTime() + delay).toISOString() : null,
        });
    }

    async function attempt(submissionId) {
        const outbox = store();
        if (!outbox) throw new Error('Document review storage unavailable');
        let sub = outbox.getSubmission(submissionId);
        if (!sub) return null;
        if (sub.delivery_status === 'delivered') return sub;

        const event = {
            type: 'document.review_submitted', schema_version: 1,
            event_id: userMessageId(sub.id), document_id: sub.document_id,
            revision_id: sub.revision_id, submission_id: sub.id,
        };
        // A pre-migration reply already persisted is evidence of delivery.
        // Adopt it without relaying or adding either chat message again.
        const storedReply = await db.getChatMessageById?.(replyMessageId(sub.id));
        if (storedReply) return markDelivered(sub, {
            transport: 'legacy_chat', conversation_id: storedReply.conversation_id,
            user_message_id: userMessageId(sub.id), assistant_message_id: storedReply.id,
        });

        sub = outbox.updateSubmission(sub.id, {
            delivery_status: 'relaying',
            delivery_attempts: sub.delivery_attempts + 1,
            relay_started_at: now().toISOString(),
            last_error: null,
            next_attempt_at: null,
        });

        // The same stable event is safe after an acknowledgement is lost.
        try {
            const data = await relay(event, { idempotencyKey: event.event_id, attempt: sub.delivery_attempts });
            const receipt = data?.receipt ?? data;
            const identifiers = ['event_id', 'document_id', 'revision_id', 'submission_id'];
            if (!receipt || identifiers.some(key => receipt[key] !== event[key])
                || !['received', 'processing', 'processed', 'needs_attention'].includes(receipt.status)
                || typeof receipt.received_at !== 'string' || !Number.isFinite(Date.parse(receipt.received_at))) {
                throw Object.assign(new Error('Praxis did not return a matching durable notification receipt'), { code: 'INVALID_NOTIFICATION_RECEIPT' });
            }
            return markDelivered(sub, {
                transport: 'notification', ...Object.fromEntries(identifiers.map(key => [key, receipt[key]])),
                status: receipt.status, received_at: receipt.received_at,
                ...(data.duplicate === true ? { duplicate: true } : {}),
            });
        } catch (err) {
            const retryable = isRetryable(err);
            log.error?.(`[DocumentReview] Notification of ${sub.id} failed (attempt ${sub.delivery_attempts}): ${err?.message || err}`);
            return markFailed(sub, `${err?.message || 'Notification failed'}${retryable ? '' : EXPLICIT_RETRY_NOTE}`, { retryable });
        }
    }

    /** Deliver one submission; concurrent calls for the same id share one attempt. */
    function deliver(submissionId) {
        if (inflight.has(submissionId)) return inflight.get(submissionId);
        const promise = attempt(submissionId).finally(() => inflight.delete(submissionId));
        inflight.set(submissionId, promise);
        return promise;
    }

    /**
     * Rows left `relaying` by a previous process cannot be confirmed from
     * here. Report them truthfully and schedule an immediate keyed retry:
     * Praxis answers it from its durable event ledger, so recovery does not
     * create another review-processing job. Past the automatic cap the row waits for an explicit retry.
     */
    function reconcileInterrupted() {
        const outbox = store();
        if (!outbox) return [];
        const interrupted = outbox.listRelayingSubmissions();
        for (const sub of interrupted) {
            if (inflight.has(sub.id)) continue;
            const canAutoRetry = sub.delivery_attempts < MAX_AUTO_ATTEMPTS;
            outbox.updateSubmission(sub.id, {
                delivery_status: 'failed',
                last_error: `Delivery was interrupted by a server restart before Praxis confirmed receipt; ${canAutoRetry ? 'recovering the receipt under the same submission id' : `automatic retries are exhausted${EXPLICIT_RETRY_NOTE}`}`,
                relay_started_at: null,
                next_attempt_at: canAutoRetry ? now().toISOString() : null,
            });
        }
        return interrupted;
    }

    async function tick() {
        const outbox = store();
        if (!outbox) return [];
        const due = outbox.listDueSubmissions(now().toISOString());
        const results = [];
        for (const sub of due) {
            try { results.push(await deliver(sub.id)); } catch (err) {
                log.error?.(`[DocumentReview] Outbox tick failed for ${sub.id}: ${err?.message || err}`);
            }
        }
        return results;
    }

    function start() {
        try { reconcileInterrupted(); } catch (err) { log.error?.(`[DocumentReview] Outbox reconcile failed: ${err?.message || err}`); }
        if (timer || !(intervalMs > 0)) return;
        timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
        timer.unref?.();
        tick().catch(() => {});
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { deliver, tick, start, stop, reconcileInterrupted, userMessageId, replyMessageId };
}

module.exports = { createDocumentReviewDelivery, relayToPraxis, userMessageId, replyMessageId, MAX_AUTO_ATTEMPTS, isRetryable };
