/**
 * Praxis Stream Relay (Phase 3)
 *
 * Opens a single upstream SSE connection to Praxis (`${PRAXIS_URL}/stream`) and
 * re-fans the events out to every connected dashboard/mobile client that hits
 * `/api/praxis/stream`. This is the off-LAN-friendly boundary: mobile doesn't
 * have to know Praxis's address, and we get one place to add auth later.
 *
 * Upstream reconnect: if Praxis drops, we reconnect with exponential backoff
 * and carry `Last-Event-ID` so the ring-buffer replay on Praxis fills gaps.
 *
 * Snapshot endpoint: GET /api/praxis/stream/snapshot proxies Praxis's
 * `/presence` so clients can bootstrap state before subscribing.
 */
const express = require('express');
const http = require('http');
const { URL } = require('url');

const PRAXIS_URL = process.env.PRAXIS_URL || 'http://127.0.0.1:54322';
const UPSTREAM_PATH = '/stream';
const SNAPSHOT_PATH = '/presence';
const RING_BUFFER_SIZE = 500;
const HEARTBEAT_MS = 15000;

function createPraxisStreamRouter({ io, pushService } = {}) {
    const router = express.Router();

    // Per-process state: one upstream connection, N downstream subscribers.
    const subscribers = new Set();
    const ring = [];
    let lastEventId = null;
    let upstreamReq = null;
    let reconnectTimer = null;
    let backoffMs = 1000;
    let upstreamAlive = false;
    const pushedHitlIds = new Set();

    function pushEventToRing(event) {
        ring.push(event);
        if (ring.length > RING_BUFFER_SIZE) ring.shift();
    }

    function broadcast(event) {
        pushEventToRing(event);
        for (const res of subscribers) {
            try {
                res.write(`id: ${event.eventId}\n`);
                res.write(`event: ${event.type}\n`);
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch (_err) {
                // Downstream write errors trigger 'close' on their own.
            }
        }
        // Mirror to socket.io for clients that can't easily consume SSE (mobile).
        if (io) {
            try { io.emit('praxis:event', event); } catch (_err) { /* best-effort */ }
        }
        notifyHitlCreated(event);
    }

    function notifyHitlCreated(event) {
        if (!pushService || event?.type !== 'hitl.created' || !event.request?.id) return;
        const request = event.request;
        if (pushedHitlIds.has(request.id)) return;
        pushedHitlIds.add(request.id);
        pushService.notify({
            title: 'Praxis needs input',
            body: request.question || request.reason || 'Human input required',
            data: {
                type: 'hitl_request',
                hitlId: request.id,
                taskId: request.taskId,
                route: '/(tabs)/praxis',
            },
            channelId: 'praxis-agent',
            categoryId: 'hitl-response',
        }).catch((err) => {
            console.warn(`[PraxisStream] HITL push failed: ${err.message}`);
            pushedHitlIds.delete(request.id);
        });
    }

    async function proxyJson(req, res, upstreamPath) {
        try {
            const options = { method: req.method, headers: { Accept: 'application/json' } };
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                options.headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify(req.body ?? {});
            }
            const response = await fetch(`${PRAXIS_URL}${upstreamPath}`, options);
            const text = await response.text();
            res.status(response.status);
            res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
            res.send(text);
        } catch (err) {
            res.status(502).json({ error: err.message || 'Praxis unreachable' });
        }
    }

    function connectUpstream() {
        if (upstreamReq) return;
        const url = new URL(UPSTREAM_PATH, PRAXIS_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                Accept: 'text/event-stream',
                'Cache-Control': 'no-cache',
            },
        };
        if (lastEventId) options.headers['Last-Event-ID'] = lastEventId;

        upstreamReq = http.request(options, (res) => {
            if (res.statusCode !== 200) {
                console.warn(`[PraxisStream] upstream returned ${res.statusCode}, will retry`);
                res.resume();
                scheduleReconnect();
                return;
            }
            upstreamAlive = true;
            backoffMs = 1000;
            console.log('[PraxisStream] connected to Praxis /stream');

            res.setEncoding('utf8');
            let buf = '';
            res.on('data', (chunk) => {
                buf += chunk;
                let idx;
                while ((idx = buf.indexOf('\n\n')) !== -1) {
                    const raw = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const parsed = parseSseFrame(raw);
                    if (!parsed) continue;
                    if (parsed.id) lastEventId = parsed.id;
                    if (!parsed.data) continue;
                    try {
                        const event = JSON.parse(parsed.data);
                        broadcast(event);
                    } catch (err) {
                        console.warn(`[PraxisStream] bad JSON frame: ${err.message}`);
                    }
                }
            });

            res.on('end', () => {
                console.warn('[PraxisStream] upstream closed');
                upstreamAlive = false;
                upstreamReq = null;
                scheduleReconnect();
            });
            res.on('error', (err) => {
                console.warn(`[PraxisStream] upstream error: ${err.message}`);
                upstreamAlive = false;
                upstreamReq = null;
                scheduleReconnect();
            });
        });

        upstreamReq.on('error', (err) => {
            console.warn(`[PraxisStream] upstream connect error: ${err.message}`);
            upstreamAlive = false;
            upstreamReq = null;
            scheduleReconnect();
        });
        upstreamReq.end();
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        const delay = Math.min(backoffMs, 30_000);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectUpstream();
        }, delay);
        if (reconnectTimer.unref) reconnectTimer.unref();
        backoffMs = Math.min(backoffMs * 2, 30_000);
    }

    function parseSseFrame(raw) {
        const out = { id: null, event: null, data: null };
        const dataLines = [];
        for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue; // comment/keepalive
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const field = line.slice(0, colon);
            const value = line.slice(colon + 1).replace(/^ /, '');
            if (field === 'id') out.id = value;
            else if (field === 'event') out.event = value;
            else if (field === 'data') dataLines.push(value);
        }
        if (dataLines.length > 0) out.data = dataLines.join('\n');
        return out.id || out.event || out.data ? out : null;
    }

    // Kick off on first router mount.
    connectUpstream();

    // ── Client-facing SSE ────────────────────────────────────────
    router.get('/stream', (req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        res.write(': connected\n\n');

        // Optional replay for clients reconnecting with Last-Event-ID.
        const sinceId = req.header('Last-Event-ID') || req.query.lastEventId;
        if (sinceId) {
            const idx = ring.findIndex((e) => e.eventId === sinceId);
            if (idx >= 0) {
                for (const event of ring.slice(idx + 1)) {
                    res.write(`id: ${event.eventId}\n`);
                    res.write(`event: ${event.type}\n`);
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
            }
        }

        subscribers.add(res);

        const heartbeat = setInterval(() => {
            try { res.write(': hb\n\n'); } catch (_err) { /* swallowed */ }
        }, HEARTBEAT_MS);
        if (heartbeat.unref) heartbeat.unref();

        const cleanup = () => {
            clearInterval(heartbeat);
            subscribers.delete(res);
        };
        req.on('close', cleanup);
        req.on('aborted', cleanup);
        res.on('close', cleanup);
    });

    // ── Snapshot bootstrap ───────────────────────────────────────
    router.get('/snapshot', async (_req, res) => {
        try {
            const response = await fetch(`${PRAXIS_URL}${SNAPSHOT_PATH}`);
            if (!response.ok) {
                return res.status(502).json({ error: `Praxis returned ${response.status}` });
            }
            const presence = await response.json();
            res.json({ presence, upstream: { connected: upstreamAlive, lastEventId } });
        } catch (err) {
            res.status(502).json({ error: err.message || 'Praxis unreachable' });
        }
    });

    // ── HITL Inbox Proxy (Phase 4) ─────────────────────────────────
    router.get('/hitl/pending', (req, res) => proxyJson(req, res, '/hitl/pending'));
    router.get('/hitl/recent', (req, res) => proxyJson(req, res, '/hitl/recent'));
    router.get('/hitl/:id', (req, res) => proxyJson(req, res, `/hitl/${encodeURIComponent(req.params.id)}`));
    router.post('/hitl/:id/resolve', (req, res) => proxyJson(req, res, `/hitl/${encodeURIComponent(req.params.id)}/resolve`));

    return router;
}

module.exports = createPraxisStreamRouter;
