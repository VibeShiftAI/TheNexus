import test from "node:test";
import assert from "node:assert/strict";

import { EVIDENCE_TONE_CLASSES, evidenceBadge, type EvidenceSummary } from "../task-evidence";

/**
 * Shapes match GET /api/task-evidence?task_ids= (server/routes/task-evidence.js),
 * taken from a live read on 2026-10-01: task 7bf1a379 completed with both
 * gates declared but QA outcome `none` (the reviewer hit its quota).
 */
const PARTIAL: EvidenceSummary = {
  taskId: "7bf1a379-8114-499e-bb4e-f722b6854de5",
  state: "unverified",
  missing: ["qa"],
  summary: "Unverified: missing QA verdict.",
  predatesEvidenceCapture: false,
};

test("an unverified completion is amber, never green, and names the missing gate", () => {
  const badge = evidenceBadge(PARTIAL);
  assert.equal(badge.tone, "unverified");
  assert.equal(badge.label, "Unverified");
  assert.equal(badge.missingText, "missing QA");
  assert.doesNotMatch(EVIDENCE_TONE_CLASSES[badge.tone], /emerald|green/);
});

test("a completion with no evidence names every gate", () => {
  const badge = evidenceBadge({
    ...PARTIAL,
    missing: ["walkthrough", "verify", "code_review", "qa"],
    summary: "Unverified: missing Walkthrough, Verify gate, Code-review gate, QA verdict.",
  });
  assert.equal(badge.missingText, "missing walkthrough, verify, code review, QA");
});

test("a pre-capture completion stays unverified, with the history flagged", () => {
  const badge = evidenceBadge({ ...PARTIAL, predatesEvidenceCapture: true });
  assert.equal(badge.tone, "unverified");
  assert.equal(badge.label, "Unverified (pre-capture)");
  assert.match(badge.title, /before Praxis recorded verification evidence/);
});

test("only a fully evidenced completion gets the green tone", () => {
  const badge = evidenceBadge({ ...PARTIAL, state: "verified", missing: [], summary: "Verified." });
  assert.equal(badge.tone, "verified");
  assert.equal(badge.missingText, "");
  assert.match(EVIDENCE_TONE_CLASSES.verified, /emerald/);
  assert.equal(evidenceBadge({ ...PARTIAL, state: "not_completed", missing: [] }).tone, "neutral");
});
