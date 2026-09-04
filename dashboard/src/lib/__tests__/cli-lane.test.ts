import test from "node:test";
import assert from "node:assert/strict";

import { cliLaneSummary, deriveCliLane, formatDuration } from "../cli-lane";

const NOW = Date.parse("2026-09-03T01:20:00.000Z");

/**
 * Trimmed from a real GET http://127.0.0.1:54322/api/dispatch/state on
 * 2026-09-03 — the gate saturated at limit 1 with one task queued behind it.
 */
function snapshot() {
  return {
    executors: {
      runs: [
        {
          taskId: "338399cd",
          executor: "claude-code",
          title: "Dashboard: show why work is queued",
          kind: "task",
          phase: "testing",
          status: "active",
          startedAt: "2026-09-03T01:14:00.802Z",
        },
        {
          taskId: "agent-eod-review",
          executor: "claude-code",
          title: "Agent: eod-review",
          kind: "agent",
          phase: "completed",
          status: "completed",
          startedAt: "2026-09-03T01:00:00.381Z",
        },
      ],
      cliQueue: [
        {
          taskId: "e524649b",
          title: "Living STATE.md replaces the March CONTEXT.md",
          executor: "claude-code",
          enqueuedAt: "2026-09-03T01:14:00.580Z",
        },
        {
          taskId: "5b52e0f0",
          title: "Close the QA learning loop",
          executor: "codex",
          enqueuedAt: "2026-09-03T00:20:00.000Z",
        },
      ],
      cliConcurrency: {
        limit: 1,
        burst: false,
        reason:
          "serial: outside the 6:00–17:00 burst window — cap 1; occupancy 1/1 (claude-code 1/1, codex 0/1, antigravity 0/1), 1 queued",
        slots: { "claude-code": 1, codex: 1, antigravity: 1 },
        metrics: null,
        thresholds: { memFreeMinPct: 25, swapoutMaxMbPerSec: 1 },
        active: 1,
        free: 0,
        queued: 1,
        occupancy: {
          "claude-code": { active: 1, slots: 1, free: 0 },
          codex: { active: 0, slots: 1, free: 0 },
          antigravity: { active: 0, slots: 1, free: 0 },
        },
      },
      posture: {
        mode: "nominal",
        available: ["claude-code", "codex", "antigravity"],
        suspended: [],
        summary: "fleet NOMINAL — all 3 workers routable",
      },
      attemptStalls: { violations: [], requeues: [], pending: 0, graceMinutes: 15 },
    },
  };
}

test("the concurrency gate reason is carried through verbatim", () => {
  const view = deriveCliLane(snapshot(), NOW);

  assert.equal(
    view.gate.reason,
    "serial: outside the 6:00–17:00 burst window — cap 1; occupancy 1/1 (claude-code 1/1, codex 0/1, antigravity 0/1), 1 queued",
  );
  assert.equal(view.gate.limit, 1);
  assert.equal(view.gate.active, 1);
  assert.equal(view.gate.free, 0);
  assert.equal(view.gate.burst, false);
  // free === 0 means the next dispatch queues.
  assert.equal(view.gate.saturated, true);
  assert.equal(view.unavailable, false);
});

test("queue entries get 1-based positions and a waiting-since clock", () => {
  const view = deriveCliLane(snapshot(), NOW);

  assert.equal(view.queue.length, 2);
  assert.deepEqual(
    view.queue.map((q) => q.position),
    [1, 2],
  );
  // Position 1 is what Praxis pulls next.
  assert.equal(view.queue[0].taskId, "e524649b");
  assert.equal(view.queue[0].executorLabel, "Claude Code");
  assert.equal(view.queue[0].enqueuedAt, "2026-09-03T01:14:00.580Z");
  assert.equal(view.queue[0].waitingMs, NOW - Date.parse("2026-09-03T01:14:00.580Z"));
  assert.equal(formatDuration(view.queue[0].waitingMs), "5m");

  assert.equal(view.queue[1].executorLabel, "Codex");
  assert.equal(formatDuration(view.queue[1].waitingMs), "1h 0m");
});

test("per-executor rows carry only ACTIVE runs, with slot occupancy", () => {
  const view = deriveCliLane(snapshot(), NOW);
  const byName = new Map(view.executors.map((e) => [e.name, e]));

  const claude = byName.get("claude-code")!;
  // The completed agent run must not read as occupying a slot.
  assert.equal(claude.runs.length, 1);
  assert.equal(claude.runs[0].taskId, "338399cd");
  assert.equal(claude.runs[0].phase, "testing");
  assert.equal(formatDuration(claude.runs[0].runningMs), "5m");
  assert.equal(claude.slots, 1);
  assert.equal(claude.free, 0);
  assert.equal(claude.suspended, false);

  assert.equal(byName.get("codex")!.runs.length, 0);
  assert.equal(byName.get("antigravity")!.runs.length, 0);
});

test("a suspended worker in the posture is flagged on its lane row", () => {
  const state = snapshot();
  state.executors.posture.suspended = ["codex"];
  state.executors.posture.available = ["claude-code", "antigravity"];

  const view = deriveCliLane(state, NOW);
  const byName = new Map(view.executors.map((e) => [e.name, e]));
  assert.equal(byName.get("codex")!.suspended, true);
  assert.equal(byName.get("claude-code")!.suspended, false);
});

test("structured gate numbers render against their thresholds once Praxis sends them", () => {
  const state = snapshot();
  // The shape Praxis task sr-j introduces — numbers beside the sentence.
  state.executors.cliConcurrency.metrics = { memFreePct: 55.4, swapoutMbPerSec: 0.25 };

  const view = deriveCliLane(state, NOW);
  assert.deepEqual(view.gate.readouts, [
    { label: "mem free", value: "55%", title: "Gate opens at 25% free memory" },
    { label: "swap rate", value: "0.3 MB/s", title: "Gate closes above 1 MB/s" },
  ]);
});

test("a Praxis without the CLI-lane fields reports unavailable, not an empty gate", () => {
  const view = deriveCliLane({ executors: { runs: [] } }, NOW);

  assert.equal(view.unavailable, true);
  assert.equal(view.gate.reason, null);
  assert.equal(view.gate.limit, null);
  assert.equal(view.gate.queued, null);
  assert.deepEqual(view.queue, []);
  assert.equal(cliLaneSummary(view), "CLI lane telemetry unavailable");
});

test("an empty queue on a live gate is a real answer, not 'unavailable'", () => {
  const state = snapshot();
  state.executors.cliQueue = [];
  state.executors.cliConcurrency.queued = 0;
  state.executors.cliConcurrency.free = 1;

  const view = deriveCliLane(state, NOW);
  assert.equal(view.unavailable, false);
  assert.equal(view.gate.queued, 0);
  assert.equal(view.gate.saturated, false);
  assert.equal(cliLaneSummary(view), "1 CLI run active, limit 1, none queued");
});

test("missing timestamps degrade to null rather than a bogus zero clock", () => {
  const view = deriveCliLane(
    {
      executors: {
        runs: [],
        cliQueue: [{ taskId: "x", title: "no enqueue time", executor: "codex" }],
        cliConcurrency: { reason: "held" },
      },
    },
    NOW,
  );

  assert.equal(view.queue[0].waitingMs, null);
  assert.equal(formatDuration(view.queue[0].waitingMs), null);
  assert.equal(view.queue[0].position, 1);
  // No `free`/`limit` reported → cannot claim saturation.
  assert.equal(view.gate.saturated, false);
});

test("stalled attempts are surfaced from attemptStalls", () => {
  const state = snapshot();
  state.executors.attemptStalls = {
    violations: [{ taskId: "a" }, { taskId: "b" }],
    requeues: [],
    pending: 2,
    graceMinutes: 15,
  };
  assert.equal(deriveCliLane(state, NOW).stalledCount, 2);
});
