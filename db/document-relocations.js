/**
 * Moving a document's registration to the file's landed location (2026-11-24,
 * task ec3e1d0c; contract docs/contracts/document-review-deliverables.md §14).
 *
 * A Praxis run writes its documents in its own Git worktree and registers them
 * there. When the run lands, its commits reach the checkout of the target
 * branch and the worktree is removed, so a registration that still names the
 * worktree path points at a file that no longer exists: the document stays
 * readable from its captured revision, but nothing can be decided on it.
 *
 * `relocateDocument` moves one registration from the worktree path to the
 * landed path. It is one compare-and-set in one immediate transaction: the
 * document must still be registered at the path the caller saw, on the
 * revision the caller hashed the landed file against. It changes only the
 * document's path, its root project and (for a `path:` key, which names the
 * path) its deliverable key. The document id, revisions, decisions, reviews,
 * comments, drafts, replacements, retirements, review requirement and waiting
 * tasks are untouched, no revision is recorded, and an outgoing grant (bound to
 * the revision and its exact bytes, never the path) stays in force.
 *
 * Each move is recorded once in `review_document_relocations`, which is
 * append-only. A repeated call changes nothing: the document is no longer at
 * the old path, so the compare-and-set does not match, and the record of the
 * earlier move answers for it.
 *
 * The methods are spread into the review store (db/document-reviews.js) and use
 * its document readers through `this`.
 */
const { randomUUID } = require('crypto');

const now = () => new Date().toISOString();

/**
 * Why a registration was not moved by the store (the route adds the outcomes
 * it decides before calling it: the landed file is missing, unreadable or holds
 * other bytes):
 *   not_found         no document has that id
 *   path_changed      the document is no longer registered at the path the caller read
 *   revision_changed  the document's current revision is not the one the caller hashed the landed file against
 *   path_occupied     another document is already registered at the landed path for the same task
 *   key_occupied      another document already holds the `path:` key of the landed path
 */
const RELOCATION_REFUSALS = ['not_found', 'path_changed', 'revision_changed', 'path_occupied', 'key_occupied'];

function initializeDocumentRelocations(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_document_relocations (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL,
        from_root TEXT NOT NULL,
        to_root TEXT NOT NULL,
        from_deliverable_key TEXT,
        to_deliverable_key TEXT,
        revision_id TEXT NOT NULL REFERENCES review_document_revisions(id),
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        task_id TEXT,
        reason TEXT,
        relocated_by TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_document_relocations_document
        ON review_document_relocations(document_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_review_document_relocations_from_root
        ON review_document_relocations(from_root);
    CREATE TRIGGER IF NOT EXISTS review_document_relocations_append_only
        BEFORE UPDATE ON review_document_relocations
        BEGIN SELECT RAISE(ABORT, 'document relocations are append-only'); END;`);
}

/** LIKE pattern for every path strictly inside `root` (which carries no trailing separator). */
function insidePattern(root) {
    return `${root.replace(/[\\%_]/g, ch => `\\${ch}`)}/%`;
}

function createDocumentRelocationStore(db) {
    const one = (sql, ...params) => db.prepare(sql).get(...params) || null;

    return {
        /** Every document registered at a path inside `root`, oldest first. */
        listDocumentsInsideRoot(root) {
            return db.prepare("SELECT * FROM review_documents WHERE path LIKE ? ESCAPE '\\' ORDER BY created_at ASC, id ASC")
                .all(insidePattern(root)).map(row => this.getDocument(row.id));
        },

        /** The recorded moves out of `root` (by the root the move was asked for), oldest first. */
        listRelocationsFromRoot(root) {
            return db.prepare('SELECT * FROM review_document_relocations WHERE from_root = ? ORDER BY created_at ASC, id ASC').all(root);
        },

        /** Every recorded move of one document, oldest first. */
        listRelocations(documentId) {
            return db.prepare('SELECT * FROM review_document_relocations WHERE document_id = ? ORDER BY created_at ASC, id ASC').all(documentId);
        },

        /**
         * Move one registration from `fromPath` to `toPath` when it is still
         * registered at `fromPath` on revision `revisionId`. Returns
         * `{ outcome: 'relocated', document, relocation }`,
         * `{ outcome: 'already_relocated', document, relocation }` when an
         * earlier move put it at `toPath` (nothing is written), or
         * `{ outcome: <refusal>, document, occupant_id? }`. Immediate, so a
         * second writer (another process on the same database) waits for this
         * one instead of moving the same row from a stale read.
         */
        relocateDocument({ documentId, fromPath, toPath, fromRoot, toRoot, revisionId, contentHash, rootProjectId, source, taskId = null, reason = null, actorId }) {
            return db.transaction(() => {
                const doc = this.getDocument(documentId);
                if (!doc) return { outcome: 'not_found', document: null };
                if (doc.path === toPath) {
                    // Already moved here (a concurrent or repeated call): answered by the record of that move, nothing written.
                    const relocation = one('SELECT * FROM review_document_relocations WHERE document_id = ? AND to_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', doc.id, toPath);
                    return { outcome: relocation ? 'already_relocated' : 'path_changed', document: doc, relocation };
                }
                if (doc.path !== fromPath) return { outcome: 'path_changed', document: doc };
                if (doc.current_revision_id !== revisionId) return { outcome: 'revision_changed', document: doc };
                const pathHolder = this.findDocumentByPath(toPath, doc.task_id);
                if (pathHolder && pathHolder.id !== doc.id) return { outcome: 'path_occupied', document: doc, occupant_id: pathHolder.id };
                // A `path:` key is the registration's path, so it moves with it; a producer's key is its own identity and stays.
                const fromKey = doc.deliverable_key ?? null;
                const toKey = fromKey === `path:${fromPath}` ? `path:${toPath}` : fromKey;
                if (toKey !== fromKey) {
                    const keyHolder = this.findDocumentByKey(toKey);
                    if (keyHolder && keyHolder.id !== doc.id) return { outcome: 'key_occupied', document: doc, occupant_id: keyHolder.id };
                }
                const at = now();
                const changed = db.prepare(`UPDATE review_documents SET path = ?, root_project_id = ?, deliverable_key = ?, updated_at = ?
                    WHERE id = ? AND path = ? AND current_revision_id = ?`)
                    .run(toPath, rootProjectId ?? doc.root_project_id ?? null, toKey, at, doc.id, fromPath, revisionId).changes;
                if (changed !== 1) return { outcome: 'path_changed', document: this.getDocument(doc.id) };
                const relocation = {
                    id: randomUUID(), document_id: doc.id, from_path: fromPath, to_path: toPath, from_root: fromRoot, to_root: toRoot,
                    from_deliverable_key: fromKey, to_deliverable_key: toKey, revision_id: revisionId, content_hash: contentHash,
                    source, task_id: taskId, reason, relocated_by: actorId, created_at: at,
                };
                const keys = Object.keys(relocation);
                db.prepare(`INSERT INTO review_document_relocations (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
                    .run(...keys.map(key => relocation[key]));
                return { outcome: 'relocated', document: this.getDocument(doc.id), relocation: one('SELECT * FROM review_document_relocations WHERE id = ?', relocation.id) };
            }).immediate();
        },
    };
}

module.exports = { initializeDocumentRelocations, createDocumentRelocationStore, RELOCATION_REFUSALS };
