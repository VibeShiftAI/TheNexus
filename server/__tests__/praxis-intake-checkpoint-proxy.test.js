/**
 * The project page reads Intake (a project's first checkpoint) from Praxis
 * through this relay: GET /api/praxis/projects/:id/intake-checkpoint.
 */
const express = require('express');

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () =>
            resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
}
const close = (handle) => new Promise((resolve) => {
    handle.server.closeAllConnections?.();
    handle.server.close(resolve);
});

describe('praxis relay: intake checkpoint', () => {
    test('forwards the read to Praxis and returns its answer and status unchanged', async () => {
        const seen = [];
        const praxis = express();
        praxis.get('/stream', (_req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(': connected\n\n');
        });
        praxis.get('/api/projects/:id/intake-checkpoint', (req, res) => {
            seen.push({ method: req.method, id: req.params.id });
            if (req.params.id === 'missing') return res.status(404).json({ error: 'not on the board' });
            res.json({ project_id: req.params.id, intake_checkpoint: { id: 'intake', status: 'current', stages: [] }, current_checkpoint: { id: 'intake', title: 'Intake', source: 'intake' } });
        });
        const praxisHandle = await listen(praxis);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;
        jest.resetModules();
        const createPraxisStreamRouter = require('../routes/praxis-stream');
        const app = express();
        app.use(express.json());
        app.use('/api/praxis', createPraxisStreamRouter({ db: {} }));
        const handle = await listen(app);
        try {
            const ok = await fetch(`${handle.baseUrl}/api/praxis/projects/p%201/intake-checkpoint`);
            expect(ok.status).toBe(200);
            expect(await ok.json()).toMatchObject({ project_id: 'p 1', current_checkpoint: { source: 'intake' } });
            const missing = await fetch(`${handle.baseUrl}/api/praxis/projects/missing/intake-checkpoint`);
            expect(missing.status).toBe(404);
            expect(seen).toEqual([{ method: 'GET', id: 'p 1' }, { method: 'GET', id: 'missing' }]);
        } finally {
            await close(handle);
            await close(praxisHandle);
            delete process.env.PRAXIS_URL;
        }
    });
});
