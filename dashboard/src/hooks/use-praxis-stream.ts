/**
 * usePraxisStream — subscribe to Praxis's outbound event stream via the
 * Nexus relay at /api/praxis/stream. Surfaces:
 *   - live PresenceState (the "what's Praxis doing right now" single snapshot)
 *   - last N events (default 20) for activity-feed style UIs
 *   - connection status
 *
 * Snapshot is bootstrapped from /api/praxis/stream/snapshot so there's no
 * blank-UI window before the first streamed event arrives.
 *
 * Reconnect: EventSource does this natively. We carry `lastEventId` so
 * gaps are replayed from the Nexus relay's ring buffer.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type { PresenceState, StreamEvent } from "@praxis/contract";

const STREAM_URL = "/api/praxis/stream";
const SNAPSHOT_URL = "/api/praxis/stream/snapshot";
const MAX_RECENT_EVENTS = 20;

export interface PraxisStreamState {
  presence: PresenceState | null;
  recentEvents: StreamEvent[];
  connected: boolean;
  lastEventId: string | null;
}

export function usePraxisStream(): PraxisStreamState {
  const [presence, setPresence] = useState<PresenceState | null>(null);
  const [recentEvents, setRecentEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;

    // 1. Bootstrap snapshot so UIs render with state immediately
    fetch(SNAPSHOT_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.presence) setPresence(data.presence as PresenceState);
        if (data.upstream?.lastEventId) setLastEventId(data.upstream.lastEventId);
      })
      .catch(() => {
        /* snapshot is best-effort; live stream will populate */
      });

    // 2. Subscribe to the live stream
    const source = new EventSource(STREAM_URL);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (msg) => handleFrame(msg);
    // Also handle named events (event: presence.changed, etc). The relay emits both
    // a named `event:` and JSON `data:` so either listener path works.
    const types: StreamEvent["type"][] = [
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
    ];
    for (const type of types) source.addEventListener(type, handleFrame as EventListener);

    function handleFrame(msg: MessageEvent) {
      if (!msg.data) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(msg.data) as StreamEvent;
      } catch {
        return;
      }
      if (event.eventId) setLastEventId(event.eventId);
      if (event.type === "presence.changed") {
        setPresence(event.presence);
      }
      // heartbeat spams the feed; keep it out of the recent-events list
      if (event.type !== "heartbeat") {
        setRecentEvents((prev) => {
          const next = [event, ...prev];
          return next.length > MAX_RECENT_EVENTS ? next.slice(0, MAX_RECENT_EVENTS) : next;
        });
      }
    }

    return () => {
      cancelled = true;
      source.close();
      sourceRef.current = null;
    };
  }, []);

  return { presence, recentEvents, connected, lastEventId };
}
