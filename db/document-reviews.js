/**
 * Markdown document review store (2026-09-10 design:
 * docs/superpowers/specs/2026-09-10-markdown-document-review-design.md).
 *
 * Registered documents, immutable content revisions, per-reviewer reviews
 * pinned to a revision, verbatim comments and the durable submission outbox
 * that carries a finished review into the Praxis conversation. Everything
 * here runs on the raw better-sqlite3 connection the facade owns; route code
 * reaches it through `db.documentReviews`.
 *
 * Declared deliverables and review decisions (2026-10-02 contract:
 * docs/contracts/document-review-deliverables.md). A document carries its
 * declared purpose, whether it requires Robert's review and the action it is
 * intended for; legacy rows migrate as reference documents (no review
 * required). Registration receipts record each validated declaration against
 * the exact revision it captured; a declared deliverable's revisions are
 * identified by the SHA-256 of the exact file bytes (legacy documents keep the
 * line-normalized identity). Decisions (approve / request changes) are
 * append-only rows pinned to one revision and one actor; the review status of
 * a document is derived from its latest decision and current revision, never
 * stored, so new bytes can never inherit an approval.
 *
 * Executor-recorded approvals (2026-10-04, task a2553798). A decision also
 * records who entered it: `recorded_by` is `operator` for Robert's own
 * decisions (an Access session or the operator credential used directly) and
 * `executor` when a dispatched executor recorded his "approve with changes"
 * instruction with the document executor credential. An executor-recorded row
 * carries `provenance`: the executor's identity and run, and a snapshot of the
 * submitted review (Robert's instruction and his delegation grant) it acted
 * on. Rows written before the column existed read as direct operator
 * decisions. A review records the operator proof it was finished with and
 * whether Robert granted approval after changes (`submitted_authority`,
 * `approval_delegated`); only such a review can be the source of an
 * executor-recorded approval.
 */
const { randomUUID } = require('crypto');

function now() { return new Date().toISOString(); }

/** Columns added to review_documents after the 2026-09-10 schema; legacy rows take the defaults. */
const DELIVERABLE_COLUMNS = [
    ['deliverable_key', 'TEXT'],
    ['purpose', 'TEXT'],
    ['requires_review', 'INTEGER NOT NULL DEFAULT 0'],
    ['intended_action', "TEXT NOT NULL DEFAULT 'none'"],
];

const REVIEW_STATUSES = ['needs_review', 'changes_requested', 'approved', 'reference'];

// Review status of a document row `d` joined to its latest decision `ld`.
// An approval or change request only counts for the revision it named.
const REVIEW_STATUS_SQL = `CASE
        WHEN d.requires_review = 0 THEN 'reference'
        WHEN ld.decision = 'approve' AND ld.revision_id = d.current_revision_id THEN 'approved'
        WHEN ld.decision = 'request_changes' AND ld.revision_id = d.current_revision_id THEN 'changes_requested'
        ELSE 'needs_review'
    END`;
const LATEST_DECISION_JOIN = `LEFT JOIN review_document_decisions ld ON ld.id = (
        SELECT x.id FROM review_document_decisions x WHERE x.document_id = d.id
        ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)`;

/**
 * Columns added to review_document_decisions after the 2026-10-02 contract.
 * `recorded_by` tells a direct operator decision from an executor-recorded one;
 * `provenance` (JSON) is set only on executor-recorded rows.
 */
const DECISION_COLUMNS = [
    ['recorded_by', "TEXT NOT NULL DEFAULT 'operator'"],
    ['provenance', 'TEXT'],
];

/**
 * Columns added to document_reviews for executor-recorded approvals (repair
 * round, 2026-10-04). `submitted_authority` is the operator proof the finish
 * request carried (access_user, access_device or operator_credential), NULL for
 * an unsigned finish; `approval_delegated` is Robert's explicit
 * approve-after-changes grant, set only together with that proof. Legacy
 * reviews read as not delegated, so no executor can act on them.
 */
const REVIEW_COLUMNS = [
    ['submitted_authority', 'TEXT'],
    ['approval_delegated', 'INTEGER NOT NULL DEFAULT 0'],
];

function addMissingColumns(db, table, columns) {
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    for (const [name, declaration] of columns) {
        if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    }
}

function migrateDeliverableColumns(db) {
    addMissingColumns(db, 'review_documents', DELIVERABLE_COLUMNS);
}

function migrateDecisionColumns(db) {
    addMissingColumns(db, 'review_document_decisions', DECISION_COLUMNS);
}

function migrateReviewColumns(db) {
    addMissingColumns(db, 'document_reviews', REVIEW_COLUMNS);
}

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

    migrateDeliverableColumns(db);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_review_documents_deliverable_key
        ON review_documents(deliverable_key) WHERE deliverable_key IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS review_document_revisions_immutable
        BEFORE UPDATE ON review_document_revisions
        BEGIN SELECT RAISE(ABORT, 'document revisions are immutable'); END;

    -- The exact delivered bytes of a declared deliverable's revision, kept
    -- only when they differ from the normalized reviewer text (a BOM or CR
    -- line endings). For such a revision content_hash is the SHA-256 of these
    -- bytes, so the raw route can serve exactly what was registered.
    CREATE TABLE IF NOT EXISTS review_document_revision_exact (
        revision_id TEXT PRIMARY KEY REFERENCES review_document_revisions(id) ON DELETE CASCADE,
        exact_content TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS review_document_revision_exact_immutable
        BEFORE UPDATE ON review_document_revision_exact
        BEGIN SELECT RAISE(ABORT, 'document revisions are immutable'); END;

    CREATE TABLE IF NOT EXISTS review_document_decisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        content_hash TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'request_changes')),
        actor_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        client_decision_id TEXT,
        intended_action TEXT NOT NULL DEFAULT 'none',
        created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_decisions_client
        ON review_document_decisions(document_id, client_decision_id) WHERE client_decision_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_review_document_decisions_document
        ON review_document_decisions(document_id, created_at);
    CREATE TRIGGER IF NOT EXISTS review_document_decisions_append_only
        BEFORE UPDATE ON review_document_decisions
        BEGIN SELECT RAISE(ABORT, 'document decisions are append-only'); END;

    CREATE TABLE IF NOT EXISTS review_document_registrations (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        content_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        deliverable_key TEXT NOT NULL,
        path TEXT NOT NULL,
        root_project_id TEXT,
        project_id TEXT NOT NULL,
        task_id TEXT,
        declaration TEXT NOT NULL DEFAULT '{}',
        document_created INTEGER NOT NULL DEFAULT 0,
        revision_created INTEGER NOT NULL DEFAULT 0,
        registered_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(document_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_review_document_registrations_task
        ON review_document_registrations(task_id);
    CREATE INDEX IF NOT EXISTS idx_review_document_registrations_project
        ON review_document_registrations(project_id);
    CREATE INDEX IF NOT EXISTS idx_review_document_registrations_document
        ON review_document_registrations(document_id, created_at);`);
    migrateDecisionColumns(db);
    migrateReviewColumns(db);
}

const JSON_COLUMNS = new Set(['metadata', 'payload', 'receipt', 'declaration', 'provenance']);
/** JSON columns whose absence reads as null rather than an empty object. */
const NULLABLE_JSON_COLUMNS = new Set(['receipt', 'provenance']);
const BOOLEAN_COLUMNS = new Set(['requires_review', 'document_created', 'revision_created', 'approval_delegated']);

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function rowOut(row) {
    if (!row) return null;
    const out = { ...row };
    for (const key of JSON_COLUMNS) {
        if (key in out) out[key] = parseJson(out[key], NULLABLE_JSON_COLUMNS.has(key) ? null : {});
    }
    for (const key of BOOLEAN_COLUMNS) {
        if (typeof out[key] === 'number') out[key] = out[key] !== 0;
    }
    return out;
}

/** Shared FROM/WHERE for the document list, its total and the per-status counts, so all three agree. */
function documentQuery({ id, task_id, project_id, kind, q } = {}) {
    const where = [];
    const params = [];
    if (id) { where.push('d.id = ?'); params.push(id); }
    if (task_id) {
        // A document belongs to a task it was first registered under, or to any task whose declared registration reused it.
        where.push('(d.task_id = ? OR d.id IN (SELECT r.document_id FROM review_document_registrations r WHERE r.task_id = ?))');
        params.push(task_id, task_id);
    }
    if (project_id) {
        // Same rule for projects: the producing project, or any project whose declared registration reused the document.
        where.push('(d.project_id = ? OR d.id IN (SELECT r.document_id FROM review_document_registrations r WHERE r.project_id = ?))');
        params.push(project_id, project_id);
    }
    if (kind) { where.push('d.kind = ?'); params.push(kind); }
    if (q) {
        const like = `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
        where.push("(d.title LIKE ? ESCAPE '\\' OR COALESCE(d.purpose, '') LIKE ? ESCAPE '\\' OR d.path LIKE ? ESCAPE '\\')");
        params.push(like, like, like);
    }
    const sql = `SELECT d.*, ${REVIEW_STATUS_SQL} AS review_status FROM review_documents d ${LATEST_DECISION_JOIN}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    return { sql, params };
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
        findDocumentByKey(key) { return one('SELECT * FROM review_documents WHERE deliverable_key = ?', key); },
        /**
         * One page of documents (newest first) with each row's derived
         * `review_status`, plus the total matching the same filters. Both run
         * in one read transaction so the page and its total agree.
         */
        listDocumentsPage({ status = 'all', limit = 100, offset = 0, ...filters } = {}) {
            const { sql, params } = documentQuery(filters);
            const statusClause = status && status !== 'all' ? ' WHERE review_status = ?' : '';
            const all = statusClause ? [...params, status] : params;
            return db.transaction(() => ({
                total: db.prepare(`SELECT COUNT(*) AS n FROM (${sql})${statusClause}`).get(...all).n,
                documents: many(`SELECT * FROM (${sql})${statusClause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...all, limit, offset),
            }))();
        },
        /** Per-status counts for the same filters as listDocumentsPage; `all` is their sum. */
        countDocumentsByStatus(filters = {}) {
            const { sql, params } = documentQuery(filters);
            const counts = Object.fromEntries([...REVIEW_STATUSES, 'all'].map(status => [status, 0]));
            for (const row of db.prepare(`SELECT review_status, COUNT(*) AS n FROM (${sql}) GROUP BY review_status`).all(...params)) {
                counts[row.review_status] = row.n;
                counts.all += row.n;
            }
            return counts;
        },
        getReviewStatus(documentId) {
            const { sql, params } = documentQuery({ id: documentId });
            return db.prepare(`SELECT review_status FROM (${sql})`).get(...params)?.review_status || null;
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
        insertRevisionExact(revisionId, exactContent) {
            insert('review_document_revision_exact', { revision_id: revisionId, exact_content: exactContent, created_at: now() });
        },
        /** The exact delivered text of a revision, or null when its normalized content already is exact. */
        getRevisionExact(revisionId) {
            return db.prepare('SELECT exact_content FROM review_document_revision_exact WHERE revision_id = ?').get(revisionId)?.exact_content ?? null;
        },
        listRevisionMeta(documentId) {
            return many(`SELECT id, document_id, content_hash, byte_length, line_count, file_mtime, captured_at
                FROM review_document_revisions WHERE document_id = ? ORDER BY captured_at ASC, rowid ASC`, documentId);
        },

        // ── Decisions (append-only) ──────────────────────────────────────
        getDecision(id) { return one('SELECT * FROM review_document_decisions WHERE id = ?', id); },
        findDecisionByClientId(documentId, clientDecisionId) {
            return one('SELECT * FROM review_document_decisions WHERE document_id = ? AND client_decision_id = ?', documentId, clientDecisionId);
        },
        latestDecision(documentId) {
            return one('SELECT * FROM review_document_decisions WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', documentId);
        },
        listDecisions(documentId) {
            return many('SELECT * FROM review_document_decisions WHERE document_id = ? ORDER BY created_at ASC, rowid ASC', documentId);
        },
        /** Decisions recorded at or after an instant (ISO 8601), oldest first: what happened since a review was submitted. */
        listDecisionsSince(documentId, sinceIso) {
            return many('SELECT * FROM review_document_decisions WHERE document_id = ? AND created_at >= ? ORDER BY created_at ASC, rowid ASC', documentId, sinceIso);
        },
        /** The executor-recorded decision that already acted on a submitted review, if any. */
        findDecisionBySourceReview(documentId, reviewId) {
            return one(`SELECT * FROM review_document_decisions
                WHERE document_id = ? AND recorded_by = 'executor' AND json_extract(provenance, '$.source.review_id') = ?
                ORDER BY created_at ASC, rowid ASC LIMIT 1`, documentId, reviewId);
        },
        insertDecision(decision) {
            const row = { id: decision.id || randomUUID(), note: '', recorded_by: 'operator', provenance: null, ...decision, created_at: now() };
            insert('review_document_decisions', row);
            return this.getDecision(row.id);
        },

        // ── Registration receipts ────────────────────────────────────────
        getRegistration(id) { return one('SELECT * FROM review_document_registrations WHERE id = ?', id); },
        findRegistration(documentId, fingerprint) {
            return one('SELECT * FROM review_document_registrations WHERE document_id = ? AND fingerprint = ?', documentId, fingerprint);
        },
        listRegistrations(documentId) {
            return many('SELECT * FROM review_document_registrations WHERE document_id = ? ORDER BY created_at ASC, rowid ASC', documentId);
        },
        insertRegistration(registration) {
            const row = { id: registration.id || randomUUID(), ...registration, created_at: now() };
            insert('review_document_registrations', row);
            return this.getRegistration(row.id);
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

module.exports = { initializeDocumentReviews, createDocumentReviewStore, REVIEW_STATUSES };
