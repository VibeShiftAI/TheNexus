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

function reviewUrlFor(documentId) {
    return `${dashboardBaseUrl()}/documents/${encodeURIComponent(documentId)}`;
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
        created_at: comment.created_at,
        updated_at: comment.updated_at,
    };
}

function buildSubmissionPayload({ submissionId, review, comments, document, revision, source, submittedAt }) {
    return {
        submission_id: submissionId,
        review_id: review.id,
        reviewer_id: review.reviewer_id,
        submitted_at: submittedAt,
        summary: review.summary || '',
        document: {
            id: document.id,
            title: document.title,
            path: document.path,
            kind: document.kind,
            project_id: document.project_id || null,
            task_id: document.task_id || null,
        },
        revision: { id: revision.id, content_hash: revision.content_hash, captured_at: revision.captured_at, line_count: revision.line_count },
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
    const notes = payload.comments.filter(c => c.kind !== 'passage');

    const lines = [
        `[DOCUMENT REVIEW] Robert finished reviewing "${doc.title}".`,
        `Document: ${doc.path}`,
        `Reviewed revision: ${shortHash}${payload.revision?.captured_at ? ` (captured ${payload.revision.captured_at})` : ''}`,
        ...source,
        `Review link: ${payload.review_url}`,
        `Submission id: ${payload.submission_id}`,
        '',
        '**Summary**',
        payload.summary && payload.summary.trim() ? payload.summary.trim() : '(no summary given)',
        '',
    ];

    if (notes.length > 0) {
        lines.push(`**Whole-document notes (${notes.length})**`);
        notes.forEach((note, index) => {
            lines.push(`${index + 1}. ${note.body.trim()}`);
            lines.push('');
        });
    }

    if (passage.length > 0) {
        lines.push(`**Passage comments (${passage.length})**`);
        passage.forEach((comment, index) => {
            const range = comment.start_line === comment.end_line ? `line ${comment.start_line}` : `lines ${comment.start_line}-${comment.end_line}`;
            lines.push(`${index + 1}. On ${range}${comment.selection ? ` (highlighted: "${comment.selection.trim()}")` : ''}:`);
            lines.push(quoteBlock(comment.quote));
            lines.push('');
            lines.push(`Robert: ${comment.body.trim()}`);
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
    reviewUrlFor,
    splitLines,
    verifyPassageAnchor,
    anchorState,
    publicComment,
    buildSubmissionPayload,
    formatSubmissionMessage,
};
