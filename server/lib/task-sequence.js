/**
 * Task sequencing — predecessor gating and successor auto-start.
 *
 * Semantics (see @praxis/contract TaskSequenceSchema, the canonical
 * definition shared by the API, the dashboard, mobile, and the Praxis/CLI
 * tool surfaces):
 *
 * - `dependencies` are PREDECESSORS: every listed task must be `completed`
 *   before this task may start. Many allowed. Enforced here on status
 *   transitions into TASK_START_STATUSES, and again at dispatch time inside
 *   Praxis's handleNexusDispatchTask (all dispatch paths funnel through it).
 * - `successor_id` is THE successor: the single task to start immediately
 *   after this one completes. Triggered here on the completed transition —
 *   the one choke point every completion path (UI, MCP, Praxis QA loop)
 *   already goes through, because they all PATCH the task API.
 */
const { isTaskDone, isTaskStarted, TASK_AUTO_START_STATUSES, normalizeTaskBoardStatus } = require('@praxis/contract');
const { PRAXIS_URL } = require('../shared/constants');

/**
 * Predecessors of `task` that are not yet completed. Ids that no longer
 * resolve to a task are ignored (a deleted predecessor must not block its
 * dependents forever) but reported in `missing` for logging.
 */
async function getIncompletePredecessors(db, task) {
    const deps = Array.isArray(task?.dependencies) ? task.dependencies : [];
    const incomplete = [];
    const missing = [];
    for (const depId of deps) {
        const dep = await db.getTask(depId);
        if (!dep) { missing.push(depId); continue; }
        if (!isTaskDone(dep.status)) incomplete.push({ id: dep.id, name: dep.name, status: dep.status });
    }
    return { incomplete, missing };
}

/**
 * Gate a status update: returns an error string when `updates.status` moves
 * a not-yet-started task into a started state while predecessors are
 * incomplete; null when the transition is allowed. `force` (body flag,
 * propagated by Praxis's forced dispatches) bypasses — the same escape
 * hatch contract as every other dispatch guard.
 */
async function checkPredecessorGate(db, existingTask, newStatus, { force = false } = {}) {
    if (force) return null;
    if (!isTaskStarted(newStatus)) return null;
    if (isTaskStarted(existingTask.status)) return null; // already running — progression, not a start
    const { incomplete, missing } = await getIncompletePredecessors(db, existingTask);
    if (missing.length > 0) {
        console.warn(`[TaskSequence] Task ${existingTask.id} lists missing predecessor(s) ${missing.join(', ')} — ignored`);
    }
    if (incomplete.length === 0) return null;
    const list = incomplete.map(p => `"${p.name}" (${p.id}, ${p.status})`).join(', ');
    return `Task cannot start — ${incomplete.length} predecessor(s) not completed: ${list}. Complete or remove them first, or pass force=true.`;
}

/**
 * Successor candidates unlocked by `completedTask` completing:
 *  1. its own `successor_id`, and
 *  2. any project sibling that (a) lists it as a predecessor, (b) is some
 *     completed task's designated successor, and (c) is now fully unblocked
 *     — i.e. `completedTask` was the last thing holding a successor open.
 * (2) keeps "starts immediately after completion" true when a successor
 * also carries other predecessors. Project-scoped by design.
 */
async function findSuccessorCandidates(db, completedTask) {
    const candidates = new Map();
    if (completedTask.successor_id) {
        const direct = await db.getTask(completedTask.successor_id);
        if (direct) candidates.set(direct.id, direct);
        else console.warn(`[TaskSequence] Task ${completedTask.id} names missing successor ${completedTask.successor_id}`);
    }
    if (completedTask.project_id) {
        const siblings = await db.getTasks(completedTask.project_id);
        const successorIds = new Set(
            siblings.filter(t => isTaskDone(t.status) && t.successor_id).map(t => t.successor_id)
        );
        for (const t of siblings) {
            if (candidates.has(t.id) || t.id === completedTask.id) continue;
            const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
            if (deps.includes(completedTask.id) && successorIds.has(t.id)) candidates.set(t.id, t);
        }
    }
    return [...candidates.values()];
}

/**
 * Fire the successor chain for a task that just transitioned to completed.
 * Dispatches each eligible candidate through Praxis's manual-dispatch
 * endpoint so every existing guard (duplicate runs, executor health,
 * day-schedule routing, workspace validation) applies. Best-effort: a
 * refused or failed dispatch is logged, never thrown — completion of the
 * current task must not be rolled back by its successor.
 *
 * Returns a summary array for callers/tests: {taskId, action, detail}.
 */
async function triggerSuccessors(db, completedTask, { fetchImpl = fetch, praxisUrl = PRAXIS_URL } = {}) {
    const results = [];
    let candidates;
    try {
        candidates = await findSuccessorCandidates(db, completedTask);
    } catch (err) {
        console.error(`[TaskSequence] Successor lookup failed for ${completedTask.id}:`, err.message);
        return results;
    }
    for (const candidate of candidates) {
        const status = normalizeTaskBoardStatus(candidate.status);
        if (!TASK_AUTO_START_STATUSES.includes(status)) {
            results.push({ taskId: candidate.id, action: 'skipped', detail: `status "${candidate.status}" is not auto-startable` });
            continue;
        }
        const { incomplete } = await getIncompletePredecessors(db, candidate);
        if (incomplete.length > 0) {
            results.push({ taskId: candidate.id, action: 'held', detail: `waiting on ${incomplete.length} predecessor(s): ${incomplete.map(p => p.id).join(', ')}` });
            console.log(`[TaskSequence] Successor ${candidate.id} held — predecessors incomplete`);
            continue;
        }
        try {
            const res = await fetchImpl(`${praxisUrl}/api/dispatch/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: candidate.id }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok) {
                results.push({ taskId: candidate.id, action: 'dispatched', detail: body.reply || 'ok' });
                console.log(`[TaskSequence] Successor ${candidate.id} ("${candidate.name}") dispatched after ${completedTask.id} completed`);
            } else {
                results.push({ taskId: candidate.id, action: 'refused', detail: body.reply || body.error || `HTTP ${res.status}` });
                console.warn(`[TaskSequence] Successor ${candidate.id} dispatch refused: ${(body.reply || body.error || res.status)}`);
            }
        } catch (err) {
            results.push({ taskId: candidate.id, action: 'failed', detail: err.message });
            console.warn(`[TaskSequence] Successor ${candidate.id} dispatch failed (Praxis unreachable?): ${err.message}`);
        }
    }
    return results;
}

module.exports = { getIncompletePredecessors, checkPredecessorGate, findSuccessorCandidates, triggerSuccessors };
