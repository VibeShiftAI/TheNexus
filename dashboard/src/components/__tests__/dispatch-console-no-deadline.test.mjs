import test from 'node:test';
import assert from 'node:assert/strict';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {formatCeiling} from '../../lib/dispatch-insight.ts';
import {TaskDispatchConsole} from '../task-view/dispatch-console.tsx';

/**
 * Since the 2026-11-13 removal of elapsed-time limits, Praxis writes
 * timeoutMs 0 (policy "disabled") on every detached-run record, and the
 * insight API reports such a live run as ceiling { ms: null,
 * source: 'praxis_run_record' }. The console must say the run has no
 * deadline, never render a dash or "over ceiling" for it.
 */

test('formatCeiling names a missing deadline and formats a real one', () => {
  assert.equal(formatCeiling({ms: null, source: 'praxis_run_record'}), 'no deadline');
  assert.equal(formatCeiling({ms: 3 * 60 * 60 * 1000, source: 'default_assumed'}), '3h');
});

const startedAt = new Date(Date.now() - 4 * 3600_000).toISOString();
const dispatch = {
  id: 'd-live', task_id: 't1', project_id: null, kind: 'dispatch', parent_id: null,
  executor: 'claude-code', model: 'claude-opus-5', tokens: null, tokens_estimated: 0,
  prompt: null, instructions: null, output: null, error: null, outcome: 'running',
  session_id: null, workspace: null, log_path: null, started_at: startedAt, completed_at: null,
};
const noDeadline = {ms: null, source: 'praxis_run_record'};
const insight = {
  taskId: 't1', ceiling: noDeadline,
  scheduleEstimateMinutes: null, spineAvailable: true, praxisReachable: true,
  latestVerification: null,
  usageRollup: {totalRuns: 1, pricedRuns: 0, unknownRuns: 1, unknownByReason: {no_token_record: 1},
    estimatedUsd: null, estimated: true, coverage: 0},
  runs: [{
    dispatchId: 'd-live', executor: 'claude-code', model: 'claude-opus-5', outcome: 'running',
    startedAt, completedAt: null, elapsedMs: 4 * 3600_000, ceiling: noDeadline, overdue: false,
    cost: null, tokens: null, tokensEstimated: false, usageUnknown: null,
    verification: null, guardrails: [], canKill: true,
  }],
};

test('a live run with no deadline reads as "no deadline", never as a dash or overdue', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/dispatch-insight/task/')) return new Response(JSON.stringify(insight), {status: 200});
    if (u.includes('/api/dispatches')) return new Response(JSON.stringify({dispatches: [dispatch]}), {status: 200});
    return new Response(JSON.stringify({}), {status: 200});
  };
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => {
      root.render(React.createElement(TaskDispatchConsole, {taskId: 't1', projectId: null}));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const text = node.textContent;
    assert.match(text, /Ceiling\s*no deadline \(live run record\)/);
    assert.doesNotMatch(text, /over ceiling/);
    // formatMs renders a non-finite value as an em dash; it must not appear.
    assert.doesNotMatch(text, /Ceiling\s*— \(/);
  } finally {
    await act(async () => root.unmount());
    node.remove();
    globalThis.fetch = oldFetch;
  }
});
