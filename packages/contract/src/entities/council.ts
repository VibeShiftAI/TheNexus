import { z } from "zod";

/**
 * Live council telemetry — the compact wire shape of a deliberation in
 * flight, emitted as `council.update` stream events by Praxis's
 * CouncilSessionTracker on every persisted mutation (convene, each thesis
 * landing, synthesis handoff, verdict). Consumers (the bridge core orb,
 * ambient mode, mobile) render deliberation activity live from this instead
 * of polling the session store.
 *
 * This mirrors — but deliberately does not replace — the full session
 * records served by /api/council/sessions: those carry theses/synthesis
 * bodies; this carries only what a presence visual needs.
 */

export const CouncilPhaseSchema = z.enum([
  "setup",
  "deliberation",
  "synthesis",
  "refinement",
  "complete",
]);
export type CouncilPhase = z.infer<typeof CouncilPhaseSchema>;

export const CouncilSeatStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "parse_error",
  "error",
  "timeout",
]);
export type CouncilSeatStatus = z.infer<typeof CouncilSeatStatusSchema>;

export const CouncilSeatSchema = z.object({
  /** Stable voice name, unique within the session ("cli:codex", "cli:claude-code (aggregator)"). */
  name: z.string(),
  model: z.string().optional(),
  status: CouncilSeatStatusSchema,
  /** True for the synthesis/aggregator seat. */
  aggregator: z.boolean().optional(),
});
export type CouncilSeat = z.infer<typeof CouncilSeatSchema>;

export const CouncilSnapshotSchema = z.object({
  sessionId: z.string(),
  topic: z.string(),
  phase: CouncilPhaseSchema,
  /** Session flavor from metadata.kind ("knowledge-council", "status-report"); absent = summoned. */
  kind: z.string().optional(),
  seats: z.array(CouncilSeatSchema),
  /** Epoch ms the session was created (CouncilState.createdAt). */
  convenedAt: z.number().int().nonnegative(),
  thesisCount: z.number().int().nonnegative(),
  /** Theses expected before synthesis begins, when the tracker knows it. */
  expectedTheses: z.number().int().nonnegative().optional(),
  /** Set once phase === "complete". */
  verdict: z.enum(["success", "error"]).optional(),
});
export type CouncilSnapshot = z.infer<typeof CouncilSnapshotSchema>;
