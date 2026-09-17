const { createLocalModelWorkReader: createReader } = require('../services/local-model-work');
const createLocalModelWorkReader = options => createReader({ readEvidence: async () => ({ available: true, batch: null }), ...options });

const model = { identifier: 'gemma', displayName: 'Gemma', type: 'llm', status: 'generating', queued: 3, parallel: 4 };
const queue = { worker: { paused: false }, counts: { queued: 25 }, jobs: Array.from({ length: 25 }, (_, i) => ({ id: `job-${i}`, status: 'queued' })) };

test('reads the real model queue for direct callers and retains every background job', async () => {
  const exec = jest.fn(async () => ({ stdout: JSON.stringify([model]) }));
  const readQueue = jest.fn(async () => queue);
  const read = createLocalModelWorkReader({ exec, readQueue, lmsPath: '/test/lms' });
  const snapshot = await read();
  expect(exec).toHaveBeenCalledWith('/test/lms', ['ps', '--json'], expect.objectContaining({ timeout: 2500 }));
  expect(snapshot.lmStudio).toEqual({ available: true, models: [{ id: 'gemma', name: 'Gemma', type: 'llm', status: 'generating', queued: 3 }] });
  expect(snapshot.background.jobs).toHaveLength(25);
  expect(snapshot.background.available).toBe(true);
});

test('native model requests remain visible when the background queue is unavailable', async () => {
  const read = createLocalModelWorkReader({ exec: async () => ({ stdout: JSON.stringify([model]) }), readQueue: async () => { throw new Error('offline'); } });
  const snapshot = await read();
  expect(snapshot.lmStudio.models[0].queued).toBe(3);
  expect(snapshot.background.available).toBe(false);
  expect(snapshot.background.jobs).toEqual([]);
});

test('a missing native queue is unavailable, not zero or the parallel capacity', async () => {
  const read = createLocalModelWorkReader({ exec: async () => ({ stdout: JSON.stringify([{ identifier: 'old-version', parallel: 4 }]) }), readQueue: async () => queue });
  const snapshot = await read();
  expect(snapshot.lmStudio.models[0]).toMatchObject({ status: null, queued: null });
  expect(snapshot.lmStudio.models[0]).not.toHaveProperty('running');
});

test('invalid and failed native probes preserve the background queue', async () => {
  for (const stdout of ['not json', '{}', '[{"identifier":"m","queued":-1}]']) {
    const read = createLocalModelWorkReader({ exec: async () => ({ stdout }), readQueue: async () => queue });
    const snapshot = await read();
    if (stdout.startsWith('[')) expect(snapshot.lmStudio.models[0].queued).toBe(null);
    else expect(snapshot.lmStudio.available).toBe(false);
    expect(snapshot.background.jobs).toHaveLength(25);
  }
  const read = createLocalModelWorkReader({ exec: async () => { throw new Error('timeout'); }, readQueue: async () => queue });
  expect((await read()).lmStudio.available).toBe(false);
});

test('coalesces concurrent readers and expires the snapshot', async () => {
  let now = 1000;
  const exec = jest.fn(async () => ({ stdout: '[]' }));
  const readQueue = jest.fn(async () => queue);
  const read = createLocalModelWorkReader({ exec, readQueue, now: () => now });
  const [a, b] = await Promise.all([read(), read()]);
  expect(a).toBe(b);
  await read();
  expect(exec).toHaveBeenCalledTimes(1);
  now += 5000;
  await read();
  expect(exec).toHaveBeenCalledTimes(2);
});

test('invalidating during an in-flight read cannot repopulate the cache with old worker state', async () => {
  let finishOld;
  let calls = 0;
  const read = createLocalModelWorkReader({
    exec: async () => ({ stdout: '[]' }),
    readQueue: () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({ ...queue, worker: { paused: true } }),
  });
  const old = read();
  await Promise.resolve();
  read.invalidate();
  expect((await read()).background.worker.paused).toBe(true);
  finishOld(queue);
  await old;
  expect((await read()).background.worker.paused).toBe(true);
});

test('the work endpoint is uncached and forwards source availability', async () => {
  const express = require('express');
  const router = require('../routes/local-queue')({ readWork: async () => ({ lmStudio: { available: false }, background: { available: true, jobs: queue.jobs } }) });
  const app = express(); app.use('/api/local-queue', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/local-queue/work`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.lmStudio.available).toBe(false);
    expect(body.background.jobs).toHaveLength(25);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
