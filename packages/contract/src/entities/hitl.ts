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

/**
 * Discriminator every HITL push / deep-link payload carries so the mobile
 * router can tell a Praxis approval apart from any other notification.
 */
export const HITL_DEEP_LINK_SOURCE = "praxis-hitl";

/**
 * Canonical in-app route a HITL approval deep-links to. The mobile inbox
 * consumes `?hitlId=` on this route to expand/scroll/highlight the exact
 * pending item. Kept here (not hard-coded per emitter) so the push producer
 * and the mobile route allow-list can never disagree on where an approval
 * tap should land.
 */
export const HITL_INBOX_ROUTE = "/(tabs)/inbox";

/**
 * Deep-link / push-notification payload for a single HITL approval — the one
 * shape the push emitter (server), the notification-route resolver, and the
 * mobile inbox all validate against. Before this existed each side hard-coded
 * its own `{ type | source, route }` and they drifted (praxis vs inbox route,
 * `type` vs `source`); this closes the approval-path deep-link gap by making
 * the payload contract-defined and derivable from a HITLRequest.
 */
export const HITLDeepLinkSchema = z.object({
  source: z.literal(HITL_DEEP_LINK_SOURCE),
  hitlId: z.string(),
  // Locked to the one canonical route — a plain z.string() would still accept
  // the old drifted `/(tabs)/praxis` value the contract exists to eliminate.
  route: z.literal(HITL_INBOX_ROUTE),
  taskId: z.string().optional(),
  reason: HITLReasonSchema.optional(),
  priority: HITLPrioritySchema.optional(),
});
export type HITLDeepLink = z.infer<typeof HITLDeepLinkSchema>;

/**
 * Derive the canonical deep-link payload for a HITL request. Pure and total —
 * a request always yields a valid, allow-listed deep link, so producers never
 * have to assemble (and drift on) the payload by hand.
 */
export function buildHitlDeepLink(
  request: Pick<HITLRequest, "id" | "taskId" | "reason" | "priority">,
): HITLDeepLink {
  return {
    source: HITL_DEEP_LINK_SOURCE,
    hitlId: request.id,
    route: HITL_INBOX_ROUTE,
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.priority ? { priority: request.priority } : {}),
  };
}
