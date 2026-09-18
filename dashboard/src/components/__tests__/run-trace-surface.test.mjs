import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTraceCompleteness,
  describeTraceGaps,
  formatAuditCompleteness,
  describeCompletenessCeiling,
} from '../../lib/run-trace.ts';

/**
 * The run-trace field list on screen (contract: docs/contracts/run-trace.md).
 *
 * The whole point of the list is that an unobserved field reads differently
 * from an observed zero, so no formatter here may return a bare number: the
 * denominator and the reason travel with it. The two cases that look like a
 * bad score but are not, an in-flight run and an activity with no run behind
 * it, have to say what they are instead.
 */

const trace = (over = {}) => ({
  version: 1,
  terminal: true,
  fields: {},
  completeness: {
    requiredFields: 8,
    observedFields: 6,
    ratio: 0.75,
    pending: false,
    missing: [
      { field: 'modelCalls', reason: 'not_instrumented' },
      { field: 'toolCalls', reason: 'not_instrumented' },
    ],
    ...over,
  },
});

test('completeness always states the denominator', () => {
  assert.equal(formatTraceCompleteness(trace()), '6 of 8 trace fields');
  assert.equal(formatTraceCompleteness(null), 'no trace');
});

test('a run still in flight reads as in flight, not as badly traced', () => {
  const inFlight = trace({ observedFields: 5, ratio: null, pending: true, missing: [{ field: 'finalOutcome', reason: 'run_in_flight' }] });
  assert.equal(formatTraceCompleteness(inFlight), '5 of 8 trace fields (run in flight)');
});

test('an activity with no run behind it says so instead of scoring 0 of 8', () => {
  const noRun = trace({
    observedFields: 0,
    ratio: null,
    pending: true,
    missing: ['runId', 'agentVersion', 'modelCalls', 'toolCalls', 'retries', 'approvals', 'errors', 'finalOutcome']
      .map((field) => ({ field, reason: 'no_dispatch_match' })),
  });
  assert.equal(formatTraceCompleteness(noRun), 'no run to trace');
});

test('gaps are grouped by reason, so one cause is not read as several faults', () => {
  assert.equal(
    describeTraceGaps(trace()),
    'model calls, tool calls: nothing records it yet',
  );
  assert.equal(
    describeTraceGaps(trace({
      observedFields: 4,
      missing: [
        { field: 'modelCalls', reason: 'not_instrumented' },
        { field: 'toolCalls', reason: 'not_instrumented' },
        { field: 'retries', reason: 'not_recorded' },
        { field: 'approvals', reason: 'not_queried' },
      ],
    })),
    'model calls, tool calls: nothing records it yet · retries: this run left no record · approvals: not read by this surface',
  );
  assert.equal(describeTraceGaps(trace({ missing: [] })), '');
});

const quality = (over = {}) => ({
  controlEffectiveness: {
    auditTraceCompleteness: {
      mean: 0.75,
      scoredRuns: 12,
      requiredFields: 8,
      uninstrumentedFields: ['modelCalls', 'toolCalls'],
      missingByField: { modelCalls: 12, toolCalls: 12 },
      ...over,
    },
  },
});

test('the task-level figure carries the runs behind it', () => {
  assert.equal(
    formatAuditCompleteness(quality()),
    '75% mean trace completeness over 12 finished runs',
  );
  assert.equal(
    formatAuditCompleteness(quality({ scoredRuns: 1 })),
    '75% mean trace completeness over 1 finished run',
  );
});

test('no finished runs reports no score, never 0%', () => {
  assert.equal(
    formatAuditCompleteness(quality({ scoredRuns: 0, mean: null })),
    'no finished runs to score',
  );
  assert.equal(formatAuditCompleteness(null), 'no finished runs to score');
});

test('the ceiling imposed by fleet instrumentation is stated with the score', () => {
  assert.equal(
    describeCompletenessCeiling(quality()),
    'Nothing in the fleet records model calls and tool calls yet, so no run can score above 75%.',
  );
  // Once everything is instrumented there is no ceiling note to make.
  assert.equal(describeCompletenessCeiling(quality({ uninstrumentedFields: [] })), '');
});
