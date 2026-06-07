"use client";

/**
 * Rich approval card for the morning [MORNING PLAN] schedule HITL.
 *
 * Detected from the generic HitlInbox when `request.metadata.kind` is
 * "day-schedule". Renders the proposed slot table with per-row controls:
 *
 *   • Worker dropdown — Antigravity / Codex / Claude Code, defaults to
 *     whatever Praxis proposed (`slot.executor`).
 *   • Skip button — opens an inline reason input; on confirm the slot is
 *     marked skipped locally and the reason is recorded.
 *
 * Approve sends `{ choice: "approve", payload: { scheduleOverrides: {
 *   executors, skips } } }` so the Praxis side applies the per-slot changes
 * via `applyScheduleOverrides` before `activateDaySchedule`. Reject sends
 * `{ choice: "reject" }` and holds the full schedule.
 */

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Trash2, XCircle } from "lucide-react";
import type { HITLRequest } from "@praxis/contract";

type ExecutorName = "antigravity" | "codex" | "claude-code";
const EXECUTOR_OPTIONS: ExecutorName[] = ["antigravity", "codex", "claude-code"];

interface ScheduleSlotMeta {
  slotNumber: number;
  nexusTaskId: string;
  title: string;
  workspace: string;
  estimatedMinutes: number;
  startTime: string;
  executor: ExecutorName;
}

interface ScheduleMetadata {
  kind: "day-schedule";
  date: string;
  nightlySummary: string | null;
  slots: ScheduleSlotMeta[];
}

/** Type-guard the open-typed metadata bag into our schedule shape. */
function asScheduleMetadata(meta: unknown): ScheduleMetadata | null {
  if (!meta || typeof meta !== "object") return null;
  const obj = meta as Record<string, unknown>;
  if (obj.kind !== "day-schedule") return null;
  if (!Array.isArray(obj.slots)) return null;
  return obj as unknown as ScheduleMetadata;
}

export function isScheduleHitl(request: HITLRequest): boolean {
  return asScheduleMetadata(request.metadata) !== null;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return iso;
  }
}

export function ScheduleHitlCard({
  request,
  resolving,
  onResolve,
}: {
  request: HITLRequest;
  resolving: boolean;
  onResolve: (
    requestId: string,
    input: { choice?: string; freeText?: string; payload?: Record<string, unknown> },
  ) => Promise<void>;
}) {
  const schedule = useMemo(() => asScheduleMetadata(request.metadata), [request.metadata]);

  // Per-slot local override state, keyed by nexus_task_id (matches the
  // payload shape the Praxis side expects).
  const [executors, setExecutors] = useState<Record<string, ExecutorName>>(() => {
    if (!schedule) return {};
    return Object.fromEntries(schedule.slots.map((s) => [s.nexusTaskId, s.executor]));
  });
  const [skips, setSkips] = useState<Record<string, string>>({});
  const [skipDraft, setSkipDraft] = useState<{ taskId: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!schedule) {
    // Defensive — caller should have checked isScheduleHitl, but fall back
    // gracefully if metadata is malformed.
    return (
      <article className="rounded-lg border border-rose-700/40 bg-rose-950/40 p-3 text-xs text-rose-200">
        Schedule HITL is missing structured slot data.
      </article>
    );
  }

  const skipCount = Object.keys(skips).length;
  const executorChanges = schedule.slots.filter(
    (s) => executors[s.nexusTaskId] !== s.executor,
  ).length;
  const activeCount = schedule.slots.length - skipCount;

  async function submit(choice: "approve" | "reject") {
    setError(null);
    try {
      if (choice === "reject") {
        await onResolve(request.id, { choice: "reject" });
        return;
      }

      // Build the scheduleOverrides payload — only include executors that
      // actually differ from the proposed defaults; always include skips.
      const executorOverrides: Record<string, string> = {};
      for (const slot of schedule!.slots) {
        const chosen = executors[slot.nexusTaskId];
        if (chosen && chosen !== slot.executor) {
          executorOverrides[slot.nexusTaskId] = chosen;
        }
      }
      const hasExecutorChanges = Object.keys(executorOverrides).length > 0;
      const hasSkips = Object.keys(skips).length > 0;

      const payload =
        hasExecutorChanges || hasSkips
          ? {
              scheduleOverrides: {
                ...(hasExecutorChanges ? { executors: executorOverrides } : {}),
                ...(hasSkips ? { skips } : {}),
              },
            }
          : undefined;

      await onResolve(request.id, {
        choice: "approve",
        payload,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolution failed");
    }
  }

  return (
    <article className="rounded-lg border border-cyan-500/30 bg-slate-950/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300">
          Morning Plan — {schedule.date}
        </span>
        <span className="text-[11px] text-slate-400">
          {activeCount} dispatching{skipCount > 0 ? `, ${skipCount} skipped` : ""}
          {executorChanges > 0 ? `, ${executorChanges} worker changes` : ""}
        </span>
      </div>

      {schedule.nightlySummary ? (
        <div className="mb-3 rounded border border-slate-700/60 bg-slate-900/60 p-2 text-[11px] text-slate-300">
          <span className="font-semibold text-cyan-300">Nightly:</span>{" "}
          {schedule.nightlySummary}
        </div>
      ) : null}

      <div className="mb-3 overflow-hidden rounded border border-slate-700/60">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-slate-400">
            <tr>
              <th className="px-2 py-1 text-left font-semibold">#</th>
              <th className="px-2 py-1 text-left font-semibold">Task</th>
              <th className="px-2 py-1 text-left font-semibold">Start</th>
              <th className="px-2 py-1 text-left font-semibold">Worker</th>
              <th className="px-2 py-1 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {schedule.slots.map((slot) => {
              const isSkipped = skips[slot.nexusTaskId] !== undefined;
              const currentExec = executors[slot.nexusTaskId] ?? slot.executor;
              const isDraftingSkip = skipDraft?.taskId === slot.nexusTaskId;
              return (
                <>
                  <tr
                    key={slot.nexusTaskId}
                    className={`border-t border-slate-700/40 ${isSkipped ? "opacity-50 line-through decoration-rose-400/60" : ""}`}
                  >
                    <td className="px-2 py-1 text-slate-400">{slot.slotNumber}</td>
                    <td className="px-2 py-1 text-slate-100">
                      <div className="truncate">{slot.title}</div>
                      <div className="truncate text-[10px] text-slate-500">
                        {slot.workspace} · ~{slot.estimatedMinutes}min
                      </div>
                    </td>
                    <td className="px-2 py-1 text-slate-300">{formatTime(slot.startTime)}</td>
                    <td className="px-2 py-1">
                      <select
                        disabled={isSkipped || resolving}
                        value={currentExec}
                        onChange={(e) =>
                          setExecutors((prev) => ({
                            ...prev,
                            [slot.nexusTaskId]: e.target.value as ExecutorName,
                          }))
                        }
                        className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200 outline-none focus:border-cyan-500 disabled:cursor-not-allowed"
                      >
                        {EXECUTOR_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1 text-right">
                      {isSkipped ? (
                        <button
                          disabled={resolving}
                          onClick={() => {
                            setSkips((prev) => {
                              const next = { ...prev };
                              delete next[slot.nexusTaskId];
                              return next;
                            });
                          }}
                          className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          disabled={resolving}
                          onClick={() =>
                            setSkipDraft({ taskId: slot.nexusTaskId, reason: "" })
                          }
                          className="inline-flex items-center gap-1 rounded border border-rose-500/40 px-2 py-0.5 text-[11px] text-rose-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" /> Skip
                        </button>
                      )}
                    </td>
                  </tr>
                  {isDraftingSkip ? (
                    <tr key={`${slot.nexusTaskId}-draft`} className="border-t border-slate-700/40 bg-rose-950/20">
                      <td colSpan={5} className="px-2 py-2">
                        <label className="mb-1 block text-[11px] text-rose-300">
                          Skip reason (recorded on the task and written to Cortex memory so Praxis stops re-proposing it):
                        </label>
                        <textarea
                          autoFocus
                          value={skipDraft.reason}
                          onChange={(e) =>
                            setSkipDraft((prev) => (prev ? { ...prev, reason: e.target.value } : prev))
                          }
                          placeholder="e.g. already built the ios widget outside Praxis"
                          className="mb-2 min-h-16 w-full resize-y rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 outline-none focus:border-rose-400"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setSkipDraft(null)}
                            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-500"
                          >
                            Cancel
                          </button>
                          <button
                            disabled={!skipDraft.reason.trim()}
                            onClick={() => {
                              setSkips((prev) => ({
                                ...prev,
                                [skipDraft.taskId]: skipDraft.reason.trim(),
                              }));
                              setSkipDraft(null);
                            }}
                            className="rounded bg-rose-500 px-2 py-0.5 text-[11px] font-semibold text-slate-950 hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                          >
                            Confirm skip
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? (
        <div className="mb-2 flex items-center gap-1 text-[11px] text-rose-300">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          disabled={resolving}
          onClick={() => void submit("reject")}
          className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" /> Reject
        </button>
        <button
          disabled={resolving || activeCount === 0}
          onClick={() => void submit("approve")}
          className="inline-flex items-center gap-1 rounded-md bg-cyan-500 px-3 py-1.5 text-xs font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {resolving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {resolving
            ? "Approving..."
            : activeCount === 0
              ? "All slots skipped"
              : `Approve (${activeCount})`}
        </button>
      </div>
    </article>
  );
}
