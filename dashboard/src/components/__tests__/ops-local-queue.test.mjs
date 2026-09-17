import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OpsLocalQueue } from '../ops-local-queue.tsx';

const now = '2026-09-10T10:00:00.000Z';
const job = (id, priority, extra = {}) => ({ id, type: 'ingest_item', payload: { title: `Article ${id}` }, status: 'queued', priority, createdAt: now, updatedAt: now, attempts: 0, maxAttempts: 3, ...extra });
const snapshot = (jobs = []) => ({ observedAt: now, lmStudio: { available: true, models: [{ id: 'gemma', name: 'Gemma', status: 'generating', queued: 3 }] }, background: { available: true, worker: { paused: false }, counts: {}, jobs } });

async function mount(t, getResponse) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url: String(url), options }); return getResponse(String(url), options); };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(OpsLocalQueue)));
  t.after(() => { act(() => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
  return { container, root, requests };
}
const ok = body => ({ ok: true, json: async () => body });

test('shows the native model queue even when no background jobs exist', async t => {
  const { container, requests } = await mount(t, () => ok(snapshot()));
  assert.match(requests[0].url, /\/api\/local-queue\/work/);
  assert.match(container.textContent, /3 requests waiting/);
  assert.match(container.textContent, /Gemma/);
  assert.match(container.textContent, /Generating/);
  assert.match(container.textContent, /No background jobs waiting/);
  assert.doesNotMatch(container.textContent, /No active jobs in local queue/);
});

test('renders all jobs in worker order with future jobs separate and finished jobs excluded', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const jobs = [job('scheduled', 0, { scheduledFor: '2026-09-11T10:00:00Z' }), job('low', 90), job('high', 1), job('running', 50, { status: 'running' }), job('finished', 0, { status: 'succeeded' }), ...Array.from({ length: 22 }, (_, i) => job(`middle-${i}`, 50))];
  const { container } = await mount(t, () => ok(snapshot(jobs)));
  const rows = [...container.querySelectorAll('[data-job-id]')];
  assert.equal(rows.length, 26);
  assert.equal(rows[0].dataset.jobId, 'running');
  assert.equal(rows[1].dataset.jobId, 'high');
  assert.equal(rows.at(-2).dataset.jobId, 'low');
  assert.equal(rows.at(-1).dataset.jobId, 'scheduled');
  assert.match(container.textContent, /Article high/);
  assert.match(container.textContent, /24 waiting/);
  assert.match(container.textContent, /Scheduled/);
  assert.doesNotMatch(container.textContent, /Article finished/);
});

test('unknown native counts are unavailable and a missing source is not an empty queue', async t => {
  const value = snapshot();
  value.lmStudio.models[0].queued = null;
  value.lmStudio.models[0].status = null;
  value.background = { available: false, jobs: [], counts: {}, worker: null, error: 'Background job queue unavailable.' };
  const { container } = await mount(t, () => ok(value));
  assert.match(container.textContent, /Waiting count unavailable/);
  assert.match(container.textContent, /Background job queue unavailable/);
  assert.doesNotMatch(container.textContent, /0 requests waiting|No background jobs waiting/);
  assert.equal(container.querySelector('[data-worker-toggle]').disabled, true);
});

test('refreshes live data and preserves the previous snapshot with a visible stale error', async t => {
  let fail = false;
  let value = snapshot();
  const { container, root } = await mount(t, () => fail ? Promise.reject(new Error('offline')) : ok(value));
  value = snapshot([job('new', 10)]);
  value.lmStudio.models[0].queued = 1;
  await act(async () => root.render(createElement(OpsLocalQueue, { refreshKey: 1 })));
  assert.match(container.textContent, /Article new/);
  assert.match(container.textContent, /1 request waiting/);
  fail = true;
  await act(async () => root.render(createElement(OpsLocalQueue, { refreshKey: 2 })));
  assert.match(container.textContent, /Article new/);
  assert.match(container.textContent, /Showing the last snapshot/);
});

test('worker pause failures are shown without claiming the worker paused', async t => {
  const { container, requests } = await mount(t, url => url.includes('/pause') ? { ok: false, status: 503, json: async () => ({ error: 'Praxis offline' }) } : ok(snapshot()));
  await act(async () => container.querySelector('[data-worker-toggle]').click());
  assert.match(container.textContent, /Praxis offline/);
  assert.match(container.querySelector('[data-worker-toggle]').textContent, /Pause background worker/);
  assert.ok(requests.some(r => r.options?.method === 'POST' && r.url.includes('/pause')));
});

test('a confirmed pause is not overwritten by an older poll', async t => {
  let deferNext = false;
  let finishOld;
  let value = snapshot();
  const { container, root } = await mount(t, (url, options) => {
    if (url.includes('/pause')) {
      assert.ok(options.signal, 'worker actions have a deadline');
      value = { ...snapshot(), background: { ...snapshot().background, worker: { paused: true } } };
      return ok({ worker: { paused: true } });
    }
    if (deferNext) { deferNext = false; return new Promise(resolve => { finishOld = resolve; }); }
    return ok(value);
  });
  deferNext = true;
  await act(async () => root.render(createElement(OpsLocalQueue, { refreshKey: 1 })));
  await act(async () => container.querySelector('[data-worker-toggle]').click());
  assert.match(container.querySelector('[data-worker-toggle]').textContent, /Resume background worker/);
  await act(async () => finishOld(ok(snapshot())));
  assert.match(container.querySelector('[data-worker-toggle]').textContent, /Resume background worker/);
});

test('polls the model queue every five seconds', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { container } = await mount(t, () => ok(snapshot()));
  globalThis.fetch = async () => ok({ ...snapshot(), lmStudio: { available: true, models: [{ id: 'gemma', name: 'Gemma', status: 'idle', queued: 0 }] } });
  await act(async () => t.mock.timers.tick(5000));
  assert.match(container.textContent, /Idle/);
  assert.match(container.textContent, /0 requests waiting/);
});

test('shows the unsent research backlog even when LM Studio has zero queued requests', async t => {
  const value = snapshot();
  value.lmStudio.models[0].queued = 0;
  value.evidence = { available: true, batch: {
    name: 'Morning research evidence extraction', date: '2026-09-10', total: 235, attempted: 44,
    complete: 35, partial: 6, failed: 3, remaining: 191, activity: 'processing', lastProgressAt: now,
    current: [{ index: 45, title: 'StudyBench', source: 'Research feed', startedAt: now }],
    waiting: Array.from({ length: 190 }, (_, i) => ({ index: i + 46, title: `Pending paper ${i + 46}`, source: 'Research feed' })),
  } };
  const { container } = await mount(t, () => ok(value));
  assert.match(container.textContent, /190 sources waiting in research batch/);
  assert.match(container.textContent, /44 of 235 sources attempted/);
  assert.match(container.textContent, /StudyBench/);
  assert.match(container.textContent, /35 complete · 6 partial · 3 failed/);
  assert.match(container.textContent, /Pending paper 235/);
  assert.match(container.textContent, /one source at a time/);
});

test('stale extraction progress is visibly unconfirmed', async t => {
  const value = snapshot();
  value.evidence = { available: true, batch: { name: 'Morning research evidence extraction', date: '2026-09-10', total: 1, attempted: 0, complete: 0, partial: 0, failed: 0, remaining: 1, current: [{ index: 1, title: 'Older source', startedAt: now }], waiting: [], activity: 'unconfirmed', lastProgressAt: now } };
  const { container } = await mount(t, () => ok(value));
  assert.match(container.textContent, /Live progress unconfirmed/);
  assert.match(container.textContent, /Last recorded source/);
  assert.doesNotMatch(container.textContent, /Processing source 1/);
});
