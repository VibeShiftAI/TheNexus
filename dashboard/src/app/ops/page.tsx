/**
 * Ops console — the dispatch drill-in behind the bridge's Ops station.
 * Live executor lanes, executor runs, CLI conversation sessions, scheduled
 * jobs, and local LLM queue controls.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Send, RefreshCw, PauseCircle, PlayCircle, Clock, AlertTriangle, MessageSquare, Terminal } from "lucide-react";
import {
  DispatchStation,
  type DispatchStateResponse,
  type ExecutorRun,
  type CronJob,
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

/** Compact duration since an instant ("23m", "4h", "2d") — session age. */
function ageSince(iso?: string) {
  if (!iso) return "—";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function executorChip(name: string) {
  const map: Record<string, string> = {
    antigravity: "border-violet-500/40 bg-violet-500/10 text-violet-300",
    codex: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    "claude-code": "border-orange-500/40 bg-orange-500/10 text-orange-300",
  };
  return map[name] ?? "border-slate-600 bg-slate-800/60 text-slate-300";
}

/** Relative time for a FUTURE instant (next scheduled run). */
function relFuture(iso?: string | null) {
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "due";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/** Colour + label for a cron category chip. */
function cronCategoryChip(category: CronJob["category"]) {
  const map: Record<CronJob["category"], string> = {
    system: "border-slate-600 bg-slate-800/60 text-slate-300",
    morning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    market: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    ingestion: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
    content: "border-violet-500/40 bg-violet-500/10 text-violet-300",
    lars: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300",
  };
  return map[category] ?? "border-slate-600 bg-slate-800/60 text-slate-300";
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
  const [togglingCron, setTogglingCron] = useState<string | null>(null);

  const toggleCronJob = async (key: string, paused: boolean, label: string) => {
    const action = paused ? "resume" : "pause";
    setTogglingCron(key);
    try {
      const res = await fetch(`/api/praxis/cron/${encodeURIComponent(key)}/${action}`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      setActionMsg(
        res.ok
          ? `${label} ${action === "pause" ? "paused" : "resumed"}.`
          : `${action} failed: ${data.error ?? res.status}`,
      );
      load();
    } catch {
      setActionMsg(`${action} failed — Praxis unreachable.`);
    } finally {
      setTogglingCron(null);
    }
  };

  // Registry runs plus SSE-synthesized rows: a run that's live on the event
  // stream still shows here even if the running Praxis predates the registry.
  const registryRuns = state?.executors?.runs ?? [];
  const runs = [
    ...registryRuns,
    ...sseRuns.filter((s) => !registryRuns.some((r) => r.taskId === s.taskId)),
  ];
  const localJobs = state?.localLlm?.jobs ?? [];
  const localCounts = state?.localLlm?.counts ?? {};
  const localPaused = Boolean(state?.localLlm?.worker?.paused);
  const activeCount = (localCounts["running"] ?? 0) + (localCounts["queued"] ?? 0);

  // Executor Runs rows: live work first, then everything else newest-first.
  const runRows: ExecutorRun[] = [...runs];
  const runRank = (r: ExecutorRun) => (r.status === "active" ? 0 : 1);
  runRows.sort(
    (a, b) => runRank(a) - runRank(b) || (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
  const activeRuns = runRows.filter((r) => r.status === "active").length;

  // CLI conversations: per-task sessions (open ones are resumable) and the
  // permanent chat sessions per backend.
  const openSessions = (state?.executors?.sessions ?? []).filter((s) => s.status === "open");
  const chatSessions = Object.entries(state?.chatSessions ?? {});

  // Scheduled jobs (cron) — the registry list from Praxis.
  const cronJobs = state?.cron ?? [];
  const cronPausedCount = cronJobs.filter((c) => c.paused).length;

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

        {/* Live executor lanes */}
        <DispatchStation />

        {/* Executor runs — all executors (Antigravity, Codex, Claude Code) + agent runs */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-3 text-sm font-bold tracking-tight text-white">
            EXECUTOR RUNS{" "}
            <span className="ml-1 text-xs font-normal text-slate-500">
              ({activeRuns} active · all executors · survives restarts)
            </span>
          </h3>
          {runRows.length === 0 ? (
            <div className="py-4 text-center text-xs text-slate-500">
              No dispatch or agent runs on record yet.
            </div>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
              {runRows.map((r) => (
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

        {/* CLI sessions — resumable per-task conversations (session registry)
            and the permanent chat session per backend. */}
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] items-start">
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-tight text-white">
              <Terminal size={14} className="text-cyan-400" />
              CLI TASK SESSIONS{" "}
              <span className="text-xs font-normal text-slate-500">
                ({openSessions.length} open · resumable conversations)
              </span>
            </h3>
            {openSessions.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-500">
                No open CLI task sessions — every dispatched conversation is closed.
              </div>
            ) : (
              <div className="max-h-60 space-y-1 overflow-y-auto pr-1">
                {openSessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="flex items-center gap-3 rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2"
                  >
                    <span className={`w-24 shrink-0 rounded border px-1.5 py-0.5 text-center text-[10px] uppercase ${executorChip(s.executor)}`}>
                      {s.executor}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={`${s.title ?? s.taskId} — session ${s.sessionId}`}>
                      {s.title ?? s.taskId}
                    </span>
                    {s.resumeCount > 0 && (
                      <span
                        className="shrink-0 rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-300"
                        title={`Resumed ${s.resumeCount} time${s.resumeCount === 1 ? "" : "s"} (corrections / follow-ups)`}
                      >
                        ↻ {s.resumeCount}
                      </span>
                    )}
                    {s.workspace && (
                      <span className="shrink-0 font-mono text-[10px] text-slate-600" title={s.workspace}>
                        {s.workspace.split("/").filter(Boolean).pop()}
                      </span>
                    )}
                    <span
                      className="w-16 shrink-0 text-right text-[10px] text-slate-500"
                      title={`opened ${relTime(s.openedAt)} · last used ${relTime(s.lastUsedAt)}`}
                    >
                      open {ageSince(s.openedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-tight text-white">
              <MessageSquare size={14} className="text-cyan-400" />
              STANDING CHAT
            </h3>
            {chatSessions.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-500">No standing chat session yet.</div>
            ) : (
              <div className="space-y-2">
                {chatSessions.map(([backend, cs]) => (
                  <div key={backend} className="rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2">
                    <div className="flex items-center gap-3">
                      <span className={`w-24 shrink-0 rounded border px-1.5 py-0.5 text-center text-[10px] uppercase ${executorChip(backend)}`}>
                        {backend}
                      </span>
                      <span className="flex-1 text-xs tabular-nums text-slate-300">
                        {cs.turns} turn{cs.turns === 1 ? "" : "s"}
                      </span>
                      {cs.pendingSeed && (
                        <span
                          className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-300"
                          title="A compaction seed will be replayed on the next turn"
                        >
                          seed pending
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-slate-500">{relTime(cs.lastActivityAt)}</span>
                    </div>
                    {cs.sessionId && (
                      <div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={cs.sessionId}>
                        {cs.sessionId}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Scheduled jobs — every cron in the system, viewable at once, each
            pausable/resumable (durably — survives restarts). */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-tight text-white">
            <Clock size={14} className="text-cyan-400" />
            SCHEDULED JOBS{" "}
            <span className="text-xs font-normal text-slate-500">
              ({cronJobs.length} job{cronJobs.length === 1 ? "" : "s"}
              {cronPausedCount > 0 ? <span className="text-amber-400"> · {cronPausedCount} paused</span> : null})
            </span>
          </h3>
          {cronJobs.length === 0 ? (
            <div className="py-4 text-center text-xs text-slate-500">
              No scheduled jobs registered — is Praxis running?
            </div>
          ) : (
            <div className="grid gap-1.5 md:grid-cols-2">
              {cronJobs.map((c) => (
                <div
                  key={c.key}
                  className={`flex items-center gap-3 rounded border px-3 py-2 ${
                    c.paused ? "border-amber-500/30 bg-amber-500/5" : "border-slate-800/60 bg-slate-950/40"
                  }`}
                >
                  <span className={`w-20 shrink-0 rounded border px-1.5 py-0.5 text-center text-[10px] uppercase ${cronCategoryChip(c.category)}`}>
                    {c.category}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`truncate text-xs ${c.paused ? "text-slate-400" : "text-slate-200"}`} title={c.description}>
                        {c.label}
                      </span>
                      {c.lastError && (
                        <AlertTriangle size={11} className="shrink-0 text-red-400" aria-label="last run errored" />
                      )}
                    </div>
                    <div className="truncate text-[10px] text-slate-500">
                      {c.cadence}
                      {!c.paused && c.nextRun ? ` · next ${relFuture(c.nextRun)}` : ""}
                    </div>
                  </div>
                  {c.paused && (
                    <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-300">
                      paused
                    </span>
                  )}
                  <button
                    onClick={() => toggleCronJob(c.key, c.paused, c.label)}
                    disabled={togglingCron === c.key}
                    className={`flex w-[68px] shrink-0 items-center justify-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-all disabled:opacity-50 ${
                      c.paused
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                    }`}
                    title={c.paused ? "Resume this job" : "Pause this job"}
                  >
                    {c.paused ? <PlayCircle size={11} /> : <PauseCircle size={11} />}
                    {c.paused ? "resume" : "pause"}
                  </button>
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
    </main>
  );
}
