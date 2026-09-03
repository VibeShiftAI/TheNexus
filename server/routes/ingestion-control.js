/**
 * Ingestion Control Routes
 * Proxies the Knowledge Ingestion dashboard page to Praxis's ingestion
 * control API (/ingestion/* on :54322): nightly sources/terms CRUD, run
 * history, per-term knowledge views, and recommendations.
 */
const express = require('express');

// Status/content-type/body forwarded verbatim, 502 on transport failure —
// the shared Praxis client owns the URL and the error shape (P1-14).
const { praxisProxyJson: proxyPraxisJson } = require('../services/praxis-client');

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
