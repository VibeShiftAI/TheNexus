/** Optional listener containing only the compiled presentation receiver and scoped reads. */
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { sendPresentationAsset, presentationHeaders, presentationErrors, noQuery } = require('./routes/presentations');
const { presentationError } = require('./services/presentation-data');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function receiverConfiguration(env = process.env) {
    const host = env.NEXUS_PRESENTATION_RECEIVER_HOST || '127.0.0.1';
    const rawPort = env.NEXUS_PRESENTATION_RECEIVER_PORT;
    if (!rawPort) return { enabled: false, port: null, host: '127.0.0.1', origin: null };
    if (!/^[1-9]\d*$/.test(rawPort) || Number(rawPort) > 65535 || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new Error('Invalid presentation receiver listener configuration.');
    const port = Number(rawPort);
    const rawOrigin = env.NEXUS_PRESENTATION_RECEIVER_ORIGIN || (LOOPBACK.has(host) ? `http://${host === '::1' ? '[::1]' : host}:${port}` : null);
    if (!rawOrigin) throw new Error('A non-loopback presentation listener requires an explicit HTTPS receiver origin.');
    let url;
    try { url = new URL(rawOrigin); } catch { throw new Error('Invalid presentation receiver origin.'); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The receiver origin must be HTTPS (except loopback), with no path or credentials.');
    return { enabled: true, host, port, origin: url.origin };
}

function bearer(req) {
    const header = req.get('authorization');
    const match = typeof header === 'string' && /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(header);
    return match ? match[1] : null;
}

function createPresentationReceiverApp({ service, staticDir = path.resolve(__dirname, '../dashboard/public/presentation') }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);
    app.use(presentationHeaders);
    app.use((req, res, next) => {
        const sdk = req.path === '/presentation/cast.html' ? ' https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/' : '';
        const ipc = req.path === '/presentation/cast.html' ? ' ws://localhost:8008/v2/ipc' : '';
        res.set('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'${sdk}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self' blob:${ipc}; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        res.set('Cross-Origin-Resource-Policy', 'same-origin');
        res.set('Cross-Origin-Opener-Policy', 'same-origin');
        next();
    });
    app.use(noQuery);
    app.use('/receiver', (req, res, next) => {
        const origin = req.get('origin');
        const allowed = new Set([service.config().receiverOrigin, `http://127.0.0.1:${req.socket.localPort}`, `http://localhost:${req.socket.localPort}`, `http://[::1]:${req.socket.localPort}`]);
        if ((origin && !allowed.has(origin)) || req.get('sec-fetch-site') === 'cross-site') {
            return res.status(403).json({ code: 'origin_denied', error: 'Receiver requests must come from this receiver origin.' });
        }
        next();
    });
    app.use('/receiver', express.json({ limit: '4kb' }));
    app.post('/receiver/pairings', (req, res) => res.status(201).json(service.enroll(req.body, req.socket.remoteAddress)));
    app.get('/receiver/pairings/:code', (req, res) => res.json(service.poll(req.params.code, bearer(req), req.socket.remoteAddress)));
    app.get('/receiver/view', async (req, res) => res.json(await service.view(service.receiverSession(bearer(req)), { receiver: true })));
    app.get('/receiver/asset', (req, res) => sendPresentationAsset(service, service.receiverSession(bearer(req)), req, res));
    app.get('/', (_req, res) => res.redirect('/presentation/index.html'));
    app.get('/presentation/:file', (req, res, next) => {
        // No source maps, arbitrary files, nested paths, or general Next.js app.
        if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:html|js|css|woff2?|wasm|bcmap|pfb|ttf|png)$/.test(req.params.file)
            || (req.params.file.endsWith('.html') && !['index.html', 'cast.html'].includes(req.params.file))) return next();
        res.sendFile(req.params.file, { root: staticDir, dotfiles: 'deny', cacheControl: false, lastModified: false, etag: false }, error => {
            if (error && !res.headersSent) next(presentationError('not_found', 404, 'Receiver asset not found.'));
        });
    });
    app.use((_req, res) => res.status(404).json({ code: 'not_found', error: 'Receiver endpoint not found.' }));
    app.use(presentationErrors);
    return app;
}

function startPresentationReceiver({ service, env = process.env, configuration = receiverConfiguration(env), staticDir } = {}) {
    if (!configuration.enabled) return null;
    const server = http.createServer(createPresentationReceiverApp({ service, staticDir }));
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 40;
    server.on('error', () => console.warn('[Presentations] Receiver listener unavailable; no general API listener was changed.'));
    server.listen(configuration.port, configuration.host, () => console.log('[Presentations] Isolated receiver listener enabled. Reachability requires the configured deployment route.'));
    return server;
}

module.exports = { createPresentationReceiverApp, receiverConfiguration, startPresentationReceiver };
