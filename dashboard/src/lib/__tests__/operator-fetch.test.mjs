import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorFetch, LOCAL_OPERATOR_PROOF_KEY } from '../local-operator-session.ts';
import { dispatchTask } from '../dispatches.ts';
import { addTask } from '../nexus/tasks.ts';

async function browser(origin, run) {
    const priorWindow = globalThis.window, priorFetch = globalThis.fetch;
    const values = new Map();
    globalThis.window = { location: new URL(origin), localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
    } };
    try { await run(values); } finally { globalThis.window = priorWindow; globalThis.fetch = priorFetch; }
}

test('operator mutation establishes the local session and sends its proof without a legacy bearer', async () => {
    await browser('http://localhost:3000/project/joey', async () => {
        const calls = [], proof = 'p'.repeat(43);
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            if (url === '/api/operator-session') return { ok: true, json: async () => ({
                operator: calls.length > 1, expiresAt: Date.now() + 3600000,
                bootstrapUrl: 'http://localhost:4000/api/operator-session/bootstrap',
            }) };
            if (url.endsWith('/bootstrap')) return { ok: true, json: async () => ({ operator: true, proof }) };
            return { ok: true };
        };
        const body = JSON.stringify({ policy: { mode: 'maintenance' }, expectedRevision: null });
        await operatorFetch('/api/praxis/project-maintenance/joey', {
            method: 'PUT', body, headers: new Headers({ 'Content-Type': 'application/json',
                Authorization: 'Bearer obsolete-placeholder', 'X-Nexus-Local-Proof': 'caller-claim' }),
        });
        assert.deepEqual(calls.map(c => c.url), ['/api/operator-session',
            'http://localhost:4000/api/operator-session/bootstrap', '/api/operator-session',
            '/api/praxis/project-maintenance/joey']);
        const request = calls.at(-1).options;
        assert.equal(request.headers.get('X-Nexus-Local-Proof'), proof);
        assert.equal(request.headers.has('Authorization'), false);
        assert.equal(request.headers.get('Content-Type'), 'application/json');
        assert.equal(request.body, body);
        assert.equal(request.credentials, 'include');
        assert.equal(request.redirect, 'error');
    });
});

test('operator reads use existing proof without bootstrapping; foreign destinations cannot receive it', async () => {
    await browser('http://localhost:3000/project/joey', async values => {
        values.set(LOCAL_OPERATOR_PROOF_KEY, 's'.repeat(43));
        const calls = [];
        globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
        await operatorFetch('/api/praxis/project-maintenance/joey');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.headers.get('X-Nexus-Local-Proof'), 's'.repeat(43));
        for (const url of ['https://evil.test/api', '//evil.test/api', 'http://localhost:4000/api', '/api/../secret', '/apix']) {
            await assert.rejects(operatorFetch(url, { method: 'POST' }), /same-origin API/);
        }
        assert.equal(calls.length, 1);
    });
});

test('remote operator requests retain Access cookies without local bootstrap or proof', async () => {
    await browser('https://nexus.vibeshiftai.com/project/joey', async values => {
        values.set(LOCAL_OPERATOR_PROOF_KEY, 's'.repeat(43));
        const calls = [];
        globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
        await operatorFetch('/api/praxis/task/dispatch', { method: 'POST' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.headers.has('X-Nexus-Local-Proof'), false);
        assert.equal(calls[0].options.credentials, 'include');
    });
});

test('the actual operator dispatch client includes proof and preserves its signed request body', async () => {
    await browser('http://localhost:3000/task/example', async values => {
        values.set(LOCAL_OPERATOR_PROOF_KEY, 'd'.repeat(43));
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            return { ok: true, status: 200, json: async () => url === '/api/operator-session'
                ? { operator: true, expiresAt: Date.now() + 3600000 } : { ok: true, reply: 'queued' } };
        };
        await dispatchTask({ taskId: 'example', operator: true, executor: 'codex' });
        assert.equal(calls.length, 2);
        const dispatch = calls.at(-1);
        assert.equal(dispatch.url, '/api/praxis/dispatch/task');
        assert.equal(dispatch.options.headers.get('X-Nexus-Local-Proof'), 'd'.repeat(43));
        assert.equal(dispatch.options.headers.has('Authorization'), false);
        assert.deepEqual(JSON.parse(dispatch.options.body), { taskId: 'example', operator: true, executor: 'codex' });
    });
});

test('refused local bootstrap removes a stale proof and never treats the UI claim as authority', async () => {
    await browser('http://localhost:3000/project/joey', async values => {
        values.set(LOCAL_OPERATOR_PROOF_KEY, 's'.repeat(43));
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            if (url === '/api/operator-session') return { ok: true, json: async () => ({
                operator: false, bootstrapUrl: 'http://localhost:4000/api/operator-session/bootstrap',
            }) };
            return { ok: false, status: 403 };
        };
        const response = await operatorFetch('/api/praxis/project-maintenance/joey', {
            method: 'PUT', headers: { 'X-Nexus-Local-Proof': 'caller-claim' },
        });
        assert.equal(response.status, 403);
        assert.equal(values.has(LOCAL_OPERATOR_PROOF_KEY), false);
        assert.equal(calls.at(-1).options.headers.has('X-Nexus-Local-Proof'), false);
    });
});

test('a board task create asks for operator origin through the verified session, never the legacy bearer', async () => {
    await browser('http://localhost:3000/project/joey', async values => {
        values.set(LOCAL_OPERATOR_PROOF_KEY, 'b'.repeat(43));
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            return { ok: true, status: 200, json: async () => url === '/api/operator-session'
                ? { operator: true, expiresAt: Date.now() + 3600000 }
                : { success: true, task: { id: 't-1' }, operator_origin: { verified: true } } };
        };
        const result = await addTask('joey', 'Try the new layout', 'Robert typed this', null);
        const create = calls.at(-1);
        assert.match(create.url, /^\/api\/projects\/joey\/tasks\?_cb=\d+$/);
        assert.equal(create.options.method, 'POST');
        assert.equal(create.options.headers.get('X-Nexus-Local-Proof'), 'b'.repeat(43));
        assert.equal(create.options.headers.has('Authorization'), false);
        const body = JSON.parse(create.options.body);
        assert.equal(body.operator, true);
        assert.equal(body.title, 'Try the new layout');
        assert.equal('source' in body, false, 'the origin label is the server\'s to record, never the client\'s');
        assert.deepEqual(result.operator_origin, { verified: true });
    });
});
