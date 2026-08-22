/**
 * useCoreState — live fused activity state for the core orb (see
 * lib/core-state.ts for the model). Wires the shared Praxis SSE stream and
 * crew activity to deriveCoreState, and keeps a light council seed poll so
 * deliberations convened before this page loaded (or missed during a stream
 * gap) still appear. Between polls, `council.update` stream events carry the
 * live truth with no added traffic.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePraxisStream } from "./use-praxis-stream";
import { useCrewActivity } from "./use-crew-activity";
import { getCouncilSessions } from "@/lib/council";
import { deriveCoreState, type CoreState, type CouncilSeed } from "@/lib/core-state";

// Seed cadence — the SSE stream carries live council changes; this only
// bootstraps and self-heals, so it can idle along at the crew-strip pace.
const COUNCIL_POLL_MS = 30_000;

export function useCoreState(): CoreState & { connected: boolean } {
  const { presence, recentEvents, connected } = usePraxisStream();
  const { crew } = useCrewActivity();
  const [councilSeed, setCouncilSeed] = useState<CouncilSeed | null>(null);
  // Re-derive periodically so time-based transitions (council staleness,
  // pulse expiry in the renderer's static frame) don't wait for an event.
  const [tick, setTick] = useState(0);
  const seedFailures = useRef(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const { sessions, inFlight } = await getCouncilSessions(5);
        if (!alive) return;
        seedFailures.current = 0;
        setCouncilSeed({
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            topic: s.topic,
            phase: s.phase,
            createdAt: s.createdAt,
            metadata: s.metadata,
            voices: s.voices?.map((v) => ({ name: v.name, status: v.status })),
          })),
          inFlight,
          fetchedAt: Date.now(),
        });
      } catch {
        // Seed is best-effort; stream events still drive the orb. Drop a
        // seed we can no longer refresh so inFlight can't go stale forever.
        seedFailures.current += 1;
        if (alive && seedFailures.current >= 3) setCouncilSeed(null);
      }
    };
    load();
    const poll = setInterval(load, COUNCIL_POLL_MS);
    const tick = setInterval(() => setTick((n) => n + 1), 15_000);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return useMemo(
    () => ({
      ...deriveCoreState({
        presence,
        connected,
        recentEvents,
        crew,
        councilSeed,
        now: Date.now(),
      }),
      connected,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick forces time-based re-derivation
    [presence, connected, recentEvents, crew, councilSeed, tick],
  );
}
