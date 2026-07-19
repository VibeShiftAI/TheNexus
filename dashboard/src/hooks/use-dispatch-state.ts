/**
 * useDispatchState — one shared /api/praxis/dispatch-state poller for the
 * whole deck.
 *
 * Same rationale (and shape) as useBoardState: the :4000 API rate-limits
 * aggressively, so N panels reading dispatch telemetry must not mean N poll
 * loops. A module-level store runs a single 20s fetch while anyone is
 * subscribed, concurrent refresh() calls coalesce into one request, and every
 * subscriber — the Ops station, the crew strip, the task board — shares the
 * same snapshot.
 *
 * Consumers that only want derived crew/lane data should use useCrewActivity,
 * which reads this same store.
 */
"use client";

import { useEffect, useState } from "react";
import type { DispatchStateResponse } from "@/components/bridge/dispatch-station";

const POLL_MS = 20_000;

export interface DispatchStateSnapshot {
  state: DispatchStateResponse | null;
  /** True once a fetch has failed and no snapshot has since succeeded. */
  error: boolean;
}

let snapshot: DispatchStateSnapshot = { state: null, error: false };
const subscribers = new Set<(s: DispatchStateSnapshot) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function publish(next: DispatchStateSnapshot) {
  snapshot = next;
  for (const fn of subscribers) fn(snapshot);
}

export function refreshDispatchState(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/praxis/dispatch-state", { cache: "no-store" });
      if (!res.ok) throw new Error(`dispatch-state ${res.status}`);
      const data = (await res.json()) as DispatchStateResponse;
      publish({ state: data, error: false });
    } catch {
      // Keep the last good snapshot — panels degrade to SSE-only rather than
      // blanking out on a single failed poll.
      publish({ state: snapshot.state, error: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function subscribe(fn: (s: DispatchStateSnapshot) => void): () => void {
  subscribers.add(fn);
  fn(snapshot);
  if (!timer) {
    refreshDispatchState();
    timer = setInterval(refreshDispatchState, POLL_MS);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useDispatchState(): DispatchStateSnapshot & { refresh: () => Promise<void> } {
  const [s, setS] = useState<DispatchStateSnapshot>(snapshot);
  useEffect(() => subscribe(setS), []);
  return { ...s, refresh: refreshDispatchState };
}
