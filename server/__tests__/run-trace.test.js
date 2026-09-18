/**
 * The standard run-trace field list (services/run-trace.js, contract
 * docs/contracts/run-trace.md).
 *
 * These tests guard the one property the whole schema exists for: a field is
 * either OBSERVED or UNKNOWN-WITH-A-REASON, and the two must never be able to
 * render alike. "0 retries" and "no retry telemetry" are different facts, and
 * a trace that defaults the second into the first has told the reader the
 * opposite of the truth.
 */

const {
    RUN_TRACE_FIELDS,
    REQUIRED_FIELD_KEYS,
    buildRunTrace,
    summarizeTraceQuality,
    isTerminalOutcome,
} = require('../services/run-trace');

const fullRun = (over = {}) => ({
    dispatchId: 'disp-1',
    executor: 'claude-code',
    model: 'claude-opus-5',
    outcome: 'success',
    tokens: 48200,
    tokensEstimated: false,
    attempts: { attempt: 2, priorAttempts: 1 },
    approvals: [{ kind: 'verification', verdict: 'verified' }],
    approvalChannelReadable: true,
    error: null,
    guardrails: [],
    ...over,
});

describe('the adopted field list', () => {
    it('is exactly the eight fields the source names, in order', () => {
        expect(RUN_TRACE_FIELDS.map((f) => f.key)).toEqual([
            'runId', 'agentVersion', 'modelCalls', 'toolCalls',
            'retries', 'approvals', 'errors', 'finalOutcome',
        ]);
    });

    it('requires every field, including the two nothing records yet', () => {
        expect(REQUIRED_FIELD_KEYS).toHaveLength(8);
        const uninstrumented = RUN_TRACE_FIELDS.filter((f) => !f.instrumented).map((f) => f.key);
        expect(uninstrumented).toEqual(['modelCalls', 'toolCalls']);
        // Still required: dropping them would redefine "complete" as
        // "complete for what we happen to store".
        for (const key of uninstrumented) {
            expect(RUN_TRACE_FIELDS.find((f) => f.key === key).required).toBe(true);
        }
    });
});

describe('buildRunTrace', () => {
    it('reports a fully-telemetered terminal run at the fleet ceiling of 6 of 8', () => {
        const trace = buildRunTrace(fullRun());
        expect(trace.terminal).toBe(true);
        expect(trace.completeness).toMatchObject({ requiredFields: 8, observedFields: 6, ratio: 0.75, pending: false });
        expect(trace.completeness.missing).toEqual([
            { field: 'modelCalls', reason: 'not_instrumented' },
            { field: 'toolCalls', reason: 'not_instrumented' },
        ]);
    });

    it('never satisfies modelCalls from the token total, but carries it as evidence', () => {
        const trace = buildRunTrace(fullRun());
        expect(trace.fields.modelCalls.known).toBe(false);
        expect(trace.fields.modelCalls.reason).toBe('not_instrumented');
        // The total is present, under the unknown, and clearly not the field.
        expect(trace.fields.modelCalls.evidence).toEqual({ tokensTotal: 48200, tokensEstimated: false });
    });

    it('does not accept the executor name as a version', () => {
        const trace = buildRunTrace(fullRun({ model: null }));
        expect(trace.fields.agentVersion.known).toBe(false);
        expect(trace.fields.agentVersion.reason).toBe('not_recorded');
        // The executor is still reported, just not as the version.
        expect(trace.fields.agentVersion.evidence).toEqual({ executor: 'claude-code' });
        expect(trace.completeness.observedFields).toBe(5);
    });

    it('marks the harness build as an explicit gap on an observed version', () => {
        expect(buildRunTrace(fullRun()).fields.agentVersion.value).toEqual({
            model: 'claude-opus-5', executor: 'claude-code', harnessVersion: null,
        });
    });

    it('distinguishes "no retries" from "no retry telemetry"', () => {
        const first = buildRunTrace(fullRun({ attempts: { attempt: 1, priorAttempts: 0 } }));
        expect(first.fields.retries).toEqual({ known: true, value: { attempt: 1, priorAttempts: 0 } });
        // A caller holding only a display page cannot know the attempt number.
        const paged = buildRunTrace(fullRun({ attempts: null }));
        expect(paged.fields.retries.known).toBe(false);
        expect(paged.fields.retries.reason).toBe('not_recorded');
    });

    it('treats an empty but readable channel as a measurement, not a gap', () => {
        const noVerdict = buildRunTrace(fullRun({ approvals: [], approvalChannelReadable: true }));
        expect(noVerdict.fields.approvals).toEqual({ known: true, value: [] });
        const noError = buildRunTrace(fullRun({ error: null, guardrails: [] }));
        expect(noError.fields.errors).toEqual({ known: true, value: { message: null, guardrails: [] } });
        // Both still count toward completeness.
        expect(noVerdict.completeness.observedFields).toBe(6);
    });

    it('reports an unreadable approval channel as unseen rather than empty', () => {
        const trace = buildRunTrace(fullRun({ approvalChannelReadable: false }));
        expect(trace.fields.approvals).toMatchObject({ known: false, reason: 'spine_unavailable' });
        expect(trace.completeness.observedFields).toBe(5);
    });

    it('lets a surface say which channel IT did not read', () => {
        const trace = buildRunTrace(fullRun({
            approvalChannelReadable: false, approvalChannelReason: 'not_queried',
        }));
        expect(trace.fields.approvals.reason).toBe('not_queried');
    });

    it('does not score a run that is still in flight', () => {
        const trace = buildRunTrace(fullRun({ outcome: 'running' }));
        expect(trace.terminal).toBe(false);
        expect(trace.fields.finalOutcome).toMatchObject({ known: false, reason: 'run_in_flight' });
        // A trace still being written is not a badly-traced run.
        expect(trace.completeness.ratio).toBeNull();
        expect(trace.completeness.pending).toBe(true);
    });

    it('collapses an activity with no run behind it to one honest reason', () => {
        const trace = buildRunTrace({ dispatchMatched: false });
        expect(trace.completeness.missing).toHaveLength(8);
        for (const m of trace.completeness.missing) expect(m.reason).toBe('no_dispatch_match');
        // Not a zero score on a real run: a different fact entirely.
        expect(trace.completeness.ratio).toBeNull();
    });

    it('survives an empty input without inventing values', () => {
        const trace = buildRunTrace();
        expect(trace.completeness.observedFields).toBe(1); // errors: readable and empty
        for (const key of ['runId', 'agentVersion', 'retries', 'finalOutcome']) {
            expect(trace.fields[key].known).toBe(false);
        }
    });

    it('recognises every terminal outcome the board writes', () => {
        for (const o of ['success', 'failure', 'timeout', 'needs_input', 'cancelled']) {
            expect(isTerminalOutcome(o)).toBe(true);
        }
        expect(isTerminalOutcome('running')).toBe(false);
        expect(isTerminalOutcome(null)).toBe(false);
    });
});

describe('summarizeTraceQuality', () => {
    const terminal = (over) => buildRunTrace(fullRun(over));

    it('scores completeness over finished runs only, and counts the rest separately', () => {
        const q = summarizeTraceQuality([
            terminal(), terminal(), terminal({ outcome: 'running' }),
        ], {});
        expect(q).toMatchObject({ runs: 3, terminalRuns: 2, inFlightRuns: 1 });
        const audit = q.controlEffectiveness.auditTraceCompleteness;
        expect(audit.mean).toBe(0.75);
        expect(audit.scoredRuns).toBe(2);
        expect(audit.uninstrumentedFields).toEqual(['modelCalls', 'toolCalls']);
        expect(audit.missingByField).toEqual({ modelCalls: 2, toolCalls: 2 });
    });

    it('reports the human measures as uninstrumented and names the reviewer stand-in', () => {
        const q = summarizeTraceQuality([terminal()], {
            reviewerRejections: 1, reviewerCorrections: 1, adjudicatedRuns: 4,
        });
        expect(q.decisionQuality.humanRejection).toMatchObject({
            rate: null, known: false, reason: 'not_instrumented', nearest: 'reviewerRejection',
        });
        expect(q.decisionQuality.humanCorrection.nearest).toBe('reviewerCorrection');
        // The measure that IS observed carries its own denominator.
        expect(q.decisionQuality.reviewerRejection).toEqual({
            rejections: 1, adjudicatedRuns: 4, rate: 0.25,
        });
    });

    it('returns null, not zero, for a rate with no denominator', () => {
        const q = summarizeTraceQuality([terminal()], {
            reviewerRejections: 0, reviewerCorrections: 0, adjudicatedRuns: null,
        });
        // A task no reviewer ever saw has no rejection rate.
        expect(q.decisionQuality.reviewerRejection).toMatchObject({ rate: null, known: false });
        expect(summarizeTraceQuality([], {}).decisionQuality.taskSuccess.rate).toBeNull();
    });

    it('refuses to report zero approval violations it cannot measure', () => {
        const q = summarizeTraceQuality([terminal()], {});
        expect(q.controlEffectiveness.approvalViolations).toMatchObject({ count: null, known: false, reason: 'not_instrumented' });
    });

    it('computes task success and escalation over terminal runs', () => {
        const q = summarizeTraceQuality([
            terminal(), terminal({ outcome: 'failure' }), terminal({ outcome: 'needs_input' }),
        ], {});
        expect(q.decisionQuality.taskSuccess).toEqual({ successes: 1, terminalRuns: 3, rate: 0.333 });
        // needs_input is the fleet's escalation: the run stopped for a human.
        expect(q.executionReliability.escalationRate).toEqual({ escalations: 1, terminalRuns: 3, rate: 0.333 });
    });

    it('measures retry rate only over the runs whose depth was actually known', () => {
        const q = summarizeTraceQuality([
            terminal({ attempts: { attempt: 1, priorAttempts: 0 } }),
            terminal({ attempts: { attempt: 2, priorAttempts: 1 } }),
            terminal({ attempts: null }),
        ], {});
        expect(q.executionReliability.retryRate).toEqual({ retriedRuns: 1, measuredRuns: 2, rate: 0.5 });
    });

    it('points at the existing cost surface instead of producing a rival figure', () => {
        const q = summarizeTraceQuality([terminal()], {});
        expect(q.operationalPerformance).toMatchObject({ known: false, reason: 'reported_elsewhere' });
    });
});
