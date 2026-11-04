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
import { useBoardState } from "@/hooks/use-board-state";
import { HudPanel } from "@/components/bridge/hud";
import { ExecutorDetailModal, type ExecutorId } from "@/components/bridge/executor-detail";
import { DispatchMap } from "./dispatch-map";
import { useCortex } from "@/components/cortex-provider";
import { useChatActivity } from "@/hooks/use-chat-activity";
import { useBridgeActivity } from "./activity-provider";
import { getBoardLaneId } from "@/lib/task-board";
import { isDayWellUnderway } from "@/lib/day-underway";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { deriveCliLane } from "@/lib/cli-lane";
import type {
  AttemptStallState,
  CliConcurrencyState,
  CliQueueEntry,
  FleetPosture,
} from "@/lib/nexus";
import {
  getCouncilSessions,
  getCouncilBenches,
  type CouncilBenchState,
  getCouncilArbiter,
  setCouncilArbiter,
  isLiveSession,
  isAggregatorVoice,
  sessionKind,
  type ArbiterSeat,
  type CouncilArbiterState,
  type CouncilSessionSummary,
} from "@/lib/council";
import type { ExecutorName } from "@praxis/contract";

const LANES: { id: ExecutorName & ExecutorId; label: string }[] = [
  { id: "antigravity", label: "Antigravity" },
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
];

export interface ExecutorRun {
  model?: string;
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
    /** Safe read-only projection of the persisted continuation ledger. */
    usageWaits?: { available: boolean; items: import('@/lib/current-focus').FocusWait[] };
    history?: DispatchHistoryRow[];
    /** Executor dispatches since local midnight, from the persistent llm_calls log. */
    dispatchedToday?: { total: number; failed: number };
    /**
     * Tasks waiting for the machine-wide CLI slot, in the order Praxis will
     * pull them — index 0 is next out, which is where queue POSITION comes
     * from (Praxis publishes no explicit position field).
     */
    cliQueue?: CliQueueEntry[];
    /** The machine-wide CLI concurrency gate and its reason string. */
    cliConcurrency?: CliConcurrencyState;
    /** Fleet routing posture — which workers are routable right now. */
    posture?: FleetPosture;
    /** Runs that overran their attempt grace window. */
    attemptStalls?: AttemptStallState;
  };
  /** Permanent chat CLI sessions, keyed by backend (e.g. "claude-code"). */
  chatSessions?: Record<string, ChatSessionState>;
  localLlm?: {
    worker?: { paused?: boolean; pauseReason?: string };
    counts?: Record<string, number>;
    jobs?: { id?: string; type?: string; status?: string; attempts?: number; maxAttempts?: number; updatedAt?: string }[];
  };
  /**
   * LM Studio live state (Praxis host-telemetry). Direct traffic — e.g.
   * TheCortex embedding calls — bypasses the local queue, so residency and
   * last-activity come from the server itself, not our job counts.
   */
  lmStudio?: {
    reachable?: boolean;
    models?: { id?: string; state?: string; type?: string }[];
    loadedCount?: number;
    lastActivityAt?: string | null;
  };
  /** Mac Studio host snapshot (Praxis runs on the box the models run on). */
  system?: {
    memory?: { totalBytes?: number; availBytes?: number; availPct?: number; swapUsedBytes?: number | null };
  };
}

/** "38.2 GB" — host-memory readouts. */
export function fmtGb(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * LM Studio saw traffic within the last two minutes. Paired with an idle
 * queue this means a direct caller (TheCortex embeddings) is on the box —
 * the state that used to read as "idle".
 */
export function lmStudioActive(lastActivityAt?: string | null) {
  if (!lastActivityAt) return false;
  const age = Date.now() - new Date(lastActivityAt).getTime();
  return age >= 0 && age < 2 * 60_000;
}



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
  const { activeItems, items, now: activityNow } = useBridgeActivity();
  // Deck-wide shared dispatch-state poller (see useDispatchState) — the crew
  // strip and task board read the same snapshot from one fetch loop.
  const { state, error: err, updatedAt } = useDispatchState();
  const [inspecting, setInspecting] = useState<ExecutorId | null>(null);

  // Count of board tasks in the Needs Attention lane (blocked / failed /
  // awaiting input). Raw dispatch failures that were retried and succeeded
  // don't land here, so this is the honest "act on this" number. The board
  // snapshot is the deck-wide shared poller; stream events nudge it.
  const { projects: boardProjects } = useBoardState();
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

  // Council chamber: poll the session store fast while a council sits,
  // lazily otherwise (mirrors the /council page cadence).
  const [benches, setBenches] = useState<CouncilBenchState | null>(null);
  const [councilUpdatedAt, setCouncilUpdatedAt] = useState(0);
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
        if (active) { setCouncilSessions(data.sessions); setCouncilUpdatedAt(Date.now()); }
      } catch {
        // Council telemetry is best-effort; the section hides itself.
      }
      try {
        const arb = await getCouncilArbiter();
        if (active) setArbiter(arb);
        const roster = await getCouncilBenches();
        if (active) setBenches(roster);
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
  const lmStudio = state?.lmStudio;
  const memory = state?.system?.memory;

  // A dispatch response can arrive after the activity provider's last tick.
  const now = Math.max(activityNow, Date.now());
  const { conversationId } = useCortex();
  const chat = useChatActivity(conversationId, now);
  const available = !err && updatedAt != null && now >= Date.parse(updatedAt) && now - Date.parse(updatedAt) < 45_000;
  const councilAvailable = councilUpdatedAt > 0 && now - councilUpdatedAt < 65_000;

  const councilToday = useMemo(() => {
    if (!councilSessions) return 0;
    const midnight = new Date().setHours(0, 0, 0, 0);
    return councilSessions.filter((s) => s.createdAt >= midnight).length;
  }, [councilSessions]);
  const lastCouncil = councilSessions?.[0] ?? null;

  const cliLane = useMemo(() => deriveCliLane(state ?? {}, now), [state, now]);

  // Headline for the status line when no council sits: the freshest active run.
  const activeRun = useMemo(() => {
    const active = (state?.executors?.runs ?? []).filter((r) => available && r.status === "active" && activeItems.some(item => item.taskId === r.taskId));
    return active.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
  }, [state, available, activeItems]);

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

  // Zero dispatches since midnight only signals a stalled pipeline once the
  // day's well underway — before dawn it's just an early idle fleet.
  const degraded = today?.total === 0 && !activeRun && isDayWellUnderway();

  return (
    <HudPanel
      icon={<Send size={16} />}
      title="OPS — DISPATCH"
      activity={available && activeItems.length > 0 || councilAvailable && !!liveCouncil ? "active" : "idle"}
      accent={degraded ? "amber" : "cyan"}
      className="dispatch-station flex h-full flex-col"
      headerRight={
        <>
          {(
            <span
              className={`w-[88px] truncate text-right text-[10px] tabular-nums ${degraded ? "font-semibold text-amber-400" : "text-slate-500"}`}
              title={`${today?.total ?? "Unknown"} dispatches since midnight${today && today.failed > 0 ? ` (${today.failed} failed)` : ""} — persistent count, survives Praxis restarts`}
            >
              {today?.total ?? "—"} today
            </span>
          )}
          <Link href="/ops" className={`flex items-center gap-1 text-[11px] ${degraded ? "text-amber-400 hover:text-amber-300" : "text-cyan-400 hover:text-cyan-300"}`}>
            console <ArrowUpRight size={12} />
          </Link>
        </>
      }
    >
        <div className="flex min-h-0 flex-1 flex-col">
          <DispatchMap
            view={cliLane}
            chat={chat}
            available={available}
            activeItems={activeItems}
            recentItems={items.filter(item => item.status !== "active" && item.channel !== "dispatch" && now - Date.parse(item.at) >= 0 && now - Date.parse(item.at) < 60_000)}
            councilAvailable={councilAvailable}
            bench={benches?.benches.find(b => b.name === (liveCouncil?.metadata?.preset ?? benches.defaultPreset)) ?? null}
            memory={memory}
            council={liveCouncil}
            local={{
              running: localRunning,
              queued: localQueued,
              paused: localPaused,
              // undefined = old Praxis payload without the field (say nothing);
              // null = probe ran and LM Studio is unreachable.
              resident: lmStudio ? (lmStudio.reachable ? (lmStudio.loadedCount ?? 0) : null) : undefined,
              directActive: localRunning === 0 && lmStudioActive(lmStudio?.lastActivityAt),
            }}
            arbiter={arbiter}
            onSetArbiter={handleSetArbiter}
            onInspect={setInspecting}
          />

          {/* Status ticker: the one thing moving through the system right now */}
          <div className="dispatch-status-line mt-1.5 flex items-center gap-2 border-t border-slate-800/60 pt-1.5 text-[10px] leading-4">
            {councilAvailable && liveCouncil ? (
              <Link href="/council" className="flex min-w-0 flex-1 items-center gap-2" title="Council in session — open the chamber">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-amber-200">
                  <Landmark size={10} className="shrink-0 text-amber-400" />
                  <span className="shrink-0 font-semibold uppercase tracking-wide text-amber-400">
                    {sessionKind(liveCouncil.metadata).label}
                  </span>
                  <span className="truncate">{liveCouncil.topic}</span>
                </span>
                <span className="max-w-[48%] truncate tabular-nums text-amber-300">
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
                <span className="max-w-[48%] truncate tabular-nums text-slate-500">
                  {activeRun.kind === "qa" ? "qa" : activeRun.kind === "agent" ? "agent" : "exec"} · {activeRun.phase}
                </span>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-slate-500">{!councilAvailable && liveCouncil ? "Council signal delayed" : available ? "crew standing by" : "Dispatch signal delayed"}</span>
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
          <div className="dispatch-upcoming mt-auto space-y-2.5 pt-2">
            {(
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
                  <Link href="/calendar" key={j.key} className="flex items-center gap-2 rounded text-[11px] hover:bg-slate-800/60">
                    <CalendarClock size={11} className="shrink-0 text-cyan-500/70" />
                    <span className="min-w-0 flex-1 truncate text-slate-300" title={j.description}>
                      {j.label}
                    </span>
                    <span className="max-w-[48%] truncate tabular-nums text-slate-500">{inFmt(j.nextRun!)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

      {inspecting && <ExecutorDetailModal executor={inspecting} onClose={() => setInspecting(null)} />}
    </HudPanel>
  );
}
