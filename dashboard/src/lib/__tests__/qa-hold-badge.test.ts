import test from "node:test";
import assert from "node:assert/strict";

import { qaHoldBadge, shortHoldReason } from "../qa-hold-badge";
import type { QaHold } from "../nexus";

/**
 * Fixture built from a real `qa_correction_withheld_paused` row in the Nexus
 * ag_events table (event 12938, task c3d1715c, held 2026-08-31) — the shape
 * server/routes/dispatch-insight.js GET /qa-holds returns after parsing the
 * event message into its reason and findings.
 */
const HELD: QaHold = {
  taskId: "c3d1715c-1641-413d-aa34-86d938cdbcb8",
  title: "Remove the tap-bound token gate on QA accept-as-is",
  status: "todo",
  projectId: "c11f3f92-0645-4746-a7d3-0b0722e5a2d3",
  reason:
    "no live day schedule — autonomy is paused. Install a day plan (morning routine) or dispatch this task explicitly to resume it; PRAXIS_AUTONOMY_WHEN_PAUSED=1 overrides.",
  heldAt: "2026-08-31 14:15:10",
  findings:
    "Q1: No. The Praxis backend correctly removes the token gate and its regression coverage passes 138/138, but the required “any surface” outcome remains incomplete.",
  eventId: 12938,
  operatorInitiated: false,
};

test("a withheld correction badges as QA-failed-correction-held, not as a todo", () => {
  const badge = qaHoldBadge(HELD);

  assert.match(badge.label, /^QA failed — correction held \(/);
  // The reason is IN the badge — that is the whole point of the surface.
  assert.match(badge.label, /no live day schedule/);
  assert.equal(badge.shortReason, "no live day schedule");
});

test("the badge links to the findings on the task screen", () => {
  const badge = qaHoldBadge(HELD);

  assert.equal(badge.findingsHref, "/task/c3d1715c-1641-413d-aa34-86d938cdbcb8#qa-hold");
  assert.equal(badge.hasFindings, true);
});

test("the hover title states the facts an ordinary todo does not carry", () => {
  const badge = qaHoldBadge(HELD);

  assert.match(badge.title, /FAILED/);
  assert.match(badge.title, /no strike spent/);
  assert.match(badge.title, /parked at todo/);
  assert.match(badge.title, /resumes it with them/);
  assert.match(badge.title, /2026-08-31 14:15:10/);
  // Full reason, not the truncated chip form.
  assert.match(badge.title, /PRAXIS_AUTONOMY_WHEN_PAUSED=1 overrides/);
});

test("an operator-started task says the explicit stop holds it too", () => {
  const badge = qaHoldBadge({
    ...HELD,
    operatorInitiated: true,
    reason: "an explicit pause is in effect (requested by Robert).",
  });

  assert.match(badge.title, /started this task by hand/);
  assert.equal(badge.shortReason, "an explicit pause is in effect (requested by Robert)");
});

test("a hold with no findings body still badges, and says so", () => {
  const badge = qaHoldBadge({ ...HELD, findings: null });

  assert.equal(badge.hasFindings, false);
  assert.match(badge.label, /QA failed — correction held/);
  assert.doesNotMatch(badge.title, /Open the task to read the findings/);
});

test("shortHoldReason cuts the remediation advice but never returns empty", () => {
  assert.equal(
    shortHoldReason("no live day schedule — autonomy is paused. Install a day plan."),
    "no live day schedule",
  );
  assert.equal(shortHoldReason("autonomy is paused explicitly."), "autonomy is paused explicitly");
  assert.equal(shortHoldReason(null), "autonomy paused");
  assert.equal(shortHoldReason("   "), "autonomy paused");
});
