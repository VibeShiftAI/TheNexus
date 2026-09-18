/**
 * Slate lifecycle projection (services/slate-lifecycle.js, route
 * routes/slate.js, contract docs/contracts/slate-lifecycle.md).
 *
 * The incident this surface exists for is one specific false reading: a slate
 * that was built, carded, and never approved looked exactly like a quiet day.
 * So the tests below are mostly about what must NOT collapse into what:
 * pending vs approved vs absent approval, skipped vs never-dispatched,
 * operator-accepted vs QA-passed, yesterday's file vs today's slate.
 */

const {
    buildSlateLifecycle,
    readSlateLifecycle,
    STALL_WARN_MS,
} = require('../services/slate-lifecycle');
const createSlateRouter = require('../routes/slate');

const NOW = new Date('2026-09-17T12:00:00.000Z');
const TODAY = NOW.toLocaleDateString('en-CA');

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
            slots: [slot({ status: 'completed', provenance: { via: 'advance-callback', at: '2026-09-17T11:30:00.000Z', spineRecorded: false } })],
        }), NOW);
        expect(stageOf(lifecycle, 'attempted').counts.spineUnrecorded).toBe(1);
    });

    it('dates the stage from the provenance stamp, not the planned start time', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'completed', provenance: { via: 'advance-callback', at: '2026-09-17T11:30:00.000Z', spineRecorded: true } })],
        }), NOW);
        expect(stageOf(lifecycle, 'attempted').at).toBe('2026-09-17T11:30:00.000Z');
    });
});

describe('the verified stage', () => {
    it('operator-accepted is attempted but NEVER verified', () => {
        const lifecycle = buildSlateLifecycle(schedule({
            slots: [slot({ status: 'operator-accepted', provenance: { via: 'operator-accept', at: '2026-09-17T11:40:00.000Z', spineRecorded: true } })],
        }), NOW);
        expect(stageOf(lifecycle, 'attempted').reached).toBe(true);
        const verified = stageOf(lifecycle, 'verified');
        expect(verified.reached).toBe(false);
        expect(verified.counts).toMatchObject({ verified: 0, operatorAccepted: 1 });
        expect(verified.detail).toMatch(/operator-accepted over a QA rejection/);
    });

    it('is complete only when every live slot is terminal', () => {
        const done = (n) => slot({ slotNumber: n, status: 'completed', provenance: { via: 'advance-callback', at: `2026-09-17T1${n}:00:00.000Z`, spineRecorded: true } });
        const partial = buildSlateLifecycle(schedule({ slots: [done(1), slot({ slotNumber: 2, status: 'dispatched' })] }), NOW);
        expect(stageOf(partial, 'verified').complete).toBe(false);
        const whole = buildSlateLifecycle(schedule({ slots: [done(1), done(2)] }), NOW);
        expect(stageOf(whole, 'verified').complete).toBe(true);
        expect(whole.stall).toBeNull();
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
