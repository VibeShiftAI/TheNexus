/**
 * Ops console — the dispatch drill-in behind the bridge's Ops station.
 * Live executor lanes, executor runs, CLI conversation sessions, scheduled
 * jobs, and local LLM queue controls.
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Send, RefreshCw, PauseCircle, PlayCircle, Clock, AlertTriangle, MessageSquare, Terminal, Landmark } from "lucide-react";
import {
  effectiveReferenceVoices,
  getCouncilSessions,
  isLiveSession,
  isProblemCouncil,
  sessionKind,
  type CouncilSessionSummary,
} from "@/lib/council";
import {
  DispatchStation,
  type DispatchStateResponse,
  type ExecutorRun,
  type CronJob,
} from "@/components/bridge/dispatch-station";
import { useLiveRefetch } from "@/components/live-board-state";
import { useCrewActivity } from "@/hooks/use-crew-activity";
import { AutonomyControl, useAutonomyControl } from "@/components/autonomy-control";
import { OpsLocalQueue } from "@/components/ops-local-queue";

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
  const [queueRefreshKey, setQueueRefreshKey] = useState(0);
  // Council sessions (deliberations) — clickable into the Chamber transcript.
  const [councilSessions, setCouncilSessions] = useState<CouncilSessionSummary[]>([]);

  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const autonomyControl = useAutonomyControl(setActionMsg);
  const refreshAutonomy = autonomyControl.refresh;

  const load = useCallback(async () => {
    setRefreshing(true);
    setQueueRefreshKey(key => key + 1);
    const autonomyRefresh = refreshAutonomy();
    try {
      const res = await fetch("/api/praxis/dispatch-state", { cache: "no-store" });
      if (!res.ok) throw new Error(`dispatch-state ${res.status}`);
      setState(await res.json());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Dispatch telemetry unavailable");
    }
    // Best-effort: a dark council store never blanks the dispatch console.
    try {
      const council = await getCouncilSessions(8);
      setCouncilSessions(council.sessions);
    } catch {
      /* keep the last list */
    }
    await autonomyRefresh;
    setRefreshing(false);
  }, [refreshAutonomy]);

  // P3-30 phase 2: the Ops console reacts to live frames instead of a fixed
  // 10s loop against the rate-limited API. `dispatch` + `system` + `activity`
  // cover executor lanes and the council list. The fallback also catches
  // CLI slot health changes without a frame. The local-model panel has its
  // own five-second poll, since direct model requests do not emit frames.
  useLiveRefetch(["dispatch", "system", "activity"], load, { fallbackPollMs: 30_000 });

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
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-6 py-3">
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
        <div className="container mx-auto px-6 pb-3">
          <AutonomyControl {...autonomyControl} />
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
                  <Link
                    key={s.sessionId}
                    href={`/task/${s.taskId}`}
                    title={`Open the task's dispatch console — every attempt's prompt, output and CLI session (session ${s.sessionId})`}
                    className="flex items-center gap-3 rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2 transition-colors hover:border-cyan-500/40 hover:bg-slate-900/70"
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
                  </Link>
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

        {/* Council sessions — deliberations (morning councils, summoned panels,
            problem councils); each row opens the full transcript in the Chamber. */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-tight text-white">
            <Landmark size={14} className="text-amber-400" />
            COUNCIL SESSIONS{" "}
            <span className="text-xs font-normal text-slate-500">(click a session to read its transcript)</span>
            <Link href="/council" className="ml-auto text-[11px] font-normal text-amber-300 hover:text-amber-200">
              open the Chamber →
            </Link>
          </h3>
          {councilSessions.length === 0 ? (
            <div className="py-4 text-center text-xs text-slate-500">No council sessions recorded yet.</div>
          ) : (
            <div className="max-h-60 space-y-1 overflow-y-auto pr-1">
              {councilSessions.map((cs) => {
                const kind = sessionKind(cs.metadata);
                const live = isLiveSession(cs);
                // Reference seats only (no aggregator, no round-2 twins); for a
                // problem council "reported" = seats whose latest round landed,
                // not the raw thesis count (which spans both rounds + aggregator).
                const refs = effectiveReferenceVoices(cs.voices);
                const reported = isProblemCouncil(cs.metadata)
                  ? refs.filter((v) => v.status === "success").length
                  : cs.stats.successCount;
                return (
                  <Link
                    key={cs.sessionId}
                    href={`/council?session=${encodeURIComponent(cs.sessionId)}`}
                    title={`Read the transcript — session ${cs.sessionId}`}
                    className="flex items-center gap-3 rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2 transition-colors hover:border-amber-500/40 hover:bg-slate-900/70"
                  >
                    <span className="w-28 shrink-0 truncate rounded border border-slate-700 px-1.5 py-0.5 text-center text-[10px] uppercase text-slate-300" title={kind.label}>
                      {kind.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{cs.topic}</span>
                    <span className="shrink-0 text-[10px] text-slate-500">{reported}/{refs.length || cs.stats.voiceCount} seats</span>
                    <span className={`w-20 shrink-0 text-right text-[10px] uppercase tracking-wider ${live ? "text-amber-300" : "text-slate-500"}`}>
                      {live ? "in session" : cs.phase}
                    </span>
                    <span className="w-16 shrink-0 text-right text-[10px] text-slate-500">{relTime(new Date(cs.createdAt).toISOString())}</span>
                  </Link>
                );
              })}
            </div>
          )}
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

        <OpsLocalQueue refreshKey={queueRefreshKey} />
      </div>
    </main>
  );
}
