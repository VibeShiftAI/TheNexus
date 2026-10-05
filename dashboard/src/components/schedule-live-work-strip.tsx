"use client"

import Link from "next/link";
import { Activity } from "lucide-react";
import {
  laneWord,
  liveItemLabel,
  liveWorkAvailabilityText,
  type LiveScheduleRow,
  type LiveWorkAvailability,
  type MergedLiveWork,
} from "@/lib/schedule-live-work";
import type { LiveWorkLane } from "@/lib/nexus/dispatch-insight";
import { taskHref } from "@/lib/task-links";

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function laneTone(lane: LiveWorkLane): string {
  switch (lane) {
    case "running":
      return "border-amber-400/40 bg-amber-400/10 text-amber-200";
    case "qa":
      return "border-violet-400/40 bg-violet-400/10 text-violet-200";
    case "finished":
      return "border-slate-600/60 bg-slate-800/40 text-slate-300";
    case "waiting":
      return "border-dashed border-slate-600/70 bg-slate-900/40 text-slate-400";
    default:
      return "border-cyan-400/40 bg-cyan-400/10 text-cyan-200";
  }
}

function laneDot(lane: LiveWorkLane): string {
  switch (lane) {
    case "running":
      return "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)] motion-safe:animate-pulse";
    case "qa":
      return "bg-violet-400";
    case "finished":
      return "bg-slate-500";
    case "waiting":
      return "border border-dashed border-slate-500 bg-transparent";
    default:
      return "border border-cyan-400/70 bg-transparent";
  }
}

/**
 * The clock column: a real time when the row has one (started / finished),
 * the queue position for queued work, "after" for work waiting on a
 * predecessor. Never an invented start time.
 */
function clockFor(row: LiveScheduleRow): { text: string; title: string } {
  const { item } = row;
  if (row.whenIso) {
    return {
      text: formatTime(row.whenIso),
      title: `${row.lane === "running" ? "started" : "implementation finished"} ${formatTime(row.whenIso)}`,
    };
  }
  if (row.lane === "queued") {
    return {
      text: `#${item.position ?? "·"}`,
      title: `Queue position ${item.position ?? "?"}${item.queueLength != null ? ` of ${item.queueLength}` : ""}: starts when the CLI slot frees; no planned time`,
    };
  }
  if (row.lane === "waiting") {
    return { text: "after", title: "Starts after the work it waits on; no planned time" };
  }
  return { text: "—", title: "No time reported" };
}

export interface LiveWorkStripProps {
  merged: MergedLiveWork;
  availability: LiveWorkAvailability;
}

/**
 * LiveWorkStrip — the runtime's view of today's work for the /calendar page:
 * what is running, under review, queued (in Praxis's order) and waiting on
 * that work. The same merge feeds the home panel, so both surfaces list the
 * same tasks; a task that also has a calendar event is badged on that event
 * instead of appearing here. Display only: nothing here dispatches or
 * re-orders anything.
 */
export function LiveWorkStrip({ merged, availability }: LiveWorkStripProps) {
  const rows = [...merged.timed, ...merged.untimed];
  const note = liveWorkAvailabilityText(availability);
  const waitingCount = merged.untimed.filter((r) => r.lane === "waiting").length;

  return (
    <section data-live-work-strip className="border-b border-slate-800 bg-slate-900/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-slate-300">
          <Activity size={14} className={merged.runningCount > 0 && availability.state === "live" ? "text-amber-400" : "text-slate-500"} />
          Runtime work
        </span>
        {availability.state === "live" && (
          <span className="text-slate-500">
            {merged.runningCount} running
            {" · "}
            <span data-live-queued-count>{merged.queuedCount} queued</span>
            {waitingCount > 0 && ` · ${waitingCount} waiting on linked work`}
          </span>
        )}
        <span className="ml-auto text-[10px] text-slate-600" title="Read from the Praxis runtime through Nexus. The calendar alone cannot show work queued from chat until it finishes.">
          from the Praxis runtime · display only
        </span>
      </div>

      {note && (
        <p data-live-availability={availability.state} className="mt-2 text-xs text-amber-300">
          {note}
        </p>
      )}

      {availability.state === "loading" && <p className="mt-2 text-xs text-slate-500">Reading the runtime queue…</p>}

      {rows.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => {
            const clock = clockFor(row);
            const label = liveItemLabel(row.item);
            return (
              <li
                key={row.key}
                data-live-row={row.lane}
                data-task-id={row.taskId}
                className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-2.5 py-1.5 text-xs ${laneTone(row.lane)}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${laneDot(row.lane)}`} aria-hidden="true" />
                <span data-live-clock className="w-12 shrink-0 font-mono text-[11px] tabular-nums text-slate-400" title={clock.title}>
                  {clock.text}
                </span>
                <Link href={taskHref(row.taskId)} className="min-w-0 flex-1 truncate font-semibold hover:underline" title={`${row.title}: open the task`}>
                  {row.title}
                </Link>
                <span data-live-label className="max-w-full truncate text-[11px] text-slate-400" title={label}>
                  {label}
                </span>
                {row.lane === "waiting" && (row.item.waitingOn ?? []).length > 0 && (
                  <span className="flex w-full flex-wrap gap-x-2 pl-[3.75rem] text-[11px] text-slate-500">
                    {(row.item.waitingOn ?? []).map((dep) => (
                      <Link key={dep.taskId} href={taskHref(dep.taskId)} className="truncate hover:text-slate-300" title={`${dep.title} (${laneWord(dep)})`}>
                        ↳ {dep.title} · {laneWord(dep)}
                      </Link>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Emptiness is judged on everything the runtime reported, badged
          work included: a queue whose only entry sits on a calendar block is
          not "nothing queued" (QA round 1, 2026-10-04). */}
      {rows.length === 0 && availability.state === "live" && merged.workCount > 0 && (
        <p data-live-badged-only className="mt-2 text-xs text-slate-500">
          Today&apos;s runtime work is already on the calendar below, badged on its block.
        </p>
      )}
      {rows.length === 0 && availability.state === "live" && merged.workCount === 0 && (
        <p className="mt-2 text-xs text-slate-500">Nothing running or queued in the runtime right now.</p>
      )}
    </section>
  );
}
