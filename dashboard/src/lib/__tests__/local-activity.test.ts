import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLocalActivity, type LocalActivityRun } from '../local-model';
import { deriveCurrentFocus } from '../current-focus';

const now = Date.parse('2026-11-25T04:16:00Z');
const lm = { reachable: true, models: [
  { id: 'embed', type: 'embeddings', state: 'loaded' },
  { id: 'gemma', type: 'llm', state: 'loaded' },
], lastActivityAt: new Date(now).toISOString() };
const item = { id: 'local', type: 'ingest_item', name: 'Knowledge ingestion',
  sourceTitle: 'An article', executionLane: 'local', startedAt: new Date(now - 24_000).toISOString(), localCallInFlight: true };
const run: LocalActivityRun = { id: 'ingest:overnight', type: item.type, name: item.name,
  finished: 90, total: 396, running: 2, queued: 305, allowedNow: true, waitReason: null,
  items: [item, { ...item, id: 'cli', executionLane: 'spillover', sourceTitle: null }] };
const worker = { paused: false };

test('a named run shows progress and attributes concurrent items to their own lanes', () => {
  const view = describeLocalActivity({ worker, runs: [run] }, lm, now);
  assert.match(view.summary, /Knowledge ingestion.*90 of 396 finished/);
  assert.equal(view.busy, true);
  assert.match(view.runs[0].items[0].description, /An article.*gemma.*24s/);
  assert.match(view.runs[0].items[1].description, /title not reported.*CLI spillover.*24s/i);
  assert.doesNotMatch(view.runs[0].items[1].description, /gemma/i);
  assert.match(view.runs[0].counts, /2 running.*1 local.*1 CLI spillover.*305 queued/);
});

test('a spillover item alone does not light up the local model', () => {
  const spill = { ...run, items: [run.items[1]], running: 1 };
  const view = describeLocalActivity({ worker, runs: [spill] }, lm, now);
  assert.equal(view.busy, false);
  assert.match(view.summary, /CLI spillover/);
  assert.equal(view.direct, null);
});

test('between items only an affirmative producer decision marks work in progress', () => {
  const gap = { ...run, items: [], running: 0 };
  const describe = (r: LocalActivityRun, w = worker) => describeLocalActivity({ worker: w, runs: [r] }, lm, now);
  assert.match(describe(gap).summary, /Knowledge ingestion.*90 of 396 finished.*between items/i);
  assert.equal(describe(gap).runs[0].status, 'draining');
  assert.equal(describe(gap).direct, null);
  const closed = describe({ ...gap, allowedNow: false, waitReason: 'overnight window closed' });
  assert.equal(closed.runs[0].status, 'waiting');
  assert.match(closed.summary, /waiting.*overnight window closed/i);
  assert.equal(closed.busy, false);
  const paused = describeLocalActivity({ worker: { paused: true, pauseReason: 'memory pressure' }, runs: [gap] }, undefined, now);
  assert.match(paused.summary, /paused.*memory pressure/i);
  assert.equal(paused.busy, false);
});

test('shared model residency is ambiguous and a daytime local worker may be rerouted', () => {
  const queuedRun = { ...run, running: 1, items: [item] };
  const queue = { worker, runs: [queuedRun] };
  const ambiguous = { ...lm, models: [...lm.models, { id: 'second chat model', state: 'loaded', type: 'llm' }] };
  assert.match(describeLocalActivity(queue, ambiguous, now).runs[0].items[0].description, /name not reported/);
  const nonlocalCall = { ...queuedRun, items: [{ ...item, localCallInFlight: false }] };
  assert.match(describeLocalActivity({ worker, runs: [nonlocalCall] }, lm, now).runs[0].items[0].description,
    /gemma resident.*serving model unconfirmed/i);
  const day = describeLocalActivity({ ...queue, runs: [nonlocalCall], localWindowOpen: false }, lm, now);
  assert.equal(day.busy, false);
  assert.match(day.runs[0].items[0].description, /serving model unconfirmed/i);
});

test('legacy jobs group by identity with explicit unknown progress, titles, eligibility and lane', () => {
  const jobs = ['running', 'queued', 'queued'].map((status, i) => ({
    id: String(i), type: 'future_work_item', status, payload: { run_id: 'r' },
  }));
  const view = describeLocalActivity({ worker, jobs }, undefined, now);
  assert.equal(view.runs.length, 1);
  assert.match(view.summary, /Future work item.*total not reported/i);
  assert.match(view.runs[0].items[0].description, /title not reported.*lane not reported.*start time not reported/i);
  assert.equal(view.busy, false);
  const gap = describeLocalActivity({ worker, jobs: jobs.slice(1) }, undefined, now);
  assert.match(gap.summary, /eligibility not reported/i);
  assert.equal(gap.busy, false);
  assert.match(describeLocalActivity(undefined, lm, now).summary, /queue unavailable/i);
});

test('direct traffic carries only the callers actually reported', () => {
  assert.match(describeLocalActivity({ worker, runs: [], directCallers: ['gateway.reader'] }, lm, now).summary, /direct traffic.*gateway.reader/i);
  const live = { ...lm, instances: [{ id: 'gemma', type: 'llm', status: 'generating', queued: 0 }] };
  assert.match(describeLocalActivity({ worker, runs: [] }, live, now).summary, /direct traffic, caller not reported/i);
  assert.match(describeLocalActivity({ worker, runs: [], directCallsInFlight: 1 }, lm, now).summary, /direct traffic, caller not reported/i);
  assert.equal(describeLocalActivity({ worker, runs: [] }, lm, now).direct, null, 'the last request can belong to a finished job');
});

test('pausing between claims leaves an already running item visible', () => {
  const view = describeLocalActivity({ worker: { paused: true, pauseReason: 'Operator hold' }, runs: [run] }, lm, now);
  assert.equal(view.runs[0].status, 'running');
  assert.match(view.summary, /current work continues.*worker paused.*Operator hold/i);
});

test('only a started batch with the next claim drains between items', () => {
  const gap = { ...run, running: 0, items: [] };
  const first = { ...gap, id: 'first', started: false, finished: 0 };
  const queue = { worker, nextLocalRunId: gap.id, runs: [first, gap] };
  const view = describeLocalActivity(queue);
  assert.equal(view.runs[0].status, 'waiting');
  assert.equal(view.runs[1].status, 'draining');
  assert.equal(describeLocalActivity({ ...queue, nextLocalRunId: first.id }).runs[1].status, 'waiting');
});

test('an independent job eligible for its first claim waits for the worker', () => {
  const standalone = { ...run, id: 'job:single', runId: null, running: 0, items: [], queued: 1, finished: null, total: null };
  const view = describeLocalActivity({ worker, runs: [standalone] }, undefined, now);
  assert.equal(view.busy, false);
  assert.match(view.summary, /Waiting for worker/);
});

test('current focus keeps distinct runs and retains full counts even when dispatch jobs are sampled', () => {
  const other = { ...run, id: 'ingest:other', allowedNow: false, waitReason: 'outside window', items: [], running: 0 };
  const view = deriveCurrentFocus({ projects: [], state: { localLlm: { worker, runs: [run, other], jobs: [] }, lmStudio: lm }, now });
  const rows = view.groups.find(g => g.name === 'Background activity')!.items;
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map(row => row.id)).size, 2);
  assert.ok(rows.every(row => row.title === 'Knowledge ingestion'));
  assert.match(rows[0].action!, /2 running.*305 queued/);
  assert.equal(rows[1].status, 'queued');
});

test('current focus stops advancing the last observed item when the queue feed fails', () => {
  const view = deriveCurrentFocus({ projects: [], state: { localLlm: { worker, runs: [run] } },
    now: now + 300_000, feed: { available: false, snapshotAt: new Date(now).toISOString() } });
  const row = view.groups[0].items[0];
  assert.equal(view.running, 0);
  assert.equal(row.stage, 'Queue signal delayed');
  assert.match(row.action!, /24s elapsed/);
});
