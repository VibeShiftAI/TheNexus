import { z } from "zod";

export const PresenceActivitySchema = z.enum([
  "idle",
  "thinking",
  "executing",
  "waiting",
  "sleeping",
  "blocked",
  "offline",
]);
export type PresenceActivity = z.infer<typeof PresenceActivitySchema>;

export const PresenceBudgetSchema = z.object({
  dailyCallsRemaining: z.number().int().nonnegative().optional(),
  dailyCallsUsed: z.number().int().nonnegative().optional(),
  hardLimit: z.number().int().positive().optional(),
  autonomousLimit: z.number().int().positive().optional(),
  warningThreshold: z.number().int().positive().optional(),
  resetAt: z.string().datetime().optional(),
});
export type PresenceBudget = z.infer<typeof PresenceBudgetSchema>;

export const PresenceStateSchema = z.object({
  activity: PresenceActivitySchema,
  summary: z.string().optional(),

  currentTaskId: z.string().optional(),
  currentExecutorId: z.string().optional(),
  blockedOnHitlId: z.string().optional(),

  nextWakeAt: z.string().datetime().optional(),
  scheduledTaskCount: z.number().int().nonnegative().optional(),
  completedTasksToday: z.number().int().nonnegative().optional(),

  lastHeartbeatAt: z.string().datetime(),
  sessionStartedAt: z.string().datetime().optional(),

  budget: PresenceBudgetSchema.optional(),

  thinkingTrace: z.string().optional(),
});
export type PresenceState = z.infer<typeof PresenceStateSchema>;
