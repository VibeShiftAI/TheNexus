/**
 * useCoreState — live fused activity state for the core orb (see
 * lib/core-state.ts for the model). Wires the shared live-board context and
 * crew activity to deriveCoreState, and keeps a light council seed poll so
 * deliberations convened before this page loaded (or missed during a stream
 * gap) still appear. Between polls, `council.update` stream events carry the
 * live truth with no added traffic.
 */
"use client";

import { useBridgeActivity } from "@/components/bridge/activity-provider";
import type { CorePulse } from "@/lib/core-state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveBoardState, useLiveRefetch } from "@/components/live-board-state";
import { useCrewActivity } from "./use-crew-activity";
import { getCouncilSessions } from "@/lib/council";
import { deriveCoreState, type CoreState, type CouncilSeed } from "@/lib/core-state";

// Seed cadence — live frames carry council changes; this only
// bootstraps and self-heals, so it can idle along at the crew-strip pace.
const COUNCIL_POLL_MS = 30_000;

export function useCoreState(): CoreState & { connected: boolean } {
  const { presence, recentEvents, connected } = useLiveBoardState();
  const { crew } = useCrewActivity();
  const bridge = useBridgeActivity();
  const [councilSeed, setCouncilSeed] = useState<CouncilSeed | null>(null);
  // Re-derive periodically so time-based transitions (council staleness,
  // pulse expiry in the renderer's static frame) don't wait for an event.
  const [tick, setTick] = useState(0);
  const seedFailures = useRef(0);

  const load = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const { sessions, inFlight } = await getCouncilSessions(5);
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
      // Seed is best-effort; live frames still drive the orb. Drop a seed we
      // can no longer refresh so inFlight can't go stale forever.
      seedFailures.current += 1;
      if (seedFailures.current >= 3) setCouncilSeed(null);
    }
  }, []);

  // Event-driven seed refresh. `council.update` rides the activity domain and
  // presence rides system, so a council convened elsewhere shows up on the
  // frame. COUNCIL_POLL_MS stays as the fallback: the seed is also how the orb
  // self-heals from a missed frame, which is exactly the case a poll covers.
  // The 2s debounce matters here: `activity` bumps on almost every frame, and
  // a busy dispatch minute would otherwise turn one 30s seed fetch into dozens.
  useLiveRefetch(["activity", "system"], load, {
    fallbackPollMs: COUNCIL_POLL_MS,
    debounceMs: 2000,
  });

  // Pure clock — re-derive so time-based transitions (council staleness, pulse
  // expiry) advance without an event. Touches no network.
  useEffect(() => {
    const tick = setInterval(() => setTick((n) => n + 1), 15_000);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return useMemo(
    () => {
      const state = deriveCoreState({
        presence,
        connected,
        recentEvents,
        crew,
        councilSeed,
        now: Date.now(),
      });
      const extra: CorePulse[] = bridge.items.filter(item => ["memory", "vault", "dispatch", "qa"].includes(item.channel) && bridge.channels.find(c => c.id === item.channel)?.available && bridge.now - Date.parse(item.at) >= 0 && bridge.now - Date.parse(item.at) < 12000).slice(0, 8).map(item => ({id:item.id, at:Date.parse(item.at), kind:item.status === "failed" ? "task-fail" : item.channel === "memory" ? "memory-access" : item.channel === "vault" ? "vault-write" : item.channel === "qa" ? "qa" : "dispatch"}));
      return { ...state, pulses:[...state.pulses,...extra], intensity:Math.min(1,state.intensity+(extra.length ? 0.2 : 0)), connected };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick forces time-based re-derivation
    [presence, connected, recentEvents, crew, councilSeed, tick, bridge],
  );
}
