/**
 * Retiring review documents that a later deliverable replaces (2026-11-19,
 * task d9f46e2f; contract docs/contracts/document-review-deliverables.md §13).
 *
 * A registration may name the waiting review documents it replaces, by
 * document id, deliverable key or exact path. Each name is a row of
 * `review_document_supersessions` on the replacing document, with its
 * outcome. Nothing is ever matched by title, project or age: a name resolves
 * to a document only through one of those three exact identities.
 *
 * Robert's ruling on 2026-11-19 (option A): a named document is retired only
 * once the replacing document is itself waiting for his review and ready to
 * view. Until then the name is `pending`, and it is applied the moment the
 * replacing document enters his queue (the route decides that gate, since
 * readiness of visual media is a route-level check).
 *
 * Retiring moves the named document from its review bucket into Reference by
 * clearing `requires_review`, exactly the state of a document with no review
 * request. It records no decision (approve, request changes or anything
 * else), so no consumer can act on its intended action, and it leaves the
 * document's waiting-task list, decisions and drafts untouched so the existing
 * request-review call restores the earlier state. The record of each
 * retirement (`review_document_retirements`) is immutable except for its
 * reopening, and it stays with the document after a reopen.
 *
 * A named document stays waiting, with every reason recorded, when it has
 * open replacement work, an outgoing message that is not sent, draft review
 * comments not yet submitted, active tasks waiting on it, or an agent review
 * waiting for Robert's choices (that last one keeps it in Needs your review
 * whatever its review requirement, so retiring could not move it anyway).
 *
 * The methods are spread into the review store (db/document-reviews.js) and
 * use its document, draft, outgoing and waiting-task readers through `this`.
 */
const { randomUUID } = require('crypto');

const now = () => new Date().toISOString();

/** How a registration may name a document it replaces: exact identities only. */
const NAME_FIELDS = ['document_id', 'deliverable_key', 'path'];
/**
 * The outcome of one name:
 *   pending       the replacing document is not yet waiting for review and ready; applied when it is
 *   retired       the named document was moved to Reference by this name (terminal: only Robert's request-review undoes it)
 *   left_waiting  the named document has a reason to stay in the queue (reasons say which)
 *   not_found     no document has that id, key or path
 *   not_waiting   the named document is already out of the queue (reference, already retired or approved)
 *   self          the name is the replacing document itself
 *   ambiguous     the path names several documents; name one by id or key
 */
const SUPERSESSION_OUTCOMES = ['pending', 'retired', 'left_waiting', 'not_found', 'not_waiting', 'self', 'ambiguous'];
/** Outgoing message states that are not sent yet (a draft, an approved grant not yet claimed, a send in flight or uncertain). */
const UNSENT_OUTGOING = new Set(['draft', 'approved', 'delivering', 'uncertain']);
/** List buckets a named document can be retired from. `in_progress` is waiting too, but its open work keeps it there. */
const WAITING_BUCKETS = new Set(['needs_review', 'changes_requested', 'in_progress']);

const sqlList = values => values.map(value => `'${value}'`).join(', ');

function initializeDocumentRetirements(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_document_supersessions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        named_by TEXT NOT NULL CHECK (named_by IN (${sqlList(NAME_FIELDS)})),
        named_value TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN (${sqlList(SUPERSESSION_OUTCOMES)})),
        reasons TEXT NOT NULL DEFAULT '[]',
        target_document_id TEXT,
        candidate_ids TEXT NOT NULL DEFAULT '[]',
        retirement_id TEXT,
        registration_id TEXT,
        revision_id TEXT,
        task_id TEXT,
        declared_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evaluated_at TEXT
    );
    -- A name is one row per replacing document; naming it again re-evaluates that row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_supersessions_name
        ON review_document_supersessions(document_id, named_by, named_value);
    CREATE INDEX IF NOT EXISTS idx_review_document_supersessions_pending
        ON review_document_supersessions(outcome, document_id);
    CREATE INDEX IF NOT EXISTS idx_review_document_supersessions_target
        ON review_document_supersessions(target_document_id);

    CREATE TABLE IF NOT EXISTS review_document_retirements (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        replaced_by_document_id TEXT NOT NULL,
        replaced_by_revision_id TEXT,
        supersession_id TEXT NOT NULL,
        registration_id TEXT,
        task_id TEXT,
        named_by TEXT NOT NULL,
        named_value TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK (trigger IN ('registration', 'review_requested', 'ready')),
        retired_by TEXT NOT NULL,
        retired_at TEXT NOT NULL,
        previous TEXT NOT NULL,
        reopened_at TEXT,
        reopened_by TEXT,
        reopened_via TEXT CHECK (reopened_via IS NULL OR reopened_via IN ('request_review', 'registration')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    -- At most one retirement in force per document.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_document_retirements_open
        ON review_document_retirements(document_id) WHERE reopened_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_review_document_retirements_document
        ON review_document_retirements(document_id, retired_at);
    CREATE INDEX IF NOT EXISTS idx_review_document_retirements_replaced_by
        ON review_document_retirements(replaced_by_document_id);
    -- The record of what was retired, when, by which registration and task, and its previous state never changes;
    -- only its reopening is written, once.
    CREATE TRIGGER IF NOT EXISTS review_document_retirements_immutable
        BEFORE UPDATE OF id, document_id, replaced_by_document_id, replaced_by_revision_id, supersession_id, registration_id,
            task_id, named_by, named_value, trigger, retired_by, retired_at, previous, created_at
        ON review_document_retirements
        BEGIN SELECT RAISE(ABORT, 'a retirement record is immutable; only its reopening is recorded'); END;
    CREATE TRIGGER IF NOT EXISTS review_document_retirements_reopen_once
        BEFORE UPDATE OF reopened_at, reopened_by, reopened_via ON review_document_retirements
        WHEN OLD.reopened_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'a retirement is reopened once'); END;`);
}

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function supersessionOut(row) {
    if (!row) return null;
    return { ...row, reasons: parseJson(row.reasons, []), candidate_ids: parseJson(row.candidate_ids, []) };
}

function retirementOut(row) {
    if (!row) return null;
    return { ...row, previous: parseJson(row.previous, {}) };
}

/** A human-readable reason a named document stays in the queue, with the facts it rests on. */
function reason(code, message, details = {}) {
    return { code, message, ...details };
}

function createDocumentRetirementStore(db) {
    return {
        // ── Names a registration declared (the replacing document's side) ─────
        getSupersession(id) { return supersessionOut(db.prepare('SELECT * FROM review_document_supersessions WHERE id = ?').get(id)); },
        /** Every name a document's registrations declared, oldest first. */
        listSupersessions(documentId) {
            return db.prepare('SELECT * FROM review_document_supersessions WHERE document_id = ? ORDER BY created_at ASC, rowid ASC')
                .all(documentId).map(supersessionOut);
        },
        /** Names that resolved to this document from other documents, oldest first (shown on the named document's page). */
        listSupersessionsTargeting(documentId) {
            return db.prepare('SELECT * FROM review_document_supersessions WHERE target_document_id = ? AND document_id != ? ORDER BY created_at ASC, rowid ASC')
                .all(documentId, documentId).map(supersessionOut);
        },
        /** Replacing documents that still hold pending names: lists and counts apply them before reading. */
        listPendingSuccessorIds() {
            return db.prepare("SELECT DISTINCT document_id FROM review_document_supersessions WHERE outcome = 'pending' ORDER BY document_id").all()
                .map(row => row.document_id);
        },
        hasPendingSupersessions(documentId) {
            return Boolean(db.prepare("SELECT 1 FROM review_document_supersessions WHERE document_id = ? AND outcome = 'pending' LIMIT 1").get(documentId));
        },
        /**
         * Record that a registration of `documentId` names something it replaces.
         * A name already declared keeps its row: a retired one is left exactly as
         * it is (only Robert's request-review undoes a retirement, and a later
         * registration naming it again must not undo his reopening); any other
         * outcome is reset to pending under the newest registration, to be
         * evaluated by the caller. Run inside the registration transaction.
         */
        declareSupersession({ document_id, named_by, named_value, registration_id = null, revision_id = null, task_id = null, declared_by }) {
            if (!NAME_FIELDS.includes(named_by)) throw new Error(`unknown name field ${named_by}`);
            const existing = db.prepare('SELECT * FROM review_document_supersessions WHERE document_id = ? AND named_by = ? AND named_value = ?')
                .get(document_id, named_by, named_value);
            const ts = now();
            if (existing) {
                if (existing.outcome !== 'retired') {
                    db.prepare(`UPDATE review_document_supersessions SET outcome = 'pending', reasons = '[]', candidate_ids = '[]',
                        registration_id = ?, revision_id = ?, task_id = ?, declared_by = ?, updated_at = ? WHERE id = ?`)
                        .run(registration_id, revision_id, task_id, declared_by, ts, existing.id);
                }
                return this.getSupersession(existing.id);
            }
            const id = randomUUID();
            db.prepare(`INSERT INTO review_document_supersessions (id, document_id, named_by, named_value, outcome, registration_id, revision_id, task_id,
                declared_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
                .run(id, document_id, named_by, named_value, registration_id, revision_id, task_id, declared_by, ts, ts);
            return this.getSupersession(id);
        },
        /** Store the evaluated outcome of a name (never `retired`: retireDocument writes that, with its record). */
        settleSupersession(id, { outcome, reasons = [], target_document_id = null, candidate_ids = [] }) {
            if (!SUPERSESSION_OUTCOMES.includes(outcome) || outcome === 'retired') throw new Error(`cannot settle a name as ${outcome}`);
            const ts = now();
            db.prepare(`UPDATE review_document_supersessions SET outcome = ?, reasons = ?, target_document_id = ?, candidate_ids = ?, updated_at = ?, evaluated_at = ?
                WHERE id = ? AND outcome != 'retired'`)
                .run(outcome, JSON.stringify(reasons), target_document_id, JSON.stringify(candidate_ids), ts, ts, id);
            return this.getSupersession(id);
        },

        // ── Whether a named document may leave the queue ──────────────────────
        /** Documents registered at this exact path (one per task); a path naming several is ambiguous. */
        findDocumentsByPath(filePath) {
            return db.prepare('SELECT id FROM review_documents WHERE path = ? ORDER BY created_at ASC, id ASC').all(filePath).map(row => this.getDocument(row.id));
        },
        /** Draft review rounds of a document holding anything not yet submitted: comments, a summary or decision answers. */
        listUnsubmittedDrafts(documentId) {
            return this.listOpenDrafts(documentId).map(review => ({
                review,
                comment_count: this.listComments(review.id).length,
                answer_count: Array.isArray(review.decision_answers) ? review.decision_answers.length : 0,
            })).filter(draft => draft.comment_count > 0 || draft.answer_count > 0 || String(draft.review.summary || '').trim());
        },
        /**
         * Decide what retiring `doc` would do, from its state now. Never looks at
         * titles, projects or dates. Returns
         *   { outcome: 'not_waiting', reasons }   already out of the queue
         *   { outcome: 'left_waiting', reasons }  stays, every reason listed
         *   { outcome: 'retirable', row }         may move to Reference
         */
        retirementCheck(doc) {
            const row = this.getDocumentListRow(doc.id);
            const bucket = row.replacement_id ? 'in_progress' : row.agent_review_ready ? 'needs_review' : row.review_status;
            if (!WAITING_BUCKETS.has(bucket)) {
                const open = this.findOpenRetirement(doc.id);
                const reasons = open
                    ? [reason('already_retired', 'It was already moved to Reference when another document replaced it', { replaced_by_document_id: open.replaced_by_document_id, retired_at: open.retired_at })]
                    : bucket === 'approved'
                        ? [reason('approved', 'It is already approved, so it is not waiting for your review')]
                        : [reason('reference', 'It is a reference document, not waiting for your review')];
                return { outcome: 'not_waiting', reasons, bucket };
            }
            const reasons = [];
            if (row.replacement_id) {
                reasons.push(reason('replacement_in_progress', `Replacement work on it is ${row.replacement_state}${row.replacement_task_id ? ` (task ${row.replacement_task_id})` : ''}; it stays until that work is finished`,
                    { replacement_id: row.replacement_id, replacement_state: row.replacement_state, task_id: row.replacement_task_id || null }));
            }
            const outgoing = this.getOutgoing(doc.id);
            if (outgoing && UNSENT_OUTGOING.has(outgoing.status)) {
                reasons.push(reason('outgoing_unsent', `It has an outgoing message that is not sent (${outgoing.status})`, { outgoing_status: outgoing.status }));
            }
            const drafts = this.listUnsubmittedDrafts(doc.id);
            if (drafts.length) {
                const comments = drafts.reduce((n, d) => n + d.comment_count, 0);
                reasons.push(reason('draft_comments', `It has review comments not yet submitted (${comments} comment${comments === 1 ? '' : 's'} in ${drafts.length} draft${drafts.length === 1 ? '' : 's'}); they are never discarded`,
                    { review_ids: drafts.map(d => d.review.id), comment_count: comments }));
            }
            const waiting = this.getBlockingTasks(doc.id);
            if (waiting.length) {
                reasons.push(reason('waiting_tasks', `${waiting.length === 1 ? 'A task is' : `${waiting.length} tasks are`} waiting on it: ${waiting.map(t => t.title || t.id).join('; ')}`,
                    { task_ids: waiting.map(t => t.id) }));
            }
            if (row.agent_review_ready) {
                reasons.push(reason('agent_review_waiting', "An agent's review of this version is waiting for your choices"));
            }
            return reasons.length ? { outcome: 'left_waiting', reasons, bucket } : { outcome: 'retirable', row, bucket };
        },

        // ── Retirement records (the retired document's side) ──────────────────
        getRetirement(id) { return retirementOut(db.prepare('SELECT * FROM review_document_retirements WHERE id = ?').get(id)); },
        findOpenRetirement(documentId) {
            return retirementOut(db.prepare('SELECT * FROM review_document_retirements WHERE document_id = ? AND reopened_at IS NULL').get(documentId));
        },
        /** Every retirement of a document, newest first, reopened ones included. */
        listRetirements(documentId) {
            return db.prepare('SELECT * FROM review_document_retirements WHERE document_id = ? ORDER BY retired_at DESC, rowid DESC').all(documentId).map(retirementOut);
        },
        /** Documents closed by hand (metadata.review_closed, 2026-11-18/19) that named this document as their replacement. */
        listManualClosesReplacedBy(documentId) {
            return db.prepare("SELECT id FROM review_documents WHERE json_extract(metadata, '$.review_closed.superseded_by') = ? ORDER BY created_at ASC, id ASC")
                .all(documentId).map(row => this.getDocument(row.id));
        },
        /**
         * Move `target` out of its review bucket into Reference on behalf of the
         * name `supersession`, after retirementCheck said it may. Clears only
         * `requires_review`; decisions, drafts, waiting tasks and the intended
         * action are left as they are, and no decision row is written. Run
         * inside the caller's transaction, which re-read the target.
         */
        retireDocument({ target, successor, supersession, trigger, bucket }) {
            const ts = now();
            const id = randomUUID();
            const previous = {
                requires_review: target.requires_review === true,
                review_status: this.getReviewStatus(target.id),
                list_bucket: bucket,
                blocking_task_ids: target.blocking_task_ids || [],
                intended_action: target.intended_action || 'none',
                current_revision_id: target.current_revision_id || null,
            };
            db.prepare(`INSERT INTO review_document_retirements (id, document_id, replaced_by_document_id, replaced_by_revision_id, supersession_id,
                registration_id, task_id, named_by, named_value, trigger, retired_by, retired_at, previous, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, target.id, successor.id, successor.current_revision_id || supersession.revision_id || null, supersession.id,
                    supersession.registration_id || null, supersession.task_id || null, supersession.named_by, supersession.named_value, trigger,
                    supersession.declared_by, ts, JSON.stringify(previous), ts, ts);
            this.updateDocument(target.id, { requires_review: false });
            db.prepare(`UPDATE review_document_supersessions SET outcome = 'retired', reasons = '[]', candidate_ids = '[]', target_document_id = ?, retirement_id = ?,
                updated_at = ?, evaluated_at = ? WHERE id = ?`).run(target.id, id, ts, ts, supersession.id);
            return this.getRetirement(id);
        },
        /**
         * Record that a retired document is back in the queue: Robert's request-review (`request_review`), or a
         * registration of new bytes for review (`registration`). The retirement record itself stays. Returns it, or
         * null when none was in force.
         */
        reopenRetirement(documentId, actorId, via = 'request_review') {
            const open = this.findOpenRetirement(documentId);
            if (!open) return null;
            const ts = now();
            db.prepare('UPDATE review_document_retirements SET reopened_at = ?, reopened_by = ?, reopened_via = ?, updated_at = ? WHERE id = ?')
                .run(ts, actorId || 'unknown', via, ts, open.id);
            return this.getRetirement(open.id);
        },
    };
}

module.exports = { initializeDocumentRetirements, createDocumentRetirementStore, NAME_FIELDS, SUPERSESSION_OUTCOMES };
