/**
 * HITL request display helpers — shared by the sidebar inbox card and the
 * pop-up inbox window.
 *
 * Praxis enriches task-question HITLs with `metadata.taskTitle` /
 * `projectName` at creation (2026-07-09); older records carry only `taskId`.
 * Readers must degrade gracefully: every accessor here returns undefined
 * rather than throwing on sparse records.
 */
import type { HITLRequest } from "@praxis/contract";

export interface HitlTaskMeta {
  kind?: string;
  executor?: string;
  taskTitle?: string;
  projectId?: string;
  projectName?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function hitlTaskMeta(request: HITLRequest): HitlTaskMeta {
  const m = (request.metadata ?? {}) as Record<string, unknown>;
  return {
    kind: str(m.kind),
    executor: str(m.executor),
    taskTitle: str(m.taskTitle),
    projectId: str(m.projectId),
    projectName: str(m.projectName),
  };
}

export interface ResumeContext {
  /** Human-readable part of the suspend blob (question + resume context). */
  context: string;
  /** Raw executor output tail — noisy, render in a collapsed monospace pane. */
  tail: string;
}

/**
 * Split an executor suspend blob into readable context vs raw output tail.
 * The blob format comes from postExecutorSuspension (Praxis
 * src/executors/executor-callback.ts): "...Resume context:\n<ctx>\n\nRaw
 * executor output tail:\n<tail>". Records without the marker are all context.
 */
export function parseResumeContext(prompt: string | undefined): ResumeContext {
  if (!prompt) return { context: "", tail: "" };
  const marker = "Raw executor output tail:";
  const idx = prompt.indexOf(marker);
  if (idx === -1) return { context: prompt.trim(), tail: "" };
  return {
    context: prompt.slice(0, idx).trim(),
    tail: prompt.slice(idx + marker.length).trim(),
  };
}

/** Priority → left-rail accent classes for inbox cards. */
export const PRIORITY_TONES: Record<string, { rail: string; chip: string }> = {
  critical: { rail: "bg-rose-500", chip: "bg-rose-400/10 text-rose-300" },
  high: { rail: "bg-amber-400", chip: "bg-amber-400/10 text-amber-300" },
  normal: { rail: "bg-cyan-400", chip: "bg-cyan-400/10 text-cyan-300" },
  low: { rail: "bg-slate-500", chip: "bg-slate-500/10 text-slate-400" },
};

export const REASON_LABELS: Record<string, string> = {
  low_confidence: "Low confidence",
  subjective_validation: "Validation",
  explicit_request: "Input requested",
  ontological_guard: "Guardrail",
  budget_gate: "Budget gate",
};
