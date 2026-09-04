/**
 * CliLanePanel — the Dispatch Station's CLI lane block.
 *
 * Answers "why is my task not running" without a chat turn: which executor
 * holds each CLI slot and for how long, what is queued behind them with its
 * POSITION and waiting-since clock, and the machine-wide concurrency gate with
 * Praxis's own reason string (plus the structured numbers once sr-j lands
 * them — see lib/cli-lane.ts).
 *
 * Purely presentational over deriveCliLane(); the derivation is unit-tested
 * without a DOM.
 */
"use client";

import Link from "next/link";
import { Cpu, ListOrdered, ShieldAlert } from "lucide-react";
import {
  cliLaneSummary,
  formatDuration,
  type CliLaneView,
} from "@/lib/cli-lane";

function GateReadouts({ view }: { view: CliLaneView }) {
  const { gate } = view;
  if (gate.readouts.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {gate.readouts.map((r) => (
        <span
          key={r.label}
          className="rounded-md border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400"
          title={r.title}
        >
          <span className="text-slate-600">{r.label}</span> {r.value}
        </span>
      ))}
    </div>
  );
}

export function CliLanePanel({ view }: { view: CliLaneView }) {
  if (view.unavailable) {
    return (
      <div className="border-t border-slate-800/60 pt-2 text-[10px] text-slate-600">
        CLI lane telemetry unavailable — this Praxis build does not report the queue or gate.
      </div>
    );
  }

  const { gate } = view;
  const gateTone = gate.saturated ? "text-amber-300" : "text-emerald-300";

  return (
    <section
      aria-label={`CLI lane — ${cliLaneSummary(view)}`}
      className="space-y-1.5 border-t border-slate-800/60 pt-2"
    >
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-slate-600">
        <span className="flex items-center gap-1">
          <Cpu size={10} className="text-cyan-500/70" />
          cli lane
        </span>
        <span className={`normal-case tracking-normal tabular-nums ${gateTone}`}>
          {gate.active ?? view.executors.reduce((n, e) => n + e.runs.length, 0)}
          {gate.limit != null ? `/${gate.limit}` : ""} running
          {gate.burst ? " · burst" : ""}
          {gate.queued ? ` · ${gate.queued} queued` : ""}
        </span>
      </div>

      {/* Per-executor active runs */}
      <ul className="space-y-1">
        {view.executors.map((ex) => {
          const run = ex.runs[0];
          const extra = ex.runs.length - 1;
          return (
            <li key={ex.name} className="flex items-center gap-2 text-[11px]">
              <span
                className={`w-24 shrink-0 truncate ${
                  ex.suspended ? "text-rose-400" : run ? "text-cyan-300" : "text-slate-600"
                }`}
                title={
                  ex.suspended
                    ? `${ex.label} is suspended — Praxis reroutes around it`
                    : `${ex.label}${ex.slots != null ? ` · ${ex.runs.length}/${ex.slots} slots` : ""}`
                }
              >
                {ex.label}
              </span>
              {run ? (
                <>
                  <Link
                    href={`/task/${run.taskId}`}
                    className="min-w-0 flex-1 truncate text-slate-300 transition-colors hover:text-cyan-200"
                    title={run.title}
                  >
                    {run.title}
                  </Link>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {run.phase ?? "running"}
                    {formatDuration(run.runningMs) ? ` · ${formatDuration(run.runningMs)}` : ""}
                    {extra > 0 ? ` · +${extra}` : ""}
                  </span>
                </>
              ) : (
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {ex.suspended ? "suspended" : "idle"}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* Queue with position + title + waiting-since */}
      {view.queue.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-600">
            <ListOrdered size={10} className="text-amber-500/70" />
            queue — next out first
          </div>
          <ol className="space-y-1">
            {view.queue.map((q) => (
              <li
                key={`${q.taskId ?? "unknown"}-${q.position}`}
                className="flex items-center gap-2 text-[11px]"
              >
                <span
                  className="w-5 shrink-0 rounded-md border border-amber-500/30 bg-amber-500/5 text-center tabular-nums text-amber-300"
                  aria-label={`Queue position ${q.position}`}
                >
                  {q.position}
                </span>
                {q.taskId ? (
                  <Link
                    href={`/task/${q.taskId}`}
                    className="min-w-0 flex-1 truncate text-slate-300 transition-colors hover:text-cyan-200"
                    title={q.title ?? q.taskId}
                  >
                    {q.title ?? q.taskId}
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-slate-400">
                    {q.title ?? "Untitled queued task"}
                  </span>
                )}
                <span
                  className="shrink-0 tabular-nums text-slate-500"
                  title={
                    q.enqueuedAt
                      ? `Queued at ${q.enqueuedAt}${q.executorLabel ? ` for ${q.executorLabel}` : ""}`
                      : "Praxis reported no enqueue time"
                  }
                >
                  {q.executorLabel ? `${q.executorLabel} · ` : ""}
                  {formatDuration(q.waitingMs) ? `waiting ${formatDuration(q.waitingMs)}` : "waiting"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* The gate's own verdict — rendered verbatim, never re-derived. */}
      {gate.reason && (
        <div
          className={`rounded-md border px-2 py-1 text-[10px] leading-4 ${
            gate.saturated
              ? "border-amber-500/30 bg-amber-500/5 text-amber-200/90"
              : "border-slate-700 bg-slate-950 text-slate-400"
          }`}
        >
          <span className="uppercase tracking-wide text-slate-600">gate</span>{" "}
          <span title={gate.reason}>{gate.reason}</span>
          <GateReadouts view={view} />
        </div>
      )}

      {view.stalledCount > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-rose-300">
          <ShieldAlert size={10} />
          {view.stalledCount} run{view.stalledCount === 1 ? "" : "s"} past the attempt grace window
        </div>
      )}
    </section>
  );
}
