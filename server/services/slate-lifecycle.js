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
 *   2a. DISPATCH evidence is not QA evidence. `completed` + a provenance stamp
 *      proves a run, not a QA pass: terminal reconciliation flips a slot to
 *      `completed` on a board completion and leaves the old stamp in place
 *      (services/slate-qa-evidence.js has the whole chain). A QA pass is
 *      claimed only against Praxis's verification ledger, and when that ledger
 *      cannot be read the answer is "unknown", never "passed" and never "no".
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
const { readQaEvidence, noQaEvidence } = require('./slate-qa-evidence');

/**
 * DISPATCH EVIDENCE, not slot status.
 *
 * `completed` on a slot is NOT proof that the dispatch plane ran it, and it is
 * not proof that QA passed. Praxis promotes board-completed work into that
 * status from at least two directions that never touched the plane:
 * `healSuspendedSlotsCompletedOnBoard` (scheduler/calendar-sync.ts) heals a
 * suspended slot whose Nexus task the board already calls done, including work
 * Robert finished by hand, and the pre-dispatch reconciliation pass consumes
 * already-done slots `out-of-band`, which dispatch-provenance.ts defines in
 * as many words as "the task was already done on the board, no plane run".
 *
 * So the evidence test below is Praxis's OWN, lifted from the reconciliation
 * canary in executors/dispatch-provenance.ts, which had to answer this exact
 * question after the 2026-08-07/08 incident ("nine completed slots alongside
 * zero recorded attempts means the control plane cannot currently prove what
 * executed"). Its rule, verbatim from that file:
 *
 *   - `advance-callback` + an `attemptId` is dispatch proof. A BARE
 *     advance-callback stamp with no attemptId "means no dispatch attempt was
 *     ever recorded anywhere, and that completion stays unproven".
 *   - `out-of-band` is out-of-band proof: the work landed, the plane did not
 *     run it. A separate outcome, never a dispatch and never a QA pass.
 *
 * Anything else is UNPROVEN. The cockpit reports unproven as unproven; it does
 * not round it up to dispatched or down to nothing.
 */

/** Stamps that mean the dispatch plane ran (or tried to run) this slot. */
const PLANE_RAN_VIA = new Set([
    // A run that hit its CLI usage limit mid-flight was, by definition, dispatched.
    'usage-limit-suspension',
    // Dispatch failed before release: an attempt was made and it did not launch.
    'dispatch-failure',
    // Robert overrode a QA rejection, so a run existed for QA to reject.
    'operator-accept',
]);

/** The stamp that explicitly means "no plane run" (dispatch-provenance.ts:65). */
const OUT_OF_BAND_VIA = 'out-of-band';

/**
 * Affirmative evidence the dispatch plane ran this slot. Mirrors the canary's
 * `dispatchProof`, minus the spine rows Nexus cannot read: the slot's own
 * persisted stamp is the half that survives a spine outage, and it is the half
 * that lives in the schedule file.
 */
function hasDispatchProof(status, provenance) {
    // Still in flight through the plane: the dispatch itself is the evidence.
    if (status === 'dispatched') return true;
    if (!provenance) return false;
    if (provenance.via === 'advance-callback') return typeof provenance.attemptId === 'string' && provenance.attemptId !== '';
    return PLANE_RAN_VIA.has(provenance.via);
}

/**
 * The only status that CAN mean the work passed cross-executor QA. Necessary,
 * never sufficient: it must also carry dispatch proof (the QA gate lives
 * inside the dispatch plane, so a completion that never entered the plane
 * never passed through the gate) AND an affirmative verdict in Praxis's
 * verification ledger. Status plus stamp is a run, not a review.
 */
const VERIFIED_STATUS = 'completed';

/** Slots that were taken out of the plan, excluded from every denominator. */
const WITHDRAWN_STATUSES = new Set(['skipped', 'deferred']);

/** Praxis rehydrates a spilled-over slate for this long (plan-model.ts:48). */
const CARRYOVER_GRACE_MS = 12 * 60 * 60_000;

/** Praxis pads every slot's end by this much (plan-model.ts:56, BUFFER_MINUTES). */
const BUFFER_MINUTES = 15;

/**
 * Slots that still OWE work. Praxis's `scheduleLiveSlotCount`
 * (plan-model.ts:401) verbatim: "Slots that still owe work: queued (pending)
 * or already in flight."
 */
const LIVE_STATUSES = new Set(['pending', 'dispatched']);

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
 * The plan's own end time. Praxis's `getScheduleEndTime` (plan-model.ts:487)
 * verbatim: the LAST slot in array order, its `startTime` plus
 * `estimatedMinutes + BUFFER_MINUTES`. Not the latest start, and not the start
 * alone: a 90-minute slot beginning at 23:30 does not end at 23:30.
 *
 * Returns NaN when the plan has no slots or the last one carries no usable
 * start; `isScheduleStale` never reaches this with an empty slot list, because
 * an empty plan has no live slots and settles on the branch above.
 */
function scheduleEndMs(rawSlots) {
    const last = rawSlots[rawSlots.length - 1];
    if (!last) return Number.NaN;
    const startMs = Date.parse(last.startTime);
    if (!Number.isFinite(startMs)) return Number.NaN;
    const estimate = Number.isFinite(last.estimatedMinutes) ? last.estimatedMinutes : 0;
    return startMs + (estimate + BUFFER_MINUTES) * 60_000;
}

/**
 * Is this persisted slate finished with, or is it still the live plan?
 *
 * This is Praxis's `isScheduleStale` (plan-model.ts:423), reimplemented against
 * the same fields so the cockpit's headline cannot disagree with the runtime's
 * own decision about which plan is live. Its rule, in its order:
 *
 *   1. Today's plan is never stale.
 *   2. Nothing left to dispatch means the day this plan belongs to is over,
 *      whatever the clock says.
 *   3. Live slots but far past the plan's END: abandoned, not spilling over.
 *
 * Staleness is a property of the WORK, not the calendar. Measuring it from the
 * last slot's START and ignoring whether work remains gets both fixtures
 * wrong in opposite directions: an active overnight slot reads stale, and a
 * finished previous-day slate reads as "running past midnight".
 */
function isScheduleStale(schedule, date, liveSlots, now) {
    if (date === scheduleDateString(now)) return false;
    if (liveSlots === 0) return true;
    const endMs = scheduleEndMs(schedule.slots);
    if (!Number.isFinite(endMs)) return false;
    return now.getTime() - endMs > CARRYOVER_GRACE_MS;
}

/**
 * Project one raw slot down to the fields this surface renders. Everything
 * else in a slot (instructions, objective, taskDescription, the
 * reconciliation evidence) is execution input and stays out of a read-only
 * status strip.
 */
function projectSlot(slot, qaEvidence) {
    const status = typeof slot.status === 'string' ? slot.status : 'pending';
    const provenance = slot.provenance && typeof slot.provenance === 'object' ? slot.provenance : null;
    const withdrawn = WITHDRAWN_STATUSES.has(status);
    const dispatchProven = hasDispatchProof(status, provenance);
    const outOfBand = provenance?.via === OUT_OF_BAND_VIA;
    const taskId = typeof slot.nexusTaskId === 'string' ? slot.nexusTaskId : null;
    // The verdict Praxis recorded when it finalized THIS slate's completion of
    // the task, or null when there is none to read. `available: false` means
    // the ledger itself could not be read: unknown, which is not the same as
    // "no pass" and must never be rendered as one.
    const qa = qaEvidence.available && taskId ? qaEvidence.records.get(taskId) || null : null;
    const qaPassed = qa ? qa.passed === true : false;
    const completed = status === VERIFIED_STATUS;
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
        attempted: !withdrawn && dispatchProven,
        // The raw evidence, WITHOUT the withdrawal mask above: a slot cancelled
        // mid-flight was removed from the plan and is not an attempt, but the
        // plane did run it, and "did the plane touch this slot" is a different
        // question from "does this slot count as an attempt".
        dispatchProven,
        // QA-passed needs THREE things, because each answers a different
        // question: the board says done, the plane can prove it ran, and the
        // verification ledger carries a reviewer's pass for this slate's
        // completion. Dropping the third is how a usage-limit suspension that
        // Robert finished by hand read as "1 of 1 slot QA-passed".
        verified: completed && dispatchProven && qaPassed,
        operatorAccepted: status === 'operator-accepted',
        // Done, but explicitly not by the plane and so not through the QA gate.
        outOfBand: completed && outOfBand,
        // Board says done; nothing anywhere proves a run. Reported as unknown
        // rather than folded into either of the two honest outcomes.
        unprovenCompletion: completed && !dispatchProven && !outOfBand,
        // Board says done and the plane really did run it, but no QA verdict
        // covers this completion. The attempt evidence stands; the QA claim
        // does not. This is the reconciled-completion case.
        qaUnverified: completed && dispatchProven && !outOfBand && !qaPassed,
        qaPassed,
        // Carried for the surface, never used to manufacture a pass: the audit
        // leg (pass/exempt/none/deferred) and Praxis's grade of the evidence
        // behind it (verified/uncertain/partial/unverified).
        qaOutcome: qa ? qa.outcome : null,
        qaVerdict: qa ? qa.verdict : null,
        qaReviewer: qa ? qa.reviewer : null,
        qaAt: qa ? qa.at : null,
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

/** ", 2 landed out of band, 1 unproven": the qualifiers, or an empty string. */
function evidenceSuffix(outOfBand, unproven) {
    const parts = [];
    if (outOfBand > 0) parts.push(`${outOfBand} landed out of band`);
    if (unproven > 0) parts.push(`${unproven} unproven`);
    return parts.length > 0 ? `; ${parts.join(', ')}` : '';
}

function attemptedStage(slots) {
    const live = slots.filter((s) => !s.withdrawn);
    const attempted = live.filter((s) => s.attempted);
    const outOfBand = live.filter((s) => s.outOfBand);
    const unproven = live.filter((s) => s.unprovenCompletion);
    const counts = {
        attempted: attempted.length,
        live: live.length,
        withdrawn: slots.length - live.length,
        spineUnrecorded: attempted.filter((s) => s.spineUnrecorded).length,
        // Resolved without the plane, and resolved with nothing to show for it.
        // Both are terminal and neither is a dispatch.
        outOfBand: outOfBand.length,
        unproven: unproven.length,
    };
    const suffix = evidenceSuffix(outOfBand.length, unproven.length);
    if (attempted.length === 0) {
        return {
            stage: 'attempted',
            reached: false,
            at: null,
            detail: slots.length === 0
                ? 'This slate has no slots'
                : live.length === 0
                    ? 'Every slot was withdrawn before dispatch'
                    : `0 of ${live.length} slots dispatched${suffix}`,
            counts,
        };
    }
    return {
        stage: 'attempted',
        reached: true,
        at: earliest(attempted.map((s) => s.provenanceAt || s.startTime)),
        detail: `${attempted.length} of ${live.length} slot${live.length === 1 ? '' : 's'} dispatched${suffix}`,
        counts,
    };
}

function verifiedStage(slots, qaEvidence) {
    const live = slots.filter((s) => !s.withdrawn);
    const verified = live.filter((s) => s.verified);
    const operatorAccepted = live.filter((s) => s.operatorAccepted);
    const outOfBand = live.filter((s) => s.outOfBand);
    const unproven = live.filter((s) => s.unprovenCompletion);
    const qaUnverified = live.filter((s) => s.qaUnverified);
    const counts = {
        verified: verified.length,
        live: live.length,
        // All four are reported BESIDE `verified`, never inside it. Each is a
        // different reason the work is done without having passed the QA gate:
        // Robert overrode a rejection, the plane never ran it, nothing can say
        // either way, or it ran and no reviewer ever signed it off.
        operatorAccepted: operatorAccepted.length,
        outOfBand: outOfBand.length,
        unproven: unproven.length,
        qaUnverified: qaUnverified.length,
    };
    if (!qaEvidence.available) {
        // An unreadable ledger cannot establish either passes or missing reviews.
        // Keep schedule/dispatch facts, but make QA counts explicitly unknown.
        return {
            stage: 'verified',
            reached: false,
            unknown: true,
            at: null,
            detail: `Verification unknown; QA ledger unavailable (${qaEvidence.reason || 'no reason given'})`,
            counts: { ...counts, verified: null, qaUnverified: null, qaUnknown: qaUnverified.length },
            qaEvidence: false,
        };
    }
    const qualifiers = [];
    if (operatorAccepted.length > 0) qualifiers.push(`${operatorAccepted.length} operator-accepted over a QA rejection`);
    if (outOfBand.length > 0) qualifiers.push(`${outOfBand.length} landed out of band, not QA-passed`);
    if (unproven.length > 0) qualifiers.push(`${unproven.length} completed with no dispatch evidence`);
    if (qaUnverified.length > 0) {
        qualifiers.push(`${qaUnverified.length} completed with no QA verdict`);
    }
    const suffix = qualifiers.length > 0 ? `; ${qualifiers.join('; ')}` : '';

    if (verified.length === 0) {
        return {
            stage: 'verified',
            reached: false,
            at: null,
            detail: `0 of ${live.length} slot${live.length === 1 ? '' : 's'} QA-passed${suffix}`,
            counts,
            qaEvidence: qaEvidence.available,
        };
    }
    // "Complete" is about the QA gate, so only QA-passed slots close it. A slate
    // finished off out of band is settled but NOT wholly verified, and saying
    // otherwise is the claim this stage exists to refuse.
    const complete = verified.length === live.length;
    return {
        stage: 'verified',
        reached: true,
        complete,
        at: latest(verified.map((s) => s.qaAt || s.provenanceAt)),
        detail: `${verified.length} of ${live.length} slot${live.length === 1 ? '' : 's'} QA-passed${suffix}`,
        counts,
        qaEvidence: qaEvidence.available,
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
function findStall(stages, now, liveSlots) {
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
        // Nothing queued and nothing in flight: the stage cannot advance because
        // the plan is out of work, not because it is late. Reported as pending,
        // never as an alarm.
        stalled: liveSlots > 0,
        // Only a stage that can still advance, has a clock, and has been on it
        // a while is worth shouting about.
        warn: pending.blocked !== true
            && !(pending.stage === 'verified' && pending.unknown === true)
            && liveSlots > 0
            && waitingMs !== null
            && waitingMs >= STALL_WARN_MS,
    };
}

/**
 * Build the lifecycle from an already-parsed schedule object.
 *
 * Pure: no filesystem, no clock beyond the `now` you pass. `readSlateLifecycle`
 * is the thin I/O wrapper.
 */
function buildSlateLifecycle(schedule, now = new Date(), qaEvidence = null) {
    if (!schedule || typeof schedule !== 'object' || !Array.isArray(schedule.slots)) {
        throw new Error('Invalid day schedule');
    }
    // No evidence argument means no QA evidence, which is UNKNOWN. A caller
    // that hands over only the schedule file has handed over dispatch
    // evidence; the QA verdicts live in a different store, and inferring a
    // pass from the schedule alone is the defect this parameter exists for.
    const evidence = qaEvidence && typeof qaEvidence === 'object' && qaEvidence.records instanceof Map
        ? qaEvidence
        : noQaEvidence();
    const rawSlots = schedule.slots.filter((s) => s && typeof s === 'object');
    const slots = rawSlots.map((slot) => projectSlot(slot, evidence));

    const stages = [
        draftedStage(schedule, slots),
        approvedStage(schedule, rawSlots),
        attemptedStage(slots),
        verifiedStage(slots, evidence),
    ];

    const date = typeof schedule.date === 'string' ? schedule.date : null;
    const liveSlots = rawSlots.filter((s) => LIVE_STATUSES.has(typeof s.status === 'string' ? s.status : 'pending')).length;
    const stale = isScheduleStale(schedule, date, liveSlots, now);
    const isToday = date === scheduleDateString(now);

    return {
        available: true,
        date,
        scheduleId: schedule.decisionIdentity?.scheduleId ?? null,
        morningRunId: schedule.decisionIdentity?.morningRunId ?? null,
        createdAt: isoOrNull(schedule.createdAt),
        stale,
        // Not today, not stale, and DATED BEFORE today: live work remains and
        // the plan is still inside Praxis's grace window. That, and only that,
        // is "running past midnight". A plan dated ahead of today is neither
        // stale nor carried over; it has not started.
        carriedOver: date !== null && !isToday && !stale && date < scheduleDateString(now),
        liveSlots,
        // Whether the QA half of this projection could be read at all, beside
        // the counts it produced. `available: false` means every unverified
        // slot below is unknown, not failed.
        qaEvidence: { available: evidence.available, ...(evidence.available ? {} : { reason: evidence.reason || null }) },
        stages,
        stall: findStall(stages, now, liveSlots),
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
    qaEvidenceReader = readQaEvidence,
} = {}) {
    try {
        // The file carries every slot's full brief, so it is megabytes, not
        // kilobytes. The ceiling is a sanity bound, not a size expectation.
        if (statSync(file).size > 16 * 1024 * 1024) throw new Error('Oversized schedule file');
        const schedule = JSON.parse(readFileSync(file, 'utf8'));
        // The QA half, from Praxis's verification ledger. Floored at the
        // slate's own start so a verdict from an earlier run of the same task
        // cannot be read as a verdict on this one.
        const slots = Array.isArray(schedule.slots) ? schedule.slots.filter((s) => s && typeof s === 'object') : [];
        const evidence = qaEvidenceReader({
            taskIds: slots.map((s) => s.nexusTaskId).filter((id) => typeof id === 'string'),
            // A slate with no usable createdAt still needs a floor, or a
            // verdict from any earlier run of the task would count: the first
            // slot's planned start is the next-best "this slate began here".
            since: isoOrNull(schedule.createdAt) || earliest(slots.map((s) => s.startTime)),
        });
        return buildSlateLifecycle(schedule, now, evidence);
    } catch (err) {
        return { available: false, reason: err.message, date: null, stages: [], stall: null, slots: [] };
    }
}

module.exports = { STALL_WARN_MS, buildSlateLifecycle, readSlateLifecycle };
