import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { resolveUsageSource } from '../../lib/usage-source.ts';
import { CommitRow } from '../activity-feed.tsx';
import { NowStrip } from '../bridge/now-strip.tsx';
import { ActivityReport } from '../project-brief/activity-report.tsx';
import { MissionBrief } from '../project-brief/mission-brief.tsx';
import { RoutingEconomicsPanel } from '../routing-economics-panel.tsx';
import economics from '../../../../server/services/routing-economics.js';

/**
 * Task 50e55c47: every cockpit surface that shows a token or cost figure
 * renders an estimate with a visible "est" marker and a missing figure as
 * "unavailable", never a bare number or a zero. The server marks each figure
 * (server/services/usage-source.js); these render each surface from that
 * marker. The task detail console is covered in usage-missing-attribution.
 */

async function mount(element, fetchImpl) {
  const originalFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(element));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return {
    text: () => node.textContent,
    dispose: async () => { await act(async () => root.unmount()); node.remove(); globalThis.fetch = originalFetch; },
  };
}

test('resolveUsageSource prefers the server marker and never reads a missing figure as a number', () => {
  assert.equal(resolveUsageSource(10, 'estimated', false), 'estimated');
  assert.equal(resolveUsageSource(10, 'measured', true), 'measured');
  assert.equal(resolveUsageSource(10, undefined, 1), 'estimated');
  assert.equal(resolveUsageSource(10, undefined, 0), 'measured');
  assert.equal(resolveUsageSource(10, undefined, undefined), 'unknown');
  assert.equal(resolveUsageSource(null, 'measured', 0), 'unavailable');
  assert.equal(resolveUsageSource(0, 'measured'), 'measured'); // a recorded zero is a measurement
});

// ── Recent Activity Feed ──────────────────────────────────────────────────
const commit = (over) => ({
  projectId: 'p1', projectName: 'TheNexus', type: 'commit', hash: 'abc1234def', message: 'Work',
  author: 'Praxis', date: new Date().toISOString(), model: 'claude-opus-5', modelInferred: false,
  tokens: 9000, tokensEstimated: false, tokensSource: 'measured', dispatchId: null, taskId: null, runTrace: null, ...over,
});

for (const [name, over, expected, forbidden] of [
  ['measured', {}, /9\.0k/, /est|unavailable/],
  ['estimated', { tokensEstimated: true, tokensSource: 'estimated' }, /~9\.0kest/, /unavailable/],
  ['unknown provenance', { tokensSource: 'unknown' }, /9\.0ksource unknown/, /~/],
  ['unavailable', { tokens: null, tokensSource: 'unavailable' }, /unavailable/, /—|\b0\b/],
]) {
  test(`activity feed: the ${name} token figure renders with its source`, async () => {
    const h = await mount(React.createElement(CommitRow, { commit: commit(over), onOpenLogs: () => {} }));
    try {
      assert.match(h.text(), expected);
      assert.doesNotMatch(h.text(), forbidden);
    } finally { await h.dispose(); }
  });
}

// ── Now strip ─────────────────────────────────────────────────────────────
const activeFetch = (dispatch) => async (url) => ({
  ok: true,
  json: async () => (String(url).includes('/api/dispatches/active') ? { active: [dispatch] } : {}),
});
const active = (over) => ({
  id: 'd1', taskId: 'task-1', projectId: 'p1', executor: 'claude-code', kind: 'task', model: 'claude-opus-5',
  tokens: 12_345, tokensEstimated: false, tokensSource: 'measured', tokensCountedRuns: 2, tokensTotalRuns: 2,
  title: 'A task', startedAt: new Date().toISOString(), ...over,
});

test('now strip: an estimated task total carries a visible est tag', async () => {
  const h = await mount(React.createElement(NowStrip), activeFetch(active({ tokensEstimated: true, tokensSource: 'estimated' })));
  try { assert.match(h.text(), /~12\.3kest/); } finally { await h.dispose(); }
});

test('now strip: a measured task total carries no estimate tag', async () => {
  const h = await mount(React.createElement(NowStrip), activeFetch(active()));
  try {
    assert.match(h.text(), /12\.3k/);
    assert.doesNotMatch(h.text(), /~|est\b/);
  } finally { await h.dispose(); }
});

test('now strip: a running task with no usage yet reads unavailable, not a dash or zero', async () => {
  const h = await mount(React.createElement(NowStrip),
    activeFetch(active({ tokens: null, tokensSource: 'unavailable', tokensCountedRuns: 0, tokensTotalRuns: 1 })));
  try {
    assert.match(h.text(), /unavailable/);
    assert.doesNotMatch(h.text(), /—$/);
  } finally { await h.dispose(); }
});

// ── Mission brief + ops log (project pulse) ──────────────────────────────
const project = { id: 'p1', name: 'TheNexus', status: 'active', description: null, tags: [] };
const brief = (crew, opsLog = []) => ({
  projectId: 'p1', lastActivityAt: new Date().toISOString(),
  git: { hasCommits: false, series: [], total: 0 },
  tasks: { active: 0, activeNames: [], queued: 0, attention: 0, review: 0, done7d: 0, total: 0 },
  crew, opsLog,
});
const crew = (over) => ({
  running: 0, last: null, dispatches7d: 4, tokensCounted7d: 4, tokensEstimated: false,
  tokens7d: 40_000, tokens24h: 5_000, tokens7dSource: 'measured', tokens24hSource: 'measured', ...over,
});

test('mission brief: an estimated 24h figure is tagged even when the 7d label is not', async () => {
  const h = await mount(React.createElement(MissionBrief, {
    project, brief: brief(crew({ tokens24hSource: 'estimated', tokens7dSource: 'estimated', tokensEstimated: true })),
  }));
  try {
    assert.match(h.text(), /Tokens · 7d \(est\)/);
    assert.match(h.text(), /~5\.0k est in 24h/);
  } finally { await h.dispose(); }
});

// The payload project-pulse now sends for measured plus unflagged runs with
// no estimate: tokensEstimated stays false, so only the marker carries it.
test('mission brief: unknown-source usage keeps "source unknown" with no estimated run', async () => {
  const h = await mount(React.createElement(MissionBrief, {
    project, brief: brief(crew({ tokens7dSource: 'unknown', tokens24hSource: 'unknown', tokensEstimated: false })),
  }));
  try {
    assert.match(h.text(), /Tokens · 7d \(source unknown\)/);
    assert.match(h.text(), /5\.0k source unknown in 24h/);
    assert.doesNotMatch(h.text(), /\best\b/);
  } finally { await h.dispose(); }
});

test('mission brief: a null 7d sum reads unavailable', async () => {
  const h = await mount(React.createElement(MissionBrief, {
    project,
    brief: brief(crew({ tokensCounted7d: 0, tokens7d: null, tokens24h: null, tokens7dSource: 'unavailable', tokens24hSource: 'unavailable' })),
  }));
  try {
    assert.match(h.text(), /Tokens · 7dunavailable/);
  } finally { await h.dispose(); }
});

test('ops log: dispatch tokens show est, source unknown, or unavailable; never a bare guess', async () => {
  const at = new Date().toISOString();
  const ev = (title, tokens, tokensSource) => ({ type: 'dispatch', at, title, meta: 'codex', outcome: 'success', tokens, tokensSource });
  const h = await mount(React.createElement(ActivityReport, {
    brief: brief(crew(), [
      ev('measured run', 1_200, 'measured'),
      ev('estimated run', 9_000, 'estimated'),
      ev('unflagged run', 300, 'unknown'),
      ev('silent run', null, 'unavailable'),
    ]),
  }));
  try {
    assert.match(h.text(), /1\.2k tok/);
    assert.match(h.text(), /~9\.0k tok est/);
    assert.match(h.text(), /300 tok source unknown/);
    assert.match(h.text(), /tok unavailable/);
  } finally { await h.dispose(); }
});

// ── Routing economics ─────────────────────────────────────────────────────
const row = (id, over) => ({ id, task_id: 'task-a', executor: 'codex', model: 'gpt-5.6-sol', tokens: 1e6, tokens_estimated: 0,
  outcome: 'success', started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:00:10Z', ...over });
const economicsFetch = (data) => async () => ({ ok: true, json: async () => data });

test('routing economics: a token sum with any estimated run is tagged est; a missing one reads unavailable', async () => {
  const data = economics.aggregateRoutingEconomics([
    row('a', { tokens_estimated: 1 }),
    row('b', { model: 'gpt-5.5', executor: 'codex', tokens: null }),
  ]);
  const h = await mount(React.createElement(RoutingEconomicsPanel), economicsFetch(data));
  try {
    assert.match(h.text(), /~1,000,000 est/);
    assert.match(h.text(), /Unavailable/);
    assert.match(h.text(), /Cost unavailable/);
  } finally { await h.dispose(); }
});
