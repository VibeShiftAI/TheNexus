/**
 * Document registry boundary: which local files may be registered for review
 * and how their content is captured.
 *
 * A document is only ever served by a server-issued id, and only when its
 * REAL path (symlinks resolved) sits inside the real path of a registered
 * project. Both the path as given and the resolved path must be of the same
 * allowed media type (services/review-media.js; contract
 * docs/contracts/review-media-and-design-packages.md), so a `.md` or `.png`
 * symlink to `.env` is refused, and a link that resolves outside every project
 * root is refused as a symlink escape. Nothing here serves arbitrary local
 * files. Markdown was the only type until 2026-10-16; `isMarkdownPath` and
 * `MAX_DOCUMENT_BYTES` keep their meaning for the text-only callers.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const media = require('./review-media');

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

function failure(status, code, message) {
    return { ok: false, status, code, error: message };
}

function isMarkdownPath(candidate) {
    return MARKDOWN_EXTENSIONS.has(path.extname(candidate).toLowerCase());
}

function hasForbiddenSegment(candidate) {
    return candidate.split(path.sep).some(segment => FORBIDDEN_SEGMENTS.has(segment));
}

function insideRoot(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Real paths of every registered project directory that exists on disk.
 * Archived projects count: a document under an archived project is still a
 * project document, and the roots are read fresh on every call so a project
 * registered after boot is honoured.
 */
async function listProjectRoots(db) {
    const projects = typeof db?.getProjects === 'function' ? await db.getProjects({ includeArchived: true }) : [];
    const roots = [];
    for (const project of projects) {
        if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path)) continue;
        try {
            const realRoot = fs.realpathSync.native(project.path);
            if (fs.statSync(realRoot).isDirectory()) roots.push({ projectId: project.id, name: project.name, root: realRoot });
        } catch {
            // A project whose directory is gone cannot anchor a document.
        }
    }
    return roots;
}

/**
 * Resolve a requested document path against the allowlisted roots.
 * Returns { ok: true, canonicalPath, root } or { ok: false, status, code, error }.
 */
function resolveDocumentPath(inputPath, roots) {
    if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.includes('\0')) {
        return failure(400, 'invalid_path', 'A document path is required');
    }
    if (!path.isAbsolute(inputPath)) return failure(400, 'invalid_path', 'Document path must be absolute');
    const normalized = path.normalize(inputPath);
    const mediaType = media.classifyPath(normalized);
    if (!mediaType) return failure(415, 'unsupported_media', 'Only allowed review media types can be registered (Markdown, text, code, JSON, HTML, SVG, images, video, audio, PDF, .design.json packages)');
    if (hasForbiddenSegment(normalized)) return failure(403, 'forbidden_path', 'Documents inside .git or node_modules cannot be registered');
    const lexicalRoot = roots.find(entry => insideRoot(normalized, entry.root));
    if (!lexicalRoot) return failure(403, 'outside_roots', 'Document path is outside every registered project');

    let canonicalPath;
    try {
        canonicalPath = fs.realpathSync.native(normalized);
    } catch (err) {
        if (err && err.code === 'ENOENT') return failure(404, 'not_found', 'Document file does not exist');
        return failure(403, 'unresolvable', 'Document path could not be resolved');
    }
    if (media.classifyPath(canonicalPath) !== mediaType) return failure(415, 'unsupported_media', 'Document resolves to a file of a different type');
    if (hasForbiddenSegment(canonicalPath)) return failure(403, 'forbidden_path', 'Document resolves into .git or node_modules');
    const root = roots.find(entry => insideRoot(canonicalPath, entry.root));
    if (!root) return failure(403, 'symlink_escape', 'Document resolves outside every registered project');

    let stat;
    try { stat = fs.statSync(canonicalPath); } catch { return failure(404, 'not_found', 'Document file does not exist'); }
    if (!stat.isFile()) return failure(400, 'not_a_file', 'Document path is not a regular file');
    const maxBytes = media.maxBytesFor(mediaType);
    if (stat.size > maxBytes) return failure(413, 'too_large', `Document exceeds ${maxBytes} bytes`);
    return { ok: true, canonicalPath, root, size: stat.size, mtime: stat.mtime.toISOString(), mediaType, mimeType: media.mimeFor(canonicalPath, mediaType) };
}

function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Read a resolved document. Line endings are normalized to `\n` so stored
 * line numbers and hashes are stable across editors; invalid UTF-8 is refused
 * rather than silently replaced.
 *
 * The exact file is reported alongside: `exactHash` is the SHA-256 of the
 * bytes on disk and `exactContent` decodes them unchanged (BOM and CR kept),
 * so a declared deliverable can bind its receipt, revision and decisions to
 * the delivered bytes while the reviewer keeps the normalized text.
 */
function readDocumentFile(canonicalPath, { maxBytes = MAX_DOCUMENT_BYTES } = {}) {
    let buffer;
    try { buffer = fs.readFileSync(canonicalPath); } catch (err) {
        return failure(err && err.code === 'ENOENT' ? 404 : 500, 'unreadable', 'Document file could not be read');
    }
    if (buffer.length > maxBytes) return failure(413, 'too_large', `Document exceeds ${maxBytes} bytes`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch {
        return failure(422, 'invalid_encoding', 'Document is not valid UTF-8');
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const content = text.replace(/\r\n?/g, '\n');
    return {
        ok: true,
        content,
        contentHash: sha256(content),
        byteLength: Buffer.byteLength(content, 'utf8'),
        lineCount: content.split('\n').length,
        // Valid UTF-8 (checked above) round-trips exactly through this decode.
        exactContent: buffer.toString('utf8'),
        exactHash: createHash('sha256').update(buffer).digest('hex'),
        exactByteLength: buffer.length,
    };
}

/**
 * Read a resolved file of any allowed media type into the uniform capture
 * shape the registry stores. Text types go through `readDocumentFile` (and
 * keep both identities). Binary types carry no reviewer text: `content` is
 * empty, `lineCount` 0 and both hashes are the SHA-256 of the bytes on disk,
 * which are copied into the blob store so the revision survives the file.
 * A design package parses and validates its manifest and resolves every
 * member; its hash is the package hash (contract §2.3) and `assets` lists the
 * members with their own hashes.
 */
function readArtifactFile(canonicalPath, { mediaType = media.classifyPath(canonicalPath), root } = {}) {
    if (!mediaType) return failure(415, 'unsupported_media', 'Unsupported review media type');
    const mimeType = media.mimeFor(canonicalPath, mediaType);
    if (media.isTextMedia(mediaType)) {
        const read = readDocumentFile(canonicalPath, { maxBytes: media.maxBytesFor(mediaType) });
        if (!read.ok) return read;
        const base = { ...read, mediaType, mimeType, binary: false, assets: null, manifest: null };
        if (mediaType !== 'design') return base;
        let parsed;
        try { parsed = JSON.parse(read.exactContent.charCodeAt(0) === 0xfeff ? read.exactContent.slice(1) : read.exactContent); }
        catch { return failure(400, 'invalid_manifest', 'Design package manifest is not valid JSON'); }
        const validated = media.validateDesignManifest(parsed);
        if (!validated.ok) return failure(400, validated.code, validated.error);
        const rootPath = root && typeof root === 'object' ? root.root : root;
        if (!rootPath) return failure(500, 'root_required', 'A project root is required to resolve a design package');
        const resolved = media.resolveDesignMembers(canonicalPath, rootPath, validated.members);
        if (!resolved.ok) return resolved;
        const hash = media.packageHash(read.exactHash, resolved.assets);
        return {
            ...base, manifest: validated.manifest, assets: resolved.assets, selectsDirection: validated.selectsDirection,
            manifestHash: read.exactHash, contentHash: hash, exactHash: hash,
        };
    }
    let stat;
    try { stat = fs.statSync(canonicalPath); } catch (err) {
        return failure(err && err.code === 'ENOENT' ? 404 : 500, 'unreadable', 'Document file could not be read');
    }
    const maxBytes = media.maxBytesFor(mediaType);
    if (stat.size > maxBytes) return failure(413, 'too_large', `Document exceeds ${maxBytes} bytes`);
    const { hash, byteLength } = media.hashFile(canonicalPath);
    let width = null;
    let height = null;
    if (mediaType === 'image') {
        const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
        const fd = fs.openSync(canonicalPath, 'r');
        try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
        const dims = media.imageDimensions(header);
        if (dims) { width = dims.width; height = dims.height; }
    }
    return {
        ok: true, content: '', contentHash: hash, byteLength, lineCount: 0,
        exactContent: null, exactHash: hash, exactByteLength: byteLength,
        mediaType, mimeType, binary: true, width, height, assets: null, manifest: null,
    };
}

module.exports = {
    MAX_DOCUMENT_BYTES,
    listProjectRoots,
    resolveDocumentPath,
    readDocumentFile,
    readArtifactFile,
    sha256,
    isMarkdownPath,
};
