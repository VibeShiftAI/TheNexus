/**
 * Real-activity detection for tasks.last_activity_at (Board Groundskeeper,
 * Nexus task 02f3c8a7).
 *
 * `updated_at` is useless for staleness: automated sweeps PATCH every row
 * daily, so all open tasks always look ≤4 days old. `last_activity_at` only
 * moves when a PATCH actually CHANGES a field a human or agent cares about —
 * a same-value rewrite (the sweep pattern) is not activity. Callers may also
 * declare themselves mechanical with the `x-nexus-sweep: 1` header, which
 * suppresses the bump even for real changes.
 *
 * Creation and dispatch count as activity (create paths set the field
 * directly; a dispatch flips `status`, which lands here as a real change).
 */

const ACTIVITY_FIELDS = [
    'name',
    'status',
    'description',
    'priority',
    'dependencies',
    'antigravity_payload',
    'model_assignment',
];

function norm(value) {
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * True when `updates` genuinely changes at least one activity field relative
 * to the existing row. Pure — exported for the fixture tests.
 */
function hasRealActivity(existing, updates, headers = {}) {
    if (String(headers['x-nexus-sweep'] || '') === '1') return false;
    return ACTIVITY_FIELDS.some(
        (field) => field in updates && norm(updates[field]) !== norm(existing?.[field])
    );
}

module.exports = { ACTIVITY_FIELDS, hasRealActivity };
