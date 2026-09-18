/**
 * Slate lifecycle: the four stages a day's slate passes through, projected
 * from the authoritative schedule Praxis already writes.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On 2026-08-24 a slate was built, reached the [MORNING PLAN] approval card,
 * and then sat there. Nothing dispatched, and nothing on the cockpit said so:
 * the board showed the same todo tasks it always shows, and the only place the
 * truth lived was `approval.status === "pending"` inside Praxis's schedule
 * file. The knowledge council's own words for it (note_knowledge_council
 * 2026-08-25, section 1): "the slate was never approved, not 'dispatch
 * broke'… Approval-gated silence is by design — silence that nobody notices
 * is not."
 *
 * So this module answers one question the cockpit could not answer: WHICH
 * STAGE is the slate sitting in, and for how long.
 *
 *   drafted   → the slate was written (schedule.createdAt)
 *   approved  → Robert resolved the HITL approval gate
 *   attempted → at least one slot actually left `pending`
 *   verified  → at least one slot reached `completed` (QA-passed terminal)
 *
 * ── What it reads, and why from a file ──────────────────────────────────────
 * Praxis owns scheduling; the cockpit only renders it. Praxis has no HTTP
 * endpoint that returns the schedule as data. `get_day_schedule` on the
 * agent-tool bridge answers with a rendered markdown TABLE, which is why
 * dispatch-insight's autonomy probe can only use it as a liveness sentinel
 * (routes/dispatch-insight.js, probeDaySchedule). Parsing a human table to
 * drive a status surface would be the wrong contract.
 *
 * Instead this reads `PRAXIS_DATA_DIR/schedule.json` directly, read-only, the
 * same way the cockpit already reads Praxis's usage-limit ledger
 * (services/focus-usage-waits.js) and its local-evidence directory
 * (services/local-evidence-work.js). Nothing here writes, and nothing here
 * dispatches: the schedule stays Praxis's to mutate.
 *
 * ── Honesty rules ───────────────────────────────────────────────────────────
 *   1. A stage is REACHED only on positive evidence. Absent evidence is
 *      `reached: false` with a reason, never an optimistic default. A slate
 *      with no `approval` record at all reads `unknown`, not `approved`;
 *      those are different facts and the whole incident above is what
 *      collapsing them costs.
 *   2. `operator-accepted` is NOT verified. Praxis stamps it when Robert
 *      overrides a QA rejection from the escalation card; its own contract
 *      (scheduler/plan-model.ts) says "The work did NOT pass QA, and every
 *      report must render it as operator-accepted, never as done/QA-passed".
 *      It counts as attempted and is reported separately.
 *   3. A slate from a previous day is reported with `stale: true` rather than
 *      shown as today's. Praxis keeps the last schedule on disk and may
 *      rehydrate one that spilled past midnight (CARRYOVER_GRACE_MS, 12h), so
 *      "yesterday's file" and "today's slate" are not the same claim.
 *   4. Unreadable file → `available: false`. The cockpit says it cannot see
 *      the slate; it never says there isn't one.
 */
const fs = require('fs');
const path = require('path');

/**
 * Slot statuses that prove the slot left `pending` through the dispatch plane
 * (or was consumed as already-done out of band, which still resolves it).
 * `skipped` and `deferred` are deliberately absent: a slot Robert removed or
 * Praxis pushed was never attempted, and counting it as an attempt is how a
 * slate with twelve skipped slots would read as a working day.
 */
const ATTEMPTED_STATUSES = new Set(['dispatched', 'completed', 'suspended', 'operator-accepted', 'cancelled']);

/** The only status that means the work passed cross-executor QA. */
const VERIFIED_STATUS = 'completed';

/** Slots that were taken out of the plan, excluded from every denominator. */
const WITHDRAWN_STATUSES = new Set(['skipped', 'deferred']);

/** Praxis rehydrates a spilled-over slate for this long (plan-model.ts). */
const CARRYOVER_GRACE_MS = 12 * 60 * 60_000;

/** Above this, a stage that has not advanced is called out rather than shown neutral. */
const STALL_WARN_MS = 45 * 60_000;

function isoOrNull(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The calendar date `schedule.date` is written in. Praxis stamps it with its
 * own `etDateString` (scheduler/plan-model.ts), which pins America/New_York,
 * so the cockpit compares against the same zone rather than whatever the host
 * happens to be set to. Reading the field in a different zone would mark a
 * live slate stale for part of every day.
 */
function scheduleDateString(d) {
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Earliest non-null ISO string, or null when none of them parsed. */
function earliest(values) {
    const times = values.filter(Boolean).map((v) => ({ v, t: Date.parse(v) })).filter((x) => Number.isFinite(x.t));
    if (times.length === 0) return null;
    return times.sort((a, b) => a.t - b.t)[0].v;
}

function latest(values) {
    const times = values.filter(Boolean).map((v) => ({ v, t: Date.parse(v) })).filter((x) => Number.isFinite(x.t));
    if (times.length === 0) return null;
    return times.sort((a, b) => b.t - a.t)[0].v;
}

/**
 * Project one raw slot down to the fields this surface renders. Everything
 * else in a slot (instructions, objective, taskDescription, the
 * reconciliation evidence) is execution input and stays out of a read-only
 * status strip.
 */
function projectSlot(slot) {
    const status = typeof slot.status === 'string' ? slot.status : 'pending';
    const provenance = slot.provenance && typeof slot.provenance === 'object' ? slot.provenance : null;
    const withdrawn = WITHDRAWN_STATUSES.has(status);
    return {
        slotNumber: Number.isInteger(slot.slotNumber) ? slot.slotNumber : null,
        taskId: typeof slot.nexusTaskId === 'string' ? slot.nexusTaskId : null,
        title: typeof slot.title === 'string' ? slot.title : '(untitled slot)',
        status,
        executor: typeof slot.executor === 'string' ? slot.executor : null,
        startTime: isoOrNull(slot.startTime),
        withdrawn,
        // Skip reason matters on the strip: a reconciliation skip is Praxis
        // saying "already done", a human skip is Robert's decision, and the
        // status report must not report the first as the second.
        skipSource: slot.skip && typeof slot.skip === 'object'
            ? (slot.skip.source === 'reconciliation' ? 'reconciliation' : 'human')
            : null,
        // A withdrawn slot is never an attempt, even when the scheduler
        // stamped it on the way out (an `out-of-band` consume of work the
        // board already had). It was removed from the plan, not run.
        attempted: !withdrawn && (ATTEMPTED_STATUSES.has(status) || Boolean(provenance)),
        verified: status === VERIFIED_STATUS,
        operatorAccepted: status === 'operator-accepted',
        provenanceAt: provenance ? isoOrNull(provenance.at) : null,
        provenanceVia: provenance && typeof provenance.via === 'string' ? provenance.via : null,
        // The 2026-08-07/08 class: the run-events spine rejected the write, so
        // this slot carries the only surviving evidence it ever ran.
        spineUnrecorded: provenance ? provenance.spineRecorded === false : false,
    };
}

function draftedStage(schedule, slots) {
    const at = isoOrNull(schedule.createdAt);
    if (!at) {
        return { stage: 'drafted', reached: false, at: null, detail: 'Slate file carries no createdAt', counts: { slots: slots.length } };
    }
    return {
        stage: 'drafted',
        reached: true,
        at,
        detail: `${slots.length} slot${slots.length === 1 ? '' : 's'} planned`,
        counts: { slots: slots.length },
    };
}

function approvedStage(schedule, slots) {
    const approval = schedule.approval && typeof schedule.approval === 'object' ? schedule.approval : null;
    const standing = slots.filter((s) => s.approvalSource === 'standing_consent').length;
    const counts = { standingConsent: standing };

    if (!approval) {
        // Absent is genuinely unknown: a plan built before the gate existed, or
        // one activated without it. Not "approved".
        return { stage: 'approved', reached: false, unknown: true, at: null, detail: 'No approval record on this slate', counts };
    }
    if (approval.status === 'approved') {
        return {
            stage: 'approved',
            reached: true,
            at: isoOrNull(approval.resolvedAt) || isoOrNull(approval.requestedAt),
            detail: standing > 0 ? `Approved (${standing} pre-approved by project policy)` : 'Approved by Robert',
            counts,
        };
    }
    if (approval.status === 'rejected') {
        return {
            stage: 'approved',
            reached: false,
            blocked: true,
            at: isoOrNull(approval.resolvedAt),
            detail: 'Rejected: this slate will not run',
            counts,
        };
    }
    // The 2026-08-24 state: built, carded, and waiting on a human.
    return {
        stage: 'approved',
        reached: false,
        waitingSince: isoOrNull(approval.requestedAt),
        at: null,
        detail: 'Waiting on Robert at the [MORNING PLAN] card',
        counts,
    };
}

function attemptedStage(slots) {
    const live = slots.filter((s) => !s.withdrawn);
    const attempted = live.filter((s) => s.attempted);
    const counts = {
        attempted: attempted.length,
        live: live.length,
        withdrawn: slots.length - live.length,
        spineUnrecorded: attempted.filter((s) => s.spineUnrecorded).length,
    };
    if (attempted.length === 0) {
        return {
            stage: 'attempted',
            reached: false,
            at: null,
            detail: slots.length === 0
                ? 'This slate has no slots'
                : live.length === 0
                    ? 'Every slot was withdrawn before dispatch'
                    : `0 of ${live.length} slots dispatched`,
            counts,
        };
    }
    return {
        stage: 'attempted',
        reached: true,
        at: earliest(attempted.map((s) => s.provenanceAt || s.startTime)),
        detail: `${attempted.length} of ${live.length} slot${live.length === 1 ? '' : 's'} dispatched`,
        counts,
    };
}

function verifiedStage(slots) {
    const live = slots.filter((s) => !s.withdrawn);
    const verified = live.filter((s) => s.verified);
    const operatorAccepted = live.filter((s) => s.operatorAccepted);
    const counts = {
        verified: verified.length,
        live: live.length,
        // Reported beside `verified`, never inside it: this work did not pass QA.
        operatorAccepted: operatorAccepted.length,
    };
    if (verified.length === 0) {
        return {
            stage: 'verified',
            reached: false,
            at: null,
            detail: operatorAccepted.length > 0
                ? `0 QA-passed; ${operatorAccepted.length} operator-accepted over a QA rejection`
                : `0 of ${live.length} slots QA-passed`,
            counts,
        };
    }
    const complete = verified.length + operatorAccepted.length === live.length;
    return {
        stage: 'verified',
        reached: true,
        complete,
        at: latest(verified.map((s) => s.provenanceAt)),
        detail: operatorAccepted.length > 0
            ? `${verified.length} of ${live.length} QA-passed; ${operatorAccepted.length} operator-accepted`
            : `${verified.length} of ${live.length} slot${live.length === 1 ? '' : 's'} QA-passed`,
        counts,
    };
}

/**
 * The first stage that has not been reached, plus how long the slate has been
 * sitting there. This is the number the 2026-08-24 slate never showed anyone.
 *
 * "Since" is the timestamp of the stage that DID complete (or the pending
 * approval's requestedAt), because that is the moment the slate started
 * waiting. A slate whose last stage is reached is not stalled at all.
 */
function findStall(stages, now) {
    const pending = stages.find((s) => !s.reached);
    if (!pending) return null;
    const index = stages.indexOf(pending);
    const since = pending.waitingSince || (index > 0 ? stages[index - 1].at : null);
    const sinceMs = since ? Date.parse(since) : NaN;
    const waitingMs = Number.isFinite(sinceMs) ? Math.max(0, now.getTime() - sinceMs) : null;
    return {
        stage: pending.stage,
        since,
        waitingMs,
        // A rejected slate is not "stalled", it is finished and will not run.
        blocked: pending.blocked === true,
        unknown: pending.unknown === true,
        // Only a stage that can still advance, has a clock, and has been on it
        // a while is worth shouting about.
        warn: pending.blocked !== true && waitingMs !== null && waitingMs >= STALL_WARN_MS,
    };
}

/**
 * Build the lifecycle from an already-parsed schedule object.
 *
 * Pure: no filesystem, no clock beyond the `now` you pass. `readSlateLifecycle`
 * is the thin I/O wrapper.
 */
function buildSlateLifecycle(schedule, now = new Date()) {
    if (!schedule || typeof schedule !== 'object' || !Array.isArray(schedule.slots)) {
        throw new Error('Invalid day schedule');
    }
    const rawSlots = schedule.slots.filter((s) => s && typeof s === 'object');
    const slots = rawSlots.map(projectSlot);

    const stages = [
        draftedStage(schedule, slots),
        approvedStage(schedule, rawSlots),
        attemptedStage(slots),
        verifiedStage(slots),
    ];

    const date = typeof schedule.date === 'string' ? schedule.date : null;
    const lastSlotStart = latest(slots.map((s) => s.startTime));
    const lastEndMs = lastSlotStart ? Date.parse(lastSlotStart) : NaN;
    // Today's slate is today's. Anything older is only plausibly live while
    // Praxis would still rehydrate it; past that it is history on disk.
    const isToday = date === scheduleDateString(now);
    const withinCarryover = Number.isFinite(lastEndMs) && now.getTime() - lastEndMs <= CARRYOVER_GRACE_MS;

    return {
        available: true,
        date,
        scheduleId: schedule.decisionIdentity?.scheduleId ?? null,
        morningRunId: schedule.decisionIdentity?.morningRunId ?? null,
        createdAt: isoOrNull(schedule.createdAt),
        stale: !isToday && !withinCarryover,
        carriedOver: !isToday && withinCarryover,
        stages,
        stall: findStall(stages, now),
        slots,
    };
}

/**
 * Read Praxis's schedule file and project it. Never throws: an absent,
 * oversized or malformed file is `available: false` with the reason, because
 * "the cockpit cannot see the slate" and "there is no slate" are different
 * things to tell Robert.
 */
function readSlateLifecycle({
    file = process.env.PRAXIS_SCHEDULE_FILE
        || path.join(process.env.PRAXIS_DATA_DIR || '/Volumes/Projects/Praxis/data', 'schedule.json'),
    now = new Date(),
    readFileSync = fs.readFileSync,
    statSync = fs.statSync,
} = {}) {
    try {
        // The file carries every slot's full brief, so it is megabytes, not
        // kilobytes. The ceiling is a sanity bound, not a size expectation.
        if (statSync(file).size > 16 * 1024 * 1024) throw new Error('Oversized schedule file');
        return buildSlateLifecycle(JSON.parse(readFileSync(file, 'utf8')), now);
    } catch (err) {
        return { available: false, reason: err.message, date: null, stages: [], stall: null, slots: [] };
    }
}

module.exports = { STALL_WARN_MS, buildSlateLifecycle, readSlateLifecycle };
