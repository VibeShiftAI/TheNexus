/**
 * useAutonomy — one shared /api/dispatch-insight/autonomy poller for the deck.
 *
 * Same module-level store rationale as useDispatchState: the :4000 API rate
 * limits, and this route costs Praxis a bridge round-trip for the day-schedule
 * probe, so N indicators must not mean N poll loops.
 *
 * A failed poll keeps the last good snapshot but flags `error`, and the
 * indicator degrades to "unknown" rather than blanking — the cockpit never
 * reads green over a runtime it cannot see.
 */
"use client";

import { useEffect, useState } from "react";
import { getAutonomyState, type AutonomyState } from "@/lib/nexus";

const POLL_MS = 30_000;

export interface AutonomySnapshot {
  state: AutonomyState | null;
  error: boolean;
}

let snapshot: AutonomySnapshot = { state: null, error: false };
const subscribers = new Set<(s: AutonomySnapshot) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function publish(next: AutonomySnapshot) {
  snapshot = next;
  for (const fn of subscribers) fn(snapshot);
}

export function refreshAutonomy(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      publish({ state: await getAutonomyState(), error: false });
    } catch {
      publish({ state: snapshot.state, error: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useAutonomy(): AutonomySnapshot & { refresh: () => Promise<void> } {
  const [s, setS] = useState<AutonomySnapshot>(snapshot);
  useEffect(() => {
    subscribers.add(setS);
    setS(snapshot);
    if (!timer) {
      refreshAutonomy();
      timer = setInterval(refreshAutonomy, POLL_MS);
    }
    return () => {
      subscribers.delete(setS);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return { ...s, refresh: refreshAutonomy };
}
