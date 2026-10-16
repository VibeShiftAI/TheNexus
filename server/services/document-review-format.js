/**
 * Pure helpers shared by the document review API and its delivery outbox:
 * anchor verification against a pinned revision, anchor state against the
 * current revision, the submission payload snapshot and the verbatim chat
 * turn Praxis receives. No I/O here so both sides can be tested directly.
 */
const { sha256 } = require('./document-registry');

const DEFAULT_DASHBOARD_URL = 'https://nexus.vibeshiftai.com';

function dashboardBaseUrl() {
    const configured = process.env.NEXUS_DASHBOARD_URL;
    return (typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_DASHBOARD_URL).replace(/\/+$/, '');
}

/** Relative in-app route of the shared reviewer; dashboards link with this so the app never leaves its session. */
function reviewPathFor(documentId) {
    return `/documents/${encodeURIComponent(documentId)}`;
}

function reviewUrlFor(documentId) {
    return `${dashboardBaseUrl()}${reviewPathFor(documentId)}`;
}

function splitLines(content) {
    return String(content ?? '').split('\n');
}

/**
 * Verify a passage anchor against the pinned revision content. The quote must
 * equal the exact source lines; the block hash is derived here, never trusted
 * from the client.
 */
function verifyPassageAnchor({ start_line, end_line, quote }, content) {
    const lines = splitLines(content);
    const start = Number(start_line);
    const end = Number(end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
        return { ok: false, code: 'invalid_anchor', error: `Anchor lines must lie within 1..${lines.length}` };
    }
    const expected = lines.slice(start - 1, end).join('\n');
    if (typeof quote !== 'string' || quote !== expected) {
        return { ok: false, code: 'anchor_mismatch', error: 'Quoted passage does not match the reviewed revision at those lines' };
    }
    return { ok: true, start_line: start, end_line: end, quote: expected, block_hash: sha256(expected) };
}

/**
 * Where a pinned passage stands in the current revision: intact (same lines),
 * moved (same text elsewhere) or orphaned (text no longer present). Whole
 * document notes are always `document`.
 */
function anchorState(comment, currentContent, pinnedHash, currentHash) {
    if (comment.kind !== 'passage') return { state: 'document' };
    if (pinnedHash && currentHash && pinnedHash === currentHash) return { state: 'intact', current_start_line: comment.start_line };
    const lines = splitLines(currentContent);
    const quoteLines = splitLines(comment.quote);
    const span = quoteLines.length;
    for (let i = 0; i + span <= lines.length; i++) {
        if (lines[i] !== quoteLines[0]) continue;
        if (lines.slice(i, i + span).join('\n') === comment.quote) {
            const currentStart = i + 1;
            return currentStart === comment.start_line
                ? { state: 'intact', current_start_line: currentStart }
                : { state: 'moved', current_start_line: currentStart };
        }
    }
    return { state: 'orphaned', current_start_line: null };
}

/** Media comment kinds and the anchor each carries (contract §3.1). */
const MEDIA_COMMENT_KINDS = new Set(['region', 'point', 'time', 'page', 'screen']);
const ANCHOR_MEDIA = {
    region: new Set(['image', 'svg', 'html', 'pdf']),
    point: new Set(['image', 'svg', 'html', 'pdf']),
    time: new Set(['video', 'audio']),
    page: new Set(['pdf']),
    screen: new Set(['image', 'svg']),
};

function unit(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function roundUnit(value) { return Math.round(value * 10000) / 10000; }

function validRegion(region) {
    if (!region || typeof region !== 'object') return null;
    const { x, y, w, h } = region;
    if (![x, y, w, h].every(unit) || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return null;
    return { x: roundUnit(x), y: roundUnit(y), w: roundUnit(Math.min(w, 1 - x)), h: roundUnit(Math.min(h, 1 - y)) };
}

function formatSeconds(seconds) {
    const total = Math.max(0, Math.round(seconds * 10) / 10);
    const minutes = Math.floor(total / 60);
    const rest = total - minutes * 60;
    const secs = Number.isInteger(rest) ? String(rest).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
    return `${minutes}:${secs}`;
}

/**
 * Verify a media anchor against the assets of the pinned revision. The asset
 * must exist in that revision and be of a type the anchor kind applies to;
 * coordinates are normalized and clamped; the label is derived here, never
 * trusted from the client.
 */
function verifyMediaAnchor(kind, rawAnchor, assets) {
    if (!MEDIA_COMMENT_KINDS.has(kind)) return { ok: false, code: 'invalid_anchor', error: 'Unknown comment kind' };
    if (!rawAnchor || typeof rawAnchor !== 'object' || Array.isArray(rawAnchor)) return { ok: false, code: 'invalid_anchor', error: 'anchor must be an object' };
    const assetKey = typeof rawAnchor.asset_key === 'string' ? rawAnchor.asset_key : null;
    const asset = assetKey ? (assets || []).find(a => a.asset_key === assetKey) : null;
    if (!asset) return { ok: false, code: 'anchor_mismatch', error: 'anchor.asset_key does not name an asset of the reviewed revision' };
    if (kind === 'screen' ? asset.role !== 'screen' : !ANCHOR_MEDIA[kind].has(asset.media_type)) {
        return { ok: false, code: 'invalid_anchor', error: `A ${kind} comment cannot be placed on a ${asset.role} ${asset.media_type} asset` };
    }
    const anchor = { asset_key: assetKey, asset_hash: asset.content_hash };
    const assetLabel = asset.label || assetKey;
    const screenLabel = [assetLabel, asset.direction, asset.appearance].filter(Boolean).join(' · ');
    let label;
    switch (kind) {
        case 'region': {
            const region = validRegion(rawAnchor);
            if (!region) return { ok: false, code: 'invalid_anchor', error: 'A region needs x, y, w, h in 0..1 with w and h above 0' };
            Object.assign(anchor, region);
            label = `${screenLabel} at (${Math.round(region.x * 100)}%, ${Math.round(region.y * 100)}%) ${Math.round(region.w * 100)}×${Math.round(region.h * 100)}%`;
            break;
        }
        case 'point': {
            if (!unit(rawAnchor.x) || !unit(rawAnchor.y)) return { ok: false, code: 'invalid_anchor', error: 'A point needs x and y in 0..1' };
            anchor.x = roundUnit(rawAnchor.x); anchor.y = roundUnit(rawAnchor.y);
            if (rawAnchor.viewport !== undefined && rawAnchor.viewport !== null) {
                if (typeof rawAnchor.viewport !== 'string' || !rawAnchor.viewport.trim() || rawAnchor.viewport.length > 60) return { ok: false, code: 'invalid_anchor', error: 'viewport must be 1-60 characters' };
                anchor.viewport = rawAnchor.viewport.trim();
            }
            label = `${screenLabel} at (${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%)${anchor.viewport ? ` on ${anchor.viewport}` : ''}`;
            break;
        }
        case 'time': {
            const start = rawAnchor.t_start;
            if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start > 86400 * 7) return { ok: false, code: 'invalid_anchor', error: 'A time anchor needs t_start in seconds' };
            anchor.t_start = Math.round(start * 1000) / 1000;
            if (rawAnchor.t_end !== undefined && rawAnchor.t_end !== null) {
                const end = rawAnchor.t_end;
                if (typeof end !== 'number' || !Number.isFinite(end) || end < start) return { ok: false, code: 'invalid_anchor', error: 't_end must be a number at or after t_start' };
                anchor.t_end = Math.round(end * 1000) / 1000;
            }
            label = anchor.t_end !== undefined && anchor.t_end !== anchor.t_start
                ? `${assetLabel !== 'primary' ? `${assetLabel} ` : ''}${formatSeconds(anchor.t_start)}–${formatSeconds(anchor.t_end)}`
                : `${assetLabel !== 'primary' ? `${assetLabel} ` : ''}${formatSeconds(anchor.t_start)}`;
            break;
        }
        case 'page': {
            const page = rawAnchor.page;
            if (!Number.isInteger(page) || page < 1 || page > 100000) return { ok: false, code: 'invalid_anchor', error: 'A page anchor needs an integer page ≥ 1' };
            anchor.page = page;
            const region = rawAnchor.x !== undefined ? validRegion(rawAnchor) : null;
            if (rawAnchor.x !== undefined && !region) return { ok: false, code: 'invalid_anchor', error: 'A page region needs x, y, w, h in 0..1' };
            if (region) Object.assign(anchor, region);
            label = `page ${page}${region ? ` at (${Math.round(region.x * 100)}%, ${Math.round(region.y * 100)}%)` : ''}`;
            break;
        }
        case 'screen': {
            const region = rawAnchor.region !== undefined && rawAnchor.region !== null ? validRegion(rawAnchor.region) : null;
            if (rawAnchor.region !== undefined && rawAnchor.region !== null && !region) return { ok: false, code: 'invalid_anchor', error: 'region needs x, y, w, h in 0..1 with w and h above 0' };
            if (region) anchor.region = region;
            label = region ? `${screenLabel} at (${Math.round(region.x * 100)}%, ${Math.round(region.y * 100)}%) ${Math.round(region.w * 100)}×${Math.round(region.h * 100)}%` : screenLabel;
            break;
        }
        default:
            return { ok: false, code: 'invalid_anchor', error: 'Unknown comment kind' };
    }
    return { ok: true, anchor, target_label: label.slice(0, 300) };
}

/**
 * Where a media comment's asset stands in the current revision: intact when
 * the same key holds the same bytes, moved when those bytes live under another
 * key, otherwise orphaned.
 */
function mediaAnchorState(comment, currentAssets) {
    const anchor = comment.anchor;
    if (!anchor || typeof anchor !== 'object') return { state: 'orphaned', current_asset_key: null };
    const same = (currentAssets || []).find(a => a.asset_key === anchor.asset_key);
    if (same && same.content_hash === anchor.asset_hash) return { state: 'intact', current_asset_key: anchor.asset_key };
    const moved = (currentAssets || []).find(a => a.content_hash === anchor.asset_hash);
    if (moved) return { state: 'moved', current_asset_key: moved.asset_key };
    return { state: 'orphaned', current_asset_key: null };
}

function publicComment(comment) {
    return {
        id: comment.id,
        kind: comment.kind,
        start_line: comment.start_line,
        end_line: comment.end_line,
        block_hash: comment.block_hash,
        quote: comment.quote,
        selection: comment.selection,
        body: comment.body,
        anchor_target: comment.anchor ?? null,
        target_label: comment.target_label ?? null,
        parent_id: comment.parent_id ?? null,
        resolved: Boolean(comment.resolved_at),
        resolved_at: comment.resolved_at ?? null,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
    };
}

function buildSubmissionPayload({ submissionId, review, comments, document, revision, source, submittedAt, selectedDirection = null }) {
    return {
        media_type: document.media_type || revision.media_type || 'markdown',
        selected_direction: selectedDirection,
        submission_id: submissionId,
        review_id: review.id,
        reviewer_id: review.reviewer_id,
        submitted_at: submittedAt,
        summary: review.summary || '',
        // Robert's explicit approve-after-changes grant and the operator proof it was made with (task a2553798).
        approval_delegated: review.approval_delegated === true,
        submitted_authority: review.submitted_authority || null,
        document: {
            id: document.id,
            title: document.title,
            path: document.path,
            kind: document.kind,
            project_id: document.project_id || null,
            task_id: document.task_id || null,
        },
        revision: { id: revision.id, content_hash: revision.content_hash, captured_at: revision.captured_at, line_count: revision.line_count, media_type: revision.media_type || 'markdown', asset_count: revision.asset_count ?? 1 },
        source: {
            task: source?.task ? { id: source.task.id, title: source.task.title || null, status: source.task.status || null } : null,
            project: source?.project ? { id: source.project.id, name: source.project.name || null } : null,
        },
        review_url: reviewUrlFor(document.id),
        comments: comments.map(publicComment),
    };
}

function quoteBlock(text) {
    return String(text ?? '').split('\n').map(line => `> ${line}`).join('\n');
}

/**
 * The verbatim turn delivered into the Praxis conversation. Every comment is
 * reproduced in full with its quoted passage; nothing is summarized.
 */
function formatSubmissionMessage(payload) {
    const doc = payload.document;
    const shortHash = String(payload.revision?.content_hash || '').slice(0, 12);
    const source = [];
    if (payload.source?.task) source.push(`Source task: ${payload.source.task.title ? `"${payload.source.task.title}" ` : ''}(${payload.source.task.id})`);
    if (payload.source?.project) source.push(`Project: ${payload.source.project.name || payload.source.project.id}`);
    const passage = payload.comments.filter(c => c.kind === 'passage');
    const media = payload.comments.filter(c => MEDIA_COMMENT_KINDS.has(c.kind));
    const notes = payload.comments.filter(c => c.kind !== 'passage' && !MEDIA_COMMENT_KINDS.has(c.kind));
    const roots = list => list.filter(c => !c.parent_id);
    const repliesTo = id => payload.comments.filter(c => c.parent_id === id);

    const lines = [
        `[DOCUMENT REVIEW] Robert finished reviewing "${doc.title}".`,
        `Document: ${doc.path}${payload.media_type && payload.media_type !== 'markdown' ? ` (${payload.media_type})` : ''}`,
        ...(payload.selected_direction ? [`Selected direction: ${payload.selected_direction}`] : []),
        `Reviewed revision: ${shortHash}${payload.revision?.captured_at ? ` (captured ${payload.revision.captured_at})` : ''}`,
        ...source,
        `Review link: ${payload.review_url}`,
        `Submission id: ${payload.submission_id}`,
        '',
        '**Summary**',
        payload.summary && payload.summary.trim() ? payload.summary.trim() : '(no summary given)',
        '',
    ];

    if (payload.approval_delegated) {
        lines.push('**Approval delegated**');
        lines.push(`Robert finished this review with the approve-after-changes grant (${payload.submitted_authority}). Once the requested change is made and the resulting revision is registered, the executor records his approval of that revision with TheNexus/scripts/record-document-approval.js, citing submission ${payload.submission_id}. Nothing else is approved by this.`);
        lines.push('');
    }

    const replyLines = comment => repliesTo(comment.id).map(reply => `   ↳ Robert (reply): ${reply.body.trim()}`);
    const resolvedTag = comment => (comment.resolved ? ' [resolved]' : '');

    if (roots(notes).length > 0) {
        lines.push(`**Whole-document notes (${roots(notes).length})**`);
        roots(notes).forEach((note, index) => {
            lines.push(`${index + 1}. ${note.body.trim()}${resolvedTag(note)}`);
            lines.push(...replyLines(note));
            lines.push('');
        });
    }

    if (roots(passage).length > 0) {
        lines.push(`**Passage comments (${roots(passage).length})**`);
        roots(passage).forEach((comment, index) => {
            const range = comment.start_line === comment.end_line ? `line ${comment.start_line}` : `lines ${comment.start_line}-${comment.end_line}`;
            lines.push(`${index + 1}. On ${range}${comment.selection ? ` (highlighted: "${comment.selection.trim()}")` : ''}${resolvedTag(comment)}:`);
            lines.push(quoteBlock(comment.quote));
            lines.push('');
            lines.push(`Robert: ${comment.body.trim()}`);
            lines.push(...replyLines(comment));
            lines.push('');
        });
    }

    if (roots(media).length > 0) {
        lines.push(`**Media comments (${roots(media).length})**`);
        roots(media).forEach((comment, index) => {
            lines.push(`${index + 1}. [${comment.target_label || comment.anchor_target?.asset_key || comment.kind}]${resolvedTag(comment)} ${comment.body.trim()}`);
            lines.push(...replyLines(comment));
            lines.push('');
        });
    }

    if (payload.comments.length === 0) {
        lines.push('Robert finished the review without adding comments.');
        lines.push('');
    }

    lines.push('This feedback is verbatim from the document reviewer; the document itself is unchanged. Reply here as usual.');
    return lines.join('\n');
}

module.exports = {
    DEFAULT_DASHBOARD_URL,
    dashboardBaseUrl,
    reviewPathFor,
    reviewUrlFor,
    splitLines,
    verifyPassageAnchor,
    anchorState,
    MEDIA_COMMENT_KINDS,
    verifyMediaAnchor,
    mediaAnchorState,
    formatSeconds,
    publicComment,
    buildSubmissionPayload,
    formatSubmissionMessage,
};
