/**
 * The standard run-trace field list, client side (server:
 * server/services/run-trace.js, contract: docs/contracts/run-trace.md).
 *
 * The attribution surface reports every run against a fixed list of eight
 * fields. The rule these helpers exist to enforce is that a field is either
 * OBSERVED or UNKNOWN-with-a-reason, and the UI must never let the two read
 * alike: "0 retries" and "no retry telemetry" are different facts, and a
 * surface that renders both as a blank has told the reader neither.
 *
 * So there is no formatter here that returns a bare number. Completeness
 * always comes back as "6 of 8", and the reason tally always accompanies it.
 */

/** Why a run-trace field carries no value. Mirrors UNKNOWN_REASONS server side. */
export type TraceUnknownReason =
  | "not_instrumented"
  | "not_recorded"
  | "spine_unavailable"
  | "run_in_flight"
  | "no_dispatch_match"
  | "not_queried";

export type RunTraceFieldKey =
  | "runId"
  | "agentVersion"
  | "modelCalls"
  | "toolCalls"
  | "retries"
  | "approvals"
  | "errors"
  | "finalOutcome";

export type RunTraceField =
  | { known: true; value: unknown }
  | { known: false; reason: TraceUnknownReason; detail: string | null; evidence?: unknown };

export interface RunTraceCompleteness {
  requiredFields: number;
  observedFields: number;
  /** null while the run is in flight: a trace still being written is not scorable. */
  ratio: number | null;
  pending: boolean;
  missing: Array<{ field: RunTraceFieldKey; reason: TraceUnknownReason }>;
}

export interface RunTrace {
  version: number;
  terminal: boolean;
  fields: Record<RunTraceFieldKey, RunTraceField>;
  completeness: RunTraceCompleteness;
}

/** A measure that could not be computed, with the reason in place of a number. */
export interface UnknownMeasure {
  rate?: null;
  count?: null;
  known: false;
  reason: string;
  detail: string;
  nearest?: string;
}

export interface RateMeasure {
  rate: number | null;
  [k: string]: unknown;
}

export interface TraceQuality {
  version: number;
  runs: number;
  terminalRuns: number;
  inFlightRuns: number;
  decisionQuality: {
    taskSuccess: RateMeasure & { successes: number; terminalRuns: number };
    incorrectAction: UnknownMeasure;
    humanRejection: UnknownMeasure;
    humanCorrection: UnknownMeasure;
    reviewerRejection: RateMeasure | UnknownMeasure;
    reviewerCorrection: RateMeasure | UnknownMeasure;
  };
  executionReliability: {
    toolCallSuccess: UnknownMeasure;
    workflowCompletion: RateMeasure & { completed: number; runs: number };
    retryRate: RateMeasure | UnknownMeasure;
    escalationRate: RateMeasure & { escalations: number; terminalRuns: number };
  };
  controlEffectiveness: {
    approvalViolations: UnknownMeasure;
    staleStateFailures: (RateMeasure & { count: number }) | UnknownMeasure;
    auditTraceCompleteness: {
      mean: number | null;
      scoredRuns: number;
      requiredFields: number;
      uninstrumentedFields: RunTraceFieldKey[];
      missingByField: Partial<Record<RunTraceFieldKey, number>>;
    };
  };
  operationalPerformance: { known: false; reason: string; detail: string };
}

/** The field list in report order, with the labels the source names them by. */
export const RUN_TRACE_FIELD_LABELS: Record<RunTraceFieldKey, string> = {
  runId: "run ID",
  agentVersion: "agent or workflow version",
  modelCalls: "model calls",
  toolCalls: "tool calls",
  retries: "retries",
  approvals: "approvals",
  errors: "errors",
  finalOutcome: "final outcome",
};

const REASON_LABELS: Record<TraceUnknownReason, string> = {
  not_instrumented: "nothing records it yet",
  not_recorded: "this run left no record",
  spine_unavailable: "Praxis's run-events spine was unreadable",
  run_in_flight: "the run has not finished",
  no_dispatch_match: "no run behind this activity",
  not_queried: "not read by this surface",
};

/**
 * "6 of 8 trace fields" for a scored run, and the honest alternatives for the
 * two cases that are NOT a low score: a run still in flight, and an activity
 * with no run behind it at all.
 */
export function formatTraceCompleteness(trace: RunTrace | null | undefined): string {
  if (!trace) return "no trace";
  const { observedFields, requiredFields, pending, missing } = trace.completeness;
  if (missing.length === requiredFields && missing.every((m) => m.reason === "no_dispatch_match")) {
    return "no run to trace";
  }
  if (pending) return `${observedFields} of ${requiredFields} trace fields (run in flight)`;
  return `${observedFields} of ${requiredFields} trace fields`;
}

/**
 * Tooltip body: which required fields are missing and why, grouped by reason
 * so a reader sees "two fields nothing records yet" as one fact rather than
 * as two separate failures of this particular run.
 */
export function describeTraceGaps(trace: RunTrace | null | undefined): string {
  if (!trace || trace.completeness.missing.length === 0) return "";
  const byReason = new Map<TraceUnknownReason, RunTraceFieldKey[]>();
  for (const m of trace.completeness.missing) {
    if (!byReason.has(m.reason)) byReason.set(m.reason, []);
    byReason.get(m.reason)!.push(m.field);
  }
  return [...byReason.entries()]
    .map(([reason, fields]) =>
      `${fields.map((f) => RUN_TRACE_FIELD_LABELS[f]).join(", ")}: ${REASON_LABELS[reason]}`)
    .join(" · ");
}

/**
 * "mean 0.75 over 12 runs" for the task-level audit-trace completeness, never
 * a bare percentage: the number of runs behind it is half the fact. Returns
 * the no-score case explicitly rather than a misleading 0.
 */
export function formatAuditCompleteness(quality: TraceQuality | null | undefined): string {
  const audit = quality?.controlEffectiveness?.auditTraceCompleteness;
  if (!audit || audit.scoredRuns === 0 || audit.mean == null) return "no finished runs to score";
  const pct = Math.round(audit.mean * 100);
  return `${pct}% mean trace completeness over ${audit.scoredRuns} finished run${audit.scoredRuns === 1 ? "" : "s"}`;
}

/**
 * The ceiling note that must ride with the number above. Fields nothing in
 * the fleet records cap every run's score, so a reader seeing 75% is told
 * that it is a fleet instrumentation gap and not this task running badly.
 */
export function describeCompletenessCeiling(quality: TraceQuality | null | undefined): string {
  const audit = quality?.controlEffectiveness?.auditTraceCompleteness;
  if (!audit || audit.uninstrumentedFields.length === 0) return "";
  const names = audit.uninstrumentedFields.map((f) => RUN_TRACE_FIELD_LABELS[f]).join(" and ");
  const ceiling = Math.round(
    ((audit.requiredFields - audit.uninstrumentedFields.length) / audit.requiredFields) * 100,
  );
  return `Nothing in the fleet records ${names} yet, so no run can score above ${ceiling}%.`;
}
