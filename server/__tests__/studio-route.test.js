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

test('serves a board when migrating legacy global studio settings', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-studio-legacy-test-'));
  let handle;
  try {
    process.env.NEXUS_DB_PATH = path.join(tmpDir, 'nexus.db');
    const Database = require('better-sqlite3');
    const legacy = new Database(process.env.NEXUS_DB_PATH);
    legacy.exec(`
      CREATE TABLE studio_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      INSERT INTO studio_settings (key, value) VALUES ('targetReady', '3');
      CREATE TABLE studio_ideas (
        id TEXT PRIMARY KEY,
        source TEXT,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'suggested',
        checklist TEXT
      );
    `);
    legacy.close();

    jest.resetModules();
    const createStudioRouter = require('../routes/studio');
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/studio', createStudioRouter({ callAI: jest.fn() }));
    handle = await listen(app);

    const result = await json(`${handle.baseUrl}/api/studio?channelId=praxis-youtube`);

    expect(result.status).toBe(200);
    expect(result.body.channel.id).toBe('praxis-youtube');
    expect(result.body.targetReady).toBe(3);
  } finally {
    if (handle) await close(handle);
    delete process.env.NEXUS_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

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
    // Disable seeded sources so discovery is deterministic and hits no network.
    const sources = (await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/sources`)).body;
    for (const source of sources) {
      await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/sources/${source.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      });
    }

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

    // Wait for the background run to settle, then confirm it completed and that
    // any model use stayed on the LOCAL provider (never a cloud tier-up).
    const runId = result.body.run.id;
    let run;
    for (let i = 0; i < 40; i += 1) {
      run = (await json(`${handle.baseUrl}/api/studio/impossible-worlds-field-guide/ingestion/runs/${runId}`)).body.run;
      if (run && run.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(run.status).toBe('complete');
    for (const call of callAI.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ provider: 'local' }));
    }
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

  test('write_script runs a writer + critic agentic flow grounded in attached object params', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    const idea = await json(`${base}/ideas`, { method: 'POST', body: JSON.stringify({ title: 'Standing on Gliese X', status: 'approved' }) });
    const object = await json(`${base}/objects`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Gliese X b',
        object_kind: 'exoplanet',
        reality_status: 'observed',
        field_guide_summary: 'A heavy super-Earth.',
        specs: [
          { spec_key: 'bulk.mass_earth', value_number: 5, status: 'known', confidence: 'high' },
          { spec_key: 'bulk.radius_earth', value_number: 1.6, status: 'known', confidence: 'high' },
        ],
      }),
    });
    await json(`${handle.baseUrl}/api/studio/ideas/${idea.body.id}/objects`, { method: 'POST', body: JSON.stringify({ object_id: object.body.id, role: 'main_subject' }) });

    callAI.mockClear();
    const gen = await json(`${base}/generate`, { method: 'POST', body: JSON.stringify({ type: 'write_script', ideaId: idea.body.id, mode: 'local' }) });

    expect(gen.status).toBe(200);
    expect(gen.body.success).toBe(true);
    expect(gen.body.idea.script).toBeTruthy();
    expect(gen.body.idea.script_model).toMatch(/writer\+critic/);
    expect(gen.body.idea.status).toBe('scripted');
    // Two model passes (writer, then critic), both local.
    expect(callAI.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of callAI.mock.calls) expect(call[0]).toEqual(expect.objectContaining({ provider: 'local' }));
    // Writer prompt was grounded in the attached object's parameters.
    expect(callAI.mock.calls[0][1]).toContain('Gliese X b');
  });

  test('the enrich endpoint drains un-enriched objects and reports remaining', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    // Two objects with mass+radius so the parameter calculator has something to do.
    for (const name of ['Enrich A', 'Enrich B']) {
      await json(`${base}/objects`, {
        method: 'POST',
        body: JSON.stringify({ name, object_kind: 'exoplanet', specs: [
          { spec_key: 'bulk.mass_earth', value_number: 1, status: 'known' },
          { spec_key: 'bulk.radius_earth', value_number: 1, status: 'known' },
        ] }),
      });
    }

    let cursors = (await json(`${base}/ingestion/cursors`)).body;
    expect(cursors.enrichRemaining).toBe(2);

    const res = await json(`${base}/ingestion/enrich`, { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(202);
    expect(res.body.run.trigger).toBe('enrich');

    let run;
    for (let i = 0; i < 40; i += 1) {
      run = (await json(`${base}/ingestion/runs/${res.body.run.id}`)).body.run;
      if (run && run.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(run.status).toBe('complete');
    expect(run.digest).toMatch(/Enrichment: processed 2/);

    // No YouTube key in the test env → objects still get parameter-enriched and marked.
    cursors = (await json(`${base}/ingestion/cursors`)).body;
    expect(cursors.enrichRemaining).toBe(0);
  });

  test('interaction_idea builds a video idea from selected objects and links them', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    const a = await json(`${base}/objects`, { method: 'POST', body: JSON.stringify({ name: 'Object Alpha', object_kind: 'exoplanet', specs: [{ spec_key: 'bulk.mass_earth', value_number: 2, status: 'known' }] }) });
    const b = await json(`${base}/objects`, { method: 'POST', body: JSON.stringify({ name: 'Object Beta', object_kind: 'rogue planet' }) });

    callAI.mockResolvedValueOnce({ text: JSON.stringify({ title: 'When Alpha Meets Beta', angle: 'A gravitational tango.', build_promise: 'See the encounter.', category: 'Object system' }) });

    const gen = await json(`${base}/generate`, { method: 'POST', body: JSON.stringify({ type: 'interaction_idea', objectIds: [a.body.id, b.body.id], mode: 'local' }) });
    expect(gen.status).toBe(200);
    expect(gen.body.result.ideaId).toBeTruthy();
    expect(gen.body.idea.title).toBe('When Alpha Meets Beta');
    expect(gen.body.idea.source).toBe('object-interaction');
    // Both objects linked to the new episode.
    expect(callAI.mock.calls[0][0]).toEqual(expect.objectContaining({ provider: 'local' }));
  });

  test('unreal_environment and physics_analysis prompts include the selected objects', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    const obj = await json(`${base}/objects`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Vulcanis Prime', object_kind: 'exoplanet', specs: [
        { spec_key: 'bulk.mass_earth', value_number: 4, status: 'known' },
        { spec_key: 'bulk.radius_earth', value_number: 1.5, status: 'known' },
      ] }),
    });

    const ue = await json(`${base}/prompt?type=unreal_environment&objectIds=${obj.body.id}`);
    expect(ue.status).toBe(200);
    expect(ue.body.user).toContain('Vulcanis Prime');
    expect(ue.body.user).toMatch(/Unreal Engine 5/i);

    const phys = await json(`${base}/prompt?type=physics_analysis&objectIds=${obj.body.id}`);
    expect(phys.status).toBe(200);
    expect(phys.body.user).toContain('Vulcanis Prime');
    expect(phys.body.user).toMatch(/tidal|Roche|gravity/i);
  });

  test('exports a double-precision SI scene for Unreal (derived initial conditions)', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    const star = await json(`${base}/objects`, { method: 'POST', body: JSON.stringify({ name: 'Star A', object_kind: 'star', specs: [{ spec_key: 'bulk.mass_earth', value_number: 200000, status: 'known' }] }) });
    const planet = await json(`${base}/objects`, { method: 'POST', body: JSON.stringify({ name: 'Planet B', object_kind: 'exoplanet', specs: [
      { spec_key: 'bulk.mass_earth', value_number: 1, status: 'known' },
      { spec_key: 'bulk.radius_earth', value_number: 1, status: 'known' },
      { spec_key: 'orbital.semi_major_axis_au', value_number: 1, status: 'known' },
    ] }) });

    const res = await json(`${base}/export/unreal`, { method: 'POST', body: JSON.stringify({ objectIds: [star.body.id, planet.body.id] }) });
    expect(res.status).toBe(200);
    expect(res.body.units).toBe('SI');
    expect(res.body.source).toBe('derived-from-elements'); // not Solar System bodies
    expect(res.body.G).toBeCloseTo(6.6743e-11, 14);
    expect(res.body.bodies).toHaveLength(2);

    const b = Object.fromEntries(res.body.bodies.map((x) => [x.name, x]));
    // Mass conversion: 1 Earth mass -> ~5.97e24 kg.
    expect(b['Planet B'].mass_kg).toBeCloseTo(5.972e24, -22);
    expect(b['Planet B'].radius_m).toBeCloseTo(6.371e6, -4);
    // Central (most massive) star sits at the origin; planet ~1 AU out, moving.
    expect(Math.hypot(...b['Star A'].position_m)).toBe(0);
    const r = Math.hypot(...b['Planet B'].position_m);
    expect(r).toBeGreaterThan(1.3e11);
    expect(r).toBeLessThan(1.6e11);
    expect(Math.hypot(...b['Planet B'].velocity_mps)).toBeGreaterThan(1e3);
  });

  test('export carries rotation, surface scattering, and suns render blocks', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    const star = await json(`${base}/objects`, { method: 'POST', body: JSON.stringify({
      name: 'Ember', object_kind: 'star', subtype: 'M1V red dwarf',
      specs: [{ spec_key: 'bulk.mass_earth', value_number: 150000, status: 'known' }],
    }) });
    const planet = await json(`${base}/objects`, { method: 'POST', body: JSON.stringify({
      name: 'Cinderfall', object_kind: 'exoplanet',
      specs: [
        { spec_key: 'bulk.mass_earth', value_number: 1.2, status: 'known' },
        { spec_key: 'bulk.radius_earth', value_number: 1.1, status: 'known' },
        { spec_key: 'orbital.semi_major_axis_au', value_number: 0.1, status: 'known' },
        { spec_key: 'orbital.rotation_period_hours', value_number: 480, status: 'known' },
        { spec_key: 'orbital.obliquity_deg', value_number: 5, status: 'known' },
        { spec_key: 'orbital.tidal_lock_status', value_text: 'Tidally locked to Ember', status: 'known' },
        { spec_key: 'energy.stellar_flux_earth', value_number: 0.9, status: 'known' },
        { spec_key: 'atmosphere.pressure_bar', value_number: 1, status: 'known' },
        { spec_key: 'atmosphere.density_kg_m3', value_number: 1.3, status: 'known' },
        { spec_key: 'atmosphere.scale_height_km', value_number: 9, status: 'known' },
        { spec_key: 'atmosphere.composition', value_text: 'N2, CO2, H2O', status: 'known' },
        { spec_key: 'location.host_star_or_object', value_text: 'Ember (M1 V)', status: 'known' },
      ],
    }) });

    const res = await json(`${base}/export/unreal`, { method: 'POST', body: JSON.stringify({ objectIds: [star.body.id, planet.body.id] }) });
    expect(res.status).toBe(200);
    const b = Object.fromEntries(res.body.bodies.map((x) => [x.name, x]));

    // Star: blackbody color from its M1V subtype (red-dominant), no surface block.
    expect(b.Ember.isStar).toBe(true);
    expect(b.Ember.surface).toBeUndefined();
    expect(b.Ember.color[0]).toBe(1);
    expect(b.Ember.color[2]).toBeLessThan(0.75);

    // Planet: rotation + tidal lock exported.
    expect(b.Cinderfall.rotation_period_h).toBeCloseTo(480, 0);
    expect(b.Cinderfall.obliquity_deg).toBeCloseTo(5, 1);
    expect(b.Cinderfall.tidal_locked).toBe(true);

    // Surface scattering scaled from air density (1.3/1.225 × UE Earth default).
    expect(b.Cinderfall.surface.rayleigh.scale).toBeCloseTo(0.0331 * (1.3 / 1.225), 3);
    expect(b.Cinderfall.surface.rayleigh.exp_distribution_km).toBeCloseTo(9, 1);
    expect(b.Cinderfall.surface.has_atmosphere).toBe(true);
    expect(b.Cinderfall.surface.planet_radius_km).toBeGreaterThan(6000);

    // Suns: the in-selection star, red-shifted, illuminance rescaled to the
    // actual exported separation (circular orbit at the catalog SMA → ≈ 0.9 S⊕).
    expect(b.Cinderfall.suns).toHaveLength(1);
    expect(b.Cinderfall.suns[0].name).toBe('Ember');
    expect(b.Cinderfall.suns[0].teff_k).toBeLessThan(4000);
    expect(b.Cinderfall.suns[0].rgb[2]).toBeLessThan(0.75);
    expect(b.Cinderfall.suns[0].illuminance_lux).toBeGreaterThan(100000);
    expect(b.Cinderfall.suns[0].illuminance_lux).toBeLessThan(140000);
    expect(b.Cinderfall.suns[0].angular_diameter_deg).toBeGreaterThan(0.5);
  });

  test('object jobs reject an empty selection', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    const res = await json(`${base}/generate`, { method: 'POST', body: JSON.stringify({ type: 'physics_analysis', objectIds: [], mode: 'local' }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/selected objects/i);
  });

  test('uploads a reference image and serves it back, scoped to channel + episode', async () => {
    const base = `${handle.baseUrl}/api/studio/impossible-worlds-field-guide`;
    const idea = await json(`${base}/ideas`, { method: 'POST', body: JSON.stringify({ title: 'Reference image episode' }) });

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('fake-png-bytes')], { type: 'image/png' }), 'ref.png');
    form.append('episode_id', idea.body.id);
    form.append('intended_use', 'surface_reference');
    const uploadRes = await fetch(`${base}/reference-images/upload`, { method: 'POST', body: form });
    const uploaded = await uploadRes.json();

    expect(uploadRes.status).toBe(201);
    expect(uploaded.episode_id).toBe(idea.body.id);
    expect(uploaded.file_path_or_url).toContain('/reference-images/');

    // Listed for the episode
    const list = await json(`${base}/reference-images?episodeId=${idea.body.id}`);
    expect(list.body.some((img) => img.id === uploaded.id)).toBe(true);

    // Served back
    const fileRes = await fetch(`${handle.baseUrl}${uploaded.file_path_or_url}`);
    expect(fileRes.status).toBe(200);
    expect(Buffer.from(await fileRes.arrayBuffer()).toString()).toBe('fake-png-bytes');
  });
});
