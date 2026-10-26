import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOperatorSessionClient, localOperatorHeaders, LOCAL_OPERATOR_PROOF_KEY } from '../local-operator-session.ts';

function client(options) {
    const values = new Map();
    return createLocalOperatorSessionClient({ storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }, ...options });
}

test('local browser establishes a session automatically without a credential or form', async () => {
    const calls = [];
    const ensure = client({ origin: () => 'http://localhost:3000', request: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ operator: calls.length > 1, proof: 'p'.repeat(43), bootstrapUrl: 'http://localhost:4000/api/operator-session/bootstrap' }) };
    } });
    assert.equal(await ensure(), true);
    assert.equal(calls[1].url, 'http://localhost:4000/api/operator-session/bootstrap');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.credentials, 'include');
    assert.equal(calls[1].options.headers, undefined);
    assert.deepEqual(calls[2].options.headers, { 'X-Nexus-Local-Proof': 'p'.repeat(43) });
    assert.equal(calls[2].options.redirect, 'error');
});
test('the Mac shell renews natively and rechecks the cookie without a browser bootstrap', async () => {
    let renewed = false, requests = 0;
    const ensure = client({ origin: () => 'http://localhost:3000',
        nativeRenew: async () => { renewed = true; return true; },
        request: async url => { requests++; assert.equal(url, '/api/operator-session'); return { ok: true, json: async () => ({ operator: renewed }) }; },
    });
    assert.equal(await ensure(), true); assert.equal(requests, 2);
});
test('tunnel sessions are untouched; invalid bootstrap destinations and failures confer no authority', async () => {
    const skip = client({ origin: () => 'https://nexus.vibeshiftai.com', request: () => { throw new Error('must not call'); } });
    assert.equal(await skip(), false);
    for (const bootstrapUrl of ['https://evil.test', 'http://localhost.evil.test:4000/api/operator-session/bootstrap', 'http://localhost:4000/api/other']) {
        let calls = 0;
        const ensure = client({ origin: () => 'http://localhost:3000', request: async () => { calls++; return { ok: true, json: async () => ({ operator: false, bootstrapUrl }) }; } });
        assert.equal(await ensure(), false); assert.equal(calls, 1);
    }
    const refused = client({ origin: () => 'http://localhost:3000', request: async () => ({ ok: false }) });
    assert.equal(await refused(), false);
});

test('a still-valid session renews before its one-hour expiry', async () => {
    let renewed = false;
    const ensure = client({ origin: () => 'http://localhost:3000', now: () => 45 * 60_000,
        nativeRenew: async () => { renewed = true; return true; },
        request: async () => ({ ok: true, json: async () => ({ operator: true, expiresAt: 60 * 60_000 }) }),
    });
    assert.equal(await ensure(), true); assert.equal(renewed, true);
});

test('origin proof is attached only to this dashboard API, never another localhost port or remote host', () => {
    const prior = globalThis.window;
    const proof = 'z'.repeat(43);
    globalThis.window = { location: new URL('http://localhost:3000/mail'), localStorage: { getItem: name => name === LOCAL_OPERATOR_PROOF_KEY ? proof : null } };
    try {
        assert.deepEqual(localOperatorHeaders('/api/documents'), { 'X-Nexus-Local-Proof': proof });
        for (const url of ['http://localhost:4000/api/operator-session/bootstrap', 'http://localhost:5000/api', 'https://evil.test/api', '/session/probe', '//evil.test/api', '/apix']) {
            assert.deepEqual(localOperatorHeaders(url), {});
        }
    } finally { globalThis.window = prior; }
});
