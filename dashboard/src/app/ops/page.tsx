/**
 * Ops console — the dispatch drill-in behind the bridge's Ops station.
 * Live executor lanes, Antigravity bridge health, the task queue, the
 * session dispatch log, and local LLM queue controls.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Send, RefreshCw, PauseCircle, PlayCircle, RotateCcw, ShieldCheck } from "lucide-react";
import {
  DispatchStation,
  type DispatchStateResponse,
  type DispatchHistoryRow,
} from "@/components/bridge/dispatch-station";
import { useCrewActivity } from "@/hooks/use-crew-activity";

function relTime(iso?: string) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function executorChip(name: string) {
  const map: Record<string, string> = {
    antigravity: "border-violet-500/40 bg-violet-500/10 text-violet-300",
    codex: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    "claude-code": "border-orange-500/40 bg-orange-500/10 text-orange-300",
  };
  return map[name] ?? "border-slate-600 bg-slate-800/60 text-slate-300";
}

/** llm_calls history rows: dispatch.<executor> carries the task title in
 * `model`; agent-dispatch.<label> carries the run detail there, so the
 * label itself is the useful title. */
function historyEntry(row: DispatchHistoryRow): { executor: string; title: string } {
  if (row.caller.startsWith("agent-dispatch.")) {
    return { executor: row.provider, title: `Agent: ${row.caller.slice("agent-dispatch.".length)}` };
  }
  return { executor: row.provider, title: row.model };
}

function statusChip(status: string) {
  const map: Record<string, string> = {
    "in-progress": "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
    running: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
    active: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
    pending: "border-slate-600 bg-slate-800/60 text-slate-300",
    queued: "border-slate-600 bg-slate-800/60 text-slate-300",
    dispatched: "border-violet-500/40 bg-violet-500/10 text-violet-300",
    scheduled: "border-violet-500/40 bg-violet-500/10 text-violet-300",
    done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    succeeded: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    completed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    failed: "border-red-500/40 bg-red-500/10 text-red-300",
    cancelled: "border-slate-600 bg-slate-800/60 text-slate-500",
    paused: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  };
  return map[status] ?? "border-slate-600 bg-slate-800/60 text-slate-400";
}

/** A row in the unified dispatch log. `liveStatus` marks an item still in the
 * Antigravity queue (rendered as a status pill); otherwise it's a completed
 * history entry (rendered as a success/fail dot). Only queue-sourced rows carry
 * an `id`, so only they can be retried. */
interface DispatchRow {
  key: string;
  id?: string;
  executor: string;
  title: string;
  ts?: string;
  liveStatus?: string;
  ok?: boolean;
  error?: string | null;
  retryable: boolean;
}

export default function OpsConsolePage() {
  const router = useRouter();
  const { sseRuns } = useCrewActivity();
  const [state, setState] = useState<DispatchStateResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/praxis/dispatch-state", { cache: "no-store" });
      if (!res.ok) throw new Error(`dispatch-state ${res.status}`);
      setState(await res.json());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Dispatch telemetry unavailable");
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const toggleLocalQueue = async () => {
    const action = localPaused ? "resume" : "pause";
    try {
      await fetch(`/api/local-queue/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "ops_console" }),
      });
      load();
    } catch {
      /* surface on next poll */
    }
  };

  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const retryTask = async (id: string) => {
    setRetryingId(id);
    try {
      const res = await fetch("/api/praxis/dispatch/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      setActionMsg(res.ok ? `Task ${id.slice(0, 8)} re-queued — the sweep will re-dispatch it.` : `Retry failed: ${data.error ?? res.status}`);
      load();
    } catch {
      setActionMsg("Retry failed — Praxis unreachable.");
    } finally {
      setRetryingId(null);
    }
  };

  const reapplyAutoApprove = async () => {
    try {
      const res = await fetch("/api/praxis/dispatch/auto-approve", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      setActionMsg(res.ok ? "Auto-approve settings re-applied to Antigravity." : `Auto-approve failed: ${data.error ?? res.status}`);
    } catch {
      setActionMsg("Auto-approve failed — Praxis unreachable.");
    }
  };

  const bridge = state?.antigravity?.bridge as
    | { status?: string; version?: string; queueDir?: string; activeTasks?: number; extension?: string }
    | null
    | undefined;
  const queue = state?.antigravity?.queue ?? [];
  // Registry runs plus SSE-synthesized rows: a run that's live on the event
  // stream still shows here even if the running Praxis predates the registry.
  const registryRuns = state?.executors?.runs ?? [];
  const runs = [
    ...registryRuns,
    ...sseRuns.filter((s) => !registryRuns.some((r) => r.taskId === s.taskId)),
  ];
  const history = state?.executors?.history ?? [];
  const today = state?.executors?.dispatchedToday;
  const localJobs = state?.localLlm?.jobs ?? [];
  const localCounts = state?.localLlm?.counts ?? {};
  const localPaused = Boolean(state?.localLlm?.worker?.paused);
  const activeCount = (localCounts["running"] ?? 0) + (localCounts["queued"] ?? 0);

  // Unified dispatch log: the live Antigravity queue (actionable — failed
  // items keep the retry button, since only these rows carry a task id) merged
  // with the persistent all-executor history from llm_calls. Live queue items
  // lead; history follows, minus any Antigravity row a live queue item already
  // represents so a dispatch isn't listed twice.
  const queueTitles = new Set(queue.map((t) => t.title));
  const dispatchRows: DispatchRow[] = [
    ...queue.map((t) => ({
      key: `q-${t.id}`,
      id: t.id,
      executor: "antigravity",
      title: t.title,
      ts: t.updatedAt,
      liveStatus: t.status,
      retryable: t.status === "failed",
    })),
    ...history
      .map((row, i) => {
        const entry = historyEntry(row);
        return {
          key: `h-${row.ts}-${i}`,
          executor: entry.executor,
          title: entry.title,
          ts: row.ts,
          ok: Boolean(row.success),
          error: row.error ?? null,
          retryable: false,
        };
      })
      .filter((r) => !(r.executor === "antigravity" && queueTitles.has(r.title))),
  ];

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30 pb-12">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
        <div className="container mx-auto flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft size={18} />
              <span className="text-sm">Bridge</span>
            </button>
            <div className="h-6 w-px bg-slate-700" />
            <div className="flex items-center gap-2">
              <Send size={16} className="text-cyan-400" />
              <h1 className="text-xl font-bold tracking-tight text-white">OPS — DISPATCH CONSOLE</h1>
            </div>
          </div>
          <button
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-1.5 text-xs text-slate-400 hover:text-white transition-all"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> refresh
          </button>
        </div>
      </header>

      <div className="container mx-auto space-y-6 p-6">
        {err && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-xs text-red-300">{err}</div>
        )}
        {actionMsg && (
          <div className="flex items-center justify-between rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-3 text-xs text-cyan-200">
            <span>{actionMsg}</span>
            <button onClick={() => setActionMsg(null)} className="text-cyan-400 hover:text-white">✕</button>
          </div>
        )}

        {/* Live lanes + bridge health */}
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] items-start">
          <DispatchStation />
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="mb-3 text-sm font-bold tracking-tight text-white">ANTIGRAVITY BRIDGE :54321</h3>
            {bridge ? (
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">status</span>
                  <span className="text-emerald-400">{bridge.status ?? "ok"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">bridge</span>
                  <span className="text-slate-300 font-mono">
                    {bridge.extension ?? "praxis-antigravity-remote-bridge"} v{bridge.version ?? "?"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">active tasks</span>
                  <span className="tabular-nums text-slate-300">{bridge.activeTasks ?? 0}</span>
                </div>
                {bridge.queueDir && (
                  <div className="flex justify-between gap-4">
                    <span className="shrink-0 text-slate-500">queue dir</span>
                    <span className="truncate font-mono text-slate-400" title={bridge.queueDir}>
                      {bridge.queueDir}
                    </span>
                  </div>
                )}
                <button
                  onClick={reapplyAutoApprove}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-300 hover:bg-emerald-500/20"
                  title="Merge full-autonomy keys into Antigravity settings.json"
                >
                  <ShieldCheck size={12} /> re-apply auto-approve
                </button>
              </div>
            ) : (
              <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                Bridge unreachable — Antigravity dispatch is down.
              </div>
            )}
          </div>
        </div>

        {/* Executor runs — all executors (Antigravity, Codex, Claude Code) + agent runs */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-3 text-sm font-bold tracking-tight text-white">
            EXECUTOR RUNS{" "}
            <span className="ml-1 text-xs font-normal text-slate-500">
              ({runs.filter((r) => r.status === "active").length} active · all executors)
            </span>
          </h3>
          {runs.length === 0 ? (
            <div className="py-4 text-center text-xs text-slate-500">
              No live runs since the last Praxis restart — the dispatch log below is the persistent record.
            </div>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
              {runs.map((r) => (
                <div
                  key={r.taskId}
                  className="flex items-center gap-3 rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2"
                >
                  <span className={`w-24 shrink-0 rounded border px-1.5 py-0.5 text-center text-[10px] uppercase ${executorChip(r.executor)}`}>
                    {r.executor}
                  </span>
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusChip(r.status === "active" ? "active" : r.status)}`}>
                    {r.status === "active" ? r.phase : r.status}
                  </span>
                  {r.kind !== "task" && (
                    <span className="shrink-0 rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                      {r.kind}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={r.summary ?? r.title}>
                    {r.title}
                  </span>
                  {r.workspace && (
                    <span className="shrink-0 font-mono text-[10px] text-slate-600" title={r.workspace}>
                      {r.workspace.split("/").filter(Boolean).pop()}
                    </span>
                  )}
                  <span className="w-16 shrink-0 text-right text-[10px] text-slate-500">{relTime(r.updatedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2 items-start">
          {/* Dispatch log — the live Antigravity queue (with retry) merged with
              the persistent all-executor history from llm_calls. */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="mb-3 text-sm font-bold tracking-tight text-white">
              DISPATCH LOG{" "}
              <span className="ml-1 text-xs font-normal text-slate-500">
                ({today ? (
                  <>
                    {today.total} today
                    {today.failed > 0 && <span className="text-red-400"> · {today.failed} failed</span>}
                    {" · "}
                  </>
                ) : null}
                {queue.length > 0 ? `${queue.length} queued · ` : ""}
                all executors · survives restarts)
              </span>
            </h3>
            {dispatchRows.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-500">No dispatches recorded.</div>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {dispatchRows.map((r) => (
                  <div
                    key={r.key}
                    className="flex items-center gap-3 rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2"
                  >
                    <span className={`w-24 shrink-0 rounded border px-1.5 py-0.5 text-center text-[10px] uppercase ${executorChip(r.executor)}`}>
                      {r.executor}
                    </span>
                    {r.liveStatus ? (
                      <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusChip(r.liveStatus)}`}>
                        {r.liveStatus}
                      </span>
                    ) : (
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.ok ? "bg-emerald-400" : "bg-red-400"}`}
                        title={r.ok ? "dispatched" : r.error ?? "dispatch failed"}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={r.error ?? r.title}>
                      {r.title}
                    </span>
                    {r.retryable && r.id && (
                      <button
                        onClick={() => retryTask(r.id!)}
                        disabled={retryingId === r.id}
                        className="flex shrink-0 items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
                        title="Re-queue for dispatch"
                      >
                        <RotateCcw size={10} className={retryingId === r.id ? "animate-spin" : ""} /> retry
                      </button>
                    )}
                    <span className="w-16 shrink-0 text-right text-[10px] text-slate-500">{relTime(r.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Local LLM queue */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold tracking-tight text-white">
                LOCAL LLM QUEUE{" "}
                <span className="ml-1 text-xs font-normal text-slate-500">
                  ({activeCount} active
                  {localCounts["failed"] ? ` · ${localCounts["failed"]} failed` : ""}
                  {localCounts["succeeded"] ? ` · ${localCounts["succeeded"]} done` : ""})
                </span>
              </h3>
              <button
                onClick={toggleLocalQueue}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-all ${
                  localPaused
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                }`}
              >
                {localPaused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
                {localPaused ? "resume worker" : "pause worker"}
              </button>
            </div>
            {localJobs.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-500">No active jobs in local queue.</div>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {localJobs.map((j, i) => (
                  <div
                    key={j.id ?? i}
                    className="flex items-center gap-3 rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2"
                  >
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusChip(j.status ?? "")}`}>
                      {j.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={j.type}>
                      {j.type}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-600">
                      try {j.attempts ?? 0}/{j.maxAttempts ?? 0}
                    </span>
                    <span className="w-16 shrink-0 text-right text-[10px] text-slate-500">{relTime(j.updatedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
