const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

describe('Nexus lease enforcement across real HTTP, SQLite and workspace files', () => {
    let dir, db, raw, server, base, previousPath;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lease-http-'));
        previousPath = process.env.NEXUS_DB_PATH;
        process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
        jest.resetModules();
        db = require('../../db');
        raw = new Database(process.env.NEXUS_DB_PATH);
        raw.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
        raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('11111111-1111-4111-8111-111111111111', 'Fixture', dir);
        const app = express();
        app.use(express.json());
        const deps = { db, PROJECT_ROOT: dir, getProjectById: () => db.getProject('11111111-1111-4111-8111-111111111111'), getAllProjects: () => db.getProjects() };
        app.use('/api/write-leases', require('../routes/write-leases')({ db }));
        app.use('/api/projects', require('../routes/projects')(deps));
        const tasks = require('../routes/tasks')(deps);
        app.use('/api/tasks', tasks);
        app.use('/api/projects', tasks);
        app.use('/api/tools', require('../routes/tools')(deps));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        raw?.close();
        if (previousPath === undefined) delete process.env.NEXUS_DB_PATH;
        else process.env.NEXUS_DB_PATH = previousPath;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
        raw.exec('DELETE FROM write_leases; DELETE FROM write_lease_requests; DELETE FROM tasks');
        await db.createTask({ id: 'task-1', project_id: '11111111-1111-4111-8111-111111111111', name: 'Original', status: 'todo' });
        fs.writeFileSync(path.join(dir, 'note.txt'), 'Original', 'utf8');
    });
    async function request(url, method = 'GET', body, headers = {}) {
        const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: res.status, body: await res.json() };
    }
    async function acquire(scope, extra = {}) {
        const res = await request('/api/write-leases', 'POST', { scope, owner: 'fixture', ...extra });
        expect(res.status).toBe(201);
        return res.body.lease;
    }

    test('owner edits succeed; competing HTTP and direct DB writes fail without changing a task', async () => {
        const lease = await acquire('board');
        const loser = await request('/api/tasks/task-1', 'PATCH', { title: 'Loser' });
        expect(loser.status).toBe(409);
        expect(loser.body.code).toBe('write_lease_conflict');
        expect(JSON.stringify(loser.body)).not.toContain(lease.token);
        await expect(db.updateTask('task-1', { name: 'Bypass' })).rejects.toMatchObject({ code: 'write_lease_conflict' });
        expect((await db.getTask('task-1')).name).toBe('Original');
        const owner = await request('/api/tasks/task-1', 'PATCH', { title: 'Owner', expected_version: 0 }, { 'x-nexus-board-lease': lease.token });
        expect(owner.status).toBe(200);
        expect(owner.body.task.name).toBe('Owner');
        expect((await request('/api/tasks/task-1', 'PATCH', { title: 'Stale', expected_version: 0 }, { 'x-nexus-board-lease': lease.token })).status).toBe(409);
        expect((await request('/api/write-leases', 'DELETE', { token: lease.token })).status).toBe(200);
        expect((await request('/api/tasks/task-1', 'PATCH', { title: 'After release' })).status).toBe(200);
    });

    test('a repeated POST with the same request_id and owner returns the same lease; GET and 409 bodies hide it', async () => {
        const request_id = 'praxis-0123456789abcdef';
        const lease = await acquire('board', { request_id });
        expect(lease.request_id).toBe(request_id);
        const replay = await acquire('board', { request_id });
        expect(replay.token).toBe(lease.token);
        const other = await request('/api/write-leases', 'POST', { scope: 'board', owner: 'someone-else' });
        expect(other.status).toBe(409);
        expect(other.body.code).toBe('write_lease_conflict');
        const reused = await request('/api/write-leases', 'POST', { scope: 'board', owner: 'someone-else', request_id });
        expect(reused.status).toBe(409);
        expect(reused.body.code).toBe('write_lease_lost');
        const status = await request('/api/write-leases?scope=board');
        expect(status.body.leases).toHaveLength(1);
        for (const body of [other.body, reused.body, status.body]) {
            expect(JSON.stringify(body)).not.toContain(lease.token);
            expect(JSON.stringify(body)).not.toContain(request_id);
        }
    });

    test('a client that drops the POST before reading the answer can release the grant by request_id', async () => {
        const request_id = 'praxis-dropped-0123456789';
        const body = JSON.stringify({ scope: 'board', owner: 'praxis:fixture', ttl_ms: 300000, request_id });
        const { port } = server.address();
        await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/api/write-leases', method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
            req.on('error', () => {}); // the client gives up; any socket error is expected
            req.on('response', () => reject(new Error('client must not read the answer')));
            req.end(body, () => { req.destroy(); resolve(); });
        });
        const granted = Date.now() + 5000;
        while (raw.prepare('SELECT count(*) AS n FROM write_leases').get().n === 0) {
            if (Date.now() > granted) throw new Error('server never processed the dropped POST');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        // The orphan: the server granted a lease the client never received.
        expect((await request('/api/tasks/task-1', 'PATCH', { title: 'Blocked' })).status).toBe(409);
        const released = await request('/api/write-leases', 'DELETE', { request_id });
        expect(released).toEqual({ status: 200, body: { success: true, released: true } });
        expect((await request('/api/tasks/task-1', 'PATCH', { title: 'Unblocked' })).status).toBe(200);
        expect((await request('/api/write-leases', 'DELETE', { request_id })).body).toEqual({ success: true, released: false });
    });

    test('a release by request_id that arrives before its POST stops the POST from granting', async () => {
        const request_id = 'praxis-early-release-0123';
        expect((await request('/api/write-leases', 'DELETE', { request_id })).body).toEqual({ success: true, released: false });
        const late = await request('/api/write-leases', 'POST', { scope: 'board', owner: 'praxis:fixture', request_id });
        expect(late.status).toBe(409);
        expect(late.body.code).toBe('write_lease_lost');
        expect((await request('/api/write-leases?scope=board')).body.leases).toEqual([]);
        expect((await request('/api/tasks/task-1', 'PATCH', { title: 'Free' })).status).toBe(200);
    });

    test.each([
        [{ token: 'some-token', request_id: 'praxis-0123456789abcdef' }],
        [{ request_id: 'short' }],
        [{ scope: 'board', request_id: 42 }],
    ])('lease API rejects malformed request_id use %p', async body => {
        const method = body.scope ? 'POST' : 'DELETE';
        const result = await request('/api/write-leases', method, body);
        expect(result.status).toBe(400);
        expect(result.body.code).toBe('invalid_write_lease');
    });

    test.each([
        ['/api/tasks/reorder', 'PATCH', { ordering: [{ id: 'task-1', sort_order: 9 }] }],
        ['/api/tasks/batch', 'POST', { project_id: '11111111-1111-4111-8111-111111111111', tasks: [{ name: 'Extra' }] }],
        ['/api/projects/11111111-1111-4111-8111-111111111111/tasks/task-1', 'PATCH', { title: 'Clobber' }],
        ['/api/projects/11111111-1111-4111-8111-111111111111/tasks/task-1', 'DELETE', {}],
        ['/api/projects/11111111-1111-4111-8111-111111111111', 'PATCH', { description: 'Clobber' }],
        ['/api/projects/11111111-1111-4111-8111-111111111111/archive', 'POST', {}],
        ['/api/projects/11111111-1111-4111-8111-111111111111', 'DELETE', {}],
    ])('board lease covers alternate mutation %s', async (url, method, body) => {
        await acquire('board');
        expect((await request(url, method, body)).status).toBe(409);
        expect((await db.getTask('task-1')).name).toBe('Original');
        expect(await db.getProject('11111111-1111-4111-8111-111111111111')).toBeTruthy();
    });

    test('reorder works for a lease owner and is not swallowed by the task-id PATCH route', async () => {
        const lease = await acquire('board');
        const result = await request('/api/tasks/reorder', 'PATCH', { ordering: [{ id: 'task-1', sort_order: 7 }] }, { 'x-nexus-board-lease': lease.token });
        expect(result.status).toBe(200);
        expect((await db.getTask('task-1')).sort_order).toBe(7);
    });

    test('workspace lease rejects file writes and shell commands; owner can write and renew', async () => {
        const lease = await acquire('workspace', { path: dir });
        const target = path.join(dir, 'note.txt');
        expect((await request('/api/tools/write-file', 'POST', { path: target, content: 'Loser' })).status).toBe(409);
        expect((await request('/api/tools/run-command', 'POST', { cwd: dir, command: 'echo unexpected' })).status).toBe(409);
        expect(fs.readFileSync(target, 'utf8')).toBe('Original');
        expect((await request('/api/tools/write-file', 'POST', { path: target, content: 'Owner' }, { 'x-nexus-workspace-lease': lease.token })).status).toBe(200);
        expect(fs.readFileSync(target, 'utf8')).toBe('Owner');
        expect((await request('/api/write-leases', 'PATCH', { token: lease.token, ttl_ms: 60000 })).status).toBe(200);
        const status = await request('/api/write-leases?scope=workspace&path=' + encodeURIComponent(dir));
        expect(JSON.stringify(status.body)).not.toContain(lease.token);
    });

    test.each(['write_file', 'patch_file', 'append_file', 'apply_diff', 'edit_lines'])('%s cannot bypass a workspace lease', async name => {
        const lease = await acquire('workspace', { path: dir });
        const tool = require('../tools/filesystem').find(tool => tool.name === name);
        const args = { project_name: 'Fixture', path: 'note.txt', content: 'Loser', replacements: [{ find: 'Original', replace: 'Loser' }],
            diff: '<<<<<<< SEARCH\nOriginal\n=======\nLoser\n>>>>>>> REPLACE', start_line: 1, end_line: 1, new_content: 'Loser' };
        const result = await tool.execute(args, { getProjectPath: () => dir, writeLeases: db.writeLeases });
        expect(result.isError).toBe(true);
        expect(result.code).toBe('write_lease_conflict');
        expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('Original');
        const owner = await tool.execute({ ...args, lease_token: lease.token }, { getProjectPath: () => dir, writeLeases: db.writeLeases });
        expect(owner.isError).not.toBe(true);
        expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toContain('Loser');
    });

    test('workspace lease prevents project deletion before either board or files change', async () => {
        await acquire('workspace', { path: dir });
        expect((await request('/api/projects/11111111-1111-4111-8111-111111111111?deleteFiles=true', 'DELETE')).status).toBe(409);
        expect(await db.getProject('11111111-1111-4111-8111-111111111111')).toBeTruthy();
        expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('Original');
    });

    test('expired workspace token returns conflict and preserves bytes even without a successor', async () => {
        const lease = await acquire('workspace', { path: dir });
        raw.prepare('UPDATE write_leases SET expires_at = 0 WHERE token = ?').run(lease.token);
        expect((await request('/api/tools/write-file', 'POST', { path: path.join(dir, 'note.txt'), content: 'Stale' }, { 'x-nexus-workspace-lease': lease.token })).status).toBe(409);
        expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('Original');
        expect((await request('/api/tools/write-file', 'POST', { path: path.join(dir, 'note.txt'), content: 'Fresh' })).status).toBe(200);
    });

    test('direct context projection refuses a workspace lease before database or file writes', async () => {
        await acquire('workspace', { path: dir });
        await expect(db.updateProjectContext('11111111-1111-4111-8111-111111111111', 'product', 'Must not write')).rejects.toMatchObject({ code: 'write_lease_conflict' });
        expect(fs.existsSync(path.join(dir, '.context', 'product.md'))).toBe(false);
        expect(raw.prepare('SELECT count(*) AS n FROM project_contexts').get().n).toBe(0);
    });

    test('context owner can write the projection and database together', async () => {
        const lease = await acquire('workspace', { path: dir });
        const result = await request('/api/projects/11111111-1111-4111-8111-111111111111/context', 'POST', { type: 'product', content: 'Context owner' }, { 'x-nexus-workspace-lease': lease.token });
        expect(result.status).toBe(200);
        expect(fs.readFileSync(path.join(dir, '.context', 'product.md'), 'utf8')).toContain('Context owner');
        expect(raw.prepare('SELECT content FROM project_contexts').get().content).toBe('Context owner');
    });

    test('reserved stakeholder mutations cannot bypass the board lease', async () => {
        await acquire('board');
        expect(() => db.proposeStakeholderAction('task-1', {})).toThrow(expect.objectContaining({ code: 'write_lease_conflict' }));
        expect(() => db.decideStakeholderProposal('task-1', {}, {})).toThrow(expect.objectContaining({ code: 'write_lease_conflict' }));
        expect(() => db.recordStakeholderReceipt('task-1', {})).toThrow(expect.objectContaining({ code: 'write_lease_conflict' }));
    });

    test('command tool honors workspace ownership and writes only for the owner', async () => {
        const lease = await acquire('workspace', { path: dir });
        const tool = require('../tools/command')[0];
        const args = { project_name: 'Fixture', command: 'printf command > command.txt' };
        const context = { getProjectPath: () => dir, writeLeases: db.writeLeases };
        expect(await tool.execute(args, context)).toMatchObject({ isError: true, code: 'write_lease_conflict' });
        expect(fs.existsSync(path.join(dir, 'command.txt'))).toBe(false);
        expect((await tool.execute({ ...args, lease_token: lease.token }, context)).isError).not.toBe(true);
        expect(fs.readFileSync(path.join(dir, 'command.txt'), 'utf8')).toBe('command');
    });

    test('context sync and its standalone file writer reject an existing workspace owner', async () => {
        await acquire('workspace', { path: dir });
        const sync = require('../services/context-sync');
        await expect(sync.pullAndSyncFromGit('11111111-1111-4111-8111-111111111111', dir, db)).rejects.toMatchObject({ code: 'write_lease_conflict' });
        await expect(sync.writeContextFile(dir, 'workflow', 'Clobber', 'draft', { writeLeases: db.writeLeases })).rejects.toMatchObject({ code: 'write_lease_conflict' });
        expect(fs.existsSync(path.join(dir, '.context', 'workflow.md'))).toBe(false);
    });

    test('context projection cannot follow a file symlink outside the project lease', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-outside-'));
        const target = path.join(outside, 'locked.md');
        const link = path.join(dir, '.context', 'symlink.md');
        fs.writeFileSync(target, 'Protected', 'utf8');
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(target, link);
        try {
            await acquire('workspace', { path: outside });
            await expect(db.updateProjectContext('11111111-1111-4111-8111-111111111111', 'symlink', 'Clobber')).rejects.toMatchObject({ status: 400 });
            const sync = require('../services/context-sync');
            await expect(sync.writeContextFile(dir, 'symlink', 'Clobber', 'draft', { writeLeases: db.writeLeases })).rejects.toMatchObject({ status: 400 });
            await expect(db.updateProjectContext('11111111-1111-4111-8111-111111111111', '../../escape', 'Clobber')).rejects.toMatchObject({ status: 400 });
            expect(fs.readFileSync(target, 'utf8')).toBe('Protected');
        } finally { fs.unlinkSync(link); fs.rmSync(outside, { recursive: true, force: true }); }
    });
});
