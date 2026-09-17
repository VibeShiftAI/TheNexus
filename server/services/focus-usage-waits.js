const fs = require('fs');
const path = require('path');

function projectUsageWaits(entries) {
    if (!Array.isArray(entries)) throw new Error('Invalid usage wait ledger');
    return entries.map(entry => {
        if (!entry || typeof entry.taskId !== 'string' || !entry.taskId
            || typeof entry.resumeAtIso !== 'string' || !Number.isFinite(Date.parse(entry.resumeAtIso))) {
            throw new Error('Invalid usage wait record');
        }
        const text = value => typeof value === 'string' ? value.slice(0, 200) : null;
        return {
            taskId: entry.taskId,
            executor: text(entry.executor || entry.session?.executor),
            model: text(entry.session?.model),
            kind: ['usage_limit', 'harness_retry', 'session_recovery'].includes(entry.kind) ? entry.kind : 'usage_limit',
            resumeAt: entry.resumeAtIso,
            limitedAt: typeof entry.limitedAtIso === 'string' && Number.isFinite(Date.parse(entry.limitedAtIso)) ? entry.limitedAtIso : null,
            requiresAction: entry.requiresAction === true,
        };
    });
}

// A read-only projection of Praxis's existing ledger, like the cockpit's
// detached-run/spine readers. Never expose saved sessions or execution input.
function readUsageWaits(file = process.env.PRAXIS_USAGE_RESUME_FILE
    || path.join(process.env.PRAXIS_DATA_DIR || '/Volumes/Projects/Praxis/data', 'usage-limit-resumes.json')) {
    try {
        if (fs.statSync(file).size > 1024 * 1024) throw new Error('Oversized wait ledger');
        return { items: projectUsageWaits(JSON.parse(fs.readFileSync(file, 'utf8'))), available: true };
    } catch {
        return { items: [], available: false };
    }
}

function validDispatchSnapshot(data) {
    const rows = (value, check) => Array.isArray(value) && value.every(row => row && typeof row === 'object' && check(row));
    const string = value => typeof value === 'string';
    return data && typeof data === 'object' && !Array.isArray(data)
        && rows(data.executors?.runs, row => string(row.taskId) && string(row.executor) && string(row.status) && string(row.phase) && string(row.startedAt) && string(row.updatedAt))
        && rows(data.executors?.cliQueue, row => string(row.taskId))
        && rows(data.executors?.sessions, row => string(row.taskId) && string(row.executor) && string(row.status))
        && rows(data.cron, row => string(row.key) && string(row.label) && typeof row.running === 'boolean')
        && rows(data.localLlm?.jobs, row => string(row.status));
}

module.exports = { projectUsageWaits, readUsageWaits, validDispatchSnapshot };
