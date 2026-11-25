#!/usr/bin/env node
/**
 * Repair current revisions with a required asset stranded in a removed Praxis
 * worktree. Preview by default. Take an online SQLite backup before --execute.
 *
 * NEXUS_REVIEW_BLOB_DIR=/absolute/store node scripts/repair-review-assets.js --db /absolute/nexus.db [--execute]
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const Database = require('better-sqlite3');
const { createDocumentReviewStore } = require('../db/document-reviews');
const { initializeAssetLocations, setAssetLocations } = require('../db/document-relocations');
const { resolveDocumentPath } = require('../server/services/document-registry');
const { planDocumentRelocation } = require('../server/services/document-relocation');
const media = require('../server/services/review-media');

function worktreeOf(file) {
    // The layout Praxis allocates: .praxis-worktrees/<run>/<repository>/<file>.
    const segments = file.split(path.sep);
    const index = segments.indexOf('.praxis-worktrees');
    return index !== -1 && segments.length > index + 3 ? segments.slice(0, index + 3).join(path.sep) : null;
}

function landedAsset(asset, revision, documentPath, root) {
    const resolved = resolveDocumentPath(documentPath, [root]);
    if (!resolved.ok) return { outcome: resolved.code, landed_path: documentPath };
    if (resolved.canonicalPath !== documentPath) return { outcome: 'landed_path_is_a_link', landed_path: documentPath };
    let landed = documentPath;
    if (asset.role !== 'primary') {
        const validated = media.validateDesignManifest(JSON.parse(revision.content.replace(/^\uFEFF/, '')));
        const member = validated.ok && validated.members.find(item => item.asset_key === asset.asset_key);
        if (!member) return { outcome: 'member_not_in_manifest' };
        const result = media.resolveDesignMembers(documentPath, root.root, [member]);
        if (!result.ok) return { outcome: result.code, landed_path: path.resolve(path.dirname(documentPath), member.file) };
        landed = result.assets[0].path;
    }
    const { hash, byteLength } = media.hashFile(landed);
    const target = { landed_path: landed, landed_hash: hash };
    if (hash !== asset.content_hash || byteLength !== asset.byte_length) return { ...target, outcome: 'hash_mismatch' };
    if (asset.media_type === 'image') {
        const check = media.readinessOf([{ ...asset, path: landed, landed_path: landed }]).checks[0];
        if (!check.ok) return { ...target, outcome: check.status };
    }
    const diskOnly = asset.byte_length > (media.MEDIA_TYPES[asset.media_type].blobLimit ?? Infinity);
    return { ...target, storage: diskOnly ? 'landed_file' : 'blob', outcome: 'would_repair' };
}

function repair(db, { execute = false } = {}) {
    const store = createDocumentReviewStore(db);
    const decisions = () => db.prepare('SELECT count(*) AS n FROM review_document_decisions').get().n;
    const decisionsBefore = decisions();
    const locationTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_document_asset_locations'");
    const hasLocations = locationTable.get();
    const required = db.prepare(`SELECT a.*, r.media_type AS revision_type, ${hasLocations ? 'l.path' : 'NULL'} AS landed_path
        FROM review_documents d JOIN review_document_revisions r ON r.id = d.current_revision_id
        JOIN review_document_revision_assets a ON a.revision_id = r.id AND a.document_id = d.id
        ${hasLocations ? 'LEFT JOIN review_document_asset_locations l ON l.asset_id = a.id' : ''}
        WHERE a.role IN ('screen', 'before') OR (a.role = 'primary' AND r.media_type <> 'design')
        ORDER BY d.id, a.asset_key`).all();
    const affected = new Map();
    const byType = {};
    for (const asset of required) {
        byType[asset.revision_type] ??= { found: 0, repairable: 0, repaired: 0, left: 0 };
        const worktree = worktreeOf(asset.path);
        if (!worktree || fs.existsSync(worktree) || media.readinessOf([asset]).ready) continue;
        if (!affected.has(asset.document_id)) affected.set(asset.document_id, []);
        affected.get(asset.document_id).push(asset);
    }

    const current = db.prepare('SELECT current_revision_id, path FROM review_documents WHERE id = ?');
    const records = [];
    const relocations = [];
    const restoredHashes = new Set();
    for (const [id, assets] of affected) {
        const processDocument = () => {
            const doc = store.getDocument(id);
            const revision = store.getRevision(assets[0].revision_id);
            const rows = assets.map(asset => ({
                document_id: id, revision_id: revision.id, media_type: revision.media_type, asset_key: asset.asset_key,
                recorded_hash: asset.content_hash, registered_asset_path: asset.path,
            }));
            const refuse = (outcome, detail) => rows.map(row => ({ ...row, outcome, ...detail }));
            if (doc.current_revision_id !== revision.id) return refuse('revision_changed');
            const project = db.prepare('SELECT id, path FROM projects WHERE id = ?').get(doc.root_project_id ?? doc.project_id);
            if (!project?.path || !fs.existsSync(project.path)) return refuse('project_root_missing');
            const root = { projectId: project.id, root: fs.realpathSync.native(project.path) };
            const fromRoot = worktreeOf(doc.path);
            let documentPath = doc.path;
            let move;
            if (fromRoot) {
                if (fs.existsSync(fromRoot)) return refuse('document_still_in_worktree');
                if (path.basename(fromRoot) !== path.basename(root.root)) return refuse('unknown_landed_checkout');
                move = planDocumentRelocation({ store, doc, revision, fromRoot, toRoot: root.root, roots: [root] });
                if (move.action !== 'move') return refuse(move.reason, { landed_path: move.toPath, landed_hash: move.landedHash });
                documentPath = move.toPath;
            }

            for (const [index, asset] of assets.entries()) {
                const row = rows[index];
                row.document_path = documentPath;
                if (media.readinessOf([asset]).ready) row.outcome = 'already_servable';
                else Object.assign(row, landedAsset(asset, revision, documentPath, root));
            }
            // Another document in this batch can already have restored the same
            // blob. This document still needs its own verified registration move.
            if (execute && move && rows.every(row => ['would_repair', 'already_servable'].includes(row.outcome))) {
                const result = store.relocateDocument({ documentId: id, fromPath: doc.path, toPath: documentPath, fromRoot,
                    toRoot: root.root, revisionId: revision.id, contentHash: move.landedHash, rootProjectId: root.projectId,
                    source: 'repair', taskId: doc.task_id, reason: 'Restore a required asset from the landed copy.', actorId: 'review-asset-repair' });
                if (result.outcome !== 'relocated') return refuse(result.outcome);
                relocations.push({ document_id: id, relocation_id: result.relocation.id });
            }
            return rows;
        };
        // Commit a document move before publishing blobs. A crash between these steps
        // leaves the missing asset discoverable on the next run.
        let rows;
        try {
            rows = execute ? db.transaction(processDocument).immediate() : processDocument();
        } catch (error) {
            rows = assets.map(asset => ({ document_id: id, revision_id: asset.revision_id, asset_key: asset.asset_key,
                media_type: asset.revision_type, recorded_hash: asset.content_hash, outcome: 'unreadable', detail: error.message }));
        }
        for (const [index, row] of rows.entries()) {
            if (!execute || row.outcome !== 'would_repair') continue;
            const asset = assets[index];
            const publish = () => {
                const doc = current.get(id);
                if (doc?.current_revision_id !== row.revision_id || doc.path !== row.document_path) return 'document_changed';
                if (locationTable.get()) asset.landed_path = store.getRevisionAsset(row.revision_id, row.asset_key)?.landed_path;
                if (media.readinessOf([asset]).ready) return 'already_servable';
                if (row.storage === 'landed_file') {
                    // Pin the canonical landed file only while it still serves these exact bytes.
                    asset.landed_path = row.landed_path;
                    if (!media.readinessOf([asset]).ready) return 'landed_file_changed';
                    initializeAssetLocations(db);
                    setAssetLocations(db, id, row.revision_id, [{ ...asset, path: row.landed_path }]);
                    return 'repaired';
                }
                // storeAssets re-hashes the actual buffer before atomically publishing it.
                media.storeAssets([{ ...asset, path: row.landed_path }]);
                const check = media.readinessOf([asset]).checks[0];
                return check.ok ? 'repaired' : check.status;
            };
            try {
                row.outcome = db.transaction(publish).immediate();
                if (row.outcome === 'repaired' && row.storage === 'blob') restoredHashes.add(row.recorded_hash);
            } catch (error) {
                row.outcome = error.code === 'asset_changed' ? 'hash_mismatch' : 'unreadable';
                row.detail = error.message;
                if (row.outcome === 'hash_mismatch') delete row.landed_hash; // the planning hash is stale
            }
        }
        for (const row of rows) {
            if (row.outcome === 'already_servable' && restoredHashes.has(row.recorded_hash)) row.restored_by = 'shared_blob';
        }
        const counts = byType[assets[0].revision_type];
        counts.found++;
        if (rows.every(row => ['would_repair', 'repaired', 'already_servable'].includes(row.outcome))) {
            counts.repairable++;
            if (rows.some(row => row.outcome === 'repaired' || row.restored_by === 'shared_blob') || relocations.at(-1)?.document_id === id) counts.repaired++;
        } else counts.left++;
        records.push(...rows);
    }
    return { mode: execute ? 'execute' : 'preview', database: db.name, blob_directory: media.blobDirectory(),
        required_assets_scanned: required.length, revisions_by_media_type: byType, relocations,
        decision_rows: { before: decisionsBefore, after: decisions() }, assets: records };
}

if (require.main === module) {
    const { values } = parseArgs({ options: { db: { type: 'string' }, execute: { type: 'boolean', default: false } } });
    if (!values.db || !path.isAbsolute(values.db) || !path.isAbsolute(process.env.NEXUS_REVIEW_BLOB_DIR || '')) {
        throw new Error('Supply an absolute --db and NEXUS_REVIEW_BLOB_DIR.');
    }
    const db = new Database(values.db, { readonly: !values.execute, fileMustExist: true });
    try {
        console.log(JSON.stringify(repair(db, { execute: values.execute }), null, 2));
    } finally {
        db.close();
    }
}

module.exports = { repair };
