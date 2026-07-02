const express = require('express');

const { PRAXIS_URL } = require('../shared/constants');

async function proxyPraxisJson(res, upstreamPath, options = {}) {
    try {
        const response = await fetch(`${PRAXIS_URL}${upstreamPath}`, {
            method: options.method || 'GET',
            headers: {
                Accept: 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        const text = await response.text();
        res.status(response.status);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        res.send(text);
    } catch (err) {
        res.status(502).json({ error: err.message || 'Praxis unreachable' });
    }
}

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
