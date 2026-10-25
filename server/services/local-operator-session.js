/**
 * Explicit local sign-in, never automatic trust in localhost, the OS user or
 * the desktop shell. Robert supplies the operator credential to the sign-in
 * endpoint. A random, HMAC-authenticated cookie refers to a one-hour in-memory
 * session. Neither the operator key nor session tokens are logged or stored
 * in browser JS storage. See docs/contracts/local-operator-session.md.
 */
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { stakeholderCredential, requireStakeholderAuthority } = require('./stakeholder-authority');

const ORIGIN = 'http://localhost:3000';
const COOKIE = 'nexus_local_operator';
const TTL_MS = 60 * 60 * 1000;
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'strict', path: '/api' };
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const sign = (key, id) => createHmac('sha256', key).update(`nexus-local-operator/v1\n${id}`, 'utf8').digest('hex');
const refusal = () => ({ ok: false, category: 'claim-rejected', check: 'local-session' });

function localRequest(req) {
    // Never use req.ip / forwarded headers: the global server trusts a proxy.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
    if (req.user?.is_service || req.get('x-praxis-bridge-token')
        || req.get('cf-access-client-id') || req.get('cf-access-client-secret')) return false;
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin') return false;
    const origin = req.get('origin');
    if (origin) return origin === ORIGIN;
    // Browsers omit Origin on same-origin GETs. Referer is sufficient ONLY for
    // reads; every mutation, including sign-in and logout, requires Origin.
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    try { return new URL(req.get('referer')).origin === ORIGIN; } catch { return false; }
}

function cookieToken(req) {
    const header = req.get('cookie');
    if (typeof header !== 'string' || header.length > 16384) return null;
    const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}\.[a-f0-9]{64}$/.test(value) ? value : null;
}

function localKey() {
    if (process.env.NEXUS_LOCAL_OPERATOR_SESSIONS !== '1') {
        throw Object.assign(new Error('Local operator sessions are not enabled'), { status: 503 });
    }
    return stakeholderCredential('operator');
}

function createLocalOperatorSessions({ now = Date.now } = {}) {
    const sessions = new Map();
    function prune() {
        for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
    }
    function inspect(req) {
        if (!localRequest(req)) return refusal();
        const token = cookieToken(req);
        if (!token) return refusal();
        prune();
        const session = sessions.get(hash(token));
        if (!session) return refusal();
        try {
            const key = localKey();
            const [id, signature] = token.split('.');
            if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(key, id), 'hex'))) {
                sessions.delete(hash(token));
                return refusal();
            }
            return { ok: true, identity: 'local', expiresAt: session.expiresAt };
        } catch {
            sessions.delete(hash(token));
            return refusal();
        }
    }
    function mint(req) {
        if (!localRequest(req)) throw Object.assign(new Error('Use the local Nexus dashboard'), { status: 403 });
        const key = localKey();
        requireStakeholderAuthority(req, 'operator');
        prune();
        const old = cookieToken(req);
        // Bound memory; do not evict Robert's existing sessions for a new one.
        if (sessions.size >= 64 && (!old || !sessions.has(hash(old)))) {
            throw Object.assign(new Error('Too many local sessions; sign out or wait for expiry'), { status: 429 });
        }
        const id = randomBytes(32).toString('base64url');
        const token = `${id}.${sign(key, id)}`;
        const expiresAt = now() + TTL_MS;
        if (old) sessions.delete(hash(old));
        sessions.set(hash(token), { expiresAt });
        return { token, expiresAt };
    }
    function revoke(req) {
        const token = cookieToken(req);
        if (token) sessions.delete(hash(token));
    }
    return { inspect, mint, revoke };
}

// One server-owned store shared by the sign-in route and all authenticators.
const localOperatorSessions = createLocalOperatorSessions();
module.exports = { createLocalOperatorSessions, localOperatorSessions, localRequest, COOKIE, COOKIE_OPTIONS, TTL_MS };
