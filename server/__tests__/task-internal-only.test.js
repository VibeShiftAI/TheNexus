const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');

// Praxis keeps a task flagged internal_only out of every client status report.
describe('task internal_only flag through PATCH /api/tasks/:taskId', () => {
  let dir, db, server, base, oldDbPath;
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-internal-'));
    oldDbPath = process.env.NEXUS_DB_PATH;
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.resetModules();
    db = require('../../db');
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/tasks`;
    const raw = new Database(process.env.NEXUS_DB_PATH);
    raw.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run(PROJECT, 'Project', path.join(dir, 'project'));
    raw.close();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (oldDbPath === undefined) delete process.env.NEXUS_DB_PATH;
    else process.env.NEXUS_DB_PATH = oldDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function request(suffix, body, method = 'GET') {
    const response = await fetch(base + suffix, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  test('sets and clears the flag without touching other metadata or task fields', async () => {
    const task = await db.createTask({ id: 'task-internal', project_id: PROJECT, name: 'Set up the shared drive', status: 'completed', priority: 1,
      metadata: { status_message: 'Kept', planning: { revision: 'r1' } } });
    const set = await request(`/${task.id}`, { internal_only: true }, 'PATCH');
    expect(set.status).toBe(200);
    const flagged = await request(`/${task.id}`);
    expect(flagged.body.metadata).toMatchObject({ internal_only: true, status_message: 'Kept', planning: { revision: 'r1' } });
    expect(flagged.body).toMatchObject({ name: 'Set up the shared drive', status: 'completed', priority: 1 });

    const cleared = await request(`/${task.id}`, { internal_only: false }, 'PATCH');
    expect(cleared.status).toBe(200);
    const read = await request(`/${task.id}`);
    expect(read.body.metadata).not.toHaveProperty('internal_only');
    expect(read.body.metadata).toMatchObject({ status_message: 'Kept', planning: { revision: 'r1' } });
  });

  test('rejects anything but a boolean and leaves the task unchanged', async () => {
    const task = await db.createTask({ id: 'task-typed', project_id: PROJECT, name: 'Draft the site map', status: 'todo', metadata: {} });
    for (const value of ['yes', 1, null]) {
      const refused = await request(`/${task.id}`, { internal_only: value }, 'PATCH');
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('internal_only must be true or false');
    }
    const read = await request(`/${task.id}`);
    expect(read.body.metadata).not.toHaveProperty('internal_only');
  });
});
