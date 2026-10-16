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
/**
 * Pinned notes from the review room: each anchored to a place in THIS
 * published revision. Mirrors the portal's validation so a note that names a
 * foreign asset, or a kind that does not suit the asset, refuses the review
 * (400 invalid_comment) rather than being stored half-right. Returns the
 * clean list (possibly empty).
 */
const COMMENT_LIMITS = { count: 50, body: 4000, label: 120 };
const ASSET_KEY_RE = /^[A-Za-z0-9._:-]{1,160}$/;
function reviewComments(input, descriptor) {
    const raw = input?.comments;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw fail(400, 'comments must be a list', 'invalid_comment');
    if (raw.length > COMMENT_LIMITS.count) throw fail(400, `at most ${COMMENT_LIMITS.count} notes per review`, 'invalid_comment');
    const assets = Array.isArray(descriptor?.assets) ? descriptor.assets : [];
    const unit = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    const bad = message => fail(400, message, 'invalid_comment');
    return raw.map(c => {
        if (!c || typeof c !== 'object') throw bad('each note must be an object');
        const body = typeof c.body === 'string' ? c.body.trim() : '';
        if (!body) throw bad('each note needs text');
        if (body.length > COMMENT_LIMITS.body) throw bad(`a note exceeds ${COMMENT_LIMITS.body} characters`);
        const label = typeof c.target_label === 'string' ? c.target_label.trim().slice(0, COMMENT_LIMITS.label) : '';
        const a = c.anchor;
        if (!a || typeof a !== 'object' || typeof a.kind !== 'string') throw bad('each note needs an anchor');
        const asset = typeof a.asset_key === 'string' && ASSET_KEY_RE.test(a.asset_key) ? assets.find(x => x.asset_key === a.asset_key) : null;
        if (['region', 'point', 'time', 'page', 'screen'].includes(a.kind) && !asset) throw bad('note anchor names an asset that is not in this revision');
        let anchor;
        switch (a.kind) {
            case 'region':
                if (!['image', 'svg', 'html', 'pdf'].includes(asset.media_type) || ![a.x, a.y, a.w, a.h].every(unit) || a.w <= 0 || a.h <= 0) throw bad('a region note needs x, y, w, h within the image');
                anchor = { kind: 'region', asset_key: asset.asset_key, x: a.x, y: a.y, w: a.w, h: a.h };
                break;
            case 'screen': {
                const r = a.region;
                if (!String(asset.asset_key).startsWith('screen:') || !r || ![r.x, r.y, r.w, r.h].every(unit) || r.w <= 0 || r.h <= 0) throw bad('a screen note needs a region on a design screen');
                anchor = { kind: 'screen', asset_key: asset.asset_key, region: { x: r.x, y: r.y, w: r.w, h: r.h } };
                break;
            }
            case 'point':
                if (!['html', 'svg', 'image'].includes(asset.media_type) || !unit(a.x) || !unit(a.y)) throw bad('a point note needs x and y on the preview');
                anchor = { kind: 'point', asset_key: asset.asset_key, x: a.x, y: a.y, ...(typeof a.viewport === 'string' ? { viewport: a.viewport.slice(0, 40) } : {}) };
                break;
            case 'time': {
                const t = a.t_start, end = a.t_end;
                if (!['video', 'audio'].includes(asset.media_type) || typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 360000) throw bad('a moment note needs a time within the recording');
                if (end !== undefined && (typeof end !== 'number' || !Number.isFinite(end) || end < t)) throw bad("a moment note's end must follow its start");
                anchor = { kind: 'time', asset_key: asset.asset_key, t_start: t, ...(end !== undefined ? { t_end: end } : {}) };
                break;
            }
            case 'page':
                if (asset.media_type !== 'pdf' || !Number.isInteger(a.page) || a.page < 1 || a.page > 100000) throw bad('a page note needs a page number');
                anchor = { kind: 'page', asset_key: asset.asset_key, page: a.page };
                break;
            case 'passage':
                if (descriptor) throw bad('a passage note belongs to a written document');
                if (!Number.isInteger(a.block) || a.block < 0 || a.block > 100000) throw bad('a passage note needs a paragraph number');
                anchor = { kind: 'passage', block: a.block, ...(typeof a.quote === 'string' ? { quote: a.quote.slice(0, 120) } : {}) };
                break;
            case 'document':
                anchor = { kind: 'document' };
                break;
            default:
                throw bad('unknown note anchor');
        }
        return { anchor, ...(label ? { target_label: label } : {}), body };
    });
}
module.exports = { revisionMedia, assetBytes, reviewSelection, reviewComments };
