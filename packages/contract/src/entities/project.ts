import { z } from "zod";

/**
 * Project lifecycle status.
 *
 * - `active`    — full participation: scheduling, goal regression, tagging,
 *                 council/knowledge task filing.
 * - `parked`    — deliberately dormant. Excluded from every autonomous surface
 *                 (morning scheduling, goal regression, project tagging,
 *                 council APPLY/slate filing) but stays visible on the board
 *                 with all data retained. Robert's "not now, keep everything"
 *                 state.
 * - `paused`    — temporarily on hold; mechanically identical to `parked`
 *                 (only `active`/unset projects participate), softer intent.
 * - `completed` — reached its end state; kept for the record.
 * - `archived`  — hidden from the board and context retrieval (see
 *                 TheNexus archiveProject).
 */
export const ProjectStatusSchema = z.enum([
  "active",
  "parked",
  "paused",
  "completed",
  "archived",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

/**
 * How much autonomous improvement attention a project accepts. Orthogonal to
 * `status` (gates WHAT the system may file, status gates WHETHER it looks at
 * the project at all — non-active projects are skipped regardless of posture).
 *
 * - `auto`    — councils / knowledge routing / steward may file improvement
 *               tasks, and the morning pipeline may schedule them through the
 *               normal approval flow. Default.
 * - `propose` — system-sourced tasks may be FILED (visible on the board as
 *               ideas) but are never auto-scheduled; Robert promotes them.
 * - `off`     — no autonomous improvement filings at all. Robert-created
 *               tasks still schedule normally.
 */
export const UpgradePostureSchema = z.enum(["auto", "propose", "off"]);
export type UpgradePosture = z.infer<typeof UpgradePostureSchema>;

export const ProjectNeedKindSchema = z.enum([
  "capability", // something the system must be able to DO (missing component)
  "resource",   // compute, money, hardware, a service subscription
  "credential", // API key, OAuth grant, account — Robert must provision
  "decision",   // a human call that blocks progress
  "information",// knowledge that must be hunted/learned first
]);
export type ProjectNeedKind = z.infer<typeof ProjectNeedKindSchema>;

/**
 * A declared need: something the project is missing on the way to its end
 * state. Open needs are the machine-readable "what is missing" registry —
 * councils and the steward read them to aim improvement work, and resolving
 * one is itself schedulable work.
 */
export const ProjectNeedSchema = z.object({
  id: z.string(),
  kind: ProjectNeedKindSchema,
  description: z.string(),
  status: z.enum(["open", "met", "dropped"]).default("open"),
  created_at: z.string(),
  resolved_at: z.string().optional(),
  /** Who declared it: "robert", "council", "steward", an agent/session name. */
  source: z.string().optional(),
  notes: z.string().optional(),
});
export type ProjectNeed = z.infer<typeof ProjectNeedSchema>;

/**
 * Machine-checkable end-state acceptance criteria. The Project Data Steward
 * evaluates the safe kinds on its weekly pass and cites per-criterion
 * pass/fail in `end_state_possibly_achieved` flags, replacing the bare
 * "no open tasks + ≥3 done" heuristic for projects that declare criteria.
 */
export const EndStateCriterionKindSchema = z.enum([
  "url_up",   // GET the url; pass when status is 200-399 (or expect_status)
  "command",  // run an allowlisted command in the project workspace; pass on exit 0
  "task_set", // pass when every task id listed is completed on the board
]);
export type EndStateCriterionKind = z.infer<typeof EndStateCriterionKindSchema>;

export const EndStateCriterionSchema = z.object({
  id: z.string(),
  kind: EndStateCriterionKindSchema,
  /** Human label — what this criterion proves about the end state. */
  description: z.string(),
  /** url_up: the URL to probe. */
  url: z.string().optional(),
  /** url_up: exact HTTP status expected (default: any 2xx/3xx). */
  expect_status: z.number().int().optional(),
  /** command: run from the project workspace; evaluator enforces an allowlist. */
  command: z.string().optional(),
  /** task_set: board task ids that must all be completed. */
  task_ids: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  created_at: z.string().optional(),
  /** Who declared it: "robert", "steward-proposal", an agent/session name. */
  source: z.string().optional(),
});
export type EndStateCriterion = z.infer<typeof EndStateCriterionSchema>;

/**
 * One revision of a project's end state. `end_state_history` is the ordered
 * list of these (oldest first); the newest entry mirrors the live
 * `end_state`. Appended server-side by TheNexus on every end_state change so
 * end states can evolve without losing where they came from.
 */
export const EndStateRevisionSchema = z.object({
  end_state: z.string(),
  at: z.string(),
  /** Who set it: "robert", "steward-proposal", an agent/session name. */
  source: z.string().optional(),
  /** Why it changed — e.g. "previous horizon reached", "scope pivot". */
  reason: z.string().optional(),
});
export type EndStateRevision = z.infer<typeof EndStateRevisionSchema>;

export const ProjectHealthSchema = z.enum([
  "healthy",
  "needs-attention",
  "critical",
  "unknown",
]);
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

export const GitCommitSummarySchema = z.object({
  hash: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type GitCommitSummary = z.infer<typeof GitCommitSummarySchema>;

export const GitStatusSummarySchema = z.object({
  hasGit: z.boolean(),
  hasRemote: z.boolean(),
  branch: z.string().nullable(),
  isClean: z.boolean(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  modifiedCount: z.number().int().nonnegative(),
  stagedCount: z.number().int().nonnegative(),
  untrackedCount: z.number().int().nonnegative(),
  daysSinceCommit: z.number().nullable().optional(),
  lastCommit: GitCommitSummarySchema.nullable().optional(),
});
export type GitStatusSummary = z.infer<typeof GitStatusSummarySchema>;

export const ProjectStatsSchema = z.object({
  openTaskCount: z.number().int().nonnegative().optional(),
  pendingReviewCount: z.number().int().nonnegative().optional(),
  blockedTaskCount: z.number().int().nonnegative().optional(),
});
export type ProjectStats = z.infer<typeof ProjectStatsSchema>;

export const ProjectUrlsSchema = z.object({
  production: z.string().url().optional(),
  repo: z.string().url().optional(),
  docs: z.string().url().optional(),
});
export type ProjectUrls = z.infer<typeof ProjectUrlsSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),

  status: ProjectStatusSchema.optional(),
  health: ProjectHealthSchema.optional(),

  pinnedAt: z.string().datetime().nullable().optional(),
  lastActiveAt: z.string().datetime().optional(),

  gitStatus: GitStatusSummarySchema.optional(),
  stats: ProjectStatsSchema.optional(),

  tags: z.array(z.string()).optional(),
  techStack: z.array(z.string()).optional(),

  type: z.string().optional(),
  vibe: z.string().optional(),
  urls: ProjectUrlsSchema.optional(),
  endState: z.string().optional(),

  /** Attention priority: 0 = normal (default), >0 elevated, <0 backburner. */
  priority: z.number().int().optional(),
  upgradePosture: UpgradePostureSchema.optional(),
  needs: z.array(ProjectNeedSchema).optional(),
  endStateHistory: z.array(EndStateRevisionSchema).optional(),
  endStateCriteria: z.array(EndStateCriterionSchema).optional(),
  endStateUpdatedAt: z.string().datetime().optional(),

  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),

  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Project = z.infer<typeof ProjectSchema>;
