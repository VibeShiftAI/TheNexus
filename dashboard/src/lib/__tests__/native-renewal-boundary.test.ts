import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionLifecycle, MAX_RENEWAL_DEFERRAL_MS } from '../connection-lifecycle';
import { detectRenewalBridge, RENEWAL_RESULT_EVENT, openSignInWindow } from '../session-renewal';

// Exercise the actual page adapter and lifecycle together. The native gate is
// modeled here; renewal_gate.rs tests the compiled native admission logic.
for (const scheduled of [false, true]) {
    test(`native boundary: transient failure recovers with a real exchange (scheduled=${scheduled})`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
        const target = new EventTarget();
        let running = scheduled;
        let completed = -Infinity;
        let exchanges = 0;
        let requests = 0;
        let ok = false;
        const w = Object.assign(target, {
            __NEXUS_SHELL__: { tabs: [], capabilities: ['renew-session'] },
            location: { origin: 'https://nexus.example', assign(href: string) {
                requests++;
                const requestId = new URL(href).searchParams.get('request');
                const reply = (detail: object) => target.dispatchEvent(new CustomEvent(RENEWAL_RESULT_EVENT, { detail: { ...detail, requestId } }));
                if (running || Date.now() - completed < 30_000) {
                    reply({ status: 'deferred', retryAfterMs: running ? 5_000 : 30_000 - (Date.now() - completed) });
                    return;
                }
                running = true;
                exchanges++;
                setTimeout(() => {
                    running = false;
                    completed = Date.now();
                    ok = exchanges >= (scheduled ? 1 : 2);
                    reply({ status: ok ? 'renewed' : 'failed' });
                }, 18_000);
            } },
        });
        if (scheduled) setTimeout(() => { running = false; completed = Date.now(); }, 45_000);
        const lifecycle = createConnectionLifecycle({ target: undefined, renewal: detectRenewalBridge(w as never), probe: async () => ok ? 'ok' : 'reauth' });
        let recoveries = 0;
        lifecycle.onRecovered(() => recoveries++);
        try {
            lifecycle.signal('manual');
            for (let tick = 0; tick < 220; tick++) {
                t.mock.timers.tick(500);
                await new Promise(setImmediate);
            }
            assert.equal(lifecycle.getState().phase, 'live');
            assert.equal(exchanges, scheduled ? 1 : 2);
            assert.equal(recoveries, 1);
            assert.ok(requests < 20, 'bounded native requests, even while another exchange is running');
            console.log(JSON.stringify({ scheduled, phase: lifecycle.getState().phase, requests, actualExchanges: exchanges }));
        } finally { lifecycle.dispose(); t.mock.timers.reset(); }
    });
}

test('older travel shells neither consume renewal attempts nor open sign-in in a different profile', () => {
    let requests = 0;
    const w = Object.assign(new EventTarget(), {
        __NEXUS_SHELL__: { tabs: [] },
        location: { origin: 'https://nexus.example', assign() { requests++; } },
        open() { requests++; return null; },
    });
    assert.equal(detectRenewalBridge(w as never), null);
    assert.equal(openSignInWindow('https://nexus.example/session/renewed', w as never), null);
    assert.equal(requests, 0);
});

test('permanent native deferral stops on an elapsed budget and explicit retry can recover', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    let requests = 0;
    let repaired = false;
    let ok = false;
    const lifecycle = createConnectionLifecycle({
        target: undefined,
        probe: async () => ok ? 'ok' : 'reauth',
        renewal: { kind: 'travel-shell', request: async () => {
            requests++;
            if (repaired) { ok = true; return { status: 'renewed' }; }
            return { status: 'deferred', retryAfterMs: 5000 };
        } },
    });
    const step = async (ms: number) => { t.mock.timers.tick(ms); await new Promise(setImmediate); };
    try {
        lifecycle.signal('manual'); await step(500);
        for (let elapsed = 0; elapsed < MAX_RENEWAL_DEFERRAL_MS; elapsed += 5000) await step(5000);
        assert.equal(lifecycle.getState().phase, 'reauth');
        assert.equal(lifecycle.getState().renewals, 0);
        const stopped = requests;
        await step(600_000);
        assert.equal(requests, stopped, 'no renewal storm after a wedged native gate');
        repaired = true;
        lifecycle.signal('manual'); await step(500); await step(0);
        assert.equal(lifecycle.getState().phase, 'live');
    } finally { lifecycle.dispose(); t.mock.timers.reset(); }
});
