/**
 * crew-lanes: reconcile event-derived executor lanes against the run registry.
 *
 * Why (2026-10-03, task 60c8716a): the lanes `hooks/use-crew-activity` folds
 * out of the live frame ring only ever moved forward on a newer frame, so an
 * "active" lane never expired. Whenever the closing `task.completed` frame was
 * missed (backend restart, sleep, a gap the relay's ring buffer could not
 * replay), the crew strip and the Ops "Executor runs" list kept showing a run
 * the registry had closed, and the Ops page synthesized a phantom active row
 * for it. The registry snapshot (`/api/praxis/dispatch-state`) is
 * authoritative for every run it knows about; the ring is only trusted for
 * what the registry has not caught up to yet.
 *
 * Pure functions, no React: unit-tested in `lib/__tests__/crew-lanes.test.ts`.
 */

export interface LaneLike {
    taskId: string;
    status: "active" | "done" | "failed";
    /** Epoch ms of the frame that produced this lane. */
    at: number;
}

export interface RegistryRunLike {
    taskId: string;
    executor: string;
    status: string;
    updatedAt?: string;
    startedAt?: string;
}

/**
 * A registry record closed this soon before the lane's last frame still wins:
 * progress frames and the registry write are not strictly ordered.
 */
export const REDISPATCH_GRACE_MS = 15_000;

/**
 * An active lane the registry has never heard of is trusted only this long
 * after its last frame. Right after a dispatch the frame beats the registry
 * write, which is normal; after a quiet window this long the run was closed
 * by a frame we never received, or predates the running Praxis process.
 */
export const ORPHAN_LANE_TTL_MS = 10 * 60_000;

/**
 * Should this "active" lane yield to the registry?
 *
 *   - `registryRuns === null`: the registry is unavailable (never loaded, or
 *     every fetch so far failed). Nothing authoritative to compare against,
 *     so the stream's word stands.
 *   - The registry has the task and marks it non-active with a timestamp at
 *     or after the lane's frame (minus the grace): the run is over.
 *   - The registry has the task and marks it active: the lane is confirmed.
 *   - The registry does not have the task: keep the lane while it is young,
 *     drop it once it has been silent for `ORPHAN_LANE_TTL_MS`.
 */
export function laneSupersededByRegistry(
    lane: LaneLike,
    executor: string,
    registryRuns: readonly RegistryRunLike[] | null,
    now: number,
): boolean {
    if (lane.status !== "active") return false;
    if (!registryRuns) return false;
    const run =
        registryRuns.find((r) => r.taskId === lane.taskId && r.executor === executor) ??
        registryRuns.find((r) => r.taskId === lane.taskId);
    if (run) {
        if (run.status === "active") return false;
        const runAt = Date.parse(run.updatedAt ?? run.startedAt ?? "");
        if (Number.isNaN(runAt)) return true;
        return runAt >= lane.at - REDISPATCH_GRACE_MS;
    }
    return now - lane.at > ORPHAN_LANE_TTL_MS;
}
