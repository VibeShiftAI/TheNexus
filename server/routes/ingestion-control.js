/**
 * Ingestion Control Routes
 * Proxies the Knowledge Ingestion dashboard page to Praxis's ingestion
 * control API (/ingestion/* on :54322): nightly sources/terms CRUD, run
 * history, per-term knowledge views, and recommendations.
 */
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

function createIngestionControlRouter() {
    const router = express.Router();

    router.get('/overview', (_req, res) => proxyPraxisJson(res, '/ingestion/overview'));
    router.get('/runs', (req, res) => {
        const limit = req.query.limit ? `?limit=${encodeURIComponent(req.query.limit)}` : '';
        proxyPraxisJson(res, `/ingestion/runs${limit}`);
    });
    router.get('/runs/:runId', (req, res) => {
        proxyPraxisJson(res, `/ingestion/runs/${encodeURIComponent(req.params.runId)}`);
    });

    router.post('/sources', (req, res) => {
        proxyPraxisJson(res, '/ingestion/sources', { method: 'POST', body: req.body });
    });
    router.post('/youtube/video', (req, res) => {
        proxyPraxisJson(res, '/ingestion/youtube/video', { method: 'POST', body: req.body });
    });
    router.post('/sources/:name/toggle', (req, res) => {
        proxyPraxisJson(res, `/ingestion/sources/${encodeURIComponent(req.params.name)}/toggle`, { method: 'POST', body: req.body });
    });
    router.post('/sources/:name/cap', (req, res) => {
        proxyPraxisJson(res, `/ingestion/sources/${encodeURIComponent(req.params.name)}/cap`, { method: 'POST', body: req.body });
    });
    router.delete('/sources/:name', (req, res) => {
        proxyPraxisJson(res, `/ingestion/sources/${encodeURIComponent(req.params.name)}`, { method: 'DELETE' });
    });

    router.patch('/config', (req, res) => {
        proxyPraxisJson(res, '/ingestion/config', { method: 'PATCH', body: req.body });
    });

    router.get('/knowledge', (req, res) => {
        const term = req.query.term ? `?term=${encodeURIComponent(req.query.term)}` : '';
        proxyPraxisJson(res, `/ingestion/knowledge${term}`);
    });
    router.post('/knowledge/expand', (req, res) => {
        proxyPraxisJson(res, '/ingestion/knowledge/expand', { method: 'POST', body: req.body });
    });
    router.get('/topic-map', (_req, res) => proxyPraxisJson(res, '/ingestion/topic-map'));

    router.get('/communities', (req, res) => {
        const limit = req.query.limit ? `?limit=${encodeURIComponent(req.query.limit)}` : '';
        proxyPraxisJson(res, `/ingestion/communities${limit}`);
    });
    router.post('/communities/rebuild', (req, res) => {
        proxyPraxisJson(res, '/ingestion/communities/rebuild', { method: 'POST', body: req.body });
    });

    router.get('/recommendations', (_req, res) => proxyPraxisJson(res, '/ingestion/recommendations'));
    router.post('/recommendations/refresh', (req, res) => {
        proxyPraxisJson(res, '/ingestion/recommendations/refresh', { method: 'POST', body: req.body });
    });
    router.post('/recommendations/:id/accept', (req, res) => {
        proxyPraxisJson(res, `/ingestion/recommendations/${encodeURIComponent(req.params.id)}/accept`, { method: 'POST', body: req.body });
    });
    router.post('/recommendations/:id/dismiss', (req, res) => {
        proxyPraxisJson(res, `/ingestion/recommendations/${encodeURIComponent(req.params.id)}/dismiss`, { method: 'POST', body: req.body });
    });

    return router;
}

module.exports = createIngestionControlRouter;
