import { z } from "zod";
import { TaskSchema, TaskPatchSchema } from "../entities/task.js";
import { PresenceStateSchema } from "../entities/presence.js";
import { HITLRequestSchema, HITLResolutionSchema } from "../entities/hitl.js";
import {
  ExecutorNameSchema,
  ExecutionResultSchema,
  ExecutionProgressSchema,
} from "../entities/executor.js";
import {
  TradeSignalSchema,
  RiskVerdictSchema,
  FillSchema,
} from "../entities/trading.js";

const baseEvent = z.object({
  at: z.string().datetime(),
  eventId: z.string(),
});

export const PresenceChangedEventSchema = baseEvent.extend({
  type: z.literal("presence.changed"),
  presence: PresenceStateSchema,
});

export const TaskCreatedEventSchema = baseEvent.extend({
  type: z.literal("task.created"),
  task: TaskSchema,
});

export const TaskUpdatedEventSchema = baseEvent.extend({
  type: z.literal("task.updated"),
  patch: TaskPatchSchema,
});

export const TaskStartedEventSchema = baseEvent.extend({
  type: z.literal("task.started"),
  taskId: z.string(),
  executor: ExecutorNameSchema,
});

export const TaskCompletedEventSchema = baseEvent.extend({
  type: z.literal("task.completed"),
  taskId: z.string(),
  result: ExecutionResultSchema,
});

export const TaskFailedEventSchema = baseEvent.extend({
  type: z.literal("task.failed"),
  taskId: z.string(),
  error: z.string(),
  result: ExecutionResultSchema.optional(),
});

export const TaskBlockedEventSchema = baseEvent.extend({
  type: z.literal("task.blocked"),
  taskId: z.string(),
  reason: z.string(),
  blockedOnHitlId: z.string().optional(),
});

export const HitlCreatedEventSchema = baseEvent.extend({
  type: z.literal("hitl.created"),
  request: HITLRequestSchema,
});

export const HitlResolvedEventSchema = baseEvent.extend({
  type: z.literal("hitl.resolved"),
  requestId: z.string(),
  resolution: HITLResolutionSchema,
});

export const HeartbeatEventSchema = baseEvent.extend({
  type: z.literal("heartbeat"),
  uptimeSeconds: z.number().nonnegative().optional(),
});

export const ThinkingTraceEventSchema = baseEvent.extend({
  type: z.literal("thinking.trace"),
  taskId: z.string().optional(),
  content: z.string(),
  tokens: z.number().int().nonnegative().optional(),
});

export const ScheduleUpdatedEventSchema = baseEvent.extend({
  type: z.literal("schedule.updated"),
  scheduledTasks: z.array(
    z.object({
      taskId: z.string(),
      scheduledFor: z.string().datetime(),
    })
  ),
});

export const ExecutorProgressEventSchema = baseEvent.extend({
  type: z.literal("executor.progress"),
  progress: ExecutionProgressSchema,
});

export const TradeSignalEventSchema = baseEvent.extend({
  type: z.literal("trade.signal"),
  signal: TradeSignalSchema,
  verdict: RiskVerdictSchema,
});

export const TradeFilledEventSchema = baseEvent.extend({
  type: z.literal("trade.filled"),
  signalId: z.string(),
  fill: FillSchema,
});

export const TradeBlockedEventSchema = baseEvent.extend({
  type: z.literal("trade.blocked"),
  signalId: z.string(),
  ticker: z.string(),
  blockedBy: z.array(z.string()),
  reason: z.string().optional(),
});

export const StreamEventSchema = z.discriminatedUnion("type", [
  PresenceChangedEventSchema,
  TaskCreatedEventSchema,
  TaskUpdatedEventSchema,
  TaskStartedEventSchema,
  TaskCompletedEventSchema,
  TaskFailedEventSchema,
  TaskBlockedEventSchema,
  HitlCreatedEventSchema,
  HitlResolvedEventSchema,
  HeartbeatEventSchema,
  ThinkingTraceEventSchema,
  ScheduleUpdatedEventSchema,
  ExecutorProgressEventSchema,
  TradeSignalEventSchema,
  TradeFilledEventSchema,
  TradeBlockedEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export type StreamEventType = StreamEvent["type"];

export type StreamEventByType<T extends StreamEventType> = Extract<
  StreamEvent,
  { type: T }
>;
