/**
 * Migration of a database created by the 2026-09-10 document review schema
 * (frozen below, byte-for-byte the DDL that shipped before declared
 * deliverables) through the real db facade. Legacy documents, revisions,
 * drafts, comments and the feedback outbox must survive untouched, legacy
 * documents must come through as reference documents (no review required,
 * even when their free-form metadata says otherwise), and the queued feedback
 * must still deliver. Isolated NEXUS_DB_PATH; the Praxis relay is a stub.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const LEGACY_SCHEMA = `CREATE TABLE IF NOT EXISTS review_documents (
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
        ON document_review_submissions(delivery_status, next_attempt_at);`;

const T0 = '2026-09-22T12:00:00.000Z';
const T1 = '2026-09-23T12:00:00.000Z';
const LEGACY_METADATA = { deliverable_type: 'stakeholder_email_draft', requires_review: true, delivery_status: 'not_sent' };
const RECEIPT = { conversation_id: 'conv-1', user_message_id: 'docreview:sub-done', assistant_message_id: 'docreview:sub-done:reply', delivered_at: T1 };

let workspace;
let dbPath;

function seedLegacyDatabase() {
    const raw = new Database(dbPath);
    raw.exec(LEGACY_SCHEMA);
    const insert = (table, row) => raw.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
    insert('review_documents', { id: 'doc-legacy', title: 'Elizabeth update (draft)', path: '/projects/Praxis/docs/draft.md', root_project_id: 'proj-praxis', project_id: 'proj-meeple', task_id: 'task-prep', kind: 'document', metadata: JSON.stringify(LEGACY_METADATA), current_revision_id: 'rev-2', registered_by: 'local_user', created_at: T0, updated_at: T1 });
    insert('review_documents', { id: 'doc-report', title: 'Readiness report', path: '/projects/Praxis/docs/report.md', root_project_id: 'proj-praxis', project_id: 'proj-praxis', task_id: null, kind: 'report', metadata: '{}', current_revision_id: 'rev-r', registered_by: 'local_user', created_at: T0, updated_at: T0 });
    insert('review_document_revisions', { id: 'rev-1', document_id: 'doc-legacy', content_hash: 'h1', content: '# Draft v1\n', byte_length: 11, line_count: 2, file_mtime: T0, captured_at: T0 });
    insert('review_document_revisions', { id: 'rev-2', document_id: 'doc-legacy', content_hash: 'h2', content: '# Draft v2\n', byte_length: 11, line_count: 2, file_mtime: T1, captured_at: T1 });
    insert('review_document_revisions', { id: 'rev-r', document_id: 'doc-report', content_hash: 'hr', content: '# Report\n', byte_length: 9, line_count: 2, file_mtime: T0, captured_at: T0 });
    insert('document_reviews', { id: 'rv-done', document_id: 'doc-legacy', revision_id: 'rev-1', reviewer_id: 'local_user', status: 'submitted', summary: 'Shorter please.', created_at: T0, updated_at: T0, submitted_at: T0 });
    insert('document_reviews', { id: 'rv-queued', document_id: 'doc-report', revision_id: 'rev-r', reviewer_id: 'local_user', status: 'submitted', summary: '', created_at: T1, updated_at: T1, submitted_at: T1 });
    insert('document_reviews', { id: 'rv-draft', document_id: 'doc-legacy', revision_id: 'rev-2', reviewer_id: 'local_user', status: 'draft', summary: 'In progress', created_at: T1, updated_at: T1, submitted_at: null });
    insert('document_review_comments', { id: 'c-1', review_id: 'rv-done', client_id: 'cl-1', kind: 'passage', start_line: 1, end_line: 1, block_hash: 'bh', quote: '# Draft v1', selection: null, body: 'Retitle.', created_at: T0, updated_at: T0 });
    insert('document_review_comments', { id: 'c-2', review_id: 'rv-draft', client_id: null, kind: 'document', start_line: null, end_line: null, block_hash: null, quote: null, selection: null, body: 'Still reading.', created_at: T1, updated_at: T1 });
    insert('document_review_submissions', { id: 'sub-done', review_id: 'rv-done', document_id: 'doc-legacy', revision_id: 'rev-1', payload: JSON.stringify({ document: { id: 'doc-legacy', project_id: 'proj-meeple' }, comments: [{ body: 'Retitle.' }] }), message_text: '[DOCUMENT REVIEW] done', delivery_status: 'delivered', delivery_attempts: 1, next_attempt_at: null, relay_started_at: null, last_error: null, delivered_at: T1, receipt: JSON.stringify(RECEIPT), created_at: T0, updated_at: T1 });
    insert('document_review_submissions', { id: 'sub-queued', review_id: 'rv-queued', document_id: 'doc-report', revision_id: 'rev-r', payload: JSON.stringify({ document: { id: 'doc-report', title: 'Readiness report', project_id: 'proj-praxis' }, comments: [] }), message_text: '[DOCUMENT REVIEW] queued', delivery_status: 'queued', delivery_attempts: 0, next_attempt_at: T0, relay_started_at: null, last_error: null, delivered_at: null, receipt: null, created_at: T1, updated_at: T1 });
    raw.close();
}

function snapshot() {
    const raw = new Database(dbPath, { readonly: true });
    const legacyColumns = 'id, title, path, root_project_id, project_id, task_id, kind, metadata, current_revision_id, registered_by, created_at, updated_at';
    // The 2026-10-04 migration adds approval_delegated and submitted_authority to document_reviews (defaults covered below).
    const legacyReviewColumns = 'id, document_id, revision_id, reviewer_id, status, summary, submitted_at, created_at, updated_at';
    const out = {
        documents: raw.prepare(`SELECT ${legacyColumns} FROM review_documents ORDER BY id`).all(),
        revisions: raw.prepare('SELECT * FROM review_document_revisions ORDER BY id').all(),
        reviews: raw.prepare(`SELECT ${legacyReviewColumns} FROM document_reviews ORDER BY id`).all(),
        comments: raw.prepare('SELECT * FROM document_review_comments ORDER BY id').all(),
        submissions: raw.prepare("SELECT * FROM document_review_submissions WHERE id = 'sub-done'").all(),
    };
    raw.close();
    return out;
}

beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-doc-migration-'));
    dbPath = path.join(workspace, 'nexus.db');
    process.env.NEXUS_DB_PATH = dbPath;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.resetModules();
});

afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.NEXUS_DB_PATH;
    jest.resetModules();
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('legacy documents, revisions, comments and feedback deliveries survive migration as reference documents', async () => {
    seedLegacyDatabase();
    const before = snapshot();
    const db = require('../../db');
    const store = db.documentReviews;

    // Every legacy row is byte-identical after the migration ran.
    expect(snapshot()).toEqual(before);
    const legacy = store.getDocument('doc-legacy');
    expect(legacy).toMatchObject({ requires_review: false, intended_action: 'none', purpose: null, deliverable_key: null, metadata: LEGACY_METADATA });
    expect(store.getReviewStatus('doc-legacy')).toBe('reference');
    expect(store.countDocumentsByStatus()).toEqual({ needs_review: 0, changes_requested: 0, approved: 0, reference: 2, all: 2 });
    const page = store.listDocumentsPage({ status: 'reference' });
    expect(page.total).toBe(2);
    expect(page.documents.map(d => d.id).sort()).toEqual(['doc-legacy', 'doc-report']);
    expect(store.listDocumentsPage({ status: 'needs_review' }).total).toBe(0);
    expect(store.listRevisionMeta('doc-legacy').map(r => r.id)).toEqual(['rev-1', 'rev-2']);
    expect(store.getRevision('rev-1').content).toBe('# Draft v1\n');
    expect(store.listComments('rv-done').map(c => c.body)).toEqual(['Retitle.']);
    expect(store.findOpenDraft('doc-legacy', 'local_user')).toMatchObject({ id: 'rv-draft', summary: 'In progress' });
    expect(store.getSubmission('sub-done')).toMatchObject({ delivery_status: 'delivered', receipt: RECEIPT });
    expect(store.listDecisions('doc-legacy')).toEqual([]);
    expect(store.listRegistrations('doc-legacy')).toEqual([]);

    // The feedback outbox still delivers a submission queued before the migration.
    const relay = jest.fn(async () => ({ response: 'Noted.' }));
    const worker = require('../services/document-review-delivery').createDocumentReviewDelivery({ db, relay, intervalMs: 0 });
    const delivered = await worker.deliver('sub-queued');
    expect(delivered).toMatchObject({ delivery_status: 'delivered', delivery_attempts: 1 });
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0][0]).toBe('[DOCUMENT REVIEW] queued');
});

test('the migration is idempotent across restarts and makes revisions immutable and decisions append-only', async () => {
    seedLegacyDatabase();
    require('../../db');
    jest.resetModules();
    const db = require('../../db');
    expect(db.documentReviews.countDocumentsByStatus().all).toBe(2);

    const raw = new Database(dbPath);
    try {
        const columns = raw.prepare('PRAGMA table_info(review_documents)').all().map(c => c.name);
        expect(columns.filter(name => ['deliverable_key', 'purpose', 'requires_review', 'intended_action'].includes(name))).toHaveLength(4);
        expect(() => raw.prepare("UPDATE review_document_revisions SET content = 'tampered' WHERE id = 'rev-1'").run()).toThrow(/immutable/);
        raw.prepare("INSERT INTO review_document_decisions (id, document_id, revision_id, content_hash, decision, actor_id, authority, created_at) VALUES ('d-1', 'doc-legacy', 'rev-2', 'h2', 'approve', 'local_user', 'operator_credential', ?)").run(T1);
        expect(() => raw.prepare("UPDATE review_document_decisions SET revision_id = 'rev-1' WHERE id = 'd-1'").run()).toThrow(/append-only/);
        expect(() => raw.prepare("INSERT INTO review_document_decisions (id, document_id, revision_id, content_hash, decision, actor_id, authority, created_at) VALUES ('d-2', 'doc-legacy', 'rev-2', 'h2', 'send', 'local_user', 'x', ?)").run(T1)).toThrow(/CHECK/);
    } finally {
        raw.close();
    }
    // A legacy document keeps reading as reference even with a stray decision row: requires_review stays off.
    expect(db.documentReviews.getReviewStatus('doc-legacy')).toBe('reference');
    expect(db.documentReviews.getRevision('rev-1').content).toBe('# Draft v1\n');
});

// The decisions table exactly as the 2026-10-02 contract shipped it, before executor-recorded approvals added
// recorded_by and provenance (2026-10-04). The live database of 2026-10-04 holds decisions in this shape.
const DECISIONS_2026_10_02 = `CREATE TABLE IF NOT EXISTS review_document_decisions (
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
        BEGIN SELECT RAISE(ABORT, 'document decisions are append-only'); END;`;

test('decisions recorded before executor-recorded approvals existed read as direct operator decisions; the added columns are idempotent and stay append-only', async () => {
    seedLegacyDatabase();
    let raw = new Database(dbPath);
    raw.exec(DECISIONS_2026_10_02);
    raw.prepare("INSERT INTO review_document_decisions (id, document_id, revision_id, content_hash, decision, actor_id, authority, note, client_decision_id, intended_action, created_at) VALUES ('d-robert', 'doc-legacy', 'rev-2', 'h2', 'approve', 'local_user', 'access_device', '', 'robert-click-1', 'none', ?)").run(T1);
    raw.close();

    const db = require('../../db');
    const store = db.documentReviews;
    raw = new Database(dbPath);
    try {
        const columns = raw.prepare('PRAGMA table_info(review_document_decisions)').all().map(c => c.name);
        expect(columns.filter(name => ['recorded_by', 'provenance'].includes(name))).toEqual(['recorded_by', 'provenance']);
        // The row Robert recorded by hand is untouched and reads as his own decision.
        expect(raw.prepare("SELECT id, authority, recorded_by, provenance FROM review_document_decisions WHERE id = 'd-robert'").get())
            .toEqual({ id: 'd-robert', authority: 'access_device', recorded_by: 'operator', provenance: null });
        expect(store.getDecision('d-robert')).toMatchObject({ decision: 'approve', authority: 'access_device', recorded_by: 'operator', provenance: null, client_decision_id: 'robert-click-1' });
        expect(store.latestDecision('doc-legacy').id).toBe('d-robert');
        expect(store.findDecisionBySourceReview('doc-legacy', 'rv-done')).toBeNull();

        // An executor-recorded row is found through the review it cites; the trigger still refuses any rewrite, new columns included.
        const recorded = store.insertDecision({
            document_id: 'doc-legacy', revision_id: 'rev-2', content_hash: 'h2', decision: 'approve', actor_id: 'local_user', authority: 'operator_credential',
            recorded_by: 'executor', provenance: { executor: { id: 'praxis-claude-code:test' }, source: { review_id: 'rv-done', submission_id: 'sub-done', instruction: 'Shorter please.' } },
        });
        expect(recorded).toMatchObject({ recorded_by: 'executor', provenance: { source: { review_id: 'rv-done', submission_id: 'sub-done' } } });
        expect(store.findDecisionBySourceReview('doc-legacy', 'rv-done')).toMatchObject({ id: recorded.id });
        expect(store.listDecisionsSince('doc-legacy', T1).map(d => d.id)).toEqual(['d-robert', recorded.id]);
        expect(store.listDecisionsSince('doc-legacy', recorded.created_at).map(d => d.id)).toEqual([recorded.id]);
        expect(() => raw.prepare("UPDATE review_document_decisions SET recorded_by = 'executor' WHERE id = 'd-robert'").run()).toThrow(/append-only/);
        expect(() => raw.prepare("UPDATE review_document_decisions SET provenance = NULL WHERE id = ?").run(recorded.id)).toThrow(/append-only/);
    } finally {
        raw.close();
    }

    // A restart runs the migration again without error and without duplicating anything.
    jest.resetModules();
    const again = require('../../db');
    raw = new Database(dbPath, { readonly: true });
    try {
        const columns = raw.prepare('PRAGMA table_info(review_document_decisions)').all().map(c => c.name);
        expect(columns.filter(name => ['recorded_by', 'provenance'].includes(name))).toHaveLength(2);
    } finally {
        raw.close();
    }
    expect(again.documentReviews.listDecisions('doc-legacy')).toHaveLength(2);
    expect(again.documentReviews.getDecision('d-robert').recorded_by).toBe('operator');
});

test('reviews finished before the delegation grant existed read as not delegated and cannot be the source of an executor-recorded approval; the review columns are idempotent', async () => {
    seedLegacyDatabase();
    const db = require('../../db');
    const store = db.documentReviews;
    let raw = new Database(dbPath, { readonly: true });
    try {
        const columns = raw.prepare('PRAGMA table_info(document_reviews)').all().map(c => c.name);
        expect(columns.filter(name => ['submitted_authority', 'approval_delegated'].includes(name))).toEqual(['submitted_authority', 'approval_delegated']);
        // Robert's legacy submitted review is untouched: no operator proof recorded, no grant.
        expect(raw.prepare("SELECT status, summary, submitted_authority, approval_delegated FROM document_reviews WHERE id = 'rv-done'").get())
            .toEqual({ status: 'submitted', summary: 'Shorter please.', submitted_authority: null, approval_delegated: 0 });
    } finally {
        raw.close();
    }
    expect(store.getReview('rv-done')).toMatchObject({ status: 'submitted', submitted_at: T0, approval_delegated: false, submitted_authority: null });

    const { resolveSourceReview, reviewDelegatesApproval } = require('../services/document-decision-provenance');
    const doc = store.getDocument('doc-legacy');
    const executor = { id: 'praxis-claude-code:test', source_review_id: 'rv-done' };
    const cite = () => resolveSourceReview({ store, doc, revision: store.getRevisionMeta('rev-2'), executor });
    expect(reviewDelegatesApproval(store.getReview('rv-done'))).toBe(false);
    expect(cite()).toMatchObject({ ok: false, status: 403, code: 'source_review_not_delegated', source_review_id: 'rv-done', approval_delegated: false, submitted_authority: null });

    // The grant counts only together with an operator proof; the boolean survives the round trip.
    store.updateReview('rv-done', { approval_delegated: true, submitted_authority: null });
    expect(store.getReview('rv-done')).toMatchObject({ approval_delegated: true, submitted_authority: null });
    expect(cite()).toMatchObject({ ok: false, code: 'source_review_not_delegated' });
    store.updateReview('rv-done', { approval_delegated: false, submitted_authority: 'access_user' });
    expect(cite()).toMatchObject({ ok: false, code: 'source_review_not_delegated' });
    store.updateReview('rv-done', { approval_delegated: true, submitted_authority: 'document_executor_credential' });
    expect(cite()).toMatchObject({ ok: false, code: 'source_review_not_delegated' });
    store.updateReview('rv-done', { approval_delegated: true, submitted_authority: 'access_user' });
    expect(reviewDelegatesApproval(store.getReview('rv-done'))).toBe(true);
    expect(cite()).toMatchObject({ ok: true, review: { id: 'rv-done', approval_delegated: true, submitted_authority: 'access_user' }, pinned: { id: 'rev-1' } });

    // A restart runs the migration again without error.
    jest.resetModules();
    require('../../db');
    raw = new Database(dbPath, { readonly: true });
    try {
        const columns = raw.prepare('PRAGMA table_info(document_reviews)').all().map(c => c.name);
        expect(columns.filter(name => ['submitted_authority', 'approval_delegated'].includes(name))).toHaveLength(2);
    } finally {
        raw.close();
    }
});
