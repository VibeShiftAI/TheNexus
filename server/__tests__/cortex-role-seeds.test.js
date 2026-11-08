/**
 * TheCortex model-control roles (task 42706754, 2026-11-07): cortex.query_expand
 * and cortex.entity_extract are seeded so the dashboard lists them, and
 * ingestion.graphiti seeds on the local default (Robert: "Switch to local and
 * seed"). The seed is INSERT OR IGNORE: re-running it is a no-op and never
 * overwrites an operator's assignment. Runs on a temp database with the real
 * db facade, resolver and GET /roles route.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const CORTEX_ROLES = ['cortex.entity_extract', 'cortex.query_expand', 'ingestion.graphiti'];

function freshDbFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cortex-roles-'));
    return { dir, file: path.join(dir, 'nexus.db') };
}

function loadDb(file) {
    process.env.NEXUS_DB_PATH = file;
    jest.resetModules();
    return require('../../db');
}

function readRoles(file) {
    const raw = new Database(file, { readonly: true });
    try {
        return raw.prepare(
            "SELECT role, assignment, description, is_active, created_at, updated_at FROM model_roles ORDER BY role"
        ).all();
    } finally {
        raw.close();
    }
}

describe('cortex model-control role seeds', () => {
    let tmp;
    beforeEach(() => { tmp = freshDbFile(); });
    afterEach(() => {
        delete process.env.NEXUS_DB_PATH;
        jest.resetModules();
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    });

    test('a fresh database seeds both cortex roles and Graphiti on the local default', async () => {
        const db = loadDb(tmp.file);
        const byRole = Object.fromEntries((await db.getModelRoles(false)).map(r => [r.role, r]));
        for (const role of CORTEX_ROLES) {
            expect(byRole[role]).toBeDefined();
            expect(byRole[role].assignment).toBe('alias:local_default');
            expect(byRole[role].is_active).toBeTruthy();
        }
    });

    test('each seeded role resolves to the local Gemma model through local_default', async () => {
        const db = loadDb(tmp.file);
        const { resolveModelAssignment } = require('../services/model-control');
        for (const role of CORTEX_ROLES) {
            const r = await resolveModelAssignment(db, { role });
            expect(r.requestedAssignment).toBe('alias:local_default');
            expect(r.provider).toBe('local');
            expect(r.resolvedModelId).toBe('local-gemma-4-31b');
            expect(r.apiModelId).toBe('google/gemma-4-31b-qat');
            expect(r.fallbackUsed).toBe(false);
        }
    });

    test('re-running the seed is a no-op: same rows, same timestamps', async () => {
        loadDb(tmp.file);
        const first = readRoles(tmp.file);
        loadDb(tmp.file); // a second boot runs runModelControlMigrations again
        loadDb(tmp.file);
        expect(readRoles(tmp.file)).toEqual(first);
        expect(first.filter(r => CORTEX_ROLES.includes(r.role))).toHaveLength(3);
    });

    test('an existing database keeps operator assignments for all three roles', async () => {
        loadDb(tmp.file);
        const raw = new Database(tmp.file);
        const tune = raw.prepare("UPDATE model_roles SET assignment = ?, description = ? WHERE role = ?");
        tune.run('cli:antigravity/gemini-3.8-flash@low', 'operator pick', 'ingestion.graphiti');
        tune.run('model:openrouter-auto-free', 'operator pick', 'cortex.query_expand');
        tune.run('cli:codex/gpt-6-astra@low', 'operator pick', 'cortex.entity_extract');
        raw.close();

        const db = loadDb(tmp.file);
        const byRole = Object.fromEntries((await db.getModelRoles(false)).map(r => [r.role, r]));
        expect(byRole['ingestion.graphiti'].assignment).toBe('cli:antigravity/gemini-3.8-flash@low');
        expect(byRole['cortex.query_expand'].assignment).toBe('model:openrouter-auto-free');
        expect(byRole['cortex.entity_extract'].assignment).toBe('cli:codex/gpt-6-astra@low');
        for (const role of CORTEX_ROLES) expect(byRole[role].description).toBe('operator pick');
    });

    test('GET /api/model-control/roles lists both cortex roles with their resolved local model', async () => {
        const db = loadDb(tmp.file);
        const createModelControlRouter = require('../routes/model-control');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db, syncModelSources: async () => {}, callAI: async () => ({}), io: null }));
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/model-control/roles`);
            expect(res.status).toBe(200);
            const { roles } = await res.json();
            for (const role of CORTEX_ROLES) {
                const row = roles.find(r => r.role === role);
                expect(row).toMatchObject({
                    assignment: 'alias:local_default',
                    resolvedProvider: 'local',
                    resolvedModel: 'google/gemma-4-31b-qat',
                });
            }
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
