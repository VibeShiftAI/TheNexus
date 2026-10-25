import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OperatorSignInForm } from '../local-operator-sign-in.tsx';

test('sign-in sends only a transient operator bearer and clears the password; logout revokes the session', async () => {
    const old = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url, ...options, headers: { ...options.headers } });
        return { ok: true, json: async () => ({ operator: options.method === 'POST', expiresAt: Date.now() + 3600000 }) };
    };
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(createElement(OperatorSignInForm)));
        const input = host.querySelector('input[type="password"]'); assert.ok(input);
        input.value = 'synthetic-secret-only';
        await act(async () => host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
        const sent = calls.find(c => c.method === 'POST');
        assert.equal(sent.url, '/api/operator-session');
        assert.deepEqual(sent.headers, { Authorization: 'Bearer synthetic-secret-only' });
        assert.equal(sent.credentials, 'same-origin'); assert.equal(sent.cache, 'no-store');
        assert.equal(input.value, ''); assert.ok(!host.textContent.includes('synthetic-secret-only'));
        assert.match(host.textContent, /Signed in as Robert/);
        await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Sign out').click());
        assert.ok(calls.some(c => c.method === 'DELETE')); assert.match(host.textContent, /Signed out/);
        assert.equal(localStorage.getItem('nexus_local_operator'), null);
    } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = old; }
});

test('refused sign-in clears the credential and never claims operator identity', async () => {
    const old = globalThis.fetch;
    globalThis.fetch = async (_url, options = {}) => ({ ok: options.method !== 'POST', json: async () => ({ operator: false, error: 'Local operator sign-in is not configured.' }) });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
        await act(async () => root.render(createElement(OperatorSignInForm)));
        const input = host.querySelector('input'); input.value = 'wrong-synthetic-key';
        await act(async () => host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
        assert.equal(input.value, ''); assert.match(host.textContent, /not configured/);
        assert.ok(!host.textContent.includes('Signed in as Robert'));
    } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = old; }
});
