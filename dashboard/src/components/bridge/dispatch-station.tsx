/**
 * DispatchStation — "Ops": live executor lanes showing task packets moving
 * through Praxis's dispatch pipeline (Codex, Claude Code, and the local LLM
 * queue). Lane motion is driven by the shared SSE stream (executor.progress /
 * task.* events); queue depth comes from Praxis /api/dispatch/state. Click a
 * lane for the executor drill-down popup, or through to /ops for the full
 * console.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Send, ArrowUpRight } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { HudPanel } from "@/components/bridge/hud";
import { ExecutorDetailModal, type ExecutorId } from "@/components/bridge/executor-detail";
import type { ExecutorName, ExecutionPhase } from "@praxis/contract";

const PHASE_PCT: Record<ExecutionPhase, number> = {
  dispatching: 8,
  loading: 22,
  thinking: 42,
  writing: 62,
  testing: 78,
  committing: 90,
  completing: 100,
};

const LANES: { id: ExecutorName & ExecutorId; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
];

interface LaneState {
  taskId: string;
  pct: number;
  phase: string;
  status: "active" | "done" | "failed";
  at: number;
}

export interface ExecutorRun {
  taskId: string;
  executor: string;
  title: string;
  workspace?: string;
  kind: "task" | "qa" | "agent";
  phase: string;
  status: "active" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  summary?: string;
}

/** A CLI conversation tied to a dispatched task (Praxis session-registry). */
export interface CliSession {
  taskId: string;
  executor: string;
  sessionId: string;
  workspace: string;
  model?: string;
  title?: string;
  status: "open" | "closed";
  openedAt: string;
  lastUsedAt: string;
  resumeCount: number;
  closedAt?: string;
  closeReason?: string;
}

/** The permanent chat CLI session for one backend (Praxis chat-cli-session). */
export interface ChatSessionState {
  sessionId?: string;
  openedAt?: string;
  lastActivityAt?: string;
  turns: number;
  pendingSeed?: string;
  compactAttempts?: number;
}

export interface DispatchHistoryRow {
  ts: string;
  caller: string;
  provider: string;
  model: string;
  latency_ms?: number | null;
  success: number | boolean;
  error?: string | null;
}

/** A scheduled job (cron), from the Praxis cron registry. */
export interface CronJob {
  key: string;
  label: string;
  description: string;
  category: "system" | "morning" | "market" | "ingestion" | "content" | "lars";
  cadence: string;
  schedule: string;
  timezone: string;
  paused: boolean;
  running: boolean;
  nextRun: string | null;
  lastRun: string | null;
  lastError: string | null;
}

export interface DispatchStateResponse {
  antigravity?: {
    bridge?: { status?: string; activeTasks?: number } | null;
    active?: number;
    pending?: number;
    queue?: { id: string; title: string; status: string; updatedAt: string; nexusTaskId?: string; error?: string | null; workspace?: string }[];
  };
  dispatchLog?: { id: string; title: string; status: string; dispatchedAt: string }[];
  cron?: CronJob[];
  executors?: {
    runs?: ExecutorRun[];
    /** CLI conversations per dispatched task, newest-first (open + recently closed). */
    sessions?: CliSession[];
    history?: DispatchHistoryRow[];
    /** Executor dispatches since local midnight, from the persistent llm_calls log. */
    dispatchedToday?: { total: number; failed: number };
  };
  /** Permanent chat CLI sessions, keyed by backend (e.g. "claude-code"). */
  chatSessions?: Record<string, ChatSessionState>;
  localLlm?: {
    worker?: { paused?: boolean; pauseReason?: string };
    counts?: Record<string, number>;
    jobs?: { id?: string; type?: string; status?: string; attempts?: number; maxAttempts?: number; updatedAt?: string }[];
  };
}

const LANE_SETTLE_MS = 60_000;

export function DispatchStation() {
  const { recentEvents } = usePraxisStream();
  const [state, setState] = useState<DispatchStateResponse | null>(null);
  const [err, setErr] = useState(false);
  const [lanes, setLanes] = useState<Partial<Record<ExecutorName, LaneState>>>({});
  const [inspecting, setInspecting] = useState<ExecutorId | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/praxis/dispatch-state", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as DispatchStateResponse;
        if (active) {
          setState(data);
          setErr(false);
        }
      } catch {
        if (active) setErr(true);
      }
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  // Fold stream events into lane state (newest event wins per executor).
  useEffect(() => {
    const next: Partial<Record<ExecutorName, LaneState>> = {};
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const e = recentEvents[i];
      if (e.type === "executor.progress") {
        const p = e.progress;
        next[p.executor] = {
          taskId: p.taskId,
          pct: p.progressPct ?? PHASE_PCT[p.phase] ?? 50,
          phase: p.phase,
          status: "active",
          at: new Date(e.at).getTime(),
        };
      } else if (e.type === "task.started") {
        next[e.executor] = {
          taskId: e.taskId,
          pct: PHASE_PCT.dispatching,
          phase: "dispatching",
          status: "active",
          at: new Date(e.at).getTime(),
        };
      } else if (e.type === "task.completed" && e.result?.executor) {
        next[e.result.executor] = {
          taskId: e.taskId,
          pct: 100,
          phase: e.result.outcome,
          status: e.result.outcome === "success" ? "done" : "failed",
          at: new Date(e.at).getTime(),
        };
      } else if (e.type === "task.failed" && e.result?.executor) {
        next[e.result.executor] = {
          taskId: e.taskId,
          pct: 100,
          phase: "failed",
          status: "failed",
          at: new Date(e.at).getTime(),
        };
      }
    }
    setLanes(next);
  }, [recentEvents]);

  const today = state?.executors?.dispatchedToday;
  const localCounts = state?.localLlm?.counts ?? {};
  const localRunning = localCounts["running"] ?? 0;
  const localQueued = localCounts["queued"] ?? 0;
  const localPaused = Boolean(state?.localLlm?.worker?.paused);

  const now = Date.now();

  return (
    <HudPanel
      icon={<Send size={16} />}
      title="OPS — DISPATCH"
      accent="cyan"
      headerRight={
        <>
          {today && (
            <span
              className="text-[10px] tabular-nums text-slate-500"
              title={`${today.total} dispatches since midnight${today.failed > 0 ? ` (${today.failed} failed)` : ""} — persistent count, survives Praxis restarts`}
            >
              {today.total} today
            </span>
          )}
          <Link href="/ops" className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
            console <ArrowUpRight size={12} />
          </Link>
        </>
      }
    >
      {err && !state ? (
        <div className="py-4 text-center text-xs text-slate-500">Dispatch telemetry unavailable</div>
      ) : (
        <div className="space-y-2.5">
          {LANES.map((lane) => {
            // Live SSE events win; fall back to the run registry snapshot so
            // a run started before this page loaded still shows as active.
            const registryRun = lanes[lane.id]
              ? undefined
              : state?.executors?.runs?.find((r) => r.executor === lane.id && r.status === "active");
            const l: LaneState | undefined =
              lanes[lane.id] ??
              (registryRun
                ? {
                    taskId: registryRun.taskId,
                    pct: PHASE_PCT[registryRun.phase as ExecutionPhase] ?? 50,
                    phase: registryRun.phase,
                    status: "active",
                    at: new Date(registryRun.updatedAt).getTime(),
                  }
                : undefined);
            const settled = l && now - l.at > LANE_SETTLE_MS && l.status !== "active";
            const show = l && !settled;
            const barColor =
              !show ? "" : l.status === "failed" ? "bg-red-400" : l.status === "done" ? "bg-emerald-400" : "bg-cyan-400";
            const dotGlow =
              !show ? "" : l.status === "failed" ? "shadow-[0_0_8px_rgba(248,113,113,0.9)]" : "shadow-[0_0_8px_rgba(34,211,238,0.9)]";
            return (
              <button
                key={lane.id}
                onClick={() => setInspecting(lane.id)}
                className="flex w-full items-center gap-2.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-slate-800/50"
                title={`${lane.label} drill-down`}
              >
                <span className="w-[76px] shrink-0 truncate text-[11px] text-slate-300">{lane.label}</span>
                <div className="relative h-1.5 flex-1 overflow-visible rounded-full bg-slate-800/70">
                  {show && (
                    <>
                      <div
                        className={`h-full rounded-full ${barColor} opacity-30 transition-all duration-700`}
                        style={{ width: `${l.pct}%` }}
                      />
                      <span
                        className={`absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full ${barColor} ${dotGlow} transition-all duration-700`}
                        style={{ left: `calc(${l.pct}% - 5px)` }}
                      />
                    </>
                  )}
                </div>
                <span className="w-[86px] shrink-0 truncate text-right text-[10px] tabular-nums text-slate-500">
                  {show ? (
                    <span className={l.status === "failed" ? "text-red-400" : l.status === "done" ? "text-emerald-400" : "text-cyan-400"}>
                      {l.phase}
                    </span>
                  ) : (
                    "idle"
                  )}
                </span>
              </button>
            );
          })}

          <button
            onClick={() => setInspecting("local-llm")}
            className="flex w-full items-center gap-2.5 border-t border-slate-800/60 px-1 pt-2 text-left transition-colors hover:bg-slate-800/50"
            title="Local LLM queue drill-down"
          >
            <span className="w-[76px] shrink-0 text-[11px] text-slate-300">Local LLM</span>
            <div className="flex-1 text-[10px] text-slate-500">
              {localRunning > 0 ? (
                <span className="text-cyan-400">{localRunning} running</span>
              ) : (
                <span>quiet</span>
              )}
              {localQueued > 0 && <span> · {localQueued} queued</span>}
              {localPaused ? <span className="text-amber-400"> · paused</span> : null}
            </div>
          </button>
        </div>
      )}

      {inspecting && <ExecutorDetailModal executor={inspecting} onClose={() => setInspecting(null)} />}
    </HudPanel>
  );
}
