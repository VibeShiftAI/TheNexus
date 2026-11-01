const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

describe('project repository readers respect the recorded workspace identity', () => {
  let dir, db, raw, dbPath, server, base;
  const get = async route => {
    const response = await fetch(base + route);
    expect(response.status).toBe(200);
    return response.json();
  };
  const makeFolder = () => { const folder = path.join(dir, crypto.randomUUID()); fs.mkdirSync(folder); return folder; };
  const commit = (folder, message) => {
    const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=Workspace Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', message);
  };
  const create = existing_path => db.createProjectIntake({ operation_id: crypto.randomUUID(), name: crypto.randomUUID(), problem: 'Read only this folder', source_ref: 'chat:workspace', ...(existing_path ? { existing_path } : {}) });
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workspace-readers-'));
    dbPath = path.join(dir, 'test.db'); process.env.NEXUS_DB_PATH = dbPath;
    jest.resetModules(); db = require('../../db');
    raw = new (require('better-sqlite3'))(dbPath);
    require('../routes/dispatches')({ dbPath }); // Owns the dispatch schema read by pulse.
    const dependencies = { db, PROJECT_ROOT: dir, getProjectById: require('../utils/project-manager').getProjectById, getAllProjects: () => db.getProjects() };
    const projects = require('../routes/projects')(dependencies);
    const app = express(); app.use(express.json());
    app.use('/api/projects', require('../routes/project-pulse')({ ...dependencies, dbPath })); // Production mount order.
    app.use('/api/projects', projects);
    app.get('/api/activity', projects.getActivityHandler);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    require('../../db/raw').closeRaw(dbPath); require('../../db/raw').closeRaw(dbPath, { readonly: true });
    raw.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.NEXUS_DB_PATH;
  });

  test.each(['retargeted', 'missing', 'unassigned', 'declared unavailable'])('%s workspace returns no repository events while preserving board activity', async state => {
    const a = makeFolder(), b = makeFolder(), alias = path.join(dir, crypto.randomUUID());
    commit(b, 'Unrelated B commit');
    if (state !== 'declared unavailable') fs.symlinkSync(a, alias, 'dir');
    const p = await create(state === 'unassigned' ? undefined : alias);
    if (state === 'declared unavailable') fs.symlinkSync(b, alias, 'dir');
    if (state === 'missing' || state === 'retargeted') fs.unlinkSync(alias);
    if (state === 'retargeted') fs.symlinkSync(b, alias, 'dir');
    const now = new Date().toISOString();
    raw.prepare('INSERT INTO tasks(id,project_id,name,status,updated_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), p.project.id, 'Existing imported work', 'completed', now);
    const detail = await get(`/api/projects/${p.project.id}/pulse`);
    expect(detail.git).toMatchObject({ hasGit: false, hasCommits: false, lastCommit: null, total: 0 });
    expect(detail.opsLog.some(event => event.type === 'commit')).toBe(false);
    expect(detail.opsLog.some(event => event.type === 'task' && event.title === 'Existing imported work')).toBe(true);
    const batch = await get('/api/projects/pulse');
    expect(batch.pulses[p.project.id].git.hasGit).toBe(false);
    expect((await get('/api/activity')).some(event => event.projectId === p.project.id)).toBe(false);
  });

  test('matching attached repositories remain readable and cached pulse rechecks a moved alias', async () => {
    const a = makeFolder(), b = makeFolder(), alias = path.join(dir, crypto.randomUUID());
    commit(a, 'Bound A commit'); commit(b, 'Unrelated B commit'); fs.symlinkSync(a, alias, 'dir');
    const p = await create(alias);
    const detail = await get(`/api/projects/${p.project.id}/pulse`);
    expect(detail.git).toMatchObject({ hasGit: true, lastCommit: { message: 'Bound A commit' } });
    expect(detail.opsLog.some(event => event.type === 'commit' && event.title === 'Bound A commit')).toBe(true);
    expect((await get('/api/projects/pulse')).pulses[p.project.id].git.hasGit).toBe(true);
    expect((await get('/api/activity')).find(event => event.projectId === p.project.id).message).toBe('Bound A commit');
    fs.unlinkSync(alias); fs.symlinkSync(b, alias, 'dir');
    expect((await get(`/api/projects/${p.project.id}/pulse`)).git.hasGit).toBe(false);
    expect((await get('/api/projects/pulse')).pulses[p.project.id].git.hasGit).toBe(false);
    expect((await get('/api/activity')).some(event => event.projectId === p.project.id)).toBe(false);
  });
});
