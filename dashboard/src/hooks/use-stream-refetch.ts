/**
 * useStreamRefetch — run a callback when a matching event lands on the shared
 * Praxis stream. Lets widgets replace tight poll loops with event-driven
 * refetches (keep a slow fallback poll for drift).
 *
 * The callback fires at most once per matching eventId and is debounced so a
 * burst of task events triggers one refetch, not five.
 */
"use client";

import { useEffect, useRef } from "react";
import type { StreamEvent } from "@praxis/contract";
import { usePraxisStream } from "./use-praxis-stream";

export function useStreamRefetch(
  types: StreamEvent["type"][] | ((e: StreamEvent) => boolean),
  onEvent: () => void,
  debounceMs = 800,
) {
  const { recentEvents } = usePraxisStream();
  const lastSeenId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    const matches =
      typeof types === "function" ? types : (e: StreamEvent) => (types as string[]).includes(e.type);
    const newest = recentEvents.find(matches);
    if (!newest || !newest.eventId || newest.eventId === lastSeenId.current) return;
    const isFirstObservation = lastSeenId.current === null;
    lastSeenId.current = newest.eventId;
    // Don't refetch for events that were already in the buffer when we mounted.
    if (isFirstObservation) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => cbRef.current(), debounceMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentEvents]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
}
