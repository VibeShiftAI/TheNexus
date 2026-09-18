/**
 * Slate lifecycle on screen (server: /api/slate/lifecycle, contract:
 * docs/contracts/slate-lifecycle.md).
 *
 * The strip renders four stages (drafted, approved, attempted, verified)
 * for the day's slate, so a slate stuck at one of them is visible on the board
 * instead of only inside Praxis's schedule file. Same direct-fetch pattern as
 * lib/dispatch-insight.ts.
 *
 * Every formatter here obeys the server's honesty rules: a stage that was not
 * reached never borrows the look of one that was, an unknown approval never
 * reads as approved, and operator-accepted work never reads as QA-passed.
 */

export type SlateStageName = "drafted" | "approved" | "attempted" | "verified";

export interface SlateStage {
  stage: SlateStageName;
  reached: boolean;
  at: string | null;
  detail: string;
  counts: Record<string, number>;
  /** Approval gate resolved "rejected": this slate will not run at all. */
  blocked?: boolean;
  /** No approval record exists: genuinely unseen, not implicitly approved. */
  unknown?: boolean;
  /** Set on a pending approval: when the slate started waiting on Robert. */
  waitingSince?: string | null;
  /** Verified only: every live slot reached a terminal state. */
  complete?: boolean;
}

export interface SlateStall {
  stage: SlateStageName;
  since: string | null;
  waitingMs: number | null;
  blocked: boolean;
  unknown: boolean;
  /** Past the warn threshold and still able to advance, so worth colouring. */
  warn: boolean;
}

export interface SlateSlot {
  slotNumber: number | null;
  taskId: string | null;
  title: string;
  status: string;
  executor: string | null;
  startTime: string | null;
  withdrawn: boolean;
  skipSource: "human" | "reconciliation" | null;
  attempted: boolean;
  verified: boolean;
  operatorAccepted: boolean;
  provenanceAt: string | null;
  provenanceVia: string | null;
  spineUnrecorded: boolean;
}

export interface SlateLifecycle {
  at: string;
  available: boolean;
  /** Why the slate could not be read. Present only when available is false. */
  reason?: string;
  date: string | null;
  scheduleId?: string | null;
  morningRunId?: string | null;
  createdAt?: string | null;
  /** Older than Praxis's carryover window: history on disk, not today. */
  stale?: boolean;
  /** Yesterday's slate still plausibly running past midnight. */
  carriedOver?: boolean;
  stages: SlateStage[];
  stall: SlateStall | null;
  slots: SlateSlot[];
}

export const SLATE_STAGE_ORDER: SlateStageName[] = ["drafted", "approved", "attempted", "verified"];

export const SLATE_STAGE_LABEL: Record<SlateStageName, string> = {
  drafted: "Drafted",
  approved: "Approved",
  attempted: "Attempted",
  verified: "Verified",
};

export async function getSlateLifecycle(): Promise<SlateLifecycle> {
  const res = await fetch(`/api/slate/lifecycle?_cb=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load slate lifecycle (${res.status})`);
  return res.json();
}

/**
 * How a stage should read. Four states, deliberately distinct:
 *
 *   done     : reached, on positive evidence
 *   waiting  : not reached and still able to advance (this is the stall)
 *   blocked  : the approval gate said no; the slate will not run
 *   unknown  : no record either way, which is NOT the same as "no"
 *
 * Only the CURRENT stall is "waiting". Stages after it are "upcoming": a slate
 * stuck at approval has not failed to dispatch, it has not got there yet, and
 * painting three stages red for one stall is how a reader stops believing the
 * strip.
 */
export type SlateStageTone = "done" | "waiting" | "upcoming" | "blocked" | "unknown";

export function stageTone(stage: SlateStage, stall: SlateStall | null): SlateStageTone {
  if (stage.reached) return "done";
  if (stage.blocked) return "blocked";
  if (stage.unknown) return "unknown";
  return stall?.stage === stage.stage ? "waiting" : "upcoming";
}

/** "1h 59m", "45m", "8s": a duration a person reads at a glance. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * The one sentence the 2026-08-24 slate never showed anyone. Returns null when
 * there is nothing to say: a slate whose last stage is reached is not stalled.
 */
export function describeStall(lifecycle: SlateLifecycle): string | null {
  if (!lifecycle.available) return null;
  const stall = lifecycle.stall;
  if (!stall) return null;
  const label = SLATE_STAGE_LABEL[stall.stage].toLowerCase();
  if (stall.blocked) return "Slate rejected: it will not run today";
  if (stall.unknown) return `No record that this slate was ${label}`;
  if (stall.waitingMs === null) return `Not ${label} yet`;
  return `Not ${label} for ${formatDuration(stall.waitingMs)}`;
}

/**
 * The strip's headline. Says which day's slate is on screen, because a
 * carried-over or stale slate must never be read as today's.
 */
export function describeSlate(lifecycle: SlateLifecycle): string {
  if (!lifecycle.available) return "Slate not readable";
  const date = lifecycle.date ?? "undated";
  if (lifecycle.stale) return `Last slate (${date}); no slate for today`;
  if (lifecycle.carriedOver) return `Slate ${date} (running past midnight)`;
  return `Slate ${date}`;
}
