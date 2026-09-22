const fs = require('fs');
const os = require('os');
const path = require('path');

describe('write lease facade compatibility', () => {
    let dir, previousPath, raw;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lease-compat-'));
        previousPath = process.env.NEXUS_DB_PATH;
        jest.resetModules();
    });
    afterEach(() => {
        jest.restoreAllMocks();
        raw?.close(); raw = undefined;
        if (previousPath === undefined) delete process.env.NEXUS_DB_PATH;
        else process.env.NEXUS_DB_PATH = previousPath;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function open() {
        process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
        const db = require('../../db');
        raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
        return db;
    }

    test('failed database open preserves the facade null/false/array results', async () => {
        process.env.NEXUS_DB_PATH = path.join(dir, 'missing-parent', 'test.db');
        const db = require('../../db');
        expect(db.isDatabaseEnabled()).toBe(false);
        for (const [name, args, expected] of [
            ['createTask', [{}], null], ['updateTask', ['task', {}], null],
            ['upsertProject', [{}], null], ['updateProject', ['project', {}], null],
            ['archiveProject', ['project'], null], ['unarchiveProject', ['project'], null],
            ['updateProjectNeed', ['project', 'need', {}], null],
            ['transitionProjectCheckpoint', ['project', {}], null],
            ['reopenProjectCheckpoint', ['project', 'checkpoint'], null],
            ['updateProjectContext', ['project', 'product', 'text'], null],
            ['deleteTask', ['task'], false], ['deleteProject', ['project'], false],
            ['reorderTasks', [[]], false], ['batchCreateTasks', [[]], []],
        ]) {
            expect({ name, result: await db[name](...args) }).toEqual({ name, result: expected });
        }
    });

    test('context projection retains getProject name-first resolution for UUID collisions', async () => {
        const db = open();
        const id = '11111111-1111-4111-8111-111111111111';
        const namedId = '22222222-2222-4222-8222-222222222222';
        const byId = path.join(dir, 'by-id'), byName = path.join(dir, 'by-name');
        fs.mkdirSync(byId); fs.mkdirSync(byName);
        const insert = raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)');
        insert.run(id, 'First project', byId);
        insert.run(namedId, id, byName);
        expect((await db.getProject(id)).id).toBe(namedId);
        const lease = db.writeLeases.acquire({ scope: 'workspace', path: byId });
        try {
            expect((await db.updateProjectContext(id, 'product', 'Named project')).content).toBe('Named project');
            expect(fs.existsSync(path.join(byId, '.context', 'product.md'))).toBe(false);
            expect(fs.readFileSync(path.join(byName, '.context', 'product.md'), 'utf8')).toContain('Named project');
        } finally { db.writeLeases.release(lease.token); }
    });

    test('context projection retains getProject refusal to resolve non-UUID ids by id', async () => {
        const db = open();
        raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('short-id', 'Project', dir);
        expect(await db.getProject('short-id')).toBeNull();
        expect((await db.updateProjectContext('short-id', 'product', 'Database only')).content).toBe('Database only');
        expect(fs.existsSync(path.join(dir, '.context', 'product.md'))).toBe(false);
    });

    test('lookup failure skips best-effort projection but still saves the context row', async () => {
        const db = open();
        const id = '11111111-1111-4111-8111-111111111111';
        raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, 'Project', dir);
        const prototype = require('better-sqlite3').prototype;
        const prepare = prototype.prepare;
        const spy = jest.spyOn(prototype, 'prepare').mockImplementation(function (sql) {
            if (sql.startsWith('SELECT * FROM projects WHERE')) throw new Error('Synthetic project lookup failure');
            return prepare.call(this, sql);
        });
        try {
            expect((await db.updateProjectContext(id, 'product', 'Retained')).content).toBe('Retained');
            expect(raw.prepare('SELECT content FROM project_contexts').get().content).toBe('Retained');
            expect(fs.existsSync(path.join(dir, '.context', 'product.md'))).toBe(false);
        } finally { spy.mockRestore(); }
    });
});
