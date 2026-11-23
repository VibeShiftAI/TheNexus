import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { deriveCliLane, slotTag } from "../cli-lane";
import { UNKNOWN_MODEL, deriveProviderRuns, modelProvenance, providerTally, resolveRunModel, runRole } from "../ops-graph";
import { PROVIDER_LOGOS, providerLogo } from "../provider-logos";

const NOW = Date.parse("2026-11-23T14:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function laneRuns(runs: Record<string, unknown>[], executor = "claude-code") {
  const view = deriveCliLane({ executors: { runs: runs.map((r) => ({ executor, status: "active", ...r })) as never, cliQueue: [] } }, NOW);
  return view.executors.find((e) => e.name === executor)?.runs ?? [];
}

test("a run's role comes from its registry kind, and a qa-- id is always a review", () => {
  assert.equal(runRole("task", "t1"), "building");
  assert.equal(runRole(undefined, "t1"), "building");
  assert.equal(runRole("qa", "qa--t1"), "reviewing");
  assert.equal(runRole("task", "qa--t1"), "reviewing");
  assert.equal(runRole("agent", "agent:research"), "agent");
});

test("the shown model is the served one, else the requested one, else the reported one, else none", () => {
  assert.deepEqual(resolveRunModel({ servedModel: "claude-opus-5", requestedModel: "claude-fable-5-1", requestedEffort: "high" }), {
    model: "Opus 5", modelSource: "served", requestedModel: "Fable 5.1", effort: "high",
  });
  // Served and requested agree: the request is not repeated.
  assert.equal(resolveRunModel({ servedModel: "claude-opus-5", requestedModel: "claude-opus-5" }).requestedModel, null);
  assert.deepEqual(resolveRunModel({ requestedModel: "claude-opus-5" }), { model: "Opus 5", modelSource: "requested", requestedModel: null, effort: null });
  assert.equal(resolveRunModel({ model: "claude-fable-5-1" }).modelSource, "reported");
  assert.deepEqual(resolveRunModel({}), { model: null, modelSource: null, requestedModel: null, effort: null });
  assert.deepEqual(resolveRunModel({ model: "  ", servedModel: null, requestedModel: "" }).model, null);
});

test("an unknown model reads 'unknown' and is never filled in from the executor's name", () => {
  for (const executor of ["claude-code", "codex", "antigravity"]) {
    const [node] = deriveProviderRuns({ laneRuns: laneRuns([{ taskId: "t1", title: "Task one", kind: "task", startedAt: ago(1000) }], executor), streamRuns: [], seats: [], council: null, now: NOW });
    assert.equal(node.model, null, `${executor} run with no reported model stays unknown`);
    assert.equal(node.modelSource, null);
    assert.match(modelProvenance(node), /^Model unknown/);
  }
  assert.equal(UNKNOWN_MODEL, "unknown");
});

test("the model sentence says where the model came from", () => {
  assert.equal(modelProvenance(resolveRunModel({ servedModel: "claude-opus-5", requestedModel: "claude-fable-5-1", requestedEffort: "high" })),
    "Model Opus 5, reported by the executor (requested Fable 5.1, effort high)");
  assert.equal(modelProvenance(resolveRunModel({ requestedModel: "claude-opus-5", requestedEffort: "xhigh" })), "Model Opus 5, as requested at dispatch, effort xhigh");
});

test("every registry run becomes one node carrying task, role, model and elapsed time, oldest first", () => {
  const nodes = deriveProviderRuns({
    laneRuns: laneRuns([
      { taskId: "b", title: "Second task", kind: "task", startedAt: ago(60_000), requestedModel: "claude-opus-5", requestedEffort: "high" },
      { taskId: "qa--a", title: "Review of first", kind: "qa", startedAt: ago(30_000), servedModel: "claude-fable-5-1" },
      { taskId: "a", title: "First task", kind: "task", startedAt: ago(600_000), model: "claude-fable-5-1", slotNumber: 3 },
    ]),
    streamRuns: [], seats: [], council: null, now: NOW,
  });
  assert.deepEqual(nodes.map((n) => [n.key, n.role, n.title, n.model, n.elapsedMs, n.slot]), [
    ["a", "building", "First task", "Fable 5.1", 600_000, "S3"],
    ["b", "building", "Second task", "Opus 5", 60_000, null],
    ["qa--a", "reviewing", "Review of first", "Fable 5.1", 30_000, null],
  ]);
  assert.equal(nodes[1].effort, "high");
  assert.equal(providerTally(nodes), "2 building · 1 reviewing");
});

test("a slot tag is S<number> for a positive integer and nothing for anything else", () => {
  assert.equal(slotTag(1), "S1");
  assert.equal(slotTag(12), "S12");
  for (const none of [undefined, null, 0, -2, 1.5, "3", NaN]) assert.equal(slotTag(none), null);
  const [withSlot, without] = deriveProviderRuns({
    laneRuns: laneRuns([{ taskId: "a", startedAt: ago(2000), slotNumber: 4 }, { taskId: "b", startedAt: ago(1000) }]),
    streamRuns: [], seats: [], council: null, now: NOW,
  });
  assert.equal(withSlot.slot, "S4");
  assert.equal(without.slot, null);
  // Queue entries carry the same optional field.
  const queue = deriveCliLane({ executors: { cliQueue: [{ taskId: "q1", slotNumber: 2 }, { taskId: "q2" }] as never } }, NOW).queue;
  assert.deepEqual(queue.map((q) => q.slotNumber), [2, null]);
});

test("there is no maximum: forty runs on one provider give forty nodes, none merged", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ taskId: `task-${i}`, title: `Task ${i}`, kind: i % 5 === 0 ? "qa" : "task", startedAt: ago((40 - i) * 1000) }));
  const nodes = deriveProviderRuns({ laneRuns: laneRuns(many), streamRuns: [], seats: [], council: null, now: NOW });
  assert.equal(nodes.length, 40);
  assert.equal(new Set(nodes.map((n) => n.key)).size, 40);
  assert.deepEqual(nodes.map((n) => n.title), many.map((r) => r.title));
});

test("a stream item adds only a run the registry lacks, and claims no start time", () => {
  const nodes = deriveProviderRuns({
    laneRuns: laneRuns([{ taskId: "a", title: "Listed", startedAt: ago(5000) }]),
    streamRuns: [
      { taskId: "a", executor: "claude-code", phase: "testing", model: "claude-fable-5-1" },
      { taskId: "qa--z", executor: "claude-code", title: "Fresh review", channel: "qa" },
    ],
    seats: [], council: null, now: NOW,
  });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].phase, "testing");
  assert.equal(nodes[0].model, "Fable 5.1", "the stream's model fills a registry run that reported none");
  assert.deepEqual([nodes[1].key, nodes[1].role, nodes[1].elapsedMs, nodes[1].model], ["qa--z", "reviewing", null, null]);
});

test("each sitting council seat is its own node; a seat that already reported is not", () => {
  const nodes = deriveProviderRuns({
    laneRuns: [], streamRuns: [],
    seats: [
      { name: "cli:claude-code/claude-opus-5", model: "cli:claude-code/claude-opus-5", status: "running" },
      { name: "cli:claude-code/claude-fable-5-1", model: "cli:claude-code/claude-fable-5-1", status: "success" },
    ],
    council: { topic: "Next improvements", createdAt: NOW - 90_000 }, now: NOW,
  });
  assert.equal(nodes.length, 1);
  assert.deepEqual([nodes[0].role, nodes[0].title, nodes[0].model, nodes[0].elapsedMs], ["council", "Next improvements", "Opus 5", 90_000]);
  assert.equal(providerTally(nodes), "1 council");
});

test("each vendor logo file is the one the notice records, byte for byte", () => {
  const dir = join(process.cwd(), "public", "brand");
  const notice = readFileSync(join(dir, "NOTICE.md"), "utf8");
  const files = readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
  assert.deepEqual(files, Object.values(PROVIDER_LOGOS).map((l) => l.src.replace("/brand/", "")).sort(), "every file is used and every used file exists");
  for (const file of files) {
    const sha = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
    assert.ok(notice.includes(sha), `${file} matches the checksum in NOTICE.md`);
  }
  assert.match(notice, /MIT/);
  assert.equal(providerLogo("openrouter"), null, "no vendor file for OpenRouter: it keeps its glyph");
  assert.equal(providerLogo("constructor"), null);
});

// QA round 1 (task 56c15b54): the runs below are not written by hand. Praxis
// tests/run_model_dispatch_state.test.ts started them through runExecution on
// the production claude-code and codex executors (stand-in CLI binaries) and
// read them back over HTTP from GET /api/dispatch/state; this file is that
// response's runs, kept as evidence. Here they go through the same function
// the Ops graphic uses for the model line.
test("runs observed in dispatch state after a real dispatch show their model, and the one with none reads unknown", () => {
  const file = join(process.cwd(), "..", "docs", "reviews", "2026-11-23-ops-graphic", "evidence", "dispatch-state", "observation.json");
  const observation = JSON.parse(readFileSync(file, "utf-8")) as {
    runs: { taskId: string; executor: string; kind: string; status: string; model?: string; requestedModel?: string; requestedEffort?: string; servedModel?: string }[];
  };
  const shown = observation.runs.map((run) => {
    const resolved = resolveRunModel(run);
    return [run.executor, runRole(run.kind, run.taskId), resolved.model ?? UNKNOWN_MODEL, resolved.modelSource, resolved.requestedModel, resolved.effort].join(" | ");
  }).sort();
  assert.deepEqual(shown, [
    // Served by the CLI and different from the request: both are kept.
    "claude-code | building | claude-stand-in-served-model | served | Fable 5.2 | high",
    "claude-code | reviewing | claude-stand-in-served-model | served | Opus 5.5 | medium",
    // codex names no model in its output: the request is what is shown.
    "codex | building | GPT-6 Astra | requested |  | high",
    "codex | reviewing | GPT-5.6 Sol | requested |  | medium",
    // No model anywhere on the run, and none taken from the executor's name.
    "model-truth-silent | building | unknown |  |  | ",
  ]);
});
