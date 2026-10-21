/** Material board evidence wakes Praxis's idle timer; never dispatches work. */
const { isDeepStrictEqual } = require('node:util');
const { praxisFetch } = require('./praxis-client');
const MATERIAL_FIELDS = ['name', 'description', 'status', 'priority', 'project_id', 'dependencies', 'successor_id',
    'walkthrough', 'research_output', 'plan_output', 'antigravity_payload', 'metadata', 'archived_at',
    'suspended_at', 'suspended_reason', 'verification', 'completion_evidence'];
function materialTaskChanged(before, after) {
    return Boolean(after && (!before || MATERIAL_FIELDS.some(key => !isDeepStrictEqual(before[key], after[key]))));
}
async function notifyTaskEvidenceChange(before, after, { send = praxisFetch,
    key = process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY, warn = console.warn } = {}) {
    if (!materialTaskChanged(before, after)) return false;
    // Database fixture writes must never contact the live orchestration daemon.
    if (process.env.NODE_ENV === 'test' && send === praxisFetch) return false;
    if (!key) { warn('[FollowupActivity] Runtime credential unavailable; idle review will reconcile at Praxis restart.'); return false; }
    try {
        const response = await send('/ops/followup-activity', { method: 'POST', timeoutMs: 3000,
            headers: { authorization: `Bearer ${key}` }, body: { taskId: after.id, version: after.version } });
        if (!response.ok) throw Error('Notification refused');
        return true;
    } catch {
        // The board write is durable. A restarted Praxis observes a fresh idle
        // interval and scans that evidence, so an offline notification is safe.
        warn('[FollowupActivity] Notification unavailable; retained board evidence will reconcile at Praxis restart.');
        return false;
    }
}
module.exports = { materialTaskChanged, notifyTaskEvidenceChange };
