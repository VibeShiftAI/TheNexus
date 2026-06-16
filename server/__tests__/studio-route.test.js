const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function listen(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, sockets, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function close(handle) {
  for (const socket of handle.sockets) socket.destroy();
  return new Promise((resolve) => handle.server.close(resolve));
}

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { status: response.status, body };
}

describe('studio route', () => {
  let tmpDir;
  let handle;
  let callAI;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-studio-test-'));
    process.env.NEXUS_DB_PATH = path.join(tmpDir, 'nexus.db');
    jest.resetModules();
    callAI = jest.fn(async () => ({
      text: JSON.stringify([{ title: 'Generated idea', source: 'test', angle: 'A generated angle.' }]),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));

    const createStudioRouter = require('../routes/studio');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/studio', createStudioRouter({ callAI }));
    handle = await listen(app);
  });

  afterEach(async () => {
    if (handle) await close(handle);
    handle = null;
    delete process.env.NEXUS_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('seeds editable Praxis and Impossible Worlds channel profiles', async () => {
    const result = await json(`${handle.baseUrl}/api/studio/channels`);

    expect(result.status).toBe(200);
    expect(result.body.map((channel) => channel.id)).toEqual([
      'praxis-youtube',
      'impossible-worlds-field-guide',
    ]);
    expect(result.body[0]).toEqual(expect.objectContaining({
      id: 'praxis-youtube',
      name: 'Praxis YouTube Channel',
      positioning: expect.stringContaining('personal AI operating system'),
    }));
    expect(result.body[1]).toEqual(expect.objectContaining({
      id: 'impossible-worlds-field-guide',
      name: 'Impossible Worlds Field Guide',
      editorial_promise: expect.stringContaining('actual physics'),
      host_style: expect.stringContaining('appears on camera'),
    }));
  });

  test('saves channel profile edits', async () => {
    const result = await json(`${handle.baseUrl}/api/studio/channels/impossible-worlds-field-guide`, {
      method: 'PATCH',
      body: JSON.stringify({
        host_style: 'Robert on camera, grounded awe, no hype.',
        default_cadence_target: 3,
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body.host_style).toBe('Robert on camera, grounded awe, no hype.');
    expect(result.body.default_cadence_target).toBe(3);
  });

  test('returns channel-scoped boards and seeds Impossible Worlds once', async () => {
    const seed = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/seed`, { method: 'POST' });
    expect(seed.status).toBe(200);
    expect(seed.body.seeded).toBe(10);

    const secondSeed = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/seed`, { method: 'POST' });
    expect(secondSeed.status).toBe(200);
    expect(secondSeed.body.seeded).toBe(0);

    const impossible = await json(`${handle.baseUrl}/api/studio?channelId=impossible-worlds-field-guide`);
    expect(impossible.status).toBe(200);
    expect(impossible.body.channel.id).toBe('impossible-worlds-field-guide');
    expect(impossible.body.ideas).toHaveLength(10);
    expect(impossible.body.ideas.map((idea) => idea.title)).toContain("What it's actually like to stand on a rogue planet");

    const praxis = await json(`${handle.baseUrl}/api/studio`);
    expect(praxis.status).toBe(200);
    expect(praxis.body.channel.id).toBe('praxis-youtube');
    expect(praxis.body.ideas).toHaveLength(0);
  });

  test('stores source configuration by channel', async () => {
    const initial = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/sources`);
    expect(initial.status).toBe(200);
    expect(initial.body.some((source) => source.name === 'Kurzgesagt YouTube Channel')).toBe(true);

    const created = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/sources`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'NASA Exoplanet Archive Follow-up',
        source_type: 'web',
        url: 'https://exoplanetarchive.ipac.caltech.edu/',
        per_run_cap: 7,
      }),
    });

    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({
      channel_id: 'impossible-worlds-field-guide',
      name: 'NASA Exoplanet Archive Follow-up',
      enabled: true,
      per_run_cap: 7,
    }));
  });

  test('creates local-only ingestion runs without calling cloud generation', async () => {
    const result = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/ingestion/run`, {
      method: 'POST',
      body: JSON.stringify({ trigger: 'manual-test' }),
    });

    expect(result.status).toBe(202);
    expect(result.body.localOnly).toBe(true);
    expect(result.body.run).toEqual(expect.objectContaining({
      channel_id: 'impossible-worlds-field-guide',
      trigger: 'manual-test',
      status: 'queued',
    }));
    expect(result.body.run.items_enqueued).toBeGreaterThan(0);
    expect(callAI).not.toHaveBeenCalled();
  });

  test('creates object catalog records with spec values and wonder fields', async () => {
    const object = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/objects`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'HD 189733 b',
        object_kind: 'exoplanet',
        reality_status: 'observed',
        field_guide_summary: 'A hot Jupiter with extreme winds and silicate condensates.',
        sensory_impression: 'Blue light, crushing heat, glass-like rain driven sideways.',
        specs: [
          { spec_key: 'atmosphere.wind_speed_km_h', value_number: 8700, unit: 'km/h', status: 'estimated', confidence: 'medium' },
          { spec_key: 'human_experience.immediate_hazards', value_text: 'Extreme heat and supersonic winds.', status: 'known', confidence: 'high' },
        ],
        wonder_points: [
          { wonder_type: 'danger', note: 'Weather turns familiar rain into a lethal physics spectacle.', episode_hook_potential: 'high' },
        ],
      }),
    });

    expect(object.status).toBe(201);
    expect(object.body.name).toBe('HD 189733 b');
    expect(object.body.spec_values).toEqual(expect.arrayContaining([
      expect.objectContaining({ spec_key: 'atmosphere.wind_speed_km_h', status: 'estimated' }),
    ]));
    expect(object.body.wonder_points).toEqual(expect.arrayContaining([
      expect.objectContaining({ wonder_type: 'danger', note: expect.stringContaining('physics spectacle') }),
    ]));

    const list = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/objects`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  test('stores reference image prompt metadata by channel and episode', async () => {
    const idea = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/ideas`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Reference image test', status: 'approved' }),
    });
    expect(idea.status).toBe(201);

    const image = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/reference-images`, {
      method: 'POST',
      body: JSON.stringify({
        episode_id: idea.body.id,
        file_path_or_url: '/Volumes/Projects/Impossible Worlds Field Guide/references/episodes/ref.png',
        prompt: 'Rogue planet surface under starless sky, scientifically plausible lighting.',
        negative_prompt: 'cartoon, fantasy magic',
        model: 'local-image-model',
        aspect_ratio: '16:9',
        intended_use: 'thumbnail',
        tags: 'rogue planet, surface',
      }),
    });

    expect(image.status).toBe(201);
    expect(image.body).toEqual(expect.objectContaining({
      channel_id: 'impossible-worlds-field-guide',
      episode_id: idea.body.id,
      intended_use: 'thumbnail',
      prompt: expect.stringContaining('Rogue planet surface'),
    }));
  });

  test('builds prompts from the selected channel profile and catalog context', async () => {
    const idea = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/ideas`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'A day on a tidally locked world',
        angle: 'Eternal noon against permanent night.',
        status: 'approved',
      }),
    });
    await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/objects`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'TRAPPIST-1 e',
        object_kind: 'exoplanet',
        reality_status: 'observed',
        field_guide_summary: 'A rocky exoplanet in a compact red dwarf system.',
      }),
    });

    const prompt = await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/prompt?type=write_script&ideaId=${idea.body.id}`);

    expect(prompt.status).toBe(200);
    expect(prompt.body.system).toContain('Impossible Worlds Field Guide');
    expect(prompt.body.system).toContain('actual physics');
    expect(prompt.body.user).toContain('field-guide');
    expect(prompt.body.user).toContain('TRAPPIST-1 e');
    expect(prompt.body.user).not.toContain('personal AI operating system');
  });
});
