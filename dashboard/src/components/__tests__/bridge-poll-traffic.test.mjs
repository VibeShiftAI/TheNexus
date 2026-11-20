import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { withNexusReadBackoff } from '../../lib/poll-fetch.ts';
import { HitlInboxProvider, useHitlInbox } from '../../hooks/use-hitl-inbox.ts';
import { AmbientMode } from '../bridge/ambient-mode.tsx';
import { useActiveWork } from '../../hooks/use-active-work.ts';
import { useTokenUsage } from '../../hooks/use-token-usage.ts';

test('three bridge panels share active and usage polling and wait through a server refusal', async t => {
    const root = createRoot(document.createElement('div'));
    t.after(() => act(() => root.unmount()));
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
    const calls = { active: 0, usage: 0 };
    t.mock.method(globalThis, 'fetch', withNexusReadBackoff(async url => {
        if (String(url).includes('/dispatches/active')) {
            calls.active++;
            if (calls.active === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
            return Response.json({ active: [] });
        }
        if (String(url).includes('/token-usage')) calls.usage++;
        return Response.json({});
    }, window.location.origin));
    function Panel() { useActiveWork(); useTokenUsage(); return null; }
    await act(async () => root.render(createElement('div', null, ...[1,2,3].map(key => createElement(Panel, { key })))));
    for (let i = 0; i < 5; i++) await act(async () => t.mock.timers.tick(10000));
    assert.deepEqual(calls, { active: 1, usage: 1 });
    await act(async () => t.mock.timers.tick(10000));
    assert.deepEqual(calls, { active: 2, usage: 2 });
});

test('one inbox serves three panels and a closed ambient overlay makes no telemetry reads', async t => {
    const root = createRoot(document.createElement('div'));
    t.after(() => act(() => root.unmount()));
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(String(url));
        return Response.json({ requests: [], sessions: [], active: [], today: { total: 0 } });
    });
    function Panel() { useHitlInbox(); return null; }
    await act(async () => root.render(createElement(HitlInboxProvider, null,
        createElement(AmbientMode), ...[1, 2, 3].map(key => createElement(Panel, { key })))));
    assert.deepEqual(calls, ['/api/praxis/hitl/pending']);
});

test('a dated general refusal pauses other local GETs while health, writes and other origins remain available', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 });
    const calls = [];
    const get = withNexusReadBackoff(async (url, init) => {
        calls.push([String(url), init?.method || 'GET']);
        if (calls.length === 1) return new Response(null, {
            status: 429, headers: { 'Retry-After': new Date(160000).toUTCString(), 'X-Nexus-Allowance': 'general' },
        });
        return Response.json({});
    }, window.location.origin);
    assert.equal((await get('/api/tasks')).status, 429);
    assert.equal((await get('/api/projects')).status, 429);
    assert.equal((await get('/api/health')).status, 200);
    assert.equal((await get('/api/projects', { method: 'PATCH' })).status, 200);
    assert.equal((await get('https://example.test/api/tasks')).status, 200);
    assert.equal(calls.length, 4);
    t.mock.timers.tick(60000);
    assert.equal((await get('/api/projects')).status, 200);
    assert.equal(calls.length, 5);
});

test('a strict-mode remount keeps a single outstanding dispatch read', async t => {
    const root = createRoot(document.createElement('div'));
    t.after(() => act(() => root.unmount()));
    const calls = [];
    t.mock.method(globalThis, 'fetch', async url => {
        calls.push(String(url));
        return Response.json({ active: [] });
    });
    function Panel() { useActiveWork(); return null; }
    await act(async () => root.render(createElement(StrictMode, null, createElement(Panel))));
    assert.deepEqual(calls.filter(url => url.includes('/dispatches/active')), ['/api/dispatches/active?limit=5']);
});
