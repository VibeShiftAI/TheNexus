/**
 * Pure logic behind LiveBoardStateProvider (components/live-board-state.tsx):
 * which domains a frame invalidates, the cross-transport dedupe set, and the
 * reducer that turns one frame into the next revision/presence/ring state.
 * No React, no sockets — so it is unit-testable without mounting the provider
 * (components/__tests__/live-board-state.test.ts).
 */
import type { PresenceState, StreamEvent } from "@praxis/contract";

/** How many recent frames the context retains for feed-style consumers. */
export const MAX_RECENT_EVENTS = 50;

/** How many event ids to remember for cross-transport dedupe. */
export const MAX_SEEN_IDS = 400;

export type LiveDomain =
    | "board"
    | "task"
    | "schedule"
    | "system"
    | "activity"
    /** HITL inbox: pending count, badge, the inbox list itself. */
    | "hitl"
    /** Dispatch surfaces: executor lanes, CLI slots, the queue. */
    | "dispatch";

export const LIVE_DOMAINS: LiveDomain[] = [
    "board",
    "task",
    "schedule",
    "system",
    "activity",
    "hitl",
    "dispatch",
];

export type LiveRevisions = Record<LiveDomain, number>;

export const ZERO_REVISIONS: LiveRevisions = Object.freeze({
    board: 0,
    task: 0,
    schedule: 0,
    system: 0,
    activity: 0,
    hitl: 0,
    dispatch: 0,
}) as LiveRevisions;

/**
 * Which domains a stream frame invalidates. A frame can touch several: a
 * `task.completed` moves the board, the task itself, and the day's schedule.
 * Unknown/future event types still bump `activity` so feeds stay live.
 */
export function domainsForEvent(type: string): LiveDomain[] {
    switch (type) {
        case "task.created":
        case "task.updated":
        case "task.blocked":
            return ["board", "task", "activity"];
        case "task.started":
        case "task.completed":
        case "task.failed":
            // A dispatch lane opens and closes on these too — the executor
            // strip and the CLI-slot panels read the same lifecycle.
            return ["board", "task", "schedule", "dispatch", "activity"];
        case "schedule.updated":
            return ["schedule", "board", "activity"];
        case "presence.changed":
            return ["system", "activity"];
        case "executor.progress":
            return ["system", "dispatch", "activity"];
        case "hitl.created":
        case "hitl.resolved":
            // The inbox badge is a correctness surface: a resolved request that
            // keeps showing as pending is worse than a stale feed.
            return ["hitl", "activity"];
        case "council.update":
        case "thinking.trace":
            return ["activity"];
        case "stream.reset":
            // We cannot know what we missed — invalidate everything.
            return LIVE_DOMAINS;
        case "heartbeat":
            return [];
        default:
            return ["activity"];
    }
}

/**
 * A bounded "have I seen this eventId" set shared by both transports. Returns
 * true when the frame should be applied. Frames WITHOUT an id cannot be
 * deduped and are always accepted — a double delivery of one costs a spare
 * refetch, never a missed one.
 */
export function createFrameDeduper(max: number = MAX_SEEN_IDS): (id: string | null | undefined) => boolean {
    const seen = new Set<string>();
    const order: string[] = [];
    return (id) => {
        if (!id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        order.push(id);
        if (order.length > max) {
            const evicted = order.shift();
            if (evicted) seen.delete(evicted);
        }
        return true;
    };
}

export interface LiveFrameState {
    revisions: LiveRevisions;
    presence: PresenceState | null;
    recentEvents: StreamEvent[];
    /** Epoch ms of the last frame seen on the socket, 0 if none. */
    lastSocketEventAt: number;
}

export const EMPTY_FRAME_STATE: LiveFrameState = Object.freeze({
    revisions: ZERO_REVISIONS,
    presence: null,
    recentEvents: [],
    lastSocketEventAt: 0,
});

/**
 * Fold one (already-deduped) frame into the state: bump every domain the
 * frame invalidates, prepend it to the ring (heartbeats excluded), pick up a
 * presence snapshot, and stamp the socket clock when it came over the socket.
 */
export function applyFrame<S extends LiveFrameState>(
    prev: S,
    event: StreamEvent,
    viaSocket: boolean,
    now: () => number = Date.now,
): S {
    const domains = domainsForEvent(event.type);
    const revisions = domains.length ? { ...prev.revisions } : prev.revisions;
    for (const d of domains) revisions[d] = revisions[d] + 1;
    const recentEvents =
        event.type === "heartbeat"
            ? prev.recentEvents
            : [event, ...prev.recentEvents].slice(0, MAX_RECENT_EVENTS);
    return {
        ...prev,
        revisions,
        recentEvents,
        presence:
            event.type === "presence.changed"
                ? (event as unknown as { presence: PresenceState }).presence
                : prev.presence,
        lastSocketEventAt: viaSocket ? now() : prev.lastSocketEventAt,
    };
}
