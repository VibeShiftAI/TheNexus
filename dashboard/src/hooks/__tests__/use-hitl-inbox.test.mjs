import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useHitlInbox } from '../use-hitl-inbox.ts';
import { LiveBoardStateProvider } from '../../components/live-board-state.tsx';
import { __setPraxisStreamStoreForTests } from '../use-praxis-stream.ts';
const request = { id: 'q1', question: 'Approve?', reason: 'explicit_request', requestedAt: '2026-10-06T00:00:00Z' };
async function fixture(fetcher) {
  const original = globalThis.fetch; globalThis.fetch = fetcher;
  let state; function Harness() { state = useHitlInbox(); return null; }
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  await act(async () => root.render(React.createElement(Harness)));
  return { get state() { return state; }, async close() { await act(async () => root.unmount()); el.remove(); globalThis.fetch = original; } };
}
test('a delayed snapshot cannot resurrect a successfully answered question', async () => {
  let reads = 0, finish;
  const f = await fixture(async (url, init) => {
    if (init?.method === 'POST') return Response.json({ request: { ...request, resolution: { choice: 'approve', resolvedAt: '2026-10-06T01:00:00Z' } } });
    if (++reads === 1) return Response.json({ requests: [request] });
    return new Promise(resolve => { finish = resolve; });
  });
  try {
    assert.equal(f.state.pendingRequests.length, 1);
    let pending; await act(async () => { pending = f.state.refresh(); });
    assert.equal(f.state.refreshing, true);
    assert.equal(f.state.loading, false, 'background refresh preserves mounted answer cards');
    await act(async () => f.state.resolveRequest('q1', { choice: 'approve' }));
    assert.equal(f.state.pendingRequests.length, 0);
    await act(async () => { finish(Response.json({ requests: [request] })); await pending; });
    assert.equal(f.state.pendingRequests.length, 0);
  } finally { await f.close(); }
});
test('a refresh after an error stays explicitly loading while the request is unsettled', async () => {
  let reads = 0, finish;
  const f = await fixture(async () => {
    if (++reads === 1) return new Response('', { status: 503 });
    return new Promise(resolve => { finish = resolve; });
  });
  try {
    assert.match(f.state.error, /503/);
    let pending; await act(async () => { pending = f.state.refresh(); });
    assert.equal(f.state.refreshing, true);
    await act(async () => { finish(Response.json({ requests: [] })); await pending; });
    assert.equal(f.state.refreshing, false);
  } finally { await f.close(); }
});

test('mounting under a retained HITL frame still loads unrelated pending requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const original = globalThis.fetch;
  const other = { ...request, id: 'unrelated-question' };
  globalThis.fetch = async () => Response.json({ requests: [other] });
  try {
    for (const event of [
      { type: 'hitl.resolved', requestId: request.id, resolution: { choice: 'done' } },
      { type: 'hitl.created', request },
    ]) {
      const snapshot = { connected: false, presence: null, recentEvents: [{ ...event, eventId: event.type, at: new Date().toISOString() }] };
      __setPraxisStreamStoreForTests({ subscribe: () => () => {}, getSnapshot: () => snapshot, getServerSnapshot: () => snapshot });
      let state; function Harness() { state = useHitlInbox(); return null; }
      const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
      try {
        await act(async () => root.render(React.createElement(LiveBoardStateProvider, null, React.createElement(Harness))));
        assert.equal(state.pendingRequests.some(item => item.id === other.id), true, event.type);
        assert.equal(state.refreshing, false);
      } finally { await act(async () => root.unmount()); el.remove(); t.mock.timers.tick(6000); }
    }
  } finally { __setPraxisStreamStoreForTests(null); globalThis.fetch = original; }
});
