const express = require('express');
const http = require('http');

describe('ingestion control route', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    async function withServer(handler) {
        const createIngestionControlRouter = require('../routes/ingestion-control');
        const app = express();
        app.use(express.json({ limit: '50mb' })); // as server.js: transcripts exceed the 100 KB default
        app.use('/api/ingestion-control', createIngestionControlRouter());
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        try {
            await handler(`http://127.0.0.1:${port}`);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }

    test('proxies single YouTube video ingestion to Praxis', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, options) => {
            if (String(url).includes('/api/ingestion-control/')) {
                return originalFetch(url, options);
            }
            calls.push({ url, options });
            return new Response(JSON.stringify({ ok: true }), {
                status: 202,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        await withServer(async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/ingestion-control/youtube/video`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc123XYZ_0' }),
            });

            expect(response.status).toBe(202);
            expect(await response.json()).toEqual({ ok: true });
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(/\/ingestion\/youtube\/video$/);
        expect(calls[0].options.method).toBe('POST');
        expect(JSON.parse(calls[0].options.body)).toEqual({ url: 'https://www.youtube.com/watch?v=abc123XYZ_0' });
    });

    test('proxies a pasted transcript and passes Praxis refusals through', async () => {
        const calls = [];
        const transcript = '0:00\n' + 'A long pasted transcript line. '.repeat(4000);
        global.fetch = jest.fn(async (url, options) => {
            if (String(url).includes('/api/ingestion-control/')) {
                return originalFetch(url, options);
            }
            calls.push({ url, options });
            const duplicate = calls.length > 1;
            return new Response(JSON.stringify(duplicate
                ? { ok: false, duplicate: true, error: '"Talk" is already in the knowledge base.' }
                : { ok: true, title: 'Talk', runId: 'run_x' }), {
                status: duplicate ? 409 : 202,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        await withServer(async (baseUrl) => {
            const send = () => fetch(`${baseUrl}/api/ingestion-control/transcript`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: transcript, url: 'https://youtu.be/abc123XYZ_0', note: 'worth keeping' }),
            });
            const first = await send();
            expect(first.status).toBe(202);
            expect(await first.json()).toEqual({ ok: true, title: 'Talk', runId: 'run_x' });
            const second = await send();
            expect(second.status).toBe(409);
            expect((await second.json()).error).toMatch(/already in the knowledge base/);
        });

        expect(calls[0].url).toMatch(/\/ingestion\/transcript$/);
        expect(JSON.parse(calls[0].options.body)).toEqual({ text: transcript, url: 'https://youtu.be/abc123XYZ_0', note: 'worth keeping' });
    });
});
