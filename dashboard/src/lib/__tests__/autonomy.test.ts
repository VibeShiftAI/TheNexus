import test from "node:test";
import assert from "node:assert/strict";

import { deriveAutonomyView, formatSince } from "../autonomy";

const NOW = Date.parse("2026-09-03T01:20:00.000Z");

test("running: no explicit pause and a live day schedule", () => {
  const view = deriveAutonomyView(
    {
      praxis: { reachable: true, error: null },
      paused: false,
      flag: { paused: false, since: "2026-09-03T01:13:37.288Z", requestedBy: "Robert" },
      inFlight: [{ taskId: "338399cd", executor: "claude-code" }],
      scheduleLive: true,
      scheduleDetail: "📅 **Day Schedule** (12 tasks):",
    },
    NOW,
  );

  assert.equal(view.mode, "running");
  assert.equal(view.label, "running");
  assert.match(view.tone, /emerald/);
  assert.match(view.reason, /Autonomy is RUNNING/);
  assert.match(view.reason, /1 run in flight/);
  assert.equal(view.inFlightCount, 1);
  // A cleared flag must not leak "who paused it" into the running state.
  assert.equal(view.who, null);
});

test("explicit pause carries who asked for it and since when", () => {
  const view = deriveAutonomyView(
    {
      praxis: { reachable: true, error: null },
      paused: true,
      flag: {
        paused: true,
        since: "2026-09-03T00:20:00.000Z",
        requestedBy: "Robert",
        reason: "pause everything",
      },
      inFlight: [{ taskId: "a" }, { taskId: "b" }],
      scheduleLive: null,
    },
    NOW,
  );

  assert.equal(view.mode, "paused");
  assert.equal(view.who, "Robert");
  assert.equal(view.since, "2026-09-03T00:20:00.000Z");
  assert.match(view.tone, /rose/);
  assert.match(view.reason, /PAUSED explicitly by Robert, 1h 0m ago/);
  assert.match(view.reason, /pause everything/);
  // The explicit stop is the one that also holds hand-started work.
  assert.match(view.reason, /including for tasks Robert started by hand/);
  assert.match(view.reason, /2 runs still in flight/);
});

test("no-live-schedule is a DIFFERENT state from an explicit pause", () => {
  const view = deriveAutonomyView(
    {
      praxis: { reachable: true, error: null },
      paused: false,
      flag: { paused: false },
      inFlight: [],
      scheduleLive: false,
      scheduleDetail: "No active day schedule. Use `schedule_day` during the morning standup to create one.",
    },
    NOW,
  );

  assert.equal(view.mode, "no_schedule");
  assert.equal(view.label, "no schedule");
  assert.match(view.tone, /amber/);
  assert.equal(view.who, null);
  assert.match(view.reason, /No live day schedule/);
  assert.match(view.reason, /schedule_day/);
  // The 2026-09-02 correction: clearing the schedule is not the stop button.
  assert.match(view.reason, /NOT an explicit stop/);
});

test("the explicit flag outranks the schedule probe", () => {
  const view = deriveAutonomyView(
    {
      praxis: { reachable: true, error: null },
      paused: true,
      flag: { paused: true, requestedBy: "Robert" },
      inFlight: [],
      scheduleLive: false,
    },
    NOW,
  );
  assert.equal(view.mode, "paused");
});

test("an unreachable Praxis reads unknown, never running", () => {
  const view = deriveAutonomyView(
    { praxis: { reachable: false, error: "fetch failed" }, inFlight: [] },
    NOW,
  );

  assert.equal(view.mode, "unknown");
  assert.notEqual(view.mode, "running");
  assert.match(view.reason, /Praxis is unreachable/);
  assert.match(view.reason, /fetch failed/);
});

test("a null snapshot reads unknown", () => {
  assert.equal(deriveAutonomyView(null, NOW).mode, "unknown");
});

test("an unanswered schedule probe reads unknown, not running", () => {
  const view = deriveAutonomyView(
    {
      praxis: { reachable: true, error: null },
      paused: false,
      flag: { paused: false },
      inFlight: [],
      scheduleLive: null,
      scheduleDetail: "day-schedule probe failed: timeout",
    },
    NOW,
  );

  assert.equal(view.mode, "unknown");
  assert.match(view.reason, /did not answer/);
  assert.match(view.reason, /timeout/);
});

test("formatSince renders minutes, hours and days", () => {
  assert.equal(formatSince("2026-09-03T01:00:00.000Z", NOW), "20m");
  assert.equal(formatSince("2026-09-02T20:00:00.000Z", NOW), "5h 20m");
  assert.equal(formatSince("2026-08-30T01:20:00.000Z", NOW), "4d");
  assert.equal(formatSince(null, NOW), null);
  assert.equal(formatSince("not-a-date", NOW), null);
});
