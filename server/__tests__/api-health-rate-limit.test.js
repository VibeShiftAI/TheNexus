const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const createApiRateLimit = require('../middleware/api-rate-limit');
const createHealthRouter = require('../routes/health');

test('the dashboard paces its turn reads from the allowance this limiter publishes', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../dashboard/src/lib/chat-turn-steps.ts'), 'utf8');
    const fallback = source.match(/API_ALLOWANCE_FALLBACK = \{ limit: ([\d_]+), windowMs: ([\d_]+) \}/);
    expect(fallback).not.toBeNull();
    const [limit, windowMs] = fallback.slice(1).map(value => Number(value.replaceAll('_', '')));
    const app = express();
    app.use('/api', createApiRateLimit());
    app.get('/api/ai/chat/turns/:id', (_req, res) => res.json({ state: 'in_progress' }));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/chat/turns/synthetic`);
        expect(response.status).toBe(200);
        expect(response.headers.get('ratelimit-limit')).toBe(String(limit));
        expect(response.headers.get('ratelimit-policy')).toBe(`${limit};w=${windowMs / 1000}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('exhausting the activity quota leaves the supervisor probe available with its own bounded quota', async () => {
    const app = express();
    app.use('/api', createApiRateLimit(1));
    app.use('/api/health', createHealthRouter());
    app.get('/api/ag/events', (_req, res) => res.json([]));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const get = path => fetch(`http://127.0.0.1:${server.address().port}/api/${path}`);
    try {
        expect((await get('ag/events')).status).toBe(200);
        expect((await get('ag/events')).status).toBe(429);
        expect((await get('health')).status).toBe(200);
        expect((await get('health')).status).toBe(429);
        expect((await get('ag/events')).status).toBe(429);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
