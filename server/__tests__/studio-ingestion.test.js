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
  for (let i = 0; i < 60; i += 1) {
    const run = (await json(`${baseUrl}/api/studio/${channelId}/ingestion/runs/${runId}`)).body.run;
    if (run && (run.status === 'complete' || run.status === 'failed')) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('studio ingestion worker', () => {
  let tmpDir; let handle; let callAI; let contextWindowFor; let sourceBody;
  const channelId = 'impossible-worlds-field-guide';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ingest-test-'));
    process.env.NEXUS_DB_PATH = path.join(tmpDir, 'nexus.db');
    jest.resetModules();

    // Local extraction stub: returns one well-formed space object.
    callAI = jest.fn(async () => ({
      text: JSON.stringify({
        objects: [{
          name: 'Testus Prime b',
          object_kind: 'exoplanet',
          reality_status: 'observed',
          field_guide_summary: 'A rocky world used in tests.',
          spec_values: [
            { spec_key: 'bulk.mass_earth', value_number: 1, status: 'known', confidence: 'high' },
            { spec_key: 'bulk.radius_earth', value_number: 1, status: 'known', confidence: 'high' },
            { spec_key: 'atmosphere.pressure_bar', value_number: 1, status: 'known', confidence: 'medium' },
            { spec_key: 'atmosphere.composition', value_text: 'N2, O2', status: 'known', confidence: 'medium' },
            { spec_key: 'energy.stellar_flux_earth', value_number: 1, status: 'known', confidence: 'medium' },
          ],
          wonder_points: [{ wonder_type: 'scale', note: 'Surprisingly Earth-like.' }],
        }],
      }),
    }));

    sourceBody = `Synthetic article body about Testus Prime b. ${'x'.repeat(200)}`;
    // Unknown window unless a test says otherwise: sources go whole.
    contextWindowFor = jest.fn(async () => null);
    const ingestionDeps = {
      youtube: { hasKey: () => false, searchVideos: async () => [], channelUploads: async () => [] },
      fetchSourceContent: async (url) => ({ content: sourceBody, title: 'Synthetic', contentType: 'article', url }),
    };

    const createStudioRouter = require('../routes/studio');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/studio', createStudioRouter({ callAI, contextWindowFor, ingestionDeps }));
    handle = await listen(app);
  });

  afterEach(async () => {
    if (handle) await close(handle);
    handle = null;
    delete process.env.NEXUS_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('extracts objects, stores provenance, and derives parameters (local only)', async () => {
    // Disable seeded sources, add one controlled web source.
    const sources = (await json(`${handle.baseUrl}/api/studio/${channelId}/sources`)).body;
    for (const s of sources) {
      await json(`${handle.baseUrl}/api/studio/${channelId}/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    }
    await json(`${handle.baseUrl}/api/studio/${channelId}/sources`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Test web source', source_type: 'web', url: 'https://example.com/testus-prime-b' }),
    });

    const run = await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/run`, { method: 'POST', body: JSON.stringify({ trigger: 'unit' }) });
    expect(run.status).toBe(202);
    const finished = await waitForRun(handle.baseUrl, channelId, run.body.run.id);
    expect(finished).not.toBeNull();
    expect(finished.status).toBe('complete');

    const objects = (await json(`${handle.baseUrl}/api/studio/${channelId}/objects`)).body;
    const obj = objects.find((o) => o.name === 'Testus Prime b');
    expect(obj).toBeTruthy();

    const specByKey = Object.fromEntries(obj.spec_values.map((s) => [s.spec_key, s]));
    // Extracted value keeps provenance to a source item.
    expect(specByKey['bulk.mass_earth'].status).toBe('known');
    expect(specByKey['bulk.mass_earth'].source_item_id).toBeTruthy();
    // Parameter calculator filled derived specs.
    expect(specByKey['bulk.surface_gravity_g']).toBeTruthy();
    expect(specByKey['bulk.surface_gravity_g'].status).toBe('estimated');
    expect(specByKey['bulk.surface_gravity_g'].value_number).toBeCloseTo(1, 1);
    expect(specByKey['atmosphere.density_kg_m3']).toBeTruthy();

    // wonder point captured
    expect(obj.wonder_points.length).toBeGreaterThan(0);

    // Local-only: every model call used the local provider.
    expect(callAI).toHaveBeenCalled();
    for (const call of callAI.mock.calls) expect(call[0]).toEqual(expect.objectContaining({ provider: 'local' }));
  });

  test('an extraction cut at the model output limit says so on the source item', async () => {
    const sources = (await json(`${handle.baseUrl}/api/studio/${channelId}/sources`)).body;
    for (const s of sources) {
      await json(`${handle.baseUrl}/api/studio/${channelId}/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    }
    await json(`${handle.baseUrl}/api/studio/${channelId}/sources`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Test web source', source_type: 'web', url: 'https://example.com/testus-prime-c' }),
    });
    const whole = await callAI();
    callAI.mockImplementation(async () => ({ ...whole, truncated: true, finishReason: 'length' }));

    const run = await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/run`, { method: 'POST', body: JSON.stringify({ trigger: 'unit' }) });
    const finished = await waitForRun(handle.baseUrl, channelId, run.body.run.id);
    expect(finished.status).toBe('complete');
    const items = (await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/runs/${run.body.run.id}`)).body.items;
    const done = items.find((item) => item.ingestion_status === 'done');
    expect(done.excerpt).toMatch(/^Extracted 1 object\(s\)\. The model stopped at its output limit.*may be missing\.$/);
  });

  async function runOneSource(slug) {
    const sources = (await json(`${handle.baseUrl}/api/studio/${channelId}/sources`)).body;
    for (const s of sources) {
      await json(`${handle.baseUrl}/api/studio/${channelId}/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    }
    await json(`${handle.baseUrl}/api/studio/${channelId}/sources`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Long source', source_type: 'web', url: `https://example.com/${slug}` }),
    });
    const run = await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/run`, { method: 'POST', body: JSON.stringify({ trigger: 'unit' }) });
    const finished = await waitForRun(handle.baseUrl, channelId, run.body.run.id);
    expect(finished.status).toBe('complete');
    return (await json(`${handle.baseUrl}/api/studio/${channelId}/ingestion/runs/${run.body.run.id}`)).body.items;
  }

  test('a long source reaches extraction whole when it fits the local model window, or the window is unknown', async () => {
    // 40,000 characters: past the old 12,000 cut, inside half of a 32k-token window.
    sourceBody = `Testus Prime b opens the article. ${'Middle of a long source. '.repeat(1600)}LAST LINE about Testus Prime c.`;
    contextWindowFor.mockResolvedValue({ tokens: 32768, source: 'LM Studio gemma4 loaded context', charsPerToken: 3 });
    await runOneSource('long-fits');
    expect(contextWindowFor).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local' }));
    const prompt = callAI.mock.calls[0][1];
    expect(prompt).toContain(sourceBody);
    expect(prompt).not.toMatch(/too large for this model's context window/);

    // Unknown window: whole, too.
    callAI.mockClear();
    contextWindowFor.mockResolvedValue(null);
    sourceBody = `${sourceBody} One more paragraph so the hash differs.`;
    await runOneSource('long-unknown');
    expect(callAI.mock.calls[0][1]).toContain(sourceBody);
  });

  test('a source past its share of the window is cut with a note, its whole text kept, and the item says so', async () => {
    sourceBody = `Testus Prime b opens the article. ${'Middle of a long source. '.repeat(1600)}LAST LINE about Testus Prime c.`;
    // 4,096 tokens x 0.5 x 3 characters = 6,144 characters for the source.
    contextWindowFor.mockResolvedValue({ tokens: 4096, source: 'LM Studio gemma4 loaded context', charsPerToken: 3 });
    const items = await runOneSource('long-cut');
    const prompt = callAI.mock.calls[0][1];
    expect(prompt).toContain('Testus Prime b opens the article.');
    expect(prompt).not.toContain('LAST LINE');
    const note = prompt.match(/\[Source "Synthetic": ([\d,]+) characters, too large for this model's context window \(4,096 tokens, LM Studio gemma4 loaded context\) alongside the rest of the request\. The first ([\d,]+) are above; the whole text is in (\S+)\.\]/);
    expect(note).not.toBeNull();
    expect(Number(note[1].replace(/,/g, ''))).toBe(sourceBody.length);
    expect(fs.readFileSync(note[3], 'utf8')).toBe(sourceBody);

    const done = items.find((item) => item.ingestion_status === 'done');
    expect(done.excerpt).toContain(`Extraction saw the first ${note[2]} of ${note[1]} characters of this source`);
    expect(done.excerpt).toContain(note[3]);
  });
});
