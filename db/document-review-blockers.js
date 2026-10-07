/** Explicit review requirements, independent of the producing task. */
const ACTIVE_TASK_SQL = `t.archived_at IS NULL
    AND LOWER(t.status) NOT IN ('completed', 'complete', 'done', 'cancelled', 'canceled', 'archived', 'rejected', 'deleted')`;
const WAITING_TASKS_FROM_SQL = `json_each(d.blocking_task_ids) required
    JOIN tasks t ON t.id = required.value
    WHERE ${ACTIVE_TASK_SQL}`;

function parseBlockingTaskIds(value) {
    if (!Array.isArray(value) || value.length > 100
        || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 120 || /[\u0000-\u001f\u007f]/.test(id))) {
        return { ok: false, error: 'blocking_task_ids must be an array of at most 100 nonempty task IDs' };
    }
    return { ok: true, value: [...new Set(value.map(id => id.trim()))] };
}

module.exports = { ACTIVE_TASK_SQL, WAITING_TASKS_FROM_SQL, parseBlockingTaskIds };
