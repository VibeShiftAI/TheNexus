/**
 * Executor-recorded document approvals (2026-10-04, task a2553798).
 *
 * Robert's ruling in questionnaire ask-robert-81299292-0878-4db1-a108-a14cc332f5dc:
 * his recurring "Approve with changes" review does not need a second click
 * from him. The flow: Robert reviews a revision and finishes the review with
 * "make this change, then mark it approved" and the explicit
 * approve-after-changes grant, from his verified Access session or with his
 * operator credential; the dispatched executor applies the change, registers
 * the resulting revision and records the approval of that exact revision with
 * the document executor credential (NEXUS_DOCUMENT_APPROVAL_KEY), declaring
 * itself in the decision body:
 *
 *   "executor": {
 *     "id": "<executor identity>",            required, e.g. praxis-claude-code:claude-fable-5-1
 *     "task_id": "<nexus task>",              optional
 *     "execution_id": "<praxis execution>",   optional
 *     "source_submission_id": "<review submission Robert's instruction arrived as>",
 *     "source_review_id": "<or the review itself>",   one of the two is required
 *     "authorization_ref": "<standing authorization, e.g. the questionnaire id>"   optional
 *   }
 *
 * The server binds the approval to Robert's own instruction rather than to
 * the executor's say-so:
 *   - only the document executor credential may carry executor provenance,
 *     and it may record nothing else. A verified Access session and the
 *     operator credential are Robert himself and record direct decisions;
 *     executor and bridge headers are refused before this module runs. The
 *     document credential is a different key from the operator credential, so
 *     it cannot approve a stakeholder proposal (stakeholder-authority.js);
 *   - the cited review must have been finished with the approve-after-changes
 *     grant by an authenticated operator (access_user, access_device or
 *     operator_credential). Every local process reaches the review API as the
 *     shared `local_user`, so an unsigned review, or a signed review without
 *     the grant, is feedback and never an authorization (QA finding on the
 *     first round of this task: a "DO NOT approve" review written by an
 *     unsigned caller was accepted as the source instruction);
 *   - only `approve` can be executor-recorded; requesting changes stays with
 *     the reviewer;
 *   - the cited review must be a submitted review of an earlier revision of
 *     the same document, and the approved revision must be the current one
 *     (the route checks freshness; this module checks lineage);
 *   - nothing may have been decided or reviewed since the instruction: a later
 *     decision or a newer submitted review supersedes it, and an approval
 *     Robert already recorded on the resulting revision is reported as such;
 *   - a review authorizes exactly one executor-recorded approval.
 * The review's summary, comments and grant are snapshotted into the
 * decision's `provenance`, so the record carries the instruction it acted on
 * even if the review is later read against a different revision.
 *
 * Nothing here touches a credential: authority is decided before this module
 * runs (document-decision-authority.js) and no key is read or logged.
 */

const EXECUTOR_FIELDS = new Set(['id', 'task_id', 'execution_id', 'source_review_id', 'source_submission_id', 'authorization_ref']);
const FIELD_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The only authority that may record an executor-recorded approval. */
const EXECUTOR_AUTHORITY = 'document_executor_credential';
/** The operator proofs that can grant delegation when a review is finished: Robert himself, never the executor credential. */
const DELEGATING_AUTHORITIES = new Set(['access_user', 'access_device', 'operator_credential']);

function refusal(status, code, error, extra = {}) {
    return { ok: false, status, code, error, ...extra };
}

function shortText(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > FIELD_MAX || CONTROL_CHARS.test(trimmed)) return null;
    return trimmed;
}

/**
 * Validate the optional `executor` block of a decision body against the
 * authority that was resolved for the request.
 * Returns { ok: true, value: null } when the body carries none (a direct
 * operator decision), { ok: true, value } for a well-formed block, a 403 when
 * the document executor credential tries to decide without one, or a 400.
 */
function parseExecutorProvenance(body, { decision, authority } = {}) {
    if (body.executor === undefined) {
        if (authority === EXECUTOR_AUTHORITY) {
            return refusal(403, 'executor_provenance_required',
                "The document executor credential records only an executor-recorded approval of Robert's own review; a direct decision needs his verified session or operator credential");
        }
        return { ok: true, value: null };
    }
    const block = body.executor;
    const invalid = error => refusal(400, 'invalid_provenance', error);
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return invalid('executor must be an object');
    const unknown = Object.keys(block).filter(key => !EXECUTOR_FIELDS.has(key));
    if (unknown.length) return invalid(`Unknown executor field(s): ${unknown.join(', ')}`);
    if (authority !== EXECUTOR_AUTHORITY) {
        return invalid('Executor provenance is accepted only with the document executor credential; a verified operator session or the operator credential records its own decision');
    }
    if (decision !== 'approve') {
        return refusal(400, 'executor_decision_not_allowed', 'An executor can record only an approval Robert asked for; requesting changes stays with the reviewer');
    }
    const value = {};
    for (const field of EXECUTOR_FIELDS) {
        if (block[field] === undefined || block[field] === null) continue;
        const text = shortText(block[field]);
        if (!text) return invalid(`executor.${field} must be 1-${FIELD_MAX} printable characters`);
        value[field] = text;
    }
    if (!value.id) return invalid('executor.id is required: the executor identity recorded on the decision');
    if (!value.source_review_id && !value.source_submission_id) {
        return invalid("executor.source_submission_id or executor.source_review_id is required: Robert's submitted review that asked for this approval");
    }
    return { ok: true, value };
}

/** Did an authenticated operator finish this review with the explicit approve-after-changes grant? */
function reviewDelegatesApproval(review) {
    return Boolean(review && review.approval_delegated) && DELEGATING_AUTHORITIES.has(review.submitted_authority);
}

/**
 * Find Robert's instruction for an executor-recorded approval and check that
 * it still stands. `revision` is the revision being approved (already known to
 * belong to `doc`). Pure reads; safe to run again inside the insert
 * transaction.
 */
function resolveSourceReview({ store, doc, revision, executor }) {
    let review = null;
    let submission = null;
    const notFound = refusal(404, 'source_review_not_found', 'The cited review was not found on this document');
    if (executor.source_submission_id) {
        submission = store.getSubmission(executor.source_submission_id);
        if (!submission || submission.document_id !== doc.id) return notFound;
        review = store.getReview(submission.review_id);
    }
    if (executor.source_review_id) {
        if (review && review.id !== executor.source_review_id) {
            return refusal(400, 'invalid_provenance', 'executor.source_review_id and executor.source_submission_id name different reviews');
        }
        review = review || store.getReview(executor.source_review_id);
    }
    if (!review || review.document_id !== doc.id) return notFound;
    if (!submission) submission = store.getSubmissionForReview(review.id) || null;
    if (review.status !== 'submitted' || !review.submitted_at) {
        return refusal(409, 'source_review_not_submitted', 'The cited review has not been finished; only a submitted review is an instruction');
    }
    if (!reviewDelegatesApproval(review)) {
        return refusal(403, 'source_review_not_delegated',
            "The cited review did not delegate approval: only a review Robert finished with the approve-after-changes grant from his verified session or operator credential authorizes an executor-recorded approval",
            { source_review_id: review.id, submitted_authority: review.submitted_authority || null, approval_delegated: Boolean(review.approval_delegated) });
    }
    const pinned = store.getRevisionMeta(review.revision_id);
    if (!pinned || pinned.id === revision.id) {
        return refusal(409, 'source_review_revision',
            'The cited review is of this same revision: nothing changed after the instruction, so the reviewer decides directly',
            { source_revision_id: review.revision_id });
    }
    if (String(revision.captured_at) < String(pinned.captured_at)) {
        return refusal(409, 'source_review_revision', 'The revision to approve predates the revision the cited review was written on',
            { source_revision_id: review.revision_id });
    }
    const consumed = store.findDecisionBySourceReview(doc.id, review.id);
    if (consumed) {
        return refusal(409, 'source_review_consumed', 'An executor already recorded an approval on the strength of this review', { decision: consumed });
    }
    const since = store.listDecisionsSince(doc.id, review.submitted_at);
    const decided = since.find(d => d.decision === 'approve' && d.revision_id === revision.id);
    if (decided) {
        return refusal(409, 'already_decided', 'This revision is already approved; read that decision back instead of recording another', { decision: decided });
    }
    if (since.length) {
        return refusal(409, 'source_review_superseded', 'A decision was recorded after the cited review; the instruction no longer stands on its own',
            { decision: since[since.length - 1] });
    }
    const newer = store.listReviews(doc.id)
        .find(r => r.id !== review.id && r.status === 'submitted' && r.submitted_at && r.submitted_at > review.submitted_at);
    if (newer) {
        return refusal(409, 'source_review_superseded', 'A newer review was submitted after the cited one; cite the latest instruction',
            { review: { id: newer.id, revision_id: newer.revision_id, submitted_at: newer.submitted_at } });
    }
    return { ok: true, review, submission, pinned, comments: store.listComments(review.id) };
}

/** The provenance stored on an executor-recorded decision: who recorded it, and the instruction and grant it acted on. */
function buildProvenance({ executor, review, submission, pinned, comments }) {
    return {
        executor: {
            id: executor.id,
            task_id: executor.task_id || null,
            execution_id: executor.execution_id || null,
        },
        source: {
            review_id: review.id,
            submission_id: submission ? submission.id : null,
            revision_id: review.revision_id,
            revision_hash: pinned ? pinned.content_hash : null,
            reviewer_id: review.reviewer_id,
            submitted_at: review.submitted_at,
            instruction: review.summary || '',
            comments: (comments || []).map(comment => ({
                id: comment.id, kind: comment.kind, start_line: comment.start_line, end_line: comment.end_line,
                quote: comment.quote, body: comment.body,
            })),
            delegation: {
                approval_delegated: true,
                authority: review.submitted_authority,
                granted_at: review.submitted_at,
            },
        },
        authorization_ref: executor.authorization_ref || null,
    };
}

module.exports = { parseExecutorProvenance, resolveSourceReview, buildProvenance, reviewDelegatesApproval, EXECUTOR_AUTHORITY, DELEGATING_AUTHORITIES };
