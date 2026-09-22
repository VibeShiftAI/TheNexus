const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('durable write leases', () => {
    let dir, a, b, first, second, time;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-leases-'));
        a = new Database(path.join(dir, 'leases.db'));
        b = new Database(path.join(dir, 'leases.db'));
        time = 10000;
        const { createWriteLeases } = require('../../db/write-leases');
        first = createWriteLeases(a, { now: () => time });
        second = createWriteLeases(b, { now: () => time });
    });
    afterEach(() => {
        a.close(); b.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const board = { scope: 'board' };

    test('independent connections cannot acquire the same board; inspection hides tokens', () => {
        const lease = first.acquire(board, { owner: 'writer-a' });
        expect(() => second.acquire(board, { owner: 'writer-a' })).toThrow(expect.objectContaining({ code: 'write_lease_conflict' }));
        expect(second.inspect(board)).toEqual([expect.objectContaining({ owner: 'writer-a' })]);
        expect(JSON.stringify(second.inspect(board))).not.toContain(lease.token);
        expect(() => second.release('wrong-token')).toThrow();
        first.release(lease.token);
        expect(second.acquire(board).token).not.toBe(lease.token);
    });

    test('expired tokens cannot mutate, renew, release a successor, or silently reacquire', () => {
        const lease = first.acquire(board, { ttl_ms: 1000 });
        time += 1000;
        const next = second.acquire(board);
        const write = jest.fn();
        expect(() => first.runSync(board, write, { token: lease.token })).toThrow();
        expect(() => first.renew(lease.token)).toThrow();
        expect(() => first.release(lease.token)).toThrow();
        expect(write).not.toHaveBeenCalled();
        expect(second.renew(next.token).token).toBe(next.token);
    });

    test('renew extends ownership; expiry without a successor still rejects the old token', () => {
        const lease = first.acquire(board, { ttl_ms: 1000 });
        time += 900;
        first.renew(lease.token, 2000);
        time += 1100;
        expect(() => second.acquire(board)).toThrow();
        time += 900;
        expect(() => first.runSync(board, () => {}, { token: lease.token })).toThrow();
        expect(second.acquire(board)).toBeDefined();
    });

    test('directory, child and symlink aliases contend; siblings are independent', () => {
        const real = path.join(dir, 'workspace');
        fs.mkdirSync(real);
        fs.symlinkSync(real, path.join(dir, 'alias'));
        const lease = first.acquire({ scope: 'workspace', path: real });
        expect(() => second.acquire({ scope: 'workspace', path: path.join(dir, 'alias', 'new', 'file.txt') })).toThrow();
        expect(() => second.acquire({ scope: 'workspace', path: dir })).toThrow();
        expect(second.acquire({ scope: 'workspace', path: real + '-other' })).toBeDefined();
        expect(first.runSync({ scope: 'workspace', path: path.join(real, 'file.txt') }, () => 'ok', { token: lease.token })).toBe('ok');
        expect(() => first.runSync(board, () => {}, { token: lease.token })).toThrow();
    });

    test('new case aliases share ownership even before the target exists', () => {
        first.acquire({ scope: 'workspace', path: path.join(dir, 'NewFile.txt') });
        expect(() => second.acquire({ scope: 'workspace', path: path.join(dir, 'newfile.txt') })).toThrow();
    });

    test('a dangling symlink shares the target lease before either target exists', () => {
        const target = path.join(dir, 'future.txt');
        const alias = path.join(dir, 'alias.txt');
        fs.symlinkSync(target, alias);
        first.acquire({ scope: 'workspace', path: target });
        expect(() => second.acquire({ scope: 'workspace', path: alias })).toThrow();
    });

    test('a foreground command remains exclusive across expiry in another process', async () => {
        const { spawn } = require('child_process');
        const { workspaceCommand } = require('../lib/write-leases');
        const leases = require('../../db/write-leases').createWriteLeases(a);
        const target = path.join(dir, 'finished.txt');
        const r = { scope: 'workspace', path: dir };
        const owner = leases.acquire(r, { ttl_ms: 1000 });
        const script = `
            const Database = require('better-sqlite3');
            const db = new Database(process.argv[1]);
            db.pragma('busy_timeout = 1');
            const leases = require(process.argv[2]).createWriteLeases(db);
            process.stdout.write('ready\\n');
            const timer = setInterval(() => {
                try {
                    leases.acquire({scope:'workspace', path:process.argv[3]});
                    process.stdout.write(JSON.stringify({afterWrite:require('fs').existsSync(process.argv[4])}));
                    clearInterval(timer); db.close();
                } catch (error) {
                    if (!error.code.startsWith('write_lease')) throw error;
                }
            }, 10);
            setTimeout(() => process.exit(2), 8000).unref();
        `;
        const child = spawn(process.execPath, ['-e', script, path.join(dir, 'leases.db'), require.resolve('../../db/write-leases'), dir, target], { cwd: process.cwd() });
        let output = '', errors = '';
        const completed = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error(errors || `child exited ${code}`)));
        });
        child.stderr.on('data', data => { errors += data; });
        await new Promise(resolve => child.stdout.on('data', data => { output += data; if (output.includes('ready\n')) resolve(); }));
        try {
            await leases.run(r, () => workspaceCommand(leases, dir, process.execPath,
                ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'finished'), 1300)", target]), { token: owner.token });
            await completed;
            expect(output).toContain('"afterWrite":true');
        } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    }, 10000);

    test('async ownership spans awaits, nests within its context, and releases on throw', async () => {
        let enter, finish;
        const entered = new Promise(resolve => { enter = resolve; });
        const wait = new Promise(resolve => { finish = resolve; });
        const work = first.run(board, async () => {
            expect(first.runSync(board, () => 42)).toBe(42);
            enter();
            await wait;
            throw new Error('operation failed');
        });
        await entered;
        expect(() => first.runSync(board, () => {})).toThrow();
        finish();
        await expect(work).rejects.toThrow('operation failed');
        expect(second.inspect(board)).toEqual([]);
    });

    test('a delayed async writer is fenced at the actual write after takeover', async () => {
        await first.run(board, async () => {
            time += 30001;
            const next = second.acquire(board);
            expect(() => first.runSync(board, () => { throw new Error('must not run'); })).toThrow(expect.objectContaining({ code: 'write_lease_lost' }));
            second.release(next.token);
        });
    });

    test('an HTTP disconnect during resource lookup cannot leave an automatic lease alive', async () => {
        const { EventEmitter } = require('events');
        const { requestLease } = require('../lib/write-leases');
        let resume;
        const lookup = new Promise(resolve => { resume = resolve; });
        const req = { method: 'POST', path: '/', get: () => undefined };
        const res = new EventEmitter();
        const next = jest.fn();
        const done = requestLease({ writeLeases: first }, async () => { await lookup; return board; })(req, res, next);
        res.destroyed = true;
        res.emit('close');
        resume();
        await new Promise(resolve => setImmediate(resolve));
        try {
            expect(first.inspect(board)).toEqual([]);
            expect(next).not.toHaveBeenCalled();
        } finally { res.emit('finish'); await done; }
    });

    test.each([0, -1, 999, 300001, NaN, '1000'])('rejects invalid TTL %s', ttl_ms => {
        expect(() => first.acquire(board, { ttl_ms })).toThrow(expect.objectContaining({ status: 400 }));
    });
});
