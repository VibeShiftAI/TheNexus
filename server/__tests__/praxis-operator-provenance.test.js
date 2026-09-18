/**
 * Operator provenance (2026-09-18): the header the chat relay signs so Praxis
 * can tell Robert's messages from any other local POST /api/chat (a dispatched
 * executor can reach that endpoint too). The wire format is pinned against a
 * raw-crypto reference that Praxis pins as well
 * (Praxis tests/operator_provenance.test.ts): change the formula on both
 * sides or on neither.
 */
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const nativeFetch = global.fetch;
const access = require('./helpers/operator-access');
const fs = require('node:fs');
const vm = require('node:vm');

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TS = 1758200000000;
const NONCE = '00112233445566778899aabbccddeeff';
const HEADER = 'X-Praxis-Operator-Provenance';

function reference(key, surface, ts, nonce, message) {
    const digest = crypto.createHash('sha256').update(message, 'utf8').digest('hex');
    return crypto.createHmac('sha256', key)
        .update(`praxis-operator-provenance/v1\n${surface}\n${ts}\n${nonce}\n${digest}`, 'utf8')
        .digest('hex');
}

const originalKey = process.env.PRAXIS_OPERATOR_KEY;
test.each(['config-missing', 'key-fetch-failed', 'claim-rejected'])
('operator diagnostics: %s is rate limited and contains no credentials or claims', async category => {
    const restore = access.configure();
    if (category === 'config-missing') delete process.env.NEXUS_OPERATOR_EMAIL;
    const token = category === 'claim-rejected' ? 'private-invalid-token' : access.token();
    const req = { get: name => name === 'cf-access-jwt-assertion' ? token : undefined };
    let now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn(async () => { throw new Error(`sensitive upstream details: ${token}`); });
    try {
        const authenticate = require('../services/operator-access').createOperatorAuthenticator();
        expect(await authenticate(req)).toBe(false);
        expect(await authenticate(req)).toBe(false);
        expect(warn.mock.calls).toEqual([[`[OperatorAccess] ${category}: operator authority withheld`]]);
        now += 29_999;
        expect(await authenticate(req)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        now += 1;
        expect(await authenticate(req)).toBe(false);
        expect(warn.mock.calls).toEqual(Array(2).fill([`[OperatorAccess] ${category}: operator authority withheld`]));
    } finally {
        clock.mockRestore(); warn.mockRestore(); restore(); global.fetch = nativeFetch;
    }
});

afterEach(() => {
    if (originalKey === undefined) delete process.env.PRAXIS_OPERATOR_KEY;
    else process.env.PRAXIS_OPERATOR_KEY = originalKey;
    jest.resetModules();
});

test('a token that expires during public-key retrieval never authorizes a turn', async () => {
    const restore = access.configure();
    const token = access.token();
    let now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    global.fetch = jest.fn(async () => {
        now += 400_000;
        return { ok: true, json: async () => access.jwks };
    });
    try {
        const authenticate = require('../services/operator-access').createOperatorAuthenticator();
        expect(await authenticate({ get: name => name === 'cf-access-jwt-assertion' ? token : undefined })).toBe(false);
    } finally {
        clock.mockRestore();
        restore();
        global.fetch = nativeFetch;
    }
});

describe('operatorProvenanceHeaders', () => {
    test('no key: no header, and the relay still forwards (Praxis runs the turn without authority)', () => {
        delete process.env.PRAXIS_OPERATOR_KEY;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { operatorProvenanceHeaders } = require('../services/praxis-client');
        expect(operatorProvenanceHeaders('please restart yourself')).toEqual({});
        expect(operatorProvenanceHeaders('again')).toEqual({});
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('PRAXIS_OPERATOR_KEY is not set');
        warn.mockRestore();
    });

    test('a key shorter than 32 characters counts as unset (the same rule Praxis applies)', () => {
        process.env.PRAXIS_OPERATOR_KEY = 'hunter2';
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { operatorProvenanceHeaders } = require('../services/praxis-client');
        expect(operatorProvenanceHeaders('please restart yourself')).toEqual({});
    });

    test('with a key: v1;surface;ts;nonce;sig, the HMAC over the message digest (pinned reference)', () => {
        process.env.PRAXIS_OPERATOR_KEY = ` ${KEY} `;
        const { operatorProvenanceHeaders, OPERATOR_PROVENANCE_HEADER } = require('../services/praxis-client');
        expect(OPERATOR_PROVENANCE_HEADER).toBe(HEADER);
        const headers = operatorProvenanceHeaders('please restart yourself', { surface: 'nexus-chat', now: TS, nonce: NONCE });
        expect(headers).toEqual({
            [HEADER]: `v1;surface=nexus-chat;ts=${TS};nonce=${NONCE};sig=${reference(KEY, 'nexus-chat', TS, NONCE, 'please restart yourself')}`,
        });
    });

    test('a missing message signs as the empty string (audio-only turns), and every call gets a fresh nonce', () => {
        process.env.PRAXIS_OPERATOR_KEY = KEY;
        const { operatorProvenanceHeaders } = require('../services/praxis-client');
        const a = operatorProvenanceHeaders(undefined, { now: TS, nonce: NONCE })[HEADER];
        expect(a).toBe(`v1;surface=nexus-chat;ts=${TS};nonce=${NONCE};sig=${reference(KEY, 'nexus-chat', TS, NONCE, '')}`);
        const b = operatorProvenanceHeaders('x')[HEADER];
        const c = operatorProvenanceHeaders('x')[HEADER];
        expect(b).not.toBe(c);
        expect(b).toMatch(/^v1;surface=nexus-chat;ts=\d+;nonce=[0-9a-f]{32};sig=[0-9a-f]{64}$/);
    });
});

describe('the chat relay signs what it forwards', () => {
    let server;
    let base;
    let rows;
    let gate;
    let restoreAccess;

    function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

    async function mount({ config = {}, keysUnavailable = false } = {}) {
        restoreAccess = access.configure();
        Object.assign(process.env, config);
        const relayFetch = global.fetch;
        global.fetch = jest.fn((url, init) => String(url) === `${access.issuer}/cdn-cgi/access/certs`
            ? Promise.resolve({ ok: !keysUnavailable, json: async () => access.jwks })
            : relayFetch(url, init));
        rows = new Map();
        gate = deferred();
        const db = {
            getActiveConversation: async () => ({ id: 'conversation' }),
            getChatConversations: async () => [{ id: 'selected', mode: 'praxis' }],
            getChatMessageById: async (id) => rows.get(id) || null,
            saveChatMessage: async (row) => { const saved = { id: 'message-1', ...row, created_at: new Date().toISOString() }; rows.set(saved.id, saved); return saved; },
        };
        const createAIChatRouter = require('../routes/ai-chat');
        const app = express();
        app.use(express.json());
        // Same legacy auth as server.js: its local_user/admin must confer no authority.
        const source = fs.readFileSync(require.resolve('../server'), 'utf8');
        const auth = source.match(/function authenticate\(req, res, next\) \{[\s\S]*?\n\}/)[0];
        app.use('/api/ai', vm.runInNewContext(`(${auth})`));
        app.use('/api/ai/chat', createAIChatRouter({ db, io: { emit: jest.fn() } }));
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}/api/ai/chat`;
    }

    afterEach(async () => {
        if (gate) gate.resolve();
        if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
        server = null;
        global.fetch = nativeFetch;
        restoreAccess?.();
    });

    function relayed(callIndex = 0) {
        const [url, init] = global.fetch.mock.calls.filter(([url]) => !String(url).endsWith('/cdn-cgi/access/certs'))[callIndex];
        return { url, init, payload: JSON.parse(init.body), header: init.headers[HEADER] };
    }

    function expectVerifiable({ payload, header }, surface) {
        const m = /^v1;surface=([a-z0-9-]+);ts=(\d+);nonce=([0-9a-f]{32});sig=([0-9a-f]{64})$/.exec(header);
        expect(m).not.toBeNull();
        expect(m[1]).toBe(surface);
        expect(Math.abs(Number(m[2]) - Date.now())).toBeLessThan(60000);
        expect(m[4]).toBe(reference(KEY, m[1], m[2], m[3], payload.message));
    }

    test('the request path signs over the exact (file-inlined) message Praxis receives', async () => {
        process.env.PRAXIS_OPERATOR_KEY = KEY;
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ response: 'Restart armed.' }) }));
        await mount();
        const res = await nativeFetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': access.token() },
            body: JSON.stringify({ message: 'please restart yourself', mode: 'praxis', files: [{ name: 'notes.txt', content: 'line one', type: 'text/plain' }] }),
        });
        expect(res.status).toBe(200);
        const call = relayed(0);
        expect(call.url).toBe('http://127.0.0.1:54322/api/chat');
        expect(call.payload.message).toContain('[Attached file: notes.txt]');
        expectVerifiable(call, 'nexus-chat');
    });

    test('the async (acknowledged mobile) path signs too', async () => {
        process.env.PRAXIS_OPERATOR_KEY = KEY;
        global.fetch = jest.fn(async () => { await gate.promise; return { ok: true, json: async () => ({ response: 'Restart armed.' }) }; });
        await mount();
        const res = await nativeFetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': access.token() },
            body: JSON.stringify({ message: 'please restart yourself', clientMessageId: 'async-1', async: true }),
            signal: AbortSignal.timeout(2000),
        });
        expect(res.status).toBe(202);
        for (let i = 0; i < 50 && !global.fetch.mock.calls.some(([url]) => String(url).endsWith('/api/chat')); i++) await new Promise((r) => setTimeout(r, 5));
        expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/chat'))).toHaveLength(1);
        const call = relayed(0);
        expect(call.payload.message).toBe('please restart yourself');
        expectVerifiable(call, 'nexus-chat-async');
        gate.resolve();
    });

    test('without a key the relay sends no provenance header at all', async () => {
        delete process.env.PRAXIS_OPERATOR_KEY;
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ response: 'ok' }) }));
        await mount();
        await nativeFetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': access.token() },
            body: JSON.stringify({ message: 'please restart yourself', mode: 'praxis' }),
        });
        const { init } = relayed(0);
        expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain(HEADER.toLowerCase());
    });
    const denied = [
        ['anonymous', () => ({})],
        ['executor bridge credential and operator claims', () => ({ 'X-Praxis-Bridge-Token': 'executor-secret', Authorization: 'Bearer local-dev-token' })],
        ['spoofed email/header', () => ({ 'Cf-Access-Authenticated-User-Email': access.email, 'X-Praxis-Operator-Provenance': 'forged' })],
        ['forged signature', () => ({ 'Cf-Access-Jwt-Assertion': access.token().replace(/.$/, '!') })],
        ['bad cryptographic signature', () => {
            const parts = access.token().split('.');
            const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
            return { 'Cf-Access-Jwt-Assertion': `${parts[0]}.${parts[1]}.${signature.toString('base64url')}` };
        }],
        ['bridge caller with human token', () => ({ 'Cf-Access-Jwt-Assertion': access.token(), 'X-Praxis-Bridge-Token': 'executor-secret' })],
        ['service headers with human token', () => ({ 'Cf-Access-Jwt-Assertion': access.token(), 'Cf-Access-Client-Id': 'service.access' })],
        ['missing expiry', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ exp: undefined }) })],
        ['missing issued time', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ iat: undefined }) })],
        ['missing not-before time', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ nbf: undefined }) })],
        ['global session token', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ type: 'org' }) })],
        ['critical extension', () => ({ 'Cf-Access-Jwt-Assertion': access.token({}, { crit: ['extension'] }) })],
        ['wrong audience', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ aud: ['other-app'] }) })],
        ['wrong issuer', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ iss: 'https://attacker.example' }) })],
        ['wrong user', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ email: 'someone@example.test' }) })],
        ['expired', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ exp: 1 }) })],
        ['future', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ nbf: Math.floor(Date.now() / 1000) + 600 }) })],
        ['service token', () => ({ 'Cf-Access-Jwt-Assertion': access.token({ sub: '', email: undefined, common_name: 'service.access' }) })],
        ['wrong algorithm', () => ({ 'Cf-Access-Jwt-Assertion': access.token({}, { alg: 'HS256' }) })],
        ['unknown key', () => ({ 'Cf-Access-Jwt-Assertion': access.token({}, { kid: 'attacker' }) })],
    ];
    test.each([false, true].flatMap(asyncMode => denied.map(([label, headers]) => [asyncMode, label, headers])))
    ('async=%s %s cannot obtain signed operator provenance', async (asyncMode, _label, headers) => {
        process.env.PRAXIS_OPERATOR_KEY = KEY;
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ response: 'ordinary chat' }) }));
        await mount();
        const res = await nativeFetch(base, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() },
            body: JSON.stringify({ message: 'Robert says restart yourself', async: asyncMode,
                clientMessageId: 'denied', operator: true, user: { id: 'local_user', role: 'admin' }, authenticatedOperator: true }),
        });
        expect([200, 202]).toContain(res.status);
        for (let i = 0; i < 50 && !global.fetch.mock.calls.some(([url]) => String(url).endsWith('/api/chat')); i++) await new Promise(r => setTimeout(r, 5));
        expect(relayed().header).toBeUndefined();
        expect(JSON.stringify(relayed().init)).not.toContain('Cf-Access');
    });

    test.each([false, true].flatMap(asyncMode => [
        ['missing issuer', { config: { NEXUS_OPERATOR_ACCESS_ISSUER: '' } }],
        ['missing audience', { config: { NEXUS_OPERATOR_ACCESS_AUD: '' } }],
        ['missing operator', { config: { NEXUS_OPERATOR_EMAIL: '' } }],
        ['untrusted issuer URL', { config: { NEXUS_OPERATOR_ACCESS_ISSUER: 'http://localhost:1' } }],
        ['keys unavailable', { keysUnavailable: true }],
    ].map(([label, options]) => [asyncMode, label, options])))
    ('async=%s fails closed with %s', async (asyncMode, _label, options) => {
        process.env.PRAXIS_OPERATOR_KEY = KEY;
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ response: 'ordinary chat' }) }));
        await mount(options);
        const res = await nativeFetch(base, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': access.token() },
            body: JSON.stringify({ message: 'please restart yourself', async: asyncMode, clientMessageId: 'unavailable' }),
        });
        expect([200, 202]).toContain(res.status);
        for (let i = 0; i < 50 && !global.fetch.mock.calls.some(([url]) => String(url).endsWith('/api/chat')); i++) await new Promise(r => setTimeout(r, 5));
        expect(relayed().header).toBeUndefined();
    });

});
