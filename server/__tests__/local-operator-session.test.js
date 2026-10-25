/** Synthetic credentials only. No live operator credential or client mail. */
const express = require('express');
const http = require('node:http');
const ORIGIN = 'http://localhost:3000';
const KEY = 'synthetic-operator-'.repeat(4);
const RUNTIME = 'synthetic-runtime-'.repeat(4);
const EXECUTOR = 'synthetic-executor-'.repeat(4);
let server, base, sessions, now, originalEnv;
const request = (headers = {}, method = 'POST', remoteAddress = '127.0.0.1') => ({
    method, socket: { remoteAddress }, user: { id: 'local_user' },
    get: name => ({ origin: ORIGIN, ...headers })[name.toLowerCase()],
});
beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.NEXUS_LOCAL_OPERATOR_SESSIONS = '1';
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = KEY;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = RUNTIME;
    process.env.NEXUS_DOCUMENT_APPROVAL_KEY = EXECUTOR;
    now = Date.now();
    const { createLocalOperatorSessions } = require('../services/local-operator-session');
    sessions = createLocalOperatorSessions({ now: () => now });
    const app = express();
    app.use(express.json());
    app.use('/api/operator-session', require('../routes/operator-session')({ sessions }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/operator-session`;
});
afterEach(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    process.env = originalEnv;
});
async function login(key = KEY, extra = {}) {
    return fetch(base, { method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${key}`, ...extra } });
}
async function cookie() {
    const response = await login();
    expect(response.status).toBe(201);
    return response.headers.get('set-cookie').split(';')[0];
}
test('explicit operator sign-in mints an HttpOnly one-hour session, never returns the credential', async () => {
    const res = await login();
    expect(res.status).toBe(201);
    const set = res.headers.get('set-cookie');
    expect(set).toContain('HttpOnly'); expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/api'); expect(set).toContain('Max-Age=3600');
    expect(set).not.toMatch(/Domain=/i);
    const body = await res.text(); expect(body).not.toContain(KEY);
    expect(sessions.inspect(request({ cookie: set.split(';')[0] }))).toMatchObject({ ok: true, identity: 'local' });
});
test.each(['local-dev-token', RUNTIME, EXECUTOR, ''])('non-operator bearer cannot establish a session (%#)', async key => {
    const res = await login(key);
    expect(res.status).toBe(403); expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'operator_required' });
});
test.each(['x-praxis-bridge-token', 'cf-access-client-id', 'cf-access-client-secret'])('machine header %s forbids sign-in and session use', async name => {
    const proof = await cookie();
    expect((await login(KEY, { [name]: 'machine' })).status).toBe(403);
    expect(sessions.inspect(request({ cookie: proof, [name]: 'machine' })).ok).toBe(false);
});
test.each(['https://evil.test', 'http://localhost:3001', 'http://127.0.0.1:3000', 'null', ''])('foreign or absent origin %s cannot sign in or mutate', async origin => {
    const proof = await cookie();
    expect((await login(KEY, { origin })).status).toBe(403);
    expect(sessions.inspect(request({ cookie: proof, origin })).ok).toBe(false);
});
test('loopback and fabricated user/header claims confer nothing; service users cannot use a session', async () => {
    expect(sessions.inspect(request()).ok).toBe(false);
    expect(sessions.inspect(request({ 'x-operator': 'Robert', authorization: 'Bearer local-dev-token' })).ok).toBe(false);
    const proof = await cookie();
    expect(sessions.inspect(request({ cookie: proof }, 'POST', '192.0.2.1')).ok).toBe(false);
    expect(sessions.inspect({ ...request({ cookie: proof }), user: { id: 'service', is_service: true } }).ok).toBe(false);
    expect(sessions.inspect(request({ cookie: proof, 'sec-fetch-site': 'cross-site' })).ok).toBe(false);
});
test('forged, duplicate, expired, logged-out and restarted sessions are refused', async () => {
    const proof = await cookie();
    expect(sessions.inspect(request({ cookie: proof + 'x' })).ok).toBe(false);
    expect(sessions.inspect(request({ cookie: proof + '; ' + proof })).ok).toBe(false);
    const fresh = require('../services/local-operator-session').createLocalOperatorSessions();
    expect(fresh.inspect(request({ cookie: proof })).ok).toBe(false);
    const logout = await fetch(base, { method: 'DELETE', headers: { origin: ORIGIN, cookie: proof } });
    expect(logout.status).toBe(200);
    expect(sessions.inspect(request({ cookie: proof })).ok).toBe(false);
    const second = await cookie(); now += 3600000;
    expect(sessions.inspect(request({ cookie: second })).ok).toBe(false);
});
test.each(['disabled', 'missing', 'short', 'runtime-collision', 'executor-collision', 'rotated'])('configuration %s invalidates proof and fails closed', async mode => {
    const proof = await cookie();
    if (mode === 'disabled') delete process.env.NEXUS_LOCAL_OPERATOR_SESSIONS;
    else process.env.NEXUS_OPERATOR_APPROVAL_KEY = ({ missing: '', short: 'short', 'runtime-collision': RUNTIME, 'executor-collision': EXECUTOR, rotated: KEY + 'rotated' })[mode];
    expect(sessions.inspect(request({ cookie: proof })).ok).toBe(false);
    expect((await login()).status).toBe(mode === 'rotated' ? 403 : 503);
});
test('same-origin GET can inspect through Referer without relaxing mutation Origin checks', async () => {
    const proof = await cookie();
    const headers = { cookie: proof, origin: undefined, referer: ORIGIN + '/documents' };
    expect(sessions.inspect(request(headers, 'GET')).ok).toBe(true);
    expect(sessions.inspect(request(headers, 'POST')).ok).toBe(false);
});

test('reauthentication replaces the old session even at capacity; unrelated new sessions are refused', () => {
    const credentials = { authorization: `Bearer ${KEY}` };
    const first = sessions.mint(request(credentials));
    for (let i = 1; i < 64; i++) sessions.mint(request(credentials));
    expect(() => sessions.mint(request(credentials))).toThrow('Too many local sessions');
    const old = `nexus_local_operator=${first.token}`;
    const replacement = sessions.mint(request({ ...credentials, cookie: old }));
    expect(sessions.inspect(request({ cookie: old })).ok).toBe(false);
    expect(sessions.inspect(request({ cookie: `nexus_local_operator=${replacement.token}` })).ok).toBe(true);
});

test('sign-in rate limit is shared across spoofed forwarded addresses', async () => {
    for (let i = 0; i < 10; i++) expect((await login('wrong', { 'x-forwarded-for': `192.0.2.${i}` })).status).toBe(403);
    expect((await login(KEY, { 'x-forwarded-for': '192.0.2.200' })).status).toBe(429);
});
