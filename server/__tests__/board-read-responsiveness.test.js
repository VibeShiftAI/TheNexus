const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('board reads leave the API event loop available', () => {
    let dir, raw, db;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-board-responsive-'));
        process.env.NEXUS_DB_PATH = path.join(dir, 'fixture.db');
        db = require('../../db');
        raw = new Database(process.env.NEXUS_DB_PATH);
        raw.prepare("INSERT INTO projects(id,name,path,status) VALUES ('p','Project','/p','active'),('retired','Retired','/retired','archived')").run();
        const insert = raw.prepare('INSERT INTO tasks(id,project_id,name,status,description,metadata,dependencies) VALUES (?,?,?,?,?,?,?)');
        raw.transaction(() => {
            for (let i = 0; i < 128; i++) insert.run(`task-${i}`, 'p', `Task ${i}`, 'completed', 'history '.repeat(4096), '{}', '[]');
            insert.run('dependency', 'retired', 'Finished dependency', 'completed', '', '{}', '[]');
            insert.run('ready', 'p', 'Ready', 'todo', 'Keep full detail', '{"work_admission":{"forged":true}}', '["dependency"]');
        })();
        raw.prepare('INSERT INTO work_admissions(task_id,document) VALUES (?,?)').run('ready', '{"decision":"new_work","authoritative":true}');
        raw.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run('{"work_admission":{"forged":true}}', 'task-0');
    });
    afterAll(() => {
        raw.close();
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.NEXUS_DB_PATH;
    });
    test('another request can run while the full board is being read', async () => {
        let eventLoopAvailable = false;
        const heartbeat = new Promise(resolve => setImmediate(() => { eventLoopAvailable = true; resolve(); }));
        const board = await db.getBoardState();
        expect(eventLoopAvailable).toBe(true);
        await heartbeat;
        expect(board).toHaveLength(1);
        expect(board[0].tasks).toHaveLength(129);
        expect(board[0].tasks.find(t => t.id === 'task-0').description).toBe('history '.repeat(4096));
        expect(board[0].tasks.find(t => t.id === 'task-0').metadata).not.toHaveProperty('work_admission');
        expect(board[0].tasks.find(t => t.id === 'ready')).toMatchObject({
            is_unblocked: true, description: 'Keep full detail',
            metadata: { work_admission: { decision: 'new_work', authoritative: true } },
        });
        expect(board[0].task_summary).toMatchObject({ total: 129, complete: 128, unblocked: 1 });
    });
    test('a later read sees committed changes and explicit archived-project reads still work', async () => {
        const before = await db.getBoardState('retired');
        expect(before[0].tasks[0].status).toBe('completed');
        raw.prepare("UPDATE tasks SET status='todo' WHERE id='dependency'").run();
        const after = await db.getBoardState('p');
        expect(after[0].tasks.find(t => t.id === 'ready').is_unblocked).toBe(false);
        expect(await db.getBoardState('missing')).toEqual([]);
    });
    test('concurrent reads coalesce, the queue is bounded, and closing rejects pending reads', async () => {
        const { createBoardReader } = require('../../db/board-reader');
        const reader = createBoardReader(path.join(dir, 'fixture.db'), { maxPending: 1 });
        try {
            const first = reader.read('p');
            expect(reader.read('p')).toBe(first);
            await expect(reader.read('retired')).rejects.toThrow('busy');
            expect((await first)[0].id).toBe('p');
            const pending = reader.read('retired');
            reader.close();
            await expect(pending).rejects.toThrow('closed');
            expect((await reader.read('retired'))[0].id).toBe('retired');
        } finally { reader.close(); }
    });
    test('worker startup and read errors reject instead of reporting an empty board', async () => {
        const { createBoardReader } = require('../../db/board-reader');
        const missing = createBoardReader(path.join(dir, 'does-not-exist.db'));
        try { await expect(missing.read()).rejects.toThrow(); }
        finally { missing.close(); }
        const emptyPath = path.join(dir, 'empty.db');
        new Database(emptyPath).close();
        const empty = createBoardReader(emptyPath);
        try { await expect(empty.read()).rejects.toThrow('no such table'); }
        finally { empty.close(); }
    });
    test('a timed-out worker settles every queued request', async () => {
        const { createBoardReader } = require('../../db/board-reader');
        const reader = createBoardReader(path.join(dir, 'fixture.db'), { timeoutMs: 1 });
        try {
            const results = await Promise.allSettled([reader.read('p'), reader.read('retired')]);
            expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
            expect(results.every(result => result.reason.message === 'Board read timed out')).toBe(true);
        } finally { reader.close(); }
    });
});
