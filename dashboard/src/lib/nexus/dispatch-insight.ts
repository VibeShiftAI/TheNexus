import { authFetch } from './shared';

// ═══════════════════════════════════════════════════════════════
// WHY WORK IS QUEUED, GATED, PAUSED OR HELD
// ═══════════════════════════════════════════════════════════════
//
// Praxis has always known why a task is not moving; the cockpit did not read
// it. Three separate answers live behind three shapes, all mirrored here:
//
//   1. The CLI lane — `executors.cliQueue` / `executors.cliConcurrency` /
//      `executors.posture` / `executors.attemptStalls` on Praxis
//      GET /api/dispatch/state. Who holds the machine-wide CLI slot, who is
//      queued behind it and since when, and the gate's own reason string.
//   2. Autonomy — may the fleet start work at all. Praxis GET /api/autonomy
//      carries only the EXPLICIT "Robert said stop" flag; the second, implicit
//      gate ("no live day schedule") is a separate probe. The Nexus relay
//      GET /api/dispatch-insight/autonomy composes both.
//   3. Held QA corrections — a task whose review failed while autonomy was
//      paused parks at `todo` with its findings and NO strike spent, and says
//      so only in a `qa_correction_withheld_paused` ops event. Read back via
//      GET /api/dispatch-insight/qa-holds.
//
// Every field is optional: these payloads come from a separately deployed
// daemon, and an older Praxis simply omits the newer ones. Renderers must say
// nothing rather than guess — see lib/cli-lane.ts and lib/autonomy.ts.

/** One task waiting for the machine-wide CLI slot (Praxis executors.cliQueue). */
export interface CliQueueEntry {
    taskId?: string;
    title?: string;
    executor?: string;
    /** When it entered the queue — the "waiting since" clock. */
    enqueuedAt?: string;
    args?: Record<string, unknown>;
}

/** Per-executor slot occupancy inside the concurrency gate. */
export interface CliExecutorOccupancy {
    active?: number;
    slots?: number;
    free?: number;
}

/**
 * Structured gate numbers. Praxis task sr-j moves these from prose into
 * fields; `metrics` is null until a probe has run, so treat every member as
 * "may not be here yet" and fall back to `reason`.
 */
export interface CliConcurrencyMetrics {
    memFreePct?: number | null;
    swapoutMbPerSec?: number | null;
    swapUsedMb?: number | null;
    llmBusy?: boolean | null;
    [key: string]: unknown;
}

/** The gate's configured limits, for rendering a number against its bound. */
export interface CliConcurrencyThresholds {
    memFreeMinPct?: number;
    llmBusyMemFreeMinPct?: number;
    swapoutMaxMbPerSec?: number;
    swapCeilingPct?: number;
    swapRefMb?: number;
    swapMaxMb?: number;
}

/**
 * The machine-wide CLI concurrency gate. `reason` is the authoritative
 * human-readable verdict and is always rendered verbatim; the structured
 * fields decorate it when present.
 */
export interface CliConcurrencyState {
    /** Concurrent CLI runs currently allowed. */
    limit?: number;
    /** True inside the daytime burst window (a raised limit). */
    burst?: boolean;
    /** Why the limit is what it is — rendered verbatim, never re-derived. */
    reason?: string;
    /** Configured slots per executor. */
    slots?: Record<string, number>;
    metrics?: CliConcurrencyMetrics | null;
    thresholds?: CliConcurrencyThresholds;
    /** CLI runs in flight right now. */
    active?: number;
    /** Slots free right now (0 = the next dispatch queues). */
    free?: number;
    /** Tasks waiting behind the gate. */
    queued?: number;
    occupancy?: Record<string, CliExecutorOccupancy>;
}

/** Fleet routing posture (Praxis executors.posture). */
export interface FleetPosture {
    mode?: string;
    available?: string[];
    suspended?: string[];
    crossExecutorQaPossible?: boolean;
    summary?: string;
    since?: string;
}

/** Runs that overran their attempt grace window (Praxis executors.attemptStalls). */
export interface AttemptStallState {
    violations?: { taskId?: string; executor?: string; detail?: string }[];
    requeues?: { taskId?: string; executor?: string; at?: string }[];
    pending?: number;
    graceMinutes?: number;
}

/** The persisted "Robert said stop" flag (Praxis data/autonomy-pause.json). */
export interface AutonomyPauseFlag {
    paused?: boolean;
    reason?: string;
    since?: string;
    /** Who asked for the stop — rendered as the "by whom" on the indicator. */
    requestedBy?: string;
}

/** A run still moving when the pause landed. Pausing never kills these. */
export interface AutonomyInFlightRun {
    taskId?: string;
    executor?: string;
    title?: string;
    startedAt?: string;
}

/**
 * Composed autonomy state (Nexus GET /api/dispatch-insight/autonomy).
 *
 * `paused` is the EXPLICIT flag only. `scheduleLive` is the separate implicit
 * gate — true when a day plan is installed and still owes work, false when
 * none is, and null when the probe could not run (which must render as
 * "unknown", never as "running").
 */
export interface AutonomyState {
    paused?: boolean;
    flag?: AutonomyPauseFlag | null;
    inFlight?: AutonomyInFlightRun[];
    scheduleLive?: boolean | null;
    /** Why `scheduleLive` reads the way it does, or why the probe failed. */
    scheduleDetail?: string | null;
    praxis?: { reachable?: boolean; error?: string | null };
}

/**
 * A task parked at `todo` because its QA correction was withheld — its latest
 * operational event is `qa_correction_withheld_paused`. Distinct from an
 * ordinary todo: the review HAPPENED and failed, the findings are kept, and no
 * strike was spent.
 */
export interface QaHold {
    taskId: string;
    /** Board title, when the task still exists. */
    title?: string | null;
    status?: string | null;
    projectId?: string | null;
    /** The pause reason, extracted from the event ("no live day schedule…"). */
    reason: string | null;
    /** When the correction was held. */
    heldAt: string | null;
    /** The reviewer's findings, verbatim from the event body. */
    findings: string | null;
    eventId: number;
    /** True when Robert had started this task by hand. */
    operatorInitiated?: boolean;
}

/** Autonomy state plus the held-correction list, for the "why" surfaces. */
export async function getAutonomyState(): Promise<AutonomyState> {
    const res = await authFetch('/api/dispatch-insight/autonomy', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Autonomy state unavailable (${res.status})`);
    return (await res.json()) as AutonomyState;
}

/** Tasks whose QA correction is currently held, newest hold first. */
export async function getQaHolds(): Promise<QaHold[]> {
    const res = await authFetch('/api/dispatch-insight/qa-holds', { cache: 'no-store' });
    if (!res.ok) throw new Error(`QA holds unavailable (${res.status})`);
    const data = await res.json();
    return Array.isArray(data?.holds) ? (data.holds as QaHold[]) : [];
}
