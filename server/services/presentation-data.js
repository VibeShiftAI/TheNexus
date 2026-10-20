/** Read-only, allowlisted presentation projections and immutable document captures. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { normalizeTaskBoardStatus } = require('@praxis/contract');
const media = require('./review-media');
const { praxisFetch } = require('./praxis-client');
const { validDispatchSnapshot } = require('./focus-usage-waits');

const MIB = 1024 * 1024;
const MIME_TYPES = {
    markdown: new Set(['text/markdown']),
    pdf: new Set(['application/pdf']),
    image: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']),
    video: new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']),
};
const ACTIVE = new Set(['dispatched', 'in_progress']);
const QUEUED = new Set(['todo', 'scheduled']);
const text = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : '';
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function presentationError(code, status, message) {
    return Object.assign(new Error(message || code.replaceAll('_', ' ')), { code, status, presentation: true });
}

async function readPresentationActivity() {
    const response = await praxisFetch('/api/dispatch/state', { timeoutMs: 4_000 });
    if (!response.ok) throw new Error('Activity unavailable');
    return response.json();
}

function createPresentationData({ db, now = Date.now, readActivity = readPresentationActivity,
    captureRoot = path.resolve(__dirname, '../../data/presentation-captures'),
    maxAssetBytes = 128 * MIB, maxTotalAssetBytes = 512 * MIB }) {
    let captureDir;
    let reservedBytes = 0;
    let closed = false;
    const captures = new Set();

    async function capture(view) {
        if (view.kind !== 'document') return null;
        const store = db?.documentReviews;
        const doc = store?.getDocument(view.documentId);
        const revision = store?.getRevision(view.revisionId);
        if (!doc || !revision) throw presentationError('document_not_found', 404, 'The selected registered document revision is unavailable.');
        if (revision.document_id !== doc.id || revision.content_hash !== view.contentHash) {
            throw presentationError('revision_mismatch', 409, 'The document, revision, and hash must identify the same registered content.');
        }
        const mediaType = revision.media_type || 'markdown';
        const mimeType = revision.mime_type || 'text/markdown';
        if (!MIME_TYPES[mediaType]?.has(mimeType)) throw presentationError('unsupported_media', 415, 'Presentations support registered Markdown, PDF, images, and video.');
        const base = { title: text(doc.title) || 'Selected document', mediaType, mimeType };
        if (mediaType === 'markdown') {
            // Registered text snapshots are the byte source, including older revisions
            // whose live file has changed. Exact CRLF/BOM content takes precedence.
            const content = store.getRevisionExact?.(revision.id) ?? revision.content;
            if (typeof content !== 'string') throw presentationError('asset_unavailable', 409, 'The selected revision has no registered text snapshot.');
            const bytes = Buffer.from(content, 'utf8');
            if (bytes.length > media.maxBytesFor('markdown')) throw presentationError('asset_too_large', 413, 'The selected text exceeds the presentation limit.');
            if (media.sha256(bytes) !== view.contentHash || bytes.length !== revision.byte_length) {
                throw presentationError('revision_mismatch', 409, 'The registered text does not match the selected revision hash.');
            }
            return { ...base, content, bytes, byteLength: bytes.length, release() {} };
        }
        const assets = store.listRevisionAssets?.(revision.id) || [];
        const primary = assets.filter(asset => asset.asset_key === 'primary' && asset.role === 'primary');
        const asset = primary[0];
        if (primary.length !== 1 || asset.content_hash !== view.contentHash || asset.media_type !== mediaType
            || asset.mime_type !== mimeType || asset.byte_length !== revision.byte_length
            || (asset.document_id && asset.document_id !== doc.id) || (asset.revision_id && asset.revision_id !== revision.id)) {
            throw presentationError('asset_unavailable', 409, 'The exact registered primary asset is unavailable.');
        }
        if (!Number.isSafeInteger(asset.byte_length) || asset.byte_length <= 0 || asset.byte_length > Math.min(maxAssetBytes, media.maxBytesFor(mediaType))) {
            throw presentationError('asset_too_large', 413, 'The selected media exceeds the 128 MiB presentation limit.');
        }
        if (closed || reservedBytes + asset.byte_length > maxTotalAssetBytes) throw presentationError('capture_capacity', 429, 'Presentation media capacity is full. Stop an existing presentation first.');
        // Review-media readiness includes image decoding. Its blob lookup alone does
        // not hash blobs, so the copy below verifies every byte once more.
        if (!media.readinessOf([asset]).ready) throw presentationError('asset_unavailable', 409, 'The selected registered media is not ready.');
        const located = media.locateAssetBytes(asset);
        if (!located) throw presentationError('asset_unavailable', 409, 'The selected registered media is unavailable.');
        if (!captureDir) {
            fs.mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
            captureDir = fs.mkdtempSync(path.join(captureRoot, 'capture-'));
        }
        const capturedPath = path.join(captureDir, randomUUID());
        reservedBytes += asset.byte_length;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            reservedBytes -= asset.byte_length;
            captures.delete(release);
            fs.rmSync(capturedPath, { force: true });
        };
        captures.add(release);
        try {
            const digest = createHash('sha256');
            let count = 0;
            const verifier = new Transform({ transform(chunk, _encoding, callback) {
                count += chunk.length;
                if (count > asset.byte_length) return callback(presentationError('revision_mismatch', 409, 'The registered media changed during capture.'));
                digest.update(chunk);
                callback(null, chunk);
            } });
            await pipeline(fs.createReadStream(located.path), verifier, fs.createWriteStream(capturedPath, { flags: 'wx', mode: 0o600 }));
            if (closed || released) throw presentationError('session_unavailable', 410, 'The presentation service has closed.');
            if (count !== asset.byte_length || digest.digest('hex') !== view.contentHash) throw presentationError('revision_mismatch', 409, 'The registered media does not match the selected revision hash.');
            fs.chmodSync(capturedPath, 0o400);
            return { ...base, content: null, path: capturedPath, byteLength: count, release };
        } catch (error) {
            release();
            if (error.presentation) throw error;
            throw presentationError('asset_unavailable', 409, 'The selected registered media could not be captured.');
        }
    }

    async function boardTasks() {
        const projects = await db.getProjects();
        const tasks = [];
        for (const project of projects) {
            if (project.status === 'archived') continue;
            for (const task of await db.getTasks(project.id)) {
                tasks.push({ id: text(task.id, 240), title: text(task.name ?? task.title), project: text(project.name, 160),
                    status: normalizeTaskBoardStatus(task.status) || 'unknown', updatedAt: timestamp(task.updated_at) });
            }
        }
        return tasks;
    }

    async function project(view, captured, assetUrl) {
        if (view.kind === 'document') {
            const current = db.documentReviews.getDocument(view.documentId);
            return {
                kind: 'document', documentId: view.documentId, revisionId: view.revisionId, contentHash: view.contentHash,
                title: captured.title, mediaType: captured.mediaType, mimeType: captured.mimeType,
                content: captured.content, assetUrl: captured.mediaType === 'markdown' ? null : assetUrl,
                assetByteLength: captured.mediaType === 'markdown' ? null : captured.byteLength,
                newerRevisionAvailable: Boolean(current?.current_revision_id && current.current_revision_id !== view.revisionId),
            };
        }
        if (view.kind === 'day-plan') {
            const date = new Date(`${view.date}T00:00:00.000Z`);
            if (date.toISOString().slice(0, 10) !== view.date) throw presentationError('invalid_date', 400, 'Choose a valid calendar date.');
            // A calendar date is the server's local calendar day, matching the
            // cockpit calendar. Convert both local midnights to UTC for storage.
            const midnight = new Date(`${view.date}T00:00:00`);
            const following = new Date(midnight);
            following.setDate(following.getDate() + 1);
            const start = midnight.toISOString();
            const end = new Date(following.getTime() - 1).toISOString();
            const events = (await db.getCalendarEvents(start, end)).filter(event => timestamp(event.start_time)).map(event => ({
                id: text(event.id, 240), title: text(event.title), startsAt: timestamp(event.start_time),
                endsAt: timestamp(event.end_time), status: text(event.status, 80),
            }));
            return { kind: 'day-plan', date: view.date, events: events.slice(0, 100), truncated: events.length > 100 };
        }
        const tasks = await boardTasks();
        if (view.kind === 'ambient') return {
            kind: 'ambient', counts: { active: tasks.filter(t => ACTIVE.has(t.status)).length,
                queued: tasks.filter(t => QUEUED.has(t.status)).length, completed: tasks.filter(t => t.status === 'completed').length },
            label: 'Task board status (not live execution). Active: dispatched / in progress. Queued: to do / scheduled.',
        };
        let activity = { available: false, taskIds: [], snapshotAt: null };
        try {
            const state = await readActivity();
            if (!validDispatchSnapshot(state)) throw new Error('Invalid activity');
            const knownIds = new Set(tasks.map(task => task.id));
            const taskIds = [...new Set(state.executors.runs.filter(run => run.status === 'active' && knownIds.has(run.taskId)).map(run => run.taskId))].slice(0, 100);
            activity = { available: true, taskIds, snapshotAt: new Date(now()).toISOString() };
        } catch { /* A board status must never stand in for unavailable runtime evidence. */ }
        const liveIds = new Set(activity.taskIds);
        const selected = view.mode === 'active' ? tasks.filter(t => ACTIVE.has(t.status) || liveIds.has(t.id)) : tasks;
        return { kind: 'focus', mode: view.mode, tasks: selected.slice(0, 100), truncated: selected.length > 100, activity };
    }

    function close() {
        closed = true;
        for (const release of captures) release();
        if (captureDir) fs.rmSync(captureDir, { recursive: true, force: true });
    }

    return { capture, project, close };
}

module.exports = { createPresentationData, presentationError };
