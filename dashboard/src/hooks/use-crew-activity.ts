/**
 * useCrewActivity — who's working right now, across the whole crew:
 * the three CLI executors (live SSE lane events, with the run-registry
 * snapshot as fallback for runs that started before this page loaded),
 * the local LLM worker (queue counts), and anything the registry knows.
 *
 * Powers the crew strip on the main viewer and the synthesized "active
 * runs" rows on the Ops console, so activity is visible even when the
 * running Praxis process predates the registry code.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { usePraxisStream } from "./use-praxis-stream";
import { useDispatchState } from "./use-dispatch-state";
import type { ExecutorName } from "@praxis/contract";
import type { ExecutorRun } from "@/components/bridge/dispatch-station";

export interface CrewMember {
  id: string;
  label: string;
  state: "active" | "done" | "failed" | "idle";
  detail?: string;
}

const SETTLE_MS = 90_000;
const EXECUTORS: { id: ExecutorName; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
];

interface SseLane {
  taskId: string;
  phase: string;
  status: "active" | "done" | "failed";
  at: number;
}

export function useCrewActivity(): {
  crew: CrewMember[];
  sseRuns: ExecutorRun[];
  dispatchedToday?: { total: number; failed: number };
} {
  const { recentEvents } = usePraxisStream();
  // Deck-wide shared dispatch-state poller — one fetch loop no matter how
  // many components call this hook (crew strip, task board, Ops console).
  const { state: dispatchState } = useDispatchState();
  // Re-render periodically so settle timeouts expire visually.
  const [, setTick] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(tick);
  }, []);

  return useMemo(() => {
    const now = Date.now();

    // Fold stream events per executor — newest wins (same as the Ops lanes).
    const lanes: Partial<Record<ExecutorName, SseLane>> = {};
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const e = recentEvents[i];
      if (e.type === "executor.progress") {
        lanes[e.progress.executor] = {
          taskId: e.progress.taskId,
          phase: e.progress.phase,
          status: "active",
          at: new Date(e.at).getTime(),
        };
      } else if (e.type === "task.started") {
        lanes[e.executor] = {
          taskId: e.taskId,
          phase: "dispatching",
          status: "active",
          at: new Date(e.at).getTime(),
        };
      } else if ((e.type === "task.completed" || e.type === "task.failed") && e.result?.executor) {
        const ok = e.type === "task.completed" && e.result.outcome === "success";
        lanes[e.result.executor] = {
          taskId: e.taskId,
          phase: ok ? "done" : "failed",
          status: ok ? "done" : "failed",
          at: new Date(e.at).getTime(),
        };
      }
    }

    const registryRuns = dispatchState?.executors?.runs ?? [];
    const crew: CrewMember[] = [];
    const sseRuns: ExecutorRun[] = [];

    for (const ex of EXECUTORS) {
      const lane = lanes[ex.id];
      const registryActive = registryRuns.find((r) => r.executor === ex.id && r.status === "active");
      const laneLive = lane && !(lane.status !== "active" && now - lane.at > SETTLE_MS);

      if (laneLive && lane) {
        crew.push({
          id: ex.id,
          label: ex.label,
          state: lane.status === "done" ? "done" : lane.status === "failed" ? "failed" : "active",
          detail: lane.status === "active" ? lane.phase : lane.phase,
        });
        if (lane.status === "active" && !registryRuns.some((r) => r.taskId === lane.taskId)) {
          sseRuns.push({
            taskId: lane.taskId,
            executor: ex.id,
            title: registryActive?.title ?? `task ${lane.taskId.slice(0, 8)}`,
            kind: "task",
            phase: lane.phase,
            status: "active",
            startedAt: new Date(lane.at).toISOString(),
            updatedAt: new Date(lane.at).toISOString(),
          });
        }
      } else if (registryActive) {
        crew.push({ id: ex.id, label: ex.label, state: "active", detail: registryActive.phase });
      } else {
        crew.push({ id: ex.id, label: ex.label, state: "idle" });
      }
    }

    // Local LLM worker
    const counts = dispatchState?.localLlm?.counts ?? {};
    const running = counts["running"] ?? 0;
    const queued = counts["queued"] ?? 0;
    const paused = Boolean(dispatchState?.localLlm?.worker?.paused);
    crew.push({
      id: "local-llm",
      label: "Local LLM",
      state: running > 0 ? "active" : "idle",
      detail: paused
        ? "paused"
        : running > 0
        ? `${running} running${queued > 0 ? ` · ${queued} queued` : ""}`
        : queued > 0
        ? `${queued} queued`
        : undefined,
    });

    return { crew, sseRuns, dispatchedToday: dispatchState?.executors?.dispatchedToday };
  }, [recentEvents, dispatchState]);
}
