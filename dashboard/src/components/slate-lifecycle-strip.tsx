/**
 * SlateLifecycleStrip: the day's slate as drafted, approved, attempted and
 * verified, on the board.
 *
 * On 2026-08-24 a slate was built, reached the [MORNING PLAN] card, and sat
 * there pending approval all night. Nothing dispatched and nothing said so:
 * the board showed its usual todo tasks, and the only record of the real state
 * was a field inside Praxis's schedule file. This strip is that field, made
 * visible, and specifically the stall: WHICH stage the slate is sitting in,
 * and for how long.
 *
 * Read-only. It renders what /api/slate/lifecycle projects from the schedule
 * Praxis owns, and offers no action: approving a slate stays on the morning
 * card, where Robert already does it.
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Check, ChevronRight, CircleDashed, Clock, HelpCircle } from "lucide-react";
import { useLiveRefetch } from "@/components/live-board-state";
import {
  describeSlate,
  describeStall,
  formatDuration,
  getSlateLifecycle,
  SLATE_STAGE_LABEL,
  stageTone,
  type SlateLifecycle,
  type SlateStage,
  type SlateStageTone,
  type SlateStall,
} from "@/lib/slate-lifecycle";

/** One palette per tone, so the four states are never told apart by text alone. */
const TONE_CLASS: Record<SlateStageTone, string> = {
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  waiting: "border-amber-500/50 bg-amber-500/10 text-amber-200",
  upcoming: "border-slate-700 bg-slate-900 text-slate-500",
  blocked: "border-rose-500/50 bg-rose-500/10 text-rose-200",
  unknown: "border-slate-600 bg-slate-900 text-slate-400",
};

function ToneIcon({ tone }: { tone: SlateStageTone }) {
  const size = 13;
  if (tone === "done") return <Check size={size} strokeWidth={3} className="shrink-0" />;
  if (tone === "waiting") return <Clock size={size} className="shrink-0" />;
  if (tone === "blocked") return <Ban size={size} className="shrink-0" />;
  if (tone === "unknown") return <HelpCircle size={size} className="shrink-0" />;
  return <CircleDashed size={size} className="shrink-0" />;
}

/** Local clock time for a stage stamp; the full ISO rides in the tooltip. */
function stageTime(at: string | null): string | null {
  if (!at) return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function StageChip({ stage, stall }: { stage: SlateStage; stall: SlateStall | null }) {
  const tone = stageTone(stage, stall);
  const time = stageTime(stage.at);
  const waiting = tone === "waiting" && stall?.waitingMs != null ? formatDuration(stall.waitingMs) : null;
  return (
    <span
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${TONE_CLASS[tone]}`}
      title={`${SLATE_STAGE_LABEL[stage.stage]}: ${stage.detail}${stage.at ? `\n${stage.at}` : ""}`}
    >
      <ToneIcon tone={tone} />
      <span className="font-semibold">{SLATE_STAGE_LABEL[stage.stage]}</span>
      {time && <span className="text-[11px] opacity-80">{time}</span>}
      {waiting && <span className="text-[11px] opacity-80">waiting {waiting}</span>}
    </span>
  );
}

/**
 * Per-slot detail behind the strip. Deliberately behind a toggle: the strip's
 * job is the stage, and twelve rows of slot titles would bury it.
 */
function SlotTable({ lifecycle }: { lifecycle: SlateLifecycle }) {
  return (
    <ul className="mt-2 space-y-1 border-t border-slate-800 pt-2">
      {lifecycle.slots.map((slot) => {
        const state = slot.withdrawn
          ? `${slot.status}${slot.skipSource ? ` (${slot.skipSource})` : ""}`
          : slot.operatorAccepted
            ? "operator-accepted (not QA-passed)"
            : slot.status;
        const tone = slot.verified
          ? "text-emerald-300"
          : slot.withdrawn
            ? "text-slate-600"
            : slot.attempted
              ? "text-cyan-300"
              : "text-slate-400";
        return (
          <li key={`${slot.slotNumber}-${slot.taskId}`} className="flex items-baseline gap-2">
            <span className="w-5 shrink-0 text-right text-slate-600">{slot.slotNumber ?? "—"}</span>
            {slot.taskId ? (
              <Link href={`/task/${slot.taskId}`} className="truncate text-slate-300 hover:text-cyan-300">
                {slot.title}
              </Link>
            ) : (
              <span className="truncate text-slate-300">{slot.title}</span>
            )}
            <span className={`ml-auto shrink-0 ${tone}`}>{state}</span>
            {slot.spineUnrecorded && (
              <span className="shrink-0 text-amber-300" title="The run-events spine rejected this slot's provenance write, so the slot carries the only surviving evidence it ran.">
                spine gap
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function SlateLifecycleStrip() {
  const [lifecycle, setLifecycle] = useState<SlateLifecycle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(() => {
    getSlateLifecycle()
      .then((next) => {
        setLifecycle(next);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load slate lifecycle"));
  }, []);

  // The slate advances on approvals, dispatches and completions; all three
  // are live domains, with the standard slow poll behind them for drift.
  useLiveRefetch(["schedule", "hitl", "task"], load, { fallbackPollMs: 60_000 });

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
        <AlertTriangle size={15} className="shrink-0" />
        Slate lifecycle unavailable: {error}
      </div>
    );
  }
  if (!lifecycle) return null;

  if (!lifecycle.available) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-2.5 text-xs text-slate-400">
        <HelpCircle size={14} className="shrink-0" />
        <span className="font-semibold uppercase tracking-wide text-slate-500">Slate lifecycle</span>
        <span>
          Praxis&apos;s schedule could not be read, so the slate&apos;s stage is unknown
          {lifecycle.reason ? ` (${lifecycle.reason})` : ""}.
        </span>
      </div>
    );
  }

  const stall = describeStall(lifecycle);
  const alarm = lifecycle.stall?.warn === true || lifecycle.stall?.blocked === true;

  return (
    <div
      className={`rounded-lg border px-4 py-2.5 text-xs ${
        alarm ? "border-amber-500/40 bg-amber-500/5 text-amber-100" : "border-slate-800 bg-slate-900/60 text-slate-400"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-semibold uppercase tracking-wide text-slate-500">{describeSlate(lifecycle)}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {lifecycle.stages.map((stage, index) => (
            <span key={stage.stage} className="flex items-center gap-1.5">
              {index > 0 && <ChevronRight size={12} className="shrink-0 text-slate-700" />}
              <StageChip stage={stage} stall={lifecycle.stall} />
            </span>
          ))}
        </div>
        {stall && (
          <span className={`flex items-center gap-1.5 ${alarm ? "text-amber-300" : "text-slate-400"}`}>
            {alarm && <AlertTriangle size={13} className="shrink-0" />}
            {stall}
          </span>
        )}
        {lifecycle.slots.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="ml-auto text-slate-500 transition-colors hover:text-cyan-300"
          >
            {expanded ? "Hide slots" : `${lifecycle.slots.length} slots`}
          </button>
        )}
      </div>

      {expanded && <SlotTable lifecycle={lifecycle} />}
    </div>
  );
}
