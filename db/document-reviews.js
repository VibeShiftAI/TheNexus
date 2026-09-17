/**
 * Markdown document review store (2026-09-10 design:
 * docs/superpowers/specs/2026-09-10-markdown-document-review-design.md).
 *
 * Registered documents, immutable content revisions, per-reviewer reviews
 * pinned to a revision, verbatim comments and the durable submission outbox
 * that carries a finished review into the Praxis conversation. Everything
 * here runs on the raw better-sqlite3 connection the facade owns; route code
 * reaches it through `db.documentReviews`.
 */
const { randomUUID } = require('crypto');

function now() { return new Date().toISOString(); }

function initializeDocumentReviews(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        root_project_id TEXT,
        project_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL DEFAULT 'document',
        metadata TEXT NOT NULL DEFAULT '{}',
        current_revision_id TEXT,
        registered_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_documents_path_task
        ON review_documents(path, COALESCE(task_id, ''));
    CREATE INDEX IF NOT EXISTS idx_review_documents_task ON review_documents(task_id);
    CREATE INDEX IF NOT EXISTS idx_review_documents_project ON review_documents(project_id);

    CREATE TABLE IF NOT EXISTS review_document_revisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        file_mtime TEXT,
        captured_at TEXT NOT NULL,
        UNIQUE(document_id, content_hash)
    );

    CREATE TABLE IF NOT EXISTS document_reviews (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        reviewer_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_reviews_open_draft
        ON document_reviews(document_id, reviewer_id) WHERE status = 'draft';
    CREATE INDEX IF NOT EXISTS idx_document_reviews_document ON document_reviews(document_id, created_at);

    CREATE TABLE IF NOT EXISTS document_review_comments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES document_reviews(id) ON DELETE CASCADE,
        client_id TEXT,
        kind TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        block_hash TEXT,
        quote TEXT,
        selection TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_review_comments_client
        ON document_review_comments(review_id, client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_document_review_comments_review ON document_review_comments(review_id, created_at);

    CREATE TABLE IF NOT EXISTS document_review_submissions (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL UNIQUE REFERENCES document_reviews(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        message_text TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'queued',
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        relay_started_at TEXT,
        last_error TEXT,
        delivered_at TEXT,
        receipt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_review_submissions_status
        ON document_review_submissions(delivery_status, next_attempt_at);`);
}

const JSON_COLUMNS = new Set(['metadata', 'payload', 'receipt']);

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function rowOut(row) {
    if (!row) return null;
    const out = { ...row };
    for (const key of JSON_COLUMNS) {
        if (key in out) out[key] = parseJson(out[key], key === 'receipt' ? null : {});
    }
    return out;
}

function rowsOut(rows) { return (rows || []).map(rowOut); }

function serialize(value) {
    if (value === undefined) return null;
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

function createDocumentReviewStore(db) {
    function insert(table, row) {
        const keys = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
            .run(...keys.map(k => serialize(row[k])));
    }
    function update(table, id, updates) {
        const patch = { ...updates, updated_at: updates.updated_at || now() };
        const keys = Object.keys(patch);
        return db.prepare(`UPDATE ${table} SET ${keys.map(k => `"${k}" = ?`).join(', ')} WHERE id = ?`)
            .run(...keys.map(k => serialize(patch[k])), id).changes;
    }
    const one = (sql, ...params) => rowOut(db.prepare(sql).get(...params));
    const many = (sql, ...params) => rowsOut(db.prepare(sql).all(...params));

    return {
        transaction(fn) { return db.transaction(fn)(); },

        // ── Documents ────────────────────────────────────────────────────
        getDocument(id) { return one('SELECT * FROM review_documents WHERE id = ?', id); },
        findDocumentByPath(path, taskId) {
            return one("SELECT * FROM review_documents WHERE path = ? AND COALESCE(task_id, '') = ?", path, taskId || '');
        },
        listDocuments({ task_id, project_id, limit = 100 } = {}) {
            const where = [];
            const params = [];
            if (task_id) { where.push('task_id = ?'); params.push(task_id); }
            if (project_id) { where.push('project_id = ?'); params.push(project_id); }
            const sql = `SELECT * FROM review_documents${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
            return many(sql, ...params, limit);
        },
        insertDocument(doc) {
            const ts = now();
            const row = { id: doc.id || randomUUID(), kind: 'document', metadata: {}, ...doc, created_at: ts, updated_at: ts };
            insert('review_documents', row);
            return this.getDocument(row.id);
        },
        updateDocument(id, updates) { update('review_documents', id, updates); return this.getDocument(id); },

        // ── Revisions ────────────────────────────────────────────────────
        getRevision(id) { return one('SELECT * FROM review_document_revisions WHERE id = ?', id); },
        getRevisionMeta(id) {
            return one('SELECT id, document_id, content_hash, byte_length, line_count, file_mtime, captured_at FROM review_document_revisions WHERE id = ?', id);
        },
        findRevisionByHash(documentId, hash) {
            return one('SELECT * FROM review_document_revisions WHERE document_id = ? AND content_hash = ?', documentId, hash);
        },
        insertRevision(rev) {
            const row = { id: rev.id || randomUUID(), captured_at: now(), ...rev };
            insert('review_document_revisions', row);
            return this.getRevision(row.id);
        },
        setCurrentRevision(documentId, revisionId) {
            update('review_documents', documentId, { current_revision_id: revisionId });
        },

        // ── Reviews ──────────────────────────────────────────────────────
        getReview(id) { return one('SELECT * FROM document_reviews WHERE id = ?', id); },
        findOpenDraft(documentId, reviewerId) {
            return one("SELECT * FROM document_reviews WHERE document_id = ? AND reviewer_id = ? AND status = 'draft'", documentId, reviewerId);
        },
        findLatestReview(documentId, reviewerId) {
            return one(`SELECT * FROM document_reviews WHERE document_id = ? AND reviewer_id = ?
                ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`, documentId, reviewerId);
        },
        listReviews(documentId) {
            return many('SELECT * FROM document_reviews WHERE document_id = ? ORDER BY created_at DESC', documentId);
        },
        insertReview(review) {
            const ts = now();
            const row = { id: review.id || randomUUID(), status: 'draft', summary: '', ...review, created_at: ts, updated_at: ts };
            insert('document_reviews', row);
            return this.getReview(row.id);
        },
        updateReview(id, updates) { update('document_reviews', id, updates); return this.getReview(id); },

        // ── Comments ─────────────────────────────────────────────────────
        getComment(id) { return one('SELECT * FROM document_review_comments WHERE id = ?', id); },
        findCommentByClientId(reviewId, clientId) {
            return one('SELECT * FROM document_review_comments WHERE review_id = ? AND client_id = ?', reviewId, clientId);
        },
        listComments(reviewId) {
            return many('SELECT * FROM document_review_comments WHERE review_id = ? ORDER BY created_at ASC, rowid ASC', reviewId);
        },
        insertComment(comment) {
            const ts = now();
            const row = { id: comment.id || randomUUID(), ...comment, created_at: ts, updated_at: ts };
            insert('document_review_comments', row);
            return this.getComment(row.id);
        },
        updateComment(id, updates) { update('document_review_comments', id, updates); return this.getComment(id); },
        deleteComment(id) { return db.prepare('DELETE FROM document_review_comments WHERE id = ?').run(id).changes; },

        // ── Submissions (delivery outbox) ────────────────────────────────
        getSubmission(id) { return one('SELECT * FROM document_review_submissions WHERE id = ?', id); },
        getSubmissionForReview(reviewId) { return one('SELECT * FROM document_review_submissions WHERE review_id = ?', reviewId); },
        insertSubmission(sub) {
            const ts = now();
            const row = { id: sub.id || randomUUID(), delivery_status: 'queued', delivery_attempts: 0, next_attempt_at: ts, ...sub, created_at: ts, updated_at: ts };
            insert('document_review_submissions', row);
            return this.getSubmission(row.id);
        },
        updateSubmission(id, updates) { update('document_review_submissions', id, updates); return this.getSubmission(id); },
        listDueSubmissions(nowIso = now()) {
            return many(`SELECT * FROM document_review_submissions
                WHERE (delivery_status = 'queued' OR delivery_status = 'failed')
                  AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
                ORDER BY created_at ASC`, nowIso);
        },
        listRelayingSubmissions() {
            return many("SELECT * FROM document_review_submissions WHERE delivery_status = 'relaying' ORDER BY created_at ASC");
        },
    };
}

module.exports = { initializeDocumentReviews, createDocumentReviewStore };
