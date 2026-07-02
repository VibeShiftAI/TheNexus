/**
 * ExecutorDetailModal — drill-down popup for a crew member / dispatch lane.
 * Fetches a fresh dispatch-state snapshot on open and shows the runs, queue
 * and worker state for one executor (or the local LLM queue). Opened from
 * the DispatchStation lanes and the crew chips on the main viewer.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Send } from "lucide-react";
import { HudModal, HudStat } from "@/components/bridge/hud";
import type { DispatchStateResponse, ExecutorRun } from "@/components/bridge/dispatch-station";

export type ExecutorId = "antigravity" | "codex" | "claude-code" | "local-llm";

const LABELS: Record<ExecutorId, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  "claude-code": "Claude Code",
  "local-llm": "Local LLM",
};

function fmtWhen(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function runDuration(run: ExecutorRun) {
  const start = new Date(run.startedAt).getTime();
  const end = run.status === "active" ? Date.now() : new Date(run.updatedAt).getTime();
  const mins = Math.max(0, Math.round((end - start) / 60_000));
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const RUN_TONE: Record<ExecutorRun["status"], string> = {
  active: "border-cyan-500/40 bg-cyan-500/5",
  completed: "border-emerald-500/30 bg-emerald-500/5",
  failed: "border-red-500/40 bg-red-500/5",
};

export function ExecutorDetailModal({ executor, onClose }: { executor: ExecutorId; onClose: () => void }) {
  const [state, setState] = useState<DispatchStateResponse | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/praxis/dispatch-state", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (active) setState(data);
      })
      .catch(() => {
        if (active) setErr(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const runs = (state?.executors?.runs ?? []).filter((r) => r.executor === executor);
  const activeRuns = runs.filter((r) => r.status === "active");
  const recentRuns = runs.filter((r) => r.status !== "active").slice(0, 6);

  return (
    <HudModal
      title={LABELS[executor]}
      subtitle="dispatch telemetry"
      icon={<Send size={15} />}
      accent="cyan"
      onClose={onClose}
    >
      {err ? (
        <p className="py-6 text-center text-xs text-slate-500">Dispatch telemetry unavailable.</p>
      ) : !state ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-500">
          <Loader2 size={14} className="animate-spin text-cyan-400" /> Pulling telemetry…
        </div>
      ) : executor === "local-llm" ? (
        <LocalLlmDetail state={state} />
      ) : (
        <div className="space-y-4">
          {executor === "antigravity" && (
            <div className="grid grid-cols-3 gap-2">
              <HudStat
                label="bridge"
                value={state.antigravity?.bridge ? "online" : "offline"}
                tone={state.antigravity?.bridge ? "text-emerald-300" : "text-red-300"}
              />
              <HudStat label="active" value={state.antigravity?.active ?? 0} />
              <HudStat label="queued" value={state.antigravity?.pending ?? 0} />
            </div>
          )}

          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Active runs
            </h4>
            {activeRuns.length === 0 ? (
              <p className="rounded-md border border-dashed border-slate-800 px-3 py-2.5 text-xs text-slate-500">
                Lane is idle — no active run.
              </p>
            ) : (
              <div className="space-y-2">
                {activeRuns.map((r) => (
                  <RunRow key={r.taskId} run={r} />
                ))}
              </div>
            )}
          </section>

          {recentRuns.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Recent runs
              </h4>
              <div className="space-y-2">
                {recentRuns.map((r) => (
                  <RunRow key={`${r.taskId}-${r.updatedAt}`} run={r} />
                ))}
              </div>
            </section>
          )}

          {executor === "antigravity" && (state.antigravity?.queue?.length ?? 0) > 0 && (
            <section>
              <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Queue
              </h4>
              <div className="space-y-1">
                {state.antigravity!.queue!.slice(0, 8).map((q) => (
                  <div
                    key={q.id}
                    className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/50 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="min-w-0 flex-1 truncate text-slate-300">{q.title}</span>
                    <span className="shrink-0 text-[10px] uppercase text-slate-500">{q.status}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-slate-600">{fmtWhen(q.updatedAt)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <Link
            href="/ops"
            className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
          >
            open full ops console <ArrowUpRight size={12} />
          </Link>
        </div>
      )}
    </HudModal>
  );
}

function RunRow({ run }: { run: ExecutorRun }) {
  return (
    <div className={`rounded-md border px-2.5 py-2 ${RUN_TONE[run.status]}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-slate-200" title={run.title}>
          {run.title}
        </span>
        <span
          className={`shrink-0 text-[10px] font-semibold uppercase ${
            run.status === "active" ? "text-cyan-300" : run.status === "failed" ? "text-red-300" : "text-emerald-300"
          }`}
        >
          {run.status === "active" ? run.phase : run.status}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
        <span className="uppercase">{run.kind}</span>
        <span>started {fmtWhen(run.startedAt)}</span>
        <span>{runDuration(run)}</span>
        {run.workspace ? <span className="truncate font-mono">{run.workspace}</span> : null}
      </div>
      {run.summary ? <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">{run.summary}</p> : null}
    </div>
  );
}

function LocalLlmDetail({ state }: { state: DispatchStateResponse }) {
  const worker = state.localLlm?.worker;
  const counts = state.localLlm?.counts ?? {};
  const jobs = state.localLlm?.jobs ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <HudStat
          label="worker"
          value={worker?.paused ? "paused" : "running"}
          tone={worker?.paused ? "text-amber-300" : "text-emerald-300"}
        />
        <HudStat label="running" value={counts["running"] ?? 0} tone="text-cyan-300" />
        <HudStat label="queued" value={counts["queued"] ?? 0} />
      </div>
      {worker?.paused && worker.pauseReason ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Paused: {worker.pauseReason}
        </p>
      ) : null}
      <section>
        <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Jobs</h4>
        {jobs.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-800 px-3 py-2.5 text-xs text-slate-500">
            Queue is quiet.
          </p>
        ) : (
          <div className="space-y-1">
            {jobs.slice(0, 10).map((j, i) => (
              <div
                key={j.id ?? i}
                className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/50 px-2.5 py-1.5 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate text-slate-300">{j.type ?? "job"}</span>
                <span
                  className={`shrink-0 text-[10px] uppercase ${
                    j.status === "running" ? "text-cyan-300" : j.status === "failed" ? "text-red-300" : "text-slate-500"
                  }`}
                >
                  {j.status}
                </span>
                {j.attempts != null && (
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-600">
                    try {j.attempts}/{j.maxAttempts ?? "—"}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <Link href="/ops" className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300">
        open full ops console <ArrowUpRight size={12} />
      </Link>
    </div>
  );
}
