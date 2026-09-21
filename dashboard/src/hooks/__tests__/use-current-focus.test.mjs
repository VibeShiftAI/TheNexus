import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { useCurrentFocus, FOCUS_TICK_MS } from '../use-current-focus';

// QA finding 2026-09-20: the shared board and dispatch stores keep the last
// good snapshot by reference while their pollers fail, so a memo keyed only on
// snapshot references froze freshness. A "Testing" row stayed fresh for the
// whole outage. This drives the real hook against stubbed fetches and a mocked
// clock: after the feeds fail and time passes, the row must fall back to
// Running with a reason, be marked stale, and keep its recorded lifecycle.
test('freshness keeps advancing during a feed outage after an initially good snapshot', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: Date.parse('2026-09-07T13:00:00Z') });
  const state = { executors: { runs: [{ taskId: 'a', title: 'Improve cards', executor: 'codex', kind: 'task', phase: 'testing', status: 'active', startedAt: '2026-09-07T12:55:00Z', updatedAt: '2026-09-07T12:59:00Z' }], usageWaits: { available: true, items: [] } } };
  const projects = [{ id: 'p1', name: 'Meeple Magnate', tasks: [{ id: 'a', name: 'Improve cards', status: 'in_progress' }] }];
  let failing = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (failing) throw new Error('feed down');
    const body = String(url).includes('dispatch-state') ? state : projects;
    return { ok: true, status: 200, json: async () => body };
  };
  const noRequests = [];
  const noRefresh = async () => {};
  let latest = null;
  function Probe() { latest = useCurrentFocus(noRequests, null, noRefresh); return null; }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const before = latest.view.groups[0].items[0];
    assert.equal(before.stage, 'Testing');
    assert.equal(before.stale, false);
    assert.equal(before.evidence.phase.value, 'testing');

    failing = true;
    await act(async () => { mock.timers.tick(7 * 60_000); await Promise.resolve(); await Promise.resolve(); });
    const after = latest.view.groups[0].items[0];
    assert.equal(after.status, 'running', 'the last reported state stays visible');
    assert.equal(after.stage, 'Running');
    assert.equal(after.stale, true);
    assert.equal(after.evidence.phase.value, null);
    assert.match(after.evidence.phase.reason, /Run feed has not refreshed since 13:00 UTC/);
    assert.match(after.evidence.phase.reason, /Testing, 12:59 UTC/);
    assert.deepEqual({ run: after.lifecycle.run, runPhase: after.lifecycle.runPhase, board: after.lifecycle.board }, { run: 'active', runPhase: 'testing', board: 'in_progress' });
    assert.ok(latest.errors.some((e) => /Run and queue data could not refresh/.test(e)));

    // With the feeds healthy again but no new report, the clock alone must
    // still retire a phase report that has passed the freshness window.
    failing = false;
    await act(async () => { mock.timers.tick(FOCUS_TICK_MS); await Promise.resolve(); await Promise.resolve(); });
    const recovered = latest.view.groups[0].items[0];
    assert.equal(recovered.stage, 'Running');
    assert.match(recovered.evidence.phase.reason, /No phase report in the last 5 min/);
  } finally {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});

test('clock alone expires activity while subsequent fetches remain pending', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: Date.parse('2026-09-07T13:00:00Z') });
  const state = { executors: { runs: [{ taskId: 'a', title: 'Improve cards', executor: 'codex', phase: 'testing', status: 'active', startedAt: '2026-09-07T12:55:00Z', updatedAt: '2026-09-07T12:59:00Z' }], usageWaits: { available: true, items: [] } } };
  const projects = [{ id: 'p1', name: 'Project', tasks: [{ id: 'a', name: 'Improve cards', status: 'in_progress' }] }];
  const originalFetch = globalThis.fetch;
  let pending = false;
  const releases = [];
  globalThis.fetch = async (url) => {
    if (pending) await new Promise(resolve => releases.push(resolve));
    return { ok: true, status: 200, json: async () => String(url).includes('dispatch-state') ? state : projects };
  };
  const requests = [];
  const refreshInput = async () => {};
  let latest;
  function Probe() { latest = useCurrentFocus(requests, null, refreshInput); return null; }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Probe)); });
    const before = latest;
    assert.equal(before.view.groups[0].items[0].stage, 'Testing');
    pending = true;
    await act(async () => { void latest.refresh(); });
    assert.ok(releases.length >= 2, 'both pollers are waiting on unresolved fetches');
    assert.strictEqual(latest.view, before.view, 'no data or error dependency has changed');
    await act(async () => { mock.timers.tick(6 * 60_000); });
    const item = latest.view.groups[0].items[0];
    assert.equal(latest.updatedAt, before.updatedAt);
    assert.deepEqual(latest.errors, before.errors);
    assert.notStrictEqual(latest.view, before.view);
    assert.equal(item.stage, 'Running');
    assert.equal(item.stale, true);
    assert.equal(item.evidence.phase.value, null);
    assert.match(item.evidence.phase.reason, /No phase report in the last 5 min/);
    assert.equal(item.lifecycle.runPhase, 'testing');
  } finally {
    act(() => root.unmount());
    await act(async () => { releases.forEach(resolve => resolve()); });
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});
