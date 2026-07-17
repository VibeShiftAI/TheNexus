/**
 * DispatchStation — "Ops": the crew flow graph. The three CLI providers, the
 * local LLM, and the Praxis hub render as one network (see CrewFlow); each
 * provider node wears its current role — executor, QA gatekeeper, council
 * seat, aggregator — with packets flowing along the edges as work moves.
 * Role/progress data comes from the shared SSE stream (executor.progress /
 * task.* events) with a fallback to the run registry from Praxis
 * /api/dispatch/state; council state from /api/praxis/council/sessions,
 * polled fast while a council sits. Click a node for the drill-down popup,
 * the status line for /council, or through to /ops for the full console.
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
import { CrewFlow, type CrewLaneView } from "@/components/bridge/crew-flow";
import { getBoardLaneId } from "@/lib/task-board";
import {
  getCouncilSessions,
  getCouncilArbiter,
  setCouncilArbiter,
  isLiveSession,
  isAggregatorVoice,
  sessionKind,
  type ArbiterSeat,
  type CouncilArbiterState,
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
  const [arbiter, setArbiter] = useState<CouncilArbiterState | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getCouncilSessions(12);
        if (active) setCouncilSessions(data.sessions);
      } catch {
        // Council telemetry is best-effort; the section hides itself.
      }
      try {
        const arb = await getCouncilArbiter();
        if (active) setArbiter(arb);
      } catch {
        // Older Praxis without the endpoint — the badges just don't render.
      }
    };
    load();
    const t = setInterval(load, councilSitting ? 5_000 : 30_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [councilSitting]);

  // Pin a seat as arbiter; clicking the pinned seat releases back to auto.
  const handleSetArbiter = useCallback(
    async (seat: ArbiterSeat) => {
      const target = arbiter?.preference === seat ? "auto" : seat;
      setArbiter((prev) =>
        prev ? { ...prev, preference: target, next: target === "auto" ? prev.next : target } : prev,
      );
      try {
        setArbiter(await setCouncilArbiter(target));
      } catch {
        // Poll refetch reconciles if the write failed.
      }
    },
    [arbiter],
  );

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
  const lastCouncil = councilSessions?.[0] ?? null;

  // Per-provider lane view for the crew graph: live SSE events win, the run
  // registry backfills runs started before this page loaded, and settled
  // (done/failed > 60s) lanes drop back to idle.
  const laneView = useMemo(() => {
    const out: Partial<Record<ExecutorName, CrewLaneView>> = {};
    for (const lane of LANES) {
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
      if (!l) continue;
      if (l.status !== "active" && now - l.at > LANE_SETTLE_MS) continue;
      out[lane.id] = { pct: l.pct, phase: l.phase, status: l.status };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes, state, now]);

  // Headline for the status line when no council sits: the freshest active run.
  const activeRun = useMemo(() => {
    const active = (state?.executors?.runs ?? []).filter((r) => r.status === "active");
    return active.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
  }, [state]);

  const councilRefs = liveCouncil?.voices.filter((v) => !isAggregatorVoice(v)) ?? [];
  const councilReported = councilRefs.filter((v) => v.status !== "pending" && v.status !== "running").length;

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
          <CrewFlow
            lanes={laneView}
            runs={state?.executors?.runs}
            council={liveCouncil}
            local={{ running: localRunning, queued: localQueued, paused: localPaused }}
            arbiter={arbiter}
            onSetArbiter={handleSetArbiter}
            onInspect={setInspecting}
          />

          {/* Status ticker: the one thing moving through the system right now */}
          <div className="mt-1.5 flex items-center gap-2 border-t border-slate-800/60 pt-1.5 text-[10px] leading-4">
            {liveCouncil ? (
              <Link href="/council" className="flex min-w-0 flex-1 items-center gap-2" title="Council in session — open the chamber">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-amber-200">
                  <Landmark size={10} className="shrink-0 text-amber-400" />
                  <span className="shrink-0 font-semibold uppercase tracking-wide text-amber-400">
                    {sessionKind(liveCouncil.metadata).label}
                  </span>
                  <span className="truncate">{liveCouncil.topic}</span>
                </span>
                <span className="shrink-0 tabular-nums text-amber-300">
                  {councilPhaseLabel(liveCouncil.phase)} · {councilReported}/{councilRefs.length} in ·{" "}
                  {Math.max(0, Math.floor((now - liveCouncil.createdAt) / 60_000))}m
                </span>
              </Link>
            ) : activeRun ? (
              <>
                <span className="min-w-0 flex-1 truncate text-slate-400" title={activeRun.title}>
                  <span className="text-cyan-400">
                    {LANES.find((l) => l.id === activeRun.executor)?.label ?? activeRun.executor}
                  </span>{" "}
                  {activeRun.title}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {activeRun.kind === "qa" ? "qa" : activeRun.kind === "agent" ? "agent" : "exec"} · {activeRun.phase}
                </span>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-slate-500">crew standing by — chamber dark</span>
                {lastCouncil && (
                  <Link href="/council" className="shrink-0 tabular-nums text-slate-500 transition-colors hover:text-slate-300">
                    {councilToday > 0 ? `${councilToday} council${councilToday === 1 ? "" : "s"} today · ` : ""}
                    last {agoFmt(lastCouncil.createdAt)}
                  </Link>
                )}
              </>
            )}
          </div>

          {/* Bottom instruments pin to the panel floor so the station fills
              its row evenly beside the knowledge constellation. */}
          <div className="mt-auto space-y-2.5 pt-2">
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
