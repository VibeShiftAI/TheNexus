/**
 * Dispatch eligibility + containment insight (server: /api/dispatch-insight).
 *
 * Read surfaces for "why isn't this running" (task board) and per-run
 * ceiling / cost / verdict / guardrail detail (dispatch console), plus the
 * kill relay. Same direct-fetch pattern as lib/dispatches.ts.
 */

export type EligibilityReasonCode =
  | "queued"
  | "predecessors_incomplete"
  | "project_dormant"
  | "executor_suspended"
  | "cli_slot_busy"
  | "praxis_unreachable";

export interface EligibilityReason {
  code: EligibilityReasonCode;
  detail: string;
}

export interface TaskEligibility {
  taskId: string;
  name: string;
  projectId: string | null;
  projectName: string | null;
  status: string;
  priority: number;
  lane: "new" | "ready";
  eligible: boolean;
  reason: EligibilityReason | null;
  /** Non-blocking context, e.g. "preferred worker suspended — Praxis reroutes to X". */
  note: string | null;
}

export interface ContainmentState {
  cliSlot: {
    busy: boolean;
    holder: {
      taskId: string;
      title: string;
      executor: string;
      phase: string;
      startedAt: string;
    } | null;
  };
  queue: Array<{
    taskId: string | null;
    title: string | null;
    executor: string | null;
    enqueuedAt: string | null;
    position: number;
  }>;
  executors: Array<{
    name: string;
    strikes: number;
    suspended: boolean;
    suspendedUntil: string | null;
    lastStrikeReason: string | null;
    lastRecoveredAt: string | null;
  }>;
  incidents: Array<{
    executor: string;
    at: string | null;
    label: string;
    reason: string | null;
  }>;
}

export interface DispatchEligibilityResponse {
  at: string;
  praxis: { reachable: boolean; error: string | null };
  containment: ContainmentState | null;
  tasks: TaskEligibility[];
}

export interface RunVerification {
  ts: string;
  verdict: string;
  basis: string[];
  qa: { outcome: string; reviewer?: string; author?: string; detail?: string } | null;
  gates: { declared?: string[]; missing?: string[]; detail?: string } | null;
}

export interface RunGuardrailEvent {
  at: string | null;
  label: string;
  source: string;
  detail: string | null;
}

export interface RunInsight {
  dispatchId: string;
  executor: string;
  model: string | null;
  outcome: string;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  /**
   * THIS run's ceiling: `praxis_run_record` only on the live run the record
   * describes; historical runs read `default_assumed` because their true
   * ceiling was never persisted.
   */
  ceiling: { ms: number; source: "praxis_run_record" | "default_assumed" };
  overdue: boolean;
  cost: { usd: number; estimated: boolean } | null;
  verification: RunVerification | null;
  guardrails: RunGuardrailEvent[];
  canKill: boolean;
}

export interface TaskDispatchInsight {
  taskId: string;
  /**
   * `praxis_run_record` = the live run's actual enforced timeout (from
   * Praxis's detached-run record); `default_assumed` = the 3h fallback —
   * Praxis's env override and historical runs' true ceilings are invisible.
   */
  ceiling: { ms: number; source: "praxis_run_record" | "default_assumed" };
  scheduleEstimateMinutes: number | null;
  spineAvailable: boolean;
  praxisReachable: boolean;
  latestVerification: RunVerification | null;
  runs: RunInsight[];
}

export async function getDispatchEligibility(): Promise<DispatchEligibilityResponse> {
  const res = await fetch(`/api/dispatch-insight/eligibility?_cb=${Date.now()}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to load dispatch eligibility (${res.status})`);
  return res.json();
}

export async function getTaskDispatchInsight(taskId: string): Promise<TaskDispatchInsight> {
  const res = await fetch(
    `/api/dispatch-insight/task/${encodeURIComponent(taskId)}?_cb=${Date.now()}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Failed to load dispatch insight (${res.status})`);
  return res.json();
}

/**
 * Kill a running dispatch: the server signals the run's own process group
 * (identified and verified via Praxis's detached-run record — the same
 * handle Praxis's timeout enforcer kills with) and marks rows cancelled only
 * after the process is confirmed dead. `method` is "sigterm"/"sigkill" for a
 * real kill, or "ghost_cleanup" when no process, record, or active run
 * existed and the stale row was simply closed. Throws (409) when a run can't
 * be safely targeted — nothing is marked cancelled in that case.
 */
export async function killTaskRun(
  taskId: string,
): Promise<{ ok: boolean; cancelled: boolean; method: string; closedDispatches: number }> {
  const res = await fetch("/api/dispatch-insight/kill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Kill failed (${res.status})`);
  return body;
}

/** "3h" / "45m" / "90s" — compact duration for ceiling & elapsed chips. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

/** "~$0.42" — estimated run cost; always marked approximate. */
export function formatCostUsd(usd: number): string {
  if (usd >= 1) return `~$${usd.toFixed(2)}`;
  return `~$${usd.toFixed(3).replace(/0$/, "")}`;
}
