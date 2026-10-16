/**
 * Review media model (contract: docs/contracts/review-media-and-design-packages.md).
 *
 * Which file types the review registry accepts, how each is classified, read,
 * hashed and stored, the design package manifest (one `.design.json` that
 * binds screens, directions, before/after pairs, tokens, previews and
 * evidence into one revision with one package hash), the content-addressed
 * blob store that keeps the bytes a decision was recorded against, and the
 * readiness check that says whether a revision's required visuals are
 * actually servable through the authenticated asset route.
 *
 * Pure where it can be (classification, manifest validation, hashing);
 * filesystem access is limited to reading registered files and writing into
 * the blob store. Nothing here crawls directories or serves arbitrary paths.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const KB = 1024;
const MB = 1024 * KB;

/** media_type → extensions, mime, handling. Order matters only for `design` (checked before `json`). */
const MEDIA_TYPES = {
    design: { extensions: ['.design.json'], mime: 'application/json', text: true, editable: true, maxBytes: 1 * MB, package: true },
    markdown: { extensions: ['.md', '.markdown'], mime: 'text/markdown', text: true, editable: true, maxBytes: 2 * MB },
    text: { extensions: ['.txt', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.env.example'], mime: 'text/plain', text: true, editable: true, maxBytes: 2 * MB },
    code: {
        extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.swift', '.kt', '.java', '.go', '.rs', '.rb', '.sh', '.zsh', '.css', '.scss', '.sql'],
        mime: 'text/plain', text: true, editable: true, maxBytes: 2 * MB,
    },
    json: { extensions: ['.json'], mime: 'application/json', text: true, editable: true, maxBytes: 2 * MB },
    html: { extensions: ['.html', '.htm'], mime: 'text/html', text: true, editable: true, maxBytes: 8 * MB, sandboxed: true },
    svg: { extensions: ['.svg'], mime: 'image/svg+xml', text: true, editable: true, maxBytes: 4 * MB, sandboxed: true, visual: true },
    image: { extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'], mime: null, text: false, editable: false, maxBytes: 40 * MB, visual: true },
    video: { extensions: ['.mp4', '.m4v', '.webm', '.mov'], mime: null, text: false, editable: false, maxBytes: 2 * 1024 * MB, visual: true, blobLimit: 512 * MB, ranged: true },
    audio: { extensions: ['.mp3', '.m4a', '.wav', '.ogg'], mime: null, text: false, editable: false, maxBytes: 200 * MB, visual: false, ranged: true },
    pdf: { extensions: ['.pdf'], mime: 'application/pdf', text: false, editable: false, maxBytes: 100 * MB, visual: true },
};

const MIME_BY_EXTENSION = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.sql': 'application/sql',
};

/** Media types whose revision is only reviewable when its visuals load (contract §5). */
const VISUAL_MEDIA_TYPES = new Set(['design', 'image', 'video', 'audio', 'pdf', 'html', 'svg']);

const ASSET_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const MANIFEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_PACKAGE_MEMBERS = 400;

function lowerName(candidate) {
    return path.basename(String(candidate)).toLowerCase();
}

/** The media type of a path by its extension(s), or null when it is not an allowed type. */
function classifyPath(candidate) {
    if (typeof candidate !== 'string' || !candidate) return null;
    const name = lowerName(candidate);
    for (const [mediaType, spec] of Object.entries(MEDIA_TYPES)) {
        if (spec.extensions.some(ext => name.endsWith(ext) && name !== ext)) return mediaType;
    }
    return null;
}

function mimeFor(candidate, mediaType = classifyPath(candidate)) {
    if (!mediaType) return 'application/octet-stream';
    const spec = MEDIA_TYPES[mediaType];
    const ext = path.extname(lowerName(candidate));
    return spec.mime || MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

function isTextMedia(mediaType) { return Boolean(MEDIA_TYPES[mediaType]?.text); }
function isEditableMedia(mediaType) { return Boolean(MEDIA_TYPES[mediaType]?.editable); }
function maxBytesFor(mediaType) { return MEDIA_TYPES[mediaType]?.maxBytes ?? 0; }
function isVisualMedia(mediaType) { return VISUAL_MEDIA_TYPES.has(mediaType); }

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

// ── Blob store ────────────────────────────────────────────────────────────

function blobDirectory() {
    const configured = process.env.NEXUS_REVIEW_BLOB_DIR;
    if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim());
    return path.join(__dirname, '..', '..', 'data', 'review-blobs');
}

function blobPath(hash) {
    return path.join(blobDirectory(), hash.slice(0, 2), hash);
}

/**
 * Keep `bytes` under their hash. Content-addressed, so a retry or a second
 * document with the same pixels costs nothing. Returns the stored path.
 */
function storeBlob(hash, bytes) {
    const target = blobPath(hash);
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
    return target;
}

function hasBlob(hash) {
    try { return fs.statSync(blobPath(hash)).isFile(); } catch { return false; }
}

/** Hash a file by streaming it, so a large video never has to sit in memory. */
function hashFile(filePath) {
    const hash = createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(1 * MB);
        let read;
        let total = 0;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, read));
            total += read;
        }
        return { hash: hash.digest('hex'), byteLength: total };
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Where a revision asset's bytes can be read from right now: the blob store
 * when the bytes were copied, otherwise the registered file when it still
 * hashes to the recorded value. Null when neither holds.
 */
function locateAssetBytes({ content_hash, path: filePath, byte_length }) {
    if (content_hash && hasBlob(content_hash)) return { source: 'blob', path: blobPath(content_hash) };
    if (!filePath) return null;
    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }
    if (!stat.isFile()) return null;
    if (typeof byte_length === 'number' && stat.size !== byte_length) return null;
    const { hash } = hashFile(filePath);
    return hash === content_hash ? { source: 'disk', path: filePath } : null;
}

// ── Image dimensions (headers only; enough for a readiness decode check) ──

function imageDimensions(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
    // PNG
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    // GIF
    if (bytes.subarray(0, 6).toString('ascii') === 'GIF89a' || bytes.subarray(0, 6).toString('ascii') === 'GIF87a') {
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    // JPEG: walk the markers to SOF0..SOF15 (except DHT/JPG/DAC)
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) { offset++; continue; }
            const marker = bytes[offset + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
            const length = bytes.readUInt16BE(offset + 2);
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
            }
            offset += 2 + length;
        }
        return null;
    }
    // WebP (VP8 / VP8L / VP8X)
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
        const chunk = bytes.subarray(12, 16).toString('ascii');
        if (chunk === 'VP8 ' && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
        if (chunk === 'VP8L' && bytes.length >= 25) {
            const b = bytes.readUInt32LE(21);
            return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X' && bytes.length >= 30) {
            return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
        }
        return null;
    }
    // AVIF: trust the container signature only
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /avi[fs]/.test(bytes.subarray(8, 12).toString('ascii'))) return { width: null, height: null };
    return null;
}

function decodableImage(bytes) {
    const dims = imageDimensions(bytes);
    if (!dims) return false;
    if (dims.width === null) return true;
    return dims.width > 0 && dims.height > 0;
}

// ── Design package manifest ──────────────────────────────────────────────

const MANIFEST_FORMAT = 'nexus-design-package/1';

function shortText(value, max) {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
}

function invalid(error) { return { ok: false, code: 'invalid_manifest', error }; }

/**
 * Validate a parsed manifest (contract §2.1). Returns the normalized manifest
 * and the member list `{ asset_key, role, file, label, direction, appearance,
 * viewport, state, before_asset_key, order }` with relative files, or the
 * first rule it breaks. Does not touch the filesystem.
 */
function validateDesignManifest(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return invalid('Manifest must be a JSON object');
    if (manifest.format !== MANIFEST_FORMAT) return invalid(`Manifest format must be "${MANIFEST_FORMAT}"`);
    const title = shortText(manifest.title, 300);
    if (!title) return invalid('Manifest needs a title of 1-300 characters');
    const summary = manifest.summary === undefined ? null : shortText(manifest.summary, 2000);
    if (manifest.summary !== undefined && !summary) return invalid('summary must be 1-2000 characters');

    const directions = [];
    const directionIds = new Set();
    if (manifest.directions !== undefined) {
        if (!Array.isArray(manifest.directions)) return invalid('directions must be an array');
        for (const direction of manifest.directions) {
            const id = shortText(direction?.id, 80);
            if (!id || !MANIFEST_ID_PATTERN.test(id)) return invalid('Each direction needs an id matching ^[A-Za-z0-9._-]{1,80}$');
            if (directionIds.has(id)) return invalid(`Duplicate direction id "${id}"`);
            const dTitle = shortText(direction.title, 200);
            if (!dTitle) return invalid(`Direction "${id}" needs a title`);
            directionIds.add(id);
            directions.push({
                id, title: dTitle,
                summary: direction.summary === undefined ? null : shortText(direction.summary, 2000),
                recommended: direction.recommended === true,
            });
        }
    }

    if (!Array.isArray(manifest.screens) || manifest.screens.length === 0) return invalid('Manifest needs at least one screen');
    const members = [];
    const screens = [];
    const screenIds = new Set();
    const memberFile = (value, where) => {
        const file = shortText(value, 1024);
        if (!file || path.isAbsolute(file) || file.includes('\0') || file.split(/[\\/]/).includes('..')) return { error: `${where} must be a relative path inside the package` };
        return { file: file.replace(/\\/g, '/') };
    };
    let order = 0;
    for (const screen of manifest.screens) {
        const id = shortText(screen?.id, 80);
        if (!id || !MANIFEST_ID_PATTERN.test(id)) return invalid('Each screen needs an id matching ^[A-Za-z0-9._-]{1,80}$');
        if (screenIds.has(id)) return invalid(`Duplicate screen id "${id}"`);
        const sTitle = shortText(screen.title, 200);
        if (!sTitle) return invalid(`Screen "${id}" needs a title`);
        const file = memberFile(screen.file, `screens["${id}"].file`);
        if (file.error) return invalid(file.error);
        const fileType = classifyPath(file.file);
        if (fileType !== 'image' && fileType !== 'svg') return invalid(`Screen "${id}" must be an image or SVG`);
        let before = null;
        if (screen.before !== undefined && screen.before !== null) {
            const b = memberFile(screen.before, `screens["${id}"].before`);
            if (b.error) return invalid(b.error);
            const bType = classifyPath(b.file);
            if (bType !== 'image' && bType !== 'svg') return invalid(`Screen "${id}" before image must be an image or SVG`);
            before = b.file;
        }
        if (screen.direction !== undefined && screen.direction !== null) {
            if (!directionIds.has(screen.direction)) return invalid(`Screen "${id}" names an unknown direction "${String(screen.direction)}"`);
        }
        if (screen.appearance !== undefined && screen.appearance !== null && !['light', 'dark'].includes(screen.appearance)) {
            return invalid(`Screen "${id}" appearance must be "light" or "dark"`);
        }
        for (const field of ['viewport', 'state']) {
            if (screen[field] !== undefined && screen[field] !== null && !shortText(screen[field], 60)) return invalid(`Screen "${id}" ${field} must be 1-60 characters`);
        }
        if (screen.notes !== undefined && screen.notes !== null && !shortText(screen.notes, 4000)) return invalid(`Screen "${id}" notes must be 1-4000 characters`);
        screenIds.add(id);
        const normalized = {
            id, title: sTitle, file: file.file, before,
            direction: screen.direction ?? null, appearance: screen.appearance ?? null,
            viewport: screen.viewport ?? null, state: screen.state ?? null, notes: screen.notes ?? null,
        };
        screens.push(normalized);
        members.push({ asset_key: `screen:${id}`, role: 'screen', file: file.file, label: sTitle, direction: normalized.direction, appearance: normalized.appearance, viewport: normalized.viewport, state: normalized.state, before_asset_key: before ? `before:${id}` : null, order: order++ });
        if (before) members.push({ asset_key: `before:${id}`, role: 'before', file: before, label: `${sTitle} (before)`, direction: normalized.direction, appearance: normalized.appearance, viewport: normalized.viewport, state: normalized.state, before_asset_key: null, order: order++ });
    }

    let tokens = null;
    if (manifest.tokens !== undefined && manifest.tokens !== null) {
        const t = memberFile(manifest.tokens, 'tokens');
        if (t.error) return invalid(t.error);
        if (classifyPath(t.file) !== 'json') return invalid('tokens must be a .json member');
        tokens = t.file;
        members.push({ asset_key: 'tokens', role: 'tokens', file: tokens, label: 'Design tokens', direction: null, appearance: null, viewport: null, state: null, before_asset_key: null, order: order++ });
    }

    const previews = [];
    if (manifest.previews !== undefined) {
        if (!Array.isArray(manifest.previews)) return invalid('previews must be an array');
        const ids = new Set();
        for (const preview of manifest.previews) {
            const id = shortText(preview?.id, 80);
            if (!id || !MANIFEST_ID_PATTERN.test(id)) return invalid('Each preview needs an id matching ^[A-Za-z0-9._-]{1,80}$');
            if (ids.has(id)) return invalid(`Duplicate preview id "${id}"`);
            const pTitle = shortText(preview.title, 200);
            if (!pTitle) return invalid(`Preview "${id}" needs a title`);
            const f = memberFile(preview.file, `previews["${id}"].file`);
            if (f.error) return invalid(f.error);
            if (!['html', 'svg', 'image'].includes(classifyPath(f.file))) return invalid(`Preview "${id}" must be HTML, SVG or an image`);
            if (preview.viewport !== undefined && preview.viewport !== null && !shortText(preview.viewport, 60)) return invalid(`Preview "${id}" viewport must be 1-60 characters`);
            ids.add(id);
            previews.push({ id, title: pTitle, file: f.file, viewport: preview.viewport ?? null });
            members.push({ asset_key: `preview:${id}`, role: 'preview', file: f.file, label: pTitle, direction: null, appearance: null, viewport: preview.viewport ?? null, state: null, before_asset_key: null, order: order++ });
        }
    }

    const evidence = [];
    if (manifest.evidence !== undefined) {
        if (!Array.isArray(manifest.evidence)) return invalid('evidence must be an array');
        const ids = new Set();
        for (const item of manifest.evidence) {
            const id = shortText(item?.id, 80);
            if (!id || !MANIFEST_ID_PATTERN.test(id)) return invalid('Each evidence item needs an id matching ^[A-Za-z0-9._-]{1,80}$');
            if (ids.has(id)) return invalid(`Duplicate evidence id "${id}"`);
            const label = shortText(item.label, 200);
            if (!label) return invalid(`Evidence "${id}" needs a label`);
            const f = memberFile(item.file, `evidence["${id}"].file`);
            if (f.error) return invalid(f.error);
            const type = classifyPath(f.file);
            if (!type || type === 'design' || (!isTextMedia(type) && type !== 'pdf')) return invalid(`Evidence "${id}" must be a text media type or a PDF`);
            ids.add(id);
            evidence.push({ id, label, file: f.file });
            members.push({ asset_key: `evidence:${id}`, role: 'evidence', file: f.file, label, direction: null, appearance: null, viewport: null, state: null, before_asset_key: null, order: order++ });
        }
    }

    if (members.length > MAX_PACKAGE_MEMBERS) return invalid(`A package may have at most ${MAX_PACKAGE_MEMBERS} members`);

    let source = null;
    if (manifest.source !== undefined && manifest.source !== null) {
        if (typeof manifest.source !== 'object' || Array.isArray(manifest.source)) return invalid('source must be an object');
        source = {};
        for (const field of ['provider', 'project_id', 'project_url', 'session_id', 'stage']) {
            if (manifest.source[field] === undefined || manifest.source[field] === null) continue;
            const value = shortText(manifest.source[field], 500);
            if (!value) return invalid(`source.${field} must be 1-500 characters`);
            source[field] = value;
        }
    }

    return {
        ok: true,
        manifest: { format: MANIFEST_FORMAT, title, summary, directions, screens, tokens, previews, evidence, source },
        members,
        selectsDirection: directions.length >= 2,
    };
}

/**
 * Package hash (contract §2.3): sha256 over the manifest hash and the sorted
 * `<asset_key>\t<member hash>\n` lines. Members sorted by asset key in byte
 * order.
 */
function packageHash(manifestHash, memberHashes) {
    const lines = [...memberHashes]
        .sort((a, b) => (a.asset_key < b.asset_key ? -1 : a.asset_key > b.asset_key ? 1 : 0))
        .map(member => `${member.asset_key}\t${member.content_hash}\n`)
        .join('');
    return sha256(`${manifestHash}\n${lines}`);
}

function insideRoot(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resolve every member of a validated manifest against the manifest's real
 * directory, inside the project root, each as its own media type with its own
 * size limit, hashed by streaming. Returns `{ ok, assets }` where every asset
 * carries its canonical path, media type, mime, byte length and hash (and
 * width/height for raster images), or the first refusal.
 */
function resolveDesignMembers(manifestCanonicalPath, root, members) {
    const base = path.dirname(manifestCanonicalPath);
    const assets = [];
    for (const member of members) {
        const requested = path.resolve(base, member.file);
        if (!insideRoot(requested, root)) return { ok: false, status: 403, code: 'outside_roots', error: `Package member ${member.file} is outside the project root` };
        let canonical;
        try { canonical = fs.realpathSync.native(requested); } catch (err) {
            if (err && err.code === 'ENOENT') return { ok: false, status: 404, code: 'member_missing', error: `Package member ${member.file} does not exist` };
            return { ok: false, status: 403, code: 'unresolvable', error: `Package member ${member.file} could not be resolved` };
        }
        if (!insideRoot(canonical, root)) return { ok: false, status: 403, code: 'symlink_escape', error: `Package member ${member.file} resolves outside the project root` };
        const mediaType = classifyPath(canonical);
        if (!mediaType || mediaType !== classifyPath(member.file)) return { ok: false, status: 415, code: 'unsupported_media', error: `Package member ${member.file} resolves to a different file type` };
        if (canonical.split(path.sep).some(segment => segment === '.git' || segment === 'node_modules')) {
            return { ok: false, status: 403, code: 'forbidden_path', error: `Package member ${member.file} resolves into .git or node_modules` };
        }
        let stat;
        try { stat = fs.statSync(canonical); } catch { return { ok: false, status: 404, code: 'member_missing', error: `Package member ${member.file} does not exist` }; }
        if (!stat.isFile()) return { ok: false, status: 400, code: 'not_a_file', error: `Package member ${member.file} is not a regular file` };
        if (stat.size > maxBytesFor(mediaType)) return { ok: false, status: 413, code: 'too_large', error: `Package member ${member.file} exceeds ${maxBytesFor(mediaType)} bytes` };
        const { hash, byteLength } = hashFile(canonical);
        let width = null;
        let height = null;
        if (mediaType === 'image') {
            const header = Buffer.alloc(Math.min(stat.size, 64 * KB));
            const fd = fs.openSync(canonical, 'r');
            try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
            const dims = imageDimensions(header);
            if (dims) { width = dims.width; height = dims.height; }
        }
        assets.push({
            ...member, path: canonical, media_type: mediaType, mime_type: mimeFor(canonical, mediaType),
            byte_length: byteLength, content_hash: hash, width, height,
        });
    }
    return { ok: true, assets };
}

/** Copy every binary member (and anything under the blob limit) into the blob store. */
function storeAssets(assets) {
    for (const asset of assets) {
        const spec = MEDIA_TYPES[asset.media_type];
        if (!spec) continue;
        if (spec.blobLimit && asset.byte_length > spec.blobLimit) continue;
        if (hasBlob(asset.content_hash)) continue;
        storeBlob(asset.content_hash, fs.readFileSync(asset.path));
    }
}

/**
 * Readiness (contract §5): can every asset of this revision be served right
 * now with the bytes the revision recorded, and do required images decode?
 */
function readinessOf(assets, { nowIso = new Date().toISOString() } = {}) {
    const checks = assets.map(asset => {
        const required = asset.role === 'screen' || asset.role === 'before' || asset.role === 'primary';
        const spec = MEDIA_TYPES[asset.media_type];
        const check = {
            asset_key: asset.asset_key, role: asset.role, required, ok: false, status: 'missing',
            byte_length: asset.byte_length, content_hash: asset.content_hash, mime_type: asset.mime_type, media_type: asset.media_type,
        };
        if (spec && asset.byte_length > spec.maxBytes) { check.status = 'too_large'; return check; }
        const located = locateAssetBytes(asset);
        if (!located) {
            check.status = asset.path && fs.existsSync(asset.path) ? 'changed' : 'missing';
            return check;
        }
        if (asset.media_type === 'image') {
            const fd = fs.openSync(located.path, 'r');
            const header = Buffer.alloc(Math.min(asset.byte_length, 64 * KB));
            try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
            if (!decodableImage(header)) { check.status = 'undecodable'; return check; }
        }
        check.ok = true;
        check.status = 'servable';
        check.source = located.source;
        return check;
    });
    const required = checks.filter(c => c.required);
    return {
        ready: required.length > 0 && required.every(c => c.ok),
        checked_at: nowIso,
        checks,
        required_total: required.length,
        required_ok: required.filter(c => c.ok).length,
    };
}

module.exports = {
    MEDIA_TYPES,
    VISUAL_MEDIA_TYPES,
    MANIFEST_FORMAT,
    MAX_PACKAGE_MEMBERS,
    ASSET_KEY_PATTERN,
    classifyPath,
    mimeFor,
    isTextMedia,
    isEditableMedia,
    isVisualMedia,
    maxBytesFor,
    sha256,
    hashFile,
    blobDirectory,
    blobPath,
    storeBlob,
    hasBlob,
    locateAssetBytes,
    imageDimensions,
    decodableImage,
    validateDesignManifest,
    packageHash,
    resolveDesignMembers,
    storeAssets,
    readinessOf,
};
