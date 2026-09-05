const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');

describe('task revision and dependency integrity', () => {
  let dir, db, raw, server, base;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cas-'));
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
    await new Promise(resolve => server.close(resolve));
    raw.close();
    delete process.env.NEXUS_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    raw.exec('DELETE FROM tasks; DELETE FROM projects;');
    raw.prepare("INSERT INTO projects (id,name,path,status) VALUES ('a','A','/a','active'), ('b','B','/b','active')").run();
  });
  async function patch(id, body) {
    const res = await fetch(`${base}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  test('two readers race: the loser cannot overwrite cancellation or its appended note', async () => {
    const original = await db.createTask({ id: 't', project_id: 'a', name: 'T', status: 'ready_for_review', description: 'base' });
    const winner = await patch('t', { status: 'cancelled', description: 'base\nconcurrent note', expected_version: original.version });
    expect(winner.status).toBe(200);
    const loser = await patch('t', { status: 'completed', description: 'base\nstale note', expected_version: original.version });
    expect(loser.status).toBe(409);
    expect(await db.getTask('t')).toMatchObject({ status: 'cancelled', description: 'base\nconcurrent note', version: original.version + 1 });
  });
  test('payload-only PATCH preserves status and advances revision; invalid versions are rejected', async () => {
    const t = await db.createTask({ id: 't', project_id: 'a', name: 'T', status: 'ready_for_review' });
    expect((await patch('t', { antigravity_payload: { prompt: 'verify' }, expected_version: t.version })).status).toBe(200);
    expect(await db.getTask('t')).toMatchObject({ status: 'ready_for_review', version: t.version + 1 });
    expect((await patch('t', { description: 'bad', expected_version: '0' })).status).toBe(400);
  });
  test('all writer paths invalidate an earlier revision, even within one timestamp', async () => {
    await db.createTask({ id: 't', project_id: 'a', name: 'T', status: 'todo' });
    const writers = [
      () => db.updateTask('t', { description: 'new' }),
      () => db.reorderTasks([{ id: 't', sort_order: 2 }]),
      () => db.archiveProject('a'),
      () => db.unarchiveProject('a'),
      () => raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 't'").run(),
    ];
    for (const write of writers) {
      const before = await db.getTask('t');
      await write();
      expect((await db.getTask('t')).version).toBe(before.version + 1);
      await expect(db.updateTask('t', { description: 'stale' }, before.version)).rejects.toMatchObject({ code: 'task_version_conflict' });
    }
  });
  test('filtered and archived project dependencies keep their true completion state', async () => {
    await db.createTask({ id: 'dep', project_id: 'b', name: 'Done', status: 'completed' });
    await db.createTask({ id: 't', project_id: 'a', name: 'T', dependencies: ['dep'] });
    expect((await db.getBoardState('a'))[0].tasks[0].is_unblocked).toBe(true);
    raw.prepare("UPDATE projects SET status = 'archived' WHERE id = 'b'").run();
    expect((await db.getBoardState())[0].tasks[0].is_unblocked).toBe(true);
    await db.updateTask('t', { dependencies: ['dep', 'missing'] });
    expect((await db.getBoardState('a'))[0].tasks[0].is_unblocked).toBe(false);
  });
});
