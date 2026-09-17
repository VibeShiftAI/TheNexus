const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');

const knowledgeContext = () => ({
  version: 1,
  lookup_status: 'available',
  requirements: [{
    id: 'rollout-question', need_id: 'need-1',
    question: 'Which rollout strategy meets the budget?',
    tags: ['safe-rollouts'], reason: 'Choose the release strategy.',
    satisfaction_test: 'A measured trial supports the answer.',
    source_refs: ['vault:rollout-trial'],
  }],
});

describe('task knowledge metadata API and storage boundary', () => {
  let dir, db, raw, server, base, oldDbPath;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-knowledge-'));
    oldDbPath = process.env.NEXUS_DB_PATH;
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.resetModules();
    db = require('../../db');
    raw = new Database(process.env.NEXUS_DB_PATH);
    raw.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/tasks`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    raw.close();
    if (oldDbPath === undefined) delete process.env.NEXUS_DB_PATH;
    else process.env.NEXUS_DB_PATH = oldDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    raw.exec('DELETE FROM tasks; DELETE FROM projects;');
    raw.prepare("INSERT INTO projects (id,name,path) VALUES ('11111111-1111-4111-8111-111111111111','Project','/tmp/project')").run();
  });
  async function request(suffix = '', body, method = 'GET') {
    const response = await fetch(base + suffix, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function seed(metadata = {}, extra = {}) {
    return db.createTask({ id: 'task-1', project_id: '11111111-1111-4111-8111-111111111111', name: 'Rollout', status: 'todo', metadata, ...extra });
  }

  test.each(['single', 'batch'])('%s create retains knowledge and unrelated metadata through GET and SQLite', async mode => {
    const metadata = {
      knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'],
      knowledge_unresolved_need_ids: ['missing-need'],
      planning: { revision: 'r1', notes: ['Keep the full context.'] },
    };
    const result = mode === 'single'
      ? await request('', { project_id: '11111111-1111-4111-8111-111111111111', title: 'Rollout', metadata }, 'POST')
      : await request('/batch', { project_id: '11111111-1111-4111-8111-111111111111', tasks: [{ name: 'Rollout', metadata }] }, 'POST');
    expect(result.status).toBe(201);
    const id = mode === 'single' ? result.body.id : result.body.tasks[0].id;
    const fetched = await request(`/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.metadata).toEqual(metadata);
    expect((await request('?project_id=11111111-1111-4111-8111-111111111111')).body.tasks[0].metadata).toEqual(metadata);
    expect(JSON.parse(raw.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id).metadata)).toEqual(metadata);
  });

  test.each([null, [], 'metadata'])('single create refuses non-object metadata %j', async metadata => {
    const result = await request('', { project_id: '11111111-1111-4111-8111-111111111111', title: 'Invalid', metadata }, 'POST');
    expect(result.status).toBe(400);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM tasks').get().count).toBe(0);
  });

  test('single create accepts an empty metadata object', async () => {
    const result = await request('', { project_id: '11111111-1111-4111-8111-111111111111', title: 'No requirements', metadata: {} }, 'POST');
    expect(result.status).toBe(201);
    expect((await request(`/${result.body.id}`)).body.metadata).toEqual({});
  });

  test('PATCH merges knowledge fields while preserving unrelated metadata and suspension history', async () => {
    const metadata = { status_message: 'Awaiting a choice', suspension: { reason: 'Operator choice', context: { options: ['canary'] } }, planning: { revision: 'r1' } };
    const task = await seed(metadata);
    const result = await request('/task-1', { knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'], expected_version: task.version }, 'PATCH');
    expect(result.status).toBe(200);
    expect(result.body.task.metadata).toEqual({ ...metadata, knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'] });
    expect((await request('/task-1')).body.metadata).toEqual(result.body.task.metadata);
    expect(result.body.task.version).toBe(task.version + 1);
  });

  test('knowledge and suspension updates in the same PATCH are both retained', async () => {
    const task = await seed({ planning: { revision: 'r1' } });
    const result = await request('/task-1', {
      knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'], expected_version: task.version,
      status: 'suspended', status_message: 'Research is paused', suspended_reason: 'Need approval',
    }, 'PATCH');
    expect(result.status).toBe(200);
    expect(result.body.task.metadata).toEqual({
      planning: { revision: 'r1' }, knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'],
      status_message: 'Research is paused', suspension: { reason: 'Need approval', suspended_at: expect.any(String) },
    });
  });

  test('either knowledge field can be replaced independently, including empty references and unavailable lookup', async () => {
    const task = await seed({ knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'], planning: 'keep' });
    const idsOnly = await request('/task-1', { knowledge_need_ids: [], expected_version: task.version }, 'PATCH');
    expect(idsOnly.status).toBe(200);
    expect(idsOnly.body.task.metadata).toEqual({ knowledge_context: knowledgeContext(), knowledge_need_ids: [], planning: 'keep' });
    const context = { version: 1, lookup_status: 'unavailable', requirements: [] };
    const contextOnly = await request('/task-1', { knowledge_context: context, expected_version: idsOnly.body.task.version }, 'PATCH');
    expect(contextOnly.status).toBe(200);
    expect(contextOnly.body.task.metadata).toEqual({ knowledge_context: context, knowledge_need_ids: [], planning: 'keep' });
  });

  test('PATCH persists unresolved links with the knowledge snapshot while preserving other metadata', async () => {
    const metadata = { planning: 'keep', suspension: { reason: 'Need approval' } };
    const task = await seed(metadata);
    const result = await request('/task-1', {
      knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'],
      knowledge_unresolved_need_ids: ['missing-need'], expected_version: task.version,
    }, 'PATCH');
    expect(result.status).toBe(200);
    expect((await request('/task-1')).body.metadata).toEqual({
      ...metadata, knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'],
      knowledge_unresolved_need_ids: ['missing-need'],
    });
  });

  test('PATCH accepts [] to clear unresolved links without changing other knowledge fields', async () => {
    const metadata = { planning: 'keep', knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'], knowledge_unresolved_need_ids: ['missing-need'] };
    const task = await seed(metadata);
    const result = await request('/task-1', { knowledge_unresolved_need_ids: [], expected_version: task.version }, 'PATCH');
    expect(result.status).toBe(200);
    expect((await request('/task-1')).body.metadata).toEqual({ ...metadata, knowledge_unresolved_need_ids: [] });
  });

  test('PATCH preserves unresolved links when their field is omitted', async () => {
    const metadata = { knowledge_context: knowledgeContext(), knowledge_unresolved_need_ids: ['missing-need'] };
    const task = await seed(metadata);
    const result = await request('/task-1', { knowledge_need_ids: ['need-1'], expected_version: task.version }, 'PATCH');
    expect(result.status).toBe(200);
    expect(result.body.task.metadata).toEqual({ ...metadata, knowledge_need_ids: ['need-1'] });
  });

  const invalidUpdates = [
    ['null context', { knowledge_context: null }],
    ['unversioned context', { knowledge_context: { lookup_status: 'available', requirements: [] } }],
    ['unknown version', { knowledge_context: { ...knowledgeContext(), version: 2 } }],
    ['unknown lookup status', { knowledge_context: { ...knowledgeContext(), lookup_status: 'verified' } }],
    ['incomplete requirement', { knowledge_context: { ...knowledgeContext(), requirements: [{ id: 'q' }] } }],
    ['non-string tag', { knowledge_context: { ...knowledgeContext(), requirements: [{ ...knowledgeContext().requirements[0], tags: [4] }] } }],
    ['non-array need IDs', { knowledge_need_ids: 'need-1' }],
    ['non-string need ID', { knowledge_need_ids: [null] }],
    ['null unresolved IDs', { knowledge_unresolved_need_ids: null }],
    ['non-array unresolved IDs', { knowledge_unresolved_need_ids: 'missing-need' }],
    ['non-string unresolved ID', { knowledge_unresolved_need_ids: [5] }],
    ['blank need ID', { knowledge_need_ids: [' '] }],
    ['blank unresolved ID', { knowledge_unresolved_need_ids: [' '] }],
    ...['id', 'need_id', 'question', 'reason', 'satisfaction_test', 'tags', 'source_refs'].map(field => [
      `blank requirement ${field}`, { knowledge_context: { ...knowledgeContext(), requirements: [{
        ...knowledgeContext().requirements[0], [field]: ['tags', 'source_refs'].includes(field) ? [' \n'] : ' \n',
      }] } },
    ]),
    ['authority claim', { knowledge_context: { ...knowledgeContext(), authority: 'operator' } }],
    ['verification claim', { knowledge_context: { ...knowledgeContext(), requirements: [{ ...knowledgeContext().requirements[0], verified_by: 'operator' }] } }],
  ];
  test.each(invalidUpdates)('PATCH refuses %s without changing task state', async (_, patch) => {
    const task = await seed({ planning: 'keep' });
    const before = await request('/task-1');
    const result = await request('/task-1', { ...patch, title: 'Must not be saved', expected_version: task.version }, 'PATCH');
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/knowledge/);
    expect((await request('/task-1')).body).toEqual(before.body);
  });

  test.each(['single', 'batch'])('%s create rejects invalid knowledge metadata before any insert', async mode => {
    const metadata = { knowledge_context: { ...knowledgeContext(), verified: true } };
    const result = mode === 'single'
      ? await request('', { project_id: '11111111-1111-4111-8111-111111111111', title: 'Invalid', metadata }, 'POST')
      : await request('/batch', { project_id: '11111111-1111-4111-8111-111111111111', tasks: [{ name: 'Valid', metadata: { knowledge_context: knowledgeContext() } }, { name: 'Invalid', metadata }] }, 'POST');
    expect(result.status).toBe(400);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM tasks').get().count).toBe(0);
  });

  test.each(['single', 'batch'])('%s create rejects invalid unresolved links before any insert', async mode => {
    const metadata = { knowledge_unresolved_need_ids: ['missing-need', 5] };
    const result = mode === 'single'
      ? await request('', { project_id: '11111111-1111-4111-8111-111111111111', title: 'Invalid', metadata }, 'POST')
      : await request('/batch', { project_id: '11111111-1111-4111-8111-111111111111', tasks: [{ name: 'Valid', metadata: {} }, { name: 'Invalid', metadata }] }, 'POST');
    expect(result.status).toBe(400);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM tasks').get().count).toBe(0);
  });

  test('stale knowledge PATCH returns 409 without overwriting a concurrent metadata edit', async () => {
    const original = await seed({ planning: 'keep' });
    expect((await request('/task-1', { status_message: 'Concurrent note', expected_version: original.version }, 'PATCH')).status).toBe(200);
    const current = await request('/task-1');
    const stale = await request('/task-1', { knowledge_context: knowledgeContext(), knowledge_need_ids: ['need-1'], expected_version: original.version }, 'PATCH');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('task_version_conflict');
    expect((await request('/task-1')).body).toEqual(current.body);
  });

  test('knowledge PATCH keeps source and payload guards and cannot replace arbitrary metadata', async () => {
    const task = await seed({ verification: { outcome: 'uncertain' }, planning: 'keep' }, { source: 'operator' });
    const result = await request('/task-1', {
      knowledge_context: knowledgeContext(), expected_version: task.version,
      antigravity_payload: { prompt: 'New execution instructions' }, source: 'operator',
      metadata: { verification: { outcome: 'verified' }, planning: 'replace' },
    }, 'PATCH');
    expect(result.status).toBe(200);
    expect(result.body.task.source).toBe('nexus-api');
    expect(result.body.task.metadata).toEqual({ verification: { outcome: 'uncertain' }, planning: 'keep', knowledge_context: knowledgeContext() });
  });
});
