const express = require('express');
const createApiRateLimit = require('../middleware/api-rate-limit');
const createHealthRouter = require('../routes/health');

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
