/**
 * Core state — the fused "what is the whole system doing right now" model
 * behind the living core orb. The orb used to render presence.activity alone,
 * so it sat "Idle" while three executors ground through dispatches and a
 * council deliberated. This module folds every activity source into one
 * deterministic snapshot the renderer (and labels) draw from:
 *
 *   - presence        Praxis himself (idle/thinking/executing/…)
 *   - crew            CLI executors + local LLM (useCrewActivity)
 *   - council         live deliberations, event-sourced from `council.update`
 *                     stream events with the REST sessions poll as seed
 *   - pulses          one-shot moments (task done/failed, HITL, verdicts)
 *                     the renderer turns into ripples and sparks
 *
 * Pure function of its inputs — no imports with runtime cost, so the vm-based
 * test harness (see __tests__/core-state.test.mjs) can load it standalone.
 */

import type { PresenceActivity, PresenceState, StreamEvent } from "@praxis/contract";

// ── Output model ─────────────────────────────────────────────────────────

export type CouncilKind = "morning" | "status" | "summoned";
export type SeatStatus = "pending" | "running" | "success" | "error";

export interface CoreSeat {
  name: string;
  status: SeatStatus;
  aggregator: boolean;
}

export interface CoreCouncil {
  sessionId: string;
  topic: string;
  phase: "setup" | "deliberation" | "synthesis" | "refinement" | "complete";
  kind: CouncilKind;
  seats: CoreSeat[];
  /** Reference theses landed / expected (aggregator excluded). */
  reported: number;
  expected: number;
}

export interface CoreWorker {
  id: string;
  label: string;
  state: "active" | "done" | "failed";
  detail?: string;
}

export type PulseKind =
  | "task-complete"
  | "task-fail"
  | "hitl-created"
  | "hitl-resolved"
  | "council-verdict"
  | "trace";

export interface CorePulse {
  id: string;
  /** Epoch ms. The renderer animates pulses younger than its own window. */
  at: number;
  kind: PulseKind;
}

export interface CoreState {
  activity: PresenceActivity;
  council: CoreCouncil | null;
  workers: CoreWorker[];
  /** Praxis is blocked on Robert (presence "waiting"). */
  waiting: boolean;
  /** 0..1 — overall busyness; drives core pulse rate and glow. */
  intensity: number;
  /** Recent one-shot moments; the renderer animates the ones it hasn't seen. */
  pulses: CorePulse[];
  label: string;
  textClass: string;
}

// ── Inputs ───────────────────────────────────────────────────────────────

/** Minimal slice of a CouncilSessionSummary the seed poll provides. */
export interface CouncilSeedSession {
  sessionId: string;
  topic: string;
  phase: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
  voices?: { name: string; status: string }[];
}

export interface CouncilSeed {
  sessions: CouncilSeedSession[];
  /** Praxis's own "a council is running right now" flag — authoritative. */
  inFlight: string | null;
  fetchedAt: number;
}

export interface DeriveCoreStateInput {
  presence: PresenceState | null;
  connected: boolean;
  recentEvents: StreamEvent[];
  crew: { id: string; label: string; state: string; detail?: string }[];
  councilSeed: CouncilSeed | null;
  now: number;
}

// ── Tunables ─────────────────────────────────────────────────────────────

/**
 * An incomplete council with no fresh signal older than this is treated as
 * interrupted (Praxis restarts kill in-flight deliberations). Deliberately
 * far tighter than the chamber page's 3h archive window — the orb must never
 * spend an afternoon claiming a dead council is in session.
 */
export const COUNCIL_STALE_MS = 45 * 60 * 1000;

const AGGREGATOR_RE = /\(aggregator\)\s*$/;

const PHASES = ["setup", "deliberation", "synthesis", "refinement", "complete"] as const;

// ── Derivation ───────────────────────────────────────────────────────────

function normalizeSeatStatus(status: string): SeatStatus {
  if (status === "pending" || status === "running" || status === "success") return status;
  return "error"; // parse_error / error / timeout all render as a failed seat
}

function normalizeKind(kind: unknown): CouncilKind {
  if (kind === "knowledge-council") return "morning";
  if (kind === "status-report") return "status";
  return "summoned";
}

function normalizePhase(phase: string): CoreCouncil["phase"] {
  return (PHASES as readonly string[]).includes(phase) ? (phase as CoreCouncil["phase"]) : "deliberation";
}

interface CouncilCandidate {
  council: CoreCouncil;
  /** When we last heard anything about this session. */
  freshAt: number;
  convenedAt: number;
}

function candidateFromEvent(event: StreamEvent & { type: "council.update" }): CouncilCandidate {
  const c = event.council;
  const seats: CoreSeat[] = c.seats.map((s) => ({
    name: s.name,
    status: normalizeSeatStatus(s.status),
    aggregator: Boolean(s.aggregator) || AGGREGATOR_RE.test(s.name),
  }));
  const expected = c.expectedTheses ?? Math.max(seats.filter((s) => !s.aggregator).length, 1);
  return {
    council: {
      sessionId: c.sessionId,
      topic: c.topic,
      phase: normalizePhase(c.phase),
      kind: normalizeKind(c.kind),
      seats,
      reported: Math.min(c.thesisCount, expected),
      expected,
    },
    freshAt: Date.parse(event.at),
    convenedAt: c.convenedAt,
  };
}

function candidateFromSeed(session: CouncilSeedSession, seed: CouncilSeed): CouncilCandidate {
  const seats: CoreSeat[] = (session.voices ?? []).map((v) => ({
    name: v.name,
    status: normalizeSeatStatus(v.status),
    aggregator: AGGREGATOR_RE.test(v.name),
  }));
  const references = seats.filter((s) => !s.aggregator);
  return {
    council: {
      sessionId: session.sessionId,
      topic: session.topic,
      phase: normalizePhase(session.phase),
      kind: normalizeKind(session.metadata?.kind ?? (session.metadata?.deliverable ? "summoned" : undefined)),
      seats,
      reported: references.filter((s) => s.status === "success" || s.status === "error").length,
      expected: Math.max(references.length, 1),
    },
    freshAt: seed.fetchedAt,
    convenedAt: session.createdAt,
  };
}

/** Latest live council across the event stream and the seed poll, or null. */
function deriveCouncil(input: DeriveCoreStateInput): CoreCouncil | null {
  const byId = new Map<string, CouncilCandidate>();

  // Seed first (older), then events newest-last so fresher data overwrites.
  if (input.councilSeed) {
    for (const session of input.councilSeed.sessions) {
      const candidate = candidateFromSeed(session, input.councilSeed);
      // The inFlight flag is Praxis saying "this one is running" — trust it
      // as fresh even when the session file itself is minutes old.
      if (session.sessionId === input.councilSeed.inFlight) {
        candidate.freshAt = input.councilSeed.fetchedAt;
      }
      byId.set(session.sessionId, candidate);
    }
  }
  for (let i = input.recentEvents.length - 1; i >= 0; i--) {
    const event = input.recentEvents[i];
    if (event.type !== "council.update") continue;
    const candidate = candidateFromEvent(event as StreamEvent & { type: "council.update" });
    const existing = byId.get(candidate.council.sessionId);
    if (!existing || candidate.freshAt >= existing.freshAt) byId.set(candidate.council.sessionId, candidate);
  }

  let best: CouncilCandidate | null = null;
  for (const candidate of byId.values()) {
    if (candidate.council.phase === "complete") continue;
    if (input.now - candidate.freshAt > COUNCIL_STALE_MS) continue;
    if (!best || candidate.convenedAt > best.convenedAt) best = candidate;
  }
  return best?.council ?? null;
}

/** One-shot pulse moments the renderer turns into ripples/sparks. */
export function derivePulses(recentEvents: StreamEvent[]): CorePulse[] {
  const pulses: CorePulse[] = [];
  for (const event of recentEvents) {
    if (pulses.length >= 16) break;
    const at = Date.parse(event.at);
    switch (event.type) {
      case "task.completed":
        pulses.push({ id: event.eventId, at, kind: event.result?.outcome === "success" ? "task-complete" : "task-fail" });
        break;
      case "task.failed":
        pulses.push({ id: event.eventId, at, kind: "task-fail" });
        break;
      case "hitl.created":
        pulses.push({ id: event.eventId, at, kind: "hitl-created" });
        break;
      case "hitl.resolved":
        pulses.push({ id: event.eventId, at, kind: "hitl-resolved" });
        break;
      case "thinking.trace":
        pulses.push({ id: event.eventId, at, kind: "trace" });
        break;
      case "council.update":
        if (event.council.phase === "complete") {
          pulses.push({ id: event.eventId, at, kind: "council-verdict" });
        }
        break;
    }
  }
  return pulses;
}

const LABELS: Record<string, { label: string; textClass: string }> = {
  offline: { label: "Offline", textClass: "text-slate-400" },
  blocked: { label: "Blocked", textClass: "text-red-300" },
  waiting: { label: "Waiting on you", textClass: "text-amber-300" },
  thinking: { label: "Thinking", textClass: "text-violet-300" },
  executing: { label: "Executing", textClass: "text-emerald-300" },
  crew: { label: "Crew Working", textClass: "text-emerald-300" },
  sleeping: { label: "Sleeping", textClass: "text-blue-300" },
  idle: { label: "Idle", textClass: "text-cyan-300" },
};

const COUNCIL_LABEL: Record<CouncilKind, { label: string; textClass: string }> = {
  morning: { label: "Morning Council", textClass: "text-amber-300" },
  status: { label: "In Council", textClass: "text-cyan-300" },
  summoned: { label: "In Council", textClass: "text-violet-300" },
};

const BASE_INTENSITY: Record<PresenceActivity, number> = {
  offline: 0.04,
  sleeping: 0.08,
  idle: 0.15,
  waiting: 0.35,
  blocked: 0.5,
  thinking: 0.55,
  executing: 0.65,
};

export function deriveCoreState(input: DeriveCoreStateInput): CoreState {
  const activity: PresenceActivity = input.connected
    ? (input.presence?.activity ?? "offline")
    : "offline";

  const council = activity === "offline" ? null : deriveCouncil(input);
  const workers: CoreWorker[] = input.crew
    .filter((m) => m.state === "active" || m.state === "done" || m.state === "failed")
    .map((m) => ({ id: m.id, label: m.label, state: m.state as CoreWorker["state"], detail: m.detail }));
  const activeWorkers = workers.filter((w) => w.state === "active").length;
  const waiting = activity === "waiting";

  let intensity = BASE_INTENSITY[activity] ?? 0.15;
  intensity += Math.min(activeWorkers * 0.12, 0.36);
  if (council) intensity += council.phase === "synthesis" || council.phase === "refinement" ? 0.35 : 0.25;
  intensity = Math.min(intensity, 1);

  // Label priority: things needing Robert first, then the council spectacle,
  // then Praxis's own work, then the crew covering for an idle Praxis.
  let key: string = activity;
  if (activity !== "offline" && activity !== "blocked" && activity !== "waiting") {
    if (council) key = "council";
    else if ((activity === "idle" || activity === "sleeping") && activeWorkers > 0) key = "crew";
  }
  const { label, textClass } = key === "council" && council ? COUNCIL_LABEL[council.kind] : LABELS[key] ?? LABELS.idle;

  return {
    activity,
    council,
    workers,
    waiting,
    intensity,
    pulses: derivePulses(input.recentEvents),
    label,
    textClass,
  };
}
