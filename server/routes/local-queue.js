const express = require('express');

// Status/content-type/body forwarded verbatim, 502 on transport failure —
// the shared Praxis client owns the URL and the error shape (P1-14).
const { praxisProxyJson: proxyPraxisJson } = require('../services/praxis-client');
const { createLocalModelWorkReader } = require('../services/local-model-work');

function createLocalQueueRouter({ readWork = createLocalModelWorkReader() } = {}) {
    const router = express.Router();

    router.get('/work', async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await readWork()); }
        catch { res.status(503).json({ error: 'Local model work unavailable.' }); }
    });
    router.get('/', (req, res) =>
        proxyPraxisJson(res, `/local-llm/queue${req.query.active ? '?active=1' : ''}`));
    router.post('/jobs', (req, res) => proxyPraxisJson(res, '/local-llm/jobs', { method: 'POST', body: req.body }));
    router.post('/jobs/:id/promote', (req, res) => {
        proxyPraxisJson(res, `/local-llm/jobs/${encodeURIComponent(req.params.id)}/promote`, { method: 'POST', body: req.body });
    });
    router.post('/jobs/:id/cancel', (req, res) => {
        proxyPraxisJson(res, `/local-llm/jobs/${encodeURIComponent(req.params.id)}/cancel`, { method: 'POST', body: req.body });
    });
    router.post('/jobs/:id/retry', (req, res) => {
        proxyPraxisJson(res, `/local-llm/jobs/${encodeURIComponent(req.params.id)}/retry`, { method: 'POST', body: req.body });
    });
    for (const action of ['pause', 'resume']) {
        router.post(`/${action}`, async (req, res) => {
            await proxyPraxisJson(res, `/local-llm/${action}`, { method: 'POST', body: req.body });
            readWork.invalidate?.();
        });
    }
    router.post('/calendar/nightly-windows', (req, res) => {
        proxyPraxisJson(res, '/local-llm/calendar/nightly-windows', { method: 'POST', body: req.body });
    });

    return router;
}

module.exports = createLocalQueueRouter;
