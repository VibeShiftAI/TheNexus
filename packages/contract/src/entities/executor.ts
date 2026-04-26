import { z } from "zod";

export const ExecutorNameSchema = z.enum([
  "antigravity",
  "codex",
  "claude-code",
  "inline",
]);
export type ExecutorName = z.infer<typeof ExecutorNameSchema>;

export const ExecutorStatusSchema = z.enum([
  "available",
  "busy",
  "degraded",
  "unavailable",
]);
export type ExecutorStatus = z.infer<typeof ExecutorStatusSchema>;

export const ExecutorSchema = z.object({
  id: z.string(),
  name: ExecutorNameSchema,
  displayName: z.string(),
  status: ExecutorStatusSchema,
  capabilities: z.array(z.string()).optional(),
  currentTaskId: z.string().optional(),
  lastHealthCheckAt: z.string().datetime().optional(),
});
export type Executor = z.infer<typeof ExecutorSchema>;

export const ExecutionRequestSchema = z.object({
  taskId: z.string(),
  projectId: z.string().optional(),
  title: z.string(),
  description: z.string(),
  instructions: z.string().optional(),
  workspace: z.string(),
  scheduledFor: z.string().datetime().optional(),
  modelOverride: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const ExecutionOutcomeSchema = z.enum([
  "success",
  "failure",
  "timeout",
  "cancelled",
]);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

export const ExecutionResultSchema = z.object({
  executor: ExecutorNameSchema,
  outcome: ExecutionOutcomeSchema,
  summary: z.string(),
  rawOutput: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  diffPatch: z.string().optional(),
  commitHash: z.string().optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const ExecutionPhaseSchema = z.enum([
  "dispatching",
  "loading",
  "thinking",
  "writing",
  "testing",
  "committing",
  "completing",
]);
export type ExecutionPhase = z.infer<typeof ExecutionPhaseSchema>;

export const ExecutionProgressSchema = z.object({
  taskId: z.string(),
  executor: ExecutorNameSchema,
  phase: ExecutionPhaseSchema,
  message: z.string().optional(),
  progressPct: z.number().min(0).max(100).optional(),
  at: z.string().datetime(),
});
export type ExecutionProgress = z.infer<typeof ExecutionProgressSchema>;
