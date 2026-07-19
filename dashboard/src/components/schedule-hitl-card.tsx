"use client";

/**
 * Approval cards for the morning routine.
 *
 * The 6 AM morning pipeline opens up to THREE independent HITL items, each
 * rendered as its own inbox card so they clear independently (2026-07-06 split
 * — approving the schedule used to clear skills + archive along with it):
 *
 *   • ScheduleHitlCard         (kind "day-schedule")      — proposed slots with
 *     per-row Worker/Model dropdowns + Skip + an add-instructions note (rides
 *     scheduleOverrides.instructions); Approve activates dispatch, Reject holds.
 *   • SkillCandidatesHitlCard  (kind "skill-candidates")  — nightly harvest;
 *     each candidate Approve/Archive posts immediately, then Done clears the item.
 *   • BoardMaintenanceHitlCard (kind "board-maintenance") — Groundskeeper
 *     archive proposals (Archive/Keep ride the Done payload) + the Monday QA
 *     spot-audit (each sample links to its task + a Holds up/Flag verdict that
 *     also rides the Done payload); Done clears the item.
 *
 * The generic HitlInbox dispatches by `request.metadata.kind` using the
 * exported `isScheduleHitl` / `isSkillCandidatesHitl` / `isBoardMaintenanceHitl`
 * guards.
 */

import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Flag,
  Loader2,
  Minus,
  Plus,
  Trash2,
  Type,
  XCircle,
} from "lucide-react";
import type { HITLRequest } from "@praxis/contract";
import {
  EXECUTOR_OPTIONS,
  useExecutorModelOptions,
  type ExecutorName,
} from "@/hooks/use-executor-models";

type ResolveFn = (
  requestId: string,
  input: { choice?: string; freeText?: string; payload?: Record<string, unknown> },
) => Promise<void>;

// ── Morning Plan font-size controller ───────────────────────────────────
// The schedule table is dense with 10–12px text. Robert reads it every
// morning, so the card exposes a −/+ stepper that scales its body text and
// remembers the choice per-browser. The scale is applied as CSS custom
// properties on the card (see scaleStyle in ScheduleHitlCard); nested text
// classes reference them via `var(--hitl-fs-*, <native>)`, so every size
// stays proportional (an absolute length per level — no em-compounding) and
// falls back to its original px on any inbox card that doesn't set the vars.
const FONT_SCALE_KEY = "praxis.morningPlan.fontScale";
const FONT_SCALE_MIN = 1;
const FONT_SCALE_MAX = 1.8;
const FONT_SCALE_STEP = 0.1;
const FONT_SCALE_DEFAULT = 1.3; // ~+3.6px on the 12px base — already ≥2pt larger than before

function clampFontScale(n: number): number {
  if (!Number.isFinite(n)) return FONT_SCALE_DEFAULT;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
  return Math.round(clamped * 100) / 100;
}

/** Card-local font scale, hydrated from and persisted to localStorage. */
function useMorningPlanFontScale() {
  const [scale, setScale] = useState(FONT_SCALE_DEFAULT);

  // Hydrate after mount so SSR and the first client render agree (localStorage
  // isn't available during SSR).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(FONT_SCALE_KEY);
      if (saved !== null) setScale(clampFontScale(Number(saved)));
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);

  const adjust = (delta: number) =>
    setScale((prev) => {
      const next = clampFontScale(prev + delta);
      try {
        window.localStorage.setItem(FONT_SCALE_KEY, String(next));
      } catch {
        /* storage unavailable — the in-memory value still applies */
      }
      return next;
    });

  return { scale, adjust };
}

/** Compact −/+ stepper that drives useMorningPlanFontScale. */
function FontScaleControl({
  scale,
  onAdjust,
}: {
  scale: number;
  onAdjust: (delta: number) => void;
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-full border border-slate-700 bg-slate-900/60 px-1 py-0.5"
      title="Text size for the Morning Plan (saved for next time)"
    >
      <Type className="mx-0.5 h-3 w-3 text-slate-400" aria-hidden />
      <button
        type="button"
        aria-label="Smaller Morning Plan text"
        disabled={scale <= FONT_SCALE_MIN}
        onClick={() => onAdjust(-FONT_SCALE_STEP)}
        className="rounded p-0.5 text-slate-300 transition hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Minus className="h-3 w-3" />
      </button>
      <span className="min-w-[2.75rem] text-center text-[0.6875rem] tabular-nums text-slate-300">
        {Math.round(scale * 100)}%
      </span>
      <button
        type="button"
        aria-label="Larger Morning Plan text"
        disabled={scale >= FONT_SCALE_MAX}
        onClick={() => onAdjust(FONT_SCALE_STEP)}
        className="rounded p-0.5 text-slate-300 transition hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

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
  /** Explainable risk verdict from Praxis's task-risk policy engine. */
  risk?: { tier: "low" | "standard" | "high"; signals: string[] };
  /** Low-risk slot admitted by the project's standing-consent policy. */
  approvalSource?: "standing_consent" | null;
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

interface PruneProposalMeta {
  /** Groundskeeper proposal id (stable across runs). */
  id: string;
  kind: string;
  taskTitle?: string | null;
  projectName?: string | null;
  duplicateOfTitle?: string | null;
  detail: string;
  confidence: number;
}

type PruneDecision = "archive" | "keep";

interface QaSpotAuditMeta {
  origTaskId: string;
  title: string | null;
  author: string | null;
  reviewer: string | null;
  reviewedAt: string;
}

/**
 * Human verdict on a sampled QA pass: "ok" = the pass holds up, "flag" = it
 * doesn't (reviewer may have rubber-stamped). Rides back on Done's
 * `payload.auditDecisions` (origTaskId → verdict); the Praxis side records a
 * durable signal so a flagged pass isn't lost. Undecided samples send nothing.
 */
type AuditDecision = "ok" | "flag";

interface ScheduleMetadata {
  kind: "day-schedule";
  date: string;
  nightlySummary: string | null;
  slots: ScheduleSlotMeta[];
}

interface SkillMetadata {
  kind: "skill-candidates";
  date: string;
  skillCandidates: SkillCandidateMeta[];
}

interface MaintenanceMetadata {
  kind: "board-maintenance";
  date: string;
  /** Groundskeeper archive proposals — decisions ride Done's payload.pruneDecisions. */
  pruneProposals?: PruneProposalMeta[];
  /** Monday QA spot-audit — Holds up/Flag verdicts ride Done's payload.auditDecisions. */
  qaSpotAudit?: QaSpotAuditMeta[];
}

/** Type-guard the open-typed metadata bag into our schedule shape. */
function asScheduleMetadata(meta: unknown): ScheduleMetadata | null {
  if (!meta || typeof meta !== "object") return null;
  const obj = meta as Record<string, unknown>;
  if (obj.kind !== "day-schedule") return null;
  if (!Array.isArray(obj.slots)) return null;
  return obj as unknown as ScheduleMetadata;
}

function asSkillMetadata(meta: unknown): SkillMetadata | null {
  if (!meta || typeof meta !== "object") return null;
  const obj = meta as Record<string, unknown>;
  if (obj.kind !== "skill-candidates") return null;
  if (!Array.isArray(obj.skillCandidates)) return null;
  return obj as unknown as SkillMetadata;
}

function asMaintenanceMetadata(meta: unknown): MaintenanceMetadata | null {
  if (!meta || typeof meta !== "object") return null;
  const obj = meta as Record<string, unknown>;
  if (obj.kind !== "board-maintenance") return null;
  return obj as unknown as MaintenanceMetadata;
}

export function isScheduleHitl(request: HITLRequest): boolean {
  return asScheduleMetadata(request.metadata) !== null;
}

export function isSkillCandidatesHitl(request: HITLRequest): boolean {
  return asSkillMetadata(request.metadata) !== null;
}

export function isBoardMaintenanceHitl(request: HITLRequest): boolean {
  return asMaintenanceMetadata(request.metadata) !== null;
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
    return <span className="text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-600">—</span>;
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
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-semibold ${tone}`}
    >
      🧩 {level}/5
    </span>
  );
}

function RiskBadge({ risk }: { risk: ScheduleSlotMeta["risk"] }) {
  const tier = risk?.tier ?? "standard";
  const tone =
    tier === "low"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : tier === "high"
        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
        : "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return (
    <span
      title={risk?.signals.length ? risk.signals.join(" · ") : "No matched risk signals"}
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-semibold tracking-wide ${tone}`}
    >
      {tier.toUpperCase()}
    </span>
  );
}

// ── Schedule card (kind "day-schedule") ─────────────────────────────────

export function ScheduleHitlCard({
  request,
  resolving,
  onResolve,
}: {
  request: HITLRequest;
  resolving: boolean;
  onResolve: ResolveFn;
}) {
  const schedule = useMemo(() => asScheduleMetadata(request.metadata), [request.metadata]);

  // Per-slot local override state, keyed by nexus_task_id (matches the
  // payload shape the Praxis side expects).
  const [executors, setExecutors] = useState<Record<string, ExecutorName>>(() => {
    if (!schedule) return {};
    return Object.fromEntries(schedule.slots.map((s) => [s.nexusTaskId, s.executor]));
  });
  const [skips, setSkips] = useState<Record<string, string>>({});
  const [revokedApprovals, setRevokedApprovals] = useState<Record<string, true>>({});
  const [skipDraft, setSkipDraft] = useState<{ taskId: string; reason: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Per-slot model override, keyed by nexus_task_id ("" = executor default).
  const [models, setModels] = useState<Record<string, string>>(() => {
    if (!schedule) return {};
    return Object.fromEntries(schedule.slots.map((s) => [s.nexusTaskId, s.modelOverride ?? ""]));
  });
  // Per-slot extra instructions typed before approving, keyed by
  // nexus_task_id. Sent as scheduleOverrides.instructions on Approve; the
  // Praxis side APPENDS them to the planner's instructions (never replaces).
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Per-executor model options for the per-slot Model dropdown — shared with
  // the task screen's dispatch console (use-executor-models).
  const { optionsFor: modelOptionsFor } = useExecutorModelOptions();
  const [error, setError] = useState<string | null>(null);
  const { scale: fontScale, adjust: adjustFontScale } = useMorningPlanFontScale();

  if (!schedule) {
    // Defensive — caller should have checked isScheduleHitl, but fall back
    // gracefully if metadata is malformed.
    return (
      <article className="rounded-lg border border-rose-700/40 bg-rose-950/40 p-3 text-[length:var(--hitl-fs-xs,0.75rem)] text-rose-200">
        Schedule HITL is missing structured slot data.
      </article>
    );
  }

  const skipCount = Object.keys(skips).length;
  const revokedCount = Object.keys(revokedApprovals).filter(
    (taskId) => skips[taskId] === undefined,
  ).length;
  const executorChanges = schedule.slots.filter(
    (s) => executors[s.nexusTaskId] !== s.executor,
  ).length;
  const activeCount = schedule.slots.length - skipCount - revokedCount;
  const noteCount = schedule.slots.filter(
    (s) => skips[s.nexusTaskId] === undefined && (notes[s.nexusTaskId] ?? "").trim() !== "",
  ).length;

  async function submit(choice: "approve" | "reject") {
    setError(null);
    try {
      if (choice === "reject") {
        await onResolve(request.id, { choice: "reject" });
        return;
      }

      // Build the scheduleOverrides payload — only include executors/models
      // that actually differ from the proposed defaults; always include skips.
      const executorOverrides: Record<string, string> = {};
      const modelOverrides: Record<string, string> = {};
      const instructionOverrides: Record<string, string> = {};
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
        // Notes on skipped slots stay local — a skipped slot never dispatches,
        // so sending its note would only confuse the audit trail.
        const note = (notes[slot.nexusTaskId] ?? "").trim();
        if (note && skips[slot.nexusTaskId] === undefined) {
          instructionOverrides[slot.nexusTaskId] = note;
        }
      }
      const hasExecutorChanges = Object.keys(executorOverrides).length > 0;
      const hasModelChanges = Object.keys(modelOverrides).length > 0;
      const hasSkips = Object.keys(skips).length > 0;
      const hasNotes = Object.keys(instructionOverrides).length > 0;
      const standingConsentRevocations = Object.keys(revokedApprovals).filter(
        (taskId) => skips[taskId] === undefined,
      );
      const hasStandingConsentRevocations = standingConsentRevocations.length > 0;

      const payload =
        hasExecutorChanges ||
        hasModelChanges ||
        hasSkips ||
        hasNotes ||
        hasStandingConsentRevocations
          ? {
              scheduleOverrides: {
                ...(hasExecutorChanges ? { executors: executorOverrides } : {}),
                ...(hasModelChanges ? { models: modelOverrides } : {}),
                ...(hasSkips ? { skips } : {}),
                ...(hasNotes ? { instructions: instructionOverrides } : {}),
                ...(hasStandingConsentRevocations ? { standingConsentRevocations } : {}),
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

  // Font scale rides down as CSS vars — each an absolute length so nested
  // text sizes keep their proportions (see useMorningPlanFontScale).
  const scaleStyle = {
    "--hitl-fs-xs": `calc(${fontScale} * 0.75rem)`,
    "--hitl-fs-11": `calc(${fontScale} * 0.6875rem)`,
    "--hitl-fs-10": `calc(${fontScale} * 0.625rem)`,
  } as CSSProperties;

  return (
    <article
      className="rounded-lg border border-cyan-500/30 bg-slate-950/60 p-3"
      style={scaleStyle}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-medium text-cyan-300">
            Morning Plan — {schedule.date}
          </span>
          <FontScaleControl scale={fontScale} onAdjust={adjustFontScale} />
        </div>
        <span className="text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-400">
          {activeCount} dispatching{skipCount > 0 ? `, ${skipCount} skipped` : ""}
          {revokedCount > 0 ? `, ${revokedCount} revoked` : ""}
          {executorChanges > 0 ? `, ${executorChanges} worker changes` : ""}
          {noteCount > 0 ? `, ${noteCount} note${noteCount === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      {schedule.nightlySummary ? (
        <div className="mb-3 rounded border border-slate-700/60 bg-slate-900/60 p-2 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-300">
          <span className="font-semibold text-cyan-300">Nightly:</span>{" "}
          {schedule.nightlySummary}
        </div>
      ) : null}

      <div className="mb-3 overflow-x-auto rounded border border-slate-700/60">
        <table className="w-full text-[length:var(--hitl-fs-xs,0.75rem)]">
          <thead className="bg-slate-900/60 text-slate-400">
            <tr>
              <th className="px-2 py-1 text-left font-semibold">#</th>
              <th className="px-2 py-1 text-left font-semibold">Task</th>
              <th className="px-2 py-1 text-left font-semibold">Risk</th>
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
              const hasNote = (notes[slot.nexusTaskId] ?? "").trim() !== "";
              const standingApproved =
                slot.approvalSource === "standing_consent" && slot.risk?.tier === "low";
              const isRevoked = standingApproved && revokedApprovals[slot.nexusTaskId] === true;
              const isInactive = isSkipped || isRevoked;
              return (
                <Fragment key={slot.nexusTaskId}>
                  <tr
                    className={`border-t border-slate-700/40 ${isInactive ? "opacity-50 line-through decoration-rose-400/60" : ""}`}
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
                          {standingApproved ? (
                            <span className="block text-[length:var(--hitl-fs-10,0.625rem)] font-medium text-emerald-300">
                              {isRevoked
                                ? "Standing consent · revoked"
                                : "Standing consent · pre-approved"}
                            </span>
                          ) : null}
                          <span className="block truncate text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
                            {hasNote && !isSkipped ? (
                              <span
                                className="text-cyan-300"
                                title="Instructions added — sent to the executor when you approve"
                              >
                                📝 note ·{" "}
                              </span>
                            ) : null}
                            {slot.workspace} · ~{slot.estimatedMinutes}min
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="px-2 py-1">
                      <RiskBadge risk={slot.risk} />
                    </td>
                    <td className="px-2 py-1">
                      <ComplexityBadge value={slot.complexity} />
                    </td>
                    <td className="px-2 py-1 text-slate-300">{formatTime(slot.startTime)}</td>
                    <td className="px-2 py-1">
                      <div className="flex flex-col gap-1">
                        <select
                          disabled={isInactive || resolving}
                          value={currentExec}
                          onChange={(e) => {
                            const nextExec = e.target.value as ExecutorName;
                            setExecutors((prev) => ({
                              ...prev,
                              [slot.nexusTaskId]: nextExec,
                            }));
                            // A chosen model is executor-specific — clear it so
                            // the slot rides the new executor's default.
                            setModels((prev) => ({ ...prev, [slot.nexusTaskId]: "" }));
                          }}
                          className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-200 outline-none focus:border-cyan-500 disabled:cursor-not-allowed"
                        >
                          {EXECUTOR_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                        {(() => {
                          const { options, fallback, note } = modelOptionsFor(currentExec);
                          const chosen = models[slot.nexusTaskId] ?? "";
                          return (
                            <select
                              disabled={isInactive || resolving}
                              value={chosen}
                              onChange={(e) =>
                                setModels((prev) => ({
                                  ...prev,
                                  [slot.nexusTaskId]: e.target.value,
                                }))
                              }
                              title={`${currentExec} model for this slot (billed to the ${note} subscription)`}
                              className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-purple-200 outline-none focus:border-purple-500 disabled:cursor-not-allowed"
                            >
                              <option value="">default ({fallback || "CLI default"})</option>
                              {options.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.label}
                                </option>
                              ))}
                              {/* Keep a Praxis-proposed value selectable even if
                                  it isn't in this executor's option list */}
                              {chosen && !options.some((m) => m.id === chosen) && (
                                <option value={chosen}>{chosen}</option>
                              )}
                            </select>
                          );
                        })()}
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
                          className="rounded border border-slate-700 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
                        >
                          Restore
                        </button>
                      ) : (
                        <div className="flex justify-end gap-1">
                          {standingApproved ? (
                            <button
                              disabled={resolving}
                              onClick={() =>
                                setRevokedApprovals((prev) => {
                                  const next = { ...prev };
                                  if (next[slot.nexusTaskId]) delete next[slot.nexusTaskId];
                                  else next[slot.nexusTaskId] = true;
                                  return next;
                                })
                              }
                              className="rounded border border-emerald-500/40 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-emerald-300 hover:border-emerald-400 disabled:opacity-50"
                            >
                              {isRevoked ? "Restore approval" : "Revoke approval"}
                            </button>
                          ) : null}
                          <button
                            disabled={resolving}
                            onClick={() =>
                              setSkipDraft({ taskId: slot.nexusTaskId, reason: "" })
                            }
                            className="inline-flex items-center gap-1 rounded border border-rose-500/40 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-rose-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" /> Skip
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr key={`${slot.nexusTaskId}-detail`} className="border-t border-slate-700/40 bg-slate-900/40">
                      <td colSpan={7} className="px-3 py-2">
                        <div className="space-y-2 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-300">
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
                          <div>
                            <span className="font-semibold text-cyan-300">Risk signals:</span>{" "}
                            <span>
                              {slot.risk?.signals.length
                                ? slot.risk.signals.join(" · ")
                                : "No matched signals"}
                            </span>
                          </div>
                          <div>
                            <label className="mb-1 block font-semibold text-cyan-300">
                              Add instructions for this run:
                            </label>
                            <textarea
                              value={notes[slot.nexusTaskId] ?? ""}
                              disabled={isInactive || resolving}
                              onChange={(e) =>
                                setNotes((prev) => ({
                                  ...prev,
                                  [slot.nexusTaskId]: e.target.value,
                                }))
                              }
                              placeholder="e.g. use the staging DB, not prod"
                              className="min-h-14 w-full resize-y rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-100 outline-none focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                            />
                            <p className="mt-0.5 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
                              Appended to the planner&apos;s instructions and sent to the executor
                              when you approve the plan.
                            </p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {isDraftingSkip ? (
                    <tr key={`${slot.nexusTaskId}-draft`} className="border-t border-slate-700/40 bg-rose-950/20">
                      <td colSpan={7} className="px-2 py-2">
                        <label className="mb-1 block text-[length:var(--hitl-fs-11,0.6875rem)] text-rose-300">
                          Skip reason (recorded on the task and written to Cortex memory so Praxis stops re-proposing it):
                        </label>
                        <textarea
                          autoFocus
                          value={skipDraft.reason}
                          onChange={(e) =>
                            setSkipDraft((prev) => (prev ? { ...prev, reason: e.target.value } : prev))
                          }
                          placeholder="e.g. already built the ios widget outside Praxis"
                          className="mb-2 min-h-16 w-full resize-y rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-100 outline-none focus:border-rose-400"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setSkipDraft(null)}
                            className="rounded border border-slate-700 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-300 hover:border-slate-500"
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
                              setRevokedApprovals((prev) => {
                                const next = { ...prev };
                                delete next[skipDraft.taskId];
                                return next;
                              });
                              setSkipDraft(null);
                            }}
                            className="rounded bg-rose-500 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-semibold text-slate-950 hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
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
        <div className="mb-2 flex items-center gap-1 text-[length:var(--hitl-fs-11,0.6875rem)] text-rose-300">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          disabled={resolving}
          onClick={() => void submit("reject")}
          className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-[length:var(--hitl-fs-xs,0.75rem)] text-slate-300 hover:border-rose-400 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" /> Reject
        </button>
        <button
          disabled={resolving || activeCount === 0}
          onClick={() => void submit("approve")}
          className="inline-flex items-center gap-1 rounded-md bg-cyan-500 px-3 py-1.5 text-[length:var(--hitl-fs-xs,0.75rem)] font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
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
    </article>
  );
}

// ── Skill-candidates card (kind "skill-candidates") ─────────────────────

export function SkillCandidatesHitlCard({
  request,
  resolving,
  onResolve,
}: {
  request: HITLRequest;
  resolving: boolean;
  onResolve: ResolveFn;
}) {
  const meta = useMemo(() => asSkillMetadata(request.metadata), [request.metadata]);
  // Each candidate decides immediately (2026-07-03) and independently of the
  // Done button below. "approved"/"archived" are terminal here; undecided
  // candidates stay staged and reappear tomorrow.
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

  if (!meta) {
    return (
      <article className="rounded-lg border border-rose-700/40 bg-rose-950/40 p-3 text-[length:var(--hitl-fs-xs,0.75rem)] text-rose-200">
        Skill-candidates HITL is missing structured data.
      </article>
    );
  }

  const candidates = meta.skillCandidates;
  const decidedCount = candidates.filter(
    (c) => candidateStates[c.id] === "approved" || candidateStates[c.id] === "archived",
  ).length;

  return (
    <article className="rounded-lg border border-violet-500/30 bg-slate-950/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-medium text-violet-300">
          🧩 Skill Candidates — {meta.date}
        </span>
        <span className="text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-400">
          {decidedCount}/{candidates.length} decided
        </span>
      </div>

      <p className="mb-2 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-400">
        Each decision applies immediately (approve installs into the live skill library; archive
        moves to _rejected/). Undecided candidates stay for tomorrow. Tap <b>Done</b> to clear this
        from your inbox.
      </p>

      <ul className="mb-3 divide-y divide-slate-700/40 overflow-hidden rounded border border-slate-700/60">
        {candidates.map((candidate) => {
          const state = candidateStates[candidate.id];
          return (
            <li key={candidate.id} className="flex items-start justify-between gap-2 px-2 py-1.5">
              <div className="min-w-0 text-[length:var(--hitl-fs-xs,0.75rem)]">
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
                  <span className="shrink-0 rounded-full border border-slate-700 px-1.5 py-0 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-400">
                    {candidate.category}
                  </span>
                </div>
                <div className="mt-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-400">{candidate.summary}</div>
                {candidate.sourceTitle ? (
                  <div className="mt-0.5 truncate text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
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
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] disabled:cursor-not-allowed disabled:opacity-50 ${
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
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] disabled:cursor-not-allowed disabled:opacity-50 ${
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

      {error ? (
        <div className="mb-2 flex items-center gap-1 text-[length:var(--hitl-fs-11,0.6875rem)] text-rose-300">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          disabled={resolving}
          onClick={() => void onResolve(request.id, { choice: "done" })}
          className="inline-flex items-center gap-1 rounded-md bg-violet-500 px-3 py-1.5 text-[length:var(--hitl-fs-xs,0.75rem)] font-bold text-slate-950 transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {resolving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {resolving ? "Clearing..." : "Done"}
        </button>
      </div>
    </article>
  );
}

// ── Board-maintenance card (kind "board-maintenance") ───────────────────

export function BoardMaintenanceHitlCard({
  request,
  resolving,
  onResolve,
}: {
  request: HITLRequest;
  resolving: boolean;
  onResolve: ResolveFn;
}) {
  const meta = useMemo(() => asMaintenanceMetadata(request.metadata), [request.metadata]);
  // Groundskeeper decisions are batched into the Done payload — toggling a
  // button stages the decision; Done sends it.
  const [pruneDecisions, setPruneDecisions] = useState<Record<string, PruneDecision>>({});
  // QA spot-audit verdicts ride the same Done payload (origTaskId → verdict).
  const [auditDecisions, setAuditDecisions] = useState<Record<string, AuditDecision>>({});
  const [error, setError] = useState<string | null>(null);

  function togglePruneDecision(id: string, decision: PruneDecision) {
    setPruneDecisions((prev) => {
      const next = { ...prev };
      if (next[id] === decision) delete next[id];
      else next[id] = decision;
      return next;
    });
  }

  function toggleAuditDecision(origTaskId: string, decision: AuditDecision) {
    setAuditDecisions((prev) => {
      const next = { ...prev };
      if (next[origTaskId] === decision) delete next[origTaskId];
      else next[origTaskId] = decision;
      return next;
    });
  }

  async function done() {
    setError(null);
    try {
      const hasPrune = Object.keys(pruneDecisions).length > 0;
      const hasAudit = Object.keys(auditDecisions).length > 0;
      const payload =
        hasPrune || hasAudit
          ? {
              ...(hasPrune ? { pruneDecisions } : {}),
              ...(hasAudit ? { auditDecisions } : {}),
            }
          : undefined;
      await onResolve(request.id, {
        choice: "done",
        ...(payload ? { payload } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolution failed");
    }
  }

  if (!meta) {
    return (
      <article className="rounded-lg border border-rose-700/40 bg-rose-950/40 p-3 text-[length:var(--hitl-fs-xs,0.75rem)] text-rose-200">
        Board-maintenance HITL is missing structured data.
      </article>
    );
  }

  const proposals = meta.pruneProposals ?? [];
  const audit = meta.qaSpotAudit ?? [];

  return (
    <article className="rounded-lg border border-amber-500/30 bg-slate-950/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] font-medium text-amber-300">
          🧹 Board Maintenance — {meta.date}
        </span>
        <span className="text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-400">
          {proposals.length} proposal{proposals.length === 1 ? "" : "s"}
          {audit.length > 0 ? ` · ${audit.length} QA sample${audit.length === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      {proposals.length > 0 ? (
        <div className="mb-3 overflow-hidden rounded border border-amber-500/30">
          <div className="flex items-center justify-between bg-amber-500/10 px-2 py-1">
            <span className="text-[length:var(--hitl-fs-11,0.6875rem)] font-semibold text-amber-300">Archive proposals</span>
            <span className="text-[length:var(--hitl-fs-10,0.625rem)] text-slate-400">
              Sent with Done · Keep suppresses re-proposal 30d · Undecided → stays for next card ·
              Nothing archives without you
            </span>
          </div>
          <ul className="divide-y divide-slate-700/40">
            {proposals.map((proposal) => {
              const decision = pruneDecisions[proposal.id];
              return (
                <li key={proposal.id} className="flex items-start justify-between gap-2 px-2 py-1.5">
                  <div className="min-w-0 text-[length:var(--hitl-fs-xs,0.75rem)]">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`truncate font-semibold ${
                          decision === "archive"
                            ? "text-slate-500 line-through decoration-rose-400/60"
                            : "text-slate-100"
                        }`}
                      >
                        {proposal.taskTitle ?? proposal.projectName ?? proposal.id}
                      </span>
                      <span className="shrink-0 rounded-full border border-slate-700 px-1.5 py-0 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-400">
                        {proposal.kind}
                      </span>
                      <span className="shrink-0 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
                        {Math.round(proposal.confidence * 100)}%
                      </span>
                    </div>
                    <div className="mt-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] text-slate-400">{proposal.detail}</div>
                    {proposal.projectName && proposal.taskTitle ? (
                      <div className="mt-0.5 text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
                        in: {proposal.projectName}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1 pt-0.5">
                    <button
                      onClick={() => togglePruneDecision(proposal.id, "archive")}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] ${
                        decision === "archive"
                          ? "border-rose-400 bg-rose-500/20 text-rose-200"
                          : "border-slate-700 text-slate-300 hover:border-rose-400 hover:text-rose-300"
                      }`}
                      title="Stage for archive — applied when you tap Done (soft, reversible status flip)"
                    >
                      <Trash2 className="h-3 w-3" />
                      {decision === "archive" ? "Archiving" : "Archive"}
                    </button>
                    <button
                      onClick={() => togglePruneDecision(proposal.id, "keep")}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] ${
                        decision === "keep"
                          ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                          : "border-slate-700 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
                      }`}
                      title="Keep — Groundskeeper won't re-propose this for 30 days"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      {decision === "keep" ? "Keeping" : "Keep"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {audit.length > 0 ? (
        <div className="mb-3 overflow-hidden rounded border border-sky-500/30">
          <div className="flex items-center justify-between bg-sky-500/10 px-2 py-1">
            <span className="text-[length:var(--hitl-fs-11,0.6875rem)] font-semibold text-sky-300">
              🔍 QA spot-audit — {audit.length} sampled pass{audit.length === 1 ? "" : "es"} from last week
            </span>
            <span className="text-[length:var(--hitl-fs-10,0.625rem)] text-slate-400">
              Open the task to read the reviewer&apos;s verdict — does the pass hold up?
            </span>
          </div>
          <ul className="divide-y divide-slate-700/40">
            {audit.map((sample) => {
              const verdict = auditDecisions[sample.origTaskId];
              return (
                <li
                  key={sample.origTaskId}
                  className="flex items-start justify-between gap-2 px-2 py-1.5 text-[length:var(--hitl-fs-xs,0.75rem)]"
                >
                  <Link
                    href={`/task/${sample.origTaskId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="group min-w-0 flex-1"
                    title="Open the reviewed task in a new tab — includes the QA review transcript"
                  >
                    <span className="flex items-center gap-1 font-semibold text-slate-100 group-hover:text-sky-300">
                      <span className="truncate">{sample.title ?? sample.origTaskId}</span>
                      <ExternalLink className="h-3 w-3 shrink-0 text-slate-500 group-hover:text-sky-300" />
                    </span>
                    <span className="mt-0.5 block text-[length:var(--hitl-fs-10,0.625rem)] text-slate-500">
                      {sample.origTaskId.slice(0, 8)} · by {sample.author ?? "?"} · reviewed by{" "}
                      {sample.reviewer ?? "?"} · {new Date(sample.reviewedAt).toLocaleDateString()}
                    </span>
                  </Link>
                  <div className="flex shrink-0 gap-1 pt-0.5">
                    <button
                      onClick={() => toggleAuditDecision(sample.origTaskId, "ok")}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] ${
                        verdict === "ok"
                          ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                          : "border-slate-700 text-slate-300 hover:border-emerald-400 hover:text-emerald-300"
                      }`}
                      title="The pass holds up — recorded when you tap Done"
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Holds up
                    </button>
                    <button
                      onClick={() => toggleAuditDecision(sample.origTaskId, "flag")}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[length:var(--hitl-fs-11,0.6875rem)] ${
                        verdict === "flag"
                          ? "border-rose-400 bg-rose-500/20 text-rose-200"
                          : "border-slate-700 text-slate-300 hover:border-rose-400 hover:text-rose-300"
                      }`}
                      title="The pass does NOT hold up — records a durable re-review signal on Done"
                    >
                      <Flag className="h-3 w-3" />
                      Flag
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {error ? (
        <div className="mb-2 flex items-center gap-1 text-[length:var(--hitl-fs-11,0.6875rem)] text-rose-300">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          disabled={resolving}
          onClick={() => void done()}
          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-[length:var(--hitl-fs-xs,0.75rem)] font-bold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {resolving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {resolving ? "Clearing..." : "Done"}
        </button>
      </div>
    </article>
  );
}
