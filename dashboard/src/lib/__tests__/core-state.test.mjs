import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// core-state.ts is deliberately runtime-import-free (type imports only) so it
// loads standalone in a vm sandbox — same harness as nbody.test.mjs.
function loadCoreState() {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/core-state.ts"), "utf-8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { exports: module.exports, module };
  vm.runInNewContext(compiled, sandbox);
  return module.exports;
}

const { deriveCoreState, derivePulses, COUNCIL_STALE_MS } = loadCoreState();

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function presence(activity, extra = {}) {
  return { activity, lastHeartbeatAt: new Date(NOW).toISOString(), ...extra };
}

function councilEvent({
  at = NOW - 5_000,
  sessionId = "council-abc",
  phase = "deliberation",
  kind = "knowledge-council",
  seats,
  thesisCount = 0,
  expectedTheses = 2,
  verdict,
} = {}) {
  return {
    type: "council.update",
    at: new Date(at).toISOString(),
    eventId: `evt-${sessionId}-${at}-${phase}`,
    council: {
      sessionId,
      topic: "Weigh the options",
      phase,
      kind,
      seats: seats ?? [
        { name: "cli:codex", status: "running" },
        { name: "openrouter/x", status: "running" },
        { name: "cli:claude-code (aggregator)", status: "pending", aggregator: true },
      ],
      convenedAt: at - 60_000,
      thesisCount,
      expectedTheses,
      ...(verdict ? { verdict } : {}),
    },
  };
}

function derive(overrides = {}) {
  return deriveCoreState({
    presence: presence("idle"),
    connected: true,
    recentEvents: [],
    crew: [],
    councilSeed: null,
    now: NOW,
    ...overrides,
  });
}

test("idle with nothing happening stays a quiet idle orb", () => {
  const state = derive();
  assert.equal(state.label, "Idle");
  assert.equal(state.council, null);
  assert.equal(state.workers.length, 0);
  assert.ok(state.intensity < 0.2);
});

test("active crew flips an idle orb to Crew Working and raises intensity", () => {
  const state = derive({
    crew: [
      { id: "claude-code", label: "Claude Code", state: "active", detail: "implementing" },
      { id: "codex", label: "Codex", state: "active" },
      { id: "antigravity", label: "Antigravity", state: "idle" },
    ],
  });
  assert.equal(state.label, "Crew Working");
  assert.equal(state.workers.filter((w) => w.state === "active").length, 2);
  assert.ok(state.intensity > 0.3);
});

test("a live council.update event puts the orb in council mode", () => {
  const state = derive({ recentEvents: [councilEvent({ thesisCount: 1 })] });
  assert.ok(state.council);
  assert.equal(state.council.kind, "morning");
  assert.equal(state.label, "Morning Council");
  assert.equal(state.council.seats.length, 3);
  assert.equal(state.council.seats.filter((s) => s.aggregator).length, 1);
  assert.equal(state.council.reported, 1);
  assert.equal(state.council.expected, 2);
});

test("newest event per session wins: completion clears the council", () => {
  const events = [
    councilEvent({ at: NOW - 1_000, phase: "complete", verdict: "success", thesisCount: 2 }),
    councilEvent({ at: NOW - 20_000, phase: "synthesis", thesisCount: 2 }),
  ];
  const state = derive({ recentEvents: events });
  assert.equal(state.council, null);
  const pulses = derivePulses(events);
  assert.ok(pulses.some((p) => p.kind === "council-verdict"));
});

test("seed poll with inFlight surfaces a council convened before page load", () => {
  const state = derive({
    councilSeed: {
      sessions: [
        {
          sessionId: "council-early",
          topic: "Before you arrived",
          phase: "deliberation",
          createdAt: NOW - 10 * 60_000,
          metadata: { deliverable: "analysis" },
          voices: [
            { name: "cli:codex", status: "success" },
            { name: "openrouter/x", status: "timeout" },
            { name: "cli:claude-code (aggregator)", status: "pending" },
          ],
        },
      ],
      inFlight: "council-early",
      fetchedAt: NOW - 5_000,
    },
  });
  assert.ok(state.council);
  assert.equal(state.council.kind, "summoned");
  assert.equal(state.label, "In Council");
  assert.equal(state.council.reported, 2); // success + timeout both count as landed
  const timedOut = state.council.seats.find((s) => s.name === "openrouter/x");
  assert.equal(timedOut.status, "error"); // timeout normalizes to a failed seat
});

test("an incomplete council with no fresh signal is treated as interrupted", () => {
  const stale = councilEvent({ at: NOW - COUNCIL_STALE_MS - 60_000 });
  const state = derive({ recentEvents: [stale] });
  assert.equal(state.council, null);
});

test("a fresher completion event beats a stale seed that still says inFlight", () => {
  const state = derive({
    councilSeed: {
      sessions: [
        {
          sessionId: "council-abc",
          topic: "Weigh the options",
          phase: "deliberation",
          createdAt: NOW - 8 * 60_000,
          voices: [],
        },
      ],
      inFlight: "council-abc",
      fetchedAt: NOW - 25_000,
    },
    recentEvents: [councilEvent({ at: NOW - 2_000, phase: "complete", verdict: "error" })],
  });
  assert.equal(state.council, null);
});

test("needs-Robert states outrank the council spectacle", () => {
  const waiting = derive({ presence: presence("waiting"), recentEvents: [councilEvent()] });
  assert.equal(waiting.label, "Waiting on you");
  assert.equal(waiting.waiting, true);
  assert.ok(waiting.council, "council still present for the renderer");

  const blocked = derive({ presence: presence("blocked"), recentEvents: [councilEvent()] });
  assert.equal(blocked.label, "Blocked");
});

test("disconnected stream renders offline regardless of other signals", () => {
  const state = derive({
    connected: false,
    presence: presence("executing"),
    recentEvents: [councilEvent()],
    crew: [{ id: "codex", label: "Codex", state: "active" }],
  });
  assert.equal(state.activity, "offline");
  assert.equal(state.label, "Offline");
  assert.equal(state.council, null);
});

test("pulses map task and hitl events to ripple kinds", () => {
  const pulses = derivePulses([
    { type: "task.completed", at: new Date(NOW).toISOString(), eventId: "e1", taskId: "t", result: { outcome: "success" } },
    { type: "task.completed", at: new Date(NOW).toISOString(), eventId: "e2", taskId: "t", result: { outcome: "failure" } },
    { type: "task.failed", at: new Date(NOW).toISOString(), eventId: "e3", taskId: "t", error: "x" },
    { type: "hitl.created", at: new Date(NOW).toISOString(), eventId: "e4", request: { id: "h" } },
    { type: "heartbeat", at: new Date(NOW).toISOString(), eventId: "e5" },
  ]);
  // Array.from re-realms the vm-created array so deepEqual's prototype check passes.
  assert.deepEqual(
    Array.from(pulses, (p) => p.kind),
    ["task-complete", "task-fail", "task-fail", "hitl-created"],
  );
});
