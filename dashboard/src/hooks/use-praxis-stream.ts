/**
 * usePraxisStream — subscribe to Praxis's outbound event stream via the
 * Nexus relay at /api/praxis/stream. Surfaces:
 *   - live PresenceState (the "what's Praxis doing right now" single snapshot)
 *   - last N events (default 50) for activity-feed / ticker style UIs
 *   - connection status
 *
 * One EventSource is shared module-wide: every component that calls this hook
 * subscribes to the same connection (the bridge dashboard has half a dozen
 * live widgets — per-hook connections would fan out N parallel SSE streams).
 * The connection opens on first subscriber and lingers briefly after the last
 * unsubscribes so route transitions don't churn it.
 *
 * Snapshot is bootstrapped from /api/praxis/stream/snapshot so there's no
 * blank-UI window before the first streamed event arrives. A `stream.reset`
 * frame re-bootstraps presence (the relay's ring buffer couldn't replay the
 * gap, so local state is stale).
 *
 * Reconnect: EventSource does this natively. We carry `lastEventId` so gaps
 * are replayed from the Nexus relay's ring buffer.
 */
"use client";

import { useSyncExternalStore } from "react";
import type { PresenceState, StreamEvent } from "@praxis/contract";

const STREAM_URL = "/api/praxis/stream";
const SNAPSHOT_URL = "/api/praxis/stream/snapshot";
const MAX_RECENT_EVENTS = 50;
const TEARDOWN_LINGER_MS = 5000;

export interface PraxisStreamState {
  presence: PresenceState | null;
  recentEvents: StreamEvent[];
  connected: boolean;
  lastEventId: string | null;
}

const EMPTY_STATE: PraxisStreamState = Object.freeze({
  presence: null,
  recentEvents: [],
  connected: false,
  lastEventId: null,
});

// ── Module-level shared store ─────────────────────────────────────
let source: EventSource | null = null;
let snapshot: PraxisStreamState = EMPTY_STATE;
const listeners = new Set<() => void>();
let subscriberCount = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

function emit(patch: Partial<PraxisStreamState>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function bootstrapSnapshot() {
  fetch(SNAPSHOT_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !source) return;
      const patch: Partial<PraxisStreamState> = {};
      if (data.presence) patch.presence = data.presence as PresenceState;
      if (data.upstream?.lastEventId && !snapshot.lastEventId) {
        patch.lastEventId = data.upstream.lastEventId;
      }
      if (Object.keys(patch).length > 0) emit(patch);
    })
    .catch(() => {
      /* snapshot is best-effort; live stream will populate */
    });
}

const EVENT_TYPES: StreamEvent["type"][] = [
  "presence.changed",
  "task.created",
  "task.updated",
  "task.started",
  "task.completed",
  "task.failed",
  "task.blocked",
  "hitl.created",
  "hitl.resolved",
  "heartbeat",
  "thinking.trace",
  "schedule.updated",
  "executor.progress",
  "stream.reset",
];

function handleFrame(msg: MessageEvent) {
  if (!msg.data) return;
  let event: StreamEvent;
  try {
    event = JSON.parse(msg.data) as StreamEvent;
  } catch {
    return;
  }
  const patch: Partial<PraxisStreamState> = {};
  if (event.eventId) patch.lastEventId = event.eventId;
  if (event.type === "presence.changed") {
    patch.presence = event.presence;
  }
  if (event.type === "stream.reset") {
    // Gap we can't replay — re-bootstrap authoritative state.
    bootstrapSnapshot();
  }
  // heartbeat spams the feed; keep it out of the recent-events list
  if (event.type !== "heartbeat") {
    const next = [event, ...snapshot.recentEvents];
    patch.recentEvents = next.length > MAX_RECENT_EVENTS ? next.slice(0, MAX_RECENT_EVENTS) : next;
  }
  emit(patch);
}

function connect() {
  if (source) return;
  source = new EventSource(STREAM_URL);
  source.onopen = () => emit({ connected: true });
  source.onerror = () => emit({ connected: false });
  source.onmessage = handleFrame;
  // Also handle named events (event: presence.changed, etc). The relay emits
  // both a named `event:` and JSON `data:` so either listener path works.
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, handleFrame as EventListener);
  }
  bootstrapSnapshot();
}

function disconnect() {
  if (!source) return;
  source.close();
  source = null;
  emit({ connected: false });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  connect();
  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount <= 0) {
      teardownTimer = setTimeout(() => {
        if (subscriberCount <= 0) disconnect();
      }, TEARDOWN_LINGER_MS);
    }
  };
}

function getSnapshot(): PraxisStreamState {
  return snapshot;
}

function getServerSnapshot(): PraxisStreamState {
  return EMPTY_STATE;
}

export function usePraxisStream(): PraxisStreamState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
