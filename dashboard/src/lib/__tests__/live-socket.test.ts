import test, { mock } from "node:test";
import assert from "node:assert/strict";

// `socket.io-client` is swapped for an inspectable fake by the test loader
// (test/loader-hooks.mjs → test/stubs/socket-io-client.mjs): `io()` records
// every socket it hands out and never touches the network.
import { __sockets, __reset } from "socket.io-client";
import { acquireLiveSocket, peekLiveSocket, reconnectLiveSocketNow } from "../live-socket";
import { __setConnectionLifecycleForTests, createConnectionLifecycle } from "../connection-lifecycle";

type FakeSocket = {
    disconnected: boolean;
    connected: boolean;
    connectCalls: number;
    __emit: (event: string, ...args: unknown[]) => void;
    __listenerCount: (event: string) => number;
};
const sockets = __sockets as unknown as FakeSocket[];

const LINGER_MS = 5000;

/**
 * The module is a process-wide singleton, so every test starts by draining
 * whatever the previous one left: release every outstanding handle and run
 * the linger timer to completion.
 */
function withFreshSocketModule(fn: () => void) {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        __reset();
        fn();
    } finally {
        mock.timers.reset();
    }
}

function drain(handles: Array<{ release: () => void }>) {
    for (const h of handles) h.release();
    mock.timers.tick(LINGER_MS + 1);
    assert.equal(peekLiveSocket(), null, "drain must leave no live socket");
}

test("acquire/release pairs: one socket for N holders, torn down only after the last release + linger", () => {
    withFreshSocketModule(() => {
        const a = acquireLiveSocket();
        const b = acquireLiveSocket();
        const c = acquireLiveSocket();
        assert.ok(a && b && c);
        assert.equal(sockets.length, 1, "three holders share one io() connection");
        assert.equal(a.socket, b.socket);
        assert.equal(b.socket, c.socket);
        assert.equal(peekLiveSocket(), a.socket);

        a.release();
        b.release();
        mock.timers.tick(LINGER_MS + 1);
        assert.equal(sockets[0].disconnected, false, "a remaining holder keeps the socket alive");
        assert.equal(peekLiveSocket(), a.socket);

        c.release();
        assert.equal(sockets[0].disconnected, false, "teardown waits for the linger");
        assert.equal(peekLiveSocket(), a.socket, "still peekable during the linger");
        mock.timers.tick(LINGER_MS - 1);
        assert.equal(sockets[0].disconnected, false);
        mock.timers.tick(2);
        assert.equal(sockets[0].disconnected, true, "last release + linger disconnects");
        assert.equal(peekLiveSocket(), null);
    });
});

test("linger teardown is cancelled by a re-acquire, and the SAME socket is reused", () => {
    withFreshSocketModule(() => {
        const a = acquireLiveSocket()!;
        a.release();
        mock.timers.tick(LINGER_MS / 2);

        // A route transition remounts a holder inside the linger window.
        const b = acquireLiveSocket()!;
        assert.equal(b.socket, a.socket, "re-acquire inside the linger reuses the connection");
        assert.equal(sockets.length, 1, "no second io() call");

        mock.timers.tick(LINGER_MS * 2);
        assert.equal(sockets[0].disconnected, false, "the pending teardown was cancelled");
        assert.equal(peekLiveSocket(), a.socket);

        drain([b]);
        assert.equal(sockets[0].disconnected, true);
    });
});

test("StrictMode double-mount (acquire, release, acquire) never churns the connection", () => {
    withFreshSocketModule(() => {
        // React StrictMode runs the effect, its cleanup, then the effect again
        // synchronously — the second acquire must land before any teardown.
        const first = acquireLiveSocket()!;
        first.release();
        const second = acquireLiveSocket()!;
        assert.equal(second.socket, first.socket);
        assert.equal(sockets.length, 1);
        mock.timers.tick(LINGER_MS * 2);
        assert.equal(sockets[0].disconnected, false, "the surviving mount keeps the socket");

        drain([second]);
    });
});

test("release is idempotent: double-releasing one handle cannot steal another holder's reference", () => {
    withFreshSocketModule(() => {
        const a = acquireLiveSocket()!;
        const b = acquireLiveSocket()!;
        a.release();
        a.release();
        a.release();
        mock.timers.tick(LINGER_MS * 2);
        assert.equal(sockets[0].disconnected, false, "b still holds the socket");
        assert.equal(peekLiveSocket(), b.socket);

        b.release();
        mock.timers.tick(LINGER_MS + 1);
        assert.equal(sockets[0].disconnected, true);
        assert.equal(peekLiveSocket(), null);
    });
});

test("after a full teardown the next acquire opens a fresh connection", () => {
    withFreshSocketModule(() => {
        const a = acquireLiveSocket()!;
        drain([a]);
        const b = acquireLiveSocket()!;
        assert.notEqual(b.socket, a.socket);
        assert.equal(sockets.length, 2);
        assert.equal(sockets[1].disconnected, false);
        drain([b]);
    });
});

test("the local-dev target is :4000 with infinite reconnection", () => {
    withFreshSocketModule(() => {
        const a = acquireLiveSocket()!;
        const created = __sockets[0] as unknown as { url: string; opts: Record<string, unknown> };
        assert.equal(created.url, "http://localhost:4000");
        assert.equal(created.opts.path, "/socket.io/");
        assert.equal(created.opts.reconnectionAttempts, Infinity);
        drain([a]);
    });
});

test("reconnectLiveSocketNow: a no-op without a socket or while connected; disconnect+connect (the safe path through socket.io's backoff) when disconnected", () => {
    withFreshSocketModule(() => {
        assert.equal(reconnectLiveSocketNow(), false, "no socket yet");
        const a = acquireLiveSocket()!;
        const s = sockets[0];
        s.connected = true;
        assert.equal(reconnectLiveSocketNow(), false, "already connected: never churn a live connection");
        assert.equal(s.connectCalls, 0);
        s.connected = false;
        assert.equal(reconnectLiveSocketNow(), true);
        assert.equal(s.connectCalls, 1);
        assert.equal(s.disconnected, false, "connect() follows the disconnect() at once");
        drain([a]);
    });
});

test("the socket reports to the shared lifecycle: our own disconnects are not failures, real drops probe once, and a passing recovery reconnects a disconnected socket at once", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let clock = 1_000_000;
    const probes: string[] = [];
    const lifecycle = createConnectionLifecycle({
        now: () => clock,
        probe: async () => {
            probes.push("ok");
            return "ok";
        },
        target: undefined,
        isVisible: () => true,
        currentHref: () => "/",
        storage: null,
    });
    __setConnectionLifecycleForTests(lifecycle);
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const step = async (ms: number) => {
        clock += ms;
        mock.timers.tick(ms);
        await flush();
    };
    try {
        __reset();
        const a = acquireLiveSocket()!;
        const s = sockets[0];
        assert.equal(s.__listenerCount("connect"), 1);
        assert.equal(s.__listenerCount("disconnect"), 1);
        assert.equal(s.__listenerCount("connect_error"), 1);

        s.__emit("disconnect", "io client disconnect");
        await step(500);
        assert.equal(probes.length, 0, "teardown / forced reconnect is not a failure");

        s.__emit("disconnect", "transport close");
        s.__emit("connect_error", new Error("xhr poll error"));
        await step(500);
        assert.equal(probes.length, 1, "one probe for the burst");
        assert.equal(lifecycle.getState().phase, "live");
        assert.equal(s.connectCalls, 0, "a healthy API does not force the socket; its own backoff runs");

        // A wake signal later finds the API healthy: the disconnected socket is reconnected now.
        await step(11_000);
        s.connected = false;
        lifecycle.signal("visible");
        await step(500);
        assert.equal(probes.length, 2);
        assert.equal(s.connectCalls, 1);

        // Teardown unbinds the reporting listeners along with the socket.
        a.release();
        await step(LINGER_MS + 1);
        assert.equal(s.disconnected, true);
        assert.equal(s.__listenerCount("connect"), 0);
        assert.equal(s.__listenerCount("disconnect"), 0);
        assert.equal(s.__listenerCount("connect_error"), 0);
        lifecycle.signal("manual");
        await step(11_000);
        assert.equal(s.connectCalls, 1, "a released socket is never reconnected by a later recovery");
    } finally {
        lifecycle.dispose();
        __setConnectionLifecycleForTests(null);
        mock.timers.reset();
    }
});
