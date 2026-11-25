/**
 * DELETE /api/model-control/roles/:role (task 7266e9f3, 2026-11-25): the
 * supported way to remove a role row nothing uses any more, added so the
 * retired trading.council row could be removed without editing the database
 * by hand. Runs on a temp database with the real db facade and router.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

function freshDbFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-role-delete-'));
    return { dir, file: path.join(dir, 'nexus.db') };
}

function loadDb(file) {
    process.env.NEXUS_DB_PATH = file;
    jest.resetModules();
    return require('../../db');
}

async function withServer(db, fn) {
    const createModelControlRouter = require('../routes/model-control');
    const app = express();
    app.use(express.json());
    app.use('/api/model-control', createModelControlRouter({ db, syncModelSources: async () => {}, callAI: async () => ({}), io: null }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        return await fn(`http://127.0.0.1:${server.address().port}/api/model-control`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('model-control role delete', () => {
    let tmp;
    beforeEach(() => { tmp = freshDbFile(); });
    afterEach(() => {
        delete process.env.NEXUS_DB_PATH;
        jest.resetModules();
        fs.rmSync(tmp.dir, { recursive: true, force: true });
    });

    test('deletes an unseeded role, answers with the row as it was, and the role stays gone after a reboot', async () => {
        const db = loadDb(tmp.file);
        await db.upsertModelRole({ role: 'trading.council', assignment: 'cli:codex/gpt-6.2-astra@high', description: 'Trading council' });
        const before = (await db.getModelRoles(false)).map(r => r.role);
        expect(before).toContain('trading.council');

        await withServer(db, async (base) => {
            const res = await fetch(`${base}/roles/trading.council`, { method: 'DELETE' });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.deleted).toMatchObject({ role: 'trading.council', assignment: 'cli:codex/gpt-6.2-astra@high', description: 'Trading council' });

            const list = await fetch(`${base}/roles`);
            expect(list.status).toBe(200);
            const { roles } = await list.json();
            expect(roles.map(r => r.role)).not.toContain('trading.council');
            // Every other role is still there.
            expect(roles.map(r => r.role).sort()).toEqual(before.filter(r => r !== 'trading.council').sort());
        });

        // A second boot runs the migrations and seed again; nothing re-creates the row.
        const rebooted = loadDb(tmp.file);
        expect(await rebooted.getModelRole('trading.council')).toBeNull();
    });

    test('a role that does not exist answers 404 and changes nothing', async () => {
        const db = loadDb(tmp.file);
        const before = await db.getModelRoles(false);
        await withServer(db, async (base) => {
            const res = await fetch(`${base}/roles/no.such.role`, { method: 'DELETE' });
            expect(res.status).toBe(404);
            expect(await res.json()).toEqual({ error: 'role_not_found', role: 'no.such.role' });
        });
        expect(await db.getModelRoles(false)).toEqual(before);
    });
});
