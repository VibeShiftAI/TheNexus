/**
 * Document registry boundary: which local Markdown files may be registered
 * for review and how their content is captured.
 *
 * A document is only ever served by a server-issued id, and only when its
 * REAL path (symlinks resolved) sits inside the real path of a registered
 * project. Both the path as given and the resolved path must be Markdown, so
 * a `.md` symlink to `.env` is refused, and a link that resolves outside every
 * project root is refused as a symlink escape. Nothing here serves arbitrary
 * local files.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

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
    if (!isMarkdownPath(normalized)) return failure(415, 'not_markdown', 'Only Markdown (.md, .markdown) documents can be registered');
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
    if (!isMarkdownPath(canonicalPath)) return failure(415, 'not_markdown', 'Document resolves to a non-Markdown file');
    if (hasForbiddenSegment(canonicalPath)) return failure(403, 'forbidden_path', 'Document resolves into .git or node_modules');
    const root = roots.find(entry => insideRoot(canonicalPath, entry.root));
    if (!root) return failure(403, 'symlink_escape', 'Document resolves outside every registered project');

    let stat;
    try { stat = fs.statSync(canonicalPath); } catch { return failure(404, 'not_found', 'Document file does not exist'); }
    if (!stat.isFile()) return failure(400, 'not_a_file', 'Document path is not a regular file');
    if (stat.size > MAX_DOCUMENT_BYTES) return failure(413, 'too_large', `Document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    return { ok: true, canonicalPath, root, size: stat.size, mtime: stat.mtime.toISOString() };
}

function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Read a resolved document. Line endings are normalized to `\n` so stored
 * line numbers and hashes are stable across editors; invalid UTF-8 is refused
 * rather than silently replaced.
 */
function readDocumentFile(canonicalPath) {
    let buffer;
    try { buffer = fs.readFileSync(canonicalPath); } catch (err) {
        return failure(err && err.code === 'ENOENT' ? 404 : 500, 'unreadable', 'Document file could not be read');
    }
    if (buffer.length > MAX_DOCUMENT_BYTES) return failure(413, 'too_large', `Document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
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
    };
}

module.exports = {
    MAX_DOCUMENT_BYTES,
    listProjectRoots,
    resolveDocumentPath,
    readDocumentFile,
    sha256,
    isMarkdownPath,
};
