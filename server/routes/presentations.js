const express = require('express');
const fs = require('node:fs');
const { createOperatorAuthenticator } = require('../services/operator-access');
const { presentationError } = require('../services/presentation-data');

function noQuery(req, _res, next) {
    if (Object.keys(req.query).length) return next(presentationError('invalid_request', 400, 'Presentation scope cannot be changed by URL parameters.'));
    next();
}

function presentationHeaders(_req, res, next) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
}

function presentationErrors(error, _req, res, _next) {
    if (res.headersSent) return res.destroy();
    for (const name of ['Content-Length', 'Content-Range', 'Content-Disposition']) res.removeHeader(name);
    res.type('json');
    if (error.presentation) return res.status(error.status).json({ code: error.code, error: error.message });
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') return res.status(400).json({ code: 'invalid_request', error: 'Invalid presentation request.' });
    // Filesystem paths, document contents, and credentials never appear in errors.
    return res.status(503).json({ code: 'presentation_unavailable', error: 'The presentation data is temporarily unavailable.' });
}

function sendPresentationAsset(service, id, req, res) {
    const asset = service.asset(id);
    const total = asset.byteLength;
    let start = 0;
    let end = total - 1;
    res.set('Accept-Ranges', 'bytes');
    if (req.get('range')) {
        const ranges = req.range(total, { combine: false });
        if (!Array.isArray(ranges) || ranges.type !== 'bytes' || ranges.length !== 1) {
            return res.status(416).set('Content-Range', `bytes */${total}`).end();
        }
        ({ start, end } = ranges[0]);
        res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`);
    }
    res.set('Content-Type', asset.mimeType);
    res.set('Content-Length', String(end - start + 1));
    res.set('Content-Disposition', 'inline');
    if (req.method === 'HEAD') return res.end();
    if (asset.bytes) return res.end(asset.bytes.subarray(start, end + 1));
    let stream;
    const unwatch = service.watch(id, () => { stream?.destroy(); res.destroy(); });
    stream = fs.createReadStream(asset.path, { start, end });
    const cleanup = () => { unwatch(); stream.destroy(); };
    res.once('close', cleanup);
    res.once('finish', cleanup);
    stream.once('error', () => {
        unwatch();
        if (!res.headersSent) res.removeHeader('Content-Length');
        presentationErrors(presentationError('asset_unavailable', 409, 'The captured media is unavailable.'), req, res);
    });
    stream.pipe(res);
}

function createPresentationRouter({ service, authenticateOperator = createOperatorAuthenticator() }) {
    const router = express.Router();
    router.use(presentationHeaders);
    router.use(async (req, res, next) => {
        let accepted = false;
        try { accepted = await authenticateOperator(req); } catch { /* Authentication fails closed. */ }
        if (!accepted) return res.status(401).json({ code: 'operator_required', error: 'A verified operator session is required.' });
        next();
    });
    router.use(noQuery);
    router.use(express.json({ limit: '64kb' }));
    router.get('/config', (_req, res) => res.json(service.config()));
    router.get('/inventory', (_req, res) => res.json({ inventories: service.inventories() }));
    router.put('/inventory', (req, res) => res.json(service.inventory(req.body)));
    router.get('/sessions', (_req, res) => res.json({ sessions: service.sessions() }));
    router.post('/sessions', async (req, res) => res.status(201).json(await service.start(req.body)));
    router.get('/sessions/:id', (req, res) => res.json(service.session(req.params.id)));
    router.post('/sessions/:id/heartbeat', (req, res) => res.json(service.heartbeat(req.params.id, req.body)));
    router.delete('/sessions/:id', (req, res) => res.json(service.stop(req.params.id)));
    router.get('/sessions/:id/view', async (req, res) => res.json(await service.view(req.params.id)));
    router.get('/sessions/:id/asset', (req, res) => sendPresentationAsset(service, req.params.id, req, res));
    router.post('/pairings/:code/claim', async (req, res) => res.status(201).json(await service.claim(req.params.code, req.body, req.socket.remoteAddress)));
    router.use((_req, res) => res.status(404).json({ code: 'not_found', error: 'Presentation endpoint not found.' }));
    router.use(presentationErrors);
    return router;
}

module.exports = createPresentationRouter;
module.exports.sendPresentationAsset = sendPresentationAsset;
module.exports.presentationHeaders = presentationHeaders;
module.exports.presentationErrors = presentationErrors;
module.exports.noQuery = noQuery;
