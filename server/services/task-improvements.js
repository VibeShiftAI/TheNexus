/** Read-only projection of optional QA improvement records; never expose runtime internals. */
const fs = require('fs');
const path = require('path');
const { publicText } = require('./task-progress');
const RUN_STATUSES = new Set(['running', 'reviewing', 'verified', 'declined', 'needs_attention']);
const MAX_RUN_BYTES = 256 * 1024;
const MAX_FINALIZATION_BYTES = 4 * 1024 * 1024;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : null;
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const suggestions = value => Array.isArray(value) ? value.slice(0, 40).map(item => ({ source: publicText(item?.source), text: publicText(item?.text) })).filter(item => item.text) : [];

function projectRun(record) {
    let status = RUN_STATUSES.has(record.status) ? record.status : 'unknown';
    let reason = publicText(record.reason);
    const author = publicText(record.author) || 'Unknown';
    const rawReview = record.review;
    const review = rawReview && ['pass', 'fail'].includes(rawReview.assessment) ? {
        assessment: rawReview.assessment, notes: publicText(rawReview.notes),
        evidence: Array.isArray(rawReview.evidence) ? rawReview.evidence.slice(0, 40).map(publicText).filter(Boolean).join('\n') : publicText(rawReview.evidence),
        reviewer: publicText(rawReview.reviewer),
    } : undefined;
    if (status === 'verified' && !(review?.assessment === 'pass' && review.evidence && review.reviewer && author !== 'Unknown' && review.reviewer !== author)) {
        status = 'needs_attention';
        reason = 'The recorded verified status lacks independent passing review evidence.';
    }
    return { id: record.id, taskId: record.taskId, startedAt: timestamp(record.createdAt), status, updatedAt: timestamp(record.updatedAt) || timestamp(record.createdAt), author,
        ...(identifier(record.dispatchId) ? { dispatchId: record.dispatchId } : {}), suggestions: suggestions(record.suggestions),
        reason: reason || ({ running: 'Improvement work was dispatched; completion has not been verified.', reviewing: 'The improvement changes are awaiting an independent QA result.', verified: 'Independent QA passed for these improvement changes.', declined: 'The improvement suggestions were declined.', needs_attention: 'The improvement work needs attention.', unknown: 'The improvement state could not be confirmed.' }[status]),
        ...(review ? { review } : {}), ...(typeof record.commitSha === 'string' && /^[a-f\d]{7,64}$/i.test(record.commitSha) ? { commitSha: record.commitSha } : {}) };
}
function projectFollowupReview(value) {
    if (!value || !['proposed', 'retained', 'completed'].includes(value.status)) return undefined;
    return { status: value.status, reviewedAt: timestamp(value.reviewedAt), reason: publicText(value.reason),
        ...(identifier(value.slateId) ? { slateId: value.slateId } : {}),
        ...(Number.isSafeInteger(value.priority) && value.priority > 0 ? { priority: value.priority } : {}),
        decisions: Array.isArray(value.decisions) ? value.decisions.slice(0, 40).filter(d => d && Number.isSafeInteger(d.index) && d.index >= 0 && ['execute', 'retain', 'complete'].includes(d.disposition)).map(d => ({
            index: d.index, disposition: d.disposition, reason: publicText(d.reason),
            evidence: Array.isArray(d.evidence) ? d.evidence.slice(0, 40).map(publicText).filter(Boolean) : [],
        })) : [],
    };
}
function projectFinalization(record) {
    const states = {
        pending: ['waiting', 'Awaiting follow-up review after thirty continuous idle minutes.'],
        deferred: ['waiting', 'Awaiting follow-up review after thirty continuous idle minutes.'],
        dispatching: ['unknown', 'Improvement dispatch was started, but no durable run confirms whether it is running or finished.'],
        sent: ['unknown', 'Improvement dispatch was sent, but no durable run or independent QA result is available.'],
        'not-sent': ['needs_attention', 'The improvement suggestions were not dispatched.'],
    };
    const optionalTaskId = typeof record.optionalTaskId === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(record.optionalTaskId) ? record.optionalTaskId : null;
    const followupReview = projectFollowupReview(record.followupReview);
    const [status, reason] = followupReview ? (optionalTaskId ? ['linked', 'Current execution and QA status are tracked in the linked follow-up task.'] : [followupReview.status === 'completed' ? 'completed_after_review' : followupReview.status, followupReview.reason || 'Follow-up review recorded.']) : record.optionalReview?.required ? ['review_held', publicText(record.optionalReview.reason) || 'Awaiting relevance review by Praxis before scheduling.'] : optionalTaskId ? ['linked', 'Current execution and QA status are tracked in the linked follow-up task.'] : states[record.optionalStatus] || ['unknown', 'The improvement dispatch state could not be confirmed.'];
    return { id: record.id, taskId: record.taskId, reviewRequired: !followupReview && record.optionalReview?.required === true, ...(followupReview ? { followupReview } : {}), ...(optionalTaskId ? { optionalTaskId } : {}), status, updatedAt: followupReview?.reviewedAt || (record.optionalReview?.required ? timestamp(record.optionalReview.heldAt) : null) || timestamp(record.optionalStartedAt) || timestamp(record.completedAt) || timestamp(record.createdAt), author: publicText(record.evidence?.author) || 'Unknown', suggestions: suggestions(record.opts?.improvements?.suggestions), reason };
}

// v1 is one complete property on the first line, inside an ordinary JSON object.
// Writer: Praxis/src/orchestrator/dashboard-record-header.ts. These summaries
// describe activity; they are not proof of the integrity of the full report body.
const MAX_HEADER_BYTES = 64 * 1024;
const HEADER_PREFIX = '{"_dashboardSummary":';
function readRecord(fd, stat, folder, budget) {
    if (!stat.isFile()) throw Error('Not a regular record');
    const read = (buffer, offset, length, position) => {
        if (budget.bytes + length > 32 * 1024 * 1024) throw Error('Scan byte limit');
        const count = fs.readSync(fd, buffer, offset, length, position);
        budget.bytes += count;
        if (count !== length) throw Error('Incomplete record read');
    };
    const prefix = Buffer.alloc(Math.min(stat.size, MAX_HEADER_BYTES));
    let used = 0;
    while (used < prefix.length) {
        const count = Math.min(4096, prefix.length - used);
        read(prefix, used, count, used); used += count;
        if (!prefix.subarray(0, used).toString('utf8').startsWith(HEADER_PREFIX)) break;
        const newline = prefix.subarray(0, used).indexOf(10);
        if (newline < 0) continue;
        const line = prefix.subarray(0, newline).toString('utf8');
        if (!line.endsWith(',')) throw Error('Invalid header framing');
        const summary = JSON.parse(line.slice(0, -1) + '}')._dashboardSummary;
        if (summary?.version !== 1 || summary.kind !== folder || !summary.record ||
            typeof summary.record !== 'object' || Array.isArray(summary.record)) throw Error('Invalid summary');
        return summary.record;
    }
    if (prefix.subarray(0, used).toString('utf8').startsWith(HEADER_PREFIX)) throw Error('Incomplete or oversized header');
    const maxBytes = folder === 'qa-improvement-runs' ? MAX_RUN_BYTES : MAX_FINALIZATION_BYTES;
    if (stat.size > maxBytes) throw Error('Legacy record size limit');
    const buffer = Buffer.alloc(stat.size);
    prefix.copy(buffer, 0, 0, used);
    read(buffer, used, stat.size - used, used);
    const record = JSON.parse(buffer.toString('utf8'));
    // A recognized header may not bypass validation by being moved/reformatted.
    if (record && Object.hasOwn(record, '_dashboardSummary')) throw Error('Invalid header position');
    return record;
}

function readTaskImprovements(taskId, { dataDir = process.env.PRAXIS_DATA_DIR || '/Volumes/Projects/Praxis/data', maxFiles = 1000 } = {}) {
    const items = new Map(); let available = true; let foundDirectory = false; let files = 0; const budget = { bytes: 0 };
    // All loops and reads are bounded. A partial scan is visibly unavailable, never an empty success.
    for (const folder of ['qa-improvement-runs', 'task-finalizations']) {
        let directory;
        try {
            const root = fs.realpathSync(dataDir); const candidate = path.join(root, folder);
            if (fs.lstatSync(candidate).isSymbolicLink()) { available = false; continue; }
            directory = fs.opendirSync(candidate); foundDirectory = true;
            let entry;
            while ((entry = directory.readSync())) {
                if (++files > Math.min(maxFiles, 1000)) { available = false; break; }
                if (!entry.name.endsWith('.json')) continue;
                if (!entry.isFile() || entry.isSymbolicLink()) { available = false; continue; }
                let fd;
                try {
                    fd = fs.openSync(path.join(candidate, entry.name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                    const stat = fs.fstatSync(fd);
                    const record = readRecord(fd, stat, folder, budget);
                    if (!record || typeof record !== 'object') { available = false; continue; }
                    if (taskId !== undefined && record.taskId !== taskId) continue;
                    if (!identifier(record.taskId)) { available = false; continue; }
                    if (!identifier(record.id)) { available = false; continue; }
                    if (folder === 'qa-improvement-runs') items.set(record.id, projectRun(record));
                    else {
                        const finalization = projectFinalization(record);
                        const legacy = items.get(record.id);
                        if (!legacy && (finalization.suggestions.length || finalization.optionalTaskId)) items.set(record.id, finalization);
                        else if (legacy && legacy.taskId === record.taskId && (finalization.optionalTaskId || finalization.reviewRequired || finalization.followupReview)) {
                            // Preserve legacy evidence, but the durable link or hold controls current status.
                            items.set(record.id, { ...legacy, status: finalization.status, reason: finalization.reason,
                                reviewRequired: finalization.reviewRequired,
                                ...(finalization.followupReview ? { followupReview: finalization.followupReview, updatedAt: finalization.updatedAt } : {}),
                                ...(finalization.optionalTaskId ? { optionalTaskId: finalization.optionalTaskId } : {}),
                            });
                        }
                    }
                } catch { available = false; }
                finally { if (fd !== undefined) fs.closeSync(fd); }
            }
        } catch (error) { if (error.code !== 'ENOENT') available = false; }
        finally { directory?.closeSync(); }
    }
    return { available: available && foundDirectory, items: [...items.values()].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)) };
}
/** One bounded scan shared by calendar rows; task-scoped reads retain their filter. */
function readCalendarImprovements(boardRows, options) {
    const records = readTaskImprovements(undefined, options);
    const board = new Map(boardRows.filter(row => !row.archived_at).map(row => [row.id, row]));
    return { available: records.available, items: records.items.flatMap(record => {
        const parent = board.get(record.taskId);
        if (!parent) return [];
        if (record.optionalTaskId) {
            const retained = record.followupReview?.decisions.filter(decision => decision.disposition === 'retain') || [];
            if (!retained.length) return [];
            // The linked task owns execution; this row represents only findings left pending.
            record = { ...record, status: 'retained', reason: retained.map(decision => decision.reason).filter(Boolean).join('\n') || 'Findings retained pending evidence or dependency.' };
        }
        const lane = { running: 'running', reviewing: 'qa', verified: 'finished', declined: 'finished', completed_after_review: 'finished' }[record.status] || 'waiting';
        return [{ taskId: record.taskId, title: `QA improvements — ${parent.name || record.taskId}`,
            boardStatus: parent.status, projectId: parent.project_id || null, projectName: parent.project_name || null,
            lane, executor: record.author, updatedAt: record.updatedAt,
            startedAt: ['running', 'qa'].includes(lane) ? record.startedAt || null : null,
            finishedAt: lane === 'finished' ? record.updatedAt : null,
            improvement: { id: record.id, status: record.status, reason: record.reason, updatedAt: record.updatedAt, ...(record.followupReview?.priority ? { priority: record.followupReview.priority } : {}) },
        }];
    }) };
}
module.exports = { readTaskImprovements, readCalendarImprovements };
