import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveBoardStateContext } from '../live-board-state.tsx';
import { EMPTY_FRAME_STATE, applyFrame } from '../live-board-state-logic.ts';
import { BridgeActivityProvider } from '../bridge/activity-provider.tsx';
import { DispatchStation } from '../bridge/dispatch-station.tsx';
import { useCoreState } from '../../hooks/use-core-state.ts';

test('the orb and Ops share visible council reads through busy, idle and sitting periods', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let hidden = false;
    t.mock.getter(document, 'hidden', () => hidden);
    const limits = [];
    const hiddenRosterReads = { arbiter: 0, benches: 0 };
    let sessions = [];
    t.mock.method(globalThis, 'fetch', async url => {
        const { pathname, searchParams } = new URL(url, window.location.origin);
        if (pathname === '/api/praxis/council/sessions') {
            limits.push(searchParams.get('limit'));
            return Response.json({ sessions, inFlight: sessions[0]?.sessionId });
        }
        if (hidden && pathname === '/api/praxis/council/arbiter') hiddenRosterReads.arbiter++;
        if (hidden && pathname === '/api/praxis/council/benches') hiddenRosterReads.benches++;
        if (pathname.includes('board')) return Response.json([]);
        return Response.json({ benches: [] });
    });

    const host = document.createElement('div');
    const root = createRoot(host);
    t.after(() => act(() => root.unmount()));
    function Orb() { return createElement('output', null, useCoreState().council?.topic); }
    let live = { ...EMPTY_FRAME_STATE, connected: true, presence: { activity: 'idle' } };
    const render = () => act(async () => root.render(
        createElement(LiveBoardStateContext.Provider, { value: live },
            createElement(BridgeActivityProvider, null, createElement(Orb), createElement(DispatchStation)))
    ));
    const tick = ms => act(async () => t.mock.timers.tick(ms));
    const emit = async event => {
        live = applyFrame(live, { eventId: String(Date.now()), at: new Date().toISOString(), ...event }, true);
        await render();
    };
    const visibility = async value => {
        hidden = value;
        await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    };
    const counts = {};
    let previous = 0;
    function record(phase) {
        counts[phase] = limits.length - previous;
        previous = limits.length;
    }

    await render();
    record('mount');
    for (let i = 0; i < 3; i++) {
        await emit({ type: 'executor.progress', progress: { executor: 'codex', taskId: 'task', phase: 'testing' } });
        await tick(2000);
    }
    record('executor');
    await tick(24000);
    record('idle');
    const session = { sessionId: 'review', topic: 'Review request traffic', phase: 'deliberation',
        createdAt: Date.now(), metadata: {}, voices: [] };
    sessions = [session];
    await emit({ type: 'council.update', council: { ...session, topic: 'Convening', seats: [], thesisCount: 0, convenedAt: session.createdAt } });
    await tick(2000);
    record('council');
    await tick(5000);
    record('sitting');
    await visibility(true);
    for (let i = 0; i < 6; i++) await tick(5000);
    record('hidden');
    await visibility(false);
    record('return');

    t.diagnostic(JSON.stringify({ counts, total: limits.length, hiddenRosterReads }));
    assert.deepEqual(counts, { mount: 1, executor: 0, idle: 1, council: 1, sitting: 1, hidden: 0, return: 1 });
    assert.deepEqual(hiddenRosterReads, { arbiter: 0, benches: 0 });
    assert.ok(limits.every(limit => limit === '12'));
    assert.equal(host.querySelector('output').textContent, session.topic);
    assert.match(host.querySelector('.dispatch-map').textContent, /Council deliberating/);
});
