import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityFeed } from '../activity-feed.tsx';
import { getActivity, getActivityEvents, getPins } from '../../lib/nexus/projects.ts';

const date = '2026-11-20T12:00:00Z';
const event = id => ({
    id, event_type: 'update', title: `Event ${id}`, created_at: date,
    severity: 'info', source: 'praxis', metadata: {}, requires_action: 0,
});
const commit = id => ({
    projectId: 'p', projectName: 'Test', type: 'commit', hash: `abc${id}`,
    message: `Commit ${id}`, author: 'Operator', date,
});

test('failed polls keep each source on screen and the next scheduled poll recovers without console errors', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const errors = t.mock.method(console, 'error', () => {});
    const warnings = t.mock.method(console, 'warn', () => {});
    let eventsCalls = 0;
    let commitCalls = 0;
    t.mock.method(globalThis, 'fetch', async url => {
        switch (new URL(url, 'http://localhost').pathname) {
            case '/api/ag/events':
                eventsCalls++;
                if (eventsCalls === 2) return new Response(null, { status: 503 });
                return Response.json([event(eventsCalls)]);
            case '/api/activity':
                commitCalls++;
                if (commitCalls === 3) throw new TypeError('connection lost');
                return Response.json([commit(commitCalls)]);
            case '/api/praxis/hitl/pending':
                return Response.json({ requests: [] });
            default:
                throw new Error(`Unexpected request ${url}`);
        }
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    t.after(() => act(() => root.unmount()));
    const nextPoll = () => act(async () => { t.mock.timers.tick(60_000); });
    await act(async () => root.render(createElement(ActivityFeed)));
    assert.match(host.textContent, /Event 1/);
    await nextPoll();
    assert.match(host.textContent, /Event 1/);
    assert.match(host.textContent, /Commit 2/);
    assert.match(host.textContent, /Retrying automatically/);
    await nextPoll();
    assert.match(host.textContent, /Event 3/);
    assert.doesNotMatch(host.textContent, /Event 1/);
    assert.match(host.textContent, /Commit 2/);
    await nextPoll();
    assert.match(host.textContent, /Commit 4/);
    assert.doesNotMatch(host.textContent, /Retrying automatically/);
    assert.equal(eventsCalls, 4);
    assert.equal(errors.mock.callCount(), 0);
    const diagnostics = warnings.mock.calls.map(call => call.arguments.join(' '));
    assert.ok(diagnostics.some(message => message.includes('/api/ag/events') && message.includes('HTTP 503')));
    assert.ok(diagnostics.some(message => message.includes('/api/activity') && message.includes('connection lost')));
});

test('overlapping polls can show a good response while the next is pending, and a late response cannot roll it back', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const pending = [];
    t.mock.method(globalThis, 'fetch', async url => {
        if (url.startsWith('/api/ag/events?')) return new Promise(resolve => pending.push(resolve));
        return Response.json(url.startsWith('/api/activity?') ? [] : { requests: [] });
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    t.after(() => act(() => root.unmount()));
    await act(async () => root.render(createElement(ActivityFeed)));
    await act(async () => { t.mock.timers.tick(60_000); });
    await act(async () => pending[0](Response.json([event(1)])));
    assert.match(host.textContent, /Event 1/);
    await act(async () => { t.mock.timers.tick(60_000); });
    await act(async () => pending[2](Response.json([event(3)])));
    await act(async () => pending[1](Response.json([event(2)])));
    assert.match(host.textContent, /Event 3/);
    assert.doesNotMatch(host.textContent, /Event 2/);
});

for (const [path, read] of [
    ['/api/ag/events', getActivityEvents],
    ['/api/activity', getActivity],
    ['/api/pins', getPins],
]) {
    test(`${path} identifies the request and preserves HTTP and network failures`, async t => {
        const transport = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }));
        await assert.rejects(read(), err => err.message.includes(path) && err.message.includes('HTTP 429'));
        transport.mock.mockImplementation(async () => { throw new TypeError('connection reset'); });
        await assert.rejects(read(), err => err.message.includes(path) && err.message.includes('connection reset'));
    });
}
