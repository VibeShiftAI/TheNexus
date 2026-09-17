const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');

// Retained actual legacy DDL, including the ineffective second unique index.
const LEGACY_SCHEMA = `CREATE TABLE usage_stats (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    request_count INTEGER DEFAULT 0, source TEXT DEFAULT 'unknown',
    UNIQUE(date, model)
);
CREATE INDEX idx_usage_stats_date ON usage_stats(date);
CREATE UNIQUE INDEX idx_usage_stats_date_model_source ON usage_stats(date, model, source);`;

const insert = (db, id, source, model = 'model-a') => db.prepare(`INSERT INTO usage_stats
    (id, date, model, input_tokens, output_tokens, total_tokens, request_count, source)
    VALUES (?, '2026-09-09', ?, 10, 3, 13, 2, ?)`).run(id, model, source);
const rows = db => db.prepare('SELECT * FROM usage_stats ORDER BY id').all();
const totals = db => db.prepare(`SELECT COUNT(*) AS rows, SUM(input_tokens) AS input,
    SUM(output_tokens) AS output, SUM(total_tokens) AS total, SUM(request_count) AS requests FROM usage_stats`).get();
const schema = db => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();

// A child owns the complete facade lifecycle. No test opens the default DB or
// inherits application paths; all SQLite files are temporary and removed.
function facadeRun(dbPath, code) {
    return execFileSync(process.execPath, ['-e', `
        const facade = require('./db');
        (async () => { ${code} })().catch(e => { console.error(e); process.exitCode = 1; });
    `], { cwd: path.resolve(__dirname, '../..'), env: {
        PATH: process.env.PATH, NEXUS_DB_PATH: dbPath, NODE_ENV: 'test',
    }, encoding: 'utf8', timeout: 15000 });
}

describe('usage identity regression', () => {
    let dir;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

    test('the actual legacy constraints reject a second source for one date/model', () => {
        const db = new Database(':memory:');
        try {
            db.exec(LEGACY_SCHEMA);
            insert(db, 'original', 'praxis');
            expect(() => insert(db, 'second', 'nexus')).toThrow(/UNIQUE constraint failed: usage_stats.date, usage_stats.model/);
            expect(totals(db)).toEqual({ rows: 1, input: 10, output: 3, total: 13, requests: 2 });
        } finally { db.close(); }
    });

    test.each(['legacy', 'fresh'])('facade accumulates repeated calls independently by source on %s startup', variant => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-usage-'));
        const dbPath = path.join(dir, 'fixture.sqlite');
        const raw = new Database(dbPath);
        if (variant === 'legacy') raw.exec(LEGACY_SCHEMA);
        raw.close();
        facadeRun(dbPath, `
            await facade.recordUsage('same-model', 10, 3, 'praxis');
            await facade.recordUsage('same-model', 20, 4, 'nexus');
            await facade.recordUsage('same-model', 7, 2, 'praxis');
            await facade.recordUsage('same-model', 1, 1, null);
            await facade.recordUsage('same-model', 2, 2);
        `);
        const check = new Database(dbPath, { readonly: true });
        try {
            expect(check.prepare('SELECT source, input_tokens, output_tokens, total_tokens, request_count FROM usage_stats ORDER BY source').all()).toEqual([
                { source: 'nexus', input_tokens: 20, output_tokens: 4, total_tokens: 24, request_count: 1 },
                { source: 'praxis', input_tokens: 17, output_tokens: 5, total_tokens: 22, request_count: 2 },
                { source: 'unknown', input_tokens: 3, output_tokens: 3, total_tokens: 6, request_count: 2 },
            ]);
        } finally { check.close(); }
    });

    test('independent concurrent facade writers conserve every call and source total', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-usage-concurrent-'));
        const dbPath = path.join(dir, 'fixture.sqlite');
        facadeRun(dbPath, '');
        const code = `const db = require('./db'); (async () => {
            for (let i = 0; i < 60; i++) await db.recordUsage('concurrent', 2, 1, i % 2 ? 'praxis' : 'nexus');
        })().catch(e => { console.error(e); process.exitCode = 1; });`;
        const results = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['-e', code], {
            cwd: path.resolve(__dirname, '../..'), env: { PATH: process.env.PATH, NEXUS_DB_PATH: dbPath, NODE_ENV: 'test' }, timeout: 15000,
        })));
        for (const result of results) expect(result.stderr).toBe('');
        const check = new Database(dbPath, { readonly: true });
        try {
            expect(totals(check)).toEqual({ rows: 2, input: 360, output: 180, total: 540, requests: 180 });
            expect(check.prepare('SELECT source, request_count FROM usage_stats ORDER BY source').all()).toEqual([
                { source: 'nexus', request_count: 90 }, { source: 'praxis', request_count: 90 },
            ]);
        } finally { check.close(); }
    });

    test('a rejected accumulation rolls back trigger side effects and leaves existing counters intact', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-usage-failure-'));
        const dbPath = path.join(dir, 'fixture.sqlite');
        facadeRun(dbPath, "await facade.recordUsage('reject-model', 10, 3, 'praxis');");
        const raw = new Database(dbPath);
        raw.exec(`CREATE TABLE failed_usage_audit (id TEXT);
            CREATE TRIGGER reject_usage AFTER UPDATE ON usage_stats BEGIN
                INSERT INTO failed_usage_audit VALUES (NEW.id);
                SELECT RAISE(ABORT, 'usage fixture rejection');
            END`);
        const before = rows(raw);
        raw.close();
        const output = facadeRun(dbPath, `
            const errors = [];
            console.error = (...args) => errors.push(args.join(' '));
            await facade.recordUsage('reject-model', 100, 30, 'praxis');
            console.log(JSON.stringify(errors));
        `);
        expect(output).toContain('usage fixture rejection');
        const check = new Database(dbPath, { readonly: true });
        try {
            expect(rows(check)).toEqual(before);
            expect(check.prepare('SELECT * FROM failed_usage_audit').all()).toEqual([]);
        } finally { check.close(); }
    });
});

describe('versioned usage migration', () => {
    let db;
    const migrate = () => {
        expect(() => require('../../db/usage-stats-migration')).not.toThrow();
        return require('../../db/usage-stats-migration').migrateUsageStats(db);
    };
    beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); });
    afterEach(() => db.close());

    test('preserves all legacy rows, ids, totals, extra columns and named indexes on repeated migration', () => {
        db.exec(LEGACY_SCHEMA);
        db.exec("ALTER TABLE usage_stats ADD COLUMN note TEXT DEFAULT 'retained'; CREATE INDEX custom_usage_model ON usage_stats(model DESC)");
        insert(db, 'id-praxis', 'praxis');
        insert(db, 'id-old-source', 'legacy-import', 'model-b');
        const before = rows(db);
        const sums = totals(db);
        expect(migrate()).toMatchObject({ version: 1, rebuilt: true });
        expect(rows(db)).toEqual(before);
        expect(totals(db)).toEqual(sums);
        expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all()).toEqual([
            { name: 'custom_usage_model' }, { name: 'idx_usage_stats_date' }, { name: 'idx_usage_stats_date_model_source' },
        ]);
        const afterSchema = schema(db);
        expect(migrate()).toMatchObject({ version: 1, rebuilt: false });
        expect(schema(db)).toEqual(afterSchema);
        expect(rows(db)).toEqual(before);
        insert(db, 'id-nexus', 'nexus');
        expect(() => insert(db, 'duplicate', 'praxis')).toThrow(/UNIQUE/);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    });

    test('preserves SQL literals that happen to contain the old constraint text', () => {
        db.exec(LEGACY_SCHEMA);
        db.exec("ALTER TABLE usage_stats ADD COLUMN note TEXT DEFAULT 'UNIQUE(date, model)'");
        insert(db, 'original', 'praxis');
        migrate();
        insert(db, 'new', 'nexus');
        expect(db.prepare('SELECT DISTINCT note FROM usage_stats').all()).toEqual([{ note: 'UNIQUE(date, model)' }]);
    });

    test('upgrades pre-source schema with explicit unknown source, retaining counters and ids', () => {
        db.exec(LEGACY_SCHEMA.replace(", source TEXT DEFAULT 'unknown'", '').replace(/CREATE UNIQUE INDEX idx_usage_stats_date_model_source[^;]+;/, ''));
        db.exec("INSERT INTO usage_stats VALUES ('old-id', '2026-09-09', 'model-a', 100, 25, 125, 3)");
        expect(migrate()).toMatchObject({ rebuilt: true });
        expect(rows(db)).toEqual([{ id: 'old-id', date: '2026-09-09', model: 'model-a', input_tokens: 100,
            output_tokens: 25, total_tokens: 125, request_count: 3, source: 'unknown' }]);
        insert(db, 'new-id', 'praxis');
        expect(totals(db)).toEqual({ rows: 2, input: 110, output: 28, total: 138, requests: 5 });
    });

    test('already source-aware schema retains its original rows and DDL', () => {
        db.exec(LEGACY_SCHEMA.replace('UNIQUE(date, model)', 'UNIQUE(date, model, source)'));
        insert(db, 'p', 'praxis'); insert(db, 'n', 'nexus');
        const ddl = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'usage_stats'").get();
        const before = rows(db);
        expect(migrate()).toMatchObject({ rebuilt: false });
        expect(migrate()).toMatchObject({ rebuilt: false });
        expect(rows(db)).toEqual(before);
        expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'usage_stats'").get()).toEqual(ddl);
        expect(db.prepare('SELECT version FROM usage_stats_migrations').all()).toEqual([{ version: 1 }]);
    });

    test('normalizes only NULL source to unknown; empty and historic values remain explicit', () => {
        db.exec(LEGACY_SCHEMA);
        insert(db, 'null-source', null); insert(db, 'empty-source', '', 'model-b');
        expect(migrate()).toMatchObject({ normalizedNullSources: 1 });
        expect(rows(db).map(row => [row.id, row.source])).toEqual([['empty-source', ''], ['null-source', 'unknown']]);
        expect(totals(db)).toEqual({ rows: 2, input: 20, output: 6, total: 26, requests: 4 });
    });

    test.each(['unknown', null])('refuses ambiguous NULL normalization against %s without merging rows', otherSource => {
        db.exec(LEGACY_SCHEMA.replace('UNIQUE(date, model)', 'UNIQUE(date, model, source)'));
        insert(db, 'unknown-a', null); insert(db, 'unknown-b', otherSource);
        const before = { rows: rows(db), schema: schema(db) };
        expect(migrate).toThrow(/ambiguous.*source/i);
        expect({ rows: rows(db), schema: schema(db) }).toEqual(before);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    test('preserves ID references, dependent views and triggers without firing deletion cascades', () => {
        db.exec(LEGACY_SCHEMA);
        insert(db, 'referenced', 'praxis');
        db.exec(`CREATE TABLE receipts (id TEXT PRIMARY KEY, usage_id TEXT REFERENCES usage_stats(id) ON DELETE CASCADE);
            INSERT INTO receipts VALUES ('receipt', 'referenced');
            CREATE TABLE audit (usage_id TEXT);
            CREATE TRIGGER usage_audit AFTER INSERT ON usage_stats BEGIN INSERT INTO audit VALUES (NEW.id); END;
            CREATE VIEW usage_report AS SELECT id, total_tokens FROM usage_stats;
            CREATE TRIGGER receipt_audit AFTER INSERT ON receipts BEGIN UPDATE usage_stats SET request_count = request_count + 1 WHERE id = NEW.usage_id; END;`);
        const objectSql = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type IN ('view', 'trigger') ORDER BY name").all();
        migrate();
        expect(db.prepare('SELECT * FROM receipts').all()).toEqual([{ id: 'receipt', usage_id: 'referenced' }]);
        expect(db.prepare('SELECT * FROM audit').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM usage_report').all()).toEqual([{ id: 'referenced', total_tokens: 13 }]);
        expect(db.prepare("SELECT name, sql FROM sqlite_schema WHERE type IN ('view', 'trigger') ORDER BY name").all()).toEqual(objectSql);
        insert(db, 'new', 'nexus');
        expect(db.prepare('SELECT * FROM audit').all()).toEqual([{ usage_id: 'new' }]);
        db.exec("INSERT INTO receipts VALUES ('receipt-2', 'new')");
        expect(db.prepare("SELECT request_count FROM usage_stats WHERE id = 'new'").get().request_count).toBe(3);
        expect(db.pragma('foreign_key_check')).toEqual([]);
    });

    test('rolls back a failure after swapping the table, including original indexes/triggers and migration stamp', () => {
        db.exec(LEGACY_SCHEMA); insert(db, 'original', 'praxis');
        db.exec('CREATE TRIGGER preserve_me AFTER UPDATE ON usage_stats BEGIN SELECT 1; END');
        const before = { rows: rows(db), schema: schema(db) };
        const exec = db.exec.bind(db);
        let dropped = false;
        const spy = jest.spyOn(db, 'exec').mockImplementation(sql => {
            if (/DROP TABLE usage_stats\b/i.test(sql)) dropped = true;
            if (dropped && /CREATE (?:UNIQUE )?INDEX/i.test(sql)) throw new Error('injected index creation failure');
            return exec(sql);
        });
        try { expect(migrate).toThrow('injected index creation failure'); } finally { spy.mockRestore(); }
        expect(dropped).toBe(true);
        expect({ rows: rows(db), schema: schema(db) }).toEqual(before);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(db.pragma('legacy_alter_table', { simple: true })).toBe(0);
        expect(db.inTransaction).toBe(false);
        expect(migrate()).toMatchObject({ rebuilt: true });
    });

    test('refuses references to the obsolete date/model identity and rolls back', () => {
        db.exec(LEGACY_SCHEMA); insert(db, 'original', 'praxis');
        db.exec(`CREATE TABLE old_receipts (date TEXT, model TEXT, FOREIGN KEY (date, model) REFERENCES usage_stats(date, model));
            INSERT INTO old_receipts VALUES ('2026-09-09', 'model-a')`);
        const before = { rows: rows(db), schema: schema(db) };
        expect(migrate).toThrow(/foreign key mismatch/i);
        expect({ rows: rows(db), schema: schema(db) }).toEqual(before);
        expect(db.pragma('foreign_key_check')).toEqual([]);
    });

    test('refuses nested transactions before changing foreign-key enforcement or schema', () => {
        db.exec(LEGACY_SCHEMA);
        const before = schema(db);
        db.transaction(() => { expect(migrate).toThrow(/outside.*transaction/i); })();
        expect(schema(db)).toEqual(before);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });
});
