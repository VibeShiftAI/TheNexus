/**
 * DispatchStation — "Ops": live executor lanes showing task packets moving
 * through Praxis's dispatch pipeline (Antigravity, Codex, Claude Code — all as
 * CLI executors — plus the local LLM queue). Lane motion is driven by the
 * shared SSE stream (executor.progress / task.* events) with a fallback to the
 * run registry from Praxis /api/dispatch/state. Below the lanes sits the
 * council chamber miniature — seats light up live as a deliberation runs
 * (data from /api/praxis/council/sessions, polled fast while a council sits).
 * Click a lane for the executor drill-down popup, the chamber for /council,
 * or through to /ops for the full console.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Send, ArrowUpRight, CalendarClock, AlertTriangle, Landmark } from "lucide-react";
import { usePraxisStream } from "@/hooks/use-praxis-stream";
import { useStreamRefetch } from "@/hooks/use-stream-refetch";
import { useBoardState } from "@/hooks/use-board-state";
import { HudPanel } from "@/components/bridge/hud";
import { ExecutorDetailModal, type ExecutorId } from "@/components/bridge/executor-detail";
import { CouncilChamberMini } from "@/components/bridge/council-chamber-mini";
import { getBoardLaneId } from "@/lib/task-board";
import {
  getCouncilSessions,
  isLiveSession,
  isAggregatorVoice,
  sessionKind,
  type CouncilSessionSummary,
} from "@/lib/council";
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
  { id: "antigravity", label: "Antigravity" },
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

/** Countdown to a cron nextRun, e.g. "in 3h 12m". */
function inFmt(iso: string) {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d`;
}

/** Relative age, e.g. "2h ago". */
function agoFmt(ts: number) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function councilPhaseLabel(phase: CouncilSessionSummary["phase"]) {
  if (phase === "deliberation") return "seats deliberating";
  if (phase === "synthesis" || phase === "refinement") return "drafting the verdict";
  if (phase === "complete") return "verdict delivered";
  return "convening";
}

export function DispatchStation() {
  const { recentEvents } = usePraxisStream();
  const [state, setState] = useState<DispatchStateResponse | null>(null);
  const [err, setErr] = useState(false);
  const [lanes, setLanes] = useState<Partial<Record<ExecutorName, LaneState>>>({});
  const [inspecting, setInspecting] = useState<ExecutorId | null>(null);

  // Count of board tasks in the Needs Attention lane (blocked / failed /
  // awaiting input). Raw dispatch failures that were retried and succeeded
  // don't land here, so this is the honest "act on this" number. The board
  // snapshot is the deck-wide shared poller; stream events nudge it.
  const { projects: boardProjects, refresh: refreshBoard } = useBoardState();
  useStreamRefetch(
    ["task.created", "task.updated", "task.started", "task.completed", "task.failed", "task.blocked"],
    refreshBoard,
  );
  const attention = useMemo(() => {
    if (!boardProjects) return null;
    let count = 0;
    for (const p of boardProjects) {
      for (const t of p.tasks ?? []) {
        if (getBoardLaneId(t) === "needs_attention") count++;
      }
    }
    return count;
  }, [boardProjects]);

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

  // Council chamber: poll the session store fast while a council sits,
  // lazily otherwise (mirrors the /council page cadence).
  const [councilSessions, setCouncilSessions] = useState<CouncilSessionSummary[] | null>(null);
  const liveCouncil = useMemo(
    () => councilSessions?.find(isLiveSession) ?? null,
    [councilSessions],
  );
  // Key the poll effect on a stable boolean — keying on the session object
  // would tear the interval down on every fetch (fresh references each time).
  const councilSitting = Boolean(liveCouncil);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getCouncilSessions(12);
        if (active) setCouncilSessions(data.sessions);
      } catch {
        // Council telemetry is best-effort; the section hides itself.
      }
    };
    load();
    const t = setInterval(load, councilSitting ? 5_000 : 30_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [councilSitting]);

  // Tick each second while a council sits so the elapsed readout runs.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!councilSitting) return;
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [councilSitting]);

  const today = state?.executors?.dispatchedToday;
  const localCounts = state?.localLlm?.counts ?? {};
  const localRunning = localCounts["running"] ?? 0;
  const localQueued = localCounts["queued"] ?? 0;
  const localPaused = Boolean(state?.localLlm?.worker?.paused);

  const now = Date.now();

  const councilToday = useMemo(() => {
    if (!councilSessions) return 0;
    const midnight = new Date().setHours(0, 0, 0, 0);
    return councilSessions.filter((s) => s.createdAt >= midnight).length;
  }, [councilSessions]);
  const chamberSession = liveCouncil ?? councilSessions?.[0] ?? null;

  // Next scheduled ops from the Praxis cron registry.
  const upcoming = useMemo(() => {
    const jobs = state?.cron ?? [];
    const at = Date.now();
    return jobs
      .filter((j) => !j.paused && j.nextRun && new Date(j.nextRun).getTime() > at)
      .sort((a, b) => new Date(a.nextRun!).getTime() - new Date(b.nextRun!).getTime())
      .slice(0, 2);
  }, [state]);

  return (
    <HudPanel
      icon={<Send size={16} />}
      title="OPS — DISPATCH"
      accent="cyan"
      className="flex h-full flex-col"
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
        <div className="flex min-h-0 flex-1 flex-col">
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
                <div className="relative h-2 flex-1 overflow-visible rounded-full bg-slate-800/70">
                  {show && (
                    <>
                      <div
                        className={`h-full rounded-full ${barColor} opacity-30 transition-all duration-700`}
                        style={{ width: `${l.pct}%` }}
                      />
                      {l.status === "active" && (
                        <div
                          className="hud-lane-flow absolute inset-y-0 left-0 rounded-full"
                          style={{
                            width: `${l.pct}%`,
                            background:
                              "repeating-linear-gradient(90deg, transparent 0px, transparent 8px, rgba(34,211,238,0.45) 8px, rgba(34,211,238,0.45) 12px)",
                          }}
                        />
                      )}
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

          {/* Bottom instruments pin to the panel floor so the station fills
              its row evenly beside the knowledge constellation. */}
          <div className="mt-auto space-y-2.5 pt-3">
            {chamberSession && (
              <div className="border-t border-slate-800/60 pt-2">
                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <Landmark size={10} className={liveCouncil ? "text-amber-400" : "text-slate-600"} />
                    council chamber
                    {liveCouncil && (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 normal-case tracking-normal">
                    {councilToday > 0 && (
                      <span className="tabular-nums text-slate-600">{councilToday} today</span>
                    )}
                    <Link href="/council" className="flex items-center gap-1 text-cyan-400 transition-colors hover:text-cyan-300">
                      chamber <ArrowUpRight size={10} />
                    </Link>
                  </span>
                </div>
                <Link
                  href="/council"
                  className={`block rounded transition-opacity hover:opacity-100 ${liveCouncil ? "" : "opacity-45"}`}
                  title={liveCouncil ? "Council in session — open the chamber" : "Open the council chamber"}
                >
                  <CouncilChamberMini
                    voices={chamberSession.voices}
                    phase={chamberSession.phase}
                    live={Boolean(liveCouncil)}
                  />
                </Link>
                <div className="mt-1 flex items-center gap-2 text-[10px]">
                  <span
                    className={`min-w-0 flex-1 truncate ${liveCouncil ? "text-amber-200" : "text-slate-500"}`}
                    title={chamberSession.topic}
                  >
                    {liveCouncil && (
                      <span className="mr-1.5 font-semibold uppercase tracking-wide text-amber-400">
                        {sessionKind(chamberSession.metadata).label} ·
                      </span>
                    )}
                    {chamberSession.topic}
                  </span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {liveCouncil ? (
                      <span className="text-amber-300">
                        {councilPhaseLabel(chamberSession.phase)} ·{" "}
                        {chamberSession.voices.filter(
                          (v) => !isAggregatorVoice(v) && v.status !== "pending" && v.status !== "running",
                        ).length}
                        /{chamberSession.voices.filter((v) => !isAggregatorVoice(v)).length} in ·{" "}
                        {Math.max(0, Math.floor((Date.now() - chamberSession.createdAt) / 60_000))}m
                      </span>
                    ) : (
                      `last convened ${agoFmt(chamberSession.createdAt)}`
                    )}
                  </span>
                </div>
              </div>
            )}

            {(upcoming.length > 0 || attention !== null) && (
              <div className="space-y-1 border-t border-slate-800/60 pt-2">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-600">
                  <span>next scheduled ops</span>
                  <Link
                    href="/task-board?lane=needs_attention"
                    className={`flex items-center gap-1 normal-case tracking-normal transition-colors ${
                      attention ? "text-rose-400 hover:text-rose-300" : "text-slate-600 hover:text-slate-400"
                    }`}
                    title="Open the task board focused on the Needs Attention lane"
                  >
                    <AlertTriangle size={10} />
                    {attention ?? "—"} {attention === 1 ? "needs" : "need"} your attention
                  </Link>
                </div>
                {upcoming.map((j) => (
                  <div key={j.key} className="flex items-center gap-2 text-[11px]">
                    <CalendarClock size={11} className="shrink-0 text-cyan-500/70" />
                    <span className="min-w-0 flex-1 truncate text-slate-300" title={j.description}>
                      {j.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-500">{inFmt(j.nextRun!)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {inspecting && <ExecutorDetailModal executor={inspecting} onClose={() => setInspecting(null)} />}
    </HudPanel>
  );
}
