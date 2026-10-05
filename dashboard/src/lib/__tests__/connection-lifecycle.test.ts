import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
    COALESCE_MS,
    MAX_RENEWAL_ATTEMPTS,
    MIN_RECOVERY_GAP_MS,
    REAUTH_REPROBE_MIN_MS,
    RENEWAL_WAIT_MS,
    RETRY_BASE_MS,
    CLOCK_TICK_MS,
    CLOCK_JUMP_MS,
    SIGN_IN_WINDOW_POLL_MS,
    createConnectionLifecycle,
    looksLikeTransportFailure,
    probeApiHealth,
    responseLooksJson,
    type ProbeOutcome,
    type RecoverySignal,
    type RenewalBridge,
    type SignInWindow,
} from "../connection-lifecycle";

/** Drain every pending microtask (the probe's `await` chain) without touching mocked timers. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A popup the test can close or inspect. */
class FakeSignInWindow implements SignInWindow {
    closed = false;
    closeCalls = 0;
    focusCalls = 0;
    close() {
        this.closeCalls += 1;
        this.closed = true;
    }
    focus() {
        this.focusCalls += 1;
    }
}

function harness(
    outcomes: ProbeOutcome[] | (() => Promise<ProbeOutcome>),
    opts: {
        visible?: () => boolean;
        storage?: Map<string, string>;
        startAt?: number;
        renewal?: RenewalBridge | null;
        openSignIn?: (href: string) => SignInWindow | null;
    } = {},
) {
    let clock = opts.startAt ?? 1_000_000;
    const probeCalls: number[] = [];
    const opened: string[] = [];
    const windows: FakeSignInWindow[] = [];
    const recovered: RecoverySignal[] = [];
    const queue = Array.isArray(outcomes) ? [...outcomes] : null;
    const probe = async () => {
        probeCalls.push(clock);
        if (queue) return queue.length > 1 ? (queue.shift() as ProbeOutcome) : queue[0];
        return (outcomes as () => Promise<ProbeOutcome>)();
    };
    const storage = opts.storage;
    const lifecycle = createConnectionLifecycle({
        now: () => clock,
        probe,
        target: window as Window & typeof globalThis,
        isVisible: opts.visible ?? (() => true),
        currentHref: () => "http://localhost/ops",
        storage: storage
            ? { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) }
            : null,
        renewal: opts.renewal ?? null,
        signInHref: () => "http://localhost/session/renewed",
        openSignIn:
            opts.openSignIn ??
            ((href) => {
                opened.push(href);
                const w = new FakeSignInWindow();
                windows.push(w);
                return w;
            }),
    });
    lifecycle.onRecovered((r) => recovered.push(r));
    return {
        lifecycle,
        probeCalls,
        opened,
        windows,
        recovered,
        /** Advance the fake clock AND the mocked timers in lockstep, then drain microtasks. */
        async step(ms: number) {
            clock += ms;
            mock.timers.tick(ms);
            await flush();
        },
        jumpClock(ms: number) {
            clock += ms;
        },
    };
}

function withTimers<T>(fn: () => Promise<T>): Promise<T> {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    return fn().finally(() => mock.timers.reset());
}

test("wake signals fired together coalesce into ONE probe; a passing probe broadcasts recovery once and lands in `live`", () =>
    withTimers(async () => {
        const h = harness(["ok"]);
        const stop = h.lifecycle.start();
        try {
            h.lifecycle.signal("visible");
            h.lifecycle.signal("focus");
            h.lifecycle.signal("online");
            assert.equal(h.probeCalls.length, 0, "nothing runs before the coalesce window closes");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            assert.deepEqual(h.recovered, ["online"], "the latest wake reason names the run");
            const s = h.lifecycle.getState();
            assert.equal(s.phase, "live");
            assert.equal(s.lastLiveAt > 0, true);
            assert.equal(s.failures, 0);
        } finally {
            stop();
            h.lifecycle.dispose();
        }
    }));

test("backend restart: a transport failure probes, the outage is `offline` with doubling backoff, and the retry that passes broadcasts recovery", () =>
    withTimers(async () => {
        const h = harness(["unreachable", "unreachable", "ok"]);
        try {
            h.lifecycle.noteTransportFailure("socket");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            assert.equal(h.lifecycle.getState().phase, "offline");
            assert.equal(h.lifecycle.getState().failures, 1);
            assert.deepEqual(h.recovered, []);

            // More failure reports during the outage add no probes: the retry timer owns the cadence.
            h.lifecycle.noteTransportFailure("sse");
            h.lifecycle.noteTransportFailure("fetch");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);

            // First retry at 3s fails → failures 2, next retry at 6s.
            await h.step(RETRY_BASE_MS - COALESCE_MS);
            assert.equal(h.probeCalls.length, 2);
            assert.equal(h.lifecycle.getState().failures, 2);
            await h.step(RETRY_BASE_MS * 2 - 1);
            assert.equal(h.probeCalls.length, 2, "backoff doubled: not yet");
            await h.step(1);
            assert.equal(h.probeCalls.length, 3);
            assert.equal(h.lifecycle.getState().phase, "live");
            assert.equal(h.lifecycle.getState().failures, 0);
            assert.deepEqual(h.recovered, ["retry"]);

            // Quiet afterwards: no stray timers keep probing.
            await h.step(60_000);
            assert.equal(h.probeCalls.length, 3);
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("a transport failing while the API probes healthy is throttled to one probe per 10s and does NOT broadcast recovery (no deck-wide refetch loop)", () =>
    withTimers(async () => {
        const h = harness(["ok"]);
        try {
            for (let i = 0; i < 5; i += 1) h.lifecycle.noteTransportFailure("fetch");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            assert.deepEqual(h.recovered, [], "the transport sorts itself out; nobody is told to refetch");
            assert.equal(h.lifecycle.getState().phase, "live");

            h.lifecycle.noteTransportFailure("sse");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1, "inside the throttle window");

            await h.step(10_000);
            h.lifecycle.noteTransportFailure("sse");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2, "throttle window passed");
            assert.deepEqual(h.recovered, []);
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("while live, a wake signal inside the gap after a passing probe is redundant; after the gap it probes and broadcasts", () =>
    withTimers(async () => {
        const h = harness(["ok"]);
        try {
            h.lifecycle.signal("focus");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            assert.equal(h.recovered.length, 1);

            h.lifecycle.signal("focus");
            h.lifecycle.signal("visible");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1, "alt-tabbing back within seconds costs nothing");

            await h.step(MIN_RECOVERY_GAP_MS);
            h.lifecycle.signal("visible");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2);
            assert.deepEqual(h.recovered, ["focus", "visible"]);
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("expired session in a browser: `reauth` has no automatic retry and never navigates or opens anything by itself; wake signals re-probe at most every 30s", () =>
    withTimers(async () => {
        const h = harness(["reauth"]);
        try {
            h.lifecycle.noteTransportFailure("fetch");
            await h.step(COALESCE_MS);
            assert.equal(h.lifecycle.getState().phase, "reauth");
            assert.equal(h.lifecycle.getState().renewalKind, null, "no shell: nothing can renew without the operator");
            assert.equal(h.probeCalls.length, 1);

            // No retry timer against the login page, ever.
            await h.step(5 * 60_000);
            assert.equal(h.probeCalls.length, 1);
            assert.deepEqual(h.opened, [], "and never opens the sign-in window on its own");
            assert.deepEqual(h.recovered, []);

            // Transport failures are ignored in reauth; wake signals are rate-limited.
            h.lifecycle.noteTransportFailure("socket");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            h.lifecycle.signal("focus");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2, "a wake after the window re-probes (the operator may have signed in elsewhere)");
            h.lifecycle.signal("focus");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2, "inside the 30s window: no storm");
            await h.step(REAUTH_REPROBE_MIN_MS);
            h.lifecycle.signal("visible");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 3);
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("inside a shell, an Access bounce first asks the shell to renew: bounded attempts with growing waits, the document never navigates, then `reauth`", () =>
    withTimers(async () => {
        const requests: number[] = [];
        const bridge: RenewalBridge = {
            kind: "travel-shell",
            request: () => {
                requests.push(1);
                return true;
            },
        };
        const h = harness(["reauth"], { renewal: bridge });
        try {
            assert.equal(h.lifecycle.getState().renewalKind, "travel-shell");
            h.lifecycle.noteTransportFailure("fetch");
            await h.step(COALESCE_MS);
            let s = h.lifecycle.getState();
            assert.equal(s.phase, "renewing");
            assert.equal(s.renewals, 1);
            assert.equal(requests.length, 1);
            assert.equal(h.probeCalls.length, 1);

            // Attempt 1 waits, then re-probes; still refused: attempt 2, longer wait.
            await h.step(RENEWAL_WAIT_MS[0] - 1);
            assert.equal(h.probeCalls.length, 1, "nothing before the wait ends");
            await h.step(1);
            assert.equal(h.probeCalls.length, 2);
            s = h.lifecycle.getState();
            assert.equal(s.phase, "renewing");
            assert.equal(s.renewals, 2);
            assert.equal(requests.length, 2);

            await h.step(RENEWAL_WAIT_MS[1]);
            assert.equal(h.probeCalls.length, 3);
            s = h.lifecycle.getState();
            assert.equal(s.phase, "renewing");
            assert.equal(s.renewals, 3);
            assert.equal(requests.length, 3);

            // The last wait runs out: the shell could not renew, the operator must.
            await h.step(RENEWAL_WAIT_MS[2]);
            assert.equal(h.probeCalls.length, 4);
            s = h.lifecycle.getState();
            assert.equal(s.phase, "reauth");
            assert.equal(s.renewals, MAX_RENEWAL_ATTEMPTS);
            assert.equal(requests.length, MAX_RENEWAL_ATTEMPTS, "no fourth request");

            await h.step(5 * 60_000);
            assert.equal(h.probeCalls.length, 4, "no retry timer against the login page");
            assert.equal(requests.length, MAX_RENEWAL_ATTEMPTS);
            assert.deepEqual(h.opened, []);
            assert.deepEqual(h.recovered, []);
        } finally {
            h.lifecycle.dispose();
        }

        // A shell that refuses the request gets no wait: straight to reauth.
        const refusing = harness(["reauth"], { renewal: { kind: "travel-shell", request: () => false } });
        try {
            refusing.lifecycle.signal("manual");
            await refusing.step(COALESCE_MS);
            assert.equal(refusing.lifecycle.getState().phase, "reauth");
            assert.equal(refusing.probeCalls.length, 1);
        } finally {
            refusing.lifecycle.dispose();
        }
    }));

test("shell renewal that works: the shell's `renewed` event cuts the wait short, the probe passes, the deck is told to refetch, and the counters reset", () =>
    withTimers(async () => {
        const requests: number[] = [];
        const h = harness(["reauth", "ok"], {
            renewal: {
                kind: "mobile-shell",
                request: () => {
                    requests.push(1);
                    return true;
                },
            },
        });
        const stop = h.lifecycle.start();
        try {
            h.lifecycle.noteTransportFailure("sse");
            await h.step(COALESCE_MS);
            assert.equal(h.lifecycle.getState().phase, "renewing");
            assert.equal(requests.length, 1);

            // The shell planted the cookie a moment later and said so.
            await h.step(300);
            window.dispatchEvent(new window.Event("nexus:session-renewed"));
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2);
            const s = h.lifecycle.getState();
            assert.equal(s.phase, "live");
            assert.equal(s.renewals, 0);
            assert.equal(s.signIn, "idle");
            assert.deepEqual(h.recovered, ["renewed"], "every domain refetches: nothing held is known to be current");

            // The scheduled re-probe was cancelled: nothing else fires or asks again.
            await h.step(RENEWAL_WAIT_MS[0] + 1000);
            assert.equal(h.probeCalls.length, 2);
            assert.equal(requests.length, 1);
        } finally {
            stop();
            h.lifecycle.dispose();
        }
    }));

test("the explicit action opens the sign-in flow in its own window and leaves this document alone; a second click focuses that window; its announcement probes, and a passing probe closes it", () =>
    withTimers(async () => {
        const storage = new Map<string, string>();
        const h = harness(["reauth", "ok"], { storage });
        const stop = h.lifecycle.start();
        try {
            h.lifecycle.noteTransportFailure("fetch");
            await h.step(COALESCE_MS);
            assert.equal(h.lifecycle.getState().phase, "reauth");

            assert.equal(h.lifecycle.reauthenticate(), "opened");
            assert.deepEqual(h.opened, ["http://localhost/session/renewed"]);
            let s = h.lifecycle.getState();
            assert.equal(s.signIn, "window-open");
            assert.equal(s.reauthAttempted, true);
            assert.equal(storage.has("nexus:reauth-attempted-at"), true);

            assert.equal(h.lifecycle.reauthenticate(), "opened");
            assert.equal(h.windows.length, 1, "no second window");
            assert.equal(h.windows[0].focusCalls, 1);

            // The window came back from the Access flow and announced it.
            window.dispatchEvent(new window.Event("nexus:session-renewed"));
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2);
            s = h.lifecycle.getState();
            assert.equal(s.phase, "live");
            assert.equal(s.signIn, "idle");
            assert.equal(s.reauthAttempted, false);
            assert.equal(storage.has("nexus:reauth-attempted-at"), false);
            assert.equal(h.windows[0].closeCalls, 1, "the window that did its job is closed");
            assert.deepEqual(h.recovered, ["renewed"]);

            // The close-poll stopped with it: nothing else probes.
            await h.step(10 * SIGN_IN_WINDOW_POLL_MS);
            assert.equal(h.probeCalls.length, 2);
        } finally {
            stop();
            h.lifecycle.dispose();
        }
    }));

test("a sign-in window closed without announcing still gets one probe; refused again, the state returns to `reauth` with the action available", () =>
    withTimers(async () => {
        const h = harness(["reauth"]);
        try {
            h.lifecycle.noteTransportFailure("fetch");
            await h.step(COALESCE_MS);
            assert.equal(h.lifecycle.reauthenticate(), "opened");
            h.windows[0].closed = true;
            await h.step(SIGN_IN_WINDOW_POLL_MS);
            assert.equal(h.lifecycle.getState().signIn, "idle");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2, "one probe for the closed window");
            const s = h.lifecycle.getState();
            assert.equal(s.phase, "reauth");
            assert.equal(s.reauthAttempted, true, "the 'did not restore the session' copy applies");
            assert.equal(h.lifecycle.reauthenticate(), "opened");
            assert.equal(h.windows.length, 2);
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("a blocked sign-in window never destroys the document; its attempt flag clears once a probe passes", () =>
    withTimers(async () => {
        const storage = new Map<string, string>();
        const h = harness(["reauth"], { storage, openSignIn: () => null });
        try {
            h.lifecycle.noteTransportFailure("fetch");
            await h.step(COALESCE_MS);
            assert.equal(h.lifecycle.reauthenticate(), "blocked");
            assert.equal(h.lifecycle.getState().signIn, "blocked");

            assert.equal(h.lifecycle.signInHere(), false);
            assert.equal(h.lifecycle.getState().reauthAttempted, true);
            assert.equal(storage.has("nexus:reauth-attempted-at"), true, "survives the navigation for the 'still refused' copy");
        } finally {
            h.lifecycle.dispose();
        }

        // The tab comes back from the sign-in round trip (a new page, a new
        // lifecycle, a few seconds later): the flag is read, and cleared again
        // once a probe passes.
        const attemptedAt = Number(storage.get("nexus:reauth-attempted-at"));
        const back = harness(["ok"], { storage, startAt: attemptedAt + 10_000 });
        try {
            assert.equal(back.lifecycle.getState().reauthAttempted, true);
            back.lifecycle.signal("manual");
            await back.step(COALESCE_MS);
            assert.equal(back.lifecycle.getState().phase, "live");
            assert.equal(back.lifecycle.getState().reauthAttempted, false);
            assert.equal(storage.has("nexus:reauth-attempted-at"), false);
        } finally {
            back.lifecycle.dispose();
        }
    }));

test("reauthenticate() and signInHere() outside `reauth` are no-ops: neither can be used to reload or pop up on a healthy page", () =>
    withTimers(async () => {
        const h = harness(["ok"]);
        try {
            assert.equal(h.lifecycle.reauthenticate(), "noop");
            assert.equal(h.lifecycle.signInHere(), false);
            assert.deepEqual(h.opened, []);
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("single flight: signals during an in-flight probe never start a second probe; at most one follow-up, dropped when the verdict already answers it", () =>
    withTimers(async () => {
        let resolveProbe: ((o: ProbeOutcome) => void) | null = null;
        const h = harness(() => new Promise<ProbeOutcome>((resolve) => { resolveProbe = resolve; }));
        try {
            h.lifecycle.signal("manual");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            assert.equal(h.lifecycle.getState().phase, "recovering");
            h.lifecycle.signal("visible");
            h.lifecycle.signal("focus");
            h.lifecycle.noteTransportFailure("socket");
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1, "still the same probe");
            resolveProbe!("ok");
            await flush();
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1, "the queued wake is redundant right after a pass");
            assert.equal(h.lifecycle.getState().phase, "live");
            assert.equal(h.recovered.length, 1);
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("browser `offline` marks the phase at once without probing; `online` probes once and broadcasts", () =>
    withTimers(async () => {
        const h = harness(["ok"]);
        const stop = h.lifecycle.start();
        try {
            window.dispatchEvent(new window.Event("offline"));
            assert.equal(h.lifecycle.getState().phase, "offline");
            await h.step(60_000);
            assert.equal(h.probeCalls.length, 0, "no probes while the browser says there is no network");

            window.dispatchEvent(new window.Event("online"));
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            assert.equal(h.lifecycle.getState().phase, "live");
            assert.deepEqual(h.recovered, ["online"]);
        } finally {
            stop();
            h.lifecycle.dispose();
        }
    }));

test("a hidden page does not retry on a timer; the next `visible` probes immediately", () =>
    withTimers(async () => {
        let visible = false;
        const h = harness(["unreachable", "ok"], { visible: () => visible });
        const stop = h.lifecycle.start();
        try {
            h.lifecycle.noteTransportFailure("socket");
            await h.step(COALESCE_MS);
            assert.equal(h.lifecycle.getState().phase, "offline");
            await h.step(5 * 60_000);
            assert.equal(h.probeCalls.length, 1, "a backgrounded tab stays quiet");

            visible = true;
            document.dispatchEvent(new window.Event("visibilitychange"));
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2);
            assert.equal(h.lifecycle.getState().phase, "live");
            assert.deepEqual(h.recovered, ["visible"]);
        } finally {
            stop();
            h.lifecycle.dispose();
        }
    }));

test("sleep detector: a 15s tick that arrives a minute late is a wake signal", () =>
    withTimers(async () => {
        const h = harness(["ok"]);
        const stop = h.lifecycle.start();
        try {
            await h.step(CLOCK_TICK_MS);
            assert.equal(h.probeCalls.length, 0, "an on-time tick is not a signal");
            h.jumpClock(CLOCK_JUMP_MS + 15_000); // the laptop was asleep
            await h.step(CLOCK_TICK_MS);
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1);
            assert.deepEqual(h.recovered, ["clock-jump"]);
        } finally {
            stop();
            h.lifecycle.dispose();
        }
    }));

test("start/stop is refcounted: two holders register the wake listeners once; they detach only after the last release", () =>
    withTimers(async () => {
        const h = harness(["ok"]);
        const stopA = h.lifecycle.start();
        const stopB = h.lifecycle.start();
        try {
            window.dispatchEvent(new window.Event("online"));
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 1, "one probe, not one per holder");

            stopA();
            await h.step(MIN_RECOVERY_GAP_MS);
            window.dispatchEvent(new window.Event("online"));
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2, "the remaining holder keeps the listeners");

            stopB();
            stopB(); // idempotent
            await h.step(MIN_RECOVERY_GAP_MS);
            window.dispatchEvent(new window.Event("online"));
            await h.step(COALESCE_MS);
            assert.equal(h.probeCalls.length, 2, "detached");
        } finally {
            h.lifecycle.dispose();
        }
    }));

test("probeApiHealth: an Access bounce (opaque redirect / 401 / 403) is `reauth`, a down backend is `unreachable`, JSON 200 is `ok`, and the token never leaves the probe", async () => {
    const mk = (over: Partial<Response>) =>
        (async () => ({ type: "basic", status: 200, ok: true, redirected: false, url: "http://localhost/api/health", ...over }) as Response);
    assert.equal(await probeApiHealth(mk({ type: "opaqueredirect", status: 0, ok: false })), "reauth");
    assert.equal(await probeApiHealth(mk({ status: 401, ok: false })), "reauth");
    assert.equal(await probeApiHealth(mk({ status: 403, ok: false })), "reauth");
    assert.equal(await probeApiHealth(mk({ redirected: true, url: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" })), "reauth");
    assert.equal(await probeApiHealth(mk({ status: 500, ok: false })), "unreachable");
    assert.equal(await probeApiHealth(mk({ status: 502, ok: false })), "unreachable");
    assert.equal(await probeApiHealth(async () => { throw new TypeError("Failed to fetch"); }), "unreachable");
    assert.equal(await probeApiHealth(mk({})), "ok");

    const seen: RequestInit[] = [];
    await probeApiHealth((async (_url: RequestInfo | URL, init?: RequestInit) => { seen.push(init!); return mk({})(); }) as typeof fetch);
    assert.equal(seen[0].redirect, "manual", "redirects stay unfollowed so a bounce is nameable");
    assert.equal(seen[0].credentials, "same-origin", "the session cookie rides; nothing else is attached");
    assert.equal((seen[0].headers as Record<string, string>).Authorization, undefined);
});

test("looksLikeTransportFailure / responseLooksJson tell the connection layer from the API's own JSON error", () => {
    const headers = (ct: string | null) => ({ get: () => ct }) as unknown as Headers;
    assert.equal(looksLikeTransportFailure(null), true, "a thrown fetch");
    assert.equal(looksLikeTransportFailure({ type: "opaqueredirect", headers: headers(null) }), true, "an Access bounce");
    assert.equal(looksLikeTransportFailure({ type: "basic", headers: headers("text/html; charset=utf-8") }), true, "a login page or proxy error page");
    assert.equal(looksLikeTransportFailure({ type: "basic", headers: headers(null) }), true, "the Next proxy's bare 500");
    assert.equal(looksLikeTransportFailure({ type: "basic", headers: headers("application/json; charset=utf-8") }), false, "the API answered, even if with an error");
    assert.equal(looksLikeTransportFailure({}), false, "a minimal test fake blames nobody");
    assert.equal(responseLooksJson({ headers: headers("application/json") }), true);
    assert.equal(responseLooksJson({ headers: headers("text/html") }), false);
    assert.equal(responseLooksJson({}), true);
});

test('native cooldown deferrals do not exhaust exchange attempts; slow completion is single-flight', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let requests = 0;
    let exchanges = 0;
    let ok = false;
    let complete: ((value: { status: 'failed' }) => void) | undefined;
    const h = harness(async () => ok ? 'ok' : 'reauth', {
        renewal: { kind: 'travel-shell', request: () => {
            requests++;
            if (requests === 1) {
                exchanges++;
                return new Promise(resolve => { complete = resolve; });
            }
            if (requests === 2) return Promise.resolve({ status: 'deferred', retryAfterMs: 30_000 });
            exchanges++;
            ok = true;
            return Promise.resolve({ status: 'renewed' });
        } },
    });
    try {
        h.lifecycle.signal('manual'); await h.step(500);
        await h.step(15_000);
        h.lifecycle.signal('online'); await h.step(500);
        assert.equal(requests, 1, 'no retry while native exchange is in flight');
        complete!({ status: 'failed' }); await flush();
        await h.step(500); await h.step(2_000);
        assert.equal(exchanges, 1);
        assert.equal(h.lifecycle.getState().renewals, 1, 'cooldown is not an exchange');
        await h.step(30_000); await h.step(2_000);
        assert.equal(exchanges, 2);
        assert.equal(h.lifecycle.getState().phase, 'live');
    } finally { h.lifecycle.dispose(); mock.timers.reset(); }
});

test('a real offline-to-online episode renews again after failed exchange budget exhaustion', () =>
    withTimers(async () => {
        let exchanges = 0;
        let repaired = false;
        let ok = false;
        const h = harness(async () => ok ? 'ok' : 'reauth', { renewal: { kind: 'travel-shell', request: async () => {
            exchanges++;
            ok = repaired;
            return { status: ok ? 'renewed' : 'failed' };
        } } });
        const stop = h.lifecycle.start();
        try {
            h.lifecycle.signal('manual'); await h.step(500);
            await h.step(2000); await h.step(4000); await h.step(8000);
            assert.equal(exchanges, 3);
            assert.equal(h.lifecycle.getState().phase, 'reauth');
            window.dispatchEvent(new window.Event('offline'));
            repaired = true;
            window.dispatchEvent(new window.Event('online'));
            await h.step(500); await h.step(0);
            assert.equal(h.lifecycle.getState().phase, 'live');
            assert.equal(exchanges, 4);
        } finally { stop(); h.lifecycle.dispose(); }
    }));
