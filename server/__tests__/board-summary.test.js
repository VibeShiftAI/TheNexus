const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const vm = require('vm');
let Database = require('better-sqlite3');
const { guardDispatchPayload } = require('../lib/provenance');

describe('compact board summary over real SQLite and HTTP', () => {
  let dir, db, raw, server, base;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-summary-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.resetModules();
    Database = require('better-sqlite3');
    db = require('../../db');
    raw = new Database(process.env.NEXUS_DB_PATH);
    raw.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
    const app = express();
    app.use(express.json());
    const createDashboardRouter = require('../routes/dashboard');
    app.use('/api/dashboard', createDashboardRouter({ db }));
    // Execute the production registration itself without starting the unrelated
    // runtime services from server.js. This catches a second, stale board route.
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf("app.get('/api/board-state'");
    const end = source.indexOf('// AI & chat', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    vm.runInNewContext(source.slice(start, end), {
      app, db, createDashboardRouter, guardDispatchPayload, console,
      authenticate: (req, res, next) => { res.set('x-test-authenticated', 'yes'); next(); },
    });
    app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    raw.close();
    delete process.env.NEXUS_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    raw.exec('DELETE FROM tasks; DELETE FROM projects;');
    raw.prepare("INSERT INTO projects (id,name,path,status) VALUES ('a','A','/a','active'), ('b','B','/b','archived')").run();
  });
  async function task(id, fields = {}) {
    const row = await db.createTask({ id, project_id: 'a', name: `Task ${id}`, status: 'todo', priority: 1, created_at: '2026-09-01', ...fields });
    expect(row).not.toBeNull();
    return row;
  }
  async function summary(query = '') {
    const response = await fetch(`${base}/api/board-state?view=summary${query}`);
    expect(response.headers.get('x-test-authenticated')).toBe('yes');
    return { status: response.status, body: await response.json() };
  }
  test('projects only routing fields, computes flags, and leaves full evidence readable', async () => {
    const original = await task('rich', {
      description: 'QA Report\n' + 'complete evidence '.repeat(5000),
      antigravity_payload: { prompt: 'full prompt '.repeat(5000), commands: ['echo external'] },
      metadata: { status_message: 'QA passed', history: 'history '.repeat(5000) },
      walkthrough: 'full walkthrough', critic_feedback: 'full critique',
    });
    const fullReader = jest.spyOn(db, 'getBoardState');
    const sql = jest.spyOn(Database.prototype, 'prepare');
    let result, statements;
    try {
      result = await summary();
      statements = sql.mock.calls.map(([query]) => query);
      expect(fullReader).not.toHaveBeenCalled();
    } finally { fullReader.mockRestore(); sql.mockRestore(); }
    expect(result.status).toBe(200);
    expect(result.body.view).toBe('summary');
    expect(result.body.tasks).toEqual([{
      id: 'rich', project_id: 'a', project_name: 'A', title: 'Task rich', status: 'todo', priority: 1,
      dependencies: [], is_unblocked: true, updated_at: original.updated_at, version: original.version,
      detail: { href: '/api/tasks/rich', has_description: true, has_payload: true, has_qa_evidence: true },
    }]);
    expect(statements.some(query => /SELECT\s+\*/i.test(query))).toBe(false);
    expect(statements.some(query => /LIMIT\s+\?/i.test(query))).toBe(true);
    const detail = await (await fetch(base + result.body.tasks[0].detail.href)).json();
    expect(detail.description).toBe(original.description);
    expect(detail.walkthrough.content).toBe(original.walkthrough);
    expect(detail.metadata).toEqual(original.metadata);
    expect(detail.antigravity_payload).toEqual(guardDispatchPayload(original));
    const full = await (await fetch(`${base}/api/board-state`)).json();
    expect(Array.isArray(full)).toBe(true);
    expect(full[0].tasks[0]).toMatchObject({ title: original.name, createdAt: original.created_at, updatedAt: original.updated_at });
    expect(full[0].tasks[0].description).toBe(original.description);
    expect(full[0].tasks[0].antigravity_payload).toEqual(guardDispatchPayload(original));
    expect(await (await fetch(`${base}/api/board-state?view=full`)).json()).toEqual(full);
    const dashboardSummary = await (await fetch(`${base}/api/dashboard/board-state?view=summary`)).json();
    expect(dashboardSummary).toEqual(result.body);
    const dashboardFull = await (await fetch(`${base}/api/dashboard/board-state`)).json();
    expect(dashboardFull[0].tasks[0]).not.toHaveProperty('title');
    expect(dashboardFull[0].tasks[0].antigravity_payload).toEqual(guardDispatchPayload(original));
  });
  test('fixed-cohort keyset traversal is complete and disjoint with priority/date/id ties', async () => {
    for (const id of ['f', 'c', 'b', 'e', 'a', 'd']) await task(id);
    await task('high', { priority: 3 });
    await task('early', { created_at: '2026-08-01' });
    await task('nulls', { priority: null });
    raw.prepare("UPDATE tasks SET created_at = NULL WHERE id = 'nulls'").run();
    const seen = [];
    let cursor = '', last;
    do {
      const result = await summary(`&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(result.status).toBe(200);
      last = result.body;
      expect(last.page).toMatchObject({ limit: 2, returned: last.tasks.length, total: 9, sort: 'priority DESC, created_at ASC, id ASC' });
      expect(last.tasks.length).toBeLessThanOrEqual(2);
      seen.push(...last.tasks.map(t => t.id));
      cursor = last.page.next_cursor;
      expect(last.page.has_more).toBe(Boolean(cursor));
    } while (cursor);
    expect(seen).toEqual(['high', 'early', 'a', 'b', 'c', 'd', 'e', 'f', 'nulls']);
    expect(new Set(seen).size).toBe(seen.length);
    expect(last.page.next_cursor).toBeNull();
  });
  test('filters display tasks without changing external, archived, or missing dependency truth', async () => {
    await task('done', { project_id: 'b', status: 'completed' });
    await task('pending', { project_id: 'b', status: 'todo' });
    await task('ready', { dependencies: ['done'] });
    await task('blocked', { dependencies: ['done', 'pending'] });
    await task('missing', { dependencies: ['absent'] });
    await task('review', { status: 'review' });
    const result = await summary('&project_id=a&status=todo,review&limit=100');
    expect(result.status).toBe(200);
    expect(result.body.page.total).toBe(4);
    expect(Object.fromEntries(result.body.tasks.map(t => [t.id, t.is_unblocked]))).toEqual({ ready: true, blocked: false, missing: false, review: true });
    expect((await summary('&project_id=b')).body.tasks.map(t => t.id)).toEqual(['done', 'pending']);
    expect((await summary('&status=completed')).body.tasks).toEqual([]);
    expect((await summary('&project_id=unknown')).body.page).toMatchObject({ returned: 0, total: 0, has_more: false, next_cursor: null });
  });
  test.each(['&limit=0', '&limit=101', '&limit=1.5', '&limit=-1', '&limit=abc', '&limit=', '&limit=1&limit=2', '&status=done', '&status=todo,', '&status=unknown', '&status=', '&status=todo&status=review', '&project_id=', '&project_id=a&project_id=b', '&cursor=', '&cursor=garbage'])('rejects invalid summary query %s', async query => {
    const result = await summary(query);
    expect(result.status).toBe(400);
    expect(result.body.error).toEqual(expect.any(String));
  });
  test('cursor binds filter identity, validates structure, allows canonical filter reordering and changing limit', async () => {
    await task('a'); await task('b'); await task('c');
    const first = await summary('&project_id=a&status=todo,review&limit=1');
    const cursor = first.body.page.next_cursor;
    expect(cursor).toEqual(expect.any(String));
    for (const query of ['&project_id=b&status=todo,review', '&project_id=a&status=todo', '&status=todo,review']) {
      expect((await summary(`${query}&cursor=${cursor}`)).status).toBe(400);
    }
    expect((await summary(`&project_id=a&status=review,todo&limit=2&cursor=${cursor}`)).body.tasks.map(t => t.id)).toEqual(['b', 'c']);
    for (const value of [null, {}, { v: 1 }, { priority: 'bad' }]) {
      expect((await summary(`&cursor=${Buffer.from(JSON.stringify(value)).toString('base64url')}`)).status).toBe(400);
    }
  });
  test('default 50-task rich-history fixture stays below 64 KiB without clipping routing fields', async () => {
    const evidence = 'QA evidence with complete output\n'.repeat(2000);
    for (let i = 0; i < 50; i++) await task(`task-${String(i).padStart(2, '0')}`, {
      name: `Task ${i}: ${'descriptive title '.repeat(6)}`, description: evidence,
      antigravity_payload: { prompt: evidence }, metadata: { status_message: evidence }, walkthrough: evidence,
      dependencies: i ? ['task-00'] : [],
    });
    const result = await summary();
    expect(result.status).toBe(200);
    expect(result.body.page).toMatchObject({ limit: 50, returned: 50, total: 50, has_more: false });
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThan(64 * 1024);
    expect(result.body.tasks[1].title).toBe(`Task 1: ${'descriptive title '.repeat(6)}`);
    expect(result.body.tasks[1].dependencies).toEqual(['task-00']);
  });
  test('rejects unknown or repeated views instead of silently returning full histories', async () => {
    for (const query of ['view=compact', 'view=summary&view=full']) {
      expect((await fetch(`${base}/api/board-state?${query}`)).status).toBe(400);
    }
  });
  test('resolves large dependency lists in bounded SQL batches without trimming IDs', async () => {
    const ids = Array.from({ length: 1003 }, (_, i) => `dep-${i}`);
    for (const id of ids) await task(id, { project_id: 'b', status: 'completed' });
    await task('root', { dependencies: ids, name: 'title '.repeat(1000) });
    const sql = jest.spyOn(Database.prototype, 'prepare');
    let result, queries;
    try {
      result = await summary('&limit=1');
      queries = sql.mock.calls.map(([query]) => query).filter(query => /SELECT id, status FROM tasks/.test(query));
    } finally { sql.mockRestore(); }
    expect(result.status).toBe(200);
    expect(result.body.tasks[0]).toMatchObject({ dependencies: ids, is_unblocked: true, title: 'title '.repeat(1000) });
    expect(queries).toHaveLength(3);
    expect(queries.every(query => (query.match(/\?/g) || []).length <= 500)).toBe(true);
  });
  test('presence flags include nested QA notes but never project their bodies', async () => {
    await task('empty');
    await task('note', { metadata: { status_message: 'QA passed after review' } });
    await task('request', { description: 'Please perform QA on this change', metadata: { status_message: 'QA requested' } });
    const result = await summary();
    expect(result.body.tasks[0].detail).toMatchObject({ has_description: false, has_payload: false, has_qa_evidence: false });
    expect(result.body.tasks[1].detail.has_qa_evidence).toBe(true);
    expect(result.body.tasks[2].detail.has_qa_evidence).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain('QA passed after review');
  });
  test('SQLite query failure returns HTTP 500', async () => {
    raw.exec('ALTER TABLE tasks RENAME TO tasks_unavailable');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await summary()).status).toBe(500); }
    finally {
      raw.exec('ALTER TABLE tasks_unavailable RENAME TO tasks');
      log.mockRestore();
    }
  });
  test('data errors fail visibly instead of becoming empty success', async () => {
    await task('broken');
    raw.prepare("UPDATE tasks SET dependencies = 'not json' WHERE id = 'broken'").run();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await summary()).status).toBe(500); }
    finally { log.mockRestore(); }
  });
});
