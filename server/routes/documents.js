/**
 * Markdown document review API (design: docs/superpowers/specs/
 * 2026-09-10-markdown-document-review-design.md).
 *
 *   POST   /api/documents                                  register a Markdown file (server-issued id, allowlisted path);
 *                                                          with `deliverable` it is a declared deliverable: strictly
 *                                                          validated, identity-stable, answered with a receipt
 *                                                          bound to the exact file bytes
 *   GET    /api/documents?status=&task_id=&project_id=&kind=&q=&limit=&offset=
 *                                                          one page of documents (newest first) with the caller's
 *                                                          review state, review_status and the matching total
 *   POST   /api/documents/relocations                      { from_root, to_root, source?, task_id?, reason? }: move every
 *                                                          registration inside a landed run's worktree to the same
 *                                                          relative path in the checkout it landed in, when that file
 *                                                          holds the exact bytes of the current revision; id, revisions,
 *                                                          decisions and review state kept (contract §14)
 *   GET    /api/documents/counts?task_id=&project_id=&kind=&q=   per-review-status totals for the same filters
 *   GET    /api/documents/:id                              document + current revision + content + the caller's review
 *   GET    /api/documents/:id/raw?revision=&download=1     Markdown source (current or pinned revision)
 *   GET    /api/documents/:id/revisions/:revisionId        a pinned snapshot
 *   GET    /api/documents/:id/history                      revisions, decisions, registration receipts and review rounds
 *   POST   /api/documents/:id/decisions                    { decision: approve|request_changes, revision_id, ... }
 *                                                          operator only, pinned to the exact current revision; or
 *                                                          executor-recorded: the document executor credential with an
 *                                                          `executor` block citing a review Robert finished with the
 *                                                          approve-after-changes grant
 *   GET    /api/documents/:id/decisions/:decisionId        a decision and whether it is still in force (consumer check)
 *   POST   /api/documents/:id/reviews                      open the caller's draft on the current revision, or return the one
 *                                                          already open (pinned to its own revision; 409 while the version
 *                                                          takes no review actions, with or without a draft)
 *   GET    /api/documents/reviews/:reviewId                review + comments (+ anchor state against the current revision)
 *   PATCH  /api/documents/reviews/:reviewId                { summary } (draft only)
 *   POST   /api/documents/reviews/:reviewId/comments       add a passage or whole-document comment (draft only; client_id dedupes)
 *   PATCH  /api/documents/reviews/:reviewId/comments/:commentId   { body }
 *   DELETE /api/documents/reviews/:reviewId/comments/:commentId
 *   POST   /api/documents/reviews/:reviewId/finish         { summary?, approve_after_changes? } → one durable submission per
 *                                                          review, delivery queued; the flag records Robert's approval of the
 *                                                          reviewed revision with his note, and needs his own operator proof
 *   GET    /api/documents/reviews/:reviewId/submission     delivery state + receipt
 *   POST   /api/documents/reviews/:reviewId/submission/retry
 *   POST   /api/documents/:id/replacements                 accept replacement work for an authorized change request
 *                                                          (idempotent by client_request_id; one open item per document;
 *                                                          supersedes every pending review draft atomically)
 *   GET    /api/documents/:id/replacements                 the document's replacement history and its open item
 *   GET    /api/documents/:id/replacements/:replacementId  one item and whether its result is the current ready revision
 *   PATCH  /api/documents/:id/replacements/:replacementId  report dispatch/QA/result progress; `ready` is verified, never trusted
 *
 * Versions (task 6b46dcc8, contract §12): a document has one current revision;
 * only the latest ready revision takes new reviews, decisions and edits. While
 * replacement work is open the document is `in_progress` for lists and counts
 * and every review action answers 409 replacement_in_progress; a draft closed
 * by that acceptance is read-only (409 review_superseded) with its comments kept.
 * Failure or cancellation reopens the unchanged version only when the attempt
 * registered no result and no failed result governs the current version. A
 * failed or cancelled attempt whose registered bytes are the current revision
 * governs it instead: those bytes take no review actions (409
 * replacement_failed) until an explicit recovery delivers, and a recovery that
 * itself ends before registering anything leaves them closed.
 *
 * Retiring replaced documents (task d9f46e2f, contract §13): a registration,
 * plain or declared, may carry `replaces: [{ document_id } | { deliverable_key }
 * | { path }]`. Once the registering document is waiting for review (in the
 * queue, not approved) and ready to view (Robert's ruling, 2026-11-19), each
 * named document still waiting is moved to Reference with no decision
 * recorded, unless open replacement work,
 * an unsent outgoing message, unsubmitted draft comments, waiting tasks or an
 * agent review keep it; every name is answered with its outcome and reasons.
 * POST /:id/request-review reopens a retired document. Never by title, project
 * or age.
 *
 * Mounted behind the server's `authenticate` middleware; every review belongs
 * to the authenticated reviewer. The router never touches task status.
 *
 * Comments, Finish review and task QA never approve anything and nothing here
 * sends or publishes. Editorial approval never authorizes sending. The separate
 * outgoing API records an exact operator send grant for Praxis to claim once
 * (docs/contracts/document-review-deliverables.md).
 */
const express = require('express');
const { createAgentReviewsRouter } = require('./document-agent-reviews');
const { inlineComments } = require('../services/document-unified-comments');
const { createDocumentOutgoingRouter } = require('./document-outgoing');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { listProjectRoots, resolveDocumentPath, readDocumentFile, readArtifactFile, sha256, exactIdentity, revisionHash } = require('../services/document-registry');
const { RELOCATION_SOURCES, parseRoot, rootsOverlap, relocateDocuments } = require('../services/document-relocation');
const media = require('../services/review-media');
const fmt = require('../services/document-review-format');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');
const { parseExecutorProvenance, resolveSourceReview, buildProvenance, DELEGATING_AUTHORITIES } = require('../services/document-decision-provenance');
const decisionItems = require('../services/document-decision-items');
const confirmation = require('../services/operator-confirmation');
const { LIST_STATUSES, REPLACEMENT_STATES, REPLACEMENT_OPEN_STATES } = require('../../db/document-reviews');
const { NAME_FIELDS } = require('../../db/document-retirements');

const KINDS = new Set(['document', 'report', 'spec', 'plan', 'research', 'walkthrough', 'other', 'design', 'image', 'video', 'audio', 'prototype', 'pdf', 'data']);
const LIMITS = { title: 300, body: 20000, summary: 20000, selection: 2000, metadataJson: 8000, clientId: 120, purpose: 500, key: 300, sourceId: 200, query: 200, selectionJson: 2048, editSummary: 2000 };
/** What the deliverable is for once approved. Approval records the decision; it never performs the action. */
const INTENDED_ACTIONS = new Set(['none', 'implement', 'send', 'publish']);
const { parseBlockingTaskIds } = require('../../db/document-review-blockers');
const DELIVERABLE_FIELDS = new Set(['key', 'purpose', 'requires_review', 'intended_action', 'source', 'blocking_task_ids']);
const SOURCE_TYPES = new Set(['task', 'chat', 'report']);
const SOURCE_ID_FIELDS = ['conversation_id', 'message_id', 'execution_id'];
const DECISIONS = new Set(['approve', 'request_changes']);
/** Idempotency key of the approval a finished review records (one per review); a direct decision may not use this prefix. */
const FINISH_APPROVAL_KEY = 'review-finish:';
const STATUS_FILTERS = new Set(['all', ...LIST_STATUSES]);
/** States a consumer may report on a replacement; `ready` is verified against the document before it is stored. */
const REPORTABLE_STATES = new Set(REPLACEMENT_STATES);
const ACCEPT_STATES = new Set(['accepted', 'queued', 'held', 'running']);
const QA_STATES = new Set(['pending', 'passed', 'failed']);
const REPLACEMENT_FIELDS = new Set(['client_request_id', 'source', 'task_id', 'execution_id', 'state', 'detail', 'recovers_replacement_id']);
const REPLACEMENT_SOURCE_FIELDS = new Set(['submission_id', 'review_id', 'decision_id']);
const REPLACEMENT_PATCH_FIELDS = new Set(['state', 'detail', 'task_id', 'execution_id', 'qa_state', 'revision_id']);
/** Board statuses of a linked task that end its replacement from Nexus's side. */
const TASK_DONE = new Set(['completed', 'complete', 'done']);
const TASK_CANCELLED = new Set(['cancelled', 'canceled', 'rejected', 'deleted', 'archived']);
const TASK_FAILED = new Set(['failed']);
const PAGE = { default: 100, max: 200 };
/** What a request to move registrations to a landed checkout may carry (contract §14). */
const RELOCATION_FIELDS = new Set(['from_root', 'to_root', 'source', 'task_id', 'reason']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function text(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) return null;
    return trimmed;
}

function badRequest(error, code = 'invalid_deliverable') {
    return { ok: false, status: 400, code, error };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The context an executor-provenance refusal carries beyond error and code (the competing decision or review, the reviewed revision). */
function sourceDetails(refusal) {
    const { ok, status, code, error, ...details } = refusal;
    return details;
}

function validMetadata(value) {
    return isPlainObject(value) && JSON.stringify(value).length <= LIMITS.metadataJson;
}

/**
 * `replaces` on a registration, plain or declared (task d9f46e2f, contract §13): the waiting review documents this
 * one replaces, each named by exactly one exact identity: `{ document_id }`, `{ deliverable_key }` or `{ path }`
 * (absolute). Nothing is ever matched by title, project or age. Naming nothing is valid. A malformed list is refused
 * before anything is written; a well-formed name that matches nothing is not an error, it is reported per name.
 * There is no count or length limit of its own: the request body limit in server/server.js bounds the list, duplicate
 * names collapse to one, and a name too long to match any document is simply reported `not_found`.
 */
function parseReplaces(value) {
    if (value === undefined || value === null) return { ok: true, value: [] };
    const refuse = error => badRequest(error, 'invalid_replaces');
    if (!Array.isArray(value)) return refuse('replaces must be an array of names');
    const seen = new Set();
    const names = [];
    for (const item of value) {
        const keys = isPlainObject(item) ? Object.keys(item) : [];
        if (keys.length !== 1 || !NAME_FIELDS.includes(keys[0])) {
            return refuse(`Each replaces entry must be an object with exactly one of ${NAME_FIELDS.join(', ')}`);
        }
        const by = keys[0];
        const given = typeof item[by] === 'string' ? item[by].trim() : '';
        if (!given || CONTROL_CHARS.test(given)) return refuse(`replaces ${by} must be a non-empty string of printable characters`);
        if (by === 'path' && !path.isAbsolute(given)) return refuse('replaces path must be an absolute path');
        const named = by === 'path' ? path.normalize(given) : given;
        if (seen.has(`${by}\u0000${named}`)) continue;
        seen.add(`${by}\u0000${named}`);
        names.push({ by, value: named });
    }
    return { ok: true, value: names };
}

/**
 * Validate a declared deliverable registration body. Strict about review authority: an
 * unknown or misspelled field is refused rather than silently registering a
 * reference document in place of a review request.
 */
function parseDeclaration(body) {
    const declared = body.deliverable;
    if (!isPlainObject(declared)) return badRequest('deliverable must be an object');
    const unknown = Object.keys(declared).filter(key => !DELIVERABLE_FIELDS.has(key));
    if (unknown.length) return badRequest(`Unknown deliverable field(s): ${unknown.join(', ')}`);
    if (typeof declared.requires_review !== 'boolean') return badRequest('deliverable.requires_review must be true or false');
    const purpose = declared.purpose == null || (typeof declared.purpose === 'string' && !declared.purpose.trim())
        ? 'Purpose not provided.' : text(declared.purpose, LIMITS.purpose);
    if (!purpose) return badRequest(`deliverable.purpose must be 1-${LIMITS.purpose} characters`);
    if (!INTENDED_ACTIONS.has(declared.intended_action)) {
        return badRequest(`deliverable.intended_action must be one of ${[...INTENDED_ACTIONS].join(', ')}`);
    }
    if (declared.intended_action !== 'none' && !declared.requires_review) {
        return badRequest('A deliverable intended for an action must require review: approval comes before the action');
    }
    let blockingTaskIds;
    if (declared.blocking_task_ids !== undefined) {
        const parsed = parseBlockingTaskIds(declared.blocking_task_ids);
        if (!parsed.ok) return badRequest(parsed.error);
        blockingTaskIds = parsed.value;
        if (blockingTaskIds.length && !declared.requires_review) return badRequest('Waiting tasks require a reviewable document');
    }
    let key = null;
    if (declared.key !== undefined) {
        key = text(declared.key, LIMITS.key);
        if (!key || CONTROL_CHARS.test(key) || key.startsWith('path:')) {
            return badRequest(`deliverable.key must be 1-${LIMITS.key} printable characters and must not start with "path:"`);
        }
    }
    let source = null;
    if (declared.source !== undefined) {
        if (!isPlainObject(declared.source)) return badRequest('deliverable.source must be an object');
        const unknownSource = Object.keys(declared.source).filter(field => field !== 'type' && !SOURCE_ID_FIELDS.includes(field));
        if (unknownSource.length) return badRequest(`Unknown deliverable.source field(s): ${unknownSource.join(', ')}`);
        if (!SOURCE_TYPES.has(declared.source.type)) return badRequest('deliverable.source.type must be "task", "chat" or "report"');
        source = { type: declared.source.type };
        for (const field of SOURCE_ID_FIELDS) {
            if (declared.source[field] === undefined) continue;
            const value = text(declared.source[field], LIMITS.sourceId);
            if (!value || CONTROL_CHARS.test(value)) return badRequest(`deliverable.source.${field} must be 1-${LIMITS.sourceId} printable characters`);
            source[field] = value;
        }
        if (source.type === 'chat' && !source.conversation_id) return badRequest('A chat deliverable needs deliverable.source.conversation_id');
        if (source.type === 'report' && !source.execution_id) return badRequest('A report deliverable needs deliverable.source.execution_id (report revision id)');
    }
    const title = text(body.title, LIMITS.title);
    if (!title) return badRequest(`A declared deliverable needs a title of 1-${LIMITS.title} characters`);
    const projectId = text(body.project_id, 120);
    if (!projectId) return badRequest('A declared deliverable needs its project_id');
    let taskId = null;
    if (body.task_id !== undefined && body.task_id !== null) {
        taskId = text(body.task_id, 120);
        if (!taskId) return badRequest('task_id must be a short string');
    }
    if (!taskId && !['chat', 'report'].includes(source?.type)) return badRequest('task_id is required unless the deliverable comes from a chat or report');
    let kind = null;
    if (body.kind !== undefined) {
        kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        if (!KINDS.has(kind)) return badRequest(`kind must be one of ${[...KINDS].join(', ')}`);
    }
    if (body.metadata !== undefined && !validMetadata(body.metadata)) return badRequest('metadata must be a small JSON object');
    // Decisions Praxis would refuse are refused here too, so a producer never gets a receipt for questions the viewer cannot show.
    const items = body.metadata?.decision_items === undefined ? null : decisionItems.parseDecisionItems(body.metadata.decision_items);
    if (items && !items.ok) return badRequest(`metadata.decision_items: ${items.error}`, 'invalid_decision_items');
    let expectedHash = null;
    if (body.expected_content_hash !== undefined) {
        if (typeof body.expected_content_hash !== 'string' || !HASH_PATTERN.test(body.expected_content_hash)) {
            return badRequest('expected_content_hash must be a lowercase hex SHA-256');
        }
        expectedHash = body.expected_content_hash;
    }
    const replaces = parseReplaces(body.replaces);
    if (!replaces.ok) return replaces;
    return {
        ok: true,
        value: {
            key, purpose, title, projectId, taskId, kind, source, expectedHash, blockingTaskIds, replaces: replaces.value,
            requiresReview: declared.requires_review, intendedAction: declared.intended_action,
            // The decision-items revision stamp is Nexus's own record, never taken from a producer.
            metadata: decisionItems.withoutRevisionStamp(body.metadata) || null,
        },
    };
}

/** Query string → list filters. Repeated parameters and out-of-range paging are refused, not guessed. */
function parseListQuery(query, { paging = true } = {}) {
    const single = name => {
        const value = query[name];
        if (value === undefined) return { ok: true, value: undefined };
        if (typeof value !== 'string') return { ok: false, error: `${name} may be given once` };
        return { ok: true, value };
    };
    const read = {};
    for (const name of ['status', 'limit', 'offset', 'task_id', 'project_id', 'kind', 'q', 'include_mail']) {
        const result = single(name);
        if (!result.ok) return result;
        read[name] = result.value;
    }
    const filters = {};
    if (read.include_mail !== undefined && !['0', '1'].includes(read.include_mail)) return { ok: false, error: 'include_mail must be 0 or 1' };
    if (read.include_mail === '1') filters.include_mail = true;
    for (const name of ['task_id', 'project_id']) {
        if (!read[name]) continue;
        if (read[name].length > 120) return { ok: false, error: `${name} must be a short string` };
        filters[name] = read[name];
    }
    if (read.kind) {
        if (!KINDS.has(read.kind)) return { ok: false, error: `kind must be one of ${[...KINDS].join(', ')}` };
        filters.kind = read.kind;
    }
    if (read.q !== undefined) {
        const q = read.q.trim();
        if (q.length > LIMITS.query) return { ok: false, error: `q must be at most ${LIMITS.query} characters` };
        if (q) filters.q = q;
    }
    if (!paging) return { ok: true, value: { filters } };
    const status = read.status === undefined || read.status === '' ? 'all' : read.status;
    if (!STATUS_FILTERS.has(status)) return { ok: false, error: `status must be one of ${[...STATUS_FILTERS].join(', ')}` };
    const limit = read.limit === undefined ? PAGE.default : (/^\d+$/.test(read.limit) ? Number(read.limit) : NaN);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max) return { ok: false, error: `limit must be an integer from 1 to ${PAGE.max}` };
    const offset = read.offset === undefined ? 0 : (/^\d+$/.test(read.offset) ? Number(read.offset) : NaN);
    if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, error: 'offset must be a non-negative integer' };
    return { ok: true, value: { status, limit, offset, filters } };
}

/** Resolve aliases for identity lookup even when a registered file is missing.
 * This grants no path access: only a matching stored document is subsequently
 * read through the normal project-root boundary. */
function registrationIdentityPath(value, seen = new Set()) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null;
    const normalized = path.normalize(value);
    if (seen.has(normalized)) return normalized;
    seen.add(normalized);
    try { return fs.realpathSync.native(normalized); } catch { /* missing bytes still have an identity */ }
    try {
        const target = fs.readlinkSync(normalized);
        return registrationIdentityPath(path.resolve(path.dirname(normalized), target), seen);
    } catch { /* not a symlink; resolve the existing ancestor instead */ }
    const parent = path.dirname(normalized);
    if (parent === normalized) return normalized;
    const resolvedParent = registrationIdentityPath(parent, seen);
    return resolvedParent ? path.join(resolvedParent, path.basename(normalized)) : normalized;
}

function createDocumentsRouter({ db, delivery, authorizeDecision = createDocumentDecisionAuthority(), proposalCompletion, confirmations = confirmation.operatorConfirmations }) {
    const router = express.Router();
    const store = () => db?.documentReviews;

    router.use((req, res, next) => {
        if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
        if (!store()) return res.status(503).json({ error: 'Document review storage unavailable' });
        next();
    });

    router.use(createAgentReviewsRouter({ db, authorizeDecision, recordRevision, reviewability, reconcileReplacement, proposalCompletion }));

    // ── Shared helpers ────────────────────────────────────────────────────
    function revisionMeta(revision) {
        if (!revision) return null;
        const { content, ...meta } = revision;
        // Editorial draft numbers are distinct from immutable capture order.
        return { ...meta, ...store().revisionDraft(revision.id) };
    }

    // ── Versions and replacement work (task 6b46dcc8) ─────────────────────
    const isOpenState = state => REPLACEMENT_OPEN_STATES.includes(state);

    /** The public shape of a replacement work item. */
    function replacementView(rp) {
        if (!rp) return null;
        const submission = rp.source_submission_id ? store().getSubmission(rp.source_submission_id) : null;
        return {
            id: rp.id, document_id: rp.document_id, state: rp.state, open: isOpenState(rp.state), terminal: !isOpenState(rp.state),
            detail: rp.detail || null, qa_state: rp.qa_state || null,
            base_revision_id: rp.base_revision_id, result_revision_id: rp.result_revision_id || null,
            task_id: rp.task_id || null, execution_id: rp.execution_id || null,
            attempt: rp.attempt, recovers_replacement_id: rp.recovers_replacement_id || null,
            client_request_id: rp.client_request_id,
            source: {
                submission_id: rp.source_submission_id || null, review_id: rp.source_review_id || null, decision_id: rp.source_decision_id || null,
                authority: rp.source_authority || null,
                // Chat transport of the originating review is separate from this work: a delivered chat turn is not acceptance, and vice versa.
                submission_delivery_status: submission ? submission.delivery_status : null,
            },
            superseded_review_ids: rp.superseded_review_ids || [],
            accepted_by: rp.accepted_by, created_at: rp.created_at, updated_at: rp.updated_at, completed_at: rp.completed_at || null,
            links: {
                task_path: rp.task_id ? `/task/${encodeURIComponent(rp.task_id)}` : null,
                review_path: fmt.reviewPathFor(rp.document_id),
                result_raw_path: rp.result_revision_id ? `/api/documents/${encodeURIComponent(rp.document_id)}/raw?revision=${encodeURIComponent(rp.result_revision_id)}` : null,
                self_path: `/api/documents/${encodeURIComponent(rp.document_id)}/replacements/${encodeURIComponent(rp.id)}`,
            },
        };
    }

    /** Is `revision` the document's current revision with every required asset servable? */
    function resultReady(doc, revision) {
        if (!revision || doc.current_revision_id !== revision.id) return { ready: false, reason: revision ? 'result_not_current' : 'no_result' };
        if (media.isVisualMedia(revision.media_type)) {
            const readiness = readinessView(doc, revision);
            if (!readiness.ready) return { ready: false, reason: 'result_not_ready', readiness };
        }
        return { ready: true, reason: null };
    }

    /**
     * The version whose reviews and decisions carry current authority. Normally
     * the current revision. When the current revision was registered by
     * replacement work that ended without being declared ready (failed or
     * cancelled), those bytes are never reviewable and authority stays with the
     * version that work set out to replace, walking back through a chain of
     * such attempts. Returns { revision, closedBy }: `closedBy` is the item
     * whose unaccepted result the current revision is, or null when the current
     * revision itself carries authority.
     */
    function authorityRevision(doc, current) {
        let revision = current;
        let closedBy = null;
        const seen = new Set();
        while (revision && !seen.has(revision.id)) {
            seen.add(revision.id);
            const producer = store().findReplacementByResult(doc.id, revision.id);
            if (!producer || producer.state === 'ready') break;
            closedBy = closedBy || producer;
            revision = producer.base_revision_id ? store().getRevisionMeta(producer.base_revision_id) : null;
        }
        return { revision, closedBy };
    }

    /**
     * Whether the document takes review actions (a new review, a decision, an
     * edit) right now. Open replacement work closes it; so does a current
     * revision that a failed or cancelled attempt registered, until an explicit
     * recovery delivers a new version; a visual revision with a missing required
     * asset is not ready. `revision` is the current revision.
     */
    function reviewability(doc, revision) {
        const open = store().findOpenReplacement(doc.id);
        if (open) return { ok: false, reason: 'replacement_in_progress', replacement: replacementView(open) };
        if (!revision) return { ok: false, reason: 'no_revision', replacement: null };
        const { closedBy } = authorityRevision(doc, revision);
        if (closedBy) return { ok: false, reason: 'replacement_failed', replacement: replacementView(closedBy) };
        if (media.isVisualMedia(revision.media_type)) {
            const readiness = readinessView(doc, revision);
            if (!readiness.ready) return { ok: false, reason: 'revision_not_ready', replacement: null, readiness: { ready: false, required_ok: readiness.required_ok, required_total: readiness.required_total } };
        }
        return { ok: true, reason: null, replacement: null };
    }

    function notReviewable(res, gate) {
        const message = gate.reason === 'replacement_in_progress'
            ? `Replacement work on this document is in progress (${gate.replacement.state}${gate.replacement.task_id ? `, task ${gate.replacement.task_id}` : ''}); this version is not reviewable until the new version is ready. If the work fails or is cancelled before registering a new revision, this version reopens only when no failed result governs the current version; if an earlier failed or cancelled attempt registered this version, or the work registered a revision first, review waits for an explicit recovery attempt (recovers_replacement_id). Nothing was recorded`
            : gate.reason === 'replacement_failed'
                ? `The current revision was registered by replacement work that ${gate.replacement.state === 'cancelled' ? 'was cancelled' : 'failed'}${gate.replacement.task_id ? ` (task ${gate.replacement.task_id})` : ''} and was never declared ready; it is not reviewable. Review reopens on a new version delivered by an explicit recovery attempt (recovers_replacement_id). Nothing was recorded`
                : gate.reason === 'revision_not_ready'
                    ? `The current revision is not ready (${gate.readiness.required_ok}/${gate.readiness.required_total} required assets servable); nothing was recorded`
                    : 'The document has no readable revision to review';
        return res.status(409).json({ error: message, code: gate.reason, ...(gate.replacement ? { replacement: gate.replacement } : {}), ...(gate.readiness ? { readiness: gate.readiness } : {}) });
    }

    /**
     * Bring the document's open replacement up to date with what Nexus can see
     * itself: the linked task's board status and whether the registered result
     * is the current, ready revision. Only a registered result that is current
     * and ready ever becomes `ready`; a task that ends without one fails the
     * work explicitly. Idempotent; runs before reads and writes that depend on
     * reviewability. Returns the (possibly updated) open or just-closed item.
     */
    async function reconcileReplacement(doc) {
        const open = store().findOpenReplacement(doc.id);
        if (!open) return null;
        const task = open.task_id && typeof db.getTask === 'function' ? await db.getTask(open.task_id) : null;
        const taskStatus = task ? String(task.status || '').toLowerCase() : null;
        const taskClosed = task && (task.archived_at || TASK_CANCELLED.has(taskStatus)) ? 'cancelled'
            : taskStatus && TASK_FAILED.has(taskStatus) ? 'failed'
                : taskStatus && TASK_DONE.has(taskStatus) ? 'done' : null;
        return store().transaction(() => {
            const fresh = store().getReplacement(open.id);
            if (!fresh || !isOpenState(fresh.state)) return fresh;
            const document = store().getDocument(doc.id);
            const result = fresh.result_revision_id ? store().getRevisionMeta(fresh.result_revision_id) : null;
            const readiness = resultReady(document, result);
            const ts = new Date().toISOString();
            let patch = null;
            if (taskClosed === 'cancelled') {
                patch = { state: 'cancelled', detail: `Task ${fresh.task_id} is ${taskStatus || 'archived'}; the replacement was not delivered`, completed_at: ts };
            } else if (taskClosed === 'failed') {
                patch = { state: 'failed', detail: `Task ${fresh.task_id} failed`, completed_at: ts };
            } else if (taskClosed === 'done') {
                patch = readiness.ready
                    ? { state: 'ready', detail: `Task ${fresh.task_id} completed; its registered revision is the current ready version`, completed_at: ts }
                    : { state: 'failed', detail: readiness.reason === 'no_result'
                        ? `Task ${fresh.task_id} completed without registering a new revision of this document`
                        : readiness.reason === 'result_not_current'
                            ? `Task ${fresh.task_id} completed but its registered revision is no longer the current one`
                            : `Task ${fresh.task_id} completed but its registered revision is not ready (${readiness.readiness.required_ok}/${readiness.readiness.required_total} required assets)`, completed_at: ts };
            } else if (fresh.state === 'qa_passed' && readiness.ready) {
                patch = { state: 'ready', detail: 'QA passed and the registered revision is the current ready version', completed_at: ts };
            }
            if (!patch) return fresh;
            const updated = store().updateReplacement(fresh.id, patch);
            console.log(`[Documents] replacement ${fresh.id} of ${doc.id} ${fresh.state} → ${updated.state}: ${patch.detail}`);
            return updated;
        });
    }

    /**
     * Lists and counts reconcile every open item first, so a queue, its counts
     * and the detail read agree without a document being opened: a task that
     * completed with a current result is `ready` the moment it is listed, not
     * after someone clicks through. Open items are few (one per document with
     * work in progress), so this is a handful of task lookups per list read.
     */
    async function reconcileOpenReplacements() {
        for (const rp of store().listOpenReplacements()) {
            // One item's failed task lookup must not take the whole queue down: that row keeps its last known state.
            try { await reconcileReplacement({ id: rp.document_id }); } catch (err) { console.error(`[Documents] reconcile of replacement ${rp.id} (document ${rp.document_id}) failed before listing:`, err); }
        }
    }

    /**
     * A declared registration under the replacement's task names the resulting
     * revision: record it and move the work to `implemented`. Readiness and
     * currency are checked when the work is declared ready, never assumed here;
     * bytes captured by a plain read are never a result. Runs inside the
     * registration transaction.
     */
    function linkReplacementResult(doc, revision, taskId) {
        if (!taskId) return null;
        const open = store().findOpenReplacement(doc.id);
        if (!open || open.task_id !== taskId || revision.id === open.base_revision_id) return null;
        const patch = {};
        if (open.result_revision_id !== revision.id) patch.result_revision_id = revision.id;
        if (ACCEPT_STATES.has(open.state)) { patch.state = 'implemented'; patch.detail = `Task ${taskId} registered revision ${revision.id}`; }
        return Object.keys(patch).length ? store().updateReplacement(open.id, patch) : open;
    }

    /**
     * The replacement a reader is shown: open work first; else the attempt whose
     * unaccepted result the current revision is (it closes the version, and it is
     * the item the list row names, even when a later recovery failed without
     * registering anything); else the newest item, which explains a failed or
     * cancelled attempt on the version still current.
     */
    function replacementForReader(doc, current) {
        const open = store().findOpenReplacement(doc.id);
        if (open) return open;
        const revision = current || (doc.current_revision_id ? store().getRevisionMeta(doc.current_revision_id) : null);
        return authorityRevision(doc, revision).closedBy || store().latestReplacement(doc.id);
    }

    // ── Retiring documents a later deliverable replaces (task d9f46e2f, contract §13) ──
    const NAME_LABEL = { document_id: 'document id', deliverable_key: 'deliverable key', path: 'path' };

    /** The registered documents a name points at, by its one exact identity; a path may name several (one per task). */
    function resolveReplacedName(row) {
        if (row.named_by === 'document_id') { const found = store().getDocument(row.named_value); return found ? [found] : []; }
        if (row.named_by === 'deliverable_key') { const found = store().findDocumentByKey(row.named_value); return found ? [found] : []; }
        const matches = new Map();
        for (const candidate of new Set([row.named_value, registrationIdentityPath(row.named_value)].filter(Boolean))) {
            for (const found of store().findDocumentsByPath(candidate)) matches.set(found.id, found);
        }
        return [...matches.values()];
    }

    /**
     * Robert's ruling (2026-11-19, option A): a replacing document retires what it names only once it is itself
     * waiting for his review (review requested and listed in Needs your review or Changes requested, so not approved)
     * and ready to view (a reviewable current revision, every required asset servable). Until then its names stay
     * pending, so nothing leaves his queue before its successor is in it.
     */
    function successorGate(doc) {
        const keep = 'The names are kept and applied the moment it is waiting for your review and ready to view';
        if (!doc.requires_review) {
            return { ok: false, reason: { code: 'replacement_not_in_queue', message: `The replacing document is not waiting for your review (a reference document, or its review has not been requested yet), so it retires nothing yet. ${keep}` } };
        }
        // A requested review is not enough: approval leaves requires_review set, so the list bucket decides whether the
        // document is actually in the queue (Needs your review or Changes requested; In progress falls to the gate below).
        const position = store().queuePosition(doc);
        if (!position.waiting) {
            const where = position.bucket === 'approved'
                ? 'it is already approved. A new version registered for your review brings it back to the queue'
                : `it is listed under ${position.bucket}`;
            return { ok: false, reason: { code: 'replacement_not_in_queue', message: `The replacing document is not waiting for your review: ${where}. Until then it retires nothing. ${keep}`, bucket: position.bucket } };
        }
        const revision = doc.current_revision_id ? store().getRevisionMeta(doc.current_revision_id) : null;
        const gate = reviewability(doc, revision);
        if (gate.ok) return { ok: true, reason: null };
        const why = gate.reason === 'revision_not_ready'
            ? `it is not ready to view yet (${gate.readiness.required_ok}/${gate.readiness.required_total} required assets servable)`
            : gate.reason === 'no_revision' ? 'it has no readable revision yet'
                : gate.reason === 'replacement_in_progress' ? 'replacement work on it is in progress, so its current version is not reviewable'
                    : 'its current version was registered by replacement work that failed or was cancelled, so it is not reviewable';
        return { ok: false, reason: { code: 'replacement_not_ready', message: `The replacing document is waiting for review but ${why}. ${keep}`, gate: gate.reason } };
    }

    /** Store an evaluated outcome, writing only when it changed (lists re-check pending names on every read). */
    function settleName(row, outcome, reasons = [], { target = null, candidates = [] } = {}) {
        const targetId = target ? target.id : null;
        const candidateIds = candidates.map(c => c.id);
        if (row.outcome === outcome && (row.target_document_id || null) === targetId && JSON.stringify(row.reasons || []) === JSON.stringify(reasons)
            && JSON.stringify(row.candidate_ids || []) === JSON.stringify(candidateIds) && row.evaluated_at) return row;
        return store().settleSupersession(row.id, { outcome, reasons, target_document_id: targetId, candidate_ids: candidateIds });
    }

    /**
     * Evaluate one pending name of `successor` against the documents as they are now. Synchronous: it runs inside the
     * caller's transaction, so a retirement lands in the same operation as the registration or review request that
     * made it due. A retired name is final; only Robert's request-review on the retired document undoes it.
     */
    function evaluateName(successor, row, gate, trigger) {
        if (row.outcome === 'retired') return row;
        const matches = resolveReplacedName(row);
        // A new version registered at the same path under a new task is the usual case: the replacing document never counts
        // as a candidate for its own name.
        const others = matches.filter(found => found.id !== successor.id);
        if (!matches.length) {
            return settleName(row, 'not_found', [{ code: 'not_found', message: `No registered document has this ${NAME_LABEL[row.named_by]}; nothing was retired` }]);
        }
        if (!others.length) {
            return settleName(row, 'self', [{ code: 'self', message: 'This names the replacing document itself; a document cannot retire itself' }], { target: successor });
        }
        if (others.length > 1) {
            return settleName(row, 'ambiguous', [{ code: 'ambiguous', message: `This path is registered as ${others.length} other documents (one per task); name the one it replaces by document id or deliverable key. Nothing was retired` }], { candidates: others });
        }
        const [target] = others;
        // A document already out of the queue is reported at once, ready or not. The guards (several queries each) are
        // judged only when the name can apply, so pending names stay cheap on every list and count read.
        const position = store().queuePosition(target);
        if (!position.waiting) return settleName(row, 'not_waiting', position.reasons, { target });
        if (!gate.ok) return settleName(row, 'pending', [gate.reason], { target });
        const check = store().retirementCheck(target);
        if (check.outcome !== 'retirable') return settleName(row, check.outcome, check.reasons, { target });
        const retirement = store().retireDocument({ target, successor, supersession: row, trigger, bucket: check.bucket });
        console.log(`[Documents] retired ${target.id} (was ${check.bucket}) as replaced by ${successor.id} (named by ${row.named_by}, registration ${row.registration_id || 'plain'}, task ${row.task_id || 'none'}, ${trigger}); retirement ${retirement.id}, no decision recorded`);
        return store().getSupersession(row.id);
    }

    /**
     * Declare the names a registration of `docId` carries, then evaluate them together with every name still pending
     * on that document. Run inside a transaction. Returns every name the document's registrations declared, as they
     * now stand.
     */
    function settleReplaces(docId, { trigger, names = [], registrationId = null, revisionId = null, taskId = null, actorId = null } = {}) {
        for (const name of names) {
            store().declareSupersession({
                document_id: docId, named_by: name.by, named_value: name.value,
                registration_id: registrationId, revision_id: revisionId, task_id: taskId, declared_by: actorId || 'unknown',
            });
        }
        const pending = store().listSupersessions(docId).filter(row => row.outcome === 'pending');
        if (pending.length) {
            const successor = store().getDocument(docId);
            const gate = successorGate(successor);
            for (const row of pending) evaluateName(successor, row, gate, trigger);
        }
        return store().listSupersessions(docId);
    }

    /**
     * settleReplaces in a savepoint of the caller's transaction: a fault in recording or applying names rolls back only
     * the names, never the registration or review request that carries them (deliverables are how work reaches Robert).
     */
    function settleReplacesGuarded(docId, options) {
        try { return { rows: store().transaction(() => settleReplaces(docId, options)), error: null }; } catch (err) {
            console.error(`[Documents] names of what ${docId} replaces were not applied:`, err);
            let rows = [];
            try { rows = store().listSupersessions(docId); } catch { /* the names stay unreported; the error says so */ }
            return {
                rows,
                error: { code: 'replaces_failed', message: 'The names of what this document replaces could not be recorded or applied, so nothing was retired by them. Everything else in this request succeeded; send it again to retry the names' },
            };
        }
    }

    /** Apply the pending names of these replacing documents now; one failure leaves its names pending and the read goes on. */
    function settlePendingOf(ids) {
        for (const id of ids) {
            try { store().transaction(() => settleReplaces(id, { trigger: 'ready' })); } catch (err) { console.error(`[Documents] pending retirements named by ${id} failed:`, err); }
        }
    }

    /** Apply the pending names of every replacing document before a list or count read, so the queue agrees with the rule. */
    function reconcilePendingRetirements() {
        settlePendingOf(store().listPendingSuccessorIds());
    }

    /** Before a document is read: apply its own pending names and those of documents that name it. */
    function settlePendingAround(docId) {
        const ids = new Set(store().hasPendingSupersessions(docId) ? [docId] : []);
        for (const row of store().listSupersessionsTargeting(docId)) if (row.outcome === 'pending') ids.add(row.document_id);
        settlePendingOf(ids);
    }

    /** A retirement as a registration or review request reports it on the document it was about. */
    function retirementEffect(action, rt) {
        const message = action === 'kept'
            ? 'This document was retired when a later document replaced it, and this registration carries the bytes it already had, so it stays in Reference. Robert can put it back with Move to review queue (request-review)'
            : action === 'reopened_by_registration'
                ? 'This document had been retired when a later document replaced it; this registration delivered new bytes for review, so it is back in the queue and the retirement is recorded as reopened'
                : 'This document had been retired when a later document replaced it; it is back in the queue and the retirement is recorded as reopened';
        return { action, message, ...retirementView(rt) };
    }

    /** A link to a document in a retirement record: its title, review page and current review status (null when it is gone). */
    function documentRef(id) {
        if (!id) return null;
        const found = store().getDocument(id);
        return { document_id: id, title: found ? found.title : null, exists: Boolean(found), review_path: fmt.reviewPathFor(id), review_status: found ? store().getReviewStatus(id) : null };
    }

    /** One name a registration declared, with its outcome and why. */
    function supersessionView(row) {
        const retirement = row.retirement_id ? store().getRetirement(row.retirement_id) : null;
        return {
            id: row.id, source: 'registration',
            named_as: { [row.named_by]: row.named_value },
            outcome: row.outcome, reasons: row.reasons || [],
            target: documentRef(row.target_document_id),
            candidates: (row.candidate_ids || []).map(documentRef),
            registration_id: row.registration_id || null, revision_id: row.revision_id || null, task_id: row.task_id || null,
            declared_by: row.declared_by, created_at: row.created_at, updated_at: row.updated_at, evaluated_at: row.evaluated_at || null,
            retirement: retirement ? {
                id: retirement.id, state: retirement.reopened_at ? 'reopened' : 'retired', retired_at: retirement.retired_at, trigger: retirement.trigger,
                reopened_at: retirement.reopened_at || null, reopened_by: retirement.reopened_by || null, reopened_via: retirement.reopened_via || null, reason: null,
            } : null,
        };
    }

    const RETIRED_REASON = 'Replaced by a later document registered for your review. Moved to Reference without a decision: nothing was approved, no changes were requested and its intended action was not carried out.';

    /** A retirement record in the shape the review page shows, for a registration's retirement and a manual close alike. */
    function retirementView(rt) {
        return {
            id: rt.id, source: 'replacement', state: rt.reopened_at ? 'reopened' : 'retired',
            retired_at: rt.retired_at, retired_by: rt.retired_by, reason: RETIRED_REASON,
            replaced_by: documentRef(rt.replaced_by_document_id), replaced_by_revision_id: rt.replaced_by_revision_id || null,
            registration_id: rt.registration_id || null, task_id: rt.task_id || null,
            task_path: rt.task_id ? `/task/${encodeURIComponent(rt.task_id)}` : null,
            trigger: rt.trigger, named_as: { [rt.named_by]: rt.named_value },
            previous: rt.previous || null, reopened_at: rt.reopened_at || null, reopened_by: rt.reopened_by || null, reopened_via: rt.reopened_via || null,
        };
    }

    /**
     * A manual close of 2026-11-18/19 (metadata.review_closed: at, by, reason, previous, superseded_by?) read into
     * the same shape, without rewriting the stamp. It is in force while the document is still out of the queue.
     */
    function manualRetirementView(doc) {
        const stamp = doc.metadata?.review_closed;
        if (!isPlainObject(stamp) || typeof stamp.at !== 'string' || !stamp.at.trim()) return null;
        const supersededBy = typeof stamp.superseded_by === 'string' && stamp.superseded_by.trim() ? stamp.superseded_by.trim() : null;
        // Put back since (review requested again, or retired afresh by a registration after a reopen): no longer in force.
        const putBack = doc.requires_review || store().listRetirements(doc.id).some(rt => String(rt.retired_at) > stamp.at);
        return {
            id: null, source: 'manual', state: putBack ? 'reopened' : 'retired',
            retired_at: stamp.at, retired_by: typeof stamp.by === 'string' ? stamp.by : null,
            reason: typeof stamp.reason === 'string' && stamp.reason.trim() ? stamp.reason.trim() : 'Closed by hand without review. Not an approval.',
            replaced_by: documentRef(supersededBy), replaced_by_revision_id: null,
            registration_id: null, task_id: null, task_path: null, trigger: 'manual', named_as: null,
            previous: isPlainObject(stamp.previous) ? stamp.previous : null, reopened_at: null, reopened_by: null, reopened_via: null,
        };
    }

    /** The retirement in force on a document (if any) and its whole retirement history, newest first. */
    function retirementsForReader(doc) {
        const rows = store().listRetirements(doc.id).map(retirementView);
        const manual = manualRetirementView(doc);
        const history = [...rows, ...(manual ? [manual] : [])].sort((a, b) => String(b.retired_at).localeCompare(String(a.retired_at)));
        const current = rows.find(rt => rt.state === 'retired') || (manual && manual.state === 'retired' ? manual : null);
        return { current, history };
    }

    /** What a replacing document retired or named: its registrations' names, plus the manual closes that named it. */
    function replacesForReader(doc) {
        const named = store().listSupersessions(doc.id).map(supersessionView);
        const manual = store().listManualClosesReplacedBy(doc.id).map(closed => {
            const view = manualRetirementView(closed);
            return {
                id: null, source: 'manual', named_as: null, outcome: 'retired', reasons: [],
                target: documentRef(closed.id), candidates: [],
                registration_id: null, revision_id: null, task_id: null,
                declared_by: view?.retired_by ?? null, created_at: view?.retired_at ?? null, updated_at: view?.retired_at ?? null, evaluated_at: view?.retired_at ?? null,
                retirement: { id: null, state: view?.state ?? 'retired', retired_at: view?.retired_at ?? null, trigger: 'manual', reopened_at: null, reopened_by: null, reopened_via: null, reason: view?.reason ?? null },
            };
        });
        return [...named, ...manual];
    }

    /** Other documents that named this one as replaced and left it waiting (or are not ready yet): shown on this page. */
    function namedAsReplacedForReader(doc) {
        return store().listSupersessionsTargeting(doc.id)
            .filter(row => row.outcome === 'pending' || row.outcome === 'left_waiting')
            .map(row => ({ ...supersessionView(row), replacing: documentRef(row.document_id) }));
    }

    // Binary and design revisions are always identified by their exact bytes (contract §1): `exactIdentity` and
    // `revisionHash` come from services/document-registry.js, shared with moving a registration (§14).

    /**
     * Find or record the revision for bytes just read. A declared deliverable
     * is identified by its exact file bytes, so a BOM or line-ending change is
     * a new revision that no earlier receipt or decision covers, and bytes the
     * normalized reviewer text cannot reproduce are kept for the raw route. A
     * legacy document keeps the line-normalized identity it always had.
     */
    function recordRevision(doc, read, mtime, { source = 'capture', editedBy = null } = {}) {
        const exact = exactIdentity(doc, read);
        const hash = revisionHash(doc, read);
        const existing = store().findRevisionByHash(doc.id, hash);
        if (existing) return { revision: existing, created: false };
        // Copy bytes a decision may be recorded against before the row exists, so a crash leaves a blob, never a dangling row.
        if (read.binary) media.storeBlob(read.exactHash, fs.readFileSync(doc.path));
        if (read.assets) media.storeAssets(read.assets);
        return store().transaction(() => {
            const revision = store().insertRevision({
                document_id: doc.id, content_hash: hash, content: read.content,
                byte_length: exact ? read.exactByteLength : read.byteLength, line_count: read.lineCount, file_mtime: mtime,
                media_type: read.mediaType, mime_type: read.mimeType, source, edited_by: editedBy,
                asset_count: (read.assets ? read.assets.length : 0) + 1, width: read.width ?? null, height: read.height ?? null,
                manifest: read.manifest ? JSON.stringify(read.manifest) : null,
            });
            if (!read.binary && read.exactContent !== read.content && read.mediaType !== 'design') store().insertRevisionExact(revision.id, read.exactContent);
            const primary = {
                asset_key: 'primary', role: 'primary', path: doc.path, media_type: read.mediaType, mime_type: read.mimeType,
                byte_length: exact ? read.exactByteLength : read.byteLength,
                content_hash: read.mediaType === 'design' ? read.manifestHash : hash,
                label: path.basename(doc.path), order: -1, width: read.width ?? null, height: read.height ?? null,
            };
            store().insertRevisionAssets(revision.id, doc.id, [primary, ...(read.assets || [])]);
            return { revision, created: true };
        });
    }

    /** The assets of a revision, with the primary first; a pre-media revision answers a synthesized Markdown primary. */
    function revisionAssets(revision) {
        if (!revision) return [];
        const rows = store().listRevisionAssets(revision.id);
        if (rows.length) return rows.map(assetView);
        const doc = store().getDocument(revision.document_id);
        return [assetView({
            asset_key: 'primary', role: 'primary', path: doc?.path ?? '', media_type: revision.media_type || 'markdown', mime_type: revision.mime_type || 'text/markdown',
            byte_length: revision.byte_length, content_hash: revision.content_hash, label: doc ? path.basename(doc.path) : 'primary', order: -1,
        })];
    }

    function assetView(asset) {
        const { id: _id, document_id: _doc, revision_id: _rev, created_at: _at, ...rest } = asset;
        return { ...rest, order: asset.order ?? 0 };
    }

    function previewAssetKey(revision, assets) {
        if (!revision) return null;
        if (revision.media_type === 'image' || revision.media_type === 'svg') return 'primary';
        if (revision.media_type === 'design') return assets.find(a => a.role === 'screen')?.asset_key ?? null;
        return null;
    }

    /** Document-level media fields derived from the current revision, for lists, receipts and the reader. */
    function mediaSummary(doc, revision) {
        const assets = revisionAssets(revision);
        return {
            media_type: revision?.media_type || doc.media_type || 'markdown',
            mime_type: revision?.mime_type || doc.mime_type || 'text/markdown',
            asset_count: revision?.asset_count ?? 1,
            editable: media.isEditableMedia(revision?.media_type || doc.media_type || 'markdown'),
            preview_asset_key: previewAssetKey(revision, assets),
            readiness_path: revision ? `/api/documents/${encodeURIComponent(doc.id)}/readiness?revision=${encodeURIComponent(revision.id)}` : null,
        };
    }

    function readinessView(doc, revision) {
        const assets = revisionAssets(revision).filter(a => a.role !== 'primary' || revision.media_type !== 'design');
        const result = media.readinessOf(revision.media_type === 'design' ? assets.filter(a => a.role !== 'primary') : assets);
        return { document_id: doc.id, revision_id: revision.id, content_hash: revision.content_hash, media_type: revision.media_type || 'markdown', ...result };
    }

    /** Re-check the boundary, read the file and record a new revision when the content changed. */
    async function captureRevision(doc) {
        const stored = doc.current_revision_id ? store().getRevision(doc.current_revision_id) : null;
        const roots = await listProjectRoots(db);
        const resolved = resolveDocumentPath(doc.path, roots);
        const unavailable = (code, error) => {
            store().invalidateOutgoing(doc.id, code);
            return { revision: stored, fileState: code, fileError: error };
        };
        if (!resolved.ok) return unavailable(resolved.code, resolved.error);
        if (resolved.canonicalPath !== doc.path) return unavailable('path_changed', 'Registered path no longer resolves to the same file');
        const read = readArtifactFile(resolved.canonicalPath, { mediaType: resolved.mediaType, root: resolved.root.root });
        if (!read.ok) return unavailable(read.code, read.error);
        const { revision } = recordRevision(doc, read, resolved.mtime);
        const fresh = store().getDocument(doc.id);
        const patch = {};
        if (fresh.current_revision_id !== revision.id) patch.current_revision_id = revision.id;
        if (fresh.media_type !== read.mediaType) { patch.media_type = read.mediaType; patch.mime_type = read.mimeType; }
        if (Object.keys(patch).length) store().updateDocument(doc.id, patch);
        return { revision, fileState: 'ok', fileError: null };
    }

    /** A rejected re-registration still revokes a grant when it observes changed or missing bytes.
     * It must not create a registration/revision for rejected producer input. */
    async function observeOutgoingRegistration(body) {
        const key = text(body.deliverable?.key, LIMITS.key);
        const candidate = registrationIdentityPath(body.path);
        const taskId = body.task_id == null ? null : text(String(body.task_id), 120);
        const doc = (key && store().findDocumentByKey(key))
            || (candidate && (store().findDocumentByPath(candidate, taskId)
                || store().findDocumentByKey(`path:${candidate}`)
                || store().findDocumentByPath(candidate, null)));
        if (!doc) return;
        const outgoing = store().getOutgoing(doc.id);
        if (!outgoing || outgoing.invalidated_at || !['draft', 'approved'].includes(outgoing.status)) return;
        const resolved = resolveDocumentPath(doc.path, await listProjectRoots(db));
        if (!resolved.ok || resolved.canonicalPath !== doc.path) {
            store().invalidateOutgoing(doc.id, 'file_unavailable');
            return;
        }
        const read = readDocumentFile(resolved.canonicalPath);
        if (!read.ok || read.exactHash !== outgoing.content_hash) {
            store().invalidateOutgoing(doc.id, read.ok ? 'document_changed' : 'file_unavailable');
        }
    }

    async function validateWaitingTasks(ids) {
        for (const id of ids || []) {
            if (!await db.getTask(id)) return { error: `Waiting task not found: ${id}`, code: 'task_not_found' };
        }
        return null;
    }

    async function sourceSummary(doc) {
        const [task, project] = await Promise.all([
            doc.task_id && typeof db.getTask === 'function' ? db.getTask(doc.task_id) : null,
            doc.project_id && typeof db.getProject === 'function' ? db.getProject(doc.project_id) : null,
        ]);
        return {
            task: task ? {
                id: task.id, title: task.name || task.title || null, status: task.status || null,
                status_message: typeof task.metadata?.status_message === 'string' ? task.metadata.status_message : null,
                project_id: task.project_id || null, updated_at: task.updated_at || null,
            } : null,
            project: project ? { id: project.id, name: project.name || null, path: project.path || null } : null,
        };
    }

    function submissionView(sub, { full = false } = {}) {
        if (!sub) return null;
        const view = {
            id: sub.id, review_id: sub.review_id, document_id: sub.document_id, revision_id: sub.revision_id,
            delivery_status: sub.delivery_status, delivery_attempts: sub.delivery_attempts,
            next_attempt_at: sub.next_attempt_at, last_error: sub.last_error, delivered_at: sub.delivered_at,
            receipt: sub.receipt || null, review_url: sub.payload?.review_url || null,
            created_at: sub.created_at, updated_at: sub.updated_at,
        };
        if (full) { view.payload = sub.payload; view.message_text = sub.message_text; }
        return view;
    }

    function reviewView(review, current) {
        const pinned = store().getRevision(review.revision_id);
        const currentRevision = current?.revision || pinned;
        const documentChanged = Boolean(pinned && currentRevision && pinned.id !== currentRevision.id);
        const currentAssets = documentChanged ? revisionAssets(currentRevision) : null;
        const comments = store().listComments(review.id).map(comment => ({
            ...fmt.publicComment(comment),
            // The reviewer's idempotency id, so a browser that reloaded mid-save can tell its draft already landed (task 1390fc34).
            client_id: comment.client_id ?? null,
            anchor: fmt.MEDIA_COMMENT_KINDS.has(comment.kind)
                ? (documentChanged ? fmt.mediaAnchorState(comment, currentAssets) : { state: 'intact', current_asset_key: comment.anchor?.asset_key ?? null })
                : fmt.anchorState(comment, currentRevision?.content, pinned?.content_hash, currentRevision?.content_hash),
        }));
        return {
            id: review.id, document_id: review.document_id, revision_id: review.revision_id, reviewer_id: review.reviewer_id,
            status: review.status, summary: review.summary || '', created_at: review.created_at, updated_at: review.updated_at,
            submitted_at: review.submitted_at || null,
            submitted_authority: review.submitted_authority || null,
            // True only on a review finished under the old approve-after-changes rule (before task 282c64fa).
            approval_delegated: Boolean(review.approval_delegated),
            // The approve decision this review recorded when it was finished with the checkbox.
            approval_decision_id: review.approval_decision_id || null,
            // Version lifecycle (task 6b46dcc8): a draft closed by accepted replacement work is 'superseded' and read-only.
            closed_at: review.closed_at || null,
            closed_reason: review.closed_reason || null,
            replacement_id: review.replacement_id || null,
            is_current_revision: !documentChanged,
            comments,
            // Answers to the document's decision_items on this round; frozen with the round once it is finished (task 50aa5747).
            decision_answers: decisionItems.storedAnswers(review),
            // The draft answers Finish would refuse, with the reason, so the viewer can offer to clear them even when the decision is gone.
            stale_answers: staleDraftAnswers(review, documentChanged),
            pinned_revision: revisionMeta(pinned),
            document_changed: documentChanged,
            ...(documentChanged ? { pinned_content: pinned.content } : {}),
            submission: submissionView(store().getSubmissionForReview(review.id)),
        };
    }

    /**
     * The draft's saved answers that cannot be sent: all of them once the
     * document moved past the round's revision (`revision_changed`), otherwise
     * those the decisions bound to that revision no longer accept.
     */
    function staleDraftAnswers(review, documentChanged) {
        const stored = decisionItems.storedAnswers(review);
        if (review.status !== 'draft' || !stored.length) return [];
        if (documentChanged) return stored.map(({ decision_id, answer }) => ({ decision_id, answer, reason: 'revision_changed' }));
        return decisionItems.unsendableAnswers(stored, decisionItems.decisionItemsFor(store().getDocument(review.document_id), review.revision_id));
    }

    function currentFor(doc) {
        const revision = doc.current_revision_id ? store().getRevision(doc.current_revision_id) : null;
        return { revision };
    }

    function loadDocument(req, res) {
        const doc = store().getDocument(req.params.id);
        if (!doc) { res.status(404).json({ error: 'Document not found' }); return null; }
        return doc;
    }

    function ownReview(req, res) {
        const review = store().getReview(req.params.reviewId);
        if (!review || review.reviewer_id !== req.user.id) { res.status(404).json({ error: 'Review not found' }); return null; }
        return review;
    }

    function requireDraft(review, res) {
        if (review.status === 'superseded') {
            // A stale tab or a concurrent write on a round that replacement work closed: refused, with the work that closed it.
            const replacement = review.replacement_id ? store().getReplacement(review.replacement_id) : null;
            res.status(409).json({
                error: 'This review was superseded when replacement work on the document was accepted, so it is read-only; your comments are kept. Review the new version once it is ready',
                code: 'review_superseded', closed_at: review.closed_at || null, replacement: replacementView(replacement),
            });
            return false;
        }
        if (review.status !== 'draft') { res.status(409).json({ error: 'Review is already finished; comments are frozen', code: 'review_submitted' }); return false; }
        return true;
    }

    /** A list row: the document, its derived review_status, current revision and the caller's own feedback round. */
    function listEntry(row, userId) {
        // The list row carries the open replacement's columns (documentQuery); they are shaped here, not spread raw.
        const { replacement_id: rpId, replacement_state: rpState, replacement_task_id: rpTask, replacement_attempt: rpAttempt, reviewable, ...doc } = row;
        const review = store().findLatestReview(doc.id, userId);
        const submission = review ? store().getSubmissionForReview(review.id) : null;
        const currentMeta = doc.current_revision_id ? store().getRevisionMeta(doc.current_revision_id) : null;
        return {
            ...doc,
            ...mediaSummary(doc, currentMeta),
            agent_review_ready: (db.agentReviews?.list(doc.id) || []).some(r => r.status === 'submitted' && r.base_revision_id === doc.current_revision_id),
            blocking_tasks: store().getBlockingTasks(doc.id),
            current_revision: revisionMeta(currentMeta),
            review_url: fmt.reviewUrlFor(doc.id),
            review_path: fmt.reviewPathFor(doc.id),
            // The governing replacement, if any: open work, or a failed or cancelled attempt whose bytes are the current revision.
            // Either way the row is `in_progress` and takes no review actions until the work is ready, ends without registering
            // a result over a version no failed result governs (the unchanged version reopens) or, once a failed attempt's bytes
            // are current, a recovery delivers (a recovery ending without a result leaves them closed).
            replacement: rpId ? { id: rpId, state: rpState, task_id: rpTask || null, attempt: rpAttempt ?? 1, open: isOpenState(rpState) } : null,
            reviewable: reviewable !== false && rpId == null,
            review_state: review ? {
                review_id: review.id, status: review.status, updated_at: review.updated_at,
                comment_count: store().listComments(review.id).length,
                delivery_status: submission ? submission.delivery_status : null,
                closed_reason: review.closed_reason || null,
            } : null,
        };
    }

    function receiptView(registration, revision) {
        const declaration = registration.declaration || {};
        return {
            id: registration.id,
            document_id: registration.document_id,
            revision_id: registration.revision_id,
            content_hash: registration.content_hash,
            byte_length: revision?.byte_length ?? null,
            line_count: revision?.line_count ?? null,
            deliverable_key: registration.deliverable_key,
            path: registration.path,
            root_project_id: registration.root_project_id,
            project_id: registration.project_id,
            task_id: registration.task_id,
            title: declaration.title ?? null,
            purpose: declaration.purpose ?? null,
            kind: declaration.kind ?? null,
            requires_review: declaration.requires_review === true,
            intended_action: declaration.intended_action ?? 'none',
            source: declaration.source ?? null,
            blocking_task_ids: declaration.blocking_task_ids || [],
            document_created: registration.document_created,
            revision_created: registration.revision_created,
            registered_by: registration.registered_by,
            registered_at: registration.created_at,
            review_status: store().getReviewStatus(registration.document_id),
            review_path: fmt.reviewPathFor(registration.document_id),
            review_url: fmt.reviewUrlFor(registration.document_id),
            raw_path: `/api/documents/${encodeURIComponent(registration.document_id)}/raw?revision=${encodeURIComponent(registration.revision_id)}`,
            media_type: revision?.media_type || 'markdown',
            mime_type: revision?.mime_type || 'text/markdown',
            asset_count: revision?.asset_count ?? 1,
            preview_asset_key: revision ? previewAssetKey(revision, revisionAssets(revision)) : null,
            readiness_path: `/api/documents/${encodeURIComponent(registration.document_id)}/readiness?revision=${encodeURIComponent(registration.revision_id)}`,
            // The replacement work this registration is the result of, when it is one (task 6b46dcc8).
            replacement: (() => {
                const rp = store().findReplacementByResult(registration.document_id, registration.revision_id);
                return rp ? { id: rp.id, state: rp.state, task_id: rp.task_id || null, attempt: rp.attempt } : null;
            })(),
        };
    }

    function conflict(code, error) {
        return Object.assign(new Error(error), { status: 409, code });
    }

    /**
     * A registration that declares decision_items binds them to the revision it
     * recorded (task 50aa5747). Metadata is merged across registrations, so
     * without the stamp a later revision would inherit the earlier questions.
     */
    function bindDecisionItems(doc, incomingMetadata, revisionId) {
        if (!decisionItems.declaresDecisionItems(incomingMetadata)) return;
        if (revisionId) store().recordDecisionDefinitions(revisionId, decisionItems.parseDecisionItems(incomingMetadata.decision_items).items);
        const fresh = store().getDocument(doc.id);
        const { [decisionItems.REVISION_KEY]: boundTo, ...rest } = fresh.metadata || {};
        if ((boundTo ?? null) === (revisionId ?? null)) return;
        // No revision (the capture failed): drop the stamp so the new items are bound to nothing rather than to older bytes.
        store().updateDocument(doc.id, { metadata: revisionId ? { ...rest, [decisionItems.REVISION_KEY]: revisionId } : rest });
    }

    /**
     * Decision definitions are immutable for a revision (task 50aa5747 QA
     * repair), as Praxis's registerDocumentDecisions keeps them: a registration
     * whose bytes land on any previously registered revision may
     * repeat those items unchanged, but may not change or clear them. Robert's
     * saved answers meant the questions and actions he read; new definitions
     * need new bytes. Returns the 409 to throw, or null. `hash` is the identity
     * recordRevision will file the registered bytes under.
     */
    function decisionItemsChangeRefusal(doc, incomingMetadata, hash) {
        if (!doc || !decisionItems.declaresDecisionItems(incomingMetadata)) return null;
        const landsOn = store().findRevisionByHash(doc.id, hash);
        if (!landsOn) return null;
        const definitions = store().getDecisionDefinitions(landsOn.id);
        if (definitions === undefined) return null; // A new capture may receive its first declaration after a viewer read.
        const recorded = decisionItems.parseDecisionItems(definitions);
        const incoming = decisionItems.parseDecisionItems(incomingMetadata.decision_items);
        if (recorded.ok && incoming.ok && decisionItems.sameDefinitions(incoming.items, recorded.items)) return null;
        return conflict('decision_items_changed', `The decisions for revision ${landsOn.id} cannot be changed or cleared on the same bytes${recorded.ok ? '' : ' because its original definitions were not retained'}; hand off a new revision to ask different questions. Nothing was registered`);
    }

    /** The viewer's decisions: the declared items, whether they bind to `revisionId`, and what finished reviews already sent for them. */
    function decisionItemsView(doc, revisionId) {
        const view = decisionItems.decisionItemsFor(doc, revisionId);
        if (!view) return null;
        return { ...view, sent_answers: view.revision_id ? decisionItems.latestSentAnswers(store().listReviews(doc.id), view.revision_id) : [] };
    }

    /**
     * Find or create the document for a validated declaration and record the
     * exact bytes that were read as its current revision, all in one
     * transaction. Identity: the declared key (or `path:<canonical path>`),
     * then a legacy row for the same file and task, then a chat-era row for
     * the same file with no task, so a retry or a task/chat handoff reuses
     * the document instead of duplicating it.
     *
     * The document keeps one consistent producer: it takes this declaration's
     * project only together with its task (the same task, or a chat-era
     * document gaining its first task). A handoff from another task or
     * project leaves the document's own pair intact and is linked through its
     * receipt, which the task and project filters both follow.
     */
    function writeDeclared(v, resolved, read, actorId) {
        return store().transaction(() => {
            const key = v.key || `path:${resolved.canonicalPath}`;
            let doc = store().findDocumentByKey(key);
            if (!doc) {
                doc = store().findDocumentByPath(resolved.canonicalPath, v.taskId)
                    || (v.taskId ? store().findDocumentByPath(resolved.canonicalPath, null) : null);
                if (doc && doc.deliverable_key && doc.deliverable_key !== key) {
                    throw conflict('identity_conflict', 'This file is already registered for this task under a different deliverable key');
                }
            }
            const declared = {
                title: v.title, purpose: v.purpose, requires_review: v.requiresReview, intended_action: v.intendedAction,
                ...(!v.requiresReview ? { blocking_task_ids: [] } : v.blockingTaskIds !== undefined ? { blocking_task_ids: v.blockingTaskIds } : {}),
                deliverable_key: key, root_project_id: resolved.root.projectId, path: resolved.canonicalPath,
                media_type: read.mediaType, mime_type: read.mimeType,
            };
            let documentCreated = false;
            let retirement = null;
            if (doc) {
                // A declared deliverable is identified by its exact bytes, which is the identity recordRevision uses below.
                const hash = revisionHash({ ...doc, deliverable_key: key }, read);
                const refusal = decisionItemsChangeRefusal(doc, v.metadata, hash);
                if (refusal) throw refusal;
                const taskId = doc.task_id || v.taskId;
                if (doc.path !== resolved.canonicalPath || taskId !== doc.task_id) {
                    const occupant = store().findDocumentByPath(resolved.canonicalPath, taskId);
                    if (occupant && occupant.id !== doc.id) throw conflict('identity_conflict', 'Another registered document already holds this file for this task');
                }
                // A retired document (contract §13) stays in Reference when a registration carries the bytes it had when it
                // was retired (a retry or replay must not undo the retirement); other bytes declared for review bring it
                // back. Compared with the retired revision, not the current one: a read may have captured newer bytes since.
                const openRetirement = v.requiresReview ? store().findOpenRetirement(doc.id) : null;
                const retiredRevisionId = openRetirement?.previous?.current_revision_id || null;
                const keepRetired = Boolean(openRetirement && retiredRevisionId && store().findRevisionByHash(doc.id, hash)?.id === retiredRevisionId);
                doc = store().updateDocument(doc.id, {
                    ...declared,
                    ...(keepRetired ? { requires_review: false } : {}),
                    task_id: taskId,
                    project_id: taskId === v.taskId ? v.projectId : doc.project_id,
                    ...(v.kind ? { kind: v.kind } : {}),
                    ...(v.metadata ? { metadata: { ...(doc.metadata || {}), ...v.metadata } } : {}),
                });
                if (openRetirement) {
                    retirement = keepRetired
                        ? retirementEffect('kept', openRetirement)
                        : retirementEffect('reopened_by_registration', store().reopenRetirement(doc.id, actorId, 'registration'));
                }
            } else {
                doc = store().insertDocument({
                    ...declared, project_id: v.projectId, task_id: v.taskId, kind: v.kind || 'document', metadata: v.metadata || {}, registered_by: actorId,
                });
                documentCreated = true;
            }
            const { revision, created: revisionCreated } = recordRevision(doc, read, resolved.mtime);
            if (doc.current_revision_id !== revision.id) store().setCurrentRevision(doc.id, revision.id);
            bindDecisionItems(doc, v.metadata, revision.id);
            // A registration under the open replacement's task is that work's result (implemented, not yet ready).
            linkReplacementResult(doc, revision, v.taskId);
            const declaration = {
                title: v.title, purpose: v.purpose, kind: v.kind || doc.kind, requires_review: v.requiresReview,
                intended_action: v.intendedAction, source: v.source,
                blocking_task_ids: doc.blocking_task_ids || [],
            };
            // A byte-identical retry of the same declaration returns its first receipt.
            const fingerprint = sha256(JSON.stringify({
                key, content_hash: revision.content_hash, path: resolved.canonicalPath, project_id: v.projectId, task_id: v.taskId, declaration,
            }));
            let registration = store().findRegistration(doc.id, fingerprint);
            const duplicate = Boolean(registration);
            if (!registration) {
                registration = store().insertRegistration({
                    document_id: doc.id, revision_id: revision.id, content_hash: revision.content_hash, fingerprint,
                    deliverable_key: key, path: resolved.canonicalPath, root_project_id: resolved.root.projectId,
                    project_id: v.projectId, task_id: v.taskId, declaration,
                    document_created: documentCreated, revision_created: revisionCreated, registered_by: actorId,
                });
            }
            // The documents this registration names as replaced (contract §13), retired in this same transaction when it
            // is waiting for review and ready to view, else kept pending until it is.
            const named = settleReplacesGuarded(doc.id, {
                trigger: 'registration', names: v.replaces || [], registrationId: registration.id, revisionId: revision.id, taskId: v.taskId, actorId,
            });
            return { doc: store().getDocument(doc.id), revision, registration, documentCreated, duplicate, replaces: named.rows, replacesError: named.error, retirement };
        });
    }

    async function registerDeclared(req, res, body) {
        const parsed = parseDeclaration(body);
        if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error, code: parsed.code });
        const v = parsed.value;
        const project = typeof db.getProject === 'function' ? await db.getProject(v.projectId) : null;
        if (!project) return res.status(404).json({ error: 'Project not found', code: 'project_not_found' });
        if (v.taskId) {
            const task = typeof db.getTask === 'function' ? await db.getTask(v.taskId) : null;
            if (!task) return res.status(404).json({ error: 'Source task not found', code: 'task_not_found' });
            if (task.project_id !== v.projectId) {
                return res.status(422).json({ error: 'The task does not belong to the declared project', code: 'association_mismatch' });
            }
        }
        const invalidWaitingTask = await validateWaitingTasks(v.blockingTaskIds);
        if (invalidWaitingTask) return res.status(404).json(invalidWaitingTask);
        const roots = await listProjectRoots(db);
        const resolved = resolveDocumentPath(body.path, roots);
        if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
        const read = readArtifactFile(resolved.canonicalPath, { mediaType: resolved.mediaType, root: resolved.root.root });
        if (!read.ok) return res.status(read.status).json({ error: read.error, code: read.code });
        // The producer's hash is checked against the exact bytes on disk (the package hash for a design package), never the normalized reviewer text.
        if (v.expectedHash && v.expectedHash !== read.exactHash) {
            return res.status(409).json({ error: 'The file no longer holds the content the producer declared', code: 'content_mismatch', content_hash: read.exactHash });
        }
        let written;
        try {
            written = writeDeclared(v, resolved, read, req.user.id);
        } catch (err) {
            if (err.status === 409) return res.status(409).json({ error: err.message, code: err.code });
            if (/UNIQUE/i.test(err.message || '')) return res.status(409).json({ error: 'A concurrent registration claimed this identity; retry', code: 'registration_conflict' });
            throw err;
        }
        const { doc, revision, registration, documentCreated, duplicate, replaces, replacesError, retirement } = written;
        return res.status(documentCreated ? 201 : 200).json({
            document: doc,
            revision: revisionMeta(revision),
            review_url: fmt.reviewUrlFor(doc.id),
            review_path: fmt.reviewPathFor(doc.id),
            created: documentCreated,
            duplicate,
            receipt: receiptView(registration, revision),
            // Every name this document's registrations declared, with its outcome and reasons (contract §13).
            replaces: replaces.map(supersessionView),
            replaces_error: replacesError,
            // This document's own retirement, when the registration found it retired (kept, or reopened by new bytes).
            retirement,
        });
    }

    router.use('/:id/outgoing', createDocumentOutgoingRouter({ store, captureRevision, authorizeDecision, confirmations }));

    // ── Registry ──────────────────────────────────────────────────────────
    router.post('/', async (req, res) => {
        try {
            const body = req.body || {};
            await observeOutgoingRegistration(body);
            if (body.deliverable !== undefined) return await registerDeclared(req, res, body);
            const roots = await listProjectRoots(db);
            const resolved = resolveDocumentPath(body.path, roots);
            if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
            const read = readArtifactFile(resolved.canonicalPath, { mediaType: resolved.mediaType, root: resolved.root.root });
            if (!read.ok) return res.status(read.status).json({ error: read.error, code: read.code });

            const taskId = body.task_id === undefined || body.task_id === null ? null : text(String(body.task_id), 120);
            if (body.task_id && !taskId) return res.status(400).json({ error: 'task_id must be a short string' });
            if (taskId && typeof db.getTask === 'function' && !(await db.getTask(taskId))) return res.status(404).json({ error: 'Source task not found' });
            let projectId = body.project_id === undefined || body.project_id === null ? null : text(String(body.project_id), 120);
            if (body.project_id && !projectId) return res.status(400).json({ error: 'project_id must be a short string' });
            if (projectId && typeof db.getProject === 'function' && !(await db.getProject(projectId))) return res.status(404).json({ error: 'Project not found' });
            if (!projectId) projectId = resolved.root.projectId;
            const kind = body.kind === undefined ? 'document' : text(String(body.kind), 40);
            if (!kind || !KINDS.has(kind)) return res.status(400).json({ error: `kind must be one of ${[...KINDS].join(', ')}` });
            if (body.metadata !== undefined && (body.metadata === null || typeof body.metadata !== 'object' || Array.isArray(body.metadata) || JSON.stringify(body.metadata).length > LIMITS.metadataJson)) {
                return res.status(400).json({ error: 'metadata must be a small JSON object' });
            }
            const items = body.metadata?.decision_items === undefined ? null : decisionItems.parseDecisionItems(body.metadata.decision_items);
            if (items && !items.ok) return res.status(400).json({ error: `metadata.decision_items: ${items.error}`, code: 'invalid_decision_items' });
            const metadata = decisionItems.withoutRevisionStamp(body.metadata);
            const title = body.title === undefined ? null : text(String(body.title), LIMITS.title);
            if (body.title !== undefined && !title) return res.status(400).json({ error: `title must be 1-${LIMITS.title} characters` });
            const replaces = parseReplaces(body.replaces);
            if (!replaces.ok) return res.status(400).json({ error: replaces.error, code: replaces.code });

            const registered = store().transaction(() => {
                const existing = store().findDocumentByPath(resolved.canonicalPath, taskId);
                const refusal = decisionItemsChangeRefusal(existing, metadata, existing ? revisionHash(existing, read) : null);
                if (refusal) throw refusal;
                let doc;
                if (existing) {
                    doc = store().updateDocument(existing.id, {
                        ...(title ? { title } : {}),
                        ...(body.project_id ? { project_id: projectId } : {}),
                        ...(body.kind ? { kind } : {}),
                        ...(metadata ? { metadata: { ...(existing.metadata || {}), ...metadata } } : {}),
                        root_project_id: resolved.root.projectId,
                    });
                } else {
                    doc = store().insertDocument({
                        title: title || (read.manifest?.title) || path.basename(resolved.canonicalPath, path.extname(resolved.canonicalPath)),
                        path: resolved.canonicalPath, root_project_id: resolved.root.projectId, project_id: projectId,
                        task_id: taskId, kind, metadata: metadata || {}, registered_by: req.user.id,
                        media_type: read.mediaType, mime_type: read.mimeType,
                    });
                }
                // Check and bind the same bytes, atomically, as on the declared path.
                // Recapturing after an await could bind unchecked historical bytes.
                const { revision } = recordRevision(doc, read, resolved.mtime);
                store().updateDocument(doc.id, { current_revision_id: revision.id, media_type: read.mediaType, mime_type: read.mimeType });
                bindDecisionItems(doc, metadata, revision.id);
                // Names of what this document replaces (contract §13). A plain registration never requests review, so on a
                // new document they wait until review is requested and it is ready to view.
                const named = settleReplacesGuarded(doc.id, {
                    trigger: 'registration', names: replaces.value, revisionId: revision.id, taskId: taskId || doc.task_id || null, actorId: req.user.id,
                });
                return { doc: store().getDocument(doc.id), revision, created: !existing, named };
            });
            const { doc, revision, created, named } = registered;
            return res.status(created ? 201 : 200).json({
                document: doc, revision: revisionMeta(revision), review_url: fmt.reviewUrlFor(doc.id),
                review_path: fmt.reviewPathFor(doc.id), created, replaces: named.rows.map(supersessionView), replaces_error: named.error,
            });
        } catch (err) {
            if (err.status === 409) return res.status(409).json({ error: err.message, code: err.code });
            console.error('[Documents] register failed:', err);
            return res.status(500).json({ error: 'Failed to register document' });
        }
    });

    // ── Moving registrations to the checkout a run landed in (task ec3e1d0c, contract §14) ──
    // Every document registered inside `from_root` (a run worktree) whose file at the same relative path under
    // `to_root` (the checkout the run landed in) holds the exact bytes of its current revision is moved there,
    // keeping its id, revisions, decisions and review state; the rest are named with the reason and both hashes.
    // Idempotent by document. `to_root: null` (the target branch is checked out nowhere) moves nothing and names them.
    router.post('/relocations', async (req, res) => {
        try {
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Same-origin requests only', code: 'cross_site' });
            const body = req.body;
            const invalid = error => res.status(400).json({ error, code: 'invalid_relocation' });
            if (!isPlainObject(body) || Object.keys(body).some(key => !RELOCATION_FIELDS.has(key))) {
                return invalid(`Only ${[...RELOCATION_FIELDS].join(', ')} may be supplied`);
            }
            const fromRoot = parseRoot(body.from_root);
            if (!fromRoot) return invalid('from_root must be an absolute, normalized directory path');
            if (!('to_root' in body)) return invalid('to_root is required: the checkout the run landed in, or null when none has the target branch checked out');
            const toRoot = body.to_root === null ? null : parseRoot(body.to_root);
            if (body.to_root !== null && !toRoot) return invalid('to_root must be an absolute, normalized directory path, or null');
            if (toRoot && rootsOverlap(fromRoot, toRoot)) return invalid('from_root and to_root must be separate directories');
            if (toRoot && !fs.statSync(toRoot, { throwIfNoEntry: false })?.isDirectory()) {
                return res.status(409).json({ error: 'to_root is not an existing directory', code: 'to_root_missing' });
            }
            const source = body.source === undefined ? 'landing' : body.source;
            if (!RELOCATION_SOURCES.includes(source)) return invalid(`source must be one of: ${RELOCATION_SOURCES.join(', ')}`);
            // The task-id bound the registration path applies (observeOutgoingRegistration).
            const taskId = body.task_id == null ? null : text(body.task_id, 120);
            if (body.task_id != null && !taskId) return invalid('task_id must be a non-empty string');
            const reason = body.reason == null ? null : text(body.reason, LIMITS.purpose);
            if (body.reason != null && !reason) return invalid(`reason must be a non-empty string of at most ${LIMITS.purpose} characters`);
            const result = await relocateDocuments({ db, store: store(), fromRoot, toRoot, source, taskId, reason, actorId: req.user.id });
            for (const row of result.relocated) {
                console.log(`[Documents] ${row.document_id} moved from ${row.from_path} to ${row.to_path} (${source}${taskId ? `, task ${taskId}` : ''})`);
            }
            for (const row of result.left) {
                console.log(`[Documents] ${row.document_id} left at ${row.from_path}: ${row.reason}${row.landed_hash ? ` (registered ${row.registered_hash}, landed ${row.landed_hash})` : ''}`);
            }
            return res.json(result);
        } catch (err) {
            console.error('[Documents] relocation failed:', err);
            return res.status(500).json({ error: 'Failed to move document registrations' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            const parsed = parseListQuery(req.query);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid_query' });
            const { status, limit, offset, filters } = parsed.value;
            await reconcileOpenReplacements();
            reconcilePendingRetirements();
            const page = store().listDocumentsPage({ status, limit, offset, ...filters });
            return res.json({
                documents: page.documents.map(doc => listEntry(doc, req.user.id)),
                total: page.total, limit, offset, has_more: offset + page.documents.length < page.total, status,
            });
        } catch (err) {
            console.error('[Documents] list failed:', err);
            return res.status(500).json({ error: 'Failed to list documents' });
        }
    });

    router.get('/mail-drafts', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const folder = req.query.folder === undefined ? 'drafts' : req.query.folder;
        if (!['drafts', 'cancelled'].includes(folder)) return res.status(400).json({ code: 'invalid_query', error: 'folder must be drafts or cancelled' });
        try {
            const result = store().listMailDrafts(folder);
            const items = await Promise.all(result.outgoing.map(async outgoing => {
                const document = store().getDocument(outgoing.document_id);
                const source = await sourceSummary({ ...document, project_id: outgoing.provenance.project_id, task_id: outgoing.provenance.task_id });
                return { document, outgoing, project_name: source.project?.name || null, task_name: source.task?.title || null };
            }));
            return res.json({ items, counts: result.counts });
        } catch (err) {
            console.error('[Documents] mail drafts failed:', err);
            return res.status(500).json({ error: 'Failed to list mail drafts' });
        }
    });

    router.get('/counts', async (req, res) => {
        try {
            const parsed = parseListQuery(req.query, { paging: false });
            if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid_query' });
            await reconcileOpenReplacements();
            reconcilePendingRetirements();
            return res.json({ counts: store().countDocumentsByStatus(parsed.value.filters), filters: parsed.value.filters });
        } catch (err) {
            console.error('[Documents] counts failed:', err);
            return res.status(500).json({ error: 'Failed to count documents' });
        }
    });

    router.get('/review-task-options', (_req, res) => {
        try { return res.json({ tasks: store().listReviewTaskOptions() }); }
        catch (err) {
            console.error('[Documents] waiting tasks failed:', err);
            return res.status(500).json({ error: 'Failed to load waiting tasks' });
        }
    });

    router.get('/:id', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            const captured = await captureRevision(doc);
            await reconcileReplacement(doc);
            settlePendingAround(doc.id);
            const fresh = store().getDocument(doc.id);
            const retirements = retirementsForReader(fresh);
            const review = store().findLatestReview(doc.id, req.user.id);
            const source = await sourceSummary(fresh);
            const latest = store().latestDecision(doc.id);
            const assets = revisionAssets(captured.revision);
            const gate = reviewability(fresh, captured.revision);
            return res.json({
                document: fresh,
                ...mediaSummary(fresh, captured.revision),
                blocking_tasks: store().getBlockingTasks(doc.id),
                revision: revisionMeta(captured.revision),
                content: captured.revision ? captured.revision.content : null,
                assets,
                manifest: captured.revision?.manifest ?? null,
                readiness: captured.revision && media.isVisualMedia(captured.revision.media_type) ? readinessView(fresh, captured.revision) : null,
                file_state: captured.fileState,
                file_error: captured.fileError,
                source,
                outgoing: store().getOutgoing(doc.id),
                review: review ? reviewView(review, { revision: captured.revision }) : null,
                // Structured decisions Robert answers in the viewer (task 50aa5747): answerable only on the revision they were declared for.
                decision_items: decisionItemsView(fresh, captured.revision?.id),
                inline_comments: captured.revision ? inlineComments(db, doc.id, captured.revision) : [],
                review_status: store().getReviewStatus(doc.id),
                current_decision: latest ? { ...latest, applies_to_current_revision: latest.revision_id === fresh.current_revision_id } : null,
                // Version lifecycle (task 6b46dcc8): the open replacement (else the attempt whose unaccepted bytes are current, else
                // the newest closed one, which explains a failed or cancelled attempt), and whether this version takes review actions now.
                replacement: replacementView(replacementForReader(fresh, captured.revision)),
                reviewable: { ok: gate.ok, reason: gate.reason, replacement_id: gate.replacement?.id ?? null },
                // Retiring replaced documents (task d9f46e2f, contract §13): the retirement in force on this document (a
                // registration's, or a manual close of 2026-11-18/19 in the same shape) and its history; what this document
                // names as replaced, with outcomes and reasons; and other documents that named this one but left it waiting.
                retirement: retirements.current,
                retirement_history: retirements.history,
                replaces: replacesForReader(fresh),
                named_as_replaced: namedAsReplacedForReader(fresh),
                version: { current_revision_id: fresh.current_revision_id, current_version: captured.revision ? store().revisionVersion(captured.revision.id) : null, revision_count: store().listRevisionMeta(doc.id).length, capture_count: store().listRevisionMeta(doc.id).length, draft_count: store().draftHistory(doc.id).drafts.length },
                // Who this read is for: the browser binds its unsaved review text to this reviewer (task 1390fc34).
                viewer: { id: req.user.id },
                links: { review_url: fmt.reviewUrlFor(fresh.id), review_path: fmt.reviewPathFor(fresh.id), raw_url: `/api/documents/${fresh.id}/raw` },
            });
        } catch (err) {
            console.error('[Documents] read failed:', err);
            return res.status(500).json({ error: 'Failed to read document' });
        }
    });

    // Review requirements are registration metadata, never an approval or dispatch.
    router.post('/:id/request-review', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Same-origin requests only', code: 'cross_site' });
            const body = req.body;
            if (!isPlainObject(body) || Object.keys(body).some(key => key !== 'blocking_task_ids')) {
                return res.status(400).json({ error: 'Only blocking_task_ids may be supplied', code: 'invalid_review_requirements' });
            }
            const parsed = parseBlockingTaskIds(body.blocking_task_ids === undefined ? (doc.blocking_task_ids ?? []) : body.blocking_task_ids);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid_review_requirements' });
            const invalid = await validateWaitingTasks(parsed.value);
            if (invalid) return res.status(404).json(invalid);
            const captured = await captureRevision(doc);
            if (captured.fileState !== 'ok') return res.status(409).json({ error: 'The document file must be available before requesting review', code: 'file_unavailable' });
            // One operation (contract §13): back into the queue, a retirement in force recorded as reopened (its waiting
            // tasks return with it unless new ones are given), and this document's own pending names applied now that it waits.
            const { document, reopened, named } = store().transaction(() => {
                const updated = store().updateDocument(doc.id, { requires_review: true, blocking_task_ids: parsed.value });
                const reopenedRetirement = store().reopenRetirement(doc.id, req.user.id, 'request_review');
                const replaces = settleReplacesGuarded(doc.id, { trigger: 'review_requested' });
                return { document: store().getDocument(updated.id), reopened: reopenedRetirement, named: replaces };
            });
            if (reopened) console.log(`[Documents] ${doc.id} reopened from retirement ${reopened.id} (replaced by ${reopened.replaced_by_document_id}) by ${req.user.id}`);
            return res.json({
                document, review_status: store().getReviewStatus(doc.id), blocking_tasks: store().getBlockingTasks(doc.id),
                retirement: reopened ? retirementEffect('reopened', reopened) : null,
                replaces: named.rows.map(supersessionView), replaces_error: named.error,
            });
        } catch (err) {
            console.error('[Documents] review requirements failed:', err);
            return res.status(500).json({ error: 'Failed to update review requirements' });
        }
    });

    router.get('/:id/raw', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            let revision;
            if (typeof req.query.revision === 'string' && req.query.revision) {
                revision = store().getRevision(req.query.revision);
                if (!revision || revision.document_id !== doc.id) return res.status(404).json({ error: 'Revision not found' });
            } else {
                revision = (await captureRevision(doc)).revision;
            }
            if (!revision) return res.status(404).json({ error: 'No captured revision for this document' });
            const primary = revisionAssets(revision).find(a => a.asset_key === 'primary');
            if (primary && !media.isTextMedia(primary.media_type)) return streamAsset(req, res, primary, revision);
            res.setHeader('Content-Type', primary && primary.media_type !== 'markdown' ? `${primary.mime_type}; charset=utf-8` : 'text/markdown; charset=utf-8');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Document-Revision', revision.content_hash);
            if (media.MEDIA_TYPES[primary?.media_type]?.sandboxed) sandboxHeaders(res);
            const filename = path.basename(doc.path).replace(/["\r\n]/g, '');
            res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`);
            // A declared revision whose bytes differ from the normalized text is served exactly as registered.
            return res.send(store().getRevisionExact(revision.id) ?? revision.content);
        } catch (err) {
            console.error('[Documents] raw failed:', err);
            return res.status(500).json({ error: 'Failed to read document' });
        }
    });

    router.get('/:id/revisions/:revisionId', (req, res) => {
        const doc = loadDocument(req, res);
        if (!doc) return;
        const revision = store().getRevision(req.params.revisionId);
        if (!revision || revision.document_id !== doc.id) return res.status(404).json({ error: 'Revision not found' });
        return res.json({ revision: revisionMeta(revision), content: revision.content, assets: revisionAssets(revision), manifest: revision.manifest ?? null });
    });

    // ── Assets, readiness and editing (contract docs/contracts/review-media-and-design-packages.md) ──

    /** The revision named by ?revision=, or the current one after a fresh capture. */
    async function revisionForQuery(doc, req, res) {
        if (typeof req.query.revision === 'string' && req.query.revision) {
            const revision = store().getRevision(req.query.revision);
            if (!revision || revision.document_id !== doc.id) { res.status(404).json({ error: 'Revision not found', code: 'revision_not_found' }); return null; }
            return revision;
        }
        const revision = (await captureRevision(doc)).revision;
        if (!revision) { res.status(404).json({ error: 'No captured revision for this document', code: 'no_revision' }); return null; }
        return revision;
    }

    /**
     * A prototype runs, but never with the dashboard's session: the CSP
     * sandbox gives it an opaque origin (no cookies, no same-origin reads).
     * It may only be framed by the dashboard itself; the global
     * X-Frame-Options would refuse the opaque-origin document outright, so
     * frame-ancestors carries that rule for these responses instead.
     */
    function sandboxHeaders(res) {
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms; frame-ancestors 'self'; default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' blob:; connect-src 'none'");
    }

    function assetHeaders(res, asset, revision, { download = false } = {}) {
        res.setHeader('Content-Type', asset.media_type === 'markdown' ? 'text/markdown; charset=utf-8' : asset.mime_type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Document-Revision', revision.content_hash);
        res.setHeader('X-Asset-Hash', asset.content_hash);
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        if (media.MEDIA_TYPES[asset.media_type]?.sandboxed) sandboxHeaders(res);
        const filename = path.basename(asset.path || 'asset').replace(/["\r\n]/g, '');
        res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
    }

    /**
     * Stream one asset of a revision: the blob copy when there is one,
     * otherwise the registered file while it still hashes to the revision.
     * Range requests are honoured so video and audio can seek.
     */
    function streamAsset(req, res, asset, revision) {
        const located = media.locateAssetBytes(asset);
        if (!located) return res.status(409).json({ error: 'The bytes of this asset are no longer available as registered', code: 'asset_changed', asset_key: asset.asset_key });
        assetHeaders(res, asset, revision, { download: req.query.download === '1' });
        const size = asset.byte_length;
        res.setHeader('Accept-Ranges', 'bytes');
        const range = typeof req.headers.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;
        if (range && (range[1] || range[2])) {
            let start = range[1] ? Number(range[1]) : null;
            let end = range[2] ? Number(range[2]) : null;
            if (start === null) { start = Math.max(0, size - end); end = size - 1; }
            else if (end === null || end >= size) end = size - 1;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
                res.setHeader('Content-Range', `bytes */${size}`);
                return res.status(416).end();
            }
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            res.setHeader('Content-Length', String(end - start + 1));
            return fs.createReadStream(located.path, { start, end }).on('error', () => res.destroy()).pipe(res);
        }
        res.setHeader('Content-Length', String(size));
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(located.path).on('error', () => res.destroy()).pipe(res);
    }

    router.get('/:id/assets/:assetKey', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            if (!media.ASSET_KEY_PATTERN.test(req.params.assetKey)) return res.status(400).json({ error: 'Invalid asset key', code: 'invalid_asset_key' });
            const revision = await revisionForQuery(doc, req, res);
            if (!revision) return;
            const asset = revisionAssets(revision).find(a => a.asset_key === req.params.assetKey);
            if (!asset) return res.status(404).json({ error: 'Asset not found in this revision', code: 'asset_not_found' });
            // The primary of a text revision is the stored text itself (exact bytes for a declared deliverable).
            if (asset.role === 'primary' && media.isTextMedia(asset.media_type)) {
                assetHeaders(res, asset, revision, { download: req.query.download === '1' });
                return res.send(store().getRevisionExact(revision.id) ?? revision.content);
            }
            return streamAsset(req, res, asset, revision);
        } catch (err) {
            console.error('[Documents] asset failed:', err);
            return res.status(500).json({ error: 'Failed to read asset' });
        }
    });

    router.get('/:id/readiness', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            const revision = await revisionForQuery(doc, req, res);
            if (!revision) return;
            // A producer polls this until its visual media is servable; that is when its pending names apply (contract §13).
            settlePendingAround(doc.id);
            return res.json(readinessView(doc, revision));
        } catch (err) {
            console.error('[Documents] readiness failed:', err);
            return res.status(500).json({ error: 'Failed to check readiness' });
        }
    });

    /**
     * Direct edit (contract §4): the operator writes new text for an editable
     * document from the reviewer. Pinned to the revision they edited, written
     * atomically, captured as a new `nexus_edit` revision; decisions never
     * carry over to it.
     */
    router.put('/:id/content', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Same-origin requests only', code: 'cross_site' });
            const authority = await authorizeDecision(req);
            if (!authority.ok) return res.status(authority.status).json({ error: authority.error, code: authority.code, ...(authority.reason ? { reason: authority.reason } : {}) });
            if (authority.actor.authority === 'document_executor_credential') return res.status(403).json({ error: 'Executors cannot edit through the reviewer; register a new revision instead', code: 'operator_required' });
            const body = isPlainObject(req.body) ? req.body : {};
            const baseRevisionId = text(body.base_revision_id, 120);
            if (!baseRevisionId) return res.status(400).json({ error: 'base_revision_id is required: an edit is pinned to the revision you edited', code: 'invalid_edit' });
            if (typeof body.content !== 'string') return res.status(400).json({ error: 'content must be a string', code: 'invalid_edit' });
            let clientEditId = null;
            if (body.client_edit_id !== undefined) {
                clientEditId = text(body.client_edit_id, LIMITS.clientId);
                if (!clientEditId) return res.status(400).json({ error: 'client_edit_id must be a short string', code: 'invalid_edit' });
            }
            const summary = body.summary === undefined ? '' : typeof body.summary === 'string' && body.summary.length <= LIMITS.editSummary ? body.summary.trim() : null;
            if (summary === null) return res.status(400).json({ error: `summary must be at most ${LIMITS.editSummary} characters`, code: 'invalid_edit' });
            if (clientEditId) {
                const prior = store().findEditByClientId(doc.id, clientEditId);
                if (prior) {
                    const revision = store().getRevision(prior.result_revision_id);
                    return res.status(200).json({ edit: prior, revision: revisionMeta(revision), content: revision?.content ?? null, duplicate: true });
                }
            }
            const mediaType = doc.media_type || 'markdown';
            if (!media.isEditableMedia(mediaType)) return res.status(409).json({ error: `${mediaType} files cannot be edited here; deliver a new file instead`, code: 'not_editable' });
            const maxBytes = media.maxBytesFor(mediaType);
            const bytes = Buffer.from(body.content, 'utf8');
            if (bytes.length === 0) return res.status(400).json({ error: 'content must not be empty', code: 'invalid_edit' });
            if (bytes.length > maxBytes) return res.status(413).json({ error: `content exceeds ${maxBytes} bytes`, code: 'too_large' });
            const roots = await listProjectRoots(db);
            const resolved = resolveDocumentPath(doc.path, roots);
            if (!resolved.ok || resolved.canonicalPath !== doc.path) return res.status(409).json({ error: 'The registered file is not available for editing', code: resolved.ok ? 'path_changed' : resolved.code });
            if (mediaType === 'design') {
                let parsed;
                try { parsed = JSON.parse(body.content); } catch { return res.status(400).json({ error: 'The manifest is not valid JSON', code: 'invalid_manifest' }); }
                const validated = media.validateDesignManifest(parsed);
                if (!validated.ok) return res.status(400).json({ error: validated.error, code: validated.code });
                const members = media.resolveDesignMembers(resolved.canonicalPath, resolved.root.root, validated.members);
                if (!members.ok) return res.status(members.status).json({ error: members.error, code: members.code });
            }
            const captured = await captureRevision(doc);
            if (captured.fileState !== 'ok') return res.status(409).json({ error: `The file cannot be confirmed right now (${captured.fileState}); nothing was written`, code: 'file_unavailable', file_state: captured.fileState });
            if (captured.revision.id !== baseRevisionId) {
                return res.status(409).json({ error: 'The document changed after the revision you edited; reload and edit the current revision', code: 'stale_revision', revision_id: baseRevisionId, current_revision: revisionMeta(captured.revision) });
            }
            // Open replacement work owns the next version: an edit now would be overtaken or would strand the work; the bytes of a
            // failed attempt take no edit either, a recovery replaces them (task 6b46dcc8). A missing visual asset never blocks an edit.
            await reconcileReplacement(doc);
            const workGate = reviewability(store().getDocument(doc.id), captured.revision);
            if (!workGate.ok && workGate.reason !== 'revision_not_ready') return notReviewable(res, workGate);
            const newHash = sha256(bytes);
            if (newHash === captured.revision.content_hash || newHash === sha256(Buffer.from(captured.revision.content, 'utf8'))) {
                return res.status(200).json({ edit: null, revision: revisionMeta(captured.revision), content: captured.revision.content, unchanged: true });
            }
            // Atomic write beside the file, then one capture of exactly those bytes.
            const tmp = `${resolved.canonicalPath}.nexus-edit-${process.pid}-${Date.now()}.tmp`;
            fs.writeFileSync(tmp, bytes);
            try { fs.renameSync(tmp, resolved.canonicalPath); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } throw err; }
            const read = readArtifactFile(resolved.canonicalPath, { mediaType, root: resolved.root.root });
            if (!read.ok) return res.status(read.status).json({ error: read.error, code: read.code });
            const stat = fs.statSync(resolved.canonicalPath);
            const { revision } = recordRevision(doc, read, stat.mtime.toISOString(), { source: 'nexus_edit', editedBy: authority.actor.id });
            let edit;
            try {
                edit = store().transaction(() => {
                    store().updateDocument(doc.id, { current_revision_id: revision.id });
                    return store().insertEdit({
                        document_id: doc.id, base_revision_id: baseRevisionId, result_revision_id: revision.id,
                        actor_id: authority.actor.id, authority: authority.actor.authority, summary, client_edit_id: clientEditId, byte_length: bytes.length,
                    });
                });
            } catch (err) {
                const raced = clientEditId && /UNIQUE/i.test(err.message || '') ? store().findEditByClientId(doc.id, clientEditId) : null;
                if (raced) return res.status(200).json({ edit: raced, revision: revisionMeta(revision), content: revision.content, duplicate: true });
                throw err;
            }
            console.log(`[Documents] edit recorded for ${doc.id}: ${baseRevisionId} → ${revision.id} (authority=${authority.actor.authority})`);
            return res.status(201).json({ edit, revision: revisionMeta(revision), content: revision.content, assets: revisionAssets(revision), review_status: store().getReviewStatus(doc.id) });
        } catch (err) {
            console.error('[Documents] edit failed:', err);
            return res.status(500).json({ error: 'Failed to save edit' });
        }
    });

    router.get('/:id/history', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            await reconcileReplacement(doc);
            const fresh = store().getDocument(doc.id);
            const draftHistory = store().draftHistory(doc.id);
            const revisions = draftHistory.revisions;
            return res.json({
                document_id: doc.id,
                current_revision_id: fresh.current_revision_id,
                current_version: fresh.current_revision_id ? store().revisionVersion(fresh.current_revision_id) : null,
                review_status: store().getReviewStatus(doc.id),
                reviewable: reviewability(fresh, fresh.current_revision_id ? store().getRevisionMeta(fresh.current_revision_id) : null).ok,
                // Every revision with its version number and whether it is the current one; history is never rewritten.
                revisions,
                drafts: draftHistory.drafts,
                capture_count: revisions.length,
                draft_count: draftHistory.drafts.length,
                decisions: store().listDecisions(doc.id),
                edits: store().listEdits(doc.id),
                registrations: store().listRegistrations(doc.id).map(registration => receiptView(registration, store().getRevisionMeta(registration.revision_id))),
                reviews: store().listReviews(doc.id).map(review => ({
                    id: review.id, revision_id: review.revision_id, reviewer_id: review.reviewer_id, status: review.status,
                    created_at: review.created_at, submitted_at: review.submitted_at || null,
                    approval_decision_id: review.approval_decision_id || null,
                    comment_count: store().listComments(review.id).length,
                    delivery_status: store().getSubmissionForReview(review.id)?.delivery_status || null,
                    // Closure (task 6b46dcc8): a superseded draft says when, why and by which work; an older round is historical.
                    closed_at: review.closed_at || null, closed_reason: review.closed_reason || null, replacement_id: review.replacement_id || null,
                    is_current_revision: review.revision_id === fresh.current_revision_id,
                })),
                replacements: store().listReplacements(doc.id).map(replacementView),
            });
        } catch (err) {
            console.error('[Documents] history failed:', err);
            return res.status(500).json({ error: 'Failed to read document history' });
        }
    });

    // ── Decisions ─────────────────────────────────────────────────────────
    // Approve document / Request changes: an operator's editorial decision on
    // the exact revision they read. Neither sends, publishes nor changes task
    // state. A decision on bytes that are no longer current is refused.
    //
    // With an `executor` block (document executor credential only, which can
    // record nothing else) the approval is executor-recorded. Since task
    // 282c64fa that path serves only reviews finished under the old
    // approve-after-changes rule, whose work is still in flight: the decision
    // carries the review it acted on, Robert's delegation grant on that review
    // and the executor's identity (services/document-decision-provenance.js).
    router.post('/:id/decisions', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Same-origin requests only', code: 'cross_site' });
            const authority = await authorizeDecision(req);
            if (!authority.ok) {
                return res.status(authority.status).json({ error: authority.error, code: authority.code, ...(authority.reason ? { reason: authority.reason } : {}) });
            }
            const body = isPlainObject(req.body) ? req.body : {};
            if (!DECISIONS.has(body.decision)) return res.status(400).json({ error: 'decision must be "approve" or "request_changes"', code: 'invalid_decision' });
            const revisionId = text(body.revision_id, 120);
            if (!revisionId) return res.status(400).json({ error: 'revision_id is required: a decision is pinned to the exact revision you read', code: 'invalid_decision' });
            if (body.content_hash !== undefined && (typeof body.content_hash !== 'string' || !HASH_PATTERN.test(body.content_hash))) {
                return res.status(400).json({ error: 'content_hash must be a lowercase hex SHA-256', code: 'invalid_decision' });
            }
            if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > LIMITS.summary)) {
                return res.status(400).json({ error: `note must be a string of at most ${LIMITS.summary} characters`, code: 'invalid_decision' });
            }
            const note = typeof body.note === 'string' ? body.note.trim() : '';
            let selection = null;
            if (body.selection !== undefined && body.selection !== null) {
                if (!isPlainObject(body.selection) || JSON.stringify(body.selection).length > LIMITS.selectionJson) {
                    return res.status(400).json({ error: `selection must be a small JSON object (at most ${LIMITS.selectionJson} characters)`, code: 'invalid_decision' });
                }
                selection = body.selection;
            }
            let clientDecisionId = null;
            if (body.client_decision_id !== undefined) {
                clientDecisionId = text(body.client_decision_id, LIMITS.clientId);
                if (!clientDecisionId) return res.status(400).json({ error: 'client_decision_id must be a short string', code: 'invalid_decision' });
                if (clientDecisionId.startsWith(FINISH_APPROVAL_KEY)) return res.status(400).json({ error: `client_decision_id may not start with "${FINISH_APPROVAL_KEY}": that key belongs to the approval a finished review records`, code: 'invalid_decision' });
            }
            const parsedExecutor = parseExecutorProvenance(body, { decision: body.decision, authority: authority.actor.authority });
            if (!parsedExecutor.ok) return res.status(parsedExecutor.status).json({ error: parsedExecutor.error, code: parsedExecutor.code });
            const executor = parsedExecutor.value;
            const sameRecorder = prior => (executor
                ? prior.recorded_by === 'executor' && prior.provenance?.executor?.id === executor.id
                    && (!executor.source_review_id || prior.provenance?.source?.review_id === executor.source_review_id)
                    && (!executor.source_submission_id || prior.provenance?.source?.submission_id === executor.source_submission_id)
                : prior.recorded_by !== 'executor');
            const sameRequest = prior => prior.decision === body.decision && prior.revision_id === revisionId && prior.note === note
                && prior.actor_id === authority.actor.id && (body.content_hash === undefined || body.content_hash === prior.content_hash)
                && JSON.stringify(prior.selection ?? null) === JSON.stringify(selection) && sameRecorder(prior);
            const replay = prior => (sameRequest(prior)
                ? res.status(200).json({ decision: prior, duplicate: true, review_status: store().getReviewStatus(doc.id) })
                : res.status(409).json({ error: 'client_decision_id was already used for a different decision', code: 'idempotency_key_reused', decision: prior }));
            // An identical retry is answered from the record before any freshness check, so a lost response never turns into a conflict.
            if (clientDecisionId) {
                const prior = store().findDecisionByClientId(doc.id, clientDecisionId);
                if (prior) return replay(prior);
            }
            if (!doc.requires_review) {
                return res.status(409).json({ error: 'This is a reference document; it does not take review decisions', code: 'review_not_required' });
            }
            const revision = store().getRevisionMeta(revisionId);
            if (!revision || revision.document_id !== doc.id) return res.status(404).json({ error: 'Revision not found', code: 'revision_not_found' });
            if (body.content_hash !== undefined && body.content_hash !== revision.content_hash) {
                return res.status(409).json({ error: 'content_hash does not match that revision', code: 'content_mismatch' });
            }
            // A direction-selection design package: approving it is choosing a direction (contract §3.3).
            const manifest = store().getRevision(revision.id)?.manifest ?? null;
            const directions = Array.isArray(manifest?.directions) ? manifest.directions.map(d => d.id) : [];
            if (directions.length >= 2 && body.decision === 'approve') {
                const chosen = selection?.direction;
                if (typeof chosen !== 'string' || !directions.includes(chosen)) {
                    return res.status(400).json({ error: 'Approving this design package means selecting a direction: send selection.direction with one of its direction ids', code: 'selection_required', directions });
                }
            } else if (selection?.direction !== undefined && !directions.includes(selection.direction)) {
                return res.status(400).json({ error: 'selection.direction does not name a direction of this revision', code: 'invalid_decision', directions });
            }
            // An executor-recorded approval must rest on Robert's submitted, delegating instruction for an earlier revision of this document.
            const sourceRefusal = refusal => res.status(refusal.status).json({ error: refusal.error, code: refusal.code, ...sourceDetails(refusal) });
            if (executor) {
                const source = resolveSourceReview({ store: store(), doc, revision, executor });
                if (!source.ok) return sourceRefusal(source);
            }
            const captured = await captureRevision(doc);
            if (captured.fileState !== 'ok') {
                return res.status(409).json({ error: `The document file cannot be confirmed right now (${captured.fileState}); no decision was recorded`, code: 'file_unavailable', file_state: captured.fileState });
            }
            const stale = current => res.status(409).json({
                error: 'The document changed after the revision you reviewed; reopen it and decide on the current revision',
                code: 'stale_revision', revision_id: revisionId, current_revision: revisionMeta(current),
            });
            if (captured.revision.id !== revision.id) return stale(captured.revision);
            // Version lifecycle (task 6b46dcc8): open replacement work, or a current revision that is not ready, takes no decision.
            await reconcileReplacement(doc);
            const gate = reviewability(store().getDocument(doc.id), captured.revision);
            if (!gate.ok) return notReviewable(res, gate);
            // A decision through the local session also needs Robert's answer to
            // a native dialog naming this exact decision (Option A, task 5e513530).
            const direction = typeof selection?.direction === 'string' ? selection.direction : null;
            const directionEntry = direction ? manifest.directions.find(d => d.id === direction) : null;
            const otherSelection = selection ? Object.keys(selection).filter(key => key !== 'direction') : [];
            const decisionIdentity = rev => ({
                kind: 'document_decision', document_id: doc.id, revision_id: rev?.id, content_hash: rev?.content_hash,
                decision: body.decision, selection: selection ?? null, note_sha256: confirmation.sha256(note),
            });
            const asked = await confirmations.confirm({ res, auth: authority, action: confirmation.documentDecisionAction({
                identity: decisionIdentity(revision), title: doc.title || doc.id, revision, version: store().revisionDraft(revision.id)?.version,
                decision: body.decision,
                direction: direction && `${directionEntry?.title || directionEntry?.name || directionEntry?.label || direction} (${direction})${otherSelection.length ? `; selection also sets ${otherSelection.join(', ')}` : ''}`,
                note,
            }) });
            if (!asked.ok) {
                return res.status(asked.status).json({ error: asked.error, code: asked.code, nothing_recorded: true, ...(asked.confirmation_ref ? { confirmation_ref: asked.confirmation_ref } : {}) });
            }
            if (asked.required) {
                // The wait can be long: the bytes on disk must still be the revision confirmed.
                const again = await captureRevision(doc);
                if (again.fileState !== 'ok') {
                    return res.status(409).json({ error: `The document file cannot be confirmed right now (${again.fileState}); no decision was recorded`, code: 'file_unavailable', file_state: again.fileState });
                }
                if (again.revision.id !== revision.id) return stale(again.revision);
            }
            let decision;
            let lostSource = null;
            let blockedBy = null;
            let unconfirmed = false;
            try {
                decision = store().transaction(() => {
                    const fresh = store().getDocument(doc.id);
                    if (fresh.current_revision_id !== revision.id || !fresh.requires_review) return null;
                    // Single use, and only for the decision Robert confirmed.
                    if (!asked.consume(decisionIdentity(store().getRevisionMeta(fresh.current_revision_id)))) { unconfirmed = true; return null; }
                    // Re-checked inside the transaction: an acceptance or a failure report landing meanwhile wins over this decision.
                    const gateNow = reviewability(fresh, revision);
                    if (!gateNow.ok) { blockedBy = gateNow; return null; }
                    let provenance = null;
                    if (executor) {
                        // Re-resolved inside the transaction: a decision or review landing meanwhile must win.
                        const source = resolveSourceReview({ store: store(), doc, revision, executor });
                        if (!source.ok) { lostSource = source; return null; }
                        provenance = buildProvenance({ executor, ...source });
                    }
                    return store().insertDecision({
                        document_id: doc.id, revision_id: revision.id, content_hash: revision.content_hash, decision: body.decision,
                        actor_id: authority.actor.id, authority: authority.actor.authority, note, client_decision_id: clientDecisionId,
                        intended_action: fresh.intended_action, selection,
                        recorded_by: executor ? 'executor' : 'operator', provenance,
                    });
                });
            } catch (err) {
                const raced = clientDecisionId && /UNIQUE/i.test(err.message || '') ? store().findDecisionByClientId(doc.id, clientDecisionId) : null;
                if (raced) return replay(raced);
                throw err;
            }
            if (lostSource) return sourceRefusal(lostSource);
            if (blockedBy) return notReviewable(res, blockedBy);
            if (unconfirmed) {
                const [status, code, error] = confirmation.REFUSALS.mismatch;
                return res.status(status).json({ error, code, nothing_recorded: true });
            }
            if (!decision) return stale(store().getRevisionMeta(store().getDocument(doc.id).current_revision_id));
            const recorder = executor ? `, recorded_by=executor ${executor.id}, source_review=${decision.provenance.source.review_id}` : '';
            const confirmed = asked.required ? `, operator confirmation ref=${asked.ref}` : '';
            console.log(`[Documents] ${body.decision} recorded for ${doc.id} revision ${revision.id} (authority=${authority.actor.authority}${recorder}${confirmed})`);
            return res.status(201).json({ decision, review_status: store().getReviewStatus(doc.id), document: store().getDocument(doc.id), ...(asked.required ? { confirmation_ref: asked.ref } : {}) });
        } catch (err) {
            console.error('[Documents] decision failed:', err);
            return res.status(500).json({ error: 'Failed to record decision' });
        }
    });

    /**
     * Consumer check for a downstream actor (for example the stakeholder
     * sender): is this decision the document's latest, on its current
     * revision as re-read now? Only `in_force && decision === 'approve'`
     * means the approved bytes are still the document's bytes.
     */
    router.get('/:id/decisions/:decisionId', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            const decision = store().getDecision(req.params.decisionId);
            if (!decision || decision.document_id !== doc.id) return res.status(404).json({ error: 'Decision not found' });
            const captured = await captureRevision(doc);
            const fresh = store().getDocument(doc.id);
            const latest = store().latestDecision(doc.id);
            let reason = null;
            if (!fresh.requires_review) reason = 'review_not_required';
            else if (latest.id !== decision.id) reason = 'superseded';
            else if (captured.fileState !== 'ok') reason = 'file_unavailable';
            else if (captured.revision?.id !== decision.revision_id) reason = 'document_changed';
            return res.json({
                decision,
                in_force: reason === null,
                reason,
                approved: reason === null && decision.decision === 'approve',
                file_state: captured.fileState,
                revision: store().getRevisionMeta(decision.revision_id),
                current_revision: revisionMeta(captured.revision),
                links: {
                    review_path: fmt.reviewPathFor(doc.id),
                    raw_path: `/api/documents/${encodeURIComponent(doc.id)}/raw?revision=${encodeURIComponent(decision.revision_id)}`,
                },
            });
        } catch (err) {
            console.error('[Documents] decision check failed:', err);
            return res.status(500).json({ error: 'Failed to check decision' });
        }
    });

    // ── Replacement work (version lifecycle, task 6b46dcc8; contract §12) ──
    // Praxis links an authorized change request (a request_changes decision on
    // the current revision, or a submitted review of it) to exactly one revision
    // work item. Accepting it supersedes every pending draft on the document
    // and closes the document to new reviews, decisions and edits until the
    // work declares its registered result the current ready revision, or fails
    // or is cancelled before registering one (the unchanged version reopens,
    // but only when no failed result governs the current version).
    // An attempt that registered a result and then failed or was cancelled
    // keeps those bytes closed until an explicit recovery delivers (12.5); a
    // recovery that ends before registering anything leaves them closed.
    // Nothing here approves, sends, publishes or changes task
    // state; chat delivery of the originating review is tracked apart from it.
    function parseReplacementSource(doc, body) {
        const source = body.source;
        if (!isPlainObject(source)) return { ok: false, status: 400, code: 'invalid_replacement', error: 'source is required: the submission, review and/or decision that authorized the change' };
        const unknown = Object.keys(source).filter(key => !REPLACEMENT_SOURCE_FIELDS.has(key));
        if (unknown.length) return { ok: false, status: 400, code: 'invalid_replacement', error: `Unknown source field(s): ${unknown.join(', ')}` };
        const ids = {};
        for (const field of REPLACEMENT_SOURCE_FIELDS) {
            if (source[field] === undefined || source[field] === null) continue;
            const value = text(String(source[field]), LIMITS.clientId);
            if (!value) return { ok: false, status: 400, code: 'invalid_replacement', error: `source.${field} must be a short string` };
            ids[field] = value;
        }
        if (!ids.submission_id && !ids.review_id && !ids.decision_id) {
            return { ok: false, status: 400, code: 'invalid_replacement', error: 'source needs submission_id, review_id or decision_id' };
        }
        const notFound = what => ({ ok: false, status: 404, code: 'source_not_found', error: `${what} was not found on this document` });
        let submission = null;
        let review = null;
        let decision = null;
        if (ids.submission_id) {
            submission = store().getSubmission(ids.submission_id);
            if (!submission || submission.document_id !== doc.id) return notFound('The cited review submission');
            review = store().getReview(submission.review_id);
        }
        if (ids.review_id) {
            if (review && review.id !== ids.review_id) return { ok: false, status: 400, code: 'invalid_replacement', error: 'source.review_id and source.submission_id name different reviews' };
            review = review || store().getReview(ids.review_id);
            if (!review || review.document_id !== doc.id) return notFound('The cited review');
        }
        if (review && !submission) submission = store().getSubmissionForReview(review.id) || null;
        if (ids.decision_id) {
            decision = store().getDecision(ids.decision_id);
            if (!decision || decision.document_id !== doc.id) return notFound('The cited decision');
        }
        return { ok: true, value: { submission, review, decision } };
    }

    /**
     * Does the source still authorize work on the document's current revision?
     * A review must be submitted and pinned to the current revision; a decision
     * must be request_changes on the current revision and the latest decision.
     * Older authority is never reused (contract §12.2).
     */
    // Authority is judged against the version that carries it (authorityRevision): the current revision, or, when the current
    // revision is the unaccepted result of a failed or cancelled attempt, the version that attempt set out to replace. So a
    // recovery cites the same review or decision the failed attempt did, and a request pinned to any other version is stale.
    function sourceAuthorizes(doc, current, { review, decision }) {
        const authority = authorityRevision(doc, current).revision;
        const authorityId = authority ? authority.id : null;
        const stale = (what, revisionId) => ({
            ok: false, status: 409, code: 'source_not_current',
            error: `${what} is pinned to revision ${revisionId}, not the current reviewable revision${authorityId && authorityId !== current.id ? ` (${authorityId}; the current bytes are an unaccepted result)` : ''}; stale authority is not reused, ask for a new review or decision of the current version`,
            extra: { source_revision_id: revisionId, authority_revision_id: authorityId, current_revision: revisionMeta(current) },
        });
        if (review) {
            if (review.status !== 'submitted' || !review.submitted_at) {
                return { ok: false, status: 409, code: 'source_review_not_submitted', error: 'The cited review has not been finished; only a submitted review authorizes work', extra: { review_id: review.id, status: review.status } };
            }
            // A review finished with the approve-with-changes checkbox approved its revision (task 282c64fa). Its note stays
            // with the approval and is never revision work; only a later request_changes decision, cited itself, can open any.
            if (review.approval_decision_id && !decision) {
                return { ok: false, status: 409, code: 'source_not_change_request', error: 'The cited review approved this version when it was finished; its note stays with the approval and creates no revision work', extra: { review_id: review.id, decision_id: review.approval_decision_id } };
            }
            if (review.revision_id !== authorityId) return stale(`The cited review ${review.id}`, review.revision_id);
        }
        if (decision) {
            if (decision.decision !== 'request_changes') {
                return { ok: false, status: 409, code: 'source_not_change_request', error: 'The cited decision is an approval; approval without edits creates no revision work', extra: { decision_id: decision.id } };
            }
            if (decision.revision_id !== authorityId) return stale(`The cited decision ${decision.id}`, decision.revision_id);
            const latest = store().latestDecision(doc.id);
            if (latest && latest.id !== decision.id) {
                return { ok: false, status: 409, code: 'source_superseded', error: 'A later decision was recorded after the cited one; it is the current authority', extra: { decision: latest } };
            }
        }
        return { ok: true };
    }

    router.post('/:id/replacements', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Same-origin requests only', code: 'cross_site' });
            const body = isPlainObject(req.body) ? req.body : {};
            const unknown = Object.keys(body).filter(key => !REPLACEMENT_FIELDS.has(key));
            if (unknown.length) return res.status(400).json({ error: `Unknown field(s): ${unknown.join(', ')}`, code: 'invalid_replacement' });
            const clientRequestId = text(body.client_request_id, LIMITS.clientId);
            if (!clientRequestId) return res.status(400).json({ error: 'client_request_id is required: a stable key so a retry is the same acceptance', code: 'invalid_replacement' });
            const taskId = body.task_id === undefined || body.task_id === null ? null : text(String(body.task_id), 120);
            if (body.task_id !== undefined && body.task_id !== null && !taskId) return res.status(400).json({ error: 'task_id must be a short string', code: 'invalid_replacement' });
            const executionId = body.execution_id === undefined || body.execution_id === null ? null : text(String(body.execution_id), 120);
            if (body.execution_id !== undefined && body.execution_id !== null && !executionId) return res.status(400).json({ error: 'execution_id must be a short string', code: 'invalid_replacement' });
            const state = body.state === undefined ? 'accepted' : body.state;
            if (!ACCEPT_STATES.has(state)) return res.status(400).json({ error: `state at acceptance must be one of ${[...ACCEPT_STATES].join(', ')}`, code: 'invalid_replacement' });
            // Replacement detail carries whole evidence (a QA reason, Robert's hold words): any length, stored as sent; the JSON body limit bounds the request.
            const detail = body.detail === undefined || body.detail === null ? null : typeof body.detail === 'string' ? body.detail.trim() || null : false;
            if (detail === false) return res.status(400).json({ error: 'detail must be a string', code: 'invalid_replacement' });
            const recovers = body.recovers_replacement_id === undefined || body.recovers_replacement_id === null ? null : text(String(body.recovers_replacement_id), 120);
            if (body.recovers_replacement_id !== undefined && body.recovers_replacement_id !== null && !recovers) return res.status(400).json({ error: 'recovers_replacement_id must be a short string', code: 'invalid_replacement' });
            const parsedSource = parseReplacementSource(doc, body);
            if (!parsedSource.ok) return res.status(parsedSource.status).json({ error: parsedSource.error, code: parsedSource.code });
            const { submission, review, decision } = parsedSource.value;
            const sourceIds = { submission_id: submission?.id ?? null, review_id: review?.id ?? null, decision_id: decision?.id ?? null };
            const sameSource = rp => rp.source_submission_id === sourceIds.submission_id && rp.source_review_id === sourceIds.review_id && rp.source_decision_id === sourceIds.decision_id;
            // An identical retry is answered from the record before anything else, so a lost response never becomes a conflict.
            const replay = prior => (sameSource(prior)
                ? res.status(200).json({ replacement: replacementView(prior), duplicate: true, superseded_reviews: prior.superseded_review_ids || [], document: store().getDocument(doc.id), review_status: store().getReviewStatus(doc.id), reviewable: false })
                : res.status(409).json({ error: 'client_request_id was already used for a different source', code: 'idempotency_key_reused', replacement: replacementView(prior) }));
            const prior = store().findReplacementByClientKey(doc.id, clientRequestId);
            if (prior) return replay(prior);
            if (taskId && typeof db.getTask === 'function' && !await db.getTask(taskId)) return res.status(404).json({ error: 'Revision task not found', code: 'task_not_found' });
            const captured = await captureRevision(doc);
            await reconcileReplacement(doc);
            // Re-checked after the awaits: an identical retry that overlapped the first acceptance is the same acceptance.
            const priorNow = store().findReplacementByClientKey(doc.id, clientRequestId);
            if (priorNow) return replay(priorNow);
            const current = captured.revision;
            if (!current) return res.status(409).json({ error: 'The document has no revision to replace', code: 'no_revision' });
            const authorized = sourceAuthorizes(doc, current, { review, decision });
            if (!authorized.ok) return res.status(authorized.status).json({ error: authorized.error, code: authorized.code, ...(authorized.extra || {}) });
            const live = store().findLiveReplacementBySource(doc.id, sourceIds);
            if (live) return res.status(409).json({ error: `This change request is already linked to replacement work (${live.state})`, code: 'replacement_exists', replacement: replacementView(live) });
            const open = store().findOpenReplacement(doc.id);
            if (open) return res.status(409).json({ error: 'Replacement work on this document is already in progress; one open item at a time', code: 'replacement_in_progress', replacement: replacementView(open) });
            // Recovery is explicit and versioned: a failed or cancelled item for the same request must be named.
            const previous = store().latestReplacementBySource(doc.id, sourceIds);
            if (previous && !recovers) return res.status(409).json({ error: `The previous replacement for this request ${previous.state}; name it in recovers_replacement_id to start attempt ${previous.attempt + 1}`, code: 'recovery_required', replacement: replacementView(previous) });
            if (recovers && (!previous || previous.id !== recovers)) return res.status(409).json({ error: 'recovers_replacement_id does not name the latest replacement for this request', code: 'invalid_recovery', ...(previous ? { replacement: replacementView(previous) } : {}) });
            const sourceAuthority = decision ? decision.authority : review ? (review.submitted_authority || 'unsigned') : null;
            let accepted;
            try {
                accepted = store().transaction(() => {
                    const fresh = store().getDocument(doc.id);
                    if (fresh.current_revision_id !== current.id) return { raced: 'stale' };
                    if (store().findOpenReplacement(doc.id)) return { raced: 'open' };
                    if (store().findLiveReplacementBySource(doc.id, sourceIds)) return { raced: 'live' };
                    // The authority is re-read inside the transaction: a decision recorded meanwhile (an approval, say) wins over this acceptance.
                    const authorityNow = sourceAuthorizes(fresh, current, { review: review && store().getReview(review.id), decision: decision && store().getDecision(decision.id) });
                    if (!authorityNow.ok) return { raced: 'authority', refusal: authorityNow };
                    const id = randomUUID();
                    const superseded = store().supersedeOpenDrafts(doc.id, id);
                    const replacement = store().insertReplacement({
                        id, document_id: doc.id, base_revision_id: current.id, client_request_id: clientRequestId,
                        source_submission_id: sourceIds.submission_id, source_review_id: sourceIds.review_id, source_decision_id: sourceIds.decision_id, source_authority: sourceAuthority,
                        task_id: taskId, execution_id: executionId, state, detail, attempt: previous ? previous.attempt + 1 : 1, recovers_replacement_id: recovers,
                        accepted_by: req.user.id, superseded_review_ids: superseded,
                    });
                    return { replacement, superseded };
                });
            } catch (err) {
                if (/UNIQUE/i.test(err.message || '')) {
                    const racedPrior = store().findReplacementByClientKey(doc.id, clientRequestId);
                    if (racedPrior) return replay(racedPrior);
                    const racedOpen = store().findOpenReplacement(doc.id) || store().findLiveReplacementBySource(doc.id, sourceIds);
                    if (racedOpen) return res.status(409).json({ error: 'A concurrent acceptance claimed this document; use the item it created', code: 'replacement_in_progress', replacement: replacementView(racedOpen) });
                }
                throw err;
            }
            if (accepted.raced === 'stale') return res.status(409).json({ error: 'The document changed while the acceptance was being recorded; re-read it and cite authority for the current revision', code: 'stale_revision', current_revision: revisionMeta(store().getRevisionMeta(store().getDocument(doc.id).current_revision_id)) });
            if (accepted.raced === 'authority') return res.status(accepted.refusal.status).json({ error: accepted.refusal.error, code: accepted.refusal.code, ...(accepted.refusal.extra || {}) });
            if (accepted.raced) {
                const byKey = store().findReplacementByClientKey(doc.id, clientRequestId);
                if (byKey) return replay(byKey);
                const existing = store().findOpenReplacement(doc.id) || store().findLiveReplacementBySource(doc.id, sourceIds);
                return res.status(409).json({ error: 'A concurrent acceptance claimed this document; use the item it created', code: accepted.raced === 'live' ? 'replacement_exists' : 'replacement_in_progress', replacement: replacementView(existing) });
            }
            const { replacement, superseded } = accepted;
            console.log(`[Documents] replacement ${replacement.id} accepted for ${doc.id} (base ${current.id}, task ${taskId || 'pending'}, attempt ${replacement.attempt}); superseded drafts: ${superseded.length ? superseded.join(', ') : 'none'}`);
            return res.status(201).json({
                replacement: replacementView(replacement), duplicate: false, superseded_reviews: superseded,
                document: store().getDocument(doc.id), review_status: store().getReviewStatus(doc.id), reviewable: false,
            });
        } catch (err) {
            console.error('[Documents] accept replacement failed:', err);
            return res.status(500).json({ error: 'Failed to accept replacement work' });
        }
    });

    router.get('/:id/replacements', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            await reconcileReplacement(doc);
            const fresh = store().getDocument(doc.id);
            const open = store().findOpenReplacement(doc.id);
            return res.json({
                document_id: doc.id, current_revision_id: fresh.current_revision_id,
                open: replacementView(open),
                reviewable: reviewability(fresh, fresh.current_revision_id ? store().getRevisionMeta(fresh.current_revision_id) : null).ok,
                replacements: store().listReplacements(doc.id).map(replacementView),
            });
        } catch (err) {
            console.error('[Documents] list replacements failed:', err);
            return res.status(500).json({ error: 'Failed to list replacement work' });
        }
    });

    /** Consumer check: is this work item open, and is its result the document's current ready revision as re-read now? */
    router.get('/:id/replacements/:replacementId', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            let rp = store().getReplacement(req.params.replacementId);
            if (!rp || rp.document_id !== doc.id) return res.status(404).json({ error: 'Replacement not found', code: 'replacement_not_found' });
            const captured = await captureRevision(doc);
            await reconcileReplacement(doc);
            rp = store().getReplacement(rp.id);
            const fresh = store().getDocument(doc.id);
            const result = rp.result_revision_id ? store().getRevisionMeta(rp.result_revision_id) : null;
            const readiness = resultReady(fresh, result);
            return res.json({
                replacement: replacementView(rp),
                is_latest: store().latestReplacement(doc.id)?.id === rp.id,
                result_is_current: Boolean(result && fresh.current_revision_id === result.id),
                result_is_ready: readiness.ready,
                result_revision: result,
                base_revision: store().getRevisionMeta(rp.base_revision_id),
                current_revision: revisionMeta(captured.revision),
                file_state: captured.fileState,
                review_status: store().getReviewStatus(doc.id),
                reviewable: reviewability(fresh, captured.revision).ok,
            });
        } catch (err) {
            console.error('[Documents] replacement check failed:', err);
            return res.status(500).json({ error: 'Failed to check replacement work' });
        }
    });

    router.patch('/:id/replacements/:replacementId', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Same-origin requests only', code: 'cross_site' });
            const rp = store().getReplacement(req.params.replacementId);
            if (!rp || rp.document_id !== doc.id) return res.status(404).json({ error: 'Replacement not found', code: 'replacement_not_found' });
            const body = isPlainObject(req.body) ? req.body : {};
            const unknown = Object.keys(body).filter(key => !REPLACEMENT_PATCH_FIELDS.has(key));
            if (unknown.length) return res.status(400).json({ error: `Unknown field(s): ${unknown.join(', ')}`, code: 'invalid_replacement' });
            if (!Object.keys(body).length) return res.status(400).json({ error: 'Nothing to report: send state, detail, task_id, execution_id, qa_state and/or revision_id', code: 'invalid_replacement' });
            const patch = {};
            if (body.state !== undefined) {
                if (!REPORTABLE_STATES.has(body.state)) return res.status(400).json({ error: `state must be one of ${REPLACEMENT_STATES.join(', ')}`, code: 'invalid_replacement' });
                patch.state = body.state;
            }
            if (body.detail !== undefined) {
                // Any length, as at acceptance: a whole QA reason is the evidence for qa_passed and is never refused for its size.
                if (body.detail !== null && typeof body.detail !== 'string') return res.status(400).json({ error: 'detail must be a string', code: 'invalid_replacement' });
                patch.detail = body.detail === null ? null : body.detail.trim() || null;
            }
            if (body.qa_state !== undefined) {
                if (body.qa_state !== null && !QA_STATES.has(body.qa_state)) return res.status(400).json({ error: 'qa_state must be pending, passed, failed or null', code: 'invalid_replacement' });
                patch.qa_state = body.qa_state;
            }
            if (body.execution_id !== undefined) {
                const executionId = body.execution_id === null ? null : text(String(body.execution_id), 120);
                if (body.execution_id !== null && !executionId) return res.status(400).json({ error: 'execution_id must be a short string', code: 'invalid_replacement' });
                patch.execution_id = executionId;
            }
            let taskId = null;
            if (body.task_id !== undefined) {
                taskId = text(String(body.task_id), 120);
                if (!taskId) return res.status(400).json({ error: 'task_id must be a short string', code: 'invalid_replacement' });
                if (rp.task_id && rp.task_id !== taskId) return res.status(409).json({ error: `This replacement is already linked to task ${rp.task_id}; one work item links to one task`, code: 'task_already_linked', replacement: replacementView(rp) });
                if (!rp.task_id) {
                    if (typeof db.getTask === 'function' && !await db.getTask(taskId)) return res.status(404).json({ error: 'Revision task not found', code: 'task_not_found' });
                    patch.task_id = taskId;
                }
            }
            let resultRevision = null;
            if (body.revision_id !== undefined) {
                const revisionId = text(String(body.revision_id), 120);
                if (!revisionId) return res.status(400).json({ error: 'revision_id must be a short string', code: 'invalid_replacement' });
                resultRevision = store().getRevisionMeta(revisionId);
                if (!resultRevision || resultRevision.document_id !== doc.id) return res.status(404).json({ error: 'Revision not found on this document', code: 'revision_not_found' });
                if (resultRevision.id === rp.base_revision_id) return res.status(409).json({ error: 'The result cannot be the revision being replaced', code: 'result_is_base' });
                if (rp.result_revision_id && rp.result_revision_id !== resultRevision.id && !isOpenState(rp.state)) return res.status(409).json({ error: 'A closed replacement keeps its recorded result', code: 'replacement_closed', replacement: replacementView(rp) });
                patch.result_revision_id = resultRevision.id;
            }
            // A report that changes nothing (the same task link again) is answered from the record.
            if (!Object.keys(patch).length) return res.status(200).json({ replacement: replacementView(rp), duplicate: true, document: store().getDocument(doc.id), review_status: store().getReviewStatus(doc.id) });
            // Terminal items are history: only an identical report is accepted (as a no-op replay).
            if (!isOpenState(rp.state)) {
                const identical = Object.entries(patch).every(([key, value]) => (rp[key] ?? null) === (value ?? null));
                if (identical) return res.status(200).json({ replacement: replacementView(rp), duplicate: true, document: store().getDocument(doc.id), review_status: store().getReviewStatus(doc.id) });
                return res.status(409).json({ error: `This replacement is ${rp.state}; it takes no further reports. Recovery is a new replacement that names this one`, code: 'replacement_closed', replacement: replacementView(rp) });
            }
            // `ready` is a verified claim: the result must be registered, current and ready as re-read now.
            const captured = await captureRevision(doc);
            const fresh = store().getDocument(doc.id);
            const notReady = (document, result, readiness) => res.status(409).json({
                error: readiness.reason === 'no_result'
                    ? 'No resulting revision is registered for this replacement; register the file under its task (or send revision_id) before declaring it ready'
                    : readiness.reason === 'result_not_current'
                        ? `Revision ${result.id} is not the document's current revision (${document.current_revision_id}); the latest bytes win and only they can be ready`
                        : `Revision ${result.id} is not ready: ${readiness.readiness.required_ok}/${readiness.readiness.required_total} required assets are servable`,
                code: 'result_not_ready', reason: readiness.reason,
                current_revision: revisionMeta(document.current_revision_id === captured.revision?.id ? captured.revision : store().getRevisionMeta(document.current_revision_id)),
                ...(readiness.readiness ? { readiness: readiness.readiness } : {}),
            });
            if (patch.state === 'ready') {
                const result = resultRevision || (rp.result_revision_id ? store().getRevisionMeta(rp.result_revision_id) : null);
                if (!result) return notReady(fresh, null, { ready: false, reason: 'no_result' });
                if (captured.fileState !== 'ok') return res.status(409).json({ error: `The document file cannot be confirmed right now (${captured.fileState}); readiness is not declared on unconfirmed bytes`, code: 'result_not_ready', reason: 'file_unavailable', file_state: captured.fileState });
                const readiness = resultReady(fresh, result);
                if (!readiness.ready) return notReady(fresh, result, readiness);
                patch.completed_at = new Date().toISOString();
            } else if (patch.state === 'failed' || patch.state === 'cancelled') {
                patch.completed_at = new Date().toISOString();
            }
            // Everything the awaits above decided is re-read inside the write transaction: a task link that landed meanwhile
            // keeps its task (one work item, one task), and `ready` is re-verified against the revision that is current now.
            let linkedMeanwhile = null;
            let staleReadiness = null;
            let unchanged = false;
            const updated = store().transaction(() => {
                const again = store().getReplacement(rp.id);
                if (!again || !isOpenState(again.state)) return null;
                if (patch.task_id !== undefined) {
                    if (again.task_id && again.task_id !== patch.task_id) { linkedMeanwhile = again; return null; }
                    if (again.task_id === patch.task_id) delete patch.task_id;
                }
                if (patch.state === 'ready') {
                    const document = store().getDocument(doc.id);
                    const result = store().getRevisionMeta(patch.result_revision_id || again.result_revision_id);
                    const readiness = resultReady(document, result);
                    if (!readiness.ready) { staleReadiness = { document, result, readiness }; return null; }
                }
                if (!Object.keys(patch).length) { unchanged = true; return again; }
                return store().updateReplacement(rp.id, patch);
            });
            if (linkedMeanwhile) return res.status(409).json({ error: `This replacement was linked to task ${linkedMeanwhile.task_id} meanwhile; one work item links to one task`, code: 'task_already_linked', replacement: replacementView(linkedMeanwhile) });
            if (staleReadiness) return notReady(staleReadiness.document, staleReadiness.result, staleReadiness.readiness);
            if (!updated) return res.status(409).json({ error: 'This replacement closed while the report was being recorded', code: 'replacement_closed', replacement: replacementView(store().getReplacement(rp.id)) });
            if (unchanged) return res.status(200).json({ replacement: replacementView(updated), duplicate: true, document: store().getDocument(doc.id), review_status: store().getReviewStatus(doc.id) });
            // A QA pass whose result is already current and ready completes the item.
            const reconciled = (await reconcileReplacement(doc)) || store().getReplacement(rp.id);
            console.log(`[Documents] replacement ${rp.id} of ${doc.id}: ${rp.state} → ${reconciled.state}${patch.task_id ? `, task ${patch.task_id}` : ''}${patch.result_revision_id ? `, result ${patch.result_revision_id}` : ''}`);
            const after = store().getDocument(doc.id);
            return res.json({ replacement: replacementView(reconciled), document: after, review_status: store().getReviewStatus(doc.id), reviewable: reviewability(after, captured.revision).ok });
        } catch (err) {
            console.error('[Documents] replacement report failed:', err);
            return res.status(500).json({ error: 'Failed to record replacement progress' });
        }
    });

    // ── Reviews ───────────────────────────────────────────────────────────
    router.post('/:id/reviews', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            const body = isPlainObject(req.body) ? req.body : {};
            // A stale tab names the revision it shows; a review is only ever opened on the current revision.
            const requested = body.revision_id === undefined || body.revision_id === null ? null : text(String(body.revision_id), 120);
            if (body.revision_id !== undefined && body.revision_id !== null && !requested) return res.status(400).json({ error: 'revision_id must be a short string', code: 'invalid_review' });
            const captured = await captureRevision(doc);
            if (!captured.revision) return res.status(409).json({ error: captured.fileError || 'Document has no readable revision to review', code: captured.fileState });
            await reconcileReplacement(doc);
            if (requested && requested !== captured.revision.id) {
                return res.status(409).json({ error: 'The document has a newer revision than the one you are viewing; reload and review the current revision', code: 'stale_revision', revision_id: requested, current_revision: revisionMeta(captured.revision) });
            }
            // Only the latest ready revision takes review actions (task 6b46dcc8), and handing back a writable draft is one: a
            // closed version answers 409 with or without a draft. Acceptance supersedes every draft on the document, whatever
            // revision it is pinned to, so none should survive into open or failed work; one that did is refused here, not
            // returned. From here to the response nothing awaits, so the gate and the draft lookup read one state.
            const gate = reviewability(store().getDocument(doc.id), captured.revision);
            if (!gate.ok) return notReviewable(res, gate);
            // A draft already open stays the caller's round even when a plain capture or edit (no replacement work) has
            // since moved the document on: it is returned pinned to its own revision, flagged `is_current_revision: false`
            // with its anchors read against the current bytes, and finishing it is feedback on that version only, never
            // authority for work on the current one (sourceAuthorizes). A new round is only ever opened on the current revision.
            let review = store().findOpenDraft(doc.id, req.user.id);
            let created = false;
            if (!review) {
                // Currency and the gate are re-checked inside the insert transaction.
                let blocked = null;
                let overtaken = null;
                review = store().transaction(() => {
                    // Re-read inside the transaction: a registration or promotion that landed during the awaits above makes the
                    // captured revision stale, and a round is only ever opened on the revision that is current at the insert.
                    const fresh = store().getDocument(doc.id);
                    if (fresh.current_revision_id !== captured.revision.id) { overtaken = store().getRevisionMeta(fresh.current_revision_id); return null; }
                    const gateNow = reviewability(fresh, captured.revision);
                    if (!gateNow.ok) { blocked = gateNow; return null; }
                    return store().insertReview({ document_id: doc.id, revision_id: captured.revision.id, reviewer_id: req.user.id });
                });
                if (overtaken) return res.status(409).json({ error: 'The document gained a newer revision while the review was being opened; reload and review the current revision', code: 'stale_revision', revision_id: captured.revision.id, current_revision: revisionMeta(overtaken) });
                if (blocked) return notReviewable(res, blocked);
                created = true;
            }
            return res.status(created ? 201 : 200).json({ review: reviewView(review, { revision: captured.revision }), created });
        } catch (err) {
            console.error('[Documents] open review failed:', err);
            return res.status(500).json({ error: 'Failed to open review' });
        }
    });

    router.get('/reviews/:reviewId', async (req, res) => {
        try {
            const review = ownReview(req, res);
            if (!review) return;
            const doc = store().getDocument(review.document_id);
            const captured = doc ? await captureRevision(doc) : { revision: null };
            return res.json({ review: reviewView(review, { revision: captured.revision }) });
        } catch (err) {
            console.error('[Documents] read review failed:', err);
            return res.status(500).json({ error: 'Failed to read review' });
        }
    });

    router.patch('/reviews/:reviewId', (req, res) => {
        const review = ownReview(req, res);
        if (!review || !requireDraft(review, res)) return;
        const body = req.body || {};
        if (typeof body.summary !== 'string' || body.summary.length > LIMITS.summary) {
            return res.status(400).json({ error: `summary must be a string of at most ${LIMITS.summary} characters` });
        }
        const updated = store().updateReview(review.id, { summary: body.summary });
        return res.json({ review: reviewView(updated, currentFor(store().getDocument(review.document_id))) });
    });

    async function commentReviewAccess(req,res) {
        const candidate=store().getReview(req.params.reviewId);
        const agent=db.agentReviews?.get(req.params.reviewId);
        if(candidate&&agent?.unified_review_id===candidate.id){
            if(req.get('sec-fetch-site')==='cross-site'){res.status(403).json({error:'Same-origin requests only',code:'cross_site'});return null;}
            const auth=await authorizeDecision(req);
            if(!auth.ok||auth.actor.authority==='document_executor_credential'){res.status(403).json({error:'Operator required',code:'operator_required'});return null;}
            return {review:candidate,agent,actor:auth.actor};
        }
        const review=ownReview(req,res);if(!review||!requireDraft(review,res))return null;
        return {review,agent:null,actor:{id:req.user.id,authority:'reviewer'}};
    }
    router.post('/reviews/:reviewId/comments', async (req, res) => {
        const access=await commentReviewAccess(req,res);if(!access)return;
        const {review,agent,actor}=access;
        if(agent&&!req.body?.parent_id)return res.status(400).json({error:'Reply to an existing finding using parent_id',code:'parent_required'});
        const body = req.body || {};
        const clientId = body.client_id === undefined ? null : text(String(body.client_id), LIMITS.clientId);
        if (body.client_id !== undefined && !clientId) return res.status(400).json({ error: 'client_id must be a short string' });
        if (clientId) {
            const existing = store().findCommentByClientId(review.id, clientId);
            if (existing) return res.status(200).json({ comment: { ...fmt.publicComment(existing), anchor: { state: 'intact', current_start_line: existing.start_line } }, duplicate: true });
        }
        const commentBody = text(body.body, LIMITS.body);
        if (!commentBody) return res.status(400).json({ error: `body must be 1-${LIMITS.body} characters` });
        const kind = body.kind === 'document' ? 'document' : body.kind === 'passage' ? 'passage' : fmt.MEDIA_COMMENT_KINDS.has(body.kind) ? body.kind : null;
        if (!kind) return res.status(400).json({ error: "kind must be 'passage', 'document', 'region', 'point', 'time', 'page' or 'screen'" });

        const row = { review_id: review.id, author: actor, provenance: agent ? {agent_review_id:agent.id,task_id:agent.task_id,parent_finding_id:store().getComment(body.parent_id)?.provenance?.finding_id} : null, client_id: clientId, kind, body: commentBody, start_line: null, end_line: null, block_hash: null, quote: null, selection: null, anchor: null, target_label: null, parent_id: null };
        if (body.parent_id !== undefined && body.parent_id !== null) {
            const parentId = text(String(body.parent_id), 120);
            const parent = parentId ? store().getComment(parentId) : null;
            if (!parent || parent.review_id !== review.id) return res.status(404).json({ error: 'parent_id does not name a comment of this review', code: 'parent_not_found' });
            if (parent.parent_id) return res.status(400).json({ error: 'Replies are one level deep; reply to the root comment', code: 'invalid_parent' });
            row.parent_id = parent.id;
        }
        if (fmt.MEDIA_COMMENT_KINDS.has(kind)) {
            const pinned = store().getRevision(review.revision_id);
            const verified = fmt.verifyMediaAnchor(kind, body.anchor, revisionAssets(pinned));
            if (!verified.ok) return res.status(verified.code === 'anchor_mismatch' ? 409 : 400).json({ error: verified.error, code: verified.code });
            row.anchor = verified.anchor;
            row.target_label = verified.target_label;
        }
        if (kind === 'passage') {
            const pinned = store().getRevision(review.revision_id);
            const verified = fmt.verifyPassageAnchor(body, pinned?.content);
            if (!verified.ok) return res.status(409).json({ error: verified.error, code: verified.code });
            Object.assign(row, { start_line: verified.start_line, end_line: verified.end_line, block_hash: verified.block_hash, quote: verified.quote });
            if (body.selection !== undefined && body.selection !== null && body.selection !== '') {
                const selection = text(String(body.selection), LIMITS.selection);
                if (!selection) return res.status(400).json({ error: `selection must be at most ${LIMITS.selection} characters` });
                row.selection = selection;
            }
        }
        try {
            const comment = store().insertComment(row);
            store().updateReview(review.id, {});
            const anchor = fmt.MEDIA_COMMENT_KINDS.has(kind)
                ? { state: 'intact', current_asset_key: row.anchor.asset_key }
                : { state: kind === 'passage' ? 'intact' : 'document', current_start_line: comment.start_line };
            return res.status(201).json({ comment: { ...fmt.publicComment(comment), anchor } });
        } catch (err) {
            if (clientId && /UNIQUE/i.test(err.message || '')) {
                const existing = store().findCommentByClientId(review.id, clientId);
                if (existing) return res.status(200).json({ comment: { ...fmt.publicComment(existing), anchor: { state: existing.kind === 'passage' ? 'intact' : 'document', current_start_line: existing.start_line } }, duplicate: true });
            }
            console.error('[Documents] add comment failed:', err);
            return res.status(500).json({ error: 'Failed to save comment' });
        }
    });

    router.patch('/reviews/:reviewId/comments/:commentId', async (req, res) => {
        const access=await commentReviewAccess(req,res);if(!access)return;
        const {review,agent}=access;
        if(agent&&req.body?.body!==undefined)return res.status(403).json({error:'Executor findings are immutable; reply or resolve instead',code:'immutable_finding'});
        const comment = store().getComment(req.params.commentId);
        if (!comment || comment.review_id !== review.id) return res.status(404).json({ error: 'Comment not found' });
        const patch = {};
        if (req.body?.body !== undefined) {
            const commentBody = text(req.body.body, LIMITS.body);
            if (!commentBody) return res.status(400).json({ error: `body must be 1-${LIMITS.body} characters` });
            patch.body = commentBody;
        }
        if (req.body?.resolved !== undefined) {
            if (typeof req.body.resolved !== 'boolean') return res.status(400).json({ error: 'resolved must be true or false' });
            patch.resolved_at = req.body.resolved ? new Date().toISOString() : null;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update: send body and/or resolved' });
        const updated = store().updateComment(comment.id, patch);
        store().updateReview(review.id, {});
        return res.json({ comment: fmt.publicComment(updated) });
    });

    router.delete('/reviews/:reviewId/comments/:commentId', (req, res) => {
        const review = ownReview(req, res);
        if (!review || !requireDraft(review, res)) return;
        const comment = store().getComment(req.params.commentId);
        if (!comment || comment.review_id !== review.id) return res.status(404).json({ error: 'Comment not found' });
        store().deleteComment(comment.id);
        store().updateReview(review.id, {});
        return res.json({ success: true, deleted: comment.id });
    });

    // ── Decision answers (task 50aa5747) ──────────────────────────────────
    // Robert answers the document's structured decision_items one at a time on
    // his draft round; Finish review sends them as feedback.decision_answers.
    // An answer records no revision and no editorial decision, and never
    // approves, publishes or sends the document.

    /** Robert's own operator proof on this request; the shared local_user and the executor credential are refused. */
    async function operatorActor(req, res, what) {
        if (req.get('sec-fetch-site') === 'cross-site') { res.status(403).json({ error: 'Same-origin requests only', code: 'cross_site' }); return null; }
        const authority = await authorizeDecision(req);
        if (!authority.ok) {
            res.status(authority.status).json({ error: authority.error, code: authority.code, ...(authority.reason ? { reason: authority.reason } : {}) });
            return null;
        }
        if (!DELEGATING_AUTHORITIES.has(authority.actor.authority)) {
            res.status(403).json({ error: `${what} is Robert's own act: it needs his verified session or operator credential, not the document executor credential`, code: 'operator_required' });
            return null;
        }
        // `via`/`device` say whether a finish must also be confirmed on the Mac; callers store only id and authority.
        return { ...authority.actor, via: authority.via, device: authority.device };
    }

    function staleAnswers(res, { answeredRevisionId, review, currentRevisionId, nothing }) {
        return res.status(409).json({
            error: `These decision answers are for revision ${answeredRevisionId}, but the current revision is ${currentRevisionId || 'unknown'}; ${nothing}. Answer the decisions on the current version`,
            code: 'stale_revision', answered_revision_id: answeredRevisionId, review_revision_id: review.revision_id, current_revision_id: currentRevisionId || null,
        });
    }

    /**
     * Applies `change` to the draft's answers as they stand at write time, in one transaction that re-reads the round, so
     * two decisions saved at once each keep their own answer. `check` (optional) re-validates the document inside the same
     * transaction and returns a refusal, or null to write.
     */
    function writeAnswers(reviewId, change, check = null) {
        return store().transaction(() => {
            const again = store().getReview(reviewId);
            if (!again || again.status !== 'draft') return { closed: again };
            const refusal = check ? check() : null;
            if (refusal) return { refusal };
            const current = decisionItems.storedAnswers(again);
            const next = change(current);
            if (next === current) return { review: again };
            return { review: store().updateReview(reviewId, { decision_answers: next.length ? next : null }) };
        });
    }

    router.put('/reviews/:reviewId/decision-answers/:decisionId', async (req, res) => {
        try {
            const review = ownReview(req, res);
            if (!review || !requireDraft(review, res)) return;
            const actor = await operatorActor(req, res, 'Answering a document decision');
            if (!actor) return;
            const body = isPlainObject(req.body) ? req.body : {};
            const revisionId = text(body.revision_id, 120);
            if (!revisionId) return res.status(400).json({ error: 'revision_id is required: an answer is pinned to the exact revision you read', code: 'revision_required' });
            if (body.content_hash !== undefined && (typeof body.content_hash !== 'string' || !HASH_PATTERN.test(body.content_hash))) {
                return res.status(400).json({ error: 'content_hash must be a lowercase hex SHA-256', code: 'invalid_answer' });
            }
            const doc = store().getDocument(review.document_id);
            // Like a decision, an answer rests on bytes Nexus can confirm now: a file changed on disk is captured first and makes this stale.
            const captured = await captureRevision(doc);
            if (captured.fileState !== 'ok') {
                return res.status(409).json({ error: `The document file cannot be confirmed right now (${captured.fileState}); nothing was saved`, code: 'file_unavailable', file_state: captured.fileState });
            }
            await reconcileReplacement(doc);
            const fresh = store().getDocument(doc.id);
            if (revisionId !== review.revision_id || review.revision_id !== fresh.current_revision_id) {
                // Name whichever revision is not current: the one the answer cites, or the one this draft round is pinned to.
                const answeredRevisionId = revisionId === fresh.current_revision_id ? review.revision_id : revisionId;
                return staleAnswers(res, { answeredRevisionId, review, currentRevisionId: fresh.current_revision_id, nothing: 'nothing was saved' });
            }
            const revision = store().getRevisionMeta(review.revision_id);
            if (body.content_hash !== undefined && body.content_hash !== revision?.content_hash) {
                return res.status(409).json({ error: 'content_hash does not match the revision under review; nothing was saved', code: 'content_mismatch' });
            }
            const gate = reviewability(fresh, revision);
            if (!gate.ok) return notReviewable(res, gate);
            const decisions = decisionItems.decisionItemsFor(fresh, review.revision_id);
            if (!decisions) return res.status(404).json({ error: 'This document declares no decisions to answer', code: 'no_decisions' });
            if (!decisions.answerable) {
                return res.status(409).json({
                    error: decisions.revision_id
                        ? `These decisions were listed for revision ${decisions.revision_id}, not the revision under review; nothing was saved`
                        : 'These decisions were recorded without the revision they belong to, so they cannot be answered here; ask Praxis to deliver the document again or answer in chat. Nothing was saved',
                    code: 'decisions_not_current', decisions_revision_id: decisions.revision_id,
                });
            }
            const item = decisions.items.find(i => i.id === req.params.decisionId);
            if (!item) return res.status(404).json({ error: 'This document has no decision with that id', code: 'unknown_decision', decision_ids: decisions.items.map(i => i.id) });
            const normalized = decisionItems.normalizeAnswer(item, body.answer);
            if (!normalized.ok) return res.status(400).json({ error: normalized.error, code: normalized.code, ...(normalized.options ? { options: normalized.options } : {}) });

            let entry = null;
            let replayed = null;
            // The definition Robert answered: finish sends the answer only while the decision still has exactly this definition.
            const definition = decisionItems.definitionHash(item);
            const written = writeAnswers(review.id, current => {
                const prior = current.find(a => a.decision_id === item.id);
                // Saving the same answer to the same definition again is a replay: the first save stands.
                if (prior && prior.answer === normalized.answer && prior.definition_hash === definition) { replayed = prior; return current; }
                entry = { decision_id: item.id, answer: normalized.answer, definition_hash: definition, answered_at: new Date().toISOString(), answered_by: actor.id, authority: actor.authority };
                return [...current.filter(a => a.decision_id !== item.id), entry];
            }, () => {
                // A registration that landed during the awaits above wins over the answer.
                const now = store().getDocument(doc.id);
                if (now.current_revision_id !== review.revision_id) return { stale: now.current_revision_id };
                const decisionsNow = decisionItems.decisionItemsFor(now, review.revision_id);
                const itemNow = decisionsNow?.answerable ? decisionsNow.items.find(i => i.id === item.id) : null;
                return itemNow && JSON.stringify(itemNow) === JSON.stringify(item) ? null : { changed: true };
            });
            if (written.closed !== undefined) { requireDraft(written.closed || review, res); return; }
            if (written.refusal?.stale !== undefined) {
                return staleAnswers(res, { answeredRevisionId: review.revision_id, review, currentRevisionId: written.refusal.stale, nothing: 'nothing was saved' });
            }
            if (written.refusal) return res.status(409).json({ error: 'The decisions for this revision changed while the answer was being saved; reload and answer again. Nothing was saved', code: 'decisions_changed' });
            const answers = decisionItems.storedAnswers(written.review);
            return replayed ? res.json({ answer: replayed, decision_answers: answers, duplicate: true }) : res.json({ answer: entry, decision_answers: answers });
        } catch (err) {
            console.error('[Documents] save decision answer failed:', err);
            return res.status(500).json({ error: 'Failed to save the answer' });
        }
    });

    // Clearing works on any draft round, including one pinned to an earlier revision, so its comments can still be sent.
    router.delete('/reviews/:reviewId/decision-answers/:decisionId', async (req, res) => {
        try {
            const review = ownReview(req, res);
            if (!review || !requireDraft(review, res)) return;
            const actor = await operatorActor(req, res, 'Clearing a document decision answer');
            if (!actor) return;
            let cleared = false;
            const written = writeAnswers(review.id, current => {
                if (!current.some(a => a.decision_id === req.params.decisionId)) return current;
                cleared = true;
                return current.filter(a => a.decision_id !== req.params.decisionId);
            });
            if (written.closed !== undefined) { requireDraft(written.closed || review, res); return; }
            return res.json({ cleared, decision_answers: decisionItems.storedAnswers(written.review) });
        } catch (err) {
            console.error('[Documents] clear decision answer failed:', err);
            return res.status(500).json({ error: 'Failed to clear the answer' });
        }
    });

    /**
     * What a direct approval of this review's revision has to pass, checked
     * before the Mac dialog so a refusal asks Robert nothing and keeps his
     * draft. Returns the direction selection the approval carries, or null
     * after sending the refusal.
     */
    async function checkApprovalAtFinish(res, doc, review) {
        const refuse = (status, body) => { res.status(status).json({ ...body, nothing_recorded: true }); return null; };
        if (!doc.requires_review) {
            return refuse(409, { error: 'This is a reference document; it does not take review decisions. Nothing was approved and your draft is kept', code: 'review_not_required' });
        }
        // A direction-selection design package: approving it is choosing a direction (contract §3.3). The finish has no
        // direction of its own, so it carries the one Robert already approved on this revision or asks him to choose.
        const manifest = store().getRevision(review.revision_id)?.manifest ?? null;
        const directions = Array.isArray(manifest?.directions) ? manifest.directions.map(d => d.id) : [];
        let selection = null;
        if (directions.length >= 2) {
            const latest = store().latestDecision(doc.id);
            const chosen = latest?.decision === 'approve' && latest.revision_id === review.revision_id ? latest.selection : null;
            if (typeof chosen?.direction !== 'string' || !directions.includes(chosen.direction)) {
                return refuse(400, { error: 'Approving this design package means choosing a direction: choose one with Approve document, then finish. Your draft is kept', code: 'selection_required', directions });
            }
            selection = chosen;
        }
        const captured = await captureRevision(doc);
        if (captured.fileState !== 'ok') {
            return refuse(409, { error: `The document file cannot be confirmed right now (${captured.fileState}); nothing was approved and your draft is kept`, code: 'file_unavailable', file_state: captured.fileState });
        }
        if (captured.revision.id !== review.revision_id) {
            return refuse(409, { error: 'The document changed after the revision you reviewed; nothing was approved and your draft is kept. Reopen it and decide on the current revision', code: 'stale_revision', revision_id: review.revision_id, current_revision: revisionMeta(captured.revision) });
        }
        await reconcileReplacement(doc);
        const gate = reviewability(store().getDocument(doc.id), captured.revision);
        if (!gate.ok) { notReviewable(res, gate); return null; }
        return { selection };
    }

    // ── Finish and delivery ───────────────────────────────────────────────
    router.post('/reviews/:reviewId/finish', async (req, res) => {
        try {
            const review = ownReview(req, res);
            if (!review) return;
            const doc = store().getDocument(review.document_id);
            const existing = store().getSubmissionForReview(review.id);
            if (review.status === 'submitted' && existing) {
                return res.status(200).json({ review: reviewView(review, currentFor(doc)), submission: submissionView(existing), duplicate: true });
            }
            // A round that replacement work closed cannot be finished from a stale tab (task 6b46dcc8).
            if (review.status === 'superseded') { requireDraft(review, res); return; }
            const body = req.body || {};
            let summary = review.summary || '';
            if (body.summary !== undefined) {
                if (typeof body.summary !== 'string' || body.summary.length > LIMITS.summary) {
                    return res.status(400).json({ error: `summary must be a string of at most ${LIMITS.summary} characters` });
                }
                summary = body.summary;
            }
            // Robert's approval with a note (task 282c64fa): finishing with
            // approve_after_changes approves the exact revision he reviewed, now,
            // as his own decision, with his summary and comments as its note. It
            // opens no revision work. It needs his own operator proof on this very
            // request (verified Access session or operator credential) and, through
            // the local session, his answer to the Mac dialog: the shared local_user
            // every local process carries is not Robert, and the document executor
            // credential cannot approve for him. Without the flag a finish is
            // feedback, as before.
            if (body.approve_after_changes !== undefined && typeof body.approve_after_changes !== 'boolean') {
                return res.status(400).json({ error: 'approve_after_changes must be true or false', code: 'invalid_grant' });
            }
            const approving = body.approve_after_changes === true;
            // Decision answers (task 50aa5747) go out only with Robert's own proof, like the approval, and only for the current revision.
            const storedAnswers = decisionItems.storedAnswers(review);
            let submittedAuthority = null;
            let finishActor = null;
            if (approving || storedAnswers.length) {
                const actor = await operatorActor(req, res, approving ? 'Approving this document' : 'Sending decision answers');
                if (!actor) return;
                submittedAuthority = actor.authority;
                finishActor = actor;
            }
            let approvalSelection = null;
            if (approving) {
                const approvable = await checkApprovalAtFinish(res, doc, review);
                if (!approvable) return;
                approvalSelection = approvable.selection;
            }
            let decisionAnswers = [];
            let answeredItems = [];
            if (storedAnswers.length) {
                const captured = await captureRevision(doc);
                if (captured.fileState !== 'ok') {
                    return res.status(409).json({ error: `The document file cannot be confirmed right now (${captured.fileState}); nothing was sent and your draft keeps its answers`, code: 'file_unavailable', file_state: captured.fileState });
                }
                await reconcileReplacement(doc);
                const fresh = store().getDocument(doc.id);
                if (review.revision_id !== fresh.current_revision_id) {
                    return staleAnswers(res, { answeredRevisionId: review.revision_id, review, currentRevisionId: fresh.current_revision_id, nothing: 'nothing was sent and your draft keeps its answers and comments. Clear the answers to send the comments alone' });
                }
                const gate = reviewability(fresh, store().getRevisionMeta(review.revision_id));
                if (!gate.ok) return notReviewable(res, gate);
                const decisions = decisionItems.decisionItemsFor(fresh, review.revision_id);
                const resolved = decisionItems.resolveAnswers(storedAnswers, decisions);
                if (!resolved.ok) {
                    return res.status(409).json({ error: 'The decisions listed for this revision changed after you answered; review your answers and send again. Nothing was sent', code: 'decisions_changed', decision_id: resolved.decision_id ?? null, stale_answers: resolved.unsendable });
                }
                decisionAnswers = resolved.answers.map(({ decision_id, answer }) => ({ decision_id, answer }));
                answeredItems = decisions.items.filter(item => decisionAnswers.some(a => a.decision_id === item.id));
            }
            // The approval and decision answers through the local session also need
            // Robert's answer to a native dialog naming them (Option A, task 5e513530),
            // bound to this review's exact summary, comments and answers.
            const finishIdentity = commentRows => ({
                kind: 'review_finish', document_id: doc.id, review_id: review.id, revision_id: review.revision_id,
                approve_after_changes: approving, answers: decisionAnswers,
                summary_sha256: confirmation.sha256(summary), comments_sha256: confirmation.sha256(JSON.stringify(commentRows)),
            });
            let asked = { ok: true, required: false, ref: null, consume: () => true };
            if (finishActor) {
                const shownComments = store().listComments(review.id);
                asked = await confirmations.confirm({ res, auth: finishActor, action: confirmation.reviewFinishAction({
                    identity: finishIdentity(shownComments), title: doc.title || doc.id, revisionId: review.revision_id,
                    version: store().revisionDraft(review.revision_id)?.version, approving, summary, commentCount: shownComments.length,
                    answers: decisionAnswers.map(({ decision_id, answer }) => {
                        const item = answeredItems.find(i => i.id === decision_id);
                        return { question: item?.question || decision_id, label: item?.options?.find(o => o.id === answer)?.label || answer };
                    }),
                }) });
                if (!asked.ok) {
                    return res.status(asked.status).json({ error: asked.error, code: asked.code, nothing_recorded: true, ...(asked.confirmation_ref ? { confirmation_ref: asked.confirmation_ref } : {}) });
                }
                if (asked.required && (storedAnswers.length || approving)) {
                    // The wait can be long: capture the file again so a changed revision is caught below.
                    const again = await captureRevision(doc);
                    if (again.fileState !== 'ok') {
                        return res.status(409).json({ error: `The document file cannot be confirmed right now (${again.fileState}); nothing was sent and your draft keeps its ${storedAnswers.length ? 'answers' : 'comments'}`, code: 'file_unavailable', file_state: again.fileState });
                    }
                }
            }
            const revision = store().getRevisionMeta(review.revision_id);
            const source = await sourceSummary(doc);
            const submittedAt = new Date().toISOString();
            const submissionId = randomUUID();
            const finished = { ...review, summary, submitted_authority: submittedAuthority };
            // Built inside the finish transaction, after the approval is inserted, so the stored package carries that decision.
            const composeSubmission = (comments, approval) => {
                const decisions = store().listDecisions(doc.id).filter(d => d.revision_id === review.revision_id);
                const latestDecision = store().latestDecision(doc.id);
                const selectedDirection = latestDecision?.decision === 'approve' && latestDecision.revision_id === review.revision_id ? latestDecision.selection?.direction ?? null : null;
                // Decision notes are stored separately from review comments. Snapshot all
                // change requests for this exact revision so neither input channel is lost.
                const changeRequests = decisions.filter(decision => decision.decision === 'request_changes' && decision.note?.trim());
                const payload = fmt.buildSubmissionPayload({ submissionId, review: finished, comments, document: doc, revision, source, submittedAt, selectedDirection, changeRequests, decisionAnswers, decisionItems: answeredItems, approval });
                payload.decisions = decisions;
                payload.agent_reviews = db.agentReviews?.list(doc.id).filter(r => r.base_revision_id === review.revision_id) || [];
                return { payload, messageText: fmt.formatSubmissionMessage(payload) };
            };
            let submission;
            try {
                submission = store().transaction(() => {
                    // Re-read inside the transaction: an acceptance that superseded this draft meanwhile wins over the finish.
                    const again = store().getReview(review.id);
                    if (!again || again.status !== 'draft') return null;
                    // Answers changed in another tab after this finish read them: send nothing rather than a stale set.
                    if (JSON.stringify(decisionItems.storedAnswers(again)) !== JSON.stringify(storedAnswers)) return { answersChanged: true };
                    // Single use, and only for the review content Robert confirmed (a comment added meanwhile refuses).
                    const commentsNow = store().listComments(review.id);
                    if (!asked.consume(finishIdentity(commentsNow))) return { unconfirmed: true };
                    if (decisionAnswers.length) {
                        // A registration during the awaits above (a new revision, or new items on this one) wins over the answers.
                        const now = store().getDocument(doc.id);
                        if (now.current_revision_id !== review.revision_id) return { staleRevision: now.current_revision_id };
                        const decisionsNow = decisionItems.decisionItemsFor(now, review.revision_id);
                        const resolvedNow = decisionItems.resolveAnswers(storedAnswers, decisionsNow);
                        const itemsNow = resolvedNow.ok ? decisionsNow.items.filter(item => decisionAnswers.some(a => a.decision_id === item.id)) : null;
                        if (!resolvedNow.ok || JSON.stringify(itemsNow) !== JSON.stringify(answeredItems)) return { decisionsChanged: true, staleAnswers: resolvedNow.unsendable ?? [] };
                    }
                    let approval = null;
                    if (approving) {
                        // Re-checked inside the transaction: a new revision, an acceptance or a failure report landing meanwhile wins.
                        const now = store().getDocument(doc.id);
                        if (!now.requires_review) return { noReviewNeeded: true };
                        if (now.current_revision_id !== review.revision_id) return { staleApproval: now.current_revision_id };
                        const gateNow = reviewability(now, revision);
                        if (!gateNow.ok) return { blockedBy: gateNow };
                        if (approvalSelection) {
                            // The direction this approval carries must still be the one he has approved on this revision.
                            const latestNow = store().latestDecision(doc.id);
                            if (latestNow?.decision !== 'approve' || latestNow.revision_id !== review.revision_id || latestNow.selection?.direction !== approvalSelection.direction) return { directionChanged: true };
                        }
                        // The key is unique per document, so one review can never hold two approvals.
                        approval = store().insertDecision({
                            document_id: doc.id, revision_id: revision.id, content_hash: revision.content_hash, decision: 'approve',
                            actor_id: finishActor.id, authority: finishActor.authority, note: fmt.composeApprovalNote(summary, commentsNow),
                            client_decision_id: `${FINISH_APPROVAL_KEY}${review.id}`, intended_action: now.intended_action, selection: approvalSelection,
                            recorded_by: 'operator',
                            provenance: {
                                source: {
                                    kind: 'review_finish', review_id: review.id, submission_id: submissionId, revision_id: revision.id,
                                    revision_hash: revision.content_hash, reviewer_id: review.reviewer_id, submitted_at: submittedAt, summary,
                                    comments: commentsNow.map(comment => ({
                                        id: comment.id, kind: comment.kind, parent_id: comment.parent_id ?? null, start_line: comment.start_line,
                                        end_line: comment.end_line, quote: comment.quote, body: comment.body,
                                    })),
                                },
                            },
                        });
                    }
                    const { payload, messageText } = composeSubmission(commentsNow, approval);
                    store().updateReview(review.id, { status: 'submitted', summary, submitted_at: submittedAt, submitted_authority: submittedAuthority, approval_decision_id: approval?.id ?? null });
                    return store().insertSubmission({ id: submissionId, review_id: review.id, document_id: doc.id, revision_id: review.revision_id, payload, message_text: messageText });
                });
            } catch (err) {
                const raced = store().getSubmissionForReview(review.id);
                if (!raced) throw err;
                return res.status(200).json({ review: reviewView(store().getReview(review.id), currentFor(doc)), submission: submissionView(raced), duplicate: true });
            }
            if (submission?.answersChanged) {
                return res.status(409).json({ error: 'Your decision answers changed in another tab while this review was being sent; reload and send again. Nothing was sent', code: 'answers_changed' });
            }
            if (submission?.unconfirmed) {
                const [status, code, error] = confirmation.REFUSALS.mismatch;
                return res.status(status).json({ error, code, nothing_recorded: true });
            }
            if (submission?.staleRevision !== undefined) {
                return staleAnswers(res, { answeredRevisionId: review.revision_id, review, currentRevisionId: submission.staleRevision, nothing: 'nothing was sent and your draft keeps its answers and comments. Clear the answers to send the comments alone' });
            }
            if (submission?.decisionsChanged) {
                return res.status(409).json({ error: 'The decisions listed for this revision changed after you answered; review your answers and send again. Nothing was sent', code: 'decisions_changed', stale_answers: submission.staleAnswers });
            }
            if (submission?.staleApproval !== undefined) {
                return res.status(409).json({ error: 'The document changed after the revision you reviewed; nothing was approved and your draft is kept. Reopen it and decide on the current revision', code: 'stale_revision', revision_id: review.revision_id, current_revision: revisionMeta(store().getRevisionMeta(submission.staleApproval)), nothing_recorded: true });
            }
            if (submission?.blockedBy) return notReviewable(res, submission.blockedBy);
            if (submission?.noReviewNeeded) {
                return res.status(409).json({ error: 'This is a reference document; it does not take review decisions. Nothing was approved and your draft is kept', code: 'review_not_required', nothing_recorded: true });
            }
            if (submission?.directionChanged) {
                return res.status(409).json({ error: 'Your decision on this design package changed while this review was being finished; nothing was approved and your draft is kept', code: 'decisions_changed', nothing_recorded: true });
            }
            if (!submission) {
                const now = store().getReview(review.id);
                const racedSubmission = store().getSubmissionForReview(review.id);
                if (now.status === 'submitted' && racedSubmission) return res.status(200).json({ review: reviewView(now, currentFor(doc)), submission: submissionView(racedSubmission), duplicate: true });
                requireDraft(now, res);
                return;
            }
            if (approving) console.log(`[Documents] review ${review.id} finished with approval of revision ${review.revision_id} recorded (authority=${submittedAuthority}, submission=${submission.id}${asked.required ? `, operator confirmation ref=${asked.ref}` : ''})`);
            else if (asked.required) console.log(`[Documents] review ${review.id} finished with decision answers after operator confirmation ref=${asked.ref} (submission=${submission.id})`);
            if (delivery && typeof delivery.deliver === 'function') {
                delivery.deliver(submission.id).catch(err => console.error(`[Documents] delivery of ${submission.id} failed:`, err?.message || err));
            }
            return res.status(202).json({ review: reviewView(store().getReview(review.id), currentFor(doc)), submission: submissionView(submission) });
        } catch (err) {
            console.error('[Documents] finish failed:', err);
            return res.status(500).json({ error: 'Failed to finish review' });
        }
    });

    router.get('/reviews/:reviewId/submission', (req, res) => {
        const review = ownReview(req, res);
        if (!review) return;
        const submission = store().getSubmissionForReview(review.id);
        if (!submission) return res.status(404).json({ error: 'Review has not been finished yet' });
        return res.json({ submission: submissionView(submission, { full: req.query.full === '1' }) });
    });

    router.post('/reviews/:reviewId/submission/retry', async (req, res) => {
        try {
            const review = ownReview(req, res);
            if (!review) return;
            const submission = store().getSubmissionForReview(review.id);
            if (!submission) return res.status(404).json({ error: 'Review has not been finished yet' });
            if (submission.delivery_status === 'delivered') return res.json({ submission: submissionView(submission), retried: false });
            if (!delivery || typeof delivery.deliver !== 'function') return res.status(503).json({ error: 'Delivery is not available' });
            delivery.deliver(submission.id).catch(err => console.error(`[Documents] retry of ${submission.id} failed:`, err?.message || err));
            return res.status(202).json({ submission: submissionView(store().getSubmissionForReview(review.id)), retried: true });
        } catch (err) {
            console.error('[Documents] retry failed:', err);
            return res.status(500).json({ error: 'Failed to retry delivery' });
        }
    });

    return router;
}

module.exports = createDocumentsRouter;
