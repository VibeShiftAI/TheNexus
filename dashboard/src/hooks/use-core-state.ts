/**
 * useCoreState — live fused activity state for the core orb (see
 * lib/core-state.ts for the model). Wires the shared live-board context and
 * crew activity to deriveCoreState, and reads the shared council snapshot so
 * deliberations convened before this page loaded (or missed during a stream
 * gap) still appear. Between polls, `council.update` stream events carry the
 * latest deliberation directly to the orb.
 */
"use client";

import { useBridgeActivity } from "@/components/bridge/activity-provider";
import type { CorePulse } from "@/lib/core-state";
import { useEffect, useMemo, useState } from "react";
import { useLiveBoardState } from "@/components/live-board-state";
import { useCrewActivity } from "./use-crew-activity";
import { useCouncilSessions } from "./use-council-sessions";
import { deriveCoreState, type CoreState } from "@/lib/core-state";

export function useCoreState(): CoreState & { connected: boolean } {
  const { presence, recentEvents, connected } = useLiveBoardState();
  const { crew } = useCrewActivity();
  const bridge = useBridgeActivity();
  const { value: snapshot, failures } = useCouncilSessions();
  // The orb uses the five most recent sessions and drops its seed after
  // three failed reads. Live council frames can still drive it independently.
  const councilSeed = useMemo(() => snapshot && failures < 3
    ? { ...snapshot, sessions: snapshot.sessions.slice(0, 5) }
    : null, [snapshot, failures]);
  const [tick, setTick] = useState(0);
  // Advance staleness and pulse expiry between events.
  useEffect(() => {
    const tick = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(tick);
  }, []);

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
