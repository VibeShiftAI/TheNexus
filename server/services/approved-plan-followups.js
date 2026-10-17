/** Read-only membership for the daily follow-up list. Never grants execution. */
const { isTaskDone } = require('@praxis/contract');
const day = date => date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const excluded = new Set(['cancelled', 'canceled', 'archived', 'rejected']);
const normalize = value => String(value || '').toLowerCase().replace(/-/g, '_');
function dependencies(row) {
    try {
        const ids = JSON.parse(row.dependencies || '[]');
        return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
    } catch { return []; }
}

function buildApprovedPlanFollowupScope(slate, events, rows, now = new Date()) {
    const scope = new Map();
    const today = day(now);
    if (!slate?.available || slate.date !== today
        || !slate.stages?.some(stage => stage.stage === 'approved' && stage.reached === true)) return scope;
    const board = new Map(rows.map(row => [row.id, row]));
    const onCalendarToday = new Set();
    const scheduled = new Set();
    for (const event of events) {
        if (!event.task_id || excluded.has(normalize(event.status))) continue;
        const start = new Date(event.start_time);
        const end = new Date(event.end_time || event.start_time);
        const overlapsToday = Number.isFinite(start.getTime()) && day(start) <= today
            && Number.isFinite(end.getTime()) && day(end) >= today;
        if (overlapsToday) onCalendarToday.add(event.task_id);
        if (overlapsToday || ['scheduled', 'pending', 'in_progress'].includes(normalize(event.status))) scheduled.add(event.task_id);
    }
    const valid = row => row && !row.archived_at && !excluded.has(normalize(row.status));
    const roots = (slate.slots || []).filter(slot => !slot.withdrawn && onCalendarToday.has(slot.taskId) && valid(board.get(slot.taskId)));
    const children = new Map();
    const link = (parent, child) => {
        if (!children.has(parent)) children.set(parent, new Set());
        children.get(parent).add(child);
    };
    for (const row of rows) {
        if (!valid(row)) continue;
        for (const parent of dependencies(row)) link(parent, row.id);
        if (row.successor_id) link(row.id, row.successor_id);
    }
    // The calendar shows immediate follow-up work, not the entire project
    // dependency tree. A later milestone needs its own approved calendar root.
    for (const root of roots) {
        for (const id of children.get(root.taskId) || []) {
            if (id === root.taskId || !valid(board.get(id))) continue;
            if (isTaskDone(board.get(id).status) || scheduled.has(id)) continue;
            if (!scope.has(id)) scope.set(id, []);
            const follows = scope.get(id);
            if (!follows.some(ref => ref.taskId === root.taskId)) {
                follows.push({ taskId: root.taskId, title: board.get(root.taskId).name || root.title || root.taskId });
            }
        }
    }
    return scope;
}
module.exports = { buildApprovedPlanFollowupScope };
