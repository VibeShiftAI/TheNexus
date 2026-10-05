/**
 * praxis-stream-store: the shared EventSource behind `usePraxisStream`
 * (hooks/use-praxis-stream.ts), as a factory with injectable dependencies so
 * its recovery behavior is testable without a browser.
 *
 * One EventSource is shared module-wide: every component that calls the hook
 * subscribes to the same connection (the bridge dashboard has half a dozen
 * live widgets; per-hook connections would fan out N parallel SSE streams).
 * The connection opens on first subscriber and lingers briefly after the last
 * unsubscribes so route transitions do not churn it.
 *
 * Snapshot is bootstrapped from /api/praxis/stream/snapshot so there is no
 * blank-UI window before the first streamed event arrives. A `stream.reset`
 * frame re-bootstraps presence (the relay's ring buffer could not replay the
 * gap, so local state is stale).
 *
 * Reconnect (2026-10-03): the browser's EventSource only retries NETWORK
 * failures. A non-200 or non-`text/event-stream` answer is final per the
 * WHATWG spec: readyState goes CLOSED and nothing ever retries. That is
 * exactly what the Next dev proxy produces (500 "Internal Server Error")
 * while :4000 restarts, and what an expired Cloudflare Access session produces
 * (302 to an HTML login page), so before this change the SSE half of the deck
 * died at every backend restart until a manual reload. Now a CLOSED source is
 * reopened with bounded backoff (3s doubling to 30s), carrying the last event
 * id as `?lastEventId=` so the relay replays the gap from its ring buffer (or
 * sends `stream.reset` if it cannot), and the shared connection lifecycle
 * (`lib/connection-lifecycle`) reopens it at once when it confirms the API is
 * back. While the lifecycle says `reauth`, no timer retries against the login
 * page; the operator's sign-in action brings the stream back.
 */
import type { PresenceState, StreamEvent } from "@praxis/contract";
import { getConnectionLifecycle, type ConnectionLifecycle } from "./connection-lifecycle";

export const STREAM_URL = "/api/praxis/stream";
export const SNAPSHOT_URL = "/api/praxis/stream/snapshot";
export const MAX_RECENT_EVENTS = 50;
export const TEARDOWN_LINGER_MS = 5000;
export const REOPEN_BASE_MS = 3000;
export const REOPEN_MAX_MS = 30_000;
/** The relay heartbeats every 15s; a source silent through three is presumed half-open. */
export const STALE_SOURCE_MS = 45_000;

/** WHATWG EventSource.readyState values (not exposed as constants in jsdom). */
export const ES_CONNECTING = 0;
export const ES_OPEN = 1;
export const ES_CLOSED = 2;

export interface PraxisStreamState {
    presence: PresenceState | null;
    recentEvents: StreamEvent[];
    connected: boolean;
    lastEventId: string | null;
    /** How many times the store itself reopened a source the browser had closed (diagnostics). */
    reopenCount: number;
}

export const EMPTY_STREAM_STATE: PraxisStreamState = Object.freeze({
    presence: null,
    recentEvents: [],
    connected: false,
    lastEventId: null,
    reopenCount: 0,
});

/** The slice of the DOM EventSource the store touches; a test fake implements it. */
export interface EventSourceLike {
    readonly readyState: number;
    onopen: ((this: EventSource, ev: Event) => unknown) | null;
    onerror: ((this: EventSource, ev: Event) => unknown) | null;
    onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null;
    addEventListener(type: string, listener: EventListener): void;
    close(): void;
}

export interface PraxisStreamStoreDeps {
    /** `null` when the runtime has no EventSource (SSR, jsdom): the store stays disconnected. */
    createSource: (url: string) => EventSourceLike | null;
    fetchSnapshot: () => Promise<unknown>;
    lifecycle: Pick<ConnectionLifecycle, "noteTransportFailure" | "noteTransportUp" | "onRecovered" | "getState">;
    now: () => number;
}

export interface PraxisStreamStore {
    subscribe(listener: () => void): () => void;
    getSnapshot(): PraxisStreamState;
    getServerSnapshot(): PraxisStreamState;
    /** Test/diagnostic seam: the live source, if any. */
    peekSource(): EventSourceLike | null;
    dispose(): void;
}

const EVENT_TYPES: StreamEvent["type"][] = [
    "presence.changed",
    "task.created",
    "task.updated",
    "task.started",
    "task.completed",
    "task.qa-passed",
    "task.failed",
    "task.blocked",
    "hitl.created",
    "hitl.resolved",
    "heartbeat",
    "thinking.trace",
    "schedule.updated",
    "executor.progress",
    "council.update",
    "stream.reset",
];

function defaultDeps(): PraxisStreamStoreDeps {
    return {
        createSource: (url) => (typeof EventSource === "undefined" ? null : new EventSource(url)),
        fetchSnapshot: () =>
            fetch(SNAPSHOT_URL, { cache: "no-store", credentials: "same-origin" }).then((r) =>
                r.ok ? r.json() : null,
            ),
        lifecycle: getConnectionLifecycle(),
        now: () => Date.now(),
    };
}

export function streamUrlFor(lastEventId: string | null): string {
    return lastEventId ? `${STREAM_URL}?lastEventId=${encodeURIComponent(lastEventId)}` : STREAM_URL;
}

export function createPraxisStreamStore(overrides: Partial<PraxisStreamStoreDeps> = {}): PraxisStreamStore {
    const deps: PraxisStreamStoreDeps = { ...defaultDeps(), ...overrides };

    let source: EventSourceLike | null = null;
    let snapshot: PraxisStreamState = EMPTY_STREAM_STATE;
    const listeners = new Set<() => void>();
    let subscriberCount = 0;
    let teardownTimer: ReturnType<typeof setTimeout> | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    let reopenStep = 0;
    let lastFrameAt = 0;
    let offRecovered: (() => void) | null = null;
    let disposed = false;

    function emit(patch: Partial<PraxisStreamState>) {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) listener();
    }

    function bootstrapSnapshot() {
        deps.fetchSnapshot()
            .then((data) => {
                if (!data || typeof data !== "object" || !source) return;
                const d = data as { presence?: PresenceState; upstream?: { lastEventId?: string } };
                const patch: Partial<PraxisStreamState> = {};
                if (d.presence) patch.presence = d.presence;
                if (d.upstream?.lastEventId && !snapshot.lastEventId) {
                    patch.lastEventId = d.upstream.lastEventId;
                }
                if (Object.keys(patch).length > 0) emit(patch);
            })
            .catch(() => {
                /* snapshot is best-effort; live stream will populate */
            });
    }

    function handleFrame(msg: MessageEvent) {
        if (!msg.data) return;
        let event: StreamEvent;
        try {
            event = JSON.parse(msg.data) as StreamEvent;
        } catch {
            return;
        }
        lastFrameAt = deps.now();
        const patch: Partial<PraxisStreamState> = {};
        if (event.eventId) patch.lastEventId = event.eventId;
        if (event.type === "presence.changed") {
            patch.presence = event.presence;
        }
        if (event.type === "stream.reset") {
            // Gap we can't replay: re-bootstrap authoritative state.
            bootstrapSnapshot();
        }
        // heartbeat spams the feed; keep it out of the recent-events list
        if (event.type !== "heartbeat") {
            const next = [event, ...snapshot.recentEvents];
            patch.recentEvents = next.length > MAX_RECENT_EVENTS ? next.slice(0, MAX_RECENT_EVENTS) : next;
        }
        emit(patch);
    }

    function dropSource() {
        if (!source) return;
        const s = source;
        source = null;
        s.onopen = null;
        s.onerror = null;
        s.onmessage = null;
        s.close();
    }

    function clearReopen() {
        if (reopenTimer) {
            clearTimeout(reopenTimer);
            reopenTimer = null;
        }
    }

    function scheduleReopen() {
        if (reopenTimer || disposed || subscriberCount <= 0) return;
        // An expired session needs the operator; the lifecycle's `onRecovered`
        // reopens us once the probe passes again. No timer against the login page.
        if (deps.lifecycle.getState().phase === "reauth") return;
        const delay = Math.min(REOPEN_MAX_MS, REOPEN_BASE_MS * 2 ** reopenStep);
        reopenStep += 1;
        reopenTimer = setTimeout(() => {
            reopenTimer = null;
            if (subscriberCount <= 0 || disposed) return;
            emit({ reopenCount: snapshot.reopenCount + 1 });
            open();
        }, delay);
    }

    function open() {
        if (source || disposed || subscriberCount <= 0) return;
        const next = deps.createSource(streamUrlFor(snapshot.lastEventId));
        if (!next) return;
        source = next;
        next.onopen = () => {
            if (source !== next) return;
            reopenStep = 0;
            lastFrameAt = deps.now();
            emit({ connected: true });
            deps.lifecycle.noteTransportUp("sse");
        };
        next.onerror = () => {
            if (source !== next) return;
            emit({ connected: false });
            if (next.readyState === ES_CLOSED) {
                // Final per the spec (bad status or content type): the browser
                // will never retry this source. We do, with backoff.
                dropSource();
                deps.lifecycle.noteTransportFailure("sse");
                scheduleReopen();
            }
            // readyState CONNECTING: a network-level drop; the browser is
            // already retrying with its own interval. Leave it alone.
        };
        next.onmessage = handleFrame as EventSourceLike["onmessage"];
        // Also handle named events (event: presence.changed, etc). The relay emits
        // both a named `event:` and JSON `data:` so either listener path works.
        for (const type of EVENT_TYPES) {
            next.addEventListener(type, handleFrame as EventListener);
        }
        bootstrapSnapshot();
    }

    function onRecovered() {
        if (disposed || subscriberCount <= 0) return;
        clearReopen();
        reopenStep = 0;
        if (source && source.readyState === ES_OPEN && deps.now() - lastFrameAt > STALE_SOURCE_MS) {
            // Reads as open but has been silent through three relay heartbeats:
            // a half-open connection after sleep. Replace it; the resume cursor
            // in the URL replays whatever we missed.
            dropSource();
        }
        if (!source) {
            emit({ reopenCount: snapshot.reopenCount + 1 });
            open();
        } else {
            bootstrapSnapshot();
        }
    }

    function disconnect() {
        clearReopen();
        reopenStep = 0;
        offRecovered?.();
        offRecovered = null;
        dropSource();
        emit({ connected: false });
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            subscriberCount += 1;
            if (teardownTimer) {
                clearTimeout(teardownTimer);
                teardownTimer = null;
            }
            if (!offRecovered && !disposed) offRecovered = deps.lifecycle.onRecovered(onRecovered);
            open();
            return () => {
                listeners.delete(listener);
                subscriberCount -= 1;
                if (subscriberCount <= 0) {
                    teardownTimer = setTimeout(() => {
                        teardownTimer = null;
                        if (subscriberCount <= 0) disconnect();
                    }, TEARDOWN_LINGER_MS);
                }
            };
        },
        getSnapshot() {
            return snapshot;
        },
        getServerSnapshot() {
            return EMPTY_STREAM_STATE;
        },
        peekSource() {
            return source;
        },
        dispose() {
            disposed = true;
            if (teardownTimer) clearTimeout(teardownTimer);
            teardownTimer = null;
            disconnect();
            listeners.clear();
            subscriberCount = 0;
        },
    };
}
