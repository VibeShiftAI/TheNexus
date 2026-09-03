const express = require('express');
const http = require('http');

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

function close(handle) {
    for (const socket of handle.sockets) socket.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

describe('praxis-client', () => {
    let praxisHandle;
    const originalEnv = process.env.PRAXIS_URL;

    afterEach(async () => {
        if (praxisHandle) await close(praxisHandle);
        praxisHandle = null;
        if (originalEnv === undefined) delete process.env.PRAXIS_URL;
        else process.env.PRAXIS_URL = originalEnv;
        jest.resetModules();
    });

    it('resolves PRAXIS_URL from the environment at call time, then constants', () => {
        delete process.env.PRAXIS_URL;
        const { praxisUrl } = require('../services/praxis-client');
        expect(praxisUrl()).toBe(require('../shared/constants').PRAXIS_URL);
        process.env.PRAXIS_URL = 'http://praxis.test:1';
        expect(praxisUrl()).toBe('http://praxis.test:1');
    });

    it('JSON-encodes object bodies, passes raw strings through, and returns the raw Response', async () => {
        const app = express();
        app.use(express.json());
        const seen = [];
        app.post('/echo', (req, res) => {
            seen.push({ ct: req.get('content-type'), body: req.body, extra: req.get('x-extra') });
            res.status(201).json({ ok: true });
        });
        praxisHandle = await listen(app);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;
        const { praxisFetch } = require('../services/praxis-client');

        const r1 = await praxisFetch('/echo', { method: 'POST', body: { a: 1 }, headers: { 'X-Extra': 'y' } });
        expect(r1.status).toBe(201);
        const r2 = await praxisFetch('/echo', { method: 'POST', body: JSON.stringify({ b: 2 }), headers: { 'Content-Type': 'application/json' } });
        expect(r2.status).toBe(201);
        expect(seen).toEqual([
            { ct: 'application/json', body: { a: 1 }, extra: 'y' },
            { ct: 'application/json', body: { b: 2 }, extra: undefined },
        ]);
    });

    it('does not throw on non-2xx (proxies forward status) but praxisJson does', async () => {
        const app = express();
        app.get('/nope', (_req, res) => res.status(418).json({ error: 'teapot' }));
        praxisHandle = await listen(app);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;
        const { praxisFetch, praxisJson, PraxisError } = require('../services/praxis-client');

        const res = await praxisFetch('/nope');
        expect(res.status).toBe(418);

        await expect(praxisJson('/nope')).rejects.toMatchObject({
            name: 'PraxisError', code: 'PRAXIS_HTTP_ERROR', status: 418, path: '/nope', method: 'GET',
        });
        await expect(praxisJson('/nope')).rejects.toBeInstanceOf(PraxisError);
    });

    it('wraps transport failures in PraxisError with the original message', async () => {
        process.env.PRAXIS_URL = 'http://127.0.0.1:9';
        const { praxisFetch } = require('../services/praxis-client');
        let caught;
        try { await praxisFetch('/ping', { timeoutMs: 2000 }); } catch (err) { caught = err; }
        expect(caught.name).toBe('PraxisError');
        expect(caught.code).toBe('PRAXIS_UNREACHABLE');
        expect(caught.status).toBeNull();
        expect(caught.path).toBe('/ping');
        expect(caught.message).toBe(caught.cause.message);
    });

    it('applies the per-call timeout via AbortSignal.timeout and reports PRAXIS_TIMEOUT', async () => {
        const app = express();
        app.get('/slow', () => { /* never answers */ });
        praxisHandle = await listen(app);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;
        const { praxisFetch } = require('../services/praxis-client');
        await expect(praxisFetch('/slow', { timeoutMs: 50 })).rejects.toMatchObject({ code: 'PRAXIS_TIMEOUT', path: '/slow' });
    });

    it('praxisProxyJson forwards status/body and answers 502 when Praxis is down', async () => {
        const app = express();
        app.get('/thing', (_req, res) => res.status(404).json({ error: 'missing' }));
        praxisHandle = await listen(app);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;
        const { praxisProxyJson } = require('../services/praxis-client');

        const fakeRes = () => {
            const r = { headers: {}, statusCode: 200 };
            r.status = (c) => { r.statusCode = c; return r; };
            r.setHeader = (k, v) => { r.headers[k] = v; };
            r.send = (b) => { r.body = b; };
            r.json = (b) => { r.body = b; };
            return r;
        };
        const ok = fakeRes();
        await praxisProxyJson(ok, '/thing');
        expect(ok.statusCode).toBe(404);
        expect(JSON.parse(ok.body)).toEqual({ error: 'missing' });

        await close(praxisHandle);
        praxisHandle = null;
        const down = fakeRes();
        await praxisProxyJson(down, '/thing');
        expect(down.statusCode).toBe(502);
        expect(down.body).toHaveProperty('error');
    });

    it('praxisStream opens a raw http request and hands the caller the live response', async () => {
        const app = express();
        let seenHeaders;
        app.get('/stream', (req, res) => {
            seenHeaders = req.headers;
            res.setHeader('Content-Type', 'text/event-stream');
            res.write('id: 1\nevent: ping\ndata: {"n":1}\n\n');
            setTimeout(() => res.end(), 20);
        });
        praxisHandle = await listen(app);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;
        const { praxisStream } = require('../services/praxis-client');

        const chunks = await new Promise((resolve, reject) => {
            const req = praxisStream('/stream', { headers: { Accept: 'text/event-stream', 'Last-Event-ID': '0' } }, (res) => {
                const got = [];
                res.setEncoding('utf8');
                res.on('data', (c) => got.push(c));
                res.on('end', () => resolve(got));
            });
            req.on('error', reject);
        });
        expect(chunks.join('')).toContain('data: {"n":1}');
        expect(seenHeaders['last-event-id']).toBe('0');
        expect(seenHeaders.accept).toBe('text/event-stream');
    });
});
