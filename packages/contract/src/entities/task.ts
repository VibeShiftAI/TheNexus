import { z } from "zod";

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
