import { z } from "zod";

export const HITLReasonSchema = z.enum([
  "low_confidence",
  "subjective_validation",
  "explicit_request",
  "ontological_guard",
  "budget_gate",
]);
export type HITLReason = z.infer<typeof HITLReasonSchema>;

export const HITLPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export type HITLPriority = z.infer<typeof HITLPrioritySchema>;

export const HITLOriginalPayloadSchema = z.object({
  prompt: z.string(),
  workspace: z.string(),
  modelOverride: z.string().optional(),
});
export type HITLOriginalPayload = z.infer<typeof HITLOriginalPayloadSchema>;

export const HITLResolutionSchema = z.object({
  resolvedAt: z.string().datetime(),
  resolvedBy: z.string(),
  choice: z.string().optional(),
  freeText: z.string().optional(),
});
export type HITLResolution = z.infer<typeof HITLResolutionSchema>;

export const HITLRequestSchema = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  conversationId: z.string().optional(),
  workspace: z.string(),

  reason: HITLReasonSchema,
  priority: HITLPrioritySchema.optional(),

  question: z.string(),
  options: z.array(z.string()).optional(),
  partialResult: z.string().optional(),
  workingBranch: z.string().optional(),
  confidenceScore: z.number().min(0).max(100).optional(),

  originalPayload: HITLOriginalPayloadSchema.optional(),
  requestedAt: z.string().datetime(),
  ttlSeconds: z.number().int().positive().optional(),

  resolution: HITLResolutionSchema.nullable().optional(),
});
export type HITLRequest = z.infer<typeof HITLRequestSchema>;
