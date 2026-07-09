import { z } from "zod";

/**
 * THE canonical single-axis board status for Nexus tasks — the one enum every
 * process boundary validates against (2026-07-05 unification; the live board
 * had drifted to three completion synonyms: complete=136 / done=66 /
 * completed=8 rows).
 *
 * Writers MUST store these exact values. Legacy synonyms are normalized at
 * the TheNexus DB write layer via LEGACY_TASK_STATUS_MAP; anything not in the
 * enum and not in the map is rejected at the API.
 */
export const TaskBoardStatusSchema = z.enum([
  "idea",
  "planning",
  "todo",
  "scheduled",
  "dispatched",
  "in_progress",
  "needs_input",
  "blocked",
  "ready_for_review",
  "review",
  "completed",
  "failed",
  "cancelled",
  "archived",
]);
export type TaskBoardStatus = z.infer<typeof TaskBoardStatusSchema>;

/** Legacy → canonical. Keys are lowercase; match after trim + lowercase. */
export const LEGACY_TASK_STATUS_MAP: Record<string, TaskBoardStatus> = {
  complete: "completed",
  done: "completed",
  ready: "todo",
  "in-progress": "in_progress",
  active: "in_progress",
  canceled: "cancelled",
  error: "failed",
  plan: "planning",
};

/**
 * Normalize any historical status spelling to the canonical enum.
 * Returns null for values that are neither canonical nor mapped legacy —
 * callers decide whether that is a validation error (API) or a
 * warn-and-passthrough (backstops).
 */
export function normalizeTaskBoardStatus(raw: unknown): TaskBoardStatus | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const parsed = TaskBoardStatusSchema.safeParse(s);
  if (parsed.success) return parsed.data;
  return LEGACY_TASK_STATUS_MAP[s] ?? null;
}

/**
 * The canonical "counts as complete" predicate for task sequencing. Accepts
 * raw status strings (legacy synonyms normalize first) so pre-unification
 * rows sequence correctly.
 */
export function isTaskDone(rawStatus: unknown): boolean {
  return normalizeTaskBoardStatus(rawStatus) === "completed";
}

/**
 * Statuses that mean a task's execution has started. The predecessor gate
 * fires on transitions INTO these; tasks already in one are never re-gated.
 */
export const TASK_START_STATUSES: readonly TaskBoardStatus[] = [
  "dispatched",
  "in_progress",
];

/** True when a raw status normalizes to a started state. */
export function isTaskStarted(rawStatus: unknown): boolean {
  const s = normalizeTaskBoardStatus(rawStatus);
  return s !== null && (TASK_START_STATUSES as string[]).includes(s);
}

/**
 * Statuses a successor may be auto-started from. Anything else is either
 * already running, terminal, or owned by another scheduler (e.g.
 * `scheduled` belongs to the day schedule).
 */
export const TASK_AUTO_START_STATUSES: readonly TaskBoardStatus[] = [
  "idea",
  "planning",
  "todo",
  "blocked",
];

/**
 * Task sequencing — the machine layer that turns a flat board into a chain.
 *
 * `dependencies` are PREDECESSORS: every listed task id must be `completed`
 * before this task may start (dispatch and status transitions into
 * TASK_START_STATUSES are gated on it). Many allowed.
 *
 * `successor_id` is THE successor: the single task to start immediately
 * after this one completes. One per task by design — a completion hands the
 * baton to exactly one next task (fan-out belongs to predecessors on the
 * other side; fan-in — several tasks naming the same successor — is fine).
 */
export const TaskSequenceSchema = z.object({
  dependencies: z.array(z.string()).default([]),
  successor_id: z.string().nullable().optional(),
});
export type TaskSequence = z.infer<typeof TaskSequenceSchema>;

/**
 * The machine-execution payload (dual-layer task standard: `description` is
 * the human layer, this is the executor layer). `prompt` states the use
 * case / intended outcome and areas impacted — intent and scope, not
 * prescriptive coding steps.
 */
export const AntigravityPayloadSchema = z.object({
  prompt: z.string(),
  workspace: z.string().optional(),
  target_files: z.array(z.string()).optional(),
  context_files: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
});
export type AntigravityPayload = z.infer<typeof AntigravityPayloadSchema>;

/**
 * Canonical create-task input — the ONE shape every creation surface
 * (TheNexus POST /api/tasks + /api/tasks/batch items, praxis-mind MCP
 * nexus_task_create, Praxis nexus_tasks action=create, dashboard, mobile)
 * validates against. Field names are the wire/db spelling (snake_case).
 *
 * `stable_id` lets batch payloads reference sibling tasks in
 * `dependencies`/`successor_id` before real ids exist; the batch endpoint
 * remaps them.
 */
export const TaskCreateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  status: TaskBoardStatusSchema.default("idea"),
  priority: z.number().int().min(0).max(3).default(1),
  sort_order: z.number().int().optional(),
  antigravity_payload: AntigravityPayloadSchema.optional(),
  dependencies: z.array(z.string()).default([]),
  successor_id: z.string().nullable().optional(),
  stable_id: z.string().optional(),
  source: z.string().optional(),
  model_assignment: z.string().nullable().optional(),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const TaskLifecycleStageSchema = z.enum([
  "idea",
  "research",
  "plan",
  "build",
  "review",
  "done",
  "cancelled",
]);
export type TaskLifecycleStage = z.infer<typeof TaskLifecycleStageSchema>;

export const TaskExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "complete",
  "failed",
]);
export type TaskExecutionStatus = z.infer<typeof TaskExecutionStatusSchema>;

export const TaskPrioritySchema = z.enum(["low", "medium", "high", "critical"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().optional(),

  lifecycleStage: TaskLifecycleStageSchema,
  executionStatus: TaskExecutionStatusSchema,
  priority: TaskPrioritySchema.optional(),

  assignee: z.string().optional(),
  parentTaskId: z.string().optional(),
  executorId: z.string().optional(),

  /** Predecessor task ids — all must be completed before this task starts. */
  dependencies: z.array(z.string()).optional(),
  /** The single task to auto-start immediately after this one completes. */
  successorId: z.string().nullable().optional(),

  tags: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),

  scheduledFor: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),

  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskPatchSchema = TaskSchema.partial().extend({
  id: z.string(),
});
export type TaskPatch = z.infer<typeof TaskPatchSchema>;
