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

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Trash2,
  XCircle,
} from "lucide-react";
import type { HITLRequest } from "@praxis/contract";
import {
  apiModelIdOf,
  filterClaudeModels,
  getModelControlState,
} from "@/lib/model-control";

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
  /** Praxis-proposed model override for the slot (api model id), if any. */
  modelOverride?: string | null;
  /** One-sentence definition of done, proposed by Praxis. */
  objective?: string | null;
  /** Praxis-assigned 1–5 difficulty score. */
  complexity?: number | null;
  /** Additional executor instructions beyond the title. */
  instructions?: string | null;
  /** Snapshot of the underlying Nexus task description. */
  taskDescription?: string | null;
}

interface SkillCandidateMeta {
  /** Candidate id (kebab-case filename in skills/_candidates/). */
  id: string;
  name: string;
  category: string;
  summary: string;
  /** Title of the ingested item this was harvested from. */
  sourceTitle?: string | null;
  sourceUrl?: string | null;
}

type CandidateDecision = "approve" | "archive";

interface ScheduleMetadata {
  kind: "day-schedule";
  date: string;
  nightlySummary: string | null;
  slots: ScheduleSlotMeta[];
  /**
   * Pending nightly skill-harvest candidates (optional — older Praxis
   * builds don't send this). Decisions ride back on the resolution as
   * payload.skillCandidateDecisions; undecided candidates stay staged.
   */
  skillCandidates?: SkillCandidateMeta[];
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

const COMPLEXITY_LABELS: Record<number, string> = {
  1: "Trivial",
  2: "Small",
  3: "Moderate",
  4: "Hard",
  5: "Very hard",
};

/** Render the Praxis-assigned 1–5 difficulty score, colored by level. */
function ComplexityBadge({ value }: { value: number | null | undefined }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return <span className="text-[11px] text-slate-600">—</span>;
  }
  const level = Math.min(5, Math.max(1, Math.round(value)));
  const tone =
    level <= 2
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : level === 3
        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
        : "border-rose-500/40 bg-rose-500/10 text-rose-300";
  return (
    <span
      title={`${COMPLEXITY_LABELS[level]} (${level}/5)`}
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      🧩 {level}/5
    </span>
  );
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-slot model override, keyed by nexus_task_id ("" = executor default).
  const [models, setModels] = useState<Record<string, string>>(() => {
    if (!schedule) return {};
    return Object.fromEntries(schedule.slots.map((s) => [s.nexusTaskId, s.modelOverride ?? ""]));
  });
  // Discovered Claude models for the per-slot Model dropdown (claude-code
  // slots only) + the operator-set default, for the "(default)" label.
  const [claudeModels, setClaudeModels] = useState<Array<{ id: string; label: string }>>([]);
  const [claudeDefault, setClaudeDefault] = useState<string>("claude-opus-4-8");
  useEffect(() => {
    let cancelled = false;
    getModelControlState(null)
      .then((state) => {
        if (cancelled) return;
        setClaudeModels(
          filterClaudeModels(state.models).map((m) => ({
            id: apiModelIdOf(m),
            label: m.display_name || m.name || m.id,
          })),
        );
        if (state.claudeDefault) setClaudeDefault(state.claudeDefault);
      })
      .catch(() => {
        /* dropdown falls back to the default-only option */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Individual candidate decisions POST immediately and are decoupled from
  // the plan approval (2026-07-03). "approved"/"archived" are terminal here;
  // undecided candidates stay staged and reappear tomorrow.
  const [candidateStates, setCandidateStates] = useState<
    Record<string, "deciding" | "approved" | "archived">
  >({});
  const [error, setError] = useState<string | null>(null);

  async function decideCandidate(id: string, decision: CandidateDecision) {
    setError(null);
    setCandidateStates((prev) => ({ ...prev, [id]: "deciding" }));
    try {
      const res = await fetch(`/api/skill-candidates/${encodeURIComponent(id)}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) throw new Error(`candidate decision failed (${res.status})`);
      setCandidateStates((prev) => ({
        ...prev,
        [id]: decision === "approve" ? "approved" : "archived",
      }));
    } catch (err) {
      setCandidateStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setError(err instanceof Error ? err.message : "Candidate decision failed");
    }
  }

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
      // The plan resolution carries ONLY plan concerns. Skill candidates are
      // decided individually via decideCandidate (2026-07-03 split).
      if (choice === "reject") {
        await onResolve(request.id, { choice: "reject" });
        return;
      }

      // Build the scheduleOverrides payload — only include executors/models
      // that actually differ from the proposed defaults; always include skips.
      const executorOverrides: Record<string, string> = {};
      const modelOverrides: Record<string, string> = {};
      for (const slot of schedule!.slots) {
        const chosen = executors[slot.nexusTaskId];
        if (chosen && chosen !== slot.executor) {
          executorOverrides[slot.nexusTaskId] = chosen;
        }
        const chosenModel = models[slot.nexusTaskId] ?? "";
        if (chosenModel !== (slot.modelOverride ?? "")) {
          // "" rides through intentionally — it clears a proposed override.
          modelOverrides[slot.nexusTaskId] = chosenModel;
        }
      }
      const hasExecutorChanges = Object.keys(executorOverrides).length > 0;
      const hasModelChanges = Object.keys(modelOverrides).length > 0;
      const hasSkips = Object.keys(skips).length > 0;

      const payload =
        hasExecutorChanges || hasModelChanges || hasSkips
          ? {
              scheduleOverrides: {
                ...(hasExecutorChanges ? { executors: executorOverrides } : {}),
                ...(hasModelChanges ? { models: modelOverrides } : {}),
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
              <th className="px-2 py-1 text-left font-semibold">Difficulty</th>
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
              const isOpen = expanded[slot.nexusTaskId] === true;
              return (
                <Fragment key={slot.nexusTaskId}>
                  <tr
                    className={`border-t border-slate-700/40 ${isSkipped ? "opacity-50 line-through decoration-rose-400/60" : ""}`}
                  >
                    <td className="px-2 py-1 text-slate-400">{slot.slotNumber}</td>
                    <td className="px-2 py-1 text-slate-100">
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((prev) => ({
                            ...prev,
                            [slot.nexusTaskId]: !prev[slot.nexusTaskId],
                          }))
                        }
                        aria-expanded={isOpen}
                        className="flex w-full items-start gap-1 text-left hover:text-cyan-300"
                        title="Open task to review objective + instructions"
                      >
                        {isOpen ? (
                          <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                        ) : (
                          <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-slate-400" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate">{slot.title}</span>
                          <span className="block truncate text-[10px] text-slate-500">
                            {slot.workspace} · ~{slot.estimatedMinutes}min
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="px-2 py-1">
                      <ComplexityBadge value={slot.complexity} />
                    </td>
                    <td className="px-2 py-1 text-slate-300">{formatTime(slot.startTime)}</td>
                    <td className="px-2 py-1">
                      <div className="flex flex-col gap-1">
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
                        {currentExec === "claude-code" ? (
                          <select
                            disabled={isSkipped || resolving}
                            value={models[slot.nexusTaskId] ?? ""}
                            onChange={(e) =>
                              setModels((prev) => ({
                                ...prev,
                                [slot.nexusTaskId]: e.target.value,
                              }))
                            }
                            title="Claude model for this slot (billed to the Claude subscription)"
                            className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[11px] text-purple-200 outline-none focus:border-purple-500 disabled:cursor-not-allowed"
                          >
                            <option value="">default ({claudeDefault})</option>
                            {claudeModels.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.label}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
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
                  {isOpen ? (
                    <tr key={`${slot.nexusTaskId}-detail`} className="border-t border-slate-700/40 bg-slate-900/40">
                      <td colSpan={6} className="px-3 py-2">
                        <div className="space-y-2 text-[11px] text-slate-300">
                          <div>
                            <span className="font-semibold text-cyan-300">Objective:</span>{" "}
                            {slot.objective ? (
                              <span>{slot.objective}</span>
                            ) : (
                              <span className="italic text-slate-500">No objective provided.</span>
                            )}
                          </div>
                          <div>
                            <span className="font-semibold text-cyan-300">Instructions:</span>{" "}
                            {slot.instructions ? (
                              <span className="whitespace-pre-wrap">{slot.instructions}</span>
                            ) : (
                              <span className="italic text-slate-500">No extra instructions.</span>
                            )}
                          </div>
                          {slot.taskDescription &&
                          slot.taskDescription.trim() !== (slot.instructions ?? "").trim() ? (
                            <div>
                              <span className="font-semibold text-cyan-300">Task description:</span>{" "}
                              <span className="whitespace-pre-wrap">{slot.taskDescription}</span>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {isDraftingSkip ? (
                    <tr key={`${slot.nexusTaskId}-draft`} className="border-t border-slate-700/40 bg-rose-950/20">
                      <td colSpan={6} className="px-2 py-2">
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
                </Fragment>
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

      {/* Plan approval sits directly under the plan and approves ONLY the
          schedule — skill candidates below are decided individually. */}
      <div className="mb-3 flex justify-end gap-2">
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
              : `Approve plan (${activeCount})`}
        </button>
      </div>

      {schedule.skillCandidates && schedule.skillCandidates.length > 0 ? (
        <div className="mb-3 overflow-hidden rounded border border-violet-500/30">
          <div className="flex items-center justify-between bg-violet-500/10 px-2 py-1">
            <span className="text-[11px] font-semibold text-violet-300">
              🧩 Skill Candidates — {schedule.skillCandidates.length} from the nightly harvest
            </span>
            <span className="text-[10px] text-slate-400">
              Decided individually — effective immediately, independent of the plan approval above · Undecided → stays for tomorrow
            </span>
          </div>
          <ul className="divide-y divide-slate-700/40">
            {schedule.skillCandidates.map((candidate) => {
              const state = candidateStates[candidate.id];
              return (
                <li key={candidate.id} className="flex items-start justify-between gap-2 px-2 py-1.5">
                  <div className="min-w-0 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`truncate font-semibold ${
                          state === "archived"
                            ? "text-slate-500 line-through decoration-rose-400/60"
                            : state === "approved"
                              ? "text-emerald-300"
                              : "text-slate-100"
                        }`}
                      >
                        {candidate.name}
                      </span>
                      <span className="shrink-0 rounded-full border border-slate-700 px-1.5 py-0 text-[10px] text-slate-400">
                        {candidate.category}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{candidate.summary}</div>
                    {candidate.sourceTitle ? (
                      <div className="mt-0.5 truncate text-[10px] text-slate-500">
                        from:{" "}
                        {candidate.sourceUrl ? (
                          <a
                            href={candidate.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-slate-600 hover:text-violet-300"
                          >
                            {candidate.sourceTitle}
                          </a>
                        ) : (
                          candidate.sourceTitle
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1 pt-0.5">
                    <button
                      disabled={state !== undefined}
                      onClick={() => void decideCandidate(candidate.id, "approve")}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50 ${
                        state === "approved"
                          ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                          : "border-slate-700 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
                      }`}
                      title="Approve now — moves into the live skill library immediately (installs for Claude Code via the vault watcher)"
                    >
                      {state === "deciding" ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                      {state === "approved" ? "Approved" : "Approve"}
                    </button>
                    <button
                      disabled={state !== undefined}
                      onClick={() => void decideCandidate(candidate.id, "archive")}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50 ${
                        state === "archived"
                          ? "border-rose-400 bg-rose-500/20 text-rose-200"
                          : "border-slate-700 text-slate-300 hover:border-rose-400 hover:text-rose-300"
                      }`}
                      title="Reject now — moved to _candidates/_rejected/ for audit"
                    >
                      <Trash2 className="h-3 w-3" />
                      {state === "archived" ? "Archived" : "Archive"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

    </article>
  );
}
