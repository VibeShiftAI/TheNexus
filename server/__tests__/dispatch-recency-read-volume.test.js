const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const createDispatchesRouter = require('../routes/dispatches');
const createProjectPulseRouter = require('../routes/project-pulse');
const { closeRaw } = require('../../db/raw');

test('existing dispatch history serves pulse and activity recency without sorting the whole history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dispatch-recency-'));
    const dbPath = path.join(dir, 'fixture.db');
    const db = new Database(dbPath);
    let prepare;
    let reader;
    try {
        createDispatchesRouter({ dbPath });
        // Simulate an existing installation predating the recency index.
        db.exec('DROP INDEX IF EXISTS idx_task_dispatches_started');
        db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, name TEXT,
            status TEXT, updated_at TEXT, last_activity_at TEXT, archived_at TEXT);
            INSERT INTO tasks (id, project_id, name) VALUES ('t', 'p', 'Task');
            INSERT INTO task_dispatches (id, task_id, executor, started_at) VALUES
              ('old', 't', 'codex', '2026-01-01'),
              ('latest', 't', 'codex', '2026-11-23'),
              ('middle', 't', 'codex', '2026-06-01');`);
        prepare = jest.spyOn(Database.prototype, 'prepare');
        const dispatches = createDispatchesRouter({ dbPath });
        createProjectPulseRouter({ dbPath, PROJECT_ROOT: dir,
            getAllProjects: async () => [], getProjectById: async () => null });
        expect(dispatches.listRecentDispatches(2).map(row => [row.id, row.project_id]))
            .toEqual([['latest', 'p'], ['middle', 'p']]);
        // Inspect the real SQL prepared by both production readers, rather
        // than asserting that an index merely exists under a particular name.
        const queries = prepare.mock.calls.map(([sql]) => sql)
            .filter(sql => /ORDER BY d\.started_at DESC/.test(sql));
        expect(queries).toHaveLength(2);
        reader = new Database(dbPath, { readonly: true });
        for (const sql of queries) {
            const statement = reader.prepare('EXPLAIN QUERY PLAN ' + sql);
            const plan = /LIMIT \?/.test(sql) ? statement.all(2) : statement.all();
            expect(plan.map(row => row.detail).join('\n')).not.toMatch(/TEMP B-TREE/);
        }
    } finally {
        prepare?.mockRestore();
        reader?.close();
        closeRaw(dbPath);
        closeRaw(dbPath, { readonly: true });
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
