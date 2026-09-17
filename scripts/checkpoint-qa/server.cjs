// Isolated real projects API: no production DB, scheduler, watcher, or proxy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-checkpoint-ui-'));
process.env.NEXUS_DB_PATH = path.join(dir, 'nexus.db');
const express = require('express');
const Database = require('better-sqlite3');
const db = require('../../db');
const raw = new Database(process.env.NEXUS_DB_PATH);
if (!raw.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'status')) raw.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
const id = '33333333-1430-4333-8333-333333333333';
const app = express();
app.use(express.json());
app.get('/__qa', (_req, res) => res.json({ isolated: true, db: process.env.NEXUS_DB_PATH, projectId: id }));
app.get('/api/projects/:id/tasks', (_req, res) => res.json({ tasks: [] }));
app.use('/api/projects', require('../../server/routes/projects')({ db, PROJECT_ROOT: dir, getProjectById: (_, id) => db.getProject(id), getAllProjects: () => db.getProjects(), scanProjects: async () => [], contextSync: {} }));
app.get('/api/tasks', (_req, res) => res.json({ tasks: [] }));
app.get('/api/dashboard/stats', (_req, res) => res.json({ artifactsInReview: { items: [] } }));
app.use('/api', (_req, res) => res.status(503).json({ error: 'Unrelated service intentionally unavailable on isolated checkpoint fixture' }));
(async () => {
  await db.upsertProject({ id, name: 'Checkpoint verification fixture', path: dir, status: 'active', end_state: 'Long-term goal: reliable releases that users trust', endpoint: { completion_policy: 'maintain' }, end_state_criteria: [{ id: 'final', kind: 'manual', description: 'Operator accepts sustained reliable releases', enabled: true }] });
  app.listen(4311, '127.0.0.1', () => console.log(JSON.stringify({ isolated: true, port: 4311, db: process.env.NEXUS_DB_PATH, projectId: id })));
})().catch(e => { console.error(e); process.exit(1); });
