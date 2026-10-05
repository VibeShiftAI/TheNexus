/**
 * LiveBoardState — ONE live-update subscription for the whole deck.
 *
 * Phase 1 of the single-transport migration (ticket P3-30). Historically every
 * live widget owned its own refresh loop: ~20 components each running a
 * `setInterval` against the rate-limited :4000 API, plus a per-hook SSE
 * subscription. This provider collapses the *notification* half of that into
 * one place:
 *
 *   - It takes a single reference on the shared Socket.IO connection
 *     (`lib/live-socket`, the same socket CortexProvider uses for chat) and
 *     listens for the `praxis:event` fan-out the Nexus relay emits for every
 *     frame it receives from Praxis's SSE stream.
 *   - It ALSO folds in the existing shared SSE store (`usePraxisStream`), which
 *     is already open for the event ticker in the root layout. Frames are
 *     deduped by `eventId`, so during Phase 1 both transports can deliver the
 *     same event and a drop on either one degrades rather than freezes the UI.
 *     Phase 2 (docs/live-transport-phase2.md) retires the SSE half.
 *   - It owns the app's reference on the shared connection lifecycle
 *     (`lib/connection-lifecycle`, 2026-10-03): foreground return, network
 *     return, a sleep gap or a transport failure trigger one bounded probe of
 *     the API, and a passing probe invalidates EVERY domain so each surface
 *     re-fetches authoritative data. The lifecycle's phase (`live`,
 *     `recovering`, `renewing`, `offline`, `reauth`) is exposed here so
 *     surfaces can say truthfully when what they show is not current.
 *
 * What consumers get is a set of monotonically increasing REVISION counters,
 * one per domain. A component does not read board data from here — it keeps
 * owning its own fetch — it just refetches when its domain's revision bumps.
 * That keeps the migration additive: no component's data shape changes.
 *
 * Usage:
 *   useLiveRefetch(["board"], fetchBoard);          // event-driven + 60s drift poll
 *   const { connected, transport, phase } = useLiveBoardState();
 */
"use client";

import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import type { PresenceState, StreamEvent } from "@praxis/contract";
import { acquireLiveSocket } from "@/lib/live-socket";
import {
    getConnectionLifecycle,
    type ConnectionState,
    type LivePhase,
    type ReauthResult,
    type RecoverySignal,
    type RenewalBridgeKind,
    type SignInState,
} from "@/lib/connection-lifecycle";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import {
    LIVE_DOMAINS,
    ZERO_REVISIONS,
    applyFrame as reduceFrame,
    createFrameDeduper,
    domainsForEvent,
    invalidateAll,
    type LiveDomain,
    type LiveFrameState,
    type LiveRevisions,
} from "./live-board-state-logic";

export { LIVE_DOMAINS, domainsForEvent };
export type { LiveDomain, LiveRevisions, LivePhase };

/** Slow drift-correction poll kept behind every live subscription. */
export const LIVE_FALLBACK_POLL_MS = 60_000;

export type LiveTransport = "socket" | "sse" | "offline";

export interface LiveBoardStateValue {
    /** Monotonic per-domain counters; bump = "your data may be stale". */
    revisions: LiveRevisions;
    /** Newest presence snapshot seen on either transport (may be null). */
    presence: PresenceState | null;
    /** Newest-first ring of non-heartbeat frames. */
    recentEvents: StreamEvent[];
    /** True while at least one transport is delivering. */
    connected: boolean;
    /** Which transport is currently authoritative. */
    transport: LiveTransport;
    /** Epoch ms of the last frame seen on the socket, 0 if none. */
    lastSocketEventAt: number;
    /**
     * The shared recovery coordinator's verdict on the API: `live`,
     * `recovering` (a probe is running), `renewing` (the session expired and
     * the native shell was asked to renew it; bounded attempts), `offline`
     * (unreachable, retrying with backoff) or `reauth` (the session expired
     * and only the operator can bring it back, see `reauthenticate`).
     * Independent of `connected`: a socket can still be delivering frames
     * while the API refuses fetches, and vice versa.
     */
    phase: LivePhase;
    /** Epoch ms when `phase` began (for "data as of" / "offline since" copy). */
    phaseSince: number;
    /** Epoch ms of the last probe that passed, 0 before the first. */
    lastLiveAt: number;
    /** True when the operator already went to sign in from this tab and the API still refuses. */
    reauthAttempted: boolean;
    /** Automatic renewal attempts made in the current outage (0 outside one). */
    renewals: number;
    /** Which native shell can renew the session without the page leaving; null in a browser. */
    renewalKind: RenewalBridgeKind | null;
    /** Where the explicit sign-in action stands: idle, its window is open, or the window was blocked. */
    signIn: SignInState;
    /**
     * The one explicit action for an expired session: opens the sign-in flow
     * in a separate window so this document and everything typed in it stay
     * put. Acts only in `reauth`, never automatically.
     */
    reauthenticate: () => ReauthResult;
    /**
     * The labelled fallback when that window is blocked: sign in in THIS tab,
     * which replaces the document (the chat draft survives, other unsaved
     * edits do not). Acts only in `reauth`.
     */
    signInHere: () => boolean;
    /** Ask the coordinator for a recovery run now (a Retry button, a failed fetch). */
    requestRecovery: (reason: RecoverySignal) => void;
}

const EMPTY_VALUE: LiveBoardStateValue = Object.freeze({
    revisions: ZERO_REVISIONS,
    presence: null,
    recentEvents: [],
    connected: false,
    transport: "offline",
    lastSocketEventAt: 0,
    phase: "live",
    phaseSince: 0,
    lastLiveAt: 0,
    reauthAttempted: false,
    renewals: 0,
    renewalKind: null,
    signIn: "idle",
    reauthenticate: () => "noop",
    signInHere: () => false,
    requestRecovery: () => {},
});

/** Stable server-render snapshot of the lifecycle (nothing has been probed). */
const SERVER_CONNECTION_STATE: ConnectionState = Object.freeze({
    phase: "live",
    since: 0,
    lastLiveAt: 0,
    failures: 0,
    probes: 0,
    lastSignal: null,
    reauthAttempted: false,
    renewals: 0,
    renewalKind: null,
    signIn: "idle",
}) as ConnectionState;
const getServerConnectionState = () => SERVER_CONNECTION_STATE;

const LiveBoardStateContext = createContext<LiveBoardStateValue | null>(null);

export function LiveBoardStateProvider({ children }: { children: ReactNode }) {
    const [socketState, setSocketState] = useState<
        LiveFrameState & { socketConnected: boolean }
    >({
        revisions: ZERO_REVISIONS,
        presence: null,
        recentEvents: [],
        socketConnected: false,
        lastSocketEventAt: 0,
    });

    // Ids seen on EITHER transport, so the SSE copy of a frame the socket
    // already delivered (or vice versa) does not double-bump a revision.
    const markSeen = useRef(createFrameDeduper()).current;

    // Shared applier, set by the socket effect and reused by the SSE drain
    // below so both transports run through the same dedupe set.
    const applyFrameRef = useRef<((e: StreamEvent, viaSocket: boolean) => void) | null>(null);

    // Last eventId applied on EITHER transport — the resume cursor sent back to
    // the relay on every (re)connect so it can replay the gap from its ring
    // buffer. Kept in a ref, not state: it changes on every frame and nothing
    // renders from it.
    const lastEventId = useRef<string | null>(null);

    // The SSE half — already open for the root-layout event ticker, so
    // consuming it here costs no extra connection.
    const sse = usePraxisStream();

    // ── The recovery coordinator: one app-wide reference ─────────────
    const lifecycle = getConnectionLifecycle();
    const conn = useSyncExternalStore(lifecycle.subscribe, lifecycle.getState, getServerConnectionState);
    useEffect(() => {
        const stop = lifecycle.start();
        // A passing probe after an outage, a foreground return or a network
        // return: nothing we hold is known to be current, so every domain is
        // invalidated and each surface's own fetch re-establishes the truth.
        const off = lifecycle.onRecovered(() => {
            setSocketState((prev) => invalidateAll(prev));
        });
        return () => {
            off();
            stop();
        };
    }, [lifecycle]);

    // ── The socket half: ONE subscription for the whole app ──────────
    useEffect(() => {
        const handle = acquireLiveSocket();
        if (!handle) return;
        const { socket, release } = handle;

        const applyFrame = (event: StreamEvent, viaSocket: boolean) => {
            const id = (event as { eventId?: string }).eventId;
            if (!markSeen(id)) return;
            // Advance the resume cursor only for frames we actually applied, so
            // a replay we deduped away can never move it past a gap.
            if (id) lastEventId.current = id;
            setSocketState((prev) => reduceFrame(prev, event, viaSocket));
        };

        const onEvent = (event: StreamEvent) => {
            if (!event || typeof event !== "object" || typeof event.type !== "string") return;
            applyFrame(event, true);
        };
        const onConnect = () => {
            setSocketState((prev) => ({ ...prev, socketConnected: true }));
            // Ask the relay to replay whatever we missed while disconnected.
            // On a first connect there is no cursor and the relay replays
            // nothing — each surface's mount fetch is its own snapshot.
            socket.emit("praxis:resume", { since: lastEventId.current });
        };
        const onDisconnect = () =>
            setSocketState((prev) => ({ ...prev, socketConnected: false }));
        // The relay could not fill our gap (we were away longer than its ring
        // buffer holds, or it restarted). We do not know what we missed, so
        // force every domain to refetch — same contract as an SSE stream.reset.
        const onResync = (payload: { eventId?: string; at?: string } | undefined) => {
            lastEventId.current = null;
            markSeen(payload?.eventId);
            setSocketState((prev) =>
                reduceFrame(
                    prev,
                    {
                        type: "stream.reset",
                        at: payload?.at ?? new Date().toISOString(),
                        eventId: payload?.eventId,
                    } as unknown as StreamEvent,
                    true,
                ),
            );
        };

        socket.on("praxis:event", onEvent);
        socket.on("praxis:resync", onResync);
        socket.on("connect", onConnect);
        socket.on("disconnect", onDisconnect);
        if (socket.connected) onConnect();

        // The SSE fallback is drained by the effect below via a ref to this
        // same applier, so both transports share the dedupe set.
        applyFrameRef.current = applyFrame;

        return () => {
            socket.off("praxis:event", onEvent);
            socket.off("praxis:resync", onResync);
            socket.off("connect", onConnect);
            socket.off("disconnect", onDisconnect);
            applyFrameRef.current = null;
            release();
        };
    }, []);

    // ── The SSE half: fold in anything the socket did not deliver ────
    const lastSseIndex = useRef<string | null>(null);
    useEffect(() => {
        const apply = applyFrameRef.current;
        if (!apply) return;
        const newest = sse.recentEvents[0];
        const newestId = newest ? (newest as { eventId?: string }).eventId ?? null : null;
        if (newestId && newestId === lastSseIndex.current) return;
        lastSseIndex.current = newestId;
        // Walk oldest→newest so revisions bump in stream order; the dedupe set
        // drops everything the socket already applied.
        for (let i = sse.recentEvents.length - 1; i >= 0; i -= 1) {
            apply(sse.recentEvents[i], false);
        }
    }, [sse.recentEvents]);

    const value = useMemo<LiveBoardStateValue>(() => {
        const transport: LiveTransport = socketState.socketConnected
            ? "socket"
            : sse.connected
              ? "sse"
              : "offline";
        return {
            revisions: socketState.revisions,
            presence: socketState.presence ?? sse.presence,
            recentEvents: socketState.recentEvents.length
                ? socketState.recentEvents
                : sse.recentEvents,
            connected: transport !== "offline",
            transport,
            lastSocketEventAt: socketState.lastSocketEventAt,
            phase: conn.phase,
            phaseSince: conn.since,
            lastLiveAt: conn.lastLiveAt,
            reauthAttempted: conn.reauthAttempted,
            renewals: conn.renewals,
            renewalKind: conn.renewalKind,
            signIn: conn.signIn,
            reauthenticate: lifecycle.reauthenticate,
            signInHere: lifecycle.signInHere,
            requestRecovery: lifecycle.signal,
        };
    }, [socketState, sse.connected, sse.presence, sse.recentEvents, conn, lifecycle]);

    return (
        <LiveBoardStateContext.Provider value={value}>{children}</LiveBoardStateContext.Provider>
    );
}

/**
 * Read the shared live state. Safe outside the provider (returns the empty
 * value) so a component can be migrated before every page mounts the provider.
 */
export function useLiveBoardState(): LiveBoardStateValue {
    return useContext(LiveBoardStateContext) ?? EMPTY_VALUE;
}

export interface LiveRefetchOptions {
    /**
     * Slow drift-correction poll. Kept deliberately: if the socket AND the SSE
     * stream both drop, the surface degrades to a 60s refresh rather than
     * freezing on stale data. Pass 0 to disable.
     */
    fallbackPollMs?: number;
    /** Coalesce a burst of events into one refetch. */
    debounceMs?: number;
    /** Run the callback once on mount (most callers want this). */
    immediate?: boolean;
}

/**
 * Drop-in replacement for `useEffect(() => setInterval(fetch, N))`.
 *
 * Fetches immediately, again whenever any of `domains` is invalidated by a live
 * frame (or by the connection lifecycle confirming a recovery), and on a slow
 * fallback poll so a dead transport degrades gracefully.
 */
export function useLiveRefetch(
    domains: LiveDomain[],
    onRefetch: () => void,
    options: LiveRefetchOptions = {},
) {
    const {
        fallbackPollMs = LIVE_FALLBACK_POLL_MS,
        debounceMs = 400,
        immediate = true,
    } = options;

    const { revisions } = useLiveBoardState();
    const cb = useRef(onRefetch);
    cb.current = onRefetch;

    // Sum of the watched domains' counters: one scalar to compare against.
    const key = domains.reduce((sum, d) => sum + (revisions[d] ?? 0), 0);
    const domainKey = domains.join(",");
    const lastKey = useRef<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (immediate) cb.current();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (lastKey.current === null) {
            // First observation is the mount baseline — the immediate fetch
            // above already covered it.
            lastKey.current = key;
            return;
        }
        if (key === lastKey.current) return;
        lastKey.current = key;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => cb.current(), debounceMs);
    }, [key, debounceMs]);

    useEffect(() => {
        if (!fallbackPollMs) return;
        const t = setInterval(() => cb.current(), fallbackPollMs);
        return () => clearInterval(t);
    }, [fallbackPollMs, domainKey]);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );
}
