"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PauseCircle, PlayCircle, RefreshCw } from "lucide-react";
import { useLiveRefetch } from "@/components/live-board-state";
import { authFetch } from "@/lib/nexus/shared";
import { getLocalModelWork, type LocalLlmJob, type LocalModelWork } from "@/lib/nexus/local-llm";

function age(iso: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function label(job: LocalLlmJob) {
  const payload = job.payload ?? {};
  const item = payload.item && typeof payload.item === "object" ? payload.item as Record<string, unknown> : {};
  for (const candidate of [payload.title, item.title, payload.name, payload.source, payload.url, payload.caller, payload.prompt, payload.input]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return job.type.replace(/_/g, " ");
}

// Match LocalLlmQueueStore.compareRunnableJobs: lower priority first, then
// scheduledFor/createdAt and finally createdAt. Future jobs are a separate list.
function compareJobs(a: LocalLlmJob, b: LocalLlmJob) {
  return a.priority - b.priority || (a.scheduledFor ?? a.createdAt).localeCompare(b.scheduledFor ?? b.createdAt) || a.createdAt.localeCompare(b.createdAt);
}

export function OpsLocalQueue({ refreshKey = 0 }: { refreshKey?: number }) {
  const [work, setWork] = useState<LocalModelWork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [changingWorker, setChangingWorker] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // A slow probe must not be overtaken by a newer poll or create a backlog.
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    setRefreshing(true);
    try {
      const snapshot = await getLocalModelWork(controller.signal);
      if (!controller.signal.aborted) { setWork(snapshot); setError(null); }
    } catch {
      if (pending.current === controller) setError("Could not refresh local model work.");
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) { pending.current = null; setRefreshing(false); }
    }
  }, []);

  useLiveRefetch([], () => void refresh(), { fallbackPollMs: 5000, immediate: false });
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);

  const background = work?.background;
  const paused = Boolean(background?.worker?.paused);
  const toggleWorker = async () => {
    setChangingWorker(true);
    setActionError(null);
    try {
      const res = await authFetch(`/api/local-queue/${paused ? "resume" : "pause"}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "ops_console" }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not change the background worker.");
      // The action returns authoritative worker state. Invalidate any older
      // read so a racing poll cannot undo the confirmed action in the UI.
      if (typeof body.worker?.paused !== "boolean") throw new Error("Worker state unavailable after the action.");
      pending.current?.abort();
      pending.current = null;
      setWork(previous => previous ? { ...previous, background: { ...previous.background, worker: body.worker } } : previous);
      void refresh();
    } catch (cause) {
      setActionError(cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
        ? "Worker update timed out. Refresh to check its current state."
        : cause instanceof Error ? cause.message : "Could not change the background worker.");
    } finally { setChangingWorker(false); }
  };

  const jobs = background?.available ? background.jobs : [];
  const running = jobs.filter(job => job.status === "running");
  const queued = jobs.filter(job => job.status === "queued");
  const isFuture = (job: LocalLlmJob) => Boolean(job.scheduledFor && Date.parse(job.scheduledFor) > Date.now());
  const waiting = queued.filter(job => !isFuture(job)).sort(compareJobs);
  const scheduled = queued.filter(isFuture).sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "") || compareJobs(a, b));
  const models = work?.lmStudio.models ?? [];
  const queueKnown = work?.lmStudio.available && models.every(model => model.queued !== null);
  const waitingRequests = models.reduce((sum, model) => sum + (model.queued ?? 0), 0);
  const batch = work?.evidence?.batch;

  return (
    <section aria-label="Local LLM queue" className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold tracking-tight text-white">LOCAL LLM QUEUE</h3>
          {batch && <p className="mt-1 text-xs text-amber-300">{batch.waiting.length} sources waiting in research batch</p>}
          <p className="mt-1 text-xs text-slate-400">{queueKnown ? `${waitingRequests} request${waitingRequests === 1 ? "" : "s"} waiting for the model` : "Waiting count unavailable"}</p>
        </div>
        <button onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh local model queue" className="flex items-center gap-1.5 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50">
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} /> Refresh
        </button>
      </div>
      {error && <p role="status" className="mb-3 text-xs text-amber-300">{error} {work ? "Showing the last snapshot." : "Queue state unavailable."}</p>}
      {!work && !error && <p className="py-3 text-xs text-slate-400">Loading local model work…</p>}
      {work && <>
        <div className="mb-4">
          <h4 className="mb-2 text-xs font-semibold text-slate-300">Model requests · all callers</h4>
          {!work.lmStudio.available ? <p role="status" className="text-xs text-amber-300">{work.lmStudio.error}</p> : models.length === 0 ? <p className="text-xs text-slate-500">No models loaded in LM Studio.</p> : (
            <ul className="space-y-2">
              {models.map(model => <li key={model.id} data-model-id={model.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950/50 px-3 py-2">
                <div className="min-w-0"><div className="text-xs text-slate-200">{model.name}</div><div className="break-all font-mono text-[10px] text-slate-500">{model.id}</div></div>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className={model.status && model.status !== "idle" ? "text-cyan-300" : "text-slate-400"}>{model.status === "generating" ? "Generating" : model.status === "idle" ? "Idle" : model.status ? model.status.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ") : "Activity unavailable"}</span>
                  <span className={model.queued ? "text-amber-300" : "text-slate-400"}>{model.queued === null ? "Waiting count unavailable" : `${model.queued} waiting`}</span>
                </div>
              </li>)}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-slate-500">Includes requests submitted by Cortex, Praxis and other callers. LM Studio reports counts per model; individual request titles are unavailable.</p>
        </div>
        {work.evidence?.available === false && <p role="status" className="mb-4 text-xs text-amber-300">{work.evidence.error}</p>}
        {batch && <div className="mb-4 rounded border border-cyan-900/70 bg-cyan-950/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-cyan-200">{batch.name} · {batch.date}</h4>
            <span className="text-xs text-slate-300">{batch.attempted} of {batch.total} sources attempted · {batch.remaining} remaining</span>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">{batch.complete} complete · {batch.partial} partial · {batch.failed} failed</p>
          {batch.activity === "unconfirmed" && <p className="mt-2 text-xs text-amber-300">Live progress unconfirmed. Last checkpoint {age(batch.lastProgressAt)} ago.</p>}
          {batch.current.map(source => <div key={source.index} className="mt-3 text-xs">
            <p className="text-cyan-400">{batch.activity === "unconfirmed" ? "Last recorded source" : "Processing source"} {source.index} · {age(source.startedAt)}</p>
            <p className="mt-1 break-words text-slate-200">{source.title}</p>
            <p className="mt-1 text-[10px] text-slate-500">{source.source}</p>
          </div>)}
          {batch.activity === "between-sources" && <p className="mt-2 text-xs text-slate-400">Preparing the next source.</p>}
          <p className="mt-3 text-[11px] text-slate-400">This batch sends one source at a time. Remaining sources wait here before reaching the model queue.</p>
          {batch.waiting.length > 0 && <details className="mt-3">
            <summary className="cursor-pointer text-xs text-cyan-400">{batch.waiting.length} sources waiting · view work list</summary>
            <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-2">
              {batch.waiting.map(source => <li key={source.index} className="flex gap-2 border-t border-slate-800/60 pt-2 text-xs">
                <span className="w-8 shrink-0 text-slate-500">#{source.index}</span>
                <div className="min-w-0"><p className="break-words text-slate-300">{source.title}</p><p className="text-[10px] text-slate-500">{source.source}</p></div>
              </li>)}
            </ol>
          </details>}
        </div>}
        <div className="border-t border-slate-800 pt-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-slate-300">Background jobs {background?.available && <span className="font-normal text-slate-500">· {running.length} running · {waiting.length} waiting · {scheduled.length} scheduled</span>}</h4>
            <button data-worker-toggle onClick={() => void toggleWorker()} disabled={!background?.available || changingWorker || Boolean(error)} className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] disabled:opacity-40 ${paused ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300"}`}>
              {paused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}{paused ? "Resume background worker" : "Pause background worker"}
            </button>
          </div>
          {actionError && <p role="alert" className="mb-2 text-xs text-amber-300">{actionError}</p>}
          {paused && <p className="mb-2 text-xs text-amber-300">Worker paused{background?.worker?.pauseReason ? `: ${background.worker.pauseReason}` : ""}. Waiting jobs will remain queued.</p>}
          {!background?.available ? <p role="status" className="text-xs text-amber-300">{background?.error}</p> : running.length + waiting.length + scheduled.length === 0 ? <p className="py-3 text-xs text-slate-500">No background jobs waiting or running.</p> : (
            <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
              {[["Running", running], ["Waiting", waiting], ["Scheduled", scheduled]].map(([heading, group]) => {
                const rows = group as LocalLlmJob[];
                if (!rows.length) return null;
                return <div key={String(heading)}><h5 className="mb-1 text-[11px] font-semibold text-slate-400">{String(heading)}</h5><ol className="space-y-1">
                  {rows.map((job, index) => <li key={job.id} data-job-id={job.id} className="rounded border border-slate-800/60 bg-slate-950/40 px-3 py-2">
                    <div className="flex items-start gap-2"><span className="w-6 shrink-0 text-[11px] text-slate-500">{heading === "Waiting" ? `#${index + 1}` : "•"}</span><div className="min-w-0 flex-1">
                      <p className="break-words text-xs text-slate-200">{label(job)}</p>
                      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500"><span>{job.type.replace(/_/g, " ")}</span><span>Priority {job.priority}</span><span>{heading === "Running" ? `Running ${age(job.startedAt ?? job.updatedAt)}` : heading === "Scheduled" ? `Starts ${new Date(job.scheduledFor!).toLocaleString()}` : `Queued ${age(job.createdAt)}`}</span><span>Attempt {job.attempts}/{job.maxAttempts}</span>{job.executionLane === "spillover" && <span>CLI spillover</span>}</p>
                      <span title={job.id} className="font-mono text-[9px] text-slate-600">{job.id}</span>
                    </div></div>
                  </li>)}
                </ol></div>;
              })}
            </div>
          )}
          <p className="mt-3 text-[11px] text-slate-500">Background jobs submit model requests as they run. Pausing this worker leaves direct callers running. <Link href="/local-queue" className="text-cyan-400 hover:underline">Manage jobs →</Link></p>
        </div>
        <p className="mt-3 text-[10px] text-slate-600">Updated {new Date(work.observedAt).toLocaleTimeString()} · refreshes every 5s</p>
      </>}
    </section>
  );
}
