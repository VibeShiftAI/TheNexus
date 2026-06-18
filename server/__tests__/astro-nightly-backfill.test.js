const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function listen(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}
function close(handle) { for (const s of handle.sockets) s.destroy(); return new Promise((r) => handle.server.close(r)); }
async function json(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { status: res.status, body: await res.json() };
}
async function waitForRun(baseUrl, channelId, runId) {
  for (let i = 0; i < 80; i += 1) {
    const run = (await json(`${baseUrl}/api/studio/${channelId}/ingestion/runs/${runId}`)).body.run;
    if (run && (run.status === 'complete' || run.status === 'failed')) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('nightly astrophysics backfill cursor', () => {
  let tmpDir; let handle; let fetchNasa;
  const channelId = 'impossible-worlds-field-guide';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-astro-test-'));
    process.env.NEXUS_DB_PATH = path.join(tmpDir, 'nexus.db');
    process.env.STUDIO_NASA_BATCH = '2'; // small batch so backfill takes multiple runs
    jest.resetModules();

    // Stubbed NASA TAP: page 1 returns a full batch (keep backfilling),
    // page 2 returns a short batch (drain → incremental).
    fetchNasa = jest.fn(async (query) => {
      if (/pl_name > 'Bb c'/.test(query)) return [{ pl_name: 'Cc d', pl_rade: 2, pl_bmasse: 5 }];
      return [
        { pl_name: 'Aa b', pl_rade: 1, pl_bmasse: 1, hostname: 'Aa' },
        { pl_name: 'Bb c', pl_rade: 1.2, pl_bmasse: 2, hostname: 'Bb' },
      ];
    });
    const astroDeps = {
      fetchNasa,
      fetchNasaCount: async () => 3,
      fetchArxiv: async () => [], // skip ArXiv for determinism
    };

    const createStudioRouter = require('../routes/studio');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/studio', createStudioRouter({ callAI: jest.fn(async () => ({ text: '{"objects":[]}' })), astroDeps }));
    handle = await listen(app);
  });

  afterEach(async () => {
    if (handle) await close(handle);
    handle = null;
    delete process.env.NEXUS_DB_PATH;
    delete process.env.STUDIO_NASA_BATCH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('advances the cursor across runs and drains the archive into the catalog', async () => {
    // ---- Night 1: ingest the first full page, cursor stays in backfill ----
    const r1 = await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/astro`, { method: 'POST', body: JSON.stringify({}) });
    expect(r1.status).toBe(202);
    expect((await waitForRun(handle.baseUrl, channelId, r1.body.run.id)).status).toBe('complete');

    let cursors = (await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/cursors`)).body;
    let nasa = cursors.cursors.find((c) => c.source === 'nasa_exoplanets');
    expect(nasa.mode).toBe('backfill');
    expect(nasa.position).toBe('Bb c');
    expect(nasa.processed_count).toBe(2);
    expect(nasa.total_estimate).toBe(3);

    let objects = (await json(`${handle.baseUrl}/api/studio/${channelId}/objects`)).body;
    expect(objects.map((o) => o.name).sort()).toEqual(['Aa b', 'Bb c']);
    // Parameter calculator ran on ingest: Aa b (1 Me, 1 Re) should have ~1 g.
    const aa = objects.find((o) => o.name === 'Aa b');
    const grav = aa.spec_values.find((s) => s.spec_key === 'bulk.surface_gravity_g');
    expect(grav).toBeTruthy();
    expect(grav.status).toBe('estimated');

    // ---- Night 2: next page is short → archive drained, flip to incremental ----
    const r2 = await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/astro`, { method: 'POST', body: JSON.stringify({}) });
    expect((await waitForRun(handle.baseUrl, channelId, r2.body.run.id)).status).toBe('complete');

    cursors = (await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/cursors`)).body;
    nasa = cursors.cursors.find((c) => c.source === 'nasa_exoplanets');
    expect(nasa.mode).toBe('incremental');
    expect(nasa.processed_count).toBe(3);

    objects = (await json(`${handle.baseUrl}/api/studio/${channelId}/objects`)).body;
    expect(objects.map((o) => o.name).sort()).toEqual(['Aa b', 'Bb c', 'Cc d']);

    // The second night queried with the resume gate from night 1.
    expect(fetchNasa.mock.calls.some(([q]) => /pl_name > 'Bb c'/.test(q))).toBe(true);
  });
});
