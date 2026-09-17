import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeActivityProvider } from '../bridge/activity-provider.tsx';
import { DispatchStation } from '../bridge/dispatch-station.tsx';
import { refreshDispatchState } from '../../hooks/use-dispatch-state.ts';

test('Ops stays live between clock ticks and reflects changed dispatch status', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-09-08T14:00:00Z') });
  const originalFetch = globalThis.fetch;
  let phase = 'testing';
  globalThis.fetch = async (url) => ({ ok: true, json: async () => {
    const path = String(url);
    if (path.includes('dispatch-state')) return {
      executors: { runs: [{ taskId: 'ops-refresh', title: 'Refresh regression', executor: 'codex', kind: 'task', phase, status: 'active', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] },
    };
    if (path.includes('council/sessions')) return { sessions: [] };
    if (path.includes('council/benches')) return { benches: [] };
    if (path.includes('board')) return [];
    return {};
  } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BridgeActivityProvider, null, createElement(DispatchStation))));
    const map = container.querySelector('.dispatch-map');
    assert.equal(map.dataset.live, 'true');
    assert.match(map.textContent, /testing/);
    const before = map.textContent;
    t.mock.timers.setTime(Date.now() + 500);
    await act(async () => refreshDispatchState());
    assert.equal(map.dataset.live, 'true', 'a fresh response must not blank Ops');
    assert.equal(map.textContent, before);
    phase = 'reviewing';
    await act(async () => refreshDispatchState());
    assert.match(map.textContent, /reviewing/);
    // A stalled request must still let the last successful snapshot expire.
    globalThis.fetch = () => new Promise(() => {});
    t.mock.timers.setTime(Date.now() + 46_000);
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(map.dataset.live, 'false');
  } finally {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    t.mock.timers.reset();
  }
});
