const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createSkillWikiRouter = require('../routes/skill-wiki');

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

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error pages */ }
  return { status: res.status, body };
}

/** A tiny vault: two linked skills, one with telemetry + knowledge, one bare. */
function buildFixtureVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-wiki-vault-'));
  fs.mkdirSync(path.join(vault, 'skills', 'operations'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'skills', '_knowledge'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'skills', '_candidates'), { recursive: true });

  fs.writeFileSync(path.join(vault, 'skills', 'operations', 'plan-day.md'), [
    '---',
    'name: plan-day',
    'category: operations',
    'created: 2026-08-30T00:00:00.000Z',
    'updated: 2026-08-30T18:00:00.000Z',
    'source: manual',
    'provenance: user-created',
    'confidence: 0.95',
    'tags: [nexus, scheduling]',
    'evidence:',
    '  - "[[feedback_day_planning]]"',
    '  - "https://example.com/paper"',
    '  - "nexus:task:d367be53"',
    '  - "session:c2c855a8-9ba5-4218-bddb-2a9bba85f0de"',
    'evidence_provenance: operator',
    '---',
    '',
    '# Plan the Day',
    '',
    '## Summary',
    'Reviews the board and proposes the schedule. See [[qa-loop]] for review.',
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(vault, 'skills', 'operations', 'qa-loop.md'), [
    '---',
    'name: qa-loop',
    'category: operations',
    'tags: [qa]',
    '---',
    '',
    '# QA Loop',
    '',
    'Cross-executor review of completed tasks.',
    '',
  ].join('\n'), 'utf8');

  // Candidate skills are pending approval — must not appear in the index.
  fs.writeFileSync(path.join(vault, 'skills', '_candidates', 'pending-skill.md'),
    '---\nname: pending-skill\n---\n\n# Pending\n', 'utf8');

  fs.writeFileSync(path.join(vault, 'skills', '_knowledge', 'plan-day.md'),
    '# plan-day — knowledge\n\nWorked 3 times, failed once on a Monday.\n', 'utf8');

  fs.writeFileSync(path.join(vault, 'skills', '_index.json'), JSON.stringify({
    skills: [{
      id: 'plan-day',
      name: 'plan-day',
      summary: 'Reviews the board and proposes the schedule.',
      recallCount: 42,
      promptInjectionCount: 3,
      successCount: 3,
      failureCount: 1,
      state: 'active',
      pinned: true,
      lastUsedAt: '2026-08-30T18:00:00.000Z',
    }],
  }), 'utf8');

  fs.writeFileSync(path.join(vault, 'LINKS.md'), [
    '# LINKS — vault backlink graph',
    '',
    '## plan-day',
    '- target: [skills/operations/plan-day.md](skills/operations/plan-day.md)',
    '- ← [skills/operations/qa-loop.md](skills/operations/qa-loop.md)',
    '- ← [memories/note_something.md](memories/note_something.md)',
    '',
  ].join('\n'), 'utf8');

  return vault;
}

describe('skill-wiki route', () => {
  let handle;
  let vault;

  beforeEach(async () => {
    vault = buildFixtureVault();
    const app = express();
    app.use('/api/skill-wiki', createSkillWikiRouter({ vaultPath: vault }));
    handle = await listen(app);
  });

  afterEach(async () => {
    if (handle) await close(handle);
    handle = null;
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('indexes installed manifests merged with telemetry, excluding candidates', async () => {
    const { status, body } = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.byCategory).toEqual({ operations: 2 });
    expect(body.skills.map((s) => s.name)).toEqual(['plan-day', 'qa-loop']);

    const planDay = body.skills.find((s) => s.name === 'plan-day');
    expect(planDay).toMatchObject({
      category: 'operations',
      tags: ['nexus', 'scheduling'],
      provenance: 'user-created',
      evidenceCount: 4,
      hasKnowledge: true,
      hasTelemetry: true,
      recallCount: 42,
      successCount: 3,
      failureCount: 1,
      state: 'active',
      pinned: true,
    });
  });

  it('shows honest absence for a skill with no telemetry, evidence, or knowledge', async () => {
    const index = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills`);
    const qaLoop = index.body.skills.find((s) => s.name === 'qa-loop');
    expect(qaLoop).toMatchObject({
      provenance: null,
      evidenceCount: 0,
      hasKnowledge: false,
      hasTelemetry: false,
      recallCount: null,
      state: null,
    });

    const detail = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/qa-loop`);
    expect(detail.status).toBe(200);
    expect(detail.body.telemetry).toBeNull();
    expect(detail.body.knowledge).toBeNull();
    expect(detail.body.evidence).toEqual([]);
  });

  it('serves a skill page with classified evidence, knowledge, and graph neighbours', async () => {
    const { status, body } = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/plan-day`);
    expect(status).toBe(200);
    expect(body.relPath).toBe('skills/operations/plan-day.md');
    expect(body.manifest).toContain('# Plan the Day');
    expect(body.frontmatter.evidence_provenance).toBe('operator');
    expect(body.evidence).toEqual([
      { raw: '[[feedback_day_planning]]', kind: 'vault', target: 'feedback_day_planning' },
      { raw: 'https://example.com/paper', kind: 'url', target: 'https://example.com/paper' },
      { raw: 'nexus:task:d367be53', kind: 'nexus-task', target: 'd367be53' },
      {
        raw: 'session:c2c855a8-9ba5-4218-bddb-2a9bba85f0de',
        kind: 'session',
        target: 'c2c855a8-9ba5-4218-bddb-2a9bba85f0de',
      },
    ]);
    expect(body.knowledge).toContain('Worked 3 times');
    // qa-loop links to nothing, but LINKS.md shows it referencing plan-day;
    // plan-day's own body wiki-links qa-loop. Both directions surface.
    expect(body.related).toEqual({ inbound: ['qa-loop'], outbound: ['qa-loop'] });
    expect(body.knownSkills).toEqual(['plan-day', 'qa-loop']);
  });

  it('opens a skill by its file name when its display name has spaces', async () => {
    // Harvested skills are named for people ("Fold Context"), and a name with
    // spaces is not a valid path segment here, so the page had no address.
    fs.mkdirSync(path.join(vault, 'skills', 'development'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'skills', 'development', 'fold-context.md'),
      '---\nname: Fold Context\ncategory: development\n---\n\n# Fold Context\n\nFolds old turns.\n', 'utf8');
    fs.writeFileSync(path.join(vault, 'skills', '_knowledge', 'fold-context.md'), '# fold-context\n\nUsed twice.\n', 'utf8');

    const { status, body } = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/fold-context`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: 'Fold Context', relPath: 'skills/development/fold-context.md' });
    expect(body.manifest).toContain('Folds old turns.');
    expect(body.knowledge).toContain('Used twice.');
    // A display name still resolves first, so existing links are unchanged.
    await expect(requestJson(`${handle.baseUrl}/api/skill-wiki/skills/plan-day`))
      .resolves.toMatchObject({ status: 200, body: { name: 'plan-day' } });
  });

  describe('with skills whose display names have spaces', () => {
    // Two harvested skills, filed by slug everywhere in the vault: the
    // manifest, the knowledge page, LINKS.md and every [[wiki-link]].
    beforeEach(() => {
      fs.mkdirSync(path.join(vault, 'skills', 'development'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'skills', 'development', 'fold-context.md'), [
        '---',
        'name: Fold Context',
        'category: development',
        '---',
        '',
        '# Fold Context',
        '',
        'Folds old turns. Pairs with [[route-by-cost]] after [[plan-day]].',
        '',
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(vault, 'skills', 'development', 'route-by-cost.md'),
        '---\nname: Route By Cost\ncategory: development\n---\n\n# Route By Cost\n\nSee [[fold-context]].\n', 'utf8');
      fs.writeFileSync(path.join(vault, 'skills', '_knowledge', 'fold-context.md'), '# fold-context\n\nUsed twice.\n', 'utf8');

      // Telemetry rows come in both shapes: one known only by display name,
      // one only by id (the slug). plan-day keeps its row with both.
      const index = JSON.parse(fs.readFileSync(path.join(vault, 'skills', '_index.json'), 'utf8'));
      index.skills.push(
        { name: 'Fold Context', recallCount: 7, successCount: 2, failureCount: 0, state: 'active' },
        { id: 'route-by-cost', recallCount: 3, successCount: 0, failureCount: 1, state: 'active' },
      );
      fs.writeFileSync(path.join(vault, 'skills', '_index.json'), JSON.stringify(index), 'utf8');

      fs.writeFileSync(path.join(vault, 'LINKS.md'), [
        '# LINKS',
        '',
        '## plan-day',
        '- target: [skills/operations/plan-day.md](skills/operations/plan-day.md)',
        '- ← [skills/operations/qa-loop.md](skills/operations/qa-loop.md)',
        '- ← [skills/development/fold-context.md](skills/development/fold-context.md)',
        '',
        '## fold-context',
        '- target: [skills/development/fold-context.md](skills/development/fold-context.md)',
        '- ← [skills/development/route-by-cost.md](skills/development/route-by-cost.md)',
        '- ← [skills/operations/qa-loop.md](skills/operations/qa-loop.md)',
        '',
      ].join('\n'), 'utf8');
    });

    it('gives every index row a slug that opens its page', async () => {
      const { body } = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills`);
      expect(body.skills.map((s) => [s.name, s.slug])).toEqual([
        ['Fold Context', 'fold-context'],
        ['plan-day', 'plan-day'],
        ['qa-loop', 'qa-loop'],
        ['Route By Cost', 'route-by-cost'],
      ]);
      for (const row of body.skills) {
        const page = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/${row.slug}`);
        expect(page).toMatchObject({ status: 200, body: { name: row.name, slug: row.slug } });
      }
      // The display name itself is still not an address.
      await expect(requestJson(`${handle.baseUrl}/api/skill-wiki/skills/${encodeURIComponent('Fold Context')}`))
        .resolves.toMatchObject({ status: 400 });
    });

    it('finds the knowledge page and telemetry of a display-named skill', async () => {
      const { body } = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills`);
      const bySlug = Object.fromEntries(body.skills.map((s) => [s.slug, s]));
      // The knowledge page is filed as fold-context.md, not "Fold Context.md".
      expect(bySlug['fold-context']).toMatchObject({ hasKnowledge: true, hasTelemetry: true, recallCount: 7, successCount: 2 });
      expect(bySlug['route-by-cost']).toMatchObject({ hasKnowledge: false, hasTelemetry: true, recallCount: 3, failureCount: 1 });
      expect(bySlug['plan-day']).toMatchObject({ hasKnowledge: true, hasTelemetry: true, recallCount: 42 });

      const fold = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/fold-context`);
      expect(fold.body.telemetry).toMatchObject({ recallCount: 7, successCount: 2 });
      const route = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/route-by-cost`);
      expect(route.body.telemetry).toMatchObject({ recallCount: 3, failureCount: 1 });
    });

    it('links a display-named skill to its neighbours, and every such link opens', async () => {
      const { body } = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/fold-context`);
      // Outbound: [[route-by-cost]] names a file, [[plan-day]] a name that is
      // also its file. Inbound: LINKS.md records sources by vault path.
      expect(body.related).toEqual({
        inbound: ['Route By Cost', 'qa-loop'],
        outbound: ['Route By Cost', 'plan-day'],
      });
      expect(body.skillSlugs).toEqual({
        'Fold Context': 'fold-context',
        'fold-context': 'fold-context',
        'Route By Cost': 'route-by-cost',
        'route-by-cost': 'route-by-cost',
        'plan-day': 'plan-day',
        'qa-loop': 'qa-loop',
      });
      for (const name of [...body.related.inbound, ...body.related.outbound]) {
        const page = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/${body.skillSlugs[name]}`);
        expect(page).toMatchObject({ status: 200, body: { name } });
      }

      // A slug-named skill sees a display-named neighbour by its display name.
      const planDay = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/plan-day`);
      expect(planDay.body.related).toEqual({ inbound: ['Fold Context', 'qa-loop'], outbound: ['qa-loop'] });
    });
  });

  it('rejects unknown skills and non-skill-name path shapes', async () => {
    await expect(requestJson(`${handle.baseUrl}/api/skill-wiki/skills/nope`))
      .resolves.toMatchObject({ status: 404 });
    // Traversal-shaped names never reach the filesystem.
    await expect(requestJson(`${handle.baseUrl}/api/skill-wiki/skills/..%2f..%2fSKILLS`))
      .resolves.toMatchObject({ status: 400 });
    await expect(requestJson(`${handle.baseUrl}/api/skill-wiki/skills/plan-day.md`))
      .resolves.toMatchObject({ status: 400 });
  });

  it('is read-only: only GET routes exist and writes are refused', async () => {
    const router = createSkillWikiRouter({ vaultPath: vault });
    const methods = router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods));
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['get']));

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { status } = await requestJson(`${handle.baseUrl}/api/skill-wiki/skills/plan-day`, { method });
      expect(status).toBe(404);
    }
  });
});
