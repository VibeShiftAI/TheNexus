import { z } from "zod";

export const ProjectStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "archived",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

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

  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),

  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Project = z.infer<typeof ProjectSchema>;
