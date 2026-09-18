/**
 * Slate lifecycle projection (services/slate-lifecycle.js, route
 * routes/slate.js, contract docs/contracts/slate-lifecycle.md).
 *
 * The incident this surface exists for is one specific false reading: a slate
 * that was built, carded, and never approved looked exactly like a quiet day.
 * So the tests below are mostly about what must NOT collapse into what:
 * pending vs approved vs absent approval, skipped vs never-dispatched,
 * operator-accepted vs QA-passed, yesterday's file vs today's slate.
 *
 * Two of those distinctions were added by the 2026-09-18 QA round:
 *   - `completed` alone is not dispatch evidence and not a QA pass. Only the
 *     stamp Praxis's own reconciliation canary accepts as proof counts.
 *   - staleness is a property of the WORK, mirroring Praxis's isScheduleStale,
 *     not of the last slot's start time.
 */

const {
    buildSlateLifecycle,
    readSlateLifecycle,
    STALL_WARN_MS,
} = require('../services/slate-lifecycle');
const { readQaEvidence } = require('../services/slate-qa-evidence');
const createSlateRouter = require('../routes/slate');

const NOW = new Date('2026-09-17T12:00:00.000Z');
// Praxis stamps `schedule.date` with etDateString (America/New_York), and the
// projection compares against the same zone. Pinned here so the suite does not
// silently depend on the host's timezone.
const TODAY = NOW.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const slot = (over = {}) => ({
    slotNumber: 1,
    nexusTaskId: 'task-1',
    title: 'A slot',
    workspace: '/Volumes/Projects/TheNexus',
    estimatedMinutes: 60,
    startTime: '2026-09-17T11:00:00.000Z',
    status: 'pending',
    executor: 'claude-code',
    ...over,
});

const schedule = (over = {}) => ({
    date: TODAY,
    createdAt: '2026-09-17T10:00:00.000Z',
    slots: [slot()],
    approval: { hitlId: 'day-schedule-x', status: 'approved', requestedAt: '2026-09-17T10:01:00.000Z', resolvedAt: '2026-09-17T10:05:00.000Z' },
    ...over,
});

/**
 * A provenance stamp the dispatch plane can stand behind: `advance-callback`
 * WITH the attempt correlation. dispatch-provenance.ts is explicit that a bare
 * advance-callback stamp without an attemptId "means no dispatch attempt was
 * ever recorded anywhere, and that completion stays unproven".
 */
const proven = (at, over = {}) => ({ via: 'advance-callback', at, attemptId: 'attempt-1', spineRecorded: true, ...over });

/**
 * Praxis's verification ledger, as buildSlateLifecycle consumes it (see
 * services/slate-qa-evidence.js). QA evidence is a SECOND source: the schedule
 * file records dispatch, the ledger records the reviewer's verdict, and since
 * the 2026-09-18 QA round neither one alone can claim a QA pass.
 */
const qaLedger = (entries = {}) => ({
    available: true,
    records: new Map(Object.entries(entries).map(([taskId, over]) => [taskId, {
        passed: true, outcome: 'pass', verdict: 'verified', reviewer: 'codex', author: 'claude-code',
        at: '2026-09-17T11:45:00.000Z', ...over,
    }])),
});
/** Every named task QA-passed; anything else in the slate did not. */
const qaPassed = (...taskIds) => qaLedger(Object.fromEntries((taskIds.length ? taskIds : ['task-1']).map((id) => [id, {}])));
const qaUnreadable = (reason = 'ENOENT: no such file') => ({ available: false, reason, records: new Map() });

const stageOf = (lifecycle, name) => lifecycle.stages.find((s) => s.stage === name);

describe('the four stages', () => {
    it('reports them in lifecycle order, always all four', () => {
        const lifecycle = buildSlateLifecycle(schedule(), NOW);
        expect(lifecycle.stages.map((s) => s.stage)).toEqual(['drafted', 'approved', 'attempted', 'verified']);
    });

    it('rejects anything that is not a schedule rather than inventing stages', () => {
        expect(() => buildSlateLifecycle(null, NOW)).toThrow('Invalid day schedule');
        expect(() => buildSlateLifecycle({ date: TODAY }, NOW)).toThrow('Invalid day schedule');
    });
});

describe('the approval stage: the 2026-08-24 reading', () => {
    it('a pending approval is NOT reached, and names what it is waiting on', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            approval: { hitlId: 'h', status: 'pending', requestedAt: '2026-09-17T10:01:00.000Z' },
        }), NOW);
        const approved = stageOf(lifecycle, 'approved');
        expect(approved.reached).toBe(false);
        expect(approved.waitingSince).toBe('2026-09-17T10:01:00.000Z');
        expect(approved.detail).toMatch(/Waiting on Robert/);
    });

    it('surfaces the stall with its clock, which is the fact the slate never showed', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            approval: { hitlId: 'h', status: 'pending', requestedAt: '2026-09-17T10:01:00.000Z' },
        }), NOW);
        expect(lifecycle.stall.stage).toBe('approved');
        expect(lifecycle.stall.waitingMs).toBe(119 * 60_000);
        expect(lifecycle.stall.warn).toBe(true);
    });

    it('does not shout about a stage that only just started waiting', () => {
        const requestedAt = new Date(NOW.getTime() - (STALL_WARN_MS - 60_000)).toISOString();
        const lifecycle = buildSlateLifecycle(schedule({
            approval: { hitlId: 'h', status: 'pending', requestedAt },
        }), NOW);
        expect(lifecycle.stall.stage).toBe('approved');
        expect(lifecycle.stall.warn).toBe(false);
    });

    it('a MISSING approval record reads unknown, never approved', () => {
        const lifecycle = buildSlateLifecycle(schedule({ approval: undefined }), NOW);
        const approved = stageOf(lifecycle, 'approved');
        expect(approved.reached).toBe(false);
        expect(approved.unknown).toBe(true);
        expect(lifecycle.stall.unknown).toBe(true);
    });

    it('a rejected slate is blocked, not merely late, so there is no stall clock to chase', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            approval: { hitlId: 'h', status: 'rejected', requestedAt: '2026-09-17T10:01:00.000Z', resolvedAt: '2026-09-17T10:02:00.000Z' },
        }), NOW);
        expect(stageOf(lifecycle, 'approved').blocked).toBe(true);
        expect(lifecycle.stall.blocked).toBe(true);
        expect(lifecycle.stall.warn).toBe(false);
    });

    it('counts slots that arrived pre-approved by project policy', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot(), slot({ slotNumber: 2, approvalSource: 'standing_consent' })],
        }), NOW);
        const approved = stageOf(lifecycle, 'approved');
        expect(approved.counts.standingConsent).toBe(1);
        expect(approved.detail).toMatch(/1 pre-approved by project policy/);
    });
});

describe('the attempted stage', () => {
    it('an approved slate with nothing dispatched stalls at attempted', () => {
        const lifecycle = buildSlateLifecycle(schedule(), NOW);
        expect(stageOf(lifecycle, 'attempted').reached).toBe(false);
        expect(lifecycle.stall.stage).toBe('attempted');
        // Clocked from the approval, the moment the slate started waiting to run.
        expect(lifecycle.stall.since).toBe('2026-09-17T10:05:00.000Z');
    });

    it('a skipped slot is not an attempt, and leaves the denominator', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [
                slot({ status: 'skipped', skip: { reason: 'already done', resolvedAt: '2026-09-17T10:06:00.000Z', source: 'reconciliation' } }),
                slot({ slotNumber: 2, status: 'dispatched' }),
            ],
        }), NOW);
        const attempted = stageOf(lifecycle, 'attempted');
        expect(attempted.counts).toMatchObject({ attempted: 1, live: 1, withdrawn: 1 });
        expect(lifecycle.slots[0].skipSource).toBe('reconciliation');
    });

    it('a slate whose every slot was withdrawn says so instead of reading as zero dispatches', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'skipped' }), slot({ slotNumber: 2, status: 'deferred' })],
        }), NOW);
        expect(stageOf(lifecycle, 'attempted').detail).toBe('Every slot was withdrawn before dispatch');
    });

    it('a slate with no slots at all is not reported as a withdrawn one', () => {
        const lifecycle = buildSlateLifecycle(schedule({ slots: [] }), NOW);
        expect(stageOf(lifecycle, 'attempted').detail).toBe('This slate has no slots');
    });

    it('a withdrawn slot is not an attempt even when it carries a provenance stamp', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'skipped', provenance: { via: 'out-of-band', at: '2026-09-17T11:10:00.000Z', spineRecorded: true } })],
        }), NOW);
        expect(lifecycle.slots[0].attempted).toBe(false);
        expect(stageOf(lifecycle, 'attempted').counts).toMatchObject({ attempted: 0, withdrawn: 1 });
    });

    it('counts a slot whose spine write was rejected: it ran, the spine lost it', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z', { spineRecorded: false }) })],
        }), NOW);
        expect(stageOf(lifecycle, 'attempted').counts.spineUnrecorded).toBe(1);
    });

    it('dates the stage from the provenance stamp, not the planned start time', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
        }), NOW);
        expect(stageOf(lifecycle, 'attempted').at).toBe('2026-09-17T11:30:00.000Z');
    });
});

describe('the verified stage', () => {
    it('operator-accepted is attempted but NEVER verified', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'operator-accepted', provenance: { via: 'operator-accept', at: '2026-09-17T11:40:00.000Z', attemptId: 'attempt-1', spineRecorded: true } })],
        }), NOW, qaLedger());
        expect(stageOf(lifecycle, 'attempted').reached).toBe(true);
        const verified = stageOf(lifecycle, 'verified');
        expect(verified.reached).toBe(false);
        expect(verified.counts).toMatchObject({ verified: 0, operatorAccepted: 1 });
        expect(verified.detail).toMatch(/operator-accepted over a QA rejection/);
    });

    it('is complete only when every live slot is terminal', () => {
        const done = (n) => slot({ slotNumber: n, nexusTaskId: `task-${n}`, status: 'completed', provenance: proven(`2026-09-17T1${n}:00:00.000Z`) });
        const ledger = qaPassed('task-1', 'task-2');
        const partial = buildSlateLifecycle(schedule({ slots: [done(1), slot({ slotNumber: 2, nexusTaskId: 'task-2', status: 'dispatched' })] }), NOW, ledger);
        expect(stageOf(partial, 'verified').complete).toBe(false);
        const whole = buildSlateLifecycle(schedule({ slots: [done(1), done(2)] }), NOW, ledger);
        expect(stageOf(whole, 'verified').complete).toBe(true);
        expect(whole.stall).toBeNull();
    });
});

describe('completion is not proof of dispatch, and not proof of QA', () => {
    // QA 2026-09-18, finding 1. Praxis promotes board-completed work into the
    // `completed` slot status from paths that never touched the dispatch plane:
    // healSuspendedSlotsCompletedOnBoard (scheduler/calendar-sync.ts) heals a
    // suspended slot whose task the board already calls done, including work
    // Robert finished by hand, and the reconciliation pass consumes already-done
    // slots `out-of-band`, which dispatch-provenance.ts:65 defines as "no plane
    // run". The reviewer's probe fed one such slot in and got back "1 of 1 slot
    // dispatched", "1 of 1 slot QA-passed" and stall: null.
    const outOfBand = (over = {}) => slot({
        status: 'completed',
        provenance: { via: 'out-of-band', at: '2026-09-17T11:05:00.000Z', spineRecorded: true },
        ...over,
    });

    it("an out-of-band completion claims neither dispatch nor a QA pass", () => {
        const lifecycle = buildSlateLifecycle(schedule({ slots: [outOfBand()] }), NOW);
        expect(stageOf(lifecycle, 'attempted').reached).toBe(false);
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
        expect(lifecycle.slots[0]).toMatchObject({ attempted: false, verified: false, outOfBand: true, unprovenCompletion: false });
    });

    it('names the out-of-band work instead of hiding it behind a zero', () => {
        const lifecycle = buildSlateLifecycle(schedule({ slots: [outOfBand()] }), NOW, qaLedger());
        expect(stageOf(lifecycle, 'attempted').detail).toBe('0 of 1 slots dispatched; 1 landed out of band');
        expect(stageOf(lifecycle, 'verified').detail).toBe('0 of 1 slot QA-passed; 1 landed out of band, not QA-passed');
        expect(stageOf(lifecycle, 'verified').counts).toMatchObject({ verified: 0, outOfBand: 1, unproven: 0 });
    });

    it('a manual completion with no stamp at all is unproven, not dispatched', () => {
        // The calendar-sync heal path: the board says done, the plan has no
        // record of a run, and nothing in the file can say which way it went.
        const lifecycle = buildSlateLifecycle(schedule({ slots: [slot({ status: 'completed' })] }), NOW, qaLedger());
        expect(lifecycle.slots[0]).toMatchObject({ attempted: false, verified: false, outOfBand: false, unprovenCompletion: true });
        expect(stageOf(lifecycle, 'verified').detail).toBe('0 of 1 slot QA-passed; 1 completed with no dispatch evidence');
    });

    it('a bare advance-callback stamp without an attemptId stays unproven', () => {
        // dispatch-provenance.ts, verbatim: a bare advance-callback stamp
        // "means no dispatch attempt was ever recorded anywhere, and that
        // completion stays unproven".
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: { via: 'advance-callback', at: '2026-09-17T11:30:00.000Z', spineRecorded: true } })],
        }), NOW);
        expect(lifecycle.slots[0].unprovenCompletion).toBe(true);
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
    });

    it('the same stamp WITH an attemptId, plus a QA verdict, is a QA pass', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
        }), NOW, qaPassed());
        expect(lifecycle.slots[0]).toMatchObject({ attempted: true, verified: true, unprovenCompletion: false });
        expect(stageOf(lifecycle, 'verified').detail).toBe('1 of 1 slot QA-passed');
    });

    it('an in-flight slot is dispatched on the strength of the dispatch itself', () => {
        const lifecycle = buildSlateLifecycle(schedule({ slots: [slot({ status: 'dispatched' })] }), NOW);
        expect(stageOf(lifecycle, 'attempted').reached).toBe(true);
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
    });

    it.each([
        ['usage-limit-suspension', 'suspended'],
        ['dispatch-failure', 'suspended'],
    ])('a %s stamp proves the plane ran without claiming a QA pass', (via, status) => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status, provenance: { via, at: '2026-09-17T11:20:00.000Z', spineRecorded: true } })],
        }), NOW);
        expect(stageOf(lifecycle, 'attempted').reached).toBe(true);
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
    });

    it('"complete" means QA-passed, so out-of-band work never closes it', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [
                slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') }),
                outOfBand({ slotNumber: 2, nexusTaskId: 'task-2' }),
            ],
        }), NOW, qaPassed('task-1'));
        const verified = stageOf(lifecycle, 'verified');
        expect(verified.reached).toBe(true);
        expect(verified.complete).toBe(false);
        expect(verified.counts).toMatchObject({ verified: 1, live: 2, outOfBand: 1 });
    });

    it('a cancelled slot is not an attempt, but the plane did run it', () => {
        // Two different questions. `attempted` answers "does this slot count
        // as an attempt in the plan" (no: it was withdrawn); `dispatchProven`
        // answers "did the plane touch it" (yes), and flattening the second
        // into the first is how evidence goes missing.
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'skipped', skip: { source: 'human' }, provenance: proven('2026-09-17T11:10:00.000Z') })],
        }), NOW);
        expect(lifecycle.slots[0]).toMatchObject({ withdrawn: true, attempted: false, dispatchProven: true, verified: false });
        expect(stageOf(lifecycle, 'attempted').counts).toMatchObject({ attempted: 0, live: 0, withdrawn: 1 });
    });

    it('a settled slate with no live work does not warn about a stage it cannot advance', () => {
        const lifecycle = buildSlateLifecycle(schedule({ slots: [outOfBand()] }), NOW);
        expect(lifecycle.liveSlots).toBe(0);
        expect(lifecycle.stall.stage).toBe('attempted');
        expect(lifecycle.stall.stalled).toBe(false);
        expect(lifecycle.stall.warn).toBe(false);
    });
});

describe('a reconciled completion is not a QA pass', () => {
    /**
     * QA 2026-09-18 round 2. Praxis's terminal reconciliation
     * (scheduler/terminal-reconciliation.ts) flips a slot to `completed` when
     * the BOARD reports the task done, and it never touches the slot's
     * provenance: `candidate.status = target` with no write to
     * `candidate.provenance`. So whatever attempt evidence was already on the
     * slot survives the transition, and the moment somebody finishes the task
     * by hand, a suspended-at-usage-limit slot, a failed-dispatch slot, or one
     * carrying an older correlated advance-callback stamp reads as a finished
     * run. Reviewer's probe, running that real function, got back
     * `verified.reached: true` / `"1 of 1 slot QA-passed"` on all three.
     *
     * The rule now: dispatch evidence proves a RUN, a verdict in Praxis's
     * verification ledger proves a REVIEW, and only the second can close the
     * verified stage. Neither replaces the other, and the attempt evidence is
     * kept in every case below.
     */
    const reconciled = (via, at, over = {}) => slot({
        // What the slot looks like AFTER reconcileTerminalTask: board-completed
        // status, pre-existing stamp untouched.
        status: 'completed',
        provenance: { via, at, attemptId: 'att-1', executor: 'codex', spineRecorded: true, ...over },
    });

    it.each([
        ['usage-limit-suspension', '2026-09-17T09:10:00.000Z'],
        ['dispatch-failure', '2026-09-17T09:20:00.000Z'],
        ['advance-callback', '2026-09-17T09:00:00.000Z'],
    ])('a retained %s stamp does not become a QA pass', (via, at) => {
        const lifecycle = buildSlateLifecycle(schedule({ slots: [reconciled(via, at)] }), NOW, qaLedger());
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
        expect(lifecycle.slots[0]).toMatchObject({ verified: false, qaPassed: false, qaUnverified: true });
        expect(stageOf(lifecycle, 'verified').detail).toBe('0 of 1 slot QA-passed; 1 completed with no QA verdict');
    });

    it('keeps the attempt evidence it really has', () => {
        // "Expose verification as unproven WITHOUT discarding genuine attempt
        // evidence" (reviewer). The plane did run this slot; only the review
        // is missing, and the attempted stage must still say so.
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [reconciled('usage-limit-suspension', '2026-09-17T09:10:00.000Z')],
        }), NOW, qaLedger());
        expect(stageOf(lifecycle, 'attempted').reached).toBe(true);
        expect(stageOf(lifecycle, 'attempted').detail).toBe('1 of 1 slot dispatched');
        expect(lifecycle.slots[0]).toMatchObject({ attempted: true, dispatchProven: true });
    });

    it('the same slot WITH a reviewer verdict IS a QA pass', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [reconciled('advance-callback', '2026-09-17T09:00:00.000Z')],
        }), NOW, qaPassed('task-1'));
        expect(stageOf(lifecycle, 'verified').reached).toBe(true);
        expect(lifecycle.slots[0]).toMatchObject({ verified: true, qaPassed: true, qaUnverified: false, qaOutcome: 'pass', qaReviewer: 'codex' });
    });

    it.each(['exempt', 'none', 'deferred'])('a %s audit is not a pass', (outcome) => {
        // verification-protocol.ts: `deferred` "grades exactly like none — the
        // completion is NOT verified"; `exempt` is a waived audit.
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [reconciled('advance-callback', '2026-09-17T09:00:00.000Z')],
        }), NOW, qaLedger({ 'task-1': { passed: false, outcome, verdict: 'unverified' } }));
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
        expect(lifecycle.slots[0]).toMatchObject({ verified: false, qaUnverified: true, qaOutcome: outcome });
    });

    it("carries Praxis's own grade of the evidence without letting it change the verdict", () => {
        // Today's real ledger rows are mostly qa.outcome=pass with verdict
        // "uncertain" (the evidence-chain abstention). That is a pass whose
        // evidence Praxis graded weak, not a failed review.
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
        }), NOW, qaLedger({ 'task-1': { verdict: 'uncertain' } }));
        expect(lifecycle.slots[0]).toMatchObject({ verified: true, qaVerdict: 'uncertain' });
    });

    it('an unreadable ledger is unknown, not a failed review', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
        }), NOW, qaUnreadable('SQLITE_CANTOPEN: unable to open database file'));
        expect(lifecycle.qaEvidence).toEqual({ available: false, reason: 'SQLITE_CANTOPEN: unable to open database file' });
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
        expect(stageOf(lifecycle, 'verified').qaEvidence).toBe(false);
        expect(stageOf(lifecycle, 'verified').unknown).toBe(true);
        expect(stageOf(lifecycle, 'verified').counts).toMatchObject({ verified: null, qaUnverified: null, qaUnknown: 1 });
        expect(stageOf(lifecycle, 'verified').detail).not.toMatch(/0 of|no QA verdict|not QA-passed/);
        expect(lifecycle.stall).toMatchObject({ unknown: true, warn: false });
        expect(stageOf(lifecycle, 'verified').detail).toContain('QA ledger unavailable (SQLITE_CANTOPEN');
        // And the run it really did have is still reported.
        expect(stageOf(lifecycle, 'attempted').reached).toBe(true);
    });

    it('never reaches verification with unavailable QA evidence, even if records contain a pass', () => {
        const plan = schedule({
            slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
        });
        const pass = qaPassed('task-1');
        expect(stageOf(buildSlateLifecycle(plan, NOW, pass), 'verified'))
            .toMatchObject({ reached: true, qaEvidence: true });
        for (const records of [new Map(), pass.records]) {
            const verified = stageOf(buildSlateLifecycle(plan, NOW, {
                available: false, reason: 'SQLITE_CANTOPEN', records,
            }), 'verified');
            expect(verified).toMatchObject({ reached: false, unknown: true, qaEvidence: false });
        }
    });

    it('does not call unknown QA late while dispatches remain in flight', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'dispatched', provenance: proven('2026-09-17T10:30:00.000Z') })],
        }), NOW, qaUnreadable());
        expect(stageOf(lifecycle, 'attempted').counts.attempted).toBe(1);
        expect(stageOf(lifecycle, 'verified')).toMatchObject({ unknown: true, counts: { verified: null } });
        expect(lifecycle.stall).toMatchObject({ stage: 'verified', unknown: true, stalled: true, warn: false });
    });

    it('claims nothing at all when no evidence source is supplied', () => {
        // A caller holding only the schedule file holds only dispatch evidence.
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
        }), NOW);
        expect(lifecycle.qaEvidence.available).toBe(false);
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
    });
});

describe("reading Praxis's verification ledger", () => {
    const row = (taskId, over = {}) => ({
        task_id: taskId,
        ts: '2026-09-17T11:45:00.000Z',
        phase: 'verified',
        data: JSON.stringify({ verdict: 'verified', qa: { outcome: 'pass', reviewer: 'codex', author: 'claude-code' }, ...over }),
    });
    const ledgerOf = (rows, capture = {}) => readQaEvidence({
        taskIds: ['task-1', 'task-2'],
        since: '2026-09-17T10:00:00.000Z',
        file: '/tmp/fake-spine.sqlite',
        existsSync: () => true,
        openDb: () => ({
            prepare(sql) {
                capture.sql = sql;
                return { all: (...params) => { capture.params = params; return rows; } };
            },
        }),
    });

    it('reads a pass with its reviewer and grade', () => {
        const evidence = ledgerOf([row('task-1')]);
        expect(evidence.available).toBe(true);
        expect(evidence.records.get('task-1')).toMatchObject({ passed: true, outcome: 'pass', verdict: 'verified', reviewer: 'codex' });
    });

    it('only "pass" is a pass', () => {
        for (const outcome of ['exempt', 'none', 'deferred']) {
            const evidence = ledgerOf([row('task-1', { qa: { outcome } })]);
            expect(evidence.records.get('task-1').passed).toBe(false);
        }
    });

    it('floors the query at the slate, so an older verdict cannot be borrowed', () => {
        const capture = {};
        ledgerOf([], capture);
        expect(capture.sql).toContain("type = 'verification'");
        expect(capture.sql).toContain('ts >= ?');
        expect(capture.params).toEqual(['task-1', 'task-2', '2026-09-17T10:00:00.000Z']);
    });

    it('the newest verdict for a task wins', () => {
        const evidence = ledgerOf([
            row('task-1', { verdict: 'unverified', qa: { outcome: 'none' } }),
            row('task-1', { verdict: 'verified', qa: { outcome: 'pass', reviewer: 'codex' } }),
        ]);
        expect(evidence.records.get('task-1').passed).toBe(true);
    });

    it('executes timestamp filtering and newest-verdict selection in SQLite', () => {
        const Database = require('better-sqlite3');
        const db = new Database(':memory:');
        try {
            db.exec('CREATE TABLE run_events (seq INTEGER PRIMARY KEY, task_id TEXT, ts TEXT, type TEXT, phase TEXT, data TEXT)');
            const insert = db.prepare('INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?)');
            const add = (seq, taskId, ts, outcome, type = 'verification') => insert.run(
                seq, taskId, ts, type, 'uncertain', JSON.stringify({ qa: { outcome } }),
            );
            // Insert out of sequence and timestamp order: append seq is authoritative.
            add(30, 'task-1', '2026-09-17T11:00:00.000Z', 'none');
            add(20, 'task-1', '2026-09-17T12:00:00.000Z', 'pass');
            add(40, 'task-1', '2026-09-17T12:00:00.000Z', 'pass', 'dispatch');
            add(50, 'old-only', '2026-09-17T09:59:59.999Z', 'pass');
            add(60, 'boundary', '2026-09-17T10:00:00.000Z', 'pass');
            add(70, 'unrequested', '2026-09-17T11:00:00.000Z', 'pass');
            const evidence = readQaEvidence({
                taskIds: ['task-1', 'old-only', 'boundary'],
                since: '2026-09-17T10:00:00.000Z',
                existsSync: () => true, openDb: () => db,
            });
            expect(evidence.available).toBe(true);
            expect([...evidence.records.keys()].sort()).toEqual(['boundary', 'task-1']);
            expect(evidence.records.get('task-1')).toMatchObject({ passed: false, outcome: 'none' });
            expect(evidence.records.get('boundary')).toMatchObject({ passed: true });
        } finally {
            db.close();
        }
    });

    it('a missing ledger is unavailable with a reason, never an empty pass list', () => {
        const evidence = readQaEvidence({ taskIds: ['task-1'], file: '/tmp/not-here.sqlite', existsSync: () => false });
        expect(evidence.available).toBe(false);
        expect(evidence.reason).toMatch(/not found/);
        expect(evidence.records.size).toBe(0);
    });

    it('a failed read is unavailable, not empty', () => {
        const evidence = readQaEvidence({
            taskIds: ['task-1'], file: '/tmp/locked.sqlite', existsSync: () => true,
            openDb: () => { throw new Error('SQLITE_BUSY: database is locked'); },
        });
        expect(evidence.available).toBe(false);
        expect(evidence.reason).toMatch(/SQLITE_BUSY/);
    });

    it('malformed row data degrades to "no pass", not a crash', () => {
        const evidence = ledgerOf([{ task_id: 'task-1', ts: 'x', phase: null, data: 'not json' }]);
        expect(evidence.records.get('task-1')).toMatchObject({ passed: false, outcome: null });
    });

    it('a slate with no tasks never opens the ledger at all', () => {
        const evidence = readQaEvidence({ taskIds: [], openDb: () => { throw new Error('should not open'); } });
        expect(evidence.available).toBe(true);
        expect(evidence.records.size).toBe(0);
    });
});

describe('which day this slate belongs to', () => {
    it('today is neither stale nor carried over', () => {
        const lifecycle = buildSlateLifecycle(schedule(), NOW);
        expect(lifecycle.stale).toBe(false);
        expect(lifecycle.carriedOver).toBe(false);
    });

    it("yesterday's slate that spilled past midnight is carried over, not stale", () => {
        const lifecycle = buildSlateLifecycle(schedule({
            date: '2026-09-16',
            slots: [slot({ startTime: '2026-09-17T03:00:00.000Z' })],
        }), NOW);
        expect(lifecycle.carriedOver).toBe(true);
        expect(lifecycle.stale).toBe(false);
    });

    it('an old file on disk is stale: it must not be read as today', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            date: '2026-09-10',
            slots: [slot({ startTime: '2026-09-10T14:00:00.000Z' })],
        }), NOW);
        expect(lifecycle.stale).toBe(true);
    });

    /**
     * QA 2026-09-18, finding 2. Staleness belongs to Praxis, not to this
     * projection: plan-model.ts isScheduleStale asks whether LIVE work remains
     * (scheduleLiveSlotCount, pending or dispatched) and, if it does, measures
     * the grace period from the schedule's scheduled END (getScheduleEndTime =
     * last slot's startTime + estimatedMinutes + BUFFER_MINUTES), not from a
     * start time. These four fixtures are the reviewer's differential cases;
     * each expectation is the answer Praxis's own function gives.
     */
    describe("agreeing with Praxis's isScheduleStale", () => {
        it('an active overnight slot is NOT stale: its work has not run out', () => {
            // Praxis: live work remains and the scheduled end is inside the
            // grace window, so this is still the live plan. The slot STARTED
            // 12.5h ago, so the round-1 rule called it stale and the headline
            // read "no slate for today" over work that was running.
            const lifecycle = buildSlateLifecycle(schedule({
                date: '2026-09-16',
                slots: [slot({ startTime: '2026-09-16T23:30:00.000Z', status: 'dispatched' })],
            }), NOW);
            expect(lifecycle.liveSlots).toBe(1);
            expect(lifecycle.stale).toBe(false);
            expect(lifecycle.carriedOver).toBe(true);
        });

        it('a finished previous-day slate IS stale, with no live work left', () => {
            // Praxis: scheduleLiveSlotCount === 0, so stale regardless of clock.
            // The round-1 rule called this carried over and printed "running
            // past midnight" for a slate that had finished hours earlier.
            const lifecycle = buildSlateLifecycle(schedule({
                date: '2026-09-16',
                slots: [
                    slot({ status: 'completed', startTime: '2026-09-16T14:00:00.000Z', provenance: proven('2026-09-16T15:00:00.000Z') }),
                    slot({ slotNumber: 2, status: 'skipped', startTime: '2026-09-16T16:00:00.000Z' }),
                ],
            }), NOW);
            expect(lifecycle.liveSlots).toBe(0);
            expect(lifecycle.stale).toBe(true);
            expect(lifecycle.carriedOver).toBe(false);
        });

        it('an abandoned plan goes stale once its scheduled END clears the grace period', () => {
            const lifecycle = buildSlateLifecycle(schedule({
                date: '2026-09-15',
                slots: [slot({ startTime: '2026-09-15T14:00:00.000Z' })],
            }), NOW);
            expect(lifecycle.liveSlots).toBe(1);
            expect(lifecycle.stale).toBe(true);
        });

        it('a plan dated ahead of today is not "running past midnight"', () => {
            // Neither stale (its work has not aged) nor carried over (it has
            // not started). The headline must say the date, not narrate an
            // overnight run that has not happened.
            const lifecycle = buildSlateLifecycle(schedule({
                date: '2026-09-18',
                slots: [slot({ startTime: '2026-09-18T14:00:00.000Z' })],
            }), NOW);
            expect(lifecycle.stale).toBe(false);
            expect(lifecycle.carriedOver).toBe(false);
        });

        it("today's plan is never stale, even once every slot is finished", () => {
            const lifecycle = buildSlateLifecycle(schedule({
                slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:40:00.000Z') })],
            }), NOW);
            expect(lifecycle.liveSlots).toBe(0);
            expect(lifecycle.stale).toBe(false);
            expect(lifecycle.carriedOver).toBe(false);
        });

        it('live work does not exempt a plan forever: the end still ages out', () => {
            // The mirror image of the first case. Same dispatched slot, started
            // early enough that even end + duration + buffer clears the 12h
            // grace: Praxis calls it stale, and so must this.
            const lifecycle = buildSlateLifecycle(schedule({
                date: '2026-09-16',
                slots: [slot({ startTime: '2026-09-16T20:00:00.000Z', status: 'dispatched' })],
            }), NOW);
            expect(lifecycle.liveSlots).toBe(1);
            expect(lifecycle.stale).toBe(true);
        });
    });
});

describe('reading the file', () => {
    it('projects a schedule read off disk', () => {
        const lifecycle = readSlateLifecycle({
            file: '/tmp/does-not-matter.json',
            now: NOW,
            statSync: () => ({ size: 1024 }),
            readFileSync: () => JSON.stringify(schedule()),
        });
        expect(lifecycle.available).toBe(true);
        expect(lifecycle.date).toBe(TODAY);
    });

    it("asks the ledger only about this slate's tasks, from this slate's start", () => {
        let asked = null;
        const lifecycle = readSlateLifecycle({
            file: '/tmp/does-not-matter.json',
            now: NOW,
            statSync: () => ({ size: 1024 }),
            readFileSync: () => JSON.stringify(schedule({
                slots: [slot(), slot({ slotNumber: 2, nexusTaskId: 'task-2', status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
            })),
            qaEvidenceReader: (args) => { asked = args; return qaPassed('task-2'); },
        });
        expect(asked).toEqual({ taskIds: ['task-1', 'task-2'], since: '2026-09-17T10:00:00.000Z' });
        expect(stageOf(lifecycle, 'verified').counts.verified).toBe(1);
    });

    it('a slate with no createdAt still floors the ledger query at its first slot', () => {
        // Without a floor, a verdict from ANY earlier run of the same task
        // would count as a verdict on this slate. A schedule missing its
        // createdAt must not be the hole in that rule.
        let asked = null;
        readSlateLifecycle({
            file: '/tmp/does-not-matter.json',
            now: NOW,
            statSync: () => ({ size: 1024 }),
            readFileSync: () => JSON.stringify(schedule({
                createdAt: undefined,
                slots: [slot({ slotNumber: 2, startTime: '2026-09-17T14:00:00.000Z' }), slot()],
            })),
            qaEvidenceReader: (args) => { asked = args; return qaLedger(); },
        });
        expect(asked.since).toBe('2026-09-17T11:00:00.000Z');
    });

    it('a slate read without a readable ledger still reports its dispatches', () => {
        const lifecycle = readSlateLifecycle({
            file: '/tmp/does-not-matter.json',
            now: NOW,
            statSync: () => ({ size: 1024 }),
            readFileSync: () => JSON.stringify(schedule({
                slots: [slot({ status: 'completed', provenance: proven('2026-09-17T11:30:00.000Z') })],
            })),
            qaEvidenceReader: () => qaUnreadable(),
        });
        expect(stageOf(lifecycle, 'attempted').reached).toBe(true);
        expect(stageOf(lifecycle, 'verified').reached).toBe(false);
        expect(lifecycle.qaEvidence.available).toBe(false);
    });

    it('an unreadable file is "cannot see", not "no slate"', () => {
        const lifecycle = readSlateLifecycle({
            file: '/tmp/missing.json',
            now: NOW,
            statSync: () => { throw new Error('ENOENT: no such file'); },
        });
        expect(lifecycle.available).toBe(false);
        expect(lifecycle.reason).toMatch(/ENOENT/);
        expect(lifecycle.stages).toEqual([]);
    });

    it('refuses an implausibly large file instead of parsing it', () => {
        const lifecycle = readSlateLifecycle({
            file: '/tmp/huge.json',
            now: NOW,
            statSync: () => ({ size: 64 * 1024 * 1024 }),
            readFileSync: () => { throw new Error('should not be read'); },
        });
        expect(lifecycle.available).toBe(false);
        expect(lifecycle.reason).toBe('Oversized schedule file');
    });
});

describe('GET /api/slate/lifecycle', () => {
    const invoke = (readLifecycle) => new Promise((resolve) => {
        const router = createSlateRouter({ readLifecycle });
        const res = { json: (body) => resolve(body) };
        router.handle({ method: 'GET', url: '/lifecycle' }, res, () => resolve({ unhandled: true }));
    });

    it('answers with the projection', async () => {
        const body = await invoke(() => buildSlateLifecycle(schedule(), NOW));
        expect(body.available).toBe(true);
        expect(body.stages).toHaveLength(4);
        expect(Date.parse(body.at)).toBeGreaterThan(0);
    });

    it('answers 200 with available:false rather than failing the strip', async () => {
        const body = await invoke(() => ({ available: false, reason: 'ENOENT', date: null, stages: [], stall: null, slots: [] }));
        expect(body.available).toBe(false);
        expect(body.reason).toBe('ENOENT');
    });
});
