/**
 * Durable outbox that carries a finished document review into Robert's
 * existing Praxis conversation.
 *
 * It reuses the canonical Nexus → Praxis chat seam: the same `praxisFetch`
 * relay to Praxis `/api/chat` and the same `chat_conversations` /
 * `chat_messages` persistence the bridge chat uses, so the review is a turn
 * in the live conversation and Praxis answers in place.
 *
 * Idempotency is durable on both sides of the seam. Here, the user turn is
 * stored under the deterministic id `docreview:<submissionId>` and the reply
 * under `docreview:<submissionId>:reply`: a stored reply marks the submission
 * delivered without a second relay, and an in-process map joins concurrent
 * attempts (double clicks). On the wire, every attempt carries the same
 * submission key (`Idempotency-Key` header and `idempotency_key` body field)
 * with the byte-identical message, so Praxis's chat ledger runs the review at
 * most once: a retry after a lost response gets the recorded reply back
 * (`duplicate: true`), and a turn that is still running answers 409 so the
 * worker waits for its receipt. That is what makes transport faults
 * (unreachable, reset, timeout, 503, a restart mid-relay) safe to retry
 * automatically with backoff; a definite rejection (any other 4xx/5xx) waits
 * for an explicit retry, which resends under the same key. Nothing is relayed
 * before Finish review: only rows that exist in the outbox are delivered.
 */
const { praxisFetch } = require('./praxis-client');
const { buildChatMessageEvent, buildPraxisAssistantMetadata } = require('../chat-message-format');

const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
const DEFAULT_RELAY_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_AUTO_ATTEMPTS = 6;
/** Outcomes where Praxis either never ran the turn or will answer the keyed retry from its ledger. */
const RETRYABLE_CODES = new Set(['PRAXIS_UNREACHABLE', 'PRAXIS_TIMEOUT', 'PRAXIS_IN_PROGRESS']);
const EXPLICIT_RETRY_NOTE = ' (retry resends this review under the same submission id; Praxis deduplicates it)';

function relayTimeoutMs() {
    const configured = Number.parseInt(process.env.PRAXIS_CHAT_TIMEOUT_MS || '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RELAY_TIMEOUT_MS;
}

/**
 * Default relay: one non-streaming Praxis chat turn, same shape the bridge
 * uses, plus the submission key that lets Praxis deduplicate a resend.
 */
async function relayToPraxis(message, { projectId, idempotencyKey, attempt } = {}) {
    const response = await praxisFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        body: JSON.stringify({
            message,
            ...(projectId ? { projectId } : {}),
            ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
            ...(attempt ? { attempt } : {}),
        }),
        timeoutMs: relayTimeoutMs(),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        if (response.status === 409 && body?.error === 'in_progress') {
            const error = new Error('Praxis is still processing this review turn; waiting for its receipt');
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

function createDocumentReviewDelivery({ db, io, relay = relayToPraxis, now = () => new Date(), intervalMs = DEFAULT_INTERVAL_MS, backoffMs = DEFAULT_BACKOFF_MS, log = console } = {}) {
    const inflight = new Map();
    let timer = null;
    const store = () => db?.documentReviews;
    const emit = row => { if (row && io) io.emit('chat-message', buildChatMessageEvent(row)); };

    function receiptFor(sub, conversationId, replyId) {
        return {
            conversation_id: conversationId,
            user_message_id: userMessageId(sub.id),
            assistant_message_id: replyId,
            delivered_at: now().toISOString(),
        };
    }

    function markDelivered(sub, conversationId, replyId) {
        return store().updateSubmission(sub.id, {
            delivery_status: 'delivered',
            delivered_at: now().toISOString(),
            last_error: null,
            next_attempt_at: null,
            relay_started_at: null,
            receipt: receiptFor(sub, conversationId, replyId),
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

        const payload = sub.payload || {};
        const replyId = replyMessageId(sub.id);
        const turnKey = userMessageId(sub.id);

        // Response loss after the reply was saved: the status update never
        // landed. Finish the bookkeeping, relay nothing.
        const storedReply = await db.getChatMessageById(replyId);
        if (storedReply) return markDelivered(sub, storedReply.conversation_id, storedReply.id);

        let userRow = await db.getChatMessageById(turnKey);
        if (!userRow) {
            const conversation = await db.getActiveConversation('praxis');
            if (!conversation?.id) {
                return markFailed({ ...sub, delivery_attempts: sub.delivery_attempts + 1 }, 'Chat storage unavailable: no Praxis conversation to deliver into', { retryable: true });
            }
            userRow = await db.saveChatMessage({
                id: turnKey,
                conversation_id: conversation.id,
                role: 'user',
                content: sub.message_text,
                mode: 'praxis',
                metadata: {
                    documentReview: {
                        submissionId: sub.id,
                        reviewId: sub.review_id,
                        documentId: sub.document_id,
                        documentTitle: payload.document?.title || null,
                        reviewUrl: payload.review_url || null,
                    },
                },
            });
            if (!userRow) {
                return markFailed({ ...sub, delivery_attempts: sub.delivery_attempts + 1 }, 'The review turn could not be saved to the Praxis conversation', { retryable: true });
            }
            emit(userRow);
        }

        sub = outbox.updateSubmission(sub.id, {
            delivery_status: 'relaying',
            delivery_attempts: sub.delivery_attempts + 1,
            relay_started_at: now().toISOString(),
            last_error: null,
            next_attempt_at: null,
        });

        // Every attempt sends the identical turn under the same key; the
        // attempt counter is metadata for Praxis's log, not part of the turn.
        let data;
        try {
            data = await relay(sub.message_text, {
                projectId: payload.document?.project_id || undefined,
                submission: sub,
                idempotencyKey: turnKey,
                attempt: sub.delivery_attempts,
            });
        } catch (err) {
            const retryable = isRetryable(err);
            log.error?.(`[DocumentReview] Delivery of ${sub.id} failed (attempt ${sub.delivery_attempts}): ${err?.message || err}`);
            return markFailed(sub, `${err?.message || 'Delivery failed'}${retryable ? '' : EXPLICIT_RETRY_NOTE}`, { retryable });
        }
        if (data?.duplicate === true) {
            log.info?.(`[DocumentReview] Praxis returned the recorded reply for ${sub.id} (attempt ${sub.delivery_attempts}); no second turn was run`);
        }

        // Chat history orders by created_at; keep the reply strictly after the
        // turn it answers even when Praxis answers within the same millisecond.
        const userStamp = Date.parse(userRow.created_at || '') || 0;
        const reply = await db.saveChatMessage({
            id: replyId,
            conversation_id: userRow.conversation_id,
            created_at: new Date(Math.max(now().getTime(), userStamp + 1)).toISOString(),
            role: 'assistant',
            content: (data && typeof data.response === 'string' && data.response) || 'No response',
            mode: 'praxis',
            metadata: { ...buildPraxisAssistantMetadata(data || {}), replyTo: turnKey, documentReview: { submissionId: sub.id, ...(data?.duplicate === true ? { recoveredReceipt: true } : {}) } },
        });
        if (!reply) {
            const existing = await db.getChatMessageById(replyId);
            if (existing) return markDelivered(sub, existing.conversation_id, existing.id);
            return markFailed(sub, `Praxis replied but the reply could not be saved to the conversation${EXPLICIT_RETRY_NOTE}`, { retryable: false });
        }
        emit(reply);
        return markDelivered(sub, reply.conversation_id, reply.id);
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
     * Praxis answers it from its ledger (recorded reply, or 409 while the
     * turn is still running), so the receipt is recovered without a second
     * turn. Past the automatic cap the row waits for an explicit retry.
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
                last_error: `Delivery was interrupted by a server restart before Praxis confirmed the reply; ${canAutoRetry ? 'recovering the receipt under the same submission id' : `automatic retries are exhausted${EXPLICIT_RETRY_NOTE}`}`,
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
