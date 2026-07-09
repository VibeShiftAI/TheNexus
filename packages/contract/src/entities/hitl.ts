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
  /**
   * Optional resolver-supplied structured payload. Used today by the morning
   * [MORNING PLAN] approval card to carry `scheduleOverrides` (per-task
   * executor changes and skips with reasons) alongside the approve choice, so
   * Robert can refine the plan inline instead of approve-as-is or reject-all.
   * Kept open-typed so other resolvers can attach their own structured input
   * without further schema churn.
   */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type HITLResolution = z.infer<typeof HITLResolutionSchema>;

/**
 * Wire format of POST /hitl/:id/resolve — what the mobile app / dashboard /
 * curl actually send. Validated at the webhook boundary (2026-07-05): a HITL
 * resolution feeds straight into the needs_input → resume pipeline (schedule
 * overrides, executor choices, re-dispatch prompts), so a malformed or
 * oversized body must be a 400, not a silent pass-through. Unknown keys are
 * stripped (not rejected) so older/newer clients stay compatible.
 */
export const HITLResolveBodySchema = z.object({
  resolvedBy: z.string().max(200).optional(),
  choice: z.string().max(4_000).optional(),
  freeText: z.string().max(50_000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  /** Voice reply — bounded at ~12 MB of base64 (≈9 MB audio). */
  audioBase64: z.string().max(12_000_000).optional(),
  audioMimeType: z.string().max(100).optional(),
  audioFilename: z.string().max(255).optional(),
});
export type HITLResolveBody = z.infer<typeof HITLResolveBodySchema>;

/** Serialized-size guard for the open-typed resolver payload (64 KB). */
export const HITL_RESOLVE_PAYLOAD_MAX_BYTES = 64 * 1024;

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

  /**
   * Open-typed metadata bag for request-kind-specific structured data the UI
   * may render against (e.g. the morning [MORNING PLAN] HITL attaches
   * `{ kind: "day-schedule", date, slots: [...] }` so the dashboard can show
   * a rich per-slot card instead of a plain textarea). Keeping it open-typed
   * avoids schema churn for every new HITL flavor.
   */
  metadata: z.record(z.string(), z.unknown()).optional(),

  resolution: HITLResolutionSchema.nullable().optional(),
});
export type HITLRequest = z.infer<typeof HITLRequestSchema>;
