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
  /**
   * Only verified-stage `verified` and `qaUnverified` are null, and only when
   * the QA ledger is unavailable. Other present counts are numeric; omitted
   * keys do not apply to that stage.
   */
  counts: Record<string, number | null>;
  /** Approval gate resolved "rejected": this slate will not run at all. */
  blocked?: boolean;
  /** Evidence is unavailable: the stage is unknown, not a negative result. */
  unknown?: boolean;
  /** Set on a pending approval: when the slate started waiting on Robert. */
  waitingSince?: string | null;
  /** Verified only: every live slot reached a terminal state. */
  complete?: boolean;
  /** Verified only: false when Praxis's QA ledger could not be read at all. */
  qaEvidence?: boolean;
}

export interface SlateStall {
  stage: SlateStageName;
  since: string | null;
  waitingMs: number | null;
  blocked: boolean;
  unknown: boolean;
  /** Past the warn threshold and still able to advance, so worth colouring. */
  warn: boolean;
  /** Live work remains, so this stage can still advance on its own. */
  stalled: boolean;
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
  /**
   * Affirmative evidence the dispatch plane ran this slot, withdrawal aside:
   * true for a slot cancelled mid-flight, which `attempted` excludes.
   */
  dispatchProven: boolean;
  /** Completed, but the plane never ran it: done on the board, not dispatched. */
  outOfBand: boolean;
  /** Completed with no evidence either way. Not a dispatch, not a QA pass. */
  unprovenCompletion: boolean;
  /**
   * Completed, genuinely dispatched, and no reviewer verdict covers it. The
   * reconciled-completion case: Praxis flipped the slot on a board completion
   * and left the old attempt stamp in place. The run is real; the review is
   * missing.
   */
  qaUnverified: boolean;
  /** A reviewer passed this completion in Praxis's verification ledger. */
  qaPassed: boolean;
  /** That ledger's audit leg: "pass" | "exempt" | "none" | "deferred". */
  qaOutcome: string | null;
  /** Praxis's grade of the evidence behind the pass, carried for display. */
  qaVerdict: string | null;
  qaReviewer: string | null;
  qaAt: string | null;
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
  /** Slots still owing work (pending or dispatched), Praxis's own count. */
  liveSlots?: number;
  /**
   * Whether the QA half of the projection could be read. `available: false`
   * means every slot below is QA-UNKNOWN, which the surface must not render
   * as a failed review.
   */
  qaEvidence?: { available: boolean; reason?: string | null };
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
 * How a stage should read. Six states, deliberately distinct:
 *
 *   done     : reached, on positive evidence, for every slot that owed work
 *   partial  : reached, but some of the slate has not got there yet
 *   waiting  : not reached and still able to advance (this is the stall)
 *   upcoming : not reached, and not the stage currently holding things up
 *   blocked  : the approval gate said no; the slate will not run
 *   unknown  : no record either way, which is NOT the same as "no"
 *
 * Only the CURRENT stall is "waiting". Stages after it are "upcoming": a slate
 * stuck at approval has not failed to dispatch, it has not got there yet, and
 * painting three stages red for one stall is how a reader stops believing the
 * strip.
 */
export type SlateStageTone = "done" | "partial" | "waiting" | "upcoming" | "blocked" | "unknown";

export function stageTone(stage: SlateStage, stall: SlateStall | null): SlateStageTone {
  if (stage.unknown || stage.qaEvidence === false) return "unknown";
  if (stage.reached) {
    // Reached is not finished. One QA-passed slot out of twelve reaches the
    // verified stage, and a chip that renders it the same green as twelve of
    // twelve is the 2026-08-24 failure in miniature: work still outstanding,
    // nothing on screen saying so.
    const progress = stageProgress(stage);
    return progress && progress.done < progress.total ? "partial" : "done";
  }
  if (stage.blocked) return "blocked";
  // A stall with no live work left cannot advance: nothing is queued and
  // nothing is in flight. Painting it amber with a running clock beside
  // "Nothing left to run" tells two different stories at once (QA 2026-09-18),
  // so it reads neutral, like any stage the slate never got to.
  if (stall?.stage === stage.stage && stall.stalled !== false) return "waiting";
  return "upcoming";
}

/**
 * The "3/12" a stage can put on its own chip. Only the two stages that measure
 * slots have one: drafted and approved are properties of the slate as a whole.
 */
export function stageProgress(stage: SlateStage): { done: number; total: number } | null {
  if (stage.unknown || stage.qaEvidence === false) return null;
  const total = stage.counts?.live;
  if (typeof total !== "number" || total <= 0) return null;
  const done = stage.stage === "attempted" ? stage.counts?.attempted : stage.stage === "verified" ? stage.counts?.verified : undefined;
  return typeof done === "number" ? { done, total } : null;
}

export interface SlateStageNote {
  /** Short enough for a chip: "2 out of band". */
  label: string;
  /** The sentence behind it, for a tooltip or a screen reader. */
  title: string;
}

/**
 * Outcomes that are NOT the stage's own count and must not hide inside it:
 * work Robert accepted over a QA rejection, work that landed without the
 * dispatch plane, and completions nothing can vouch for. Rendered beside the
 * chip rather than in its title, so they survive a touch device with no hover.
 */
export function stageNotes(stage: SlateStage): SlateStageNote[] {
  const counts = stage.counts ?? {};
  const notes: SlateStageNote[] = [];
  const push = (key: string, label: (n: number) => string, title: string) => {
    const n = counts[key];
    if (typeof n === "number" && n > 0) notes.push({ label: label(n), title });
  };
  push("operatorAccepted", (n) => `${n} operator-accepted`, "Robert accepted this work over a QA rejection. It did not pass QA.");
  push("outOfBand", (n) => `${n} out of band`, "Already done on the board when Praxis reached the slot, so the dispatch plane never ran it.");
  push("unproven", (n) => `${n} unproven`, "Completed with no dispatch evidence, so neither a run nor a QA pass can be claimed.");
  push("qaUnknown", (n) => `${n} QA unknown`, "The dispatch plane ran these, but the QA ledger is unreadable; whether they were reviewed is unknown.");
  if (stage.qaEvidence !== false) push("qaUnverified", (n) => `${n} not QA-reviewed`, "The dispatch plane really ran these, but no reviewer verdict in Praxis's verification ledger covers the completion.");
  push("withdrawn", (n) => `${n} withdrawn`, "Skipped or deferred before dispatch, so these slots never owed a run.");
  push("spineUnrecorded", (n) => `${n} spine gap`, "The run-events spine rejected the provenance write; the slot carries the only surviving evidence.");
  return notes;
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
  if (stall.stage === "verified" && (stall.unknown || lifecycle.qaEvidence?.available === false)) {
    return stall.stalled === false
      ? "Nothing left to run; verification unknown"
      : "Verification unknown; QA evidence unreadable";
  }
  if (stall.unknown) return `No record that this slate was ${label}`;
  // Nothing left to run: this stage is not late, it is never going to happen.
  // A slate whose work all landed out of band sits here, and counting minutes
  // at it would be a stall that no dispatch can ever clear.
  if (stall.stalled === false) return `Nothing left to run; never ${label}`;
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
