/**
 * Autonomy state — may the fleet start work on its own right now?
 *
 * Praxis gates autonomous dispatch on two conditions that are NOT the same
 * state and must not render as one (src/orchestrator/autonomy-pause.ts):
 *
 *   - EXPLICIT pause: Robert said "pause everything". Persisted to disk so it
 *     survives the launchd restart that killing the process guarantees. This
 *     one also withholds QA corrections for work Robert started by hand.
 *   - NO LIVE DAY SCHEDULE: the implicit "the day is not running" state. It
 *     stops the autonomous planner opening new slates; it does NOT withhold a
 *     continuation.
 *
 * A third case matters just as much: the probe could not run. The cockpit's
 * honesty rule is that it never reads green over a runtime it cannot see, so
 * an unreachable Praxis renders "unknown", never "running".
 *
 * Pure derivation over the composed relay payload — see
 * server/routes/dispatch-insight.js GET /autonomy.
 */

import type { AutonomyState } from "@/lib/nexus";

export type AutonomyMode = "running" | "paused" | "no_schedule" | "unknown";

export interface AutonomyView {
  mode: AutonomyMode;
  /** Short chip text, e.g. "paused" / "no schedule". */
  label: string;
  /** Tailwind text class matching the bridge's existing pill tones. */
  tone: string;
  /** Who asked for the stop — explicit pauses only. */
  who: string | null;
  /** ISO timestamp the current state began, when known. */
  since: string | null;
  /** Full explanation, rendered as the hover title. */
  reason: string;
  /** Runs still moving. A pause stops work STARTING, never work finishing. */
  inFlightCount: number;
}

/** "2h 14m" — how long the current autonomy state has held. */
export function formatSince(since: string | null, now = Date.now()): string | null {
  if (!since) return null;
  const at = new Date(since).getTime();
  if (!Number.isFinite(at)) return null;
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Fold the relay payload into the indicator's three (plus unknown) states.
 *
 * Precedence mirrors Praxis: the explicit flag is checked first and outranks
 * the schedule probe, because an explicit stop is a contemporaneous
 * instruction and holds more than the implicit state does.
 */
export function deriveAutonomyView(
  state: AutonomyState | null | undefined,
  now = Date.now(),
): AutonomyView {
  const inFlightCount = state?.inFlight?.length ?? 0;

  if (!state || state.praxis?.reachable === false) {
    return {
      mode: "unknown",
      label: "unknown",
      tone: "text-slate-500",
      who: null,
      since: null,
      reason:
        "Autonomy state unknown — Praxis is unreachable" +
        (state?.praxis?.error ? ` (${state.praxis.error}).` : ".") +
        " The fleet may or may not be dispatching; this reads unknown rather than running.",
      inFlightCount,
    };
  }

  if (state.paused === true) {
    const who = state.flag?.requestedBy?.trim() || null;
    const since = state.flag?.since ?? null;
    const held = formatSince(since, now);
    const detail = state.flag?.reason?.trim();
    return {
      mode: "paused",
      label: "paused",
      tone: "text-rose-300",
      who,
      since,
      reason:
        `Autonomy is PAUSED explicitly${who ? ` by ${who}` : ""}${held ? `, ${held} ago` : ""}. ` +
        (detail ? `${detail} ` : "") +
        "Nothing new dispatches and QA corrections are withheld — including for tasks Robert started by hand. " +
        (inFlightCount > 0
          ? `${inFlightCount} run${inFlightCount === 1 ? "" : "s"} still in flight: a pause stops work starting, never work finishing.`
          : "Nothing is in flight."),
      inFlightCount,
    };
  }

  if (state.scheduleLive === false) {
    return {
      mode: "no_schedule",
      label: "no schedule",
      tone: "text-amber-300",
      who: null,
      since: null,
      reason:
        "No live day schedule — the autonomous planner will not open new work. " +
        (state.scheduleDetail?.trim() ? `${state.scheduleDetail.trim()} ` : "") +
        "This is NOT an explicit stop: a task dispatched by hand still runs, and corrections for work already under way are not withheld.",
      inFlightCount,
    };
  }

  if (state.scheduleLive == null) {
    return {
      mode: "unknown",
      label: "unknown",
      tone: "text-slate-500",
      who: null,
      since: null,
      reason:
        "Explicit pause is clear, but the day-schedule probe did not answer" +
        (state.scheduleDetail?.trim() ? ` (${state.scheduleDetail.trim()})` : "") +
        ", so whether the autonomous planner is live is unknown.",
      inFlightCount,
    };
  }

  return {
    mode: "running",
    label: "running",
    tone: "text-emerald-300",
    who: null,
    since: null,
    reason:
      "Autonomy is RUNNING — no explicit pause and a live day schedule, so the fleet dispatches on its own. " +
      (state.scheduleDetail?.trim() ? `${state.scheduleDetail.trim()} ` : "") +
      (inFlightCount > 0
        ? `${inFlightCount} run${inFlightCount === 1 ? "" : "s"} in flight.`
        : "Nothing in flight right now."),
    inFlightCount,
  };
}
