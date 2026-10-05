// The shared connection lifecycle through the real provider: a backend
// restart, a foreground return, an expired session, and teardown, with
// several `useLiveRefetch` consumers mounted at once. The socket is the test
// loader's inspectable fake; the EventSource and the probe are fakes injected
// through the modules' test seams. Every timer (including Date) is mocked so
// backoff and debounce run deterministically.
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { __sockets, __reset } from "socket.io-client";
import { LiveBoardStateProvider, useLiveBoardState, useLiveRefetch } from "../live-board-state.tsx";
import { __setConnectionLifecycleForTests, createConnectionLifecycle } from "../../lib/connection-lifecycle.ts";
import { createPraxisStreamStore } from "../../lib/praxis-stream-store.ts";
import { __setPraxisStreamStoreForTests } from "../../hooks/use-praxis-stream.ts";

const T0 = Date.parse("2026-10-03T15:00:00Z");
const SOCKET_EVENTS = ["praxis:event", "praxis:resync", "connect", "disconnect", "connect_error"];

class FakeSource {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.onopen = null;
        this.onerror = null;
        this.onmessage = null;
        this.closed = false;
    }
    addEventListener() {}
    close() {
        this.closed = true;
        this.readyState = 2;
    }
    open() {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
    }
    fail(final) {
        this.readyState = final ? 2 : 0;
        this.onerror?.(new Event("error"));
    }
}

function Consumer({ id, domains, counts }) {
    useLiveRefetch(domains, () => {
        counts[id] = (counts[id] ?? 0) + 1;
    }, { fallbackPollMs: 0 });
    const { phase, connected, reauthAttempted, signIn, reauthenticate } = useLiveBoardState();
    return createElement(
        "div",
        {
            "data-consumer": id,
            "data-phase": phase,
            "data-connected": String(connected),
            "data-reauth-attempted": String(reauthAttempted),
            "data-sign-in": signIn,
        },
        createElement("button", { "data-reauth": id, onClick: () => reauthenticate() }),
    );
}

function harness(t, probe) {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: T0 });
    const opened = [];
    const lifecycle = createConnectionLifecycle({
        probe,
        target: window,
        isVisible: () => true,
        currentHref: () => "http://localhost/ops",
        storage: null,
        signInHref: () => "http://localhost/session/renewed",
        openSignIn: (href) => {
            opened.push(href);
            return { closed: false, close() {}, focus() {} };
        },
    });
    __setConnectionLifecycleForTests(lifecycle);
    const sources = [];
    const store = createPraxisStreamStore({
        createSource: (url) => {
            const s = new FakeSource(url);
            sources.push(s);
            return s;
        },
        fetchSnapshot: async () => null,
        lifecycle,
    });
    __setPraxisStreamStoreForTests(store);
    __reset();

    const counts = {};
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let unmounted = false;
    const h = {
        lifecycle,
        opened,
        sources,
        counts,
        container,
        socket: () => __sockets[0],
        attr: (id, name) => container.querySelector(`[data-consumer="${id}"]`).getAttribute(name),
        listeners: () => Object.fromEntries(SOCKET_EVENTS.map((e) => [e, __sockets[0].__listenerCount(e)])),
        async mount(consumers) {
            await act(async () =>
                root.render(
                    createElement(
                        LiveBoardStateProvider,
                        null,
                        ...consumers.map(([id, domains]) => createElement(Consumer, { key: id, id, domains, counts })),
                    ),
                ),
            );
        },
        /** Run `fn`, then drain microtasks inside act. */
        async do(fn) {
            await act(async () => {
                fn?.();
                await new Promise((r) => setImmediate(r));
            });
        },
        /** Advance the mocked clock and timers, then drain microtasks, inside act. */
        async step(ms) {
            await act(async () => {
                t.mock.timers.tick(ms);
                await new Promise((r) => setImmediate(r));
            });
        },
        async unmount() {
            await act(async () => root.unmount());
            unmounted = true;
        },
        cleanup() {
            if (!unmounted) act(() => root.unmount());
            // Drain the shared socket's 5s linger under THIS test's mock clock
            // so the module singleton is torn down before the clock is reset;
            // a stale handle cleared under the next test's clock corrupts it.
            t.mock.timers.tick(6_000);
            container.remove();
            lifecycle.dispose();
            store.dispose();
            __setConnectionLifecycleForTests(null);
            __setPraxisStreamStoreForTests(null);
            t.mock.timers.reset();
        },
    };
    return h;
}

test("backend restart: the socket drop probes, the outage reads `offline` with no refetch storm, and the retry that passes refetches every consumer exactly once and reconnects the socket at once", async (t) => {
    let outcome = "unreachable";
    const probes = [];
    const h = harness(t, async () => {
        probes.push(outcome);
        return outcome;
    });
    try {
        await h.mount([["ops", ["dispatch", "system", "activity"]], ["board", ["board"]], ["strip", ["dispatch"]]]);
        assert.deepEqual(h.counts, { ops: 1, board: 1, strip: 1 }, "mount fetch each");
        assert.equal(__sockets.length, 1, "one shared socket for three consumers");
        const socket = h.socket();
        const listenersAtRest = h.listeners();
        assert.equal(listenersAtRest["praxis:event"], 1, "one provider subscription");

        socket.connected = true;
        await h.do(() => socket.__emit("connect"));
        assert.equal(h.attr("ops", "data-connected"), "true");
        assert.equal(h.attr("ops", "data-phase"), "live");

        // :4000 restarts.
        socket.connected = false;
        await h.do(() => socket.__emit("disconnect", "transport close"));
        assert.equal(h.attr("ops", "data-connected"), "false");
        await h.step(500);
        assert.deepEqual(probes, ["unreachable"]);
        assert.equal(h.attr("ops", "data-phase"), "offline");
        assert.deepEqual(h.counts, { ops: 1, board: 1, strip: 1 }, "nothing refetches against a dead API");

        // socket.io keeps failing its own reconnect attempts: no extra probes.
        await h.do(() => {
            socket.__emit("connect_error", new Error("xhr poll error"));
            socket.__emit("connect_error", new Error("xhr poll error"));
        });
        await h.step(500);
        assert.equal(probes.length, 1);

        // First retry at 3s still fails; the second at 6s more passes.
        await h.step(2500);
        assert.equal(probes.length, 2);
        assert.equal(h.attr("board", "data-phase"), "offline");
        outcome = "ok";
        await h.step(6000);
        assert.equal(probes.length, 3);
        assert.equal(h.attr("board", "data-phase"), "live");
        assert.equal(socket.connectCalls, 1, "recovery reconnected the socket instead of waiting out its 3s to 15s backoff");

        await h.step(400); // the refetch debounce
        assert.deepEqual(h.counts, { ops: 2, board: 2, strip: 2 }, "each consumer re-fetched authoritative state once");
        await h.step(10_000);
        assert.deepEqual(h.counts, { ops: 2, board: 2, strip: 2 }, "and only once");
        assert.deepEqual(h.listeners(), listenersAtRest, "no listener leaked or doubled across the outage");

        // The reconnected socket announces itself; the relay replay (praxis:resume) rides `connect`.
        socket.connected = true;
        await h.do(() => socket.__emit("connect"));
        assert.equal(h.attr("ops", "data-connected"), "true");
        assert.equal(probes.length, 3, "a transport coming up while live probes nothing");
    } finally {
        h.cleanup();
    }
});

test("foreground return: visible + focus + online fired together make one probe and one refetch per consumer; a second return inside the gap makes none", async (t) => {
    const probes = [];
    const h = harness(t, async () => {
        probes.push("ok");
        return "ok";
    });
    try {
        await h.mount([["ops", ["dispatch"]], ["inbox", ["hitl"]]]);
        assert.deepEqual(h.counts, { ops: 1, inbox: 1 });
        await h.do(() => {
            document.dispatchEvent(new window.Event("visibilitychange"));
            window.dispatchEvent(new window.Event("focus"));
            window.dispatchEvent(new window.Event("online"));
        });
        await h.step(500);
        assert.equal(probes.length, 1, "coalesced");
        await h.step(400);
        assert.deepEqual(h.counts, { ops: 2, inbox: 2 });

        await h.do(() => window.dispatchEvent(new window.Event("focus")));
        await h.step(900);
        assert.equal(probes.length, 1, "alt-tab inside the gap: nothing");
        assert.deepEqual(h.counts, { ops: 2, inbox: 2 });

        await h.step(11_000);
        await h.do(() => document.dispatchEvent(new window.Event("visibilitychange")));
        await h.step(500);
        assert.equal(probes.length, 2);
        await h.step(400);
        assert.deepEqual(h.counts, { ops: 3, inbox: 3 });
    } finally {
        h.cleanup();
    }
});

test("expired session: the probe's redirect verdict reads `reauth`; nothing retries, refetches or navigates by itself; the explicit action opens the sign-in window, leaves the document, and is reflected", async (t) => {
    const probes = [];
    const h = harness(t, async () => {
        probes.push("reauth");
        return "reauth";
    });
    try {
        await h.mount([["ops", ["dispatch"]]]);
        const socket = h.socket();
        await h.do(() => socket.__emit("disconnect", "transport close"));
        await h.step(500);
        assert.equal(h.attr("ops", "data-phase"), "reauth");
        assert.equal(probes.length, 1);

        await h.do(() => window.dispatchEvent(new window.Event("focus")));
        await h.step(500);
        assert.equal(probes.length, 1, "wake inside the 30s reauth window: no re-probe");
        await h.step(31_000);
        await h.do(() => window.dispatchEvent(new window.Event("focus")));
        await h.step(500);
        assert.equal(probes.length, 2, "a later wake re-checks (the operator may have signed in elsewhere)");

        await h.step(5 * 60_000);
        assert.equal(probes.length, 2, "no timer retries against the login page");
        assert.deepEqual(h.counts, { ops: 1 }, "no refetch storm against an expired session");
        assert.deepEqual(h.opened, [], "and never opens the sign-in window on its own");
        assert.equal(h.attr("ops", "data-reauth-attempted"), "false");
        assert.equal(h.attr("ops", "data-sign-in"), "idle");

        await h.do(() => h.container.querySelector('[data-reauth="ops"]').click());
        assert.deepEqual(h.opened, ["http://localhost/session/renewed"], "one sign-in window, operator-initiated");
        assert.equal(h.attr("ops", "data-reauth-attempted"), "true");
        assert.equal(h.attr("ops", "data-sign-in"), "window-open");
    } finally {
        h.cleanup();
    }
});

test("`connected` follows the socket even while the SSE source is dead (the PRAXIS chip no longer reads Offline after every backend restart)", async (t) => {
    const h = harness(t, async () => "ok");
    try {
        await h.mount([["strip", ["system"]]]);
        const socket = h.socket();
        assert.equal(h.sources.length, 1, "the provider's SSE half opened one source");
        await h.do(() => h.sources[0].open());
        socket.connected = true;
        await h.do(() => socket.__emit("connect"));
        assert.equal(h.attr("strip", "data-connected"), "true");
        await h.do(() => h.sources[0].fail(true));
        assert.equal(h.attr("strip", "data-connected"), "true", "socket still delivering");
        await h.step(3000);
        assert.equal(h.sources.length, 2, "and the store reopened the source on its own");
    } finally {
        h.cleanup();
    }
});

test("unmount releases everything: socket listeners, the socket itself after the linger, the SSE source, and the wake listeners", async (t) => {
    const probes = [];
    const h = harness(t, async () => {
        probes.push("ok");
        return "ok";
    });
    try {
        await h.mount([["ops", ["dispatch"]], ["board", ["board"]]]);
        const socket = h.socket();
        assert.equal(h.listeners()["praxis:event"], 1);
        assert.equal(h.sources.length, 1);
        await h.unmount();
        await h.step(5001); // socket + SSE linger
        assert.equal(socket.disconnected, true, "the shared socket was torn down after the linger");
        for (const e of SOCKET_EVENTS) assert.equal(socket.__listenerCount(e), 0, `${e} listeners removed`);
        assert.equal(h.sources[0].closed, true, "the SSE source was closed");
        await h.do(() => window.dispatchEvent(new window.Event("online")));
        await h.step(500);
        assert.equal(probes.length, 0, "wake listeners detached: no probe after unmount");
    } finally {
        h.cleanup();
    }
});
