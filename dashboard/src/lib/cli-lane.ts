/**
 * CLI lane — who holds the machine-wide CLI slot, who is queued behind it,
 * and why the concurrency gate is set where it is.
 *
 * Praxis has published all of this on /api/dispatch/state for a while
 * (`executors.cliQueue`, `executors.cliConcurrency`, `executors.posture`,
 * `executors.attemptStalls`); the cockpit read none of it, so "why is this
 * queued" was only answerable in chat. These are pure derivations over that
 * snapshot so the rendering component stays declarative and the shapes are
 * testable without a DOM.
 *
 * Rule for every field: an older Praxis omits the newer ones, so a missing
 * value renders as absent, never as zero. The gate's `reason` string is
 * authoritative and always shown verbatim — Praxis task sr-j is moving numbers
 * into the structured fields, and they DECORATE the sentence rather than
 * replacing it.
 */

import type {
  AttemptStallState,
  CliConcurrencyState,
  CliQueueEntry,
  FleetPosture,
} from "@/lib/nexus";

/** The three executors Praxis counts against the machine-wide CLI gate. */
export const CLI_EXECUTORS = ["claude-code", "codex", "antigravity"] as const;
export type CliExecutorName = (typeof CLI_EXECUTORS)[number];

export const CLI_EXECUTOR_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

/** An active run occupying a CLI slot. */
export interface CliLaneRun {
  taskId: string;
  title: string;
  phase?: string;
  kind?: string;
  startedAt?: string;
  /** ms since the run started, or null when Praxis sent no timestamp. */
  runningMs: number | null;
}

/** One executor's row in the lane block. */
export interface CliLaneExecutor {
  name: string;
  label: string;
  runs: CliLaneRun[];
  /** Configured slots, when the gate reported them. */
  slots: number | null;
  free: number | null;
  /** True when the fleet posture lists this worker as suspended. */
  suspended: boolean;
}

/** One task waiting behind the gate, with its position and wait clock. */
export interface CliLaneQueueItem {
  /** 1-based position — what Praxis will pull next is position 1. */
  position: number;
  taskId: string | null;
  title: string | null;
  executor: string | null;
  executorLabel: string | null;
  enqueuedAt: string | null;
  /** ms waited, or null when Praxis sent no enqueue time. */
  waitingMs: number | null;
}

/** The concurrency gate, ready to render. */
export interface CliLaneGate {
  /** Praxis's own sentence. Rendered verbatim; null when it sent none. */
  reason: string | null;
  limit: number | null;
  active: number | null;
  free: number | null;
  queued: number | null;
  burst: boolean | null;
  /** Structured numbers, only those actually present. */
  readouts: { label: string; value: string; title?: string }[];
  /** True when nothing can start right now. */
  saturated: boolean;
}

export interface CliLaneView {
  executors: CliLaneExecutor[];
  queue: CliLaneQueueItem[];
  gate: CliLaneGate;
  posture: FleetPosture | null;
  /** Runs past their attempt grace window — a stall the operator should see. */
  stalledCount: number;
  /** True when Praxis sent none of the CLI-lane fields (older daemon). */
  unavailable: boolean;
}

/** The subset of the dispatch-state snapshot this module reads. */
export interface CliLaneSource {
  executors?: {
    runs?: {
      taskId: string;
      executor: string;
      title: string;
      kind?: string;
      phase?: string;
      status?: string;
      startedAt?: string;
    }[];
    cliQueue?: CliQueueEntry[];
    cliConcurrency?: CliConcurrencyState;
    posture?: FleetPosture;
    attemptStalls?: AttemptStallState;
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function elapsedMs(iso: string | undefined | null, now: number): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

export function executorLabel(name: string | null | undefined): string | null {
  if (!name) return null;
  return CLI_EXECUTOR_LABELS[name] ?? name;
}

/**
 * "4m" / "1h 12m" / "3d" — a compact wait/run clock. Deliberately not
 * "x ago": these read as durations next to a position number.
 */
export function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Structured gate numbers worth showing beside the reason sentence. Only
 * fields Praxis actually sent are emitted, each paired with its threshold when
 * one exists, so a number always reads against its bound.
 */
function gateReadouts(gate: CliConcurrencyState | undefined): CliLaneGate["readouts"] {
  const out: CliLaneGate["readouts"] = [];
  const metrics = gate?.metrics;
  if (!metrics) return out;
  const thresholds = gate?.thresholds ?? {};

  const memFree = num(metrics.memFreePct);
  if (memFree != null) {
    const min = num(thresholds.memFreeMinPct);
    out.push({
      label: "mem free",
      value: `${Math.round(memFree)}%`,
      title: min != null ? `Gate opens at ${min}% free memory` : undefined,
    });
  }
  const swapRate = num(metrics.swapoutMbPerSec);
  if (swapRate != null) {
    const max = num(thresholds.swapoutMaxMbPerSec);
    out.push({
      label: "swap rate",
      value: `${swapRate.toFixed(1)} MB/s`,
      title: max != null ? `Gate closes above ${max} MB/s` : undefined,
    });
  }
  const swapUsed = num(metrics.swapUsedMb);
  if (swapUsed != null) {
    out.push({ label: "swap used", value: `${Math.round(swapUsed)} MB` });
  }
  return out;
}

/**
 * Fold a dispatch-state snapshot into the CLI lane view.
 *
 * `now` is injectable so the wait clocks are deterministic under test.
 */
export function deriveCliLane(state: CliLaneSource | null | undefined, now = Date.now()): CliLaneView {
  const executors = state?.executors;
  const gateState = executors?.cliConcurrency;
  const rawQueue = Array.isArray(executors?.cliQueue) ? executors.cliQueue : [];
  const posture = executors?.posture ?? null;
  const suspended = new Set(posture?.suspended ?? []);

  // "Unavailable" means the daemon sent no CLI-lane fields at all — an empty
  // queue on a live gate is a real, renderable answer and must not read the
  // same as a Praxis too old to have one.
  const unavailable = !gateState && !executors?.cliQueue;

  const activeRuns = (executors?.runs ?? []).filter((r) => r.status === "active");

  // Every executor the gate knows about, plus any that is actually running —
  // a worker missing from `occupancy` but holding a run must still appear.
  const names = new Set<string>(CLI_EXECUTORS);
  for (const key of Object.keys(gateState?.occupancy ?? {})) names.add(key);
  for (const key of Object.keys(gateState?.slots ?? {})) names.add(key);
  for (const run of activeRuns) names.add(run.executor);

  const lanes: CliLaneExecutor[] = [...names].map((name) => {
    const occupancy = gateState?.occupancy?.[name];
    return {
      name,
      label: executorLabel(name) ?? name,
      runs: activeRuns
        .filter((r) => r.executor === name)
        .map((r) => ({
          taskId: r.taskId,
          title: r.title,
          phase: r.phase,
          kind: r.kind,
          startedAt: r.startedAt,
          runningMs: elapsedMs(r.startedAt, now),
        })),
      slots: num(occupancy?.slots) ?? num(gateState?.slots?.[name]),
      free: num(occupancy?.free),
      suspended: suspended.has(name),
    };
  });

  const queue: CliLaneQueueItem[] = rawQueue.map((entry, i) => ({
    position: i + 1,
    taskId: entry?.taskId ?? null,
    title: entry?.title ?? null,
    executor: entry?.executor ?? null,
    executorLabel: executorLabel(entry?.executor),
    enqueuedAt: entry?.enqueuedAt ?? null,
    waitingMs: elapsedMs(entry?.enqueuedAt, now),
  }));

  const free = num(gateState?.free);
  const limit = num(gateState?.limit);
  const active = num(gateState?.active);

  const gate: CliLaneGate = {
    reason: gateState?.reason?.trim() || null,
    limit,
    active,
    free,
    // Prefer the gate's own count; fall back to the queue we can see.
    queued: num(gateState?.queued) ?? (executors?.cliQueue ? rawQueue.length : null),
    burst: typeof gateState?.burst === "boolean" ? gateState.burst : null,
    readouts: gateReadouts(gateState),
    // Saturated when the gate says no slots are free, or — with no `free`
    // field — when the runs we can see already meet the limit.
    saturated: free != null ? free <= 0 : limit != null && active != null && active >= limit,
  };

  return {
    executors: lanes,
    queue,
    gate,
    posture,
    stalledCount:
      num(executors?.attemptStalls?.pending) ??
      (executors?.attemptStalls?.violations?.length ?? 0),
    unavailable,
  };
}

/**
 * One sentence for the lane header: what the gate is doing right now. Used as
 * the accessible label so a screen reader gets the verdict without walking the
 * whole table.
 */
export function cliLaneSummary(view: CliLaneView): string {
  if (view.unavailable) return "CLI lane telemetry unavailable";
  const { gate } = view;
  const running = view.executors.reduce((n, e) => n + e.runs.length, 0);
  const parts = [
    `${running} CLI ${running === 1 ? "run" : "runs"} active`,
    gate.limit != null ? `limit ${gate.limit}` : null,
    view.queue.length > 0 ? `${view.queue.length} queued` : "none queued",
  ].filter(Boolean);
  return parts.join(", ");
}
