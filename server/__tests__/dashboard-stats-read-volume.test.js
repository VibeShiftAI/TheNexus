const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

test('stats count all statuses without reading retired task artifacts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stats-volume-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'fixture.db');
    const db = require('../../db');
    const raw = new Database(process.env.NEXUS_DB_PATH);
    raw.prepare("INSERT INTO projects(id,name,path,status) VALUES ('p','Project','/p','active'),('old','Retired','/old','archived')").run();
    const insert = raw.prepare('INSERT INTO tasks(id,project_id,name,status,research_output) VALUES (?,?,?,?,?)');
    for (const status of ['completed', 'Complete', 'DONE', 'cancelled', 'canceled', 'archived']) {
        insert.run(status, 'p', status, status, 'Large old artifact '.repeat(2048));
    }
    insert.run('retired-project', 'old', 'Retired project task', 'todo', 'Hidden review');
    insert.run('active', 'p', 'Current task', 'todo', 'Current review');
    insert.run('orphan', null, 'Unassigned task', 'todo', 'Keep unassigned review');
    const originalPrepare = Database.prototype.prepare;
    const artifactRows = [];
    // Measure real rows materialized, not elapsed time: retired TEXT payloads
    // caused seconds of disk I/O before JS discarded them in production.
    const spy = jest.spyOn(Database.prototype, 'prepare').mockImplementation(function(sql) {
        const statement = originalPrepare.call(this, sql);
        if (!/SELECT[\s\S]*research_output/i.test(sql)) return statement;
        return new Proxy(statement, { get(target, key) {
            if (key === 'all') return (...args) => {
                const rows = target.all(...args);
                artifactRows.push(...rows.map(row => row.id));
                return rows;
            };
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    });
    try {
        const result = await db.getDashboardStats();
        expect(result.tasksByStatus).toEqual({ completed: 1, Complete: 1, DONE: 1, cancelled: 1, canceled: 1, archived: 1, todo: 3 });
        expect(result.artifactsInReview.items.map(item => item.id).sort()).toEqual(['active', 'orphan']);
        expect(artifactRows.sort()).toEqual(['active', 'orphan']);
    } finally {
        spy.mockRestore();
        raw.close();
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.NEXUS_DB_PATH;
    }
});
