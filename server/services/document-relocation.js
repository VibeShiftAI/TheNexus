/**
 * Moving document registrations out of a run worktree to the checkout the
 * run landed in (2026-11-24, task ec3e1d0c; contract
 * docs/contracts/document-review-deliverables.md §14).
 *
 * For every document registered at a path inside `fromRoot`, the landed copy
 * is the file at the same relative path under `toRoot`. A registration moves
 * only when that file resolves inside the registered project roots (the same
 * boundary every registration passes), sits at exactly that path (no link to
 * somewhere else), and hashes, by the identity rule revision capture uses
 * (`revisionHash`), to the document's current revision. Anything else leaves
 * the registration where it is, readable from its captured revision, and is
 * reported by name with both hashes when there is a landed file to hash.
 *
 * Used by POST /api/documents/relocations (Praxis calls it when a run lands,
 * before the worktree is removed) and by the one-time repair of documents
 * stranded before that existed. Nothing here records a revision, a decision or
 * a notice.
 */
const fs = require('fs');
const path = require('path');
const { listProjectRoots, resolveDocumentPath, readArtifactFile, revisionHash } = require('./document-registry');

/** Who asked for a move: the landing of a run, or the repair of documents stranded before landings moved them. */
const RELOCATION_SOURCES = ['landing', 'repair'];

/**
 * A root as the caller names it: an absolute path with no `..`, trailing
 * separator or NUL, and not the filesystem root. Returns the normalized path
 * or null.
 */
function parseRoot(value) {
    if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return null;
    const normalized = path.resolve(value);
    if (normalized !== value || normalized === path.parse(normalized).root) return null;
    return normalized;
}

/** The given root and, when it exists and differs, its real path: a registration stores real paths. */
function rootSpellings(root) {
    try {
        const real = fs.realpathSync.native(root);
        return real === root ? [root] : [root, real];
    } catch {
        return [root];
    }
}

function insideRoot(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Whether two roots are the same directory or one contains the other: a move between them has no single meaning. */
function rootsOverlap(a, b) {
    return a === b || insideRoot(a, b) || insideRoot(b, a);
}

/**
 * What would happen to one registration: `{ action: 'move', toPath, landedHash,
 * registeredHash, rootProjectId }` or `{ action: 'leave', reason, toPath,
 * landedHash, registeredHash, detail }`. Reads files, writes nothing.
 *
 * `fromRoot` must contain `doc.path`; `toRoot` is the landed checkout (its real
 * path) or null when there is none.
 */
function planDocumentRelocation({ doc, revision, fromRoot, toRoot, roots }) {
    const relative = path.relative(fromRoot, doc.path);
    const registeredHash = revision?.content_hash ?? null;
    const leave = (reason, extra = {}) => ({ action: 'leave', reason, toPath: null, landedHash: null, registeredHash, detail: null, ...extra });
    if (!insideRoot(doc.path, fromRoot)) return leave('outside_from_root');
    if (!toRoot) return leave('no_landed_checkout');
    const toPath = path.join(toRoot, relative);
    if (!revision) return leave('no_revision', { toPath });
    const resolved = resolveDocumentPath(toPath, roots);
    if (!resolved.ok) {
        return leave(resolved.code === 'not_found' ? 'landed_file_missing' : 'landed_file_refused', { toPath, detail: resolved.code === 'not_found' ? null : resolved.code });
    }
    if (resolved.canonicalPath !== toPath) return leave('landed_path_is_a_link', { toPath, detail: resolved.canonicalPath });
    const read = readArtifactFile(resolved.canonicalPath, { mediaType: resolved.mediaType, root: resolved.root.root });
    if (!read.ok) return leave('landed_file_unreadable', { toPath, detail: read.code });
    const landedHash = revisionHash(doc, read);
    if (landedHash !== registeredHash) return leave('hash_mismatch', { toPath, landedHash });
    return { action: 'move', toPath, landedHash, registeredHash, rootProjectId: resolved.root.projectId };
}

function entry(doc, extra) {
    return {
        document_id: doc.id,
        title: doc.title,
        requires_review: Boolean(doc.requires_review),
        task_id: doc.task_id ?? null,
        ...extra,
    };
}

/**
 * Move every registration inside `fromRoot` whose landed copy under `toRoot`
 * holds the exact bytes of its current revision. Returns
 * `{ from_root, to_root, applied, relocated, already_relocated, left }`:
 *
 *   relocated          moved by this call (with `apply: false`: would be moved)
 *   already_relocated  moved out of `fromRoot` by an earlier call and still at the path it was moved to
 *   left               not moved, each with `reason` (and both hashes when there is a landed file to hash)
 *
 * Idempotent by document: a document moved once is no longer inside
 * `fromRoot`, so a repeat (a retried landing, a restart between the merge and
 * the worktree removal) finds it only in the record of moves and moves
 * nothing. Each move is its own compare-and-set (store.relocateDocument), so a
 * capture that records new bytes in between leaves that document in `left`.
 */
async function relocateDocuments({ db, store, fromRoot, toRoot, source, taskId = null, reason = null, actorId, apply = true }) {
    const fromSpellings = rootSpellings(fromRoot);
    const toReal = toRoot ? fs.realpathSync.native(toRoot) : null;
    const roots = await listProjectRoots(db);
    const relocated = [];
    const already = [];
    const left = [];
    const seen = new Set();
    const alreadyEntry = (doc, row) => entry(doc, {
        from_path: row.from_path, to_path: row.to_path, revision_id: row.revision_id, registered_hash: row.content_hash, landed_hash: row.content_hash,
        from_deliverable_key: row.from_deliverable_key, to_deliverable_key: row.to_deliverable_key, relocation_id: row.id, relocated_at: row.created_at,
    });
    for (const spelling of fromSpellings) {
        for (const doc of store.listDocumentsInsideRoot(spelling)) {
            if (seen.has(doc.id)) continue;
            seen.add(doc.id);
            const revision = doc.current_revision_id ? store.getRevision(doc.current_revision_id) : null;
            const plan = planDocumentRelocation({ doc, revision, fromRoot: spelling, toRoot: toReal, roots });
            const base = { from_path: doc.path, to_path: plan.toPath, revision_id: doc.current_revision_id ?? null, registered_hash: plan.registeredHash, landed_hash: plan.landedHash };
            if (plan.action === 'leave') {
                left.push(entry(doc, { ...base, reason: plan.reason, detail: plan.detail }));
                continue;
            }
            const fromKey = doc.deliverable_key ?? null;
            const toKey = fromKey === `path:${doc.path}` ? `path:${plan.toPath}` : fromKey;
            if (!apply) {
                relocated.push(entry(doc, { ...base, from_deliverable_key: fromKey, to_deliverable_key: toKey }));
                continue;
            }
            const result = store.relocateDocument({
                documentId: doc.id, fromPath: doc.path, toPath: plan.toPath, fromRoot: spelling, toRoot: toReal,
                revisionId: doc.current_revision_id, contentHash: plan.landedHash, rootProjectId: plan.rootProjectId,
                source, taskId, reason, actorId,
            });
            if (result.outcome === 'relocated') {
                relocated.push(entry(result.document, { ...base, from_deliverable_key: result.relocation.from_deliverable_key, to_deliverable_key: result.relocation.to_deliverable_key, relocation_id: result.relocation.id }));
            } else if (result.outcome === 'already_relocated' && result.relocation) {
                // A concurrent call moved it between this call's read and its compare-and-set.
                already.push(alreadyEntry(result.document, result.relocation));
            } else {
                left.push(entry(doc, { ...base, reason: result.outcome, detail: result.occupant_id ? `occupied by document ${result.occupant_id}` : null }));
            }
        }
    }
    // Newest move first, so a document moved out of this root more than once is answered by its latest move.
    for (const spelling of fromSpellings) {
        for (const row of store.listRelocationsFromRoot(spelling).reverse()) {
            if (seen.has(row.document_id)) continue;
            const doc = store.getDocument(row.document_id);
            // Moved since to somewhere else (a later registration elsewhere): no longer this root's to answer for.
            if (!doc || doc.path !== row.to_path) continue;
            seen.add(row.document_id);
            already.push(alreadyEntry(doc, row));
        }
    }
    return { from_root: fromRoot, to_root: toReal, applied: apply, relocated, already_relocated: already, left };
}

module.exports = { RELOCATION_SOURCES, parseRoot, rootsOverlap, planDocumentRelocation, relocateDocuments };
