/**
 * In-memory presentation authority. This is a cockpit surface, not a display
 * discovery or orchestration runtime. Inventories are device-reported provenance.
 * Restart, expiry, stop, or a missed authenticated controller heartbeat revokes
 * receiver capabilities. Only hashes of receiver secrets are retained.
 */
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { z } = require('zod');
const {
    DisplayInventorySchema, DisplaySourceSchema, PresentationStartSchema, PresentationViewSchema,
    DISPLAY_INVENTORY_TTL_MS, PRESENTATION_TTL_MS, PRESENTATION_PAIRING_TTL_MS, resolveDisplayTarget,
} = require('@praxis/contract');
const { createPresentationData, presentationError } = require('./presentation-data');

const CONTROLLER_LEASE_MS = 45_000;
const RECEIVER_LEASE_MS = 45_000;
const TERMINAL = new Set(['stopped', 'expired', 'disconnected', 'failed']);
const heartbeatSchema = z.object({ state: z.enum(['active', 'disconnected', 'failed']) }).strict();
const pairingSchema = z.object({ name: z.string().trim().min(1).max(160) }).strict();
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const iso = value => new Date(value).toISOString();

function parse(schema, input) {
    const result = schema.safeParse(input);
    if (!result.success) throw presentationError('invalid_request', 400, 'The presentation request does not match the supported contract.');
    return result.data;
}

function createPresentationService({ db, now = Date.now, receiverOrigin = null, limits = {}, captureRoot, readActivity } = {}) {
    const maxDevices = Math.min(limits.devices ?? 16, 16);
    const maxSessions = Math.min(limits.sessions ?? 32, 32);
    const maxPairings = Math.min(limits.pairings ?? 64, 64);
    const data = createPresentationData({ db, now, captureRoot, readActivity, maxAssetBytes: limits.assetBytes, maxTotalAssetBytes: limits.totalAssetBytes });
    const inventories = new Map();
    const sessions = new Map();
    const pairings = new Map();
    const tokenSessions = new Map();
    const rates = new Map();
    let pendingStarts = 0;
    let closed = false;

    function revoke(record, state, reason) {
        if (TERMINAL.has(record.session.state)) return;
        clearTimeout(record.timer);
        record.session = { ...record.session, state, reason, updatedAt: iso(now()) };
        if (record.tokenHash) tokenSessions.delete(record.tokenHash);
        record.tokenHash = null;
        for (const stop of record.streams) stop();
        record.streams.clear();
        record.captured?.release();
    }

    function check(record) {
        if (!record) throw presentationError('session_not_found', 404, 'The presentation session was not found.');
        if (closed) revoke(record, 'expired', 'The presentation service closed.');
        else if (now() >= Date.parse(record.session.expiresAt)) revoke(record, 'expired', 'The presentation reached its time limit.');
        else if (now() >= record.leaseUntil) revoke(record, 'expired', 'The authenticated controller heartbeat expired.');
        else if (!record.tokenHash && record.pairingUntil !== null && now() >= record.pairingUntil) revoke(record, 'expired', 'The receiver pairing expired before the TV connected.');
        else if (record.receiverLastSeen !== null && now() >= record.receiverLastSeen + RECEIVER_LEASE_MS) revoke(record, 'disconnected', 'The receiver stopped reading its presentation.');
        return record;
    }

    function usable(id) {
        const record = check(sessions.get(id));
        if (TERMINAL.has(record.session.state)) throw presentationError('session_unavailable', 410, 'The presentation has stopped or expired.');
        return record;
    }

    function arm(record) {
        clearTimeout(record.timer);
        const receiverUntil = record.receiverLastSeen === null ? Infinity : record.receiverLastSeen + RECEIVER_LEASE_MS;
        const pairingUntil = record.tokenHash || record.pairingUntil === null ? Infinity : record.pairingUntil;
        const delay = Math.max(1, Math.min(record.leaseUntil, Date.parse(record.session.expiresAt), receiverUntil, pairingUntil) - now());
        record.timer = setTimeout(() => { check(record); if (!TERMINAL.has(record.session.state)) arm(record); }, delay);
        record.timer.unref?.();
    }

    function prune() {
        for (const [code, pairing] of pairings) if (pairing.expiresAt <= now()) pairings.delete(code);
        for (const record of sessions.values()) check(record);
        for (const [key, bucket] of rates) if (bucket.until <= now()) rates.delete(key);
    }

    function rate(bucket, client, max, windowMs = 60_000) {
        prune();
        const key = `${bucket}:${hash(String(client || 'unknown'))}`;
        let entry = rates.get(key);
        if (!entry) {
            if (rates.size >= 1024) throw presentationError('rate_limited', 429, 'Presentation request capacity is full. Try again later.');
            entry = { count: 0, until: now() + windowMs };
            rates.set(key, entry);
        }
        if (++entry.count > max) throw presentationError('rate_limited', 429, 'Too many presentation requests. Try again later.');
    }

    function inventory(input) {
        const report = parse(DisplayInventorySchema, input);
        const observed = Date.parse(report.observedAt);
        const expires = Date.parse(report.expiresAt);
        const fresh = stamp => stamp <= now() + 5_000 && stamp > now() - DISPLAY_INVENTORY_TTL_MS;
        if (!fresh(observed) || expires <= now() || expires > now() + DISPLAY_INVENTORY_TTL_MS
            || report.targets.some(target => !fresh(Date.parse(target.observedAt)) || Date.parse(target.observedAt) > expires
                || target.method === 'paired-browser'
                || (target.method === 'windows-monitor' && report.sourceDevice.platform !== 'windows')
                || (['android-presentation', 'cast'].includes(target.method) && report.sourceDevice.platform !== 'android')
                || new Set(target.capabilities).size !== target.capabilities.length)) {
            throw presentationError('invalid_inventory', 400, 'The device inventory must be fresh and describe its own supported native targets.');
        }
        if (!inventories.has(report.sourceDevice.id) && inventories.size >= maxDevices) {
            for (const [id, stored] of inventories) if (Date.parse(stored.expiresAt) <= now()) inventories.delete(id);
            if (inventories.size >= maxDevices) throw presentationError('device_capacity', 429, 'Too many source devices are reporting displays.');
        }
        inventories.set(report.sourceDevice.id, clone(report));
        return clone(report);
    }

    async function createSession(sourceDeviceId, target, view, pairingUntil = null) {
        prune();
        if (closed) throw presentationError('session_unavailable', 410, 'The presentation service has closed.');
        // Terminal records remain readable until capacity is needed. No unbounded
        // history or sessions survive a process restart.
        if (sessions.size + pendingStarts >= maxSessions) {
            for (const [id, record] of sessions) if (TERMINAL.has(record.session.state)) sessions.delete(id);
        }
        if (sessions.size + pendingStarts >= maxSessions) throw presentationError('session_capacity', 429, 'Too many presentations are open. Stop an existing presentation first.');
        pendingStarts++;
        let captured;
        try {
            captured = await data.capture(view);
            if (closed) throw presentationError('session_unavailable', 410, 'The presentation service has closed.');
            const id = randomUUID();
            const session = { id, sourceDeviceId, targetId: target.id, method: target.method, view: clone(view),
                state: 'starting', createdAt: iso(now()), expiresAt: iso(now() + PRESENTATION_TTL_MS), updatedAt: iso(now()), reason: null };
            const record = { session, captured, leaseUntil: now() + CONTROLLER_LEASE_MS, receiverLastSeen: null,
                pairingUntil, streams: new Set(), tokenHash: null, timer: null };
            sessions.set(id, record);
            arm(record);
            return clone(session);
        } catch (error) {
            captured?.release();
            throw error;
        } finally { pendingStarts--; }
    }

    async function start(input) {
        const request = parse(PresentationStartSchema, input);
        const report = inventories.get(request.sourceDeviceId);
        if (!report) throw presentationError('inventory_not_found', 409, 'Discover this device’s displays before starting.');
        const resolved = resolveDisplayTarget(report, request.targetId, now());
        if (!resolved.ok) throw presentationError(resolved.code, 409, 'The selected display is unavailable, ambiguous, or stale. Discover displays again.');
        if (!resolved.target.capabilities.includes(request.view.kind)) throw presentationError('unsupported_view', 409, 'This target does not support the selected view.');
        return createSession(request.sourceDeviceId, resolved.target, request.view);
    }

    function heartbeat(id, input) {
        const request = parse(heartbeatSchema, input);
        const record = usable(id);
        if (request.state !== 'active') revoke(record, request.state, request.state === 'disconnected' ? 'The controller reported that the display disconnected.' : 'The controller reported a presentation failure.');
        else {
            record.leaseUntil = now() + CONTROLLER_LEASE_MS;
            const state = record.session.method === 'paired-browser' && !record.tokenHash ? 'starting' : 'active';
            record.session = { ...record.session, state, updatedAt: iso(now()), reason: null };
            arm(record);
        }
        return clone(record.session);
    }

    async function view(id, { receiver = false } = {}) {
        const record = usable(id);
        const content = await data.project(record.session.view, record.captured, receiver ? '/receiver/asset' : `/api/presentations/sessions/${id}/asset`);
        usable(id); // Do not return a slow read after revocation/lease expiry.
        return { version: 1, session: clone(record.session), sampledAt: iso(now()), content };
    }

    function asset(id) {
        const record = usable(id);
        if (!record.captured) throw presentationError('asset_not_found', 404, 'This view has no selected document asset.');
        return record.captured;
    }

    function watch(id, stop) {
        const record = usable(id);
        if (record.streams.size >= 4) throw presentationError('stream_capacity', 429, 'Too many media reads are open for this presentation.');
        record.streams.add(stop);
        return () => record.streams.delete(stop);
    }

    function enroll(input, client) {
        const request = parse(pairingSchema, input);
        rate('enroll', client, 10);
        if (closed || pairings.size >= maxPairings) throw presentationError('pairing_capacity', 429, 'Too many receivers are waiting to pair.');
        const code = randomBytes(8).toString('hex').toUpperCase();
        const pollToken = randomBytes(32).toString('base64url');
        const expiresAt = now() + PRESENTATION_PAIRING_TTL_MS;
        pairings.set(code, { name: request.name, targetId: `receiver:${randomUUID()}`, pollHash: hash(pollToken), expiresAt, attempts: 0, sessionId: null, claiming: false });
        return { code, pollToken, expiresAt: iso(expiresAt) };
    }

    function pendingPairing(code) {
        prune();
        const pairing = pairings.get(code);
        if (!pairing || closed) throw presentationError('pairing_not_found', 404, 'This receiver pairing is unavailable or expired.');
        return pairing;
    }

    async function claim(code, input, client) {
        rate('claim', client, 20);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'sourceDevice,view') throw presentationError('invalid_request', 400);
        const source = parse(DisplaySourceSchema, input.sourceDevice);
        const selection = parse(PresentationViewSchema, input.view);
        const pairing = pendingPairing(code);
        if (pairing.sessionId || pairing.claiming) throw presentationError('pairing_claimed', 409, 'This code has already been claimed.');
        pairing.claiming = true;
        const target = { id: pairing.targetId, name: pairing.name, sourceDeviceId: source.id, method: 'paired-browser',
            availability: 'available', observedAt: iso(now()), capabilities: ['ambient', 'focus', 'document', 'day-plan'],
            limitations: ['Temporary browser receiver; no native casting protocol is implied.'] };
        try {
            const session = await createSession(source.id, target, selection, pairing.expiresAt);
            if (pairing.expiresAt <= now() || pairings.get(code) !== pairing) {
                revoke(sessions.get(session.id), 'expired', 'The receiver pairing expired before capture completed.');
                throw presentationError('pairing_not_found', 404, 'This receiver pairing expired.');
            }
            pairing.sessionId = session.id;
            return { session, target };
        } finally { pairing.claiming = false; }
    }

    function poll(code, token, client) {
        rate('poll', client, 120);
        const pairing = pendingPairing(code);
        if (typeof token !== 'string' || token.length > 512 || !timingSafeEqual(Buffer.from(hash(token || ''), 'hex'), Buffer.from(pairing.pollHash, 'hex'))) {
            if (++pairing.attempts >= 8) pairings.delete(code);
            throw presentationError('receiver_unauthorized', 401, 'The receiver credential is invalid or expired.');
        }
        if (!pairing.sessionId) return { state: 'pending' };
        const record = usable(pairing.sessionId);
        const sessionToken = randomBytes(32).toString('base64url');
        record.tokenHash = hash(sessionToken);
        tokenSessions.set(record.tokenHash, record.session.id);
        record.receiverLastSeen = now();
        record.session = { ...record.session, state: 'active', updatedAt: iso(now()) };
        arm(record);
        pairings.delete(code); // Deliver to the original poll secret once only.
        return { state: 'paired', token: sessionToken, session: clone(record.session) };
    }

    function receiverSession(token) {
        const denied = () => presentationError('receiver_unauthorized', 401, 'The receiver credential is invalid or expired.');
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
        const digest = hash(token);
        const id = tokenSessions.get(digest);
        if (!id) throw denied();
        let record;
        try { record = usable(id); } catch { throw denied(); }
        record.receiverLastSeen = now();
        arm(record);
        return id;
    }

    function close() {
        closed = true;
        for (const record of sessions.values()) revoke(record, 'expired', 'The presentation service closed.');
        pairings.clear(); tokenSessions.clear(); inventories.clear(); rates.clear();
        data.close();
    }

    return {
        config: () => ({ receiverOrigin, limitations: [
            'Display inventory is reported by a Windows or Android controller; the server does not enumerate hardware.',
            'Ambient counts reflect task board status. Focus marks runtime activity only when the existing Praxis activity feed confirms an active run.',
            'Day plan uses the server calendar timezone.',
            'Media presentations are limited to registered primary assets of 128 MiB or less.',
            'TV presence is observed through scoped receiver reads; 45 seconds without a read disconnects the session.',
            receiverOrigin ? 'TV pairing requires this receiver origin to be reachable without forwarding operator credentials. Hosting and Access policies are unchanged.'
                : 'The separate TV receiver listener is disabled. Native display presentations remain available.',
        ] }),
        inventory, inventories: () => [...inventories.values()].map(clone), start,
        sessions: () => { prune(); return [...sessions.values()].map(record => clone(record.session)); },
        session: id => clone(check(sessions.get(id)).session), heartbeat,
        stop: id => { const record = check(sessions.get(id)); revoke(record, 'stopped', 'Stopped by the controller.'); return clone(record.session); },
        view, asset, watch, enroll, claim, poll, receiverSession, close,
    };
}

module.exports = { createPresentationService, CONTROLLER_LEASE_MS, RECEIVER_LEASE_MS };
