/**
 * Stakeholder governance routes (2026-08-22, Robert's directive).
 *
 *  GET  /api/projects/:id/stakeholders       — { decision_makers, members }
 *  GET  /api/projects/:id/requests?status=   — tasks carrying a stakeholder gate
 *  POST /api/tasks/:taskId/stakeholder-decision — approve / reject / duplicate / defer
 *
 * A "request" is an ordinary task that Praxis's feedback pipeline filed as
 * `blocked` with `metadata.stakeholder_gate` because the project has Primary
 * Decision Makers (PDMs). The decision endpoint is the ONE place the gate is
 * flipped — the dashboard, Praxis (hosted-report responses, email replies),
 * and the mobile app all call it, so the status transition, history, and
 * member interaction-log note happen identically for every caller.
 *
 * Shapes: @praxis/contract entities/stakeholders.ts (StakeholderGate,
 * StakeholderDecision, STAKEHOLDER_DECISION_STATUS).
 */
const express = require('express');

const DECISIONS = ['approve', 'reject', 'duplicate', 'defer'];
// Mirrors STAKEHOLDER_DECISION_STATUS in the contract (kept inline — this
// server is plain CJS and must not depend on the ESM contract build).
const DECISION_STATUS = { approve: 'idea', reject: 'cancelled', duplicate: 'cancelled', defer: 'blocked' };
const DECISION_GATE = { approve: 'approved', reject: 'rejected', duplicate: 'duplicate', defer: 'deferred' };
const GATE_MESSAGE = {
    approved: 'Approved by a Primary Decision Maker — ready for scheduling',
    rejected: 'Declined by a Primary Decision Maker',
    duplicate: 'Closed as a duplicate by a Primary Decision Maker',
    deferred: 'Changes requested by a Primary Decision Maker — awaiting revision',
    pending: 'Awaiting Primary Decision Maker approval',
};
const HISTORY_MAX = 40;

function cleanParty(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const out = {};
    for (const key of ['member_id', 'name', 'email']) {
        if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = raw[key].trim().slice(0, 200);
    }
    if (['operator', 'report', 'email', 'api'].includes(raw.via)) out.via = raw.via;
    return Object.keys(out).length ? out : undefined;
}

/**
 * Two routers because the surface spans two mounts: `projects` goes under
 * /api/projects, `tasks` under /api/tasks (mounting one router on both would
 * expose nonsense paths like /api/tasks/:id/requests).
 */
function createStakeholderRouters({ db }) {
    const router = express.Router();
    const tasksRouter = express.Router();

    // GET /api/projects/:id/stakeholders
    router.get('/:id/stakeholders', async (req, res) => {
        try {
            const members = await db.listProjectContacts(req.params.id);
            const decision_makers = members.filter((m) => m.decision_maker === true && (m.status ?? 'active') !== 'dormant');
            res.json({ decision_makers, members });
        } catch (error) {
            console.error('Error listing stakeholders:', error);
            res.status(500).json({ error: 'Failed to list stakeholders' });
        }
    });

    // GET /api/projects/:id/requests?status=pending|all|approved|…
    router.get('/:id/requests', async (req, res) => {
        const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : 'pending';
        try {
            const tasks = await db.listStakeholderRequests(req.params.id, { status });
            const requests = tasks.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description ?? null,
                status: t.status,
                priority: t.priority ?? null,
                source: t.source ?? null,
                created_at: t.created_at,
                updated_at: t.updated_at ?? null,
                gate: t.metadata.stakeholder_gate,
            }));
            res.json({ requests });
        } catch (error) {
            console.error('Error listing stakeholder requests:', error);
            res.status(500).json({ error: 'Failed to list requests' });
        }
    });

    // POST /api/tasks/:taskId/stakeholder-decision
    tasksRouter.post('/:taskId/stakeholder-decision', async (req, res) => {
        const { decision, note, duplicate_of, decided_by } = req.body || {};
        if (!DECISIONS.includes(decision)) {
            return res.status(400).json({ error: `decision must be one of: ${DECISIONS.join(', ')}` });
        }
        if (decision === 'duplicate' && !duplicate_of) {
            return res.status(400).json({ error: 'duplicate_of is required for a duplicate decision' });
        }
        try {
            const task = await db.getTask(req.params.taskId);
            if (!task) return res.status(404).json({ error: 'Task not found' });
            const gate = task.metadata && typeof task.metadata === 'object' ? task.metadata.stakeholder_gate : null;
            if (!gate || typeof gate !== 'object') {
                return res.status(409).json({ error: 'Task has no stakeholder gate' });
            }
            if (duplicate_of) {
                if (duplicate_of === task.id) return res.status(400).json({ error: 'A request cannot duplicate itself' });
                if (!(await db.getTask(duplicate_of))) return res.status(400).json({ error: `duplicate_of task not found: ${duplicate_of}` });
            }
            const nowIso = new Date().toISOString();
            const by = cleanParty(decided_by);
            const nextStatus = DECISION_GATE[decision];
            const history = Array.isArray(gate.history) ? [...gate.history] : [];
            history.push({ at: nowIso, status: nextStatus, ...(by ? { by } : {}), ...(note ? { note: String(note).slice(0, 4000) } : {}) });
            const nextGate = {
                ...gate,
                status: nextStatus,
                decided_at: nowIso,
                ...(by ? { decided_by: by } : {}),
                ...(note ? { note: String(note).slice(0, 4000) } : {}),
                ...(decision === 'duplicate' ? { duplicate_of } : {}),
                history: history.slice(-HISTORY_MAX),
            };
            if (decision !== 'duplicate') delete nextGate.duplicate_of;
            const updates = {
                status: DECISION_STATUS[decision],
                metadata: { ...task.metadata, stakeholder_gate: nextGate, status_message: GATE_MESSAGE[nextStatus] },
                updated_at: nowIso,
                last_activity_at: nowIso,
            };
            const updated = await db.updateTask(task.id, updates);
            if (!updated) return res.status(500).json({ error: 'Failed to apply decision' });

            // Leave a trace on the deciding member's interaction log (best-effort).
            if (by?.member_id && typeof db.appendContactLog === 'function') {
                const verb = { approved: 'approved', rejected: 'declined', duplicate: 'marked as duplicate', deferred: 'asked for changes on' }[nextStatus];
                db.appendContactLog(by.member_id, {
                    note: `${verb} request "${String(task.name).slice(0, 120)}"${note ? ` — ${String(note).slice(0, 200)}` : ''}`,
                    source: 'stakeholder-decision',
                    touchContact: by.via === 'report' || by.via === 'email',
                }).catch(() => undefined);
            }
            res.json({ success: true, task: updated, gate: nextGate });
        } catch (error) {
            console.error('Error applying stakeholder decision:', error);
            res.status(500).json({ error: 'Failed to apply decision' });
        }
    });

    return { projects: router, tasks: tasksRouter };
}

module.exports = createStakeholderRouters;
