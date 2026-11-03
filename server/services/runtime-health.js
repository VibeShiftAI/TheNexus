/** Read-only cockpit projection of Praxis judgments. No dashboard thresholds. */
const fs = require('node:fs');
const path = require('node:path');

function readRuntimeReport(now = new Date()) {
    // Praxis morning/health-investigations.ts owns the reporting day and file.
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const file = path.join(process.env.PRAXIS_DATA_DIR || '/Volumes/Projects/Praxis/data', 'morning-health', `${date}.json`);
    try {
        if (fs.statSync(file).size > 1024 * 1024) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const report = data.report;
        if (data.date !== date || !Number.isFinite(Date.parse(report?.capturedAt))
            || Date.parse(report.capturedAt) > now.getTime()
            || !Array.isArray(report.checks) || !report.checks.some(c => c?.name === 'day activity')
            || !report.checks.every(c => c && typeof c.name === 'string' && typeof c.detail === 'string'
                && ['green', 'yellow', 'red'].includes(c.status))) return null;
        return report;
    } catch { return null; }
}

function projectRuntimeHealth(state, usageWaits, report) {
    const causes = [];
    const unavailable = [];
    const add = (id, detail, taskId) => causes.push({ id, detail, href: taskId ? `/task/${encodeURIComponent(taskId)}` : '/ops' });
    const executors = state?.executors;
    const posture = executors?.posture;
    if (!['nominal', 'degraded', 'critical'].includes(posture?.mode)) unavailable.push('Fleet posture');
    else if (posture.mode !== 'nominal') {
        add('fleet', posture.summary || `Fleet ${posture.mode}`);
        for (const [index, item] of (Array.isArray(posture.suspended) ? posture.suspended : []).entries()) {
            if (item && typeof item.executor === 'string') add(`executor-${index}`, `${item.executor}: ${item.reason || 'Executor suspended'}`);
        }
    }
    const stalls = executors?.attemptStalls;
    if (!Array.isArray(stalls?.violations) || !Number.isFinite(stalls.pending)) unavailable.push('Attempt watchdog');
    else {
        for (const [index, item] of stalls.violations.entries()) {
            if (!item || typeof item.detail !== 'string') { unavailable.push('Attempt watchdog'); continue; }
            add(`stall-${index}`, `${item.causeTitle || 'Silent dispatch failure'}: ${item.detail}`, item.taskId);
        }
        if (stalls.pending > 0) add('recovery', `${stalls.pending} dispatch recovery attempt(s) awaiting a reply`);
    }
    if (!usageWaits?.available || !Array.isArray(usageWaits.items)) unavailable.push('Usage waits');
    else for (const [index, item] of usageWaits.items.entries()) {
        // The ledger owns the wait lifecycle. Passing resumeAt does not prove recovery.
        if (item.kind === 'usage_limit') add(`usage-${index}`, `${item.executor || 'Executor'} usage limit — waiting to resume`, item.taskId);
    }
    if (!report) unavailable.push('Daily runtime checks');
    else for (const [index, check] of report.checks.entries()) {
        if (check.status !== 'green') add(`check-${index}`, `${check.name}: ${check.detail}`);
    }
    return {
        status: causes.length ? 'degraded' : unavailable.length ? 'unknown' : 'healthy',
        causes, unavailable,
        reportCapturedAt: report?.capturedAt || null,
    };
}

module.exports = { readRuntimeReport, projectRuntimeHealth };
