const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');

describe('linked QA improvement creation', () => {
    let db, raw, server, base, dir, oldDbPath;
    const project = '11111111-1111-4111-8111-111111111111';
    const link = { parentTaskId: 'parent', finalizationId: 'a'.repeat(64) };
    const proposal = extra => ({ project_id: project, title: 'Improve error recovery', source: 'praxis',
        description: 'Exercise failed network requests and retain the pending form.', metadata: { qaImprovement: link }, ...extra });
    async function post(body) {
        const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    }
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-qa-linked-'));
        oldDbPath = process.env.NEXUS_DB_PATH;
        process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
        jest.resetModules(); db = require('../../db'); raw = new Database(process.env.NEXUS_DB_PATH);
        const app = express(); app.use(express.json());
        app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir }));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}/api/tasks`;
    });
    afterAll(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); raw.close();
        if (oldDbPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = oldDbPath;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
        raw.exec('DELETE FROM tasks; DELETE FROM projects;');
        raw.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run(project, 'Project', '/tmp/synthetic-qa');
        await db.createTask({ id: 'parent', project_id: project, name: 'Original task', status: 'completed' });
    });
    test('lost-response retry returns the same child without modifying either task', async () => {
        const parent = await db.getTask('parent');
        const first = await post(proposal());
        expect(first.status).toBe(201);
        expect(first.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const persisted = await db.getTask(first.body.id);
        const retry = await post(proposal({ title: 'Changed retry must not overwrite original' }));
        expect(retry.status).toBe(200);
        expect(retry.body.id).toBe(first.body.id);
        expect(await db.getTask(first.body.id)).toEqual(persisted);
        expect(await db.getTask('parent')).toEqual(parent);
        expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(2);
    });
    test.each([null, [], {}, { ...link, finalizationId: 'bad' }, { ...link, parentTaskId: ' ' }, { ...link, approved: true }])('rejects malformed link %j', async qaImprovement => {
        expect((await post(proposal({ metadata: { qaImprovement } }))).status).toBe(400);
        expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
    });
    test.each(['missing', 'active', 'other-project'])('requires completed same-project parent: %s', async variant => {
        if (variant === 'missing') raw.prepare('DELETE FROM tasks WHERE id = ?').run('parent');
        if (variant === 'active') await db.updateTask('parent', { status: 'todo' });
        if (variant === 'other-project') {
            raw.prepare("INSERT INTO projects (id,name,path) VALUES ('other','Other','/tmp/other')").run();
            await db.updateTask('parent', { project_id: 'other' });
        }
        expect((await post(proposal())).status).toBe(variant === 'missing' ? 404 : 409);
    });
    test('rejects an ID collision with a different immutable link', async () => {
        const first = await post(proposal());
        raw.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ qaImprovement: { ...link, finalizationId: 'b'.repeat(64) } }), first.body.id);
        const before = await db.getTask(first.body.id);
        expect((await post(proposal())).status).toBe(409);
        expect(await db.getTask(first.body.id)).toEqual(before);
    });
    test.each([{}, { qaImprovement: { ...link, finalizationId: 7 } }])('collision with corrupt or absent link is a conflict: %j', async metadata => {
        const first = await post(proposal());
        raw.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), first.body.id);
        expect((await post(proposal())).status).toBe(409);
    });
    test('overlapping requests and retries create at most one linked child under the board lease', async () => {
        const responses = await Promise.all([post(proposal()), post(proposal()), post(proposal())]);
        expect(responses.some(result => result.status === 201)).toBe(true);
        for (const response of responses) expect([200, 201, 409]).toContain(response.status);
        const retry = await post(proposal());
        expect(retry.status).toBe(200);
        expect(new Set(responses.filter(r => r.status < 300).map(r => r.body.id))).toEqual(new Set([retry.body.id]));
        expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(2);
    });
    test('uppercase finalization retry reuses the same identity', async () => {
        const first = await post(proposal());
        const retry = await post(proposal({ metadata: { qaImprovement: { ...link, finalizationId: link.finalizationId.toUpperCase() } } }));
        expect(retry.status).toBe(200);
        expect(retry.body.id).toBe(first.body.id);
    });
    test('distinct finalizations produce distinct normal admitted tasks', async () => {
        const first = await post(proposal());
        const second = await post(proposal({ description: 'Exercise failed network requests and retain pending form data across reloads.', metadata: { qaImprovement: { ...link, finalizationId: 'b'.repeat(64) } } }));
        expect(second.status).toBe(201);
        expect(second.body.id).not.toBe(first.body.id);
        expect(second.body.metadata.work_admission).toMatchObject({ owner: 'work-admission', decision: 'needs_evidence' });
        expect(second.body.source).toBe('praxis');
        expect(second.body.status).toBe('planning');
    });
    test('existing normal work identity cannot be relabeled as a linked child', async () => {
        const work_identity = { proposal_id: 'already-reserved', acceptance: ['Failure retains the pending form.'] };
        const existing = await post(proposal({ metadata: { work_identity } }));
        const before = await db.getTask(existing.body.id);
        const result = await post(proposal({ metadata: { work_identity, qaImprovement: link } }));
        expect(result.status).toBe(409);
        expect(await db.getTask(existing.body.id)).toEqual(before);
        expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(2);
    });
});
