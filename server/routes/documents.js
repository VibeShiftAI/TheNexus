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
 *   GET    /api/documents/counts?task_id=&project_id=&kind=&q=   per-review-status totals for the same filters
 *   GET    /api/documents/:id                              document + current revision + content + the caller's review
 *   GET    /api/documents/:id/raw?revision=&download=1     Markdown source (current or pinned revision)
 *   GET    /api/documents/:id/revisions/:revisionId        a pinned snapshot
 *   GET    /api/documents/:id/history                      revisions, decisions, registration receipts and review rounds
 *   POST   /api/documents/:id/decisions                    { decision: approve|request_changes, revision_id, ... }
 *                                                          operator only, pinned to the exact current revision
 *   GET    /api/documents/:id/decisions/:decisionId        a decision and whether it is still in force (consumer check)
 *   POST   /api/documents/:id/reviews                      open (or return) the caller's draft, pinned to the current revision
 *   GET    /api/documents/reviews/:reviewId                review + comments (+ anchor state against the current revision)
 *   PATCH  /api/documents/reviews/:reviewId                { summary } (draft only)
 *   POST   /api/documents/reviews/:reviewId/comments       add a passage or whole-document comment (draft only; client_id dedupes)
 *   PATCH  /api/documents/reviews/:reviewId/comments/:commentId   { body }
 *   DELETE /api/documents/reviews/:reviewId/comments/:commentId
 *   POST   /api/documents/reviews/:reviewId/finish         { summary? } → one durable submission per review, delivery queued
 *   GET    /api/documents/reviews/:reviewId/submission     delivery state + receipt
 *   POST   /api/documents/reviews/:reviewId/submission/retry
 *
 * Mounted behind the server's `authenticate` middleware; every review belongs
 * to the authenticated reviewer. The router never touches task status.
 *
 * Comments, Finish review and task QA never approve anything and nothing here
 * sends or publishes: an approval is a recorded editorial decision on one
 * revision, which a separate sender must verify before acting
 * (docs/contracts/document-review-deliverables.md).
 */
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { listProjectRoots, resolveDocumentPath, readDocumentFile, sha256 } = require('../services/document-registry');
const fmt = require('../services/document-review-format');
const { createDocumentDecisionAuthority } = require('../services/document-decision-authority');
const { REVIEW_STATUSES } = require('../../db/document-reviews');

const KINDS = new Set(['document', 'report', 'spec', 'plan', 'research', 'walkthrough', 'other']);
const LIMITS = { title: 300, body: 20000, summary: 20000, selection: 2000, metadataJson: 8000, clientId: 120, purpose: 500, key: 300, sourceId: 200, query: 200 };
/** What the deliverable is for once approved. Approval records the decision; it never performs the action. */
const INTENDED_ACTIONS = new Set(['none', 'implement', 'send', 'publish']);
const DELIVERABLE_FIELDS = new Set(['key', 'purpose', 'requires_review', 'intended_action', 'source']);
const SOURCE_TYPES = new Set(['task', 'chat']);
const SOURCE_ID_FIELDS = ['conversation_id', 'message_id', 'execution_id'];
const DECISIONS = new Set(['approve', 'request_changes']);
const STATUS_FILTERS = new Set(['all', ...REVIEW_STATUSES]);
const PAGE = { default: 100, max: 200 };
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

function validMetadata(value) {
    return isPlainObject(value) && JSON.stringify(value).length <= LIMITS.metadataJson;
}

/**
 * Validate a declared deliverable registration body. Strict on purpose: an
 * unknown or misspelled field is refused rather than silently registering a
 * reference document in place of a review request.
 */
function parseDeclaration(body) {
    const declared = body.deliverable;
    if (!isPlainObject(declared)) return badRequest('deliverable must be an object');
    const unknown = Object.keys(declared).filter(key => !DELIVERABLE_FIELDS.has(key));
    if (unknown.length) return badRequest(`Unknown deliverable field(s): ${unknown.join(', ')}`);
    if (typeof declared.requires_review !== 'boolean') return badRequest('deliverable.requires_review must be true or false');
    const purpose = text(declared.purpose, LIMITS.purpose);
    if (!purpose) return badRequest(`deliverable.purpose must be 1-${LIMITS.purpose} characters`);
    if (!INTENDED_ACTIONS.has(declared.intended_action)) {
        return badRequest(`deliverable.intended_action must be one of ${[...INTENDED_ACTIONS].join(', ')}`);
    }
    if (declared.intended_action !== 'none' && !declared.requires_review) {
        return badRequest('A deliverable intended for an action must require review: approval comes before the action');
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
        if (!SOURCE_TYPES.has(declared.source.type)) return badRequest('deliverable.source.type must be "task" or "chat"');
        source = { type: declared.source.type };
        for (const field of SOURCE_ID_FIELDS) {
            if (declared.source[field] === undefined) continue;
            const value = text(declared.source[field], LIMITS.sourceId);
            if (!value || CONTROL_CHARS.test(value)) return badRequest(`deliverable.source.${field} must be 1-${LIMITS.sourceId} printable characters`);
            source[field] = value;
        }
        if (source.type === 'chat' && !source.conversation_id) return badRequest('A chat deliverable needs deliverable.source.conversation_id');
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
    if (!taskId && source?.type !== 'chat') return badRequest('task_id is required unless the deliverable comes from a chat (deliverable.source.type "chat")');
    let kind = null;
    if (body.kind !== undefined) {
        kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        if (!KINDS.has(kind)) return badRequest(`kind must be one of ${[...KINDS].join(', ')}`);
    }
    if (body.metadata !== undefined && !validMetadata(body.metadata)) return badRequest('metadata must be a small JSON object');
    let expectedHash = null;
    if (body.expected_content_hash !== undefined) {
        if (typeof body.expected_content_hash !== 'string' || !HASH_PATTERN.test(body.expected_content_hash)) {
            return badRequest('expected_content_hash must be a lowercase hex SHA-256');
        }
        expectedHash = body.expected_content_hash;
    }
    return {
        ok: true,
        value: {
            key, purpose, title, projectId, taskId, kind, source, expectedHash,
            requiresReview: declared.requires_review, intendedAction: declared.intended_action,
            metadata: body.metadata || null,
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
    for (const name of ['status', 'limit', 'offset', 'task_id', 'project_id', 'kind', 'q']) {
        const result = single(name);
        if (!result.ok) return result;
        read[name] = result.value;
    }
    const filters = {};
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

function createDocumentsRouter({ db, delivery, authorizeDecision = createDocumentDecisionAuthority() }) {
    const router = express.Router();
    const store = () => db?.documentReviews;

    router.use((req, res, next) => {
        if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
        if (!store()) return res.status(503).json({ error: 'Document review storage unavailable' });
        next();
    });

    // ── Shared helpers ────────────────────────────────────────────────────
    function revisionMeta(revision) {
        if (!revision) return null;
        const { content, ...meta } = revision;
        return meta;
    }

    /**
     * Find or record the revision for bytes just read. A declared deliverable
     * is identified by its exact file bytes, so a BOM or line-ending change is
     * a new revision that no earlier receipt or decision covers, and bytes the
     * normalized reviewer text cannot reproduce are kept for the raw route. A
     * legacy document keeps the line-normalized identity it always had.
     */
    function recordRevision(doc, read, mtime) {
        const exact = Boolean(doc.deliverable_key);
        const hash = exact ? read.exactHash : read.contentHash;
        const existing = store().findRevisionByHash(doc.id, hash);
        if (existing) return { revision: existing, created: false };
        return store().transaction(() => {
            const revision = store().insertRevision({
                document_id: doc.id, content_hash: hash, content: read.content,
                byte_length: exact ? read.exactByteLength : read.byteLength, line_count: read.lineCount, file_mtime: mtime,
            });
            if (exact && read.exactContent !== read.content) store().insertRevisionExact(revision.id, read.exactContent);
            return { revision, created: true };
        });
    }

    /** Re-check the boundary, read the file and record a new revision when the content changed. */
    async function captureRevision(doc) {
        const stored = doc.current_revision_id ? store().getRevision(doc.current_revision_id) : null;
        const roots = await listProjectRoots(db);
        const resolved = resolveDocumentPath(doc.path, roots);
        if (!resolved.ok) return { revision: stored, fileState: resolved.code, fileError: resolved.error };
        if (resolved.canonicalPath !== doc.path) return { revision: stored, fileState: 'path_changed', fileError: 'Registered path no longer resolves to the same file' };
        const read = readDocumentFile(resolved.canonicalPath);
        if (!read.ok) return { revision: stored, fileState: read.code, fileError: read.error };
        const { revision } = recordRevision(doc, read, resolved.mtime);
        if (doc.current_revision_id !== revision.id) store().setCurrentRevision(doc.id, revision.id);
        return { revision, fileState: 'ok', fileError: null };
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
        const comments = store().listComments(review.id).map(comment => ({
            ...fmt.publicComment(comment),
            anchor: fmt.anchorState(comment, currentRevision?.content, pinned?.content_hash, currentRevision?.content_hash),
        }));
        return {
            id: review.id, document_id: review.document_id, revision_id: review.revision_id, reviewer_id: review.reviewer_id,
            status: review.status, summary: review.summary || '', created_at: review.created_at, updated_at: review.updated_at,
            submitted_at: review.submitted_at || null,
            comments,
            pinned_revision: revisionMeta(pinned),
            document_changed: documentChanged,
            ...(documentChanged ? { pinned_content: pinned.content } : {}),
            submission: submissionView(store().getSubmissionForReview(review.id)),
        };
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
        if (review.status !== 'draft') { res.status(409).json({ error: 'Review is already finished; comments are frozen', code: 'review_submitted' }); return false; }
        return true;
    }

    /** A list row: the document, its derived review_status, current revision and the caller's own feedback round. */
    function listEntry(doc, userId) {
        const review = store().findLatestReview(doc.id, userId);
        const submission = review ? store().getSubmissionForReview(review.id) : null;
        return {
            ...doc,
            current_revision: revisionMeta(doc.current_revision_id ? store().getRevisionMeta(doc.current_revision_id) : null),
            review_url: fmt.reviewUrlFor(doc.id),
            review_path: fmt.reviewPathFor(doc.id),
            review_state: review ? {
                review_id: review.id, status: review.status, updated_at: review.updated_at,
                comment_count: store().listComments(review.id).length,
                delivery_status: submission ? submission.delivery_status : null,
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
            document_created: registration.document_created,
            revision_created: registration.revision_created,
            registered_by: registration.registered_by,
            registered_at: registration.created_at,
            review_status: store().getReviewStatus(registration.document_id),
            review_path: fmt.reviewPathFor(registration.document_id),
            review_url: fmt.reviewUrlFor(registration.document_id),
            raw_path: `/api/documents/${encodeURIComponent(registration.document_id)}/raw?revision=${encodeURIComponent(registration.revision_id)}`,
        };
    }

    function conflict(code, error) {
        return Object.assign(new Error(error), { status: 409, code });
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
                deliverable_key: key, root_project_id: resolved.root.projectId, path: resolved.canonicalPath,
            };
            let documentCreated = false;
            if (doc) {
                const taskId = doc.task_id || v.taskId;
                if (doc.path !== resolved.canonicalPath || taskId !== doc.task_id) {
                    const occupant = store().findDocumentByPath(resolved.canonicalPath, taskId);
                    if (occupant && occupant.id !== doc.id) throw conflict('identity_conflict', 'Another registered document already holds this file for this task');
                }
                doc = store().updateDocument(doc.id, {
                    ...declared,
                    task_id: taskId,
                    project_id: taskId === v.taskId ? v.projectId : doc.project_id,
                    ...(v.kind ? { kind: v.kind } : {}),
                    ...(v.metadata ? { metadata: { ...(doc.metadata || {}), ...v.metadata } } : {}),
                });
            } else {
                doc = store().insertDocument({
                    ...declared, project_id: v.projectId, task_id: v.taskId, kind: v.kind || 'document', metadata: v.metadata || {}, registered_by: actorId,
                });
                documentCreated = true;
            }
            const { revision, created: revisionCreated } = recordRevision(doc, read, resolved.mtime);
            if (doc.current_revision_id !== revision.id) store().setCurrentRevision(doc.id, revision.id);
            const declaration = {
                title: v.title, purpose: v.purpose, kind: v.kind || doc.kind, requires_review: v.requiresReview,
                intended_action: v.intendedAction, source: v.source,
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
            return { doc: store().getDocument(doc.id), revision, registration, documentCreated, duplicate };
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
        const roots = await listProjectRoots(db);
        const resolved = resolveDocumentPath(body.path, roots);
        if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
        const read = readDocumentFile(resolved.canonicalPath);
        if (!read.ok) return res.status(read.status).json({ error: read.error, code: read.code });
        // The producer's hash is checked against the exact bytes on disk, never the normalized reviewer text.
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
        const { doc, revision, registration, documentCreated, duplicate } = written;
        return res.status(documentCreated ? 201 : 200).json({
            document: doc,
            revision: revisionMeta(revision),
            review_url: fmt.reviewUrlFor(doc.id),
            review_path: fmt.reviewPathFor(doc.id),
            created: documentCreated,
            duplicate,
            receipt: receiptView(registration, revision),
        });
    }

    // ── Registry ──────────────────────────────────────────────────────────
    router.post('/', async (req, res) => {
        try {
            const body = req.body || {};
            if (body.deliverable !== undefined) return await registerDeclared(req, res, body);
            const roots = await listProjectRoots(db);
            const resolved = resolveDocumentPath(body.path, roots);
            if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
            const read = readDocumentFile(resolved.canonicalPath);
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
            const title = body.title === undefined ? null : text(String(body.title), LIMITS.title);
            if (body.title !== undefined && !title) return res.status(400).json({ error: `title must be 1-${LIMITS.title} characters` });

            const existing = store().findDocumentByPath(resolved.canonicalPath, taskId);
            let doc;
            if (existing) {
                doc = store().updateDocument(existing.id, {
                    ...(title ? { title } : {}),
                    ...(body.project_id ? { project_id: projectId } : {}),
                    ...(body.kind ? { kind } : {}),
                    ...(body.metadata ? { metadata: { ...(existing.metadata || {}), ...body.metadata } } : {}),
                    root_project_id: resolved.root.projectId,
                });
            } else {
                doc = store().insertDocument({
                    title: title || path.basename(resolved.canonicalPath, path.extname(resolved.canonicalPath)),
                    path: resolved.canonicalPath, root_project_id: resolved.root.projectId, project_id: projectId,
                    task_id: taskId, kind, metadata: body.metadata || {}, registered_by: req.user.id,
                });
            }
            const captured = await captureRevision(doc);
            doc = store().getDocument(doc.id);
            return res.status(existing ? 200 : 201).json({
                document: doc, revision: revisionMeta(captured.revision), review_url: fmt.reviewUrlFor(doc.id),
                review_path: fmt.reviewPathFor(doc.id), created: !existing,
            });
        } catch (err) {
            console.error('[Documents] register failed:', err);
            return res.status(500).json({ error: 'Failed to register document' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            const parsed = parseListQuery(req.query);
            if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid_query' });
            const { status, limit, offset, filters } = parsed.value;
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

    router.get('/counts', (req, res) => {
        try {
            const parsed = parseListQuery(req.query, { paging: false });
            if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid_query' });
            return res.json({ counts: store().countDocumentsByStatus(parsed.value.filters), filters: parsed.value.filters });
        } catch (err) {
            console.error('[Documents] counts failed:', err);
            return res.status(500).json({ error: 'Failed to count documents' });
        }
    });

    router.get('/:id', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            const captured = await captureRevision(doc);
            const fresh = store().getDocument(doc.id);
            const review = store().findLatestReview(doc.id, req.user.id);
            const source = await sourceSummary(fresh);
            const latest = store().latestDecision(doc.id);
            return res.json({
                document: fresh,
                revision: revisionMeta(captured.revision),
                content: captured.revision ? captured.revision.content : null,
                file_state: captured.fileState,
                file_error: captured.fileError,
                source,
                review: review ? reviewView(review, { revision: captured.revision }) : null,
                review_status: store().getReviewStatus(doc.id),
                current_decision: latest ? { ...latest, applies_to_current_revision: latest.revision_id === fresh.current_revision_id } : null,
                links: { review_url: fmt.reviewUrlFor(fresh.id), review_path: fmt.reviewPathFor(fresh.id), raw_url: `/api/documents/${fresh.id}/raw` },
            });
        } catch (err) {
            console.error('[Documents] read failed:', err);
            return res.status(500).json({ error: 'Failed to read document' });
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
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Document-Revision', revision.content_hash);
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
        return res.json({ revision: revisionMeta(revision), content: revision.content });
    });

    router.get('/:id/history', (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            return res.json({
                document_id: doc.id,
                current_revision_id: doc.current_revision_id,
                review_status: store().getReviewStatus(doc.id),
                revisions: store().listRevisionMeta(doc.id),
                decisions: store().listDecisions(doc.id),
                registrations: store().listRegistrations(doc.id).map(registration => receiptView(registration, store().getRevisionMeta(registration.revision_id))),
                reviews: store().listReviews(doc.id).map(review => ({
                    id: review.id, revision_id: review.revision_id, reviewer_id: review.reviewer_id, status: review.status,
                    created_at: review.created_at, submitted_at: review.submitted_at || null,
                    comment_count: store().listComments(review.id).length,
                    delivery_status: store().getSubmissionForReview(review.id)?.delivery_status || null,
                })),
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
            let clientDecisionId = null;
            if (body.client_decision_id !== undefined) {
                clientDecisionId = text(body.client_decision_id, LIMITS.clientId);
                if (!clientDecisionId) return res.status(400).json({ error: 'client_decision_id must be a short string', code: 'invalid_decision' });
            }
            const sameRequest = prior => prior.decision === body.decision && prior.revision_id === revisionId && prior.note === note
                && prior.actor_id === authority.actor.id && (body.content_hash === undefined || body.content_hash === prior.content_hash);
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
            const captured = await captureRevision(doc);
            if (captured.fileState !== 'ok') {
                return res.status(409).json({ error: `The document file cannot be confirmed right now (${captured.fileState}); no decision was recorded`, code: 'file_unavailable', file_state: captured.fileState });
            }
            const stale = current => res.status(409).json({
                error: 'The document changed after the revision you reviewed; reopen it and decide on the current revision',
                code: 'stale_revision', revision_id: revisionId, current_revision: revisionMeta(current),
            });
            if (captured.revision.id !== revision.id) return stale(captured.revision);
            let decision;
            try {
                decision = store().transaction(() => {
                    const fresh = store().getDocument(doc.id);
                    if (fresh.current_revision_id !== revision.id || !fresh.requires_review) return null;
                    return store().insertDecision({
                        document_id: doc.id, revision_id: revision.id, content_hash: revision.content_hash, decision: body.decision,
                        actor_id: authority.actor.id, authority: authority.actor.authority, note, client_decision_id: clientDecisionId,
                        intended_action: fresh.intended_action,
                    });
                });
            } catch (err) {
                const raced = clientDecisionId && /UNIQUE/i.test(err.message || '') ? store().findDecisionByClientId(doc.id, clientDecisionId) : null;
                if (raced) return replay(raced);
                throw err;
            }
            if (!decision) return stale(store().getRevisionMeta(store().getDocument(doc.id).current_revision_id));
            console.log(`[Documents] ${body.decision} recorded for ${doc.id} revision ${revision.id} (authority=${authority.actor.authority})`);
            return res.status(201).json({ decision, review_status: store().getReviewStatus(doc.id), document: store().getDocument(doc.id) });
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

    // ── Reviews ───────────────────────────────────────────────────────────
    router.post('/:id/reviews', async (req, res) => {
        try {
            const doc = loadDocument(req, res);
            if (!doc) return;
            const captured = await captureRevision(doc);
            if (!captured.revision) return res.status(409).json({ error: captured.fileError || 'Document has no readable revision to review', code: captured.fileState });
            let review = store().findOpenDraft(doc.id, req.user.id);
            let created = false;
            if (!review) {
                review = store().insertReview({ document_id: doc.id, revision_id: captured.revision.id, reviewer_id: req.user.id });
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

    router.post('/reviews/:reviewId/comments', (req, res) => {
        const review = ownReview(req, res);
        if (!review || !requireDraft(review, res)) return;
        const body = req.body || {};
        const clientId = body.client_id === undefined ? null : text(String(body.client_id), LIMITS.clientId);
        if (body.client_id !== undefined && !clientId) return res.status(400).json({ error: 'client_id must be a short string' });
        if (clientId) {
            const existing = store().findCommentByClientId(review.id, clientId);
            if (existing) return res.status(200).json({ comment: { ...fmt.publicComment(existing), anchor: { state: 'intact', current_start_line: existing.start_line } }, duplicate: true });
        }
        const commentBody = text(body.body, LIMITS.body);
        if (!commentBody) return res.status(400).json({ error: `body must be 1-${LIMITS.body} characters` });
        const kind = body.kind === 'document' ? 'document' : body.kind === 'passage' ? 'passage' : null;
        if (!kind) return res.status(400).json({ error: "kind must be 'passage' or 'document'" });

        const row = { review_id: review.id, client_id: clientId, kind, body: commentBody, start_line: null, end_line: null, block_hash: null, quote: null, selection: null };
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
            return res.status(201).json({ comment: { ...fmt.publicComment(comment), anchor: { state: kind === 'passage' ? 'intact' : 'document', current_start_line: comment.start_line } } });
        } catch (err) {
            if (clientId && /UNIQUE/i.test(err.message || '')) {
                const existing = store().findCommentByClientId(review.id, clientId);
                if (existing) return res.status(200).json({ comment: { ...fmt.publicComment(existing), anchor: { state: existing.kind === 'passage' ? 'intact' : 'document', current_start_line: existing.start_line } }, duplicate: true });
            }
            console.error('[Documents] add comment failed:', err);
            return res.status(500).json({ error: 'Failed to save comment' });
        }
    });

    router.patch('/reviews/:reviewId/comments/:commentId', (req, res) => {
        const review = ownReview(req, res);
        if (!review || !requireDraft(review, res)) return;
        const comment = store().getComment(req.params.commentId);
        if (!comment || comment.review_id !== review.id) return res.status(404).json({ error: 'Comment not found' });
        const commentBody = text(req.body?.body, LIMITS.body);
        if (!commentBody) return res.status(400).json({ error: `body must be 1-${LIMITS.body} characters` });
        const updated = store().updateComment(comment.id, { body: commentBody });
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
            const body = req.body || {};
            let summary = review.summary || '';
            if (body.summary !== undefined) {
                if (typeof body.summary !== 'string' || body.summary.length > LIMITS.summary) {
                    return res.status(400).json({ error: `summary must be a string of at most ${LIMITS.summary} characters` });
                }
                summary = body.summary;
            }
            const revision = store().getRevisionMeta(review.revision_id);
            const comments = store().listComments(review.id);
            const source = await sourceSummary(doc);
            const submittedAt = new Date().toISOString();
            const submissionId = randomUUID();
            const payload = fmt.buildSubmissionPayload({ submissionId, review: { ...review, summary }, comments, document: doc, revision, source, submittedAt });
            const messageText = fmt.formatSubmissionMessage(payload);
            let submission;
            try {
                submission = store().transaction(() => {
                    store().updateReview(review.id, { status: 'submitted', summary, submitted_at: submittedAt });
                    return store().insertSubmission({ id: submissionId, review_id: review.id, document_id: doc.id, revision_id: review.revision_id, payload, message_text: messageText });
                });
            } catch (err) {
                const raced = store().getSubmissionForReview(review.id);
                if (!raced) throw err;
                return res.status(200).json({ review: reviewView(store().getReview(review.id), currentFor(doc)), submission: submissionView(raced), duplicate: true });
            }
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
