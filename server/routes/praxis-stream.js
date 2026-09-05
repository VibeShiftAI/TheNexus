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
const { randomUUID } = require('crypto');

const fs = require('fs');
const { PRAXIS_BRIDGE_TOKEN_FILE } = require('../shared/constants');
const { praxisFetch, praxisProxyJson, praxisStream } = require('../services/praxis-client');

/**
 * Praxis's full-scope bridge token, read fresh per call (it is minted on
 * Praxis's first boot and can rotate; the file is tiny). Null when absent —
 * the call then runs read-only and Praxis says why.
 */
function readBridgeToken() {
    try {
        const token = fs.readFileSync(PRAXIS_BRIDGE_TOKEN_FILE, 'utf8').trim();
        return token || null;
    } catch {
        return null;
    }
}
const providerCredentials = require('../services/provider-credentials');

/**
 * Key-aware routing verdict for a dispatch, fail-open. The gate exists to save
 * a wasted run; it must never become the reason a dispatch can't happen, so any
 * fault in the credential reader allows the dispatch through.
 */
function checkDispatchRoute(route) {
    try {
        return providerCredentials.checkDispatchRoute(route);
    } catch (err) {
        console.warn('[Praxis Relay] key-aware routing check failed (allowing dispatch):', err.message);
        return { allowed: true, code: null, reason: null, until: null };
    }
}

const UPSTREAM_PATH = '/stream';
const SNAPSHOT_PATH = '/presence';
const RING_BUFFER_SIZE = 500;
/**
 * How many event ids the relay remembers for dual-publish dedupe. Comfortably
 * larger than RING_BUFFER_SIZE: an id must never be forgotten here while the
 * event it names is still replayable from the ring, or a resume would deliver
 * a frame the relay would then happily re-broadcast as new.
 */
const SEEN_EVENT_IDS_MAX = 2000;
const HEARTBEAT_MS = 15000;

/**
 * The model a dispatch will actually run on when the caller pins none — the
 * operator-set per-executor default. Needed by the key-aware gate: Praxis's
 * usage-limit cooldowns are frequently PER MODEL, and most dispatches ride the
 * default, so without this the gate would only ever catch lane-wide blocks.
 */
const EXECUTOR_DEFAULT_MODEL_SETTING = {
    'claude-code': 'claude_default_model',
    codex: 'codex_default_model',
    antigravity: 'antigravity_default_model',
};

async function effectiveModel({ db, executor, model }) {
    if (model) return model;
    const key = EXECUTOR_DEFAULT_MODEL_SETTING[executor];
    if (!key || !db || typeof db.getModelControlSetting !== 'function') return null;
    try {
        const setting = await db.getModelControlSetting(key);
        const value = setting && typeof setting.model === 'string' ? setting.model.trim() : '';
        return value || null;
    } catch (err) {
        console.warn('[Praxis Relay] default-model lookup failed:', err.message);
        return null;
    }
}

function createPraxisStreamRouter({ io, pushService, db } = {}) {
    const router = express.Router();

    // Per-process state: one upstream connection, N downstream subscribers.
    const subscribers = new Set();
    const ring = [];
    let lastEventId = null;
    let upstreamReq = null;
    let upstreamStopped = false;
    let reconnectTimer = null;
    let backoffMs = 1000;
    let upstreamAlive = false;
    const pushedHitlIds = new Set();
    const seenEventIds = new Set();

    /**
     * Cross-path dedupe for {@link broadcast}. Bounded the same way the HITL
     * push set is: insertion-ordered Set, oldest evicted first. Sized well
     * above the ring buffer so an event can never be forgotten here while it
     * is still replayable from the ring. An event WITHOUT an id cannot be
     * deduped and is always accepted — a double delivery costs a spare
     * refetch; a dropped one costs a stale board.
     */
    function markEventSeen(eventId) {
        if (!eventId || typeof eventId !== 'string') return true;
        if (seenEventIds.has(eventId)) return false;
        if (seenEventIds.size >= SEEN_EVENT_IDS_MAX) {
            seenEventIds.delete(seenEventIds.values().next().value);
        }
        seenEventIds.add(eventId);
        return true;
    }

    function pushEventToRing(event) {
        ring.push(event);
        if (ring.length > RING_BUFFER_SIZE) ring.shift();
    }

    /**
     * Socket.IO reconnect replay (P3-30 phase 2, the one-way-door prerequisite).
     *
     * SSE gets `Last-Event-ID` replay for free; Socket.IO does not, so a tab
     * that was asleep for 20 seconds silently misses every frame in that gap
     * and sits on stale data until the 60s fallback poll. The dashboard's
     * LiveBoardStateProvider therefore emits `praxis:resume { since }` on every
     * (re)connect, carrying the last eventId it applied, and this answers:
     *
     *   - `since` is still in the ring  → replay every frame AFTER it as
     *     ordinary `praxis:event`s. The client's own eventId dedupe makes an
     *     overlapping replay harmless, so we never have to be exact.
     *   - `since` is unknown (client was away longer than the ring holds, or
     *     the relay restarted and lost the ring) → we cannot fill the gap, so
     *     send `praxis:resync`. The provider treats that as "invalidate
     *     everything" and refetches all domains, the same contract as the SSE
     *     path's `stream.reset` frame.
     *   - no `since` (first connect) → nothing to replay; the client's mount
     *     fetch is its snapshot.
     *
     * Replay is per-socket (`socket.emit`), never `io.emit` — one reconnecting
     * tab must not re-bump every other tab's revisions.
     */
    function handleResume(socket, payload) {
        const since = payload && typeof payload.since === 'string' ? payload.since : null;
        if (!since) return;
        const idx = ring.findIndex((e) => e && e.eventId === since);
        if (idx < 0) {
            socket.emit('praxis:resync', {
                reason: 'ring-miss',
                at: new Date().toISOString(),
                eventId: randomUUID(),
            });
            return;
        }
        for (const event of ring.slice(idx + 1)) {
            socket.emit('praxis:event', event);
        }
    }

    if (io && typeof io.on === 'function') {
        io.on('connection', (socket) => {
            if (!socket || typeof socket.on !== 'function') return;
            socket.on('praxis:resume', (payload) => {
                try {
                    handleResume(socket, payload);
                } catch (err) {
                    console.warn(`[PraxisStream] resume replay failed: ${err.message}`);
                }
            });
        });
    }

    /**
     * Fan one event out everywhere: the ring buffer (replay source), every
     * downstream SSE subscriber, every Socket.IO client, and the HITL push.
     *
     * THE single choke point. Every path that introduces an event — the
     * upstream SSE relay and, since P3-30 phase 2, the direct POST ingest —
     * must come through here, or HITL push notifications stop firing while
     * the UI still looks perfectly correct.
     *
     * Returns false when the event was a duplicate and nothing was fanned out.
     */
    function broadcast(event) {
        // Dual-publish dedupe. Praxis now pushes events to POST /events AND
        // still serves them on its SSE stream, which this relay still consumes
        // — deliberately, for one soak — so most events arrive twice. Whichever
        // copy lands first wins; the second is dropped here rather than being
        // ringed twice, delivered twice, and (worst) pushed to Robert's phone
        // twice. Ids are UUIDs stamped once by Praxis's event bus, so the two
        // copies of one event are genuinely identical.
        if (!markEventSeen(event && event.eventId)) return false;
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
        return true;
    }

    function notifyHitlCreated(event) {
        if (!pushService || event?.type !== 'hitl.created' || !event.request?.id) return;
        const request = event.request;
        if (pushedHitlIds.has(request.id)) return;
        // Bound the dedupe set so a long-lived relay can't leak memory one HITL
        // id at a time. Set preserves insertion order, so deleting the first
        // key evicts the oldest. 1000 is far more than the in-flight HITL count.
        if (pushedHitlIds.size >= 1000) {
            pushedHitlIds.delete(pushedHitlIds.values().next().value);
        }
        pushedHitlIds.add(request.id);
        // Forward the contract-defined deep-link payload Praxis attaches to the
        // hitl.created event (@praxis/contract buildHitlDeepLink) verbatim, so
        // the push route + source can never drift from what the mobile router
        // allow-lists. Fall back to an equivalent payload for older Praxis
        // builds that predate the deepLink field. `type` is retained for any
        // backward-compatible consumer that still keys on it.
        const deepLink = event.deepLink || {
            source: 'praxis-hitl',
            hitlId: request.id,
            route: '/(tabs)/inbox',
            ...(request.taskId ? { taskId: request.taskId } : {}),
        };
        pushService.notify({
            title: 'Praxis needs input',
            body: request.question || request.reason || 'Human input required',
            data: {
                type: 'hitl_request',
                ...deepLink,
            },
            channelId: 'praxis-agent',
            categoryId: 'hitl-response',
        }).catch((err) => {
            console.warn(`[PraxisStream] HITL push failed: ${err.message}`);
            pushedHitlIds.delete(request.id);
        });
    }

    function proxyJson(req, res, upstreamPath) {
        const options = { method: req.method, headers: { Accept: 'application/json' } };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(req.body ?? {});
        }
        // Operator-originated tool calls (Council Chamber summon, problem
        // intake) run at full bridge scope — the dashboard is Robert's own
        // console, already behind the Nexus server's auth.
        if (upstreamPath.startsWith('/agent-tool')) {
            const token = readBridgeToken();
            if (token) options.headers['X-Praxis-Bridge-Token'] = token;
        }
        // No client-side timeout (as before): council summons and dispatches
        // are long, and the browser owns the wait.
        return praxisProxyJson(res, upstreamPath, options);
    }

    function councilSummonArgs(body = {}) {
        const args = {};
        const stringFields = ['topic', 'context', 'deliverable', 'project', 'domain', 'preset'];
        for (const field of stringFields) {
            if (typeof body[field] === 'string' && body[field].trim()) {
                args[field] = body[field].trim();
            }
        }
        if (typeof body.focus === 'boolean') args.focus = body.focus;
        if (typeof body.include_consultations === 'boolean') args.include_consultations = body.include_consultations;
        if (Array.isArray(body.consultations)) {
            const consultations = body.consultations.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
            if (consultations.length) args.consultations = consultations;
        }
        return args;
    }

    function connectUpstream() {
        if (upstreamStopped || upstreamReq) return;
        const headers = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
        };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;

        // Raw node http stream via the shared client — no buffering, no
        // timeout; the response is consumed frame by frame below.
        let finished = false;
        let response;
        const reconnect = () => {
            if (finished) return;
            finished = true;
            upstreamAlive = false;
            const request = upstreamReq;
            upstreamReq = null;
            response?.destroy();
            request?.destroy();
            scheduleReconnect();
        };
        upstreamReq = praxisStream(UPSTREAM_PATH, { method: 'GET', headers }, (res) => {
            if (finished || upstreamStopped) { res.destroy(); return; }
            response = res;
            res.on('end', reconnect);
            res.on('aborted', reconnect);
            res.on('close', reconnect);
            res.on('error', reconnect);
            if (res.statusCode !== 200) {
                console.warn(`[PraxisStream] upstream returned ${res.statusCode}, will retry`);
                res.resume();
                reconnect();
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

        });

        upstreamReq.on('error', reconnect);
    }

    function scheduleReconnect() {
        if (upstreamStopped || reconnectTimer) return;
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

    // Explicit teardown for server shutdown and isolated route consumers.
    router.closeUpstream = () => {
        upstreamStopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        upstreamReq?.destroy();
        upstreamReq = null;
        upstreamAlive = false;
    };

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
            } else {
                // We don't hold sinceId — the relay restarted (or the client was
                // gone longer than the ring holds). We can't fill the gap, so tell
                // the client to re-bootstrap from /snapshot instead of resuming
                // blind. Mirrors Praxis's own ring-miss handling on /stream.
                const reset = { type: 'stream.reset', at: new Date().toISOString(), eventId: randomUUID(), reason: 'ring-miss' };
                res.write(`id: ${reset.eventId}\n`);
                res.write(`event: ${reset.type}\n`);
                res.write(`data: ${JSON.stringify(reset)}\n\n`);
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

    // ── Direct event ingest (P3-30 phase 2, step 3) ──────────────
    //
    // Praxis POSTs each operational event here as it is published, instead of
    // this relay having to pull it off Praxis's SSE stream. Both paths run in
    // parallel for now — the SSE upstream above is still connected — and
    // broadcast()'s eventId dedupe makes the duplicate free. Deleting the SSE
    // route is a separate follow-up after a soak.
    //
    // This is an inbound WRITE endpoint that fans out to every connected
    // browser and can fire a push to Robert's phone, so it is treated as
    // security-sensitive: loopback callers only, and a shared-secret header.
    // It goes through the SAME broadcast() as the relay, which is what keeps
    // HITL pushes, the ring buffer, SSE and Socket.IO all consistent.
    function isLoopback(req) {
        // Deliberately NOT req.ip: server.js sets `trust proxy`, so req.ip honours
        // X-Forwarded-For from any direct peer and a LAN host could claim 127.0.0.1.
        // The socket's own peer address is the only thing a caller cannot forge.
        const ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
        return ip === '127.0.0.1' || ip === '::1';
    }

    function ingestAuthorized(req) {
        const expected = process.env.NEXUS_SERVICE_KEY;
        // No key configured → loopback alone is the boundary (same posture as
        // the other same-box Praxis seams). A configured key is enforced.
        if (!expected) return true;
        const provided = req.header('X-Nexus-Service-Key');
        if (typeof provided !== 'string') return false;
        const a = Buffer.from(provided), b = Buffer.from(expected);
        return a.length === b.length && require('crypto').timingSafeEqual(a, b);
    }

    router.post('/events', express.json({ limit: '256kb' }), (req, res) => {
        if (!isLoopback(req)) {
            return res.status(403).json({ ok: false, error: 'loopback only' });
        }
        if (!ingestAuthorized(req)) {
            return res.status(401).json({ ok: false, error: 'bad service key' });
        }
        const body = req.body || {};
        // One event, or a batch (Praxis flushes its outbound buffer after a
        // Nexus restart, and one round trip beats N).
        const events = Array.isArray(body.events) ? body.events : [body];
        let accepted = 0;
        let duplicates = 0;
        for (const event of events) {
            if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
                return res.status(400).json({ ok: false, error: 'event.type is required' });
            }
            if (broadcast(event)) accepted += 1;
            else duplicates += 1;
        }
        // `lastEventId` is the SSE upstream's cursor and is deliberately NOT
        // moved here: it is what a reconnect to Praxis resumes from, and a
        // POSTed event proves nothing about what that stream has delivered.
        res.json({ ok: true, accepted, duplicates });
    });

    // ── Snapshot bootstrap ───────────────────────────────────────
    async function handleSnapshot(_req, res) {
        try {
            const response = await praxisFetch(SNAPSHOT_PATH);
            if (!response.ok) {
                return res.status(502).json({ error: `Praxis returned ${response.status}` });
            }
            const presence = await response.json();
            res.json({ presence, upstream: { connected: upstreamAlive, lastEventId } });
        } catch (err) {
            res.status(502).json({ error: err.message || 'Praxis unreachable' });
        }
    }

    router.get('/snapshot', handleSnapshot);
    router.get('/stream/snapshot', handleSnapshot);

    // ── HITL Inbox Proxy (Phase 4) ─────────────────────────────────
    router.get('/hitl/pending', (req, res) => proxyJson(req, res, '/hitl/pending'));
    router.get('/hitl/recent', (req, res) => proxyJson(req, res, '/hitl/recent'));
    router.get('/hitl/:id', (req, res) => proxyJson(req, res, `/hitl/${encodeURIComponent(req.params.id)}`));
    router.post('/hitl/:id/resolve', (req, res) => proxyJson(req, res, `/hitl/${encodeURIComponent(req.params.id)}/resolve`));

    // ── LLM usage log proxy ("who is calling which AI") ────────────
    router.get('/llm-log', (req, res) => {
        const qs = new URLSearchParams(req.query).toString();
        return proxyJson(req, res, `/api/llm-log${qs ? `?${qs}` : ''}`);
    });

    // ── Council Chamber (deliberation viewer) ──────────────────────
    router.get('/council/sessions', (req, res) => {
        const qs = new URLSearchParams(req.query).toString();
        return proxyJson(req, res, `/api/council/sessions${qs ? `?${qs}` : ''}`);
    });
    router.get('/council/sessions/:id', (req, res) =>
        proxyJson(req, res, `/api/council/sessions/${encodeURIComponent(req.params.id)}`));
    router.post('/council/summon', (req, res) => {
        const args = councilSummonArgs(req.body);
        if (!args.topic) {
            return res.status(400).json({ ok: false, error: 'topic is required' });
        }
        req.body = { name: 'spawn_council', args };
        return proxyJson(req, res, '/agent-tool');
    });
    // Hand Praxis a PROBLEM from the Chamber: the problem council (three
    // top-tier seats, two rounds, ranked ideas → charter → project set up)
    // via Praxis's problem_intake tool. dry_run deliberates without creating.
    router.post('/council/problem', (req, res) => {
        const body = req.body || {};
        const problem = typeof body.problem === 'string' ? body.problem.trim() : '';
        if (!problem) {
            return res.status(400).json({ ok: false, error: 'problem is required' });
        }
        const args = { problem, council: body.council !== false };
        for (const field of ['name', 'type', 'context', 'preset']) {
            if (typeof body[field] === 'string' && body[field].trim()) args[field] = body[field].trim();
        }
        if (body.dry_run === true) args.dry_run = true;
        req.body = { name: 'problem_intake', args };
        return proxyJson(req, res, '/agent-tool');
    });
    // Arbiter preference (bridge Ops control) — which CLI seat writes the verdict.
    router.get('/council/arbiter', (req, res) => proxyJson(req, res, '/api/council/arbiter'));
    router.post('/council/arbiter', (req, res) => proxyJson(req, res, '/api/council/arbiter'));
    // Bench composition — who sits on each council. Praxis validates every
    // seat for reachability before writing, so a 400 here carries an operator-
    // readable reason and should be surfaced verbatim rather than retried.
    router.get('/council/benches', (req, res) => proxyJson(req, res, '/api/council/benches'));
    router.post('/council/benches/:name', (req, res) =>
        proxyJson(req, res, `/api/council/benches/${encodeURIComponent(req.params.name)}`));

    // ── Bridge / cockpit passthroughs (command-deck dashboard) ─────
    router.get('/stats', (req, res) => proxyJson(req, res, '/api/praxis/stats'));
    // Voice line health (ElevenLabs quota etc.) — the bridge's muted-voice badge.
    router.get('/voice-status', (req, res) => proxyJson(req, res, '/api/voice/status'));
    // External-comms feed (feedback gateway in/out) — forwards ?since/?limit.
    router.get('/comms', (req, res) => {
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return proxyJson(req, res, `/api/comms${qs}`);
    });
    router.get('/skills', (req, res) => proxyJson(req, res, '/api/skills'));
    router.get('/dispatch-state', (req, res) => proxyJson(req, res, '/api/dispatch/state'));

    // -- Model status board (Model Control Center) ------------------
    // Which models dispatch can reach, why any are held, and the target that
    // releases each. The clear is loopback-only on the Praxis side; this relay
    // runs on the same box, so the proxied call satisfies that check while the
    // browser never talks to Praxis directly.
    router.get('/models/status', (req, res) => proxyJson(req, res, '/api/models/status'));
    router.get('/usage/state', (req, res) => proxyJson(req, res, '/api/usage/state'));
    router.post('/usage/clear-limit', (req, res) => proxyJson(req, res, '/api/usage/clear-limit'));
    router.post('/transcribe', (req, res) => proxyJson(req, res, '/api/transcribe'));
    router.post('/speak', (req, res) => proxyJson(req, res, '/api/speak'));
    // Non-streaming chat relay for the voice bar ({ message, stream: false }).
    router.post('/chat', (req, res) => proxyJson(req, res, '/api/chat'));
    // Ops console actions.
    router.post('/dispatch/retry', (req, res) => proxyJson(req, res, '/api/dispatch/retry'));
    router.post('/dispatch/auto-approve', (req, res) => proxyJson(req, res, '/api/dispatch/auto-approve'));
    // Scheduled-jobs (cron) pause/resume — list data rides /dispatch-state.
    router.post('/cron/:key/pause', (req, res) => proxyJson(req, res, `/api/cron/${encodeURIComponent(req.params.key)}/pause`));
    router.post('/cron/:key/resume', (req, res) => proxyJson(req, res, `/api/cron/${encodeURIComponent(req.params.key)}/resume`));
    // Manual task dispatch with executor/model selection (mobile/cockpit).
    // Key-aware routing gate: a route whose credential is provably spent is
    // refused HERE, before the CLI slot is taken and the 402 is discovered.
    // Same 409 refusal shape as a Praxis refusal, so every caller's existing
    // "Force dispatch" override works unchanged.
    router.post('/dispatch/task', async (req, res) => {
        const body = req.body || {};
        if (!body.force) {
            const executor = typeof body.executor === 'string' ? body.executor.trim() : null;
            const route = checkDispatchRoute({
                executor,
                // A caller naming a provider is asking for a per-token API route,
                // which cannot run without that provider's key present.
                provider: typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : null,
                model: await effectiveModel({
                    db,
                    executor,
                    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
                }),
            });
            if (!route.allowed) {
                return res.status(409).json({
                    ok: false,
                    refused: true,
                    reason: route.code,
                    reply: `Dispatch blocked by key-aware routing: ${route.reason}. `
                        + 'Pick another worker or model, or force to run anyway.',
                });
            }
        }
        return proxyJson(req, res, '/api/dispatch/task');
    });
    // Follow-up prompt to a finished dispatch's saved CLI session (task screen).
    router.post('/dispatch/follow-up', (req, res) => proxyJson(req, res, '/api/dispatch/follow-up'));
    // Inbox "Clear list" — drops failed entries from the Antigravity queue.
    router.post('/dispatch/clear-failed', (req, res) => proxyJson(req, res, '/api/dispatch/clear-failed'));
    // Shared voice-command grammar (classification lives with the agent).
    router.post('/voice-intent', (req, res) => proxyJson(req, res, '/api/voice/intent'));

    // ── Status reports (themed HTML rendered by Praxis) ────────────
    // Raw passthrough (not proxyJson — the payload is text/html). The chat
    // [STATUS REPORT] card links to /api/praxis/report/<file>, which the
    // dashboard's /api rewrite sends here; opening it in a new window
    // serves the report through this relay.
    async function proxyReportFile(res, praxisPath) {
        try {
            const response = await praxisFetch(praxisPath, { redirect: 'follow' });
            res.status(response.status);
            const type = response.headers.get('content-type');
            if (type) res.set('Content-Type', type);
            res.send(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
            res.status(502).json({ error: err.message || 'Praxis unreachable' });
        }
    }
    router.get('/report/latest', (req, res) => proxyReportFile(res, '/report/latest'));
    router.get('/report/:file', (req, res) =>
        proxyReportFile(res, `/reports/${encodeURIComponent(req.params.file)}`));
    router.get('/reports', (req, res) => proxyJson(req, res, '/reports'));
    // Stakeholder status reports (Praxis src/stakeholders) — list / generate
    // / detail / send, relayed for the project page's Communication panel.
    // The query string rides along (proxyJson takes a fully-formed path).
    router.get('/stakeholder-reports', (req, res) => {
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return proxyJson(req, res, `/api/stakeholder-reports${qs}`);
    });
    router.post('/stakeholder-reports/generate', (req, res) => proxyJson(req, res, '/api/stakeholder-reports/generate'));
    router.get('/stakeholder-reports/:id', (req, res) =>
        proxyJson(req, res, `/api/stakeholder-reports/${encodeURIComponent(req.params.id)}`));
    router.post('/stakeholder-reports/:id/send', (req, res) =>
        proxyJson(req, res, `/api/stakeholder-reports/${encodeURIComponent(req.params.id)}/send`));
    router.post('/stakeholder-reports/:id/cancel', (req, res) =>
        proxyJson(req, res, `/api/stakeholder-reports/${encodeURIComponent(req.params.id)}/cancel`));
    // Manual trigger (mobile/remote surfaces without chat).
    router.post('/status-report', (req, res) => proxyJson(req, res, '/status-report'));

    return router;
}

module.exports = createPraxisStreamRouter;
