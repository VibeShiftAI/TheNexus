/**
 * Photo attachments on inbox (HITL) answers.
 *
 * Robert answers Praxis questions from the Nexus inbox card. Until task
 * 0df94949 (2026-10-24) the card could carry text and a choice only, so a
 * question that asked for a screenshot could not be answered with one. The
 * repair reuses the chat upload store (server/routes/chat-files.js:
 * data/chat-files/<uuid><ext>, served at /api/chat/files/:fileId) and rides
 * the references on the open-typed `payload.attachments` of the resolve body.
 *
 * This module is the Nexus-side trust boundary for those references. The
 * browser may name a file it uploaded; it may not name anything else. Every
 * reference that reaches Praxis is rebuilt here from the stored file: the id
 * must be a UUID that exists in the store, the bytes must be an image, and the
 * url, mime type and size are derived on the server, never copied from the
 * client. A failure is a 400 that leaves the question pending, so the typed
 * answer stays in the card.
 */
const fs = require('fs');
const path = require('path');

const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Photos and screenshots only: what a phone camera roll or screenshot tool produces. */
const IMAGE_MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
};

const DEFAULT_LIMITS = Object.freeze({
    /** Mirrors the multer cap on the upload route. */
    maxBytes: 25 * 1024 * 1024,
    maxCount: 4,
    maxNameLength: 255,
});

/** Where chat uploads live; NEXUS_CHAT_FILES_DIR lets an isolated stack keep its own store. */
function chatFilesDir() {
    const fromEnv = process.env.NEXUS_CHAT_FILES_DIR;
    return typeof fromEnv === 'string' && fromEnv.trim()
        ? path.resolve(fromEnv.trim())
        : path.join(__dirname, '..', '..', 'data', 'chat-files');
}

/** The stored file for an upload id, or null. Same lookup the GET route uses. */
function findStoredFile(fileId, dir) {
    if (typeof fileId !== 'string' || !FILE_ID_RE.test(fileId)) return null;
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const match = names.find((name) => name.toLowerCase().startsWith(fileId.toLowerCase()) && !name.startsWith('.'));
    if (!match) return null;
    return { name: match, path: path.join(dir, match), ext: path.extname(match).toLowerCase() };
}

/**
 * Check the first bytes against the type the extension claims. A renamed
 * non-image must not reach an executor as a "photo".
 */
function looksLikeImage(filePath, ext) {
    let header;
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            header = Buffer.alloc(16);
            const read = fs.readSync(fd, header, 0, 16, 0);
            header = header.subarray(0, read);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
    if (header.length < 12) return false;
    switch (ext) {
        case '.png':
            return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        case '.jpg':
        case '.jpeg':
            return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
        case '.gif':
            return header.subarray(0, 4).toString('latin1') === 'GIF8';
        case '.webp':
            return header.subarray(0, 4).toString('latin1') === 'RIFF' && header.subarray(8, 12).toString('latin1') === 'WEBP';
        case '.heic':
        case '.heif':
            return header.subarray(4, 8).toString('latin1') === 'ftyp';
        default:
            return false;
    }
}

function cleanName(value, fallback, maxNameLength) {
    if (typeof value !== 'string') return fallback;
    // Strip control characters and path separators; the name is display text.
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]+/g, '-').trim();
    if (!cleaned) return fallback;
    return cleaned.length > maxNameLength ? cleaned.slice(0, maxNameLength) : cleaned;
}

/**
 * Rebuild a client-supplied attachment list from the store.
 *
 * Returns `{ ok: true, attachments }` with server-derived entries, or
 * `{ ok: false, detail }` naming the first problem in plain words.
 */
function normalizeAnswerAttachments(raw, options = {}) {
    const dir = options.dir || chatFilesDir();
    const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    if (!Array.isArray(raw)) return { ok: false, detail: 'attachments must be a list of uploaded files' };
    if (raw.length === 0) return { ok: true, attachments: [] };
    if (raw.length > limits.maxCount) {
        return { ok: false, detail: `Up to ${limits.maxCount} photos can be attached to one answer` };
    }
    const attachments = [];
    const seen = new Set();
    for (const item of raw) {
        const fileId = item && typeof item === 'object' && typeof item.fileId === 'string' ? item.fileId.trim() : '';
        if (!FILE_ID_RE.test(fileId)) {
            return { ok: false, detail: 'Each attachment must name a file uploaded through the Nexus upload API' };
        }
        const key = fileId.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const stored = findStoredFile(fileId, dir);
        if (!stored) return { ok: false, detail: 'The attached file was not found in the Nexus upload store; attach it again' };
        const mimeType = IMAGE_MIME_BY_EXT[stored.ext];
        if (!mimeType) return { ok: false, detail: `Only photos and screenshots can be attached (${stored.ext || 'no extension'} is not an image)` };
        if (!looksLikeImage(stored.path, stored.ext)) {
            return { ok: false, detail: 'The attached file is not a readable image' };
        }
        let size;
        try {
            size = fs.statSync(stored.path).size;
        } catch {
            return { ok: false, detail: 'The attached file could not be read from the Nexus upload store' };
        }
        if (size > limits.maxBytes) {
            return { ok: false, detail: `Photos up to ${Math.floor(limits.maxBytes / (1024 * 1024))} MB can be attached` };
        }
        attachments.push({
            fileId,
            url: `/api/chat/files/${fileId}`,
            mimeType,
            originalName: cleanName(item.originalName, stored.name, limits.maxNameLength),
            size,
        });
    }
    return { ok: true, attachments };
}

/**
 * Express middleware for the HITL resolve proxy. A body without
 * `payload.attachments` passes through untouched (text, choice and voice
 * answers are unchanged); one with them is rebuilt from the store or refused.
 */
function hitlAnswerAttachmentGuard(options = {}) {
    return function guardHitlAnswerAttachments(req, res, next) {
        const payload = req.body && typeof req.body === 'object' ? req.body.payload : undefined;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.attachments === undefined) {
            return next();
        }
        const result = normalizeAnswerAttachments(payload.attachments, options);
        if (!result.ok) {
            return res.status(400).json({ error: 'invalid_attachment', detail: result.detail });
        }
        if (result.attachments.length === 0) {
            delete payload.attachments;
            if (Object.keys(payload).length === 0) delete req.body.payload;
        } else {
            payload.attachments = result.attachments;
        }
        return next();
    };
}

module.exports = {
    DEFAULT_LIMITS,
    FILE_ID_RE,
    IMAGE_MIME_BY_EXT,
    chatFilesDir,
    findStoredFile,
    hitlAnswerAttachmentGuard,
    normalizeAnswerAttachments,
};
