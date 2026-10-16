/** Client-safe projection of a published, immutable review revision. Never expose
 * the raw design manifest, filesystem paths, source account URLs or evidence. */
const fs = require('fs');
const { createHash } = require('crypto');
const media = require('../server/services/review-media');
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const fields = ['asset_key', 'role', 'media_type', 'mime_type', 'content_hash', 'byte_length', 'label', 'direction', 'appearance', 'viewport', 'state', 'before_asset_key', 'width', 'height', 'order'];
const visible = (asset, type) => ['screen', 'before', 'preview', 'tokens'].includes(asset.role) || (asset.role === 'primary' && type !== 'design');

function revisionMedia(db, artifact) {
    if (!artifact.revision_id || !artifact.document_id) return null;
    const revision = db.prepare('SELECT * FROM review_document_revisions WHERE id = ? AND document_id = ?').get(artifact.revision_id, artifact.document_id);
    if (!revision || !media.isVisualMedia(revision.media_type)) return null;
    const assets = db.prepare('SELECT * FROM review_document_revision_assets WHERE revision_id = ? AND document_id = ? ORDER BY "order", asset_key').all(revision.id, artifact.document_id)
        .filter(a => visible(a, revision.media_type));
    const manifest = parse(revision.manifest);
    const directions = revision.media_type === 'design' && Array.isArray(manifest?.directions)
        ? manifest.directions.map(d => ({ id: d.id, title: d.title, ...(typeof d.summary === 'string' ? { summary: d.summary } : {}), ...(d.recommended === true ? { recommended: true } : {}) })) : [];
    return { revision, assets, descriptor: { media_type: revision.media_type, assets: assets.map(a => Object.fromEntries(fields.filter(k => a[k] !== undefined).map(k => [k, a[k]]))), directions } };
}

function assetBytes(db, artifact, assetKey) {
    if (!media.ASSET_KEY_PATTERN.test(assetKey)) throw fail(400, 'Invalid asset key', 'invalid_asset_key');
    const captured = revisionMedia(db, artifact);
    const asset = captured?.assets.find(a => a.asset_key === assetKey);
    if (!asset) throw fail(404, 'Asset not found in this published revision', 'asset_not_found');
    // Portal design reads are bounded. Large video needs a separate streaming consumer.
    if (asset.byte_length > 40 * 1024 * 1024) throw fail(409, 'Asset exceeds the client viewer size limit', 'asset_too_large');
    let bytes;
    if (asset.role === 'primary' && media.isTextMedia(asset.media_type)) {
        const exact = db.prepare('SELECT exact_content FROM review_document_revision_exact WHERE revision_id = ?').get(captured.revision.id);
        bytes = Buffer.from(exact?.exact_content ?? captured.revision.content, 'utf8');
    } else {
        const located = media.locateAssetBytes(asset);
        if (!located) throw fail(409, 'Published asset bytes unavailable', 'asset_changed');
        bytes = fs.readFileSync(located.path);
    }
    if (bytes.length !== asset.byte_length || createHash('sha256').update(bytes).digest('hex') !== asset.content_hash) throw fail(409, 'Published asset bytes changed', 'asset_changed');
    return { bytes, mime_type: asset.mime_type, media_type: asset.media_type, content_hash: asset.content_hash, revision_hash: captured.revision.content_hash };
}

function reviewSelection(input, descriptor, decision) {
    const directions = descriptor?.directions || [];
    const selection = input?.selection;
    if (selection === undefined || selection === null) {
        if (decision === 'accept' && directions.length >= 2) throw fail(400, 'Choose a design direction', 'selection_required');
        return null;
    }
    if (typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(k => k !== 'direction') || typeof selection.direction !== 'string' || !directions.some(d => d.id === selection.direction)) throw fail(400, 'Choose a direction in this published revision', 'invalid_selection');
    return { direction: selection.direction };
}
module.exports = { revisionMedia, assetBytes, reviewSelection };
