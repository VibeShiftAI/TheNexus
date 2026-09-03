const express = require('express');

// Status/content-type/body forwarded verbatim, 502 on transport failure —
// the shared Praxis client owns the URL and the error shape (P1-14).
const { praxisProxyJson: proxyPraxisJson } = require('../services/praxis-client');

function createLocalQueueRouter() {
    const router = express.Router();

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
    router.post('/pause', (req, res) => proxyPraxisJson(res, '/local-llm/pause', { method: 'POST', body: req.body }));
    router.post('/resume', (req, res) => proxyPraxisJson(res, '/local-llm/resume', { method: 'POST', body: req.body }));
    router.post('/calendar/nightly-windows', (req, res) => {
        proxyPraxisJson(res, '/local-llm/calendar/nightly-windows', { method: 'POST', body: req.body });
    });

    return router;
}

module.exports = createLocalQueueRouter;
