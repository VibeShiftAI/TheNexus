/**
 * useQaHolds — shared poller for tasks whose QA correction is being held.
 *
 * A held task sits at `todo` looking exactly like an ordinary one: its review
 * ran, failed, and was NOT re-dispatched because autonomy was paused, so the
 * findings are kept and no strike was spent. On 2026-09-02 three of Robert's
 * tasks sat parked this way and chat was the only way to find out.
 *
 * Indexed by task id so the board can badge a card in O(1) while it maps.
 */
"use client";

import { useEffect, useState } from "react";
import { getQaHolds, type QaHold } from "@/lib/nexus";

const POLL_MS = 60_000;

export interface QaHoldsSnapshot {
  holds: QaHold[];
  byTaskId: Map<string, QaHold>;
  /** True once a fetch has failed and none has since succeeded. */
  error: boolean;
}

const EMPTY: QaHoldsSnapshot = { holds: [], byTaskId: new Map(), error: false };

let snapshot: QaHoldsSnapshot = EMPTY;
const subscribers = new Set<(s: QaHoldsSnapshot) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function publish(next: QaHoldsSnapshot) {
  snapshot = next;
  for (const fn of subscribers) fn(snapshot);
}

export function indexHolds(holds: QaHold[]): Map<string, QaHold> {
  return new Map(holds.map((h) => [h.taskId, h]));
}

export function refreshQaHolds(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const holds = await getQaHolds();
      publish({ holds, byTaskId: indexHolds(holds), error: false });
    } catch {
      // Keep the last good list: a held task is still held through a blip.
      publish({ ...snapshot, error: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useQaHolds(): QaHoldsSnapshot & { refresh: () => Promise<void> } {
  const [s, setS] = useState<QaHoldsSnapshot>(snapshot);
  useEffect(() => {
    subscribers.add(setS);
    setS(snapshot);
    if (!timer) {
      refreshQaHolds();
      timer = setInterval(refreshQaHolds, POLL_MS);
    }
    return () => {
      subscribers.delete(setS);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return { ...s, refresh: refreshQaHolds };
}
