const express = require('express');
const http = require('http');
const createRouter = require('../routes/automatic-start');

describe('operator automatic-start relay', () => {
    let server, url, calls, signed, auth;
    beforeEach(async () => {
        calls = []; signed = []; auth = { ok: true, actor: { authority: 'access_device' } };
        const app = express(); app.use(express.json());
        app.use(createRouter({
            authorize: async () => auth,
            sign: (message, options) => { signed.push({ message, options }); return { 'X-Praxis-Operator-Provenance': 'signed' }; },
            relay: async (path, options) => { calls.push({ path, options }); return new Response(JSON.stringify({ request: { taskId: 'canva', state: 'waiting' } }), { status: 200 }); },
        }));
        server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
        url = `http://127.0.0.1:${server.address().port}`;
    });
    afterEach(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    test('signs only a verified operator request and preserves exact version', async () => {
        const response = await post(url, { taskId: 'canva', expectedVersion: 7 });
        expect(response.status).toBe(200);
        expect(calls[0].path).toBe('/api/dispatch/automatic-start');
        expect(signed[0]).toEqual({ message: JSON.stringify({ action: 'create', taskId: 'canva', expectedVersion: 7 }), options: { surface: 'automatic-start' } });
    });
    test('accepts version zero for a newly created task', async () => {
        expect((await post(url, { taskId: 'canva', expectedVersion: 0 })).status).toBe(200);
    });
    test('rejects executor identity and cross-site actions before signing', async () => {
        auth.actor.authority = 'document_executor_credential';
        expect((await post(url, { taskId: 'canva', expectedVersion: 7 })).status).toBe(403);
        auth.actor.authority = 'access_user';
        expect((await post(url, { taskId: 'canva', expectedVersion: 7 }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
        expect(calls).toHaveLength(0); expect(signed).toHaveLength(0);
    });
    test('rejects stale-input omissions and force fields', async () => {
        expect((await post(url, { taskId: 'canva' })).status).toBe(400);
        expect((await post(url, { taskId: 'canva', expectedVersion: 7, force: true })).status).toBe(400);
        expect(calls).toHaveLength(0);
    });
    test('cancellation binds the particular saved request', async () => {
        const expectedRequestedAt = '2026-10-08T23:00:00.000Z';
        const response = await fetch(url + '/canva', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRequestedAt }) });
        expect(response.status).toBe(200);
        expect(signed[0].message).toBe(JSON.stringify({ action: 'cancel', taskId: 'canva', expectedRequestedAt }));
    });
});
