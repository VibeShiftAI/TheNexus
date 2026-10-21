"use client"

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarPlus, ChevronDown, ChevronUp, GitBranch } from "lucide-react";
import { AutomaticStartControl } from "./automatic-start-control";
import { scheduleFollowUp } from "@/lib/calendar";
import type { LiveWorkItem } from "@/lib/nexus/dispatch-insight";
import { laneWord, liveItemLabel, type LiveScheduleRow, type LiveWorkAvailability } from "@/lib/schedule-live-work";
import { taskHref } from "@/lib/task-links";

/**
 * FollowUpsSection — the follow-ups of today's plan, as their own block.
 *
 * Follow-ups are board tasks that succeed work on today's calendar but have
 * no slot of their own (lib/schedule-live-work, lane "waiting"). They used
 * to be interleaved with the timeline right after the last planned task,
 * which on a day whose plan finished early put seven unscheduled rows
 * between the morning's completions and the work actually running, and on
 * a phone meant scrolling through them to reach it (Robert, 2026-10-17).
 *
 * Now both schedule surfaces render them here, after the schedule itself:
 * the timeline shows only what has or had a time, and this section says
 * plainly that these rows are successors, not slots. The two actions a row
 * offers keep the operator in control: authorize an automatic start (the
 * Praxis relay), or give the task a real slot on the calendar right after
 * today's last planned task. Mounting the section never starts anything.
 *
 * The section starts collapsed on every screen size; its header toggles it.
 */

export function followUpRows(rows: LiveScheduleRow[]): LiveScheduleRow[] {
  return rows.filter((row) => row.lane === "waiting");
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A saved or in-flight automatic start means the calendar must not double it. */
function automaticStartActive(item: LiveWorkItem): boolean {
  if (item.autoStart) return true;
  const request = item.automaticStart;
  return Boolean(request && request.state !== "cancelled");
}

/** "Add to the calendar after today's last task": one click, one event. */
function AddToScheduleControl({ item, onChanged, disabled }: {
  item: LiveWorkItem;
  onChanged?: () => void | Promise<void>;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<{ at: string; after: string | null } | null>(null);
  useEffect(() => { setScheduled(null); setError(null); }, [item.taskId]);
  if (automaticStartActive(item)) return null;

  async function schedule() {
    if (busy || disabled) return;
    setBusy(true); setError(null);
    try {
      const result = await scheduleFollowUp(item.taskId);
      setScheduled({ at: result.event.start_time, after: result.after?.title ?? null });
      await onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scheduling could not be confirmed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-add-to-schedule className="mt-1.5 text-xs">
      {scheduled ? (
        <p className="text-emerald-300">
          On the calendar at {formatTime(scheduled.at)}{scheduled.after ? ` after “${scheduled.after}”` : ""}. Praxis starts it from there through the usual checks.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => void schedule()}
          disabled={disabled || busy}
          className="inline-flex items-center gap-1.5 rounded border border-purple-500/50 px-2 py-1 text-purple-200 hover:bg-purple-900/30 disabled:opacity-50"
          title="Create a calendar slot for this task right after today’s last planned task. Praxis runs it at that time through its normal dispatch and QA gates."
        >
          <CalendarPlus size={12} />
          {busy ? "Scheduling…" : "Add to calendar after today’s last task"}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-1 text-amber-300">
          {error} <Link href={taskHref(item.taskId)} className="underline">Review task</Link>
        </p>
      )}
    </div>
  );
}

function PreparedRow({ row, availability, onChanged }: {
  row: LiveScheduleRow;
  availability: LiveWorkAvailability;
  onChanged?: () => void | Promise<void>;
}) {
  const { item } = row;
  const live = availability.state === "live";
  const deps = item.waitingOn ?? [];
  return (
    <li
      data-live-row={row.lane}
      data-task-id={row.taskId}
      className="rounded-md border border-dashed border-slate-700/70 bg-slate-950/40 px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-slate-500" aria-hidden="true" />
        <Link href={taskHref(row.taskId)} className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-200 hover:underline" title={`${row.title}: open the task`}>
          {row.title}
        </Link>
        <span
          data-live-clock
          className="shrink-0 rounded border border-slate-700/70 px-1 text-[9px] font-semibold uppercase tracking-wider text-slate-400"
          title={automaticStartActive(item) ? "Automatic start requested; no planned time" : "Prepared follow-up; not scheduled"}
        >
          {automaticStartActive(item) ? "auto start" : "prepared"}
        </span>
      </div>
      <p data-live-label className="mt-0.5 pl-4 text-[10px] text-slate-500" title={liveItemLabel(item)}>
        {liveItemLabel(item)}
      </p>
      {deps.length > 0 && (
        <p className="flex flex-wrap gap-x-2 pl-4 text-[10px] text-slate-500">
          {deps.map((dep) => (
            <Link key={dep.taskId} href={taskHref(dep.taskId)} className="truncate hover:text-slate-300" title={`${dep.title} (${laneWord(dep)})`}>
              ↳ {dep.title} · {laneWord(dep)}
            </Link>
          ))}
        </p>
      )}
      <div className="pl-4">
        <AutomaticStartControl item={item} onChanged={onChanged} disabled={!live} />
        <AddToScheduleControl item={item} onChanged={onChanged} disabled={!live} />
      </div>
    </li>
  );
}

/** A QA-improvement suggestion on a finished parent: information, no start. */
function SuggestionRow({ row }: { row: LiveScheduleRow }) {
  const { item } = row;
  const improvement = item.improvement!;
  const updated = improvement.updatedAt ?? null;
  return (
    <li data-live-row={row.lane} data-task-id={row.taskId} className="pl-4 text-[11px] text-slate-400">
      <div className="flex flex-wrap items-center gap-x-2">
        <Link href={`${taskHref(row.taskId)}#qa-improvements`} className="min-w-0 truncate font-semibold text-slate-300 hover:underline" title={`${row.title}: open the task’s QA improvements`}>
          {row.title}
        </Link>
        <span
          data-live-clock
          className="font-mono text-[10px] tabular-nums text-slate-500"
          title={updated ? `Improvement status updated ${new Date(updated).toLocaleString()}` : "Improvement update time unavailable"}
        >
          {updated ? new Date(updated).toLocaleString() : "—"}
        </span>
      </div>
      <p data-live-label className="text-[10px] text-slate-500" title={liveItemLabel(item)}>{liveItemLabel(item)}</p>
      <p className="text-[11px] text-slate-400">
        {improvement.reason}{" "}
        <Link href={`${taskHref(row.taskId)}#qa-improvements`} className="text-cyan-300 underline">View suggestions and QA</Link>
      </p>
    </li>
  );
}

export interface FollowUpsSectionProps {
  /** The merged schedule's untimed rows; only the waiting lane is used. */
  rows: LiveScheduleRow[];
  availability: LiveWorkAvailability;
  onChanged?: () => void | Promise<void>;
  followupError?: string | null;
  /** Anchor id so a count elsewhere on the page can link here. */
  id?: string;
  className?: string;
}

export function FollowUpsSection({ rows, availability, onChanged, followupError, id = "followups", className = "" }: FollowUpsSectionProps) {
  const [open, setOpen] = useState(false);
  const waiting = followUpRows(rows);
  const prepared = waiting.filter((row) => !row.item.improvement);
  const suggestions = waiting.filter((row) => row.item.improvement);
  if (waiting.length === 0 && !followupError) return null;

  const listClass = open ? "block" : "hidden";
  const summary = [
    prepared.length > 0 && `${prepared.length} prepared`,
    suggestions.length > 0 && `${suggestions.length} QA ${suggestions.length === 1 ? "suggestion" : "suggestions"}`,
  ].filter(Boolean).join(" · ");

  return (
    <section id={id} data-live-followups className={className}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-slate-800/30"
      >
        <GitBranch size={12} className="shrink-0 text-slate-500" aria-hidden="true" />
        <span data-live-followups-header className="text-[9px] font-semibold uppercase tracking-widest text-slate-400">
          Pending QA follow-ups
        </span>
        {summary && <span data-live-followups-count className="truncate text-[10px] text-slate-500">{summary}</span>}
        <span className="ml-auto shrink-0 text-slate-500" aria-hidden="true">
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>
      <div id={`${id}-list`} className={listClass}>
        <p className="px-1 pb-1.5 text-[10px] text-slate-500">
          QA findings remain here across days while awaiting review or approval. Prepared task follow-ups are also shown below; they have no calendar slot.
        </p>
        {followupError && <p className="px-1 pb-1.5 text-[10px] text-amber-300">{followupError}</p>}
        {prepared.length > 0 && (
          <ul className="space-y-1.5">
            {prepared.map((row) => <PreparedRow key={row.key} row={row} availability={availability} onChanged={onChanged} />)}
          </ul>
        )}
        {suggestions.length > 0 && (
          <div className={prepared.length > 0 ? "mt-2" : ""}>
            <div className="px-1 py-1 text-[9px] font-semibold uppercase tracking-widest text-slate-500">
              QA findings · awaiting review or approval
            </div>
            <ul className="space-y-1.5">
              {suggestions.map((row) => <SuggestionRow key={row.key} row={row} />)}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
