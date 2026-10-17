/**
 * Follow-up scheduling: put a prepared follow-up on the calendar AFTER the
 * last planned task of the day, from the cockpit.
 *
 * The follow-up list on Today's Schedule (see approved-plan-followups.js)
 * shows successors of today's approved work that have no calendar event. The
 * operator can authorize an automatic start (Praxis relay), or, with this
 * module, give the task a real slot: a `praxis_task` calendar event that the
 * Praxis calendar poller fires at its start time through the ordinary
 * dispatch and QA gates. Nothing here dispatches; it writes a calendar row.
 *
 * The event mirrors what Praxis's own `nexus_calendar` tool writes
 * (title, the "Praxis follow-up" marker in the description, the derived id),
 * so Praxis recognises and can cancel it like any other follow-up, and the
 * calendar dispatcher derives the workspace from the same `Workspace:` line.
 *
 * Pure helpers only: the route owns the reads and the write.
 */
const { createHash } = require('node:crypto');
const { isTaskDone } = require('@praxis/contract');

const TIME_ZONE = 'America/New_York';
const FOLLOW_UP_MARKER = '\nPraxis follow-up\n';
const SLOT_TITLE = /^\[Slot \d+\]/i;
/** Never start before the dispatcher's next poll could see the event. */
const LEAD_MS = 2 * 60_000;
/** Planned duration when the last task has no end_time of its own. */
const ASSUMED_LAST_TASK_MS = 60 * 60_000;
const FOLLOW_UP_MINUTES = 30;

const CLOSED_TASK = new Set(['cancelled', 'canceled', 'archived', 'rejected']);
const CLOSED_EVENT = new Set(['skipped', 'cancelled', 'canceled']);
const PENDING_EVENT = new Set(['scheduled', 'pending', 'dispatched', 'in_progress']);

const normalize = value => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const day = (date, timeZone = TIME_ZONE) => date.toLocaleDateString('en-CA', { timeZone });
const toTime = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** True when the board task can no longer take new work. */
function taskClosed(task) {
    if (!task) return true;
    if (task.archived_at) return true;
    const status = normalize(task.status);
    return isTaskDone(status) || CLOSED_TASK.has(status);
}

/**
 * Today's work plan as the calendar shows it: `praxis_task` events with a
 * task that start today (local), plus `[Slot N]` events that spilled past
 * midnight, which are still this plan. Unrelated work tomorrow and system
 * windows (local LLM, stakeholder meetings) do not extend the plan.
 */
function planEvents(events, now, timeZone = TIME_ZONE) {
    const today = day(now, timeZone);
    const tomorrow = day(new Date(now.getTime() + 24 * 60 * 60_000), timeZone);
    return (events || []).filter(event => {
        if (!event || !event.task_id || event.event_type !== 'praxis_task') return false;
        if (CLOSED_EVENT.has(normalize(event.status))) return false;
        const start = toTime(event.start_time);
        if (start === null) return false;
        const onDay = day(new Date(start), timeZone);
        return onDay === today || (onDay === tomorrow && SLOT_TITLE.test(String(event.title || '')));
    });
}

/** When an event is over: its end_time, or an assumed hour after it starts. */
function eventEnd(event) {
    const start = toTime(event.start_time);
    const end = toTime(event.end_time);
    if (end !== null && start !== null && end > start) return end;
    return start === null ? null : start + ASSUMED_LAST_TASK_MS;
}

/**
 * The slot a follow-up gets: right after the plan's last task ends, never in
 * the past. Returns the anchor event too, so the UI can say what it follows.
 */
function planFollowUpSlot(events, now = new Date(), { timeZone = TIME_ZONE, minutes = FOLLOW_UP_MINUTES } = {}) {
    let anchor = null;
    let anchorEnd = null;
    for (const event of planEvents(events, now, timeZone)) {
        const end = eventEnd(event);
        if (end === null) continue;
        if (anchorEnd === null || end > anchorEnd) { anchor = event; anchorEnd = end; }
    }
    const earliest = now.getTime() + LEAD_MS;
    const start = anchorEnd === null ? earliest : Math.max(anchorEnd, earliest);
    return {
        start: new Date(start).toISOString(),
        end: new Date(start + minutes * 60_000).toISOString(),
        anchor: anchor ? { id: anchor.id, title: anchor.title, task_id: anchor.task_id, end: new Date(anchorEnd).toISOString() } : null,
    };
}

/** Any calendar event that already promises this task a run. */
function pendingEventFor(events, taskId) {
    return (events || []).find(event => event && event.task_id === taskId && PENDING_EVENT.has(normalize(event.status))) || null;
}

/** The calendar row for the follow-up, shaped like Praxis's own follow-ups. */
function followUpEvent({ task, workspace, slot }) {
    const id = `followup-${createHash('sha256').update(`${task.id}\n${slot.start}`).digest('hex').slice(0, 32)}`;
    const instructions = slot.anchor
        ? `Scheduled from the Nexus calendar after today's last planned task (${slot.anchor.title}).`
        : 'Scheduled from the Nexus calendar; no other task was planned for today.';
    return {
        id,
        title: `Follow-up: ${task.name || task.title || task.id}`,
        description: `Workspace: ${workspace}${FOLLOW_UP_MARKER}Nexus Task: ${task.id}\nInstructions: ${instructions}`,
        task_id: task.id,
        project_id: task.project_id || null,
        start_time: slot.start,
        end_time: slot.end,
        event_type: 'praxis_task',
        status: 'scheduled',
    };
}

module.exports = {
    FOLLOW_UP_MARKER,
    FOLLOW_UP_MINUTES,
    LEAD_MS,
    taskClosed,
    planEvents,
    planFollowUpSlot,
    pendingEventFor,
    followUpEvent,
};
