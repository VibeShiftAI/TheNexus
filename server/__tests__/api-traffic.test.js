const express = require('express');
const { createHmac } = require('node:crypto');
const createApiRateLimit = require('../middleware/api-rate-limit');

test('a browser refusal preserves the authenticated local runtime lane and logs the refusal', async () => {
    const previous = process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    const key = 'test-runtime-key'.repeat(3);
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = key;
    const proof = createHmac('sha256', key).update('nexus:request-allowance:v1').digest('hex');
    const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const app = express();
    app.use('/api', createApiRateLimit(1));
    app.get('/api/tasks', (_req, res) => res.json([]));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const get = headers => fetch(`http://127.0.0.1:${server.address().port}/api/tasks?private=omit`, { headers });
    try {
        expect((await get({ 'x-nexus-runtime-traffic': proof })).status).toBe(200);
        expect((await get({ 'user-agent': 'Mozilla/5.0' })).status).toBe(200);
        const denied = await get({ 'user-agent': 'Mozilla/5.0' });
        expect(denied.status).toBe(429);
        expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
        expect((await get({ 'x-nexus-runtime-traffic': 'invalid' })).status).toBe(429);
        expect((await get({ 'x-nexus-runtime-traffic': proof })).status).toBe(200);
        expect((await get({ authorization: `Bearer ${key}` })).status).toBe(200);
        expect(log).toHaveBeenCalledWith('[ApiRateLimit]', expect.objectContaining({
            caller: 'browser', route: '/api/tasks', reason: 'window_exhausted'
        }));
        const healthUrl = `http://127.0.0.1:${server.address().port}/api/health`;
        await fetch(healthUrl);
        expect((await fetch(healthUrl, { headers: { 'x-nexus-runtime-traffic': proof } })).status).toBe(429);
        expect(log).toHaveBeenCalledWith('[ApiRateLimit]', expect.objectContaining({
            caller: 'praxis-runtime', route: '/api/health', lane: 'health', reason: 'window_exhausted',
        }));
        expect(JSON.stringify(log.mock.calls)).not.toContain('private=omit');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previous === undefined) delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
        else process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = previous;
        log.mockRestore();
    }
});
