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
const { ACTIVE_TASK_SQL, WAITING_TASKS_FROM_SQL } = require('./document-review-blockers');
const { initializeDocumentOutgoing, createDocumentOutgoingStore } = require('./document-outgoing');

function now() { return new Date().toISOString(); }

/** Columns added to review_documents after the 2026-09-10 schema; legacy rows take the defaults. */
const DELIVERABLE_COLUMNS = [
    ['deliverable_key', 'TEXT'],
    ['purpose', 'TEXT'],
    ['blocking_task_ids', "TEXT NOT NULL DEFAULT '[]'"],
    ['requires_review', 'INTEGER NOT NULL DEFAULT 0'],
    ['intended_action', "TEXT NOT NULL DEFAULT 'none'"],
    // Media model (2026-10-16, docs/contracts/review-media-and-design-packages.md). Legacy rows are Markdown.
    ['media_type', "TEXT NOT NULL DEFAULT 'markdown'"],
    ['mime_type', "TEXT NOT NULL DEFAULT 'text/markdown'"],
];

/**
 * Columns added to review_document_revisions for the media model. `source` is
 * `capture` for bytes read from the producer's file and `nexus_edit` for a
 * revision written by the reviewer's own edit; `asset_count` is 1 for a single
 * file and members + 1 for a design package, whose parsed `manifest` is kept
 * with the revision so the viewer never depends on the file on disk.
 */
const REVISION_MEDIA_COLUMNS = [
    ['media_type', "TEXT NOT NULL DEFAULT 'markdown'"],
    ['mime_type', "TEXT NOT NULL DEFAULT 'text/markdown'"],
    ['source', "TEXT NOT NULL DEFAULT 'capture'"],
    ['edited_by', 'TEXT'],
    ['asset_count', 'INTEGER NOT NULL DEFAULT 1'],
    ['width', 'INTEGER'],
    ['height', 'INTEGER'],
    ['manifest', 'TEXT'],
];

/**
 * Columns added to document_review_comments for media anchors and threads
 * (contract §3). `anchor` is the JSON region/time/page/screen anchor,
 * `target_label` the human label the reviewer saw, `parent_id` a reply's root
 * in the same review, `resolved_at` the reviewer's own bookkeeping.
 */
const COMMENT_MEDIA_COLUMNS = [
    ['anchor', 'TEXT'],
    ['target_label', 'TEXT'],
    ['parent_id', 'TEXT'],
    ['resolved_at', 'TEXT'],
];

const REVIEW_STATUSES = ['needs_review', 'changes_requested', 'approved', 'reference'];
/**
 * List and count buckets (2026-10-23, task 6b46dcc8): the four decision
 * statuses plus `in_progress`, a document whose replacement work is accepted
 * and not finished, or whose current revision is the unaccepted result of a
 * failed or cancelled attempt. Such a document is not reviewable, so it leaves
 * the decision buckets until its new current revision is ready (or, when the
 * attempt registered no result and no failed result governs the current
 * version, until it fails or is cancelled; a registered result, or the failed
 * result a recovery set out to replace, waits for an explicit recovery that
 * delivers). `review_status` itself stays one of
 * REVIEW_STATUSES: it describes decisions, the bucket describes reviewability.
 */
const LIST_STATUSES = [...REVIEW_STATUSES, 'in_progress'];

/**
 * Replacement work on a document (task 6b46dcc8). One open replacement per
 * document at a time; accepting it supersedes every pending review draft and
 * closes the document to new reviews, decisions and edits until the work
 * declares the new current revision ready, or fails or is cancelled before
 * registering a result over a version no failed result governs. A result
 * registered by an attempt that then failed or was cancelled keeps the
 * document closed until an explicit recovery delivers; a recovery that ends
 * before registering anything leaves it closed.
 *
 *   accepted    the originating change request is linked to revision work (task may follow)
 *   queued      dispatch queued for the linked task
 *   held        dispatch held (hold reason in `detail`)
 *   running     the executor is working
 *   implemented a resulting revision is registered on the document (`result_revision_id`)
 *   qa_passed   the linked task's QA passed; the result still has to be current and ready
 *   ready       the resulting revision is the current, ready revision: reviewable again (terminal)
 *   failed      the work did not deliver (terminal; recovery is a new, versioned replacement)
 *   cancelled   the work was stopped on purpose (terminal; recovery as above)
 */
const REPLACEMENT_STATES = ['accepted', 'queued', 'held', 'running', 'implemented', 'qa_passed', 'ready', 'failed', 'cancelled'];
const REPLACEMENT_TERMINAL_STATES = ['ready', 'failed', 'cancelled'];
const REPLACEMENT_OPEN_STATES = REPLACEMENT_STATES.filter(state => !REPLACEMENT_TERMINAL_STATES.includes(state));
const sqlList = values => values.map(value => `'${value}'`).join(', ');

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
// The replacement that governs a document row `rp`, if any: its one open item (partial unique index below), else the newest
// attempt that registered the current revision, when that attempt failed or was cancelled (a ready producer governs nothing).
// Either way the version takes no review actions: the first until the work closes, the second until an explicit recovery
// delivers a new version (never by reviewing failed bytes). This is the producer the route's authorityRevision starts from,
// so a list row and the detail read agree on whether the version is closed.
const GOVERNING_REPLACEMENT_JOIN = `LEFT JOIN review_document_replacements rp ON rp.id = COALESCE(
        (SELECT y.id FROM review_document_replacements y WHERE y.document_id = d.id AND y.state IN (${sqlList(REPLACEMENT_OPEN_STATES)})
         ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1),
        (SELECT CASE WHEN z.state IN ('failed', 'cancelled') THEN z.id END FROM review_document_replacements z
         WHERE z.document_id = d.id AND z.result_revision_id = d.current_revision_id
         ORDER BY z.created_at DESC, z.rowid DESC LIMIT 1))`;
/** The bucket a list row falls in, over the columns documentQuery selects: a governing replacement takes it out of the decision buckets. */
const LIST_BUCKET_SQL = `CASE WHEN replacement_id IS NULL THEN review_status ELSE 'in_progress' END`;

/**
 * Columns added to review_document_decisions after the 2026-10-02 contract.
 * `recorded_by` tells a direct operator decision from an executor-recorded one;
 * `provenance` (JSON) is set only on executor-recorded rows.
 */
const DECISION_COLUMNS = [
    ['recorded_by', "TEXT NOT NULL DEFAULT 'operator'"],
    ['provenance', 'TEXT'],
    // What the decision chose, when the deliverable offered a choice (a design package's direction). JSON, contract §3.3.
    // Stored as selection_json (the comments table already has a free-text `selection`); read back as `selection`.
    ['selection_json', 'TEXT'],
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

/**
 * Columns added to document_reviews for the version lifecycle (2026-10-23,
 * task 6b46dcc8). A pending draft is closed as `superseded` when replacement
 * work on its document is accepted: `status` becomes 'superseded' (which frees
 * the one-open-draft slot and freezes the round), `closed_at` and
 * `closed_reason` say when and why, `replacement_id` names the work. Comments
 * and summary stay as they were. Legacy rows read as never closed.
 */
const REVIEW_LIFECYCLE_COLUMNS = [
    ['closed_at', 'TEXT'],
    ['closed_reason', 'TEXT'],
    ['replacement_id', 'TEXT'],
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

/**
 * Version lifecycle (2026-10-23, task 6b46dcc8): replacement work items and
 * the review closure columns. Additive: nothing existing is rewritten.
 */
function migrateReplacementLifecycle(db) {
    addMissingColumns(db, 'document_reviews', REVIEW_LIFECYCLE_COLUMNS);
    db.exec(`CREATE TABLE IF NOT EXISTS review_document_replacements (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        base_revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        client_request_id TEXT NOT NULL,
        source_submission_id TEXT,
        source_review_id TEXT,
        source_decision_id TEXT,
        source_authority TEXT,
        task_id TEXT,
        execution_id TEXT,
        state TEXT NOT NULL CHECK (state IN (${sqlList(REPLACEMENT_STATES)})),
        detail TEXT,
        qa_state TEXT CHECK (qa_state IS NULL OR qa_state IN ('pending', 'passed', 'failed')),
        result_revision_id TEXT REFERENCES review_document_revisions(id),
        attempt INTEGER NOT NULL DEFAULT 1,
        recovers_replacement_id TEXT,
        accepted_by TEXT NOT NULL,
        superseded_review_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    );
    -- Idempotent acceptance: the same client key on the same document is one item.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_replacements_client
        ON review_document_replacements(document_id, client_request_id);
    -- One open replacement per document: concurrent acceptances cannot both win.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_replacements_open
        ON review_document_replacements(document_id) WHERE state IN (${sqlList(REPLACEMENT_OPEN_STATES)});
    -- One live (open or ready) work item per originating submission or decision; a failed or cancelled one may be recovered by a new item.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_replacements_source_submission
        ON review_document_replacements(document_id, source_submission_id) WHERE source_submission_id IS NOT NULL AND state NOT IN ('failed', 'cancelled');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_replacements_source_decision
        ON review_document_replacements(document_id, source_decision_id) WHERE source_decision_id IS NOT NULL AND state NOT IN ('failed', 'cancelled');
    CREATE INDEX IF NOT EXISTS idx_review_document_replacements_document
        ON review_document_replacements(document_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_review_document_replacements_task
        ON review_document_replacements(task_id);`);
}

function migrateMediaColumns(db) {
    addMissingColumns(db, 'review_document_revisions', REVISION_MEDIA_COLUMNS);
    addMissingColumns(db, 'document_review_comments', COMMENT_MEDIA_COLUMNS);
    db.exec(`CREATE TABLE IF NOT EXISTS review_document_revision_assets (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES review_document_revisions(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        asset_key TEXT NOT NULL,
        role TEXT NOT NULL,
        path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        label TEXT,
        direction TEXT,
        appearance TEXT,
        viewport TEXT,
        state TEXT,
        before_asset_key TEXT,
        "order" INTEGER NOT NULL DEFAULT 0,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(revision_id, asset_key)
    );
    CREATE INDEX IF NOT EXISTS idx_review_document_revision_assets_revision
        ON review_document_revision_assets(revision_id, "order");
    CREATE TRIGGER IF NOT EXISTS review_document_revision_assets_immutable
        BEFORE UPDATE ON review_document_revision_assets
        BEGIN SELECT RAISE(ABORT, 'revision assets are immutable'); END;

    -- A reviewer edit: which revision it started from, which it produced, who made it (contract §4). Append-only.
    CREATE TABLE IF NOT EXISTS review_document_edits (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        base_revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        result_revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        actor_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        client_edit_id TEXT,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_edits_client
        ON review_document_edits(document_id, client_edit_id) WHERE client_edit_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_review_document_edits_document
        ON review_document_edits(document_id, created_at);
    CREATE TRIGGER IF NOT EXISTS review_document_edits_append_only
        BEFORE UPDATE ON review_document_edits
        BEGIN SELECT RAISE(ABORT, 'document edits are append-only'); END;`);
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
    migrateMediaColumns(db);
    migrateReplacementLifecycle(db);
    initializeDocumentOutgoing(db);
}

const JSON_COLUMNS = new Set(['metadata', 'payload', 'receipt', 'declaration', 'provenance', 'blocking_task_ids', 'anchor', 'selection_json', 'manifest', 'superseded_review_ids']);
/** JSON columns whose absence reads as null rather than an empty object. */
const NULLABLE_JSON_COLUMNS = new Set(['receipt', 'provenance', 'anchor', 'selection_json', 'manifest']);
const BOOLEAN_COLUMNS = new Set(['requires_review', 'document_created', 'revision_created', 'approval_delegated', 'reviewable']);

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function rowOut(row) {
    if (!row) return null;
    const out = { ...row };
    for (const key of JSON_COLUMNS) {
        if (key in out) out[key] = parseJson(out[key], key === 'blocking_task_ids' ? [] : NULLABLE_JSON_COLUMNS.has(key) ? null : {});
    }
    for (const key of BOOLEAN_COLUMNS) {
        if (typeof out[key] === 'number') out[key] = out[key] !== 0;
    }
    if ('selection_json' in out) { out.selection = out.selection_json; delete out.selection_json; }
    return out;
}

/** Shared FROM/WHERE for the document list, its total and the per-status counts, so all three agree. */
function documentQuery({ id, task_id, project_id, kind, q } = {}, blockingCountSql = '0') {
    const where = [];
    const params = [];
    if (id) { where.push('d.id = ?'); params.push(id); }
    if (task_id) {
        // A document belongs to a task it was first registered under, or to any task whose declared registration reused it.
        where.push('(d.task_id = ? OR d.id IN (SELECT r.document_id FROM review_document_registrations r WHERE r.task_id = ?) OR EXISTS (SELECT 1 FROM json_each(d.blocking_task_ids) WHERE value = ?))');
        params.push(task_id, task_id, task_id);
    }
    if (project_id) {
        // Include consumer projects too, so task links using both filters remain truthful.
        const consumer = blockingCountSql !== '0'
            ? ' OR EXISTS (SELECT 1 FROM json_each(d.blocking_task_ids) required JOIN tasks t ON t.id = required.value WHERE t.project_id = ?)'
            : '';
        where.push(`(d.project_id = ? OR d.id IN (SELECT r.document_id FROM review_document_registrations r WHERE r.project_id = ?)${consumer})`);
        params.push(project_id, project_id);
        if (consumer) params.push(project_id);
    }
    if (kind) { where.push('d.kind = ?'); params.push(kind); }
    if (q) {
        const like = `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
        where.push("(d.title LIKE ? ESCAPE '\\' OR COALESCE(d.purpose, '') LIKE ? ESCAPE '\\' OR d.path LIKE ? ESCAPE '\\')");
        params.push(like, like, like);
    }
    // Alongside the decision-derived review_status: the governing replacement (if any) and whether the row takes review actions now.
    const sql = `SELECT d.*, ${REVIEW_STATUS_SQL} AS review_status, ${blockingCountSql} AS blocking_task_count,
        rp.id AS replacement_id, rp.state AS replacement_state, rp.task_id AS replacement_task_id, rp.attempt AS replacement_attempt,
        CASE WHEN rp.id IS NULL THEN 1 ELSE 0 END AS reviewable
        FROM review_documents d ${LATEST_DECISION_JOIN} ${GOVERNING_REPLACEMENT_JOIN}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
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
    const outgoing = createDocumentOutgoingStore(db);
    const hasTasks = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get());
    const queryDocuments = (filters) => documentQuery(filters, hasTasks()
        ? `CASE WHEN (${REVIEW_STATUS_SQL}) IN ('needs_review', 'changes_requested')
            THEN (SELECT COUNT(DISTINCT t.id) FROM ${WAITING_TASKS_FROM_SQL}) ELSE 0 END`
        : '0');
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
        ...outgoing,
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
            const { sql, params } = queryDocuments(filters);
            // A status is a bucket: a document with open replacement work is `in_progress` and in no decision bucket.
            const statusClause = status && status !== 'all' ? ` WHERE ${LIST_BUCKET_SQL} = ?` : '';
            const all = statusClause ? [...params, status] : params;
            return db.transaction(() => ({
                total: db.prepare(`SELECT COUNT(*) AS n FROM (${sql})${statusClause}`).get(...all).n,
                documents: many(`SELECT * FROM (${sql})${statusClause} ORDER BY blocking_task_count DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`, ...all, limit, offset),
            }))();
        },
        /** Per-bucket counts for the same filters as listDocumentsPage (the four statuses plus in_progress); `all` is their sum. */
        countDocumentsByStatus(filters = {}) {
            const { sql, params } = queryDocuments(filters);
            const counts = Object.fromEntries([...LIST_STATUSES, 'all'].map(status => [status, 0]));
            for (const row of db.prepare(`SELECT ${LIST_BUCKET_SQL} AS bucket, COUNT(*) AS n FROM (${sql}) GROUP BY bucket`).all(...params)) {
                counts[row.bucket] = row.n;
                counts.all += row.n;
            }
            return counts;
        },
        /** The list row of one document (review_status, bucket fields, reviewable), or null. */
        getDocumentListRow(documentId) {
            const { sql, params } = queryDocuments({ id: documentId });
            return one(`SELECT * FROM (${sql})`, ...params);
        },
        getReviewStatus(documentId) {
            const { sql, params } = queryDocuments({ id: documentId });
            return db.prepare(`SELECT review_status FROM (${sql})`).get(...params)?.review_status || null;
        },
        listReviewTaskOptions() {
            if (!hasTasks()) return [];
            return many(`SELECT t.id, t.name AS title, t.status, t.project_id, p.name AS project_name
                FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                WHERE ${ACTIVE_TASK_SQL} ORDER BY p.name COLLATE NOCASE, t.name COLLATE NOCASE, t.id`);
        },
        getBlockingTasks(documentId) {
            if (!hasTasks() || !['needs_review', 'changes_requested'].includes(this.getReviewStatus(documentId))) return [];
            return many(`SELECT DISTINCT t.id, t.name AS title, t.status, t.project_id
                FROM review_documents d, ${WAITING_TASKS_FROM_SQL} AND d.id = ?
                ORDER BY t.name COLLATE NOCASE, t.id`, documentId);
        },
        insertDocument(doc) {
            const ts = now();
            const row = { id: doc.id || randomUUID(), kind: 'document', metadata: {}, ...doc, created_at: ts, updated_at: ts };
            insert('review_documents', row);
            return this.getDocument(row.id);
        },
        updateDocument(id, updates) {
            return db.transaction(() => {
                const before = this.getDocument(id);
                const bindingFields = ['path', 'project_id', 'task_id', 'requires_review', 'intended_action', 'deliverable_key', 'current_revision_id', 'media_type'];
                if (before && (bindingFields.some(key => key in updates && updates[key] !== before[key])
                    || ('metadata' in updates && ['member_id', 'stakeholder_project_id', 'commitment_id', 'source_refs'].some(key =>
                        JSON.stringify(updates.metadata?.[key] ?? null) !== JSON.stringify(before.metadata?.[key] ?? null))))) {
                    outgoing.invalidateOutgoing(id, 'document_binding_changed');
                }
                update('review_documents', id, updates);
                return this.getDocument(id);
            })();
        },

        // ── Revisions ────────────────────────────────────────────────────
        getRevision(id) { return one('SELECT * FROM review_document_revisions WHERE id = ?', id); },
        getRevisionMeta(id) {
            return one(`SELECT id, document_id, content_hash, byte_length, line_count, file_mtime, captured_at,
                media_type, mime_type, source, edited_by, asset_count, width, height FROM review_document_revisions WHERE id = ?`, id);
        },
        findRevisionByHash(documentId, hash) {
            return one('SELECT * FROM review_document_revisions WHERE document_id = ? AND content_hash = ?', documentId, hash);
        },
        insertRevision(rev) {
            const row = { id: rev.id || randomUUID(), captured_at: now(), media_type: 'markdown', mime_type: 'text/markdown', source: 'capture', asset_count: 1, ...rev };
            insert('review_document_revisions', row);
            return this.getRevision(row.id);
        },
        setCurrentRevision(documentId, revisionId) {
            this.updateDocument(documentId, { current_revision_id: revisionId });
        },
        insertRevisionExact(revisionId, exactContent) {
            insert('review_document_revision_exact', { revision_id: revisionId, exact_content: exactContent, created_at: now() });
        },
        /** The exact delivered text of a revision, or null when its normalized content already is exact. */
        getRevisionExact(revisionId) {
            return db.prepare('SELECT exact_content FROM review_document_revision_exact WHERE revision_id = ?').get(revisionId)?.exact_content ?? null;
        },
        listRevisionMeta(documentId) {
            return many(`SELECT id, document_id, content_hash, byte_length, line_count, file_mtime, captured_at,
                media_type, mime_type, source, edited_by, asset_count, width, height
                FROM review_document_revisions WHERE document_id = ? ORDER BY captured_at ASC, rowid ASC`, documentId);
        },
        /** The 1-based version number of a revision within its document (capture order), for "v3" labels. */
        revisionVersion(revisionId) {
            const row = db.prepare(`SELECT COUNT(*) AS n FROM review_document_revisions r, review_document_revisions self
                WHERE self.id = ? AND r.document_id = self.document_id
                  AND (r.captured_at < self.captured_at OR (r.captured_at = self.captured_at AND r.rowid <= self.rowid))`).get(revisionId);
            return row && row.n > 0 ? row.n : null;
        },

        // ── Revision assets (design package members and the primary asset) ─
        insertRevisionAssets(revisionId, documentId, assets) {
            const ts = now();
            for (const asset of assets) {
                insert('review_document_revision_assets', {
                    id: randomUUID(), revision_id: revisionId, document_id: documentId,
                    asset_key: asset.asset_key, role: asset.role, path: asset.path, media_type: asset.media_type, mime_type: asset.mime_type,
                    byte_length: asset.byte_length, content_hash: asset.content_hash, label: asset.label ?? null,
                    direction: asset.direction ?? null, appearance: asset.appearance ?? null, viewport: asset.viewport ?? null, state: asset.state ?? null,
                    before_asset_key: asset.before_asset_key ?? null, order: asset.order ?? 0, width: asset.width ?? null, height: asset.height ?? null,
                    created_at: ts,
                });
            }
        },
        listRevisionAssets(revisionId) {
            return many('SELECT * FROM review_document_revision_assets WHERE revision_id = ? ORDER BY "order" ASC, rowid ASC', revisionId);
        },
        getRevisionAsset(revisionId, assetKey) {
            return one('SELECT * FROM review_document_revision_assets WHERE revision_id = ? AND asset_key = ?', revisionId, assetKey);
        },

        // ── Edits (append-only) ─────────────────────────────────────────
        insertEdit(edit) {
            const row = { id: edit.id || randomUUID(), summary: '', client_edit_id: null, ...edit, created_at: now() };
            insert('review_document_edits', row);
            return one('SELECT * FROM review_document_edits WHERE id = ?', row.id);
        },
        findEditByClientId(documentId, clientEditId) {
            return one('SELECT * FROM review_document_edits WHERE document_id = ? AND client_edit_id = ?', documentId, clientEditId);
        },
        listEdits(documentId) {
            return many('SELECT * FROM review_document_edits WHERE document_id = ? ORDER BY created_at ASC, rowid ASC', documentId);
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
            const { selection, ...rest } = decision;
            const row = { id: decision.id || randomUUID(), note: '', recorded_by: 'operator', provenance: null, selection_json: selection ?? null, ...rest, created_at: now() };
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
        /** Every pending draft of a document, any reviewer: the review requests that replacement work supersedes. */
        listOpenDrafts(documentId) {
            return many("SELECT * FROM document_reviews WHERE document_id = ? AND status = 'draft' ORDER BY created_at ASC, rowid ASC", documentId);
        },
        /**
         * Close every pending draft of a document as superseded by `replacementId`
         * (status 'superseded', closure columns set, comments and summary kept).
         * Returns the ids of the drafts closed. Run inside the acceptance transaction.
         */
        supersedeOpenDrafts(documentId, replacementId, reason = 'superseded') {
            const ids = this.listOpenDrafts(documentId).map(review => review.id);
            if (ids.length) {
                const ts = now();
                db.prepare(`UPDATE document_reviews SET status = 'superseded', closed_at = ?, closed_reason = ?, replacement_id = ?, updated_at = ?
                    WHERE document_id = ? AND status = 'draft'`).run(ts, reason, replacementId, ts, documentId);
            }
            return ids;
        },

        // ── Replacement work items (version lifecycle, task 6b46dcc8) ──────
        getReplacement(id) { return one('SELECT * FROM review_document_replacements WHERE id = ?', id); },
        /** The one open (non-terminal) replacement of a document, or null. */
        findOpenReplacement(documentId) {
            return one(`SELECT * FROM review_document_replacements WHERE document_id = ? AND state IN (${sqlList(REPLACEMENT_OPEN_STATES)})
                ORDER BY created_at DESC, rowid DESC LIMIT 1`, documentId);
        },
        /** Every open replacement across documents, oldest first: list and count reads reconcile these before querying, so a queue agrees with detail without a document being opened. */
        listOpenReplacements() {
            return many(`SELECT * FROM review_document_replacements WHERE state IN (${sqlList(REPLACEMENT_OPEN_STATES)}) ORDER BY created_at ASC, rowid ASC`);
        },
        /** The newest replacement of a document in any state, or null: what the reader explains when nothing is open. */
        latestReplacement(documentId) {
            return one('SELECT * FROM review_document_replacements WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', documentId);
        },
        findReplacementByClientKey(documentId, clientRequestId) {
            return one('SELECT * FROM review_document_replacements WHERE document_id = ? AND client_request_id = ?', documentId, clientRequestId);
        },
        /** The live (open or ready) work item already linked to an originating submission or decision, if any. */
        findLiveReplacementBySource(documentId, { submission_id = null, decision_id = null } = {}) {
            if (submission_id) {
                const hit = one(`SELECT * FROM review_document_replacements WHERE document_id = ? AND source_submission_id = ? AND state NOT IN ('failed', 'cancelled')`, documentId, submission_id);
                if (hit) return hit;
            }
            if (decision_id) {
                return one(`SELECT * FROM review_document_replacements WHERE document_id = ? AND source_decision_id = ? AND state NOT IN ('failed', 'cancelled')`, documentId, decision_id);
            }
            return null;
        },
        /** The newest replacement for an originating submission or decision in any state (the one a recovery must name). */
        latestReplacementBySource(documentId, { submission_id = null, decision_id = null } = {}) {
            return one(`SELECT * FROM review_document_replacements WHERE document_id = ?
                AND ((? IS NOT NULL AND source_submission_id = ?) OR (? IS NOT NULL AND source_decision_id = ?))
                ORDER BY created_at DESC, rowid DESC LIMIT 1`, documentId, submission_id, submission_id, decision_id, decision_id);
        },
        listReplacements(documentId) {
            return many('SELECT * FROM review_document_replacements WHERE document_id = ? ORDER BY created_at DESC, rowid DESC', documentId);
        },
        /** The replacement whose registered result is this revision, if any (the newest when several name it). */
        findReplacementByResult(documentId, revisionId) {
            return one('SELECT * FROM review_document_replacements WHERE document_id = ? AND result_revision_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', documentId, revisionId);
        },
        listReplacementsForTask(taskId) {
            return many('SELECT * FROM review_document_replacements WHERE task_id = ? ORDER BY created_at DESC, rowid DESC', taskId);
        },
        insertReplacement(replacement) {
            const ts = now();
            const row = { id: replacement.id || randomUUID(), state: 'accepted', attempt: 1, superseded_review_ids: [], ...replacement, created_at: ts, updated_at: ts };
            insert('review_document_replacements', row);
            return this.getReplacement(row.id);
        },
        updateReplacement(id, updates) { update('review_document_replacements', id, updates); return this.getReplacement(id); },

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
        deleteComment(id) {
            return db.transaction(() => {
                db.prepare('DELETE FROM document_review_comments WHERE parent_id = ?').run(id);
                return db.prepare('DELETE FROM document_review_comments WHERE id = ?').run(id).changes;
            })();
        },

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

module.exports = {
    initializeDocumentReviews, createDocumentReviewStore, REVIEW_STATUSES, LIST_STATUSES,
    REPLACEMENT_STATES, REPLACEMENT_OPEN_STATES, REPLACEMENT_TERMINAL_STATES,
};
