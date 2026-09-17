/**
 * Markdown document review API (design: docs/superpowers/specs/
 * 2026-09-10-markdown-document-review-design.md).
 *
 *   POST   /api/documents                                  register a Markdown file (server-issued id, allowlisted path)
 *   GET    /api/documents?task_id=&project_id=             list registered documents with the caller's review state
 *   GET    /api/documents/:id                              document + current revision + content + the caller's review
 *   GET    /api/documents/:id/raw?revision=&download=1     Markdown source (current or pinned revision)
 *   GET    /api/documents/:id/revisions/:revisionId        a pinned snapshot
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
 */
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { listProjectRoots, resolveDocumentPath, readDocumentFile } = require('../services/document-registry');
const fmt = require('../services/document-review-format');

const KINDS = new Set(['document', 'report', 'spec', 'plan', 'research', 'walkthrough', 'other']);
const LIMITS = { title: 300, body: 20000, summary: 20000, selection: 2000, metadataJson: 8000, clientId: 120 };

function text(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) return null;
    return trimmed;
}

function createDocumentsRouter({ db, delivery }) {
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

    /** Re-check the boundary, read the file and record a new revision when the content changed. */
    async function captureRevision(doc) {
        const stored = doc.current_revision_id ? store().getRevision(doc.current_revision_id) : null;
        const roots = await listProjectRoots(db);
        const resolved = resolveDocumentPath(doc.path, roots);
        if (!resolved.ok) return { revision: stored, fileState: resolved.code, fileError: resolved.error };
        if (resolved.canonicalPath !== doc.path) return { revision: stored, fileState: 'path_changed', fileError: 'Registered path no longer resolves to the same file' };
        const read = readDocumentFile(resolved.canonicalPath);
        if (!read.ok) return { revision: stored, fileState: read.code, fileError: read.error };
        let revision = store().findRevisionByHash(doc.id, read.contentHash);
        if (!revision) {
            revision = store().insertRevision({
                document_id: doc.id, content_hash: read.contentHash, content: read.content,
                byte_length: read.byteLength, line_count: read.lineCount, file_mtime: resolved.mtime,
            });
        }
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

    // ── Registry ──────────────────────────────────────────────────────────
    router.post('/', async (req, res) => {
        try {
            const body = req.body || {};
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
                document: doc, revision: revisionMeta(captured.revision), review_url: fmt.reviewUrlFor(doc.id), created: !existing,
            });
        } catch (err) {
            console.error('[Documents] register failed:', err);
            return res.status(500).json({ error: 'Failed to register document' });
        }
    });

    router.get('/', async (req, res) => {
        try {
            const taskId = typeof req.query.task_id === 'string' ? req.query.task_id : undefined;
            const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;
            const documents = store().listDocuments({ task_id: taskId, project_id: projectId }).map(doc => {
                const review = store().findLatestReview(doc.id, req.user.id);
                const submission = review ? store().getSubmissionForReview(review.id) : null;
                return {
                    ...doc,
                    current_revision: revisionMeta(doc.current_revision_id ? store().getRevisionMeta(doc.current_revision_id) : null),
                    review_url: fmt.reviewUrlFor(doc.id),
                    review_state: review ? {
                        review_id: review.id, status: review.status, updated_at: review.updated_at,
                        comment_count: store().listComments(review.id).length,
                        delivery_status: submission ? submission.delivery_status : null,
                    } : null,
                };
            });
            return res.json({ documents });
        } catch (err) {
            console.error('[Documents] list failed:', err);
            return res.status(500).json({ error: 'Failed to list documents' });
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
            return res.json({
                document: fresh,
                revision: revisionMeta(captured.revision),
                content: captured.revision ? captured.revision.content : null,
                file_state: captured.fileState,
                file_error: captured.fileError,
                source,
                review: review ? reviewView(review, { revision: captured.revision }) : null,
                links: { review_url: fmt.reviewUrlFor(fresh.id), raw_url: `/api/documents/${fresh.id}/raw` },
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
            return res.send(revision.content);
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
