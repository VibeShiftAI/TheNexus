import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeActivityProvider } from '../bridge/activity-provider.tsx';
import { DispatchStation } from '../bridge/dispatch-station.tsx';
import { useCrewActivity } from '../../hooks/use-crew-activity.ts';
import { refreshDispatchState } from '../../hooks/use-dispatch-state.ts';

const now = Date.parse('2026-11-25T04:20:00Z');
const startedAt = new Date(now - 24_000).toISOString();

function CrewReadout() {
  const member = useCrewActivity().crew.find(m => m.id === 'local-llm');
  return createElement('output', { 'data-state': member.state }, member.detail);
}

test('the bridge and open local drill-down follow named runs, item lanes, gaps and direct callers', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const run = {
    id: 'overnight', type: 'ingest_item', name: 'Knowledge ingestion',
    finished: 90, total: 396, queued: 304, running: 2, allowedNow: true,
    items: [
      { id: 'a', type: 'ingest_item', name: 'Ingest source', sourceTitle: 'Paper A', executionLane: 'local', startedAt },
      { id: 'b', type: 'ingest_item', name: 'Ingest source', sourceTitle: 'Paper B', executionLane: 'spillover', startedAt },
    ],
  };
  const worker = { paused: false };
  const sweep = { ...run, id: 'sweep', name: 'Conversation sweep', running: 0, items: [],
    finished: 0, total: 1, queued: 1, allowedNow: false, waitReason: 'scheduled for tomorrow' };
  let queue = { worker, runs: [run, sweep] };
  const lmStudio = { reachable: true, lastActivityAt: new Date(now).toISOString(),
    models: [{ id: 'gemma', type: 'llm', state: 'loaded' }, { id: 'embed', type: 'embeddings', state: 'loaded' }] };
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => {
    const path = String(url);
    if (path.includes('dispatch-state')) return { localLlm: queue, lmStudio };
    if (path.includes('council/sessions')) return { sessions: [] };
    if (path.includes('council/benches')) return { benches: [] };
    if (path.includes('board')) return [];
    return {};
  } }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => { act(() => root.unmount()); container.remove(); });

  await act(async () => root.render(createElement(BridgeActivityProvider, null,
    createElement(DispatchStation), createElement(CrewReadout))));
  const indicator = container.querySelector('.dispatch-local');
  const crew = container.querySelector('output');
  assert.match(indicator.textContent, /Knowledge ingestion.*90 of 396 finished/);
  assert.equal(crew.dataset.state, 'active');
  assert.match(crew.textContent, /Knowledge ingestion.*90 of 396 finished/);
  await act(async () => indicator.click());
  const dialog = document.querySelector('[role="dialog"]');
  const activity = dialog.querySelector('[aria-label="Local model activity"]');
  assert.match(activity.textContent, /Conversation sweep.*0 of 1 finished.*scheduled for tomorrow/i);
  assert.match(activity.textContent, /2 running.*1 local.*1 CLI spillover.*304 queued/);
  const items = activity.querySelectorAll('li');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Ingest source.*Paper A.*gemma.*24s/);
  assert.match(items[1].textContent, /Ingest source.*Paper B.*CLI spillover.*24s/);
  assert.doesNotMatch(items[1].textContent, /gemma/);
  assert.match(dialog.querySelector('[title="embed"]').parentElement.textContent, /resident/);

  const gap = { ...run, running: 0, items: [], finished: 92 };
  queue = { worker, runs: [gap] };
  await act(refreshDispatchState);
  assert.match(indicator.textContent, /92 of 396 finished.*between items/i);
  assert.match(activity.textContent, /92 of 396 finished.*between items/i);
  assert.equal(indicator.dataset.active, 'true');
  assert.doesNotMatch(activity.textContent, /Paper A|direct traffic/i);

  queue = { worker, runs: [{ ...gap, allowedNow: false, waitReason: 'outside local window' }] };
  lmStudio.lastActivityAt = null;
  await act(refreshDispatchState);
  assert.match(activity.textContent, /waiting.*outside local window/i);
  assert.equal(indicator.dataset.active, 'false');
  assert.equal(crew.dataset.state, 'idle');

  queue = { worker, runs: [], directCallers: ['gateway.reader'] };
  await act(refreshDispatchState);
  assert.match(indicator.textContent, /direct traffic.*gateway.reader/i);
  assert.match(activity.textContent, /direct traffic.*gateway.reader/i);

  // Older producers publish sampled jobs without lane or run totals.
  queue = { worker, jobs: [{ id: 'old', type: 'custom_job', status: 'running', payload: { title: 'Legacy source' } }] };
  await act(refreshDispatchState);
  assert.match(indicator.textContent, /Custom job.*total not reported/i);
  assert.match(activity.textContent, /Legacy source.*lane not reported.*start time not reported/i);
  assert.equal(indicator.dataset.active, 'false');
});
