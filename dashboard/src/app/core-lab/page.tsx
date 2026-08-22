/**
 * Core Lab — a design bench for the living core orb. Drives CoreCanvas
 * through every activity scenario (councils mid-deliberation, crew comets,
 * failures, beacons) with synthetic inputs run through the REAL
 * deriveCoreState path, so what you see here is exactly what the bridge
 * shows when the system is actually doing these things. No live data.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FlaskConical, Play, Square } from "lucide-react";
import { CoreCanvas } from "@/components/bridge/core-canvas";
import {
  deriveCoreState,
  type CorePulse,
  type CouncilSeed,
  type DeriveCoreStateInput,
  type PulseKind,
} from "@/lib/core-state";
import type { PresenceActivity } from "@praxis/contract";

interface Scenario {
  key: string;
  label: string;
  activity: PresenceActivity;
  crew?: { id: string; label: string; state: string; detail?: string }[];
  council?: {
    kind?: string;
    phase: string;
    seats: { name: string; status: string }[];
  };
  connected?: boolean;
}

const CREW_BUSY = [
  { id: "claude-code", label: "Claude Code", state: "active", detail: "implementing" },
  { id: "codex", label: "Codex", state: "active", detail: "reviewing" },
];

const SEATS_DELIBERATING = [
  { name: "cli:claude-code", status: "running" },
  { name: "cli:codex", status: "success" },
  { name: "openrouter/deepseek", status: "running" },
  { name: "openrouter/gemini", status: "pending" },
  { name: "cli:claude-code (aggregator)", status: "pending" },
];

const SEATS_SYNTHESIS = [
  { name: "cli:claude-code", status: "success" },
  { name: "cli:codex", status: "success" },
  { name: "openrouter/deepseek", status: "timeout" },
  { name: "openrouter/gemini", status: "success" },
  { name: "cli:claude-code (aggregator)", status: "running" },
];

const SCENARIOS: Scenario[] = [
  { key: "idle", label: "Idle", activity: "idle" },
  { key: "sleeping", label: "Sleeping", activity: "sleeping" },
  { key: "thinking", label: "Thinking", activity: "thinking" },
  { key: "executing", label: "Executing", activity: "executing" },
  { key: "crew", label: "Crew working", activity: "idle", crew: CREW_BUSY },
  {
    key: "council-morning",
    label: "Morning council",
    activity: "thinking",
    council: { kind: "knowledge-council", phase: "deliberation", seats: SEATS_DELIBERATING },
  },
  {
    key: "council-synthesis",
    label: "Council synthesis",
    activity: "thinking",
    council: { kind: "knowledge-council", phase: "synthesis", seats: SEATS_SYNTHESIS },
  },
  {
    key: "council-summoned",
    label: "Summoned council + crew",
    activity: "executing",
    crew: CREW_BUSY,
    council: { phase: "deliberation", seats: SEATS_DELIBERATING },
  },
  {
    key: "crew-failure",
    label: "Executor failing",
    activity: "idle",
    crew: [
      { id: "antigravity", label: "Antigravity", state: "failed", detail: "timeout" },
      { id: "claude-code", label: "Claude Code", state: "active" },
    ],
  },
  { key: "waiting", label: "Waiting on you", activity: "waiting" },
  { key: "blocked", label: "Blocked", activity: "blocked" },
  { key: "offline", label: "Offline", activity: "offline", connected: false },
];

const PULSES: { kind: PulseKind; label: string }[] = [
  { kind: "task-complete", label: "Task complete" },
  { kind: "task-fail", label: "Task failed" },
  { kind: "hitl-created", label: "HITL raised" },
  { kind: "hitl-resolved", label: "HITL resolved" },
  { kind: "council-verdict", label: "Council verdict" },
  { kind: "trace", label: "Thought spark" },
];

function seedFor(scenario: Scenario, now: number): CouncilSeed | null {
  if (!scenario.council) return null;
  return {
    sessions: [
      {
        sessionId: `lab-${scenario.key}`,
        topic:
          scenario.council.kind === "knowledge-council"
            ? "What did the fleet learn overnight, and what should today's slate be?"
            : "Adversarial audit of the revenue strategy",
        phase: scenario.council.phase,
        createdAt: now - 4 * 60_000,
        metadata: scenario.council.kind ? { kind: scenario.council.kind } : { deliverable: "analysis" },
        voices: scenario.council.seats,
      },
    ],
    inFlight: `lab-${scenario.key}`,
    fetchedAt: now,
  };
}

export default function CoreLabPage() {
  const [scenarioKey, setScenarioKey] = useState("idle");
  const [pulses, setPulses] = useState<CorePulse[]>([]);
  const [touring, setTouring] = useState(false);
  const [tick, setTick] = useState(0);

  // Tour mode walks the scenario list; a slow tick also refreshes `now` so
  // synthetic sessions stay inside the staleness window.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), touring ? 7_000 : 30_000);
    return () => clearInterval(t);
  }, [touring]);
  useEffect(() => {
    if (!touring || tick === 0) return;
    setScenarioKey((prev) => {
      const idx = SCENARIOS.findIndex((s) => s.key === prev);
      return SCENARIOS[(idx + 1) % SCENARIOS.length].key;
    });
  }, [tick, touring]);

  const scenario = SCENARIOS.find((s) => s.key === scenarioKey) ?? SCENARIOS[0];

  const state = useMemo(() => {
    const now = Date.now();
    const input: DeriveCoreStateInput = {
      presence: {
        activity: scenario.activity,
        lastHeartbeatAt: new Date(now).toISOString(),
        summary: `Core Lab scenario: ${scenario.label}`,
      },
      connected: scenario.connected ?? true,
      recentEvents: [],
      crew: scenario.crew ?? [],
      councilSeed: seedFor(scenario, now),
      now,
    };
    const derived = deriveCoreState(input);
    return { ...derived, pulses };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick refreshes `now`
  }, [scenario, pulses, tick]);

  const firePulse = (kind: PulseKind) =>
    setPulses((prev) => [{ id: `lab-${kind}-${Date.now()}`, at: Date.now(), kind }, ...prev].slice(0, 24));

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-200">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/" className="text-slate-500 transition-colors hover:text-white" aria-label="Back to bridge">
            <ArrowLeft size={18} />
          </Link>
          <FlaskConical size={18} className="text-violet-400" />
          <h1 className="text-lg font-bold tracking-tight">Core Lab</h1>
          <span className="text-xs text-slate-500">the orb's animation vocabulary, one scenario at a time</span>
        </div>

        <div className="flex flex-col items-center rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <CoreCanvas state={state} size={340} />
          <div className={`mt-2 text-xl font-semibold ${state.textClass}`}>{state.label}</div>
          <div className="mt-1 h-4 text-xs text-slate-500">
            {state.council
              ? `${state.council.topic} — ${state.council.reported}/${state.council.expected} seats reported`
              : scenario.crew?.length
              ? scenario.crew.map((c) => c.label).join(" · ")
              : " "}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setTouring((v) => !v)}
            className={`mr-2 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              touring
                ? "border-violet-400/50 bg-violet-400/10 text-violet-200"
                : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            {touring ? <Square size={12} /> : <Play size={12} />}
            {touring ? "Stop tour" : "Tour all"}
          </button>
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              onClick={() => {
                setTouring(false);
                setScenarioKey(s.key);
              }}
              className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                s.key === scenarioKey
                  ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                  : "border-slate-800 bg-slate-900/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-wide text-slate-600">fire a moment</span>
          {PULSES.map((p) => (
            <button
              key={p.kind}
              onClick={() => firePulse(p.kind)}
              className="rounded-md border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              {p.label}
            </button>
          ))}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-600">
          Scenarios run through the same deriveCoreState the bridge uses — synthetic presence, crew, and
          council-seed inputs, zero live data. Trace sparks only render while the orb is thinking or executing,
          same as on the bridge.
        </p>
      </div>
    </div>
  );
}
