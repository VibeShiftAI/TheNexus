import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
    ES_CLOSED,
    ES_CONNECTING,
    ES_OPEN,
    REOPEN_BASE_MS,
    STALE_SOURCE_MS,
    TEARDOWN_LINGER_MS,
    createPraxisStreamStore,
    type EventSourceLike,
} from "../praxis-stream-store";
import type { ConnectionLifecycle, LivePhase, RecoverySignal } from "../connection-lifecycle";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The browser EventSource in miniature: the store only sees this surface. */
class FakeSource implements EventSourceLike {
    readyState = ES_CONNECTING;
    onopen: EventSourceLike["onopen"] = null;
    onerror: EventSourceLike["onerror"] = null;
    onmessage: EventSourceLike["onmessage"] = null;
    closed = false;
    constructor(public url: string) {}
    addEventListener() {}
    close() {
        this.closed = true;
        this.readyState = ES_CLOSED;
    }
    open() {
        this.readyState = ES_OPEN;
        this.onopen?.call(this as unknown as EventSource, new Event("open"));
    }
    /** `final` = a bad status / content type: the browser gives up (CLOSED). Otherwise a network drop it retries itself. */
    fail(final: boolean) {
        this.readyState = final ? ES_CLOSED : ES_CONNECTING;
        this.onerror?.call(this as unknown as EventSource, new Event("error"));
    }
    message(data: unknown) {
        this.onmessage?.call(this as unknown as EventSource, { data: JSON.stringify(data) } as MessageEvent);
    }
}

function harness() {
    let clock = 1_000_000;
    let phase: LivePhase = "live";
    const sources: FakeSource[] = [];
    const failures: string[] = [];
    const ups: string[] = [];
    const recoveredCbs = new Set<(r: RecoverySignal) => void>();
    let snapshotFetches = 0;
    const lifecycle: Pick<ConnectionLifecycle, "noteTransportFailure" | "noteTransportUp" | "onRecovered" | "getState"> = {
        noteTransportFailure: (s) => void failures.push(s),
        noteTransportUp: (s) => void ups.push(s),
        onRecovered: (cb) => {
            recoveredCbs.add(cb);
            return () => void recoveredCbs.delete(cb);
        },
        getState: () => ({ phase, since: 0, lastLiveAt: 0, failures: 0, probes: 0, lastSignal: null, reauthAttempted: false }),
    };
    const store = createPraxisStreamStore({
        createSource: (url) => {
            const s = new FakeSource(url);
            sources.push(s);
            return s;
        },
        fetchSnapshot: async () => {
            snapshotFetches += 1;
            return { presence: { activity: "idle" }, upstream: { lastEventId: "snap-1" } };
        },
        lifecycle,
        now: () => clock,
    });
    return {
        store,
        sources,
        failures,
        ups,
        lifecycle,
        setPhase: (p: LivePhase) => void (phase = p),
        recover: () => {
            for (const cb of recoveredCbs) cb("visible");
        },
        snapshotFetches: () => snapshotFetches,
        recoveredListeners: () => recoveredCbs.size,
        async step(ms: number) {
            clock += ms;
            mock.timers.tick(ms);
            await flush();
        },
        age(ms: number) {
            clock += ms;
        },
    };
}

function withTimers<T>(fn: () => Promise<T>): Promise<T> {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    return fn().finally(() => mock.timers.reset());
}

test("a source the browser closed for good (proxy 500 / Access 302) is reopened with doubling backoff, carrying the last event id for the relay's replay", () =>
    withTimers(async () => {
        const h = harness();
        const unsub = h.store.subscribe(() => {});
        try {
            assert.equal(h.sources.length, 1);
            assert.equal(h.sources[0].url, "/api/praxis/stream", "first open: no cursor");
            h.sources[0].open();
            assert.equal(h.store.getSnapshot().connected, true);
            assert.deepEqual(h.ups, ["sse"]);
            h.sources[0].message({ type: "task.updated", eventId: "e1", at: "2026-10-03T12:00:00Z" });
            h.sources[0].message({ type: "task.updated", eventId: "e2", at: "2026-10-03T12:00:01Z" });

            // :4000 restarts; the Next proxy answers 500 → the browser closes the source for good.
            h.sources[0].fail(true);
            assert.equal(h.store.getSnapshot().connected, false);
            assert.deepEqual(h.failures, ["sse"], "the shared lifecycle hears about it once");
            assert.equal(h.sources[0].closed, true, "the dead source is released");
            assert.equal(h.sources.length, 1, "no immediate reopen storm");

            await h.step(REOPEN_BASE_MS);
            assert.equal(h.sources.length, 2);
            assert.equal(h.sources[1].url, "/api/praxis/stream?lastEventId=e2", "the resume cursor rides the URL (a recreated EventSource has no Last-Event-ID header)");
            assert.equal(h.store.getSnapshot().reopenCount, 1);

            h.sources[1].fail(true);
            await h.step(REOPEN_BASE_MS);
            assert.equal(h.sources.length, 2, "backoff doubled to 6s");
            await h.step(REOPEN_BASE_MS);
            assert.equal(h.sources.length, 3);

            // The relay is back: open resets the backoff.
            h.sources[2].open();
            h.sources[2].fail(true);
            await h.step(REOPEN_BASE_MS);
            assert.equal(h.sources.length, 4, "after a successful open the next reopen is back at the base delay");
        } finally {
            unsub();
            h.store.dispose();
        }
    }));

test("a network-level error (readyState CONNECTING) is the browser's own retry: the store neither reopens nor reports", () =>
    withTimers(async () => {
        const h = harness();
        const unsub = h.store.subscribe(() => {});
        try {
            h.sources[0].open();
            h.sources[0].fail(false);
            assert.equal(h.store.getSnapshot().connected, false, "honest while the browser retries");
            assert.deepEqual(h.failures, []);
            await h.step(60_000);
            assert.equal(h.sources.length, 1, "no competing reopen");
            h.sources[0].open();
            assert.equal(h.store.getSnapshot().connected, true);
        } finally {
            unsub();
            h.store.dispose();
        }
    }));

test("recovery reopens a closed source at once and cancels the pending backoff; a source that is open but silent through three heartbeats is replaced; a healthy one just re-bootstraps", () =>
    withTimers(async () => {
        const h = harness();
        const unsub = h.store.subscribe(() => {});
        try {
            const bootstraps = h.snapshotFetches();
            h.sources[0].open();
            h.sources[0].message({ type: "heartbeat", eventId: "h1", at: "x" });
            h.sources[0].fail(true);
            await h.step(1000); // reopen pending at 3s
            h.recover();
            assert.equal(h.sources.length, 2, "reopened immediately");
            assert.equal(h.sources[1].url, "/api/praxis/stream?lastEventId=h1");
            await h.step(60_000);
            assert.equal(h.sources.length, 2, "the pending backoff timer was cancelled, not doubled up");

            // Half-open after sleep: open, but nothing for 50s (the relay heartbeats every 15s).
            h.sources[1].open();
            h.sources[1].message({ type: "heartbeat", eventId: "h2", at: "x" });
            h.age(STALE_SOURCE_MS + 5_000);
            h.recover();
            assert.equal(h.sources[1].closed, true, "the silent source is dropped");
            assert.equal(h.sources.length, 3);
            assert.equal(h.sources[2].url, "/api/praxis/stream?lastEventId=h2");

            // Healthy: a frame just arrived; recovery only re-bootstraps the snapshot.
            h.sources[2].open();
            h.sources[2].message({ type: "heartbeat", eventId: "h3", at: "x" });
            const before = h.snapshotFetches();
            h.recover();
            assert.equal(h.sources.length, 3, "kept");
            await flush();
            assert.equal(h.snapshotFetches(), before + 1);
            assert.ok(h.snapshotFetches() > bootstraps);
        } finally {
            unsub();
            h.store.dispose();
        }
    }));

test("while the lifecycle says `reauth` no timer reopens against the login page; the operator's recovery brings the stream back", () =>
    withTimers(async () => {
        const h = harness();
        const unsub = h.store.subscribe(() => {});
        try {
            h.sources[0].open();
            h.setPhase("reauth");
            h.sources[0].fail(true);
            await h.step(10 * 60_000);
            assert.equal(h.sources.length, 1, "no reopen storm against an expired session");
            h.setPhase("live");
            h.recover();
            assert.equal(h.sources.length, 2);
        } finally {
            unsub();
            h.store.dispose();
        }
    }));

test("the last subscriber leaving (after the linger) stops every retry and drops the recovery hook; a new subscriber reopens", () =>
    withTimers(async () => {
        const h = harness();
        const unsubA = h.store.subscribe(() => {});
        const unsubB = h.store.subscribe(() => {});
        try {
            assert.equal(h.sources.length, 1, "two subscribers share one source");
            assert.equal(h.recoveredListeners(), 1, "one recovery hook, not one per subscriber");
            h.sources[0].fail(true);
            unsubA();
            unsubB();
            await h.step(TEARDOWN_LINGER_MS);
            await h.step(60_000);
            assert.equal(h.sources.length, 1, "no reopen after teardown");
            assert.equal(h.recoveredListeners(), 0, "the recovery hook is released");
            h.recover();
            assert.equal(h.sources.length, 1);

            const unsubC = h.store.subscribe(() => {});
            assert.equal(h.sources.length, 2);
            assert.equal(h.recoveredListeners(), 1);
            unsubC();
        } finally {
            h.store.dispose();
        }
    }));

test("frames: heartbeats stay out of the ring, presence is applied, stream.reset re-bootstraps the authoritative snapshot", () =>
    withTimers(async () => {
        const h = harness();
        const unsub = h.store.subscribe(() => {});
        try {
            await flush();
            const after = h.snapshotFetches();
            h.sources[0].open();
            h.sources[0].message({ type: "heartbeat", eventId: "h1", at: "x" });
            assert.equal(h.store.getSnapshot().recentEvents.length, 0);
            assert.equal(h.store.getSnapshot().lastEventId, "h1");
            h.sources[0].message({ type: "presence.changed", eventId: "p1", at: "x", presence: { activity: "thinking" } });
            assert.deepEqual(h.store.getSnapshot().presence, { activity: "thinking" });
            h.sources[0].message({ type: "stream.reset", eventId: "r1", at: "x" });
            await flush();
            assert.equal(h.snapshotFetches(), after + 1);
            assert.equal(h.store.getSnapshot().recentEvents[0].type, "stream.reset");
        } finally {
            unsub();
            h.store.dispose();
        }
    }));
