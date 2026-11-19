import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { ProjectCheckpointsPanel } from "../project-endpoint/checkpoints-panel.tsx";
import { MissionBrief } from "../project-brief/mission-brief.tsx";

// Intake on the project page. The stage names and statuses belong to Praxis
// (it reads them from the saved intake); the page shows whatever it is given.
// The fixture therefore uses placeholder names, so this repo holds no copy of
// the real stage list.
const at = "2026-11-18T10:00:00Z";
const statuses = ["done", "in_progress", "not_started", "not_started", "held", "not_started", "not_started"];
const stages = statuses.map((status, i) => ({
  id: `stage-${i + 1}`,
  name: `Placeholder stage ${i + 1}`,
  status,
  ...(i === 4 ? { detail: "the council has not sat" } : {}),
}));
const reading = (status, list = stages) => ({
  id: "intake",
  title: "Intake",
  goal: "The project is understood and has an approved plan",
  status,
  stages: list,
  stages_settled: list.filter((s) => s.status === "done" || s.status === "skipped").length,
});
const planned = {
  id: "cp-1", title: "First planned checkpoint", goal: "Planned goal", status: "pending",
  criteria: [{ id: "c1", kind: "manual", description: "A planned criterion", enabled: true }],
  need_ids: [], created_at: at, definition_revision: at, completion: null, assessment: null, history: [],
};
const project = {
  id: "p-intake", name: "Intake project", path: "/x", type: "tool", updated_at: at,
  end_state: "Long-term goal", end_state_criteria: [], needs: [],
  intake: { state: "interviewing" },
  checkpoints: null,
};
const withPlan = { ...project, checkpoints: { items: [planned], archived: [], revision: "r1", sequence_completed_at: null } };

async function mount(Component, props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, props)));
  // Let the Intake reading resolve and render.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, root, close() { act(() => root.unmount()); container.remove(); } };
}
function mockFetch(respond) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return respond(String(url)); };
  return { calls, restore() { globalThis.fetch = original; } };
}
const answer = (intake_checkpoint) => () => ({ ok: true, status: 200, json: async () => ({ project_id: project.id, intake_checkpoint, current_checkpoint: null }) });

test("a project in intake shows Intake as its current checkpoint with the stages Praxis read, in order", async () => {
  const net = mockFetch(answer(reading("current")));
  const ui = await mount(ProjectCheckpointsPanel, { project, onUpdate: () => {} });
  try {
    assert.deepEqual(net.calls, ["/api/praxis/projects/p-intake/intake-checkpoint"]);
    const card = ui.container.querySelector('[data-intake-checkpoint="current"]');
    assert.ok(card, "Intake is shown as the current checkpoint");
    assert.match(card.textContent, /Working toward now/);
    assert.match(card.textContent, /first checkpoint · 1 of 7 stages settled/);
    assert.match(card.textContent, /Intake/);
    const rows = [...card.querySelectorAll("[data-intake-stage]")];
    assert.deepEqual(rows.map((r) => r.getAttribute("data-intake-stage")), stages.map((s) => s.id));
    rows.forEach((row, i) => {
      assert.match(row.textContent, new RegExp(`${i + 1}\\.Placeholder stage ${i + 1}`));
      assert.match(row.textContent, new RegExp(statuses[i].replace("_", " ")));
    });
    assert.match(rows[4].textContent, /the council has not sat/);
    assert.match(ui.container.textContent, /No checkpoints are planned after Intake yet/);
  } finally { ui.close(); net.restore(); }
});

test("while Intake is current the plan's first checkpoint is next, and it is current once Intake is complete", async () => {
  let net = mockFetch(answer(reading("current")));
  let ui = await mount(ProjectCheckpointsPanel, { project: withPlan, onUpdate: () => {} });
  try {
    assert.match(ui.container.textContent, /Next, once Intake is complete/);
    assert.match(ui.container.textContent, /First planned checkpoint/);
    assert.equal((ui.container.textContent.match(/Working toward now/g) ?? []).length, 1, "only Intake is current");
  } finally { ui.close(); net.restore(); }

  const done = stages.map((s) => ({ id: s.id, name: s.name, status: "done" }));
  net = mockFetch(answer(reading("complete", done)));
  ui = await mount(ProjectCheckpointsPanel, { project: { ...withPlan, intake: { state: "handed_off" } }, onUpdate: () => {} });
  try {
    const card = ui.container.querySelector('[data-intake-checkpoint="complete"]');
    assert.ok(card, "Intake reads complete");
    assert.match(card.textContent, /Complete/);
    assert.match(card.textContent, /7 of 7 stages settled/);
    assert.doesNotMatch(ui.container.textContent, /Next, once Intake is complete/);
    const working = [...ui.container.querySelectorAll("div")].find((d) => /^Working toward now/.test(d.textContent) && /First planned checkpoint/.test(d.parentElement.textContent));
    assert.ok(working, "the first planned checkpoint is the current one");
  } finally { ui.close(); net.restore(); }
});

test("the mission brief names Intake as what the project is working toward", async () => {
  const net = mockFetch(answer(reading("current")));
  const ui = await mount(MissionBrief, { project: withPlan, brief: null });
  try {
    const block = ui.container.querySelector('[data-intake-checkpoint="current"]');
    assert.ok(block);
    assert.match(block.textContent, /Working toward now/);
    assert.match(block.textContent, /Intake/);
    assert.match(ui.container.textContent, /Next, once Intake is complete/);
  } finally { ui.close(); net.restore(); }
});

test("a project that never came through intake asks Praxis nothing and reads as before", async () => {
  const net = mockFetch(() => { throw new Error("no request expected"); });
  const { intake: _intake, ...plain } = withPlan;
  const ui = await mount(ProjectCheckpointsPanel, { project: plain, onUpdate: () => {} });
  const brief = await mount(MissionBrief, { project: plain, brief: null });
  try {
    assert.deepEqual(net.calls, []);
    assert.equal(ui.container.querySelector("[data-intake-checkpoint]"), null);
    assert.equal(brief.container.querySelector("[data-intake-checkpoint]"), null);
    assert.match(ui.container.textContent, /Working toward now/);
    assert.match(ui.container.textContent, /checkpoint 1 of 1/);
    assert.doesNotMatch(ui.container.textContent, /Intake/);
  } finally { ui.close(); brief.close(); net.restore(); }
});

test("when Praxis does not answer the page says the Intake checkpoint was not read and invents no stages", async () => {
  const net = mockFetch(() => ({ ok: false, status: 502, json: async () => ({ error: "down" }) }));
  const ui = await mount(ProjectCheckpointsPanel, { project: withPlan, onUpdate: () => {} });
  try {
    const note = ui.container.querySelector('[data-intake-checkpoint="unavailable"]');
    assert.ok(note);
    assert.match(note.textContent, /Intake checkpoint not read: Praxis answered 502/);
    assert.equal(ui.container.querySelectorAll("[data-intake-stage]").length, 0);
  } finally { ui.close(); net.restore(); }
});

// The status report task finishing moves an Intake stage and leaves the project
// row's updated_at alone (a task update writes the task, not the project). The
// page then hands the mounted components a refreshed project record.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const settled = (count) => stages.map((s, i) => ({ id: s.id, name: s.name, status: i < count ? "done" : "in_progress" }));

for (const [name, Component, extra] of [
  ["ProjectCheckpointsPanel", ProjectCheckpointsPanel, { onUpdate: () => {} }],
  ["MissionBrief", MissionBrief, { brief: null }],
]) {
  test(`${name}: a mounted page follows Intake to complete when a task finishes and the project's updated_at does not change`, async () => {
    let served = reading("current", settled(6));
    const net = mockFetch(() => answer(served)());
    const ui = await mount(Component, { project: withPlan, ...extra });
    try {
      assert.ok(ui.container.querySelector('[data-intake-checkpoint="current"]'), "Intake starts as the current checkpoint");
      assert.match(ui.container.textContent, /Next, once Intake is complete/);
      if (Component === ProjectCheckpointsPanel) {
        assert.match(ui.container.querySelector('[data-intake-stage="stage-7"]').textContent, /in progress/);
      }

      // The task completes; Praxis now reads the stage done and Intake complete.
      served = reading("complete", settled(7));
      const refreshed = { ...withPlan };
      assert.equal(refreshed.updated_at, withPlan.updated_at);
      await act(async () => ui.root.render(createElement(Component, { project: refreshed, ...extra })));
      await flush();

      assert.equal(net.calls.length, 2, "the refreshed record asked Praxis again");
      assert.equal(ui.container.querySelector('[data-intake-checkpoint="current"]'), null, "Intake is no longer current");
      assert.doesNotMatch(ui.container.textContent, /Next, once Intake is complete/);
      assert.match(ui.container.textContent, /Working toward now/);
      assert.match(ui.container.textContent, /checkpoint 1 of 1/);
      assert.match(ui.container.textContent, /First planned checkpoint/);
      if (Component === ProjectCheckpointsPanel) {
        const card = ui.container.querySelector('[data-intake-checkpoint="complete"]');
        assert.ok(card, "Intake reads complete");
        assert.match(card.textContent, /7 of 7 stages settled/);
        assert.match(card.querySelector('[data-intake-stage="stage-7"]').textContent, /done/);
        assert.doesNotMatch(card.textContent, /Working toward now/);
      }
    } finally { ui.close(); net.restore(); }
  });
}

test("a slow answer to an earlier request never replaces a newer reading", async () => {
  const pending = [];
  const net = mockFetch(() => new Promise((resolve) => pending.push(resolve)));
  const ui = await mount(ProjectCheckpointsPanel, { project: withPlan, onUpdate: () => {} });
  try {
    await act(async () => ui.root.render(createElement(ProjectCheckpointsPanel, { project: { ...withPlan }, onUpdate: () => {} })));
    assert.equal(pending.length, 2);
    // The newer request answers first with Intake complete; the older one answers late with Intake current.
    await act(async () => pending[1](answer(reading("complete", settled(7)))()));
    await flush();
    assert.ok(ui.container.querySelector('[data-intake-checkpoint="complete"]'));
    await act(async () => pending[0](answer(reading("current", settled(6)))()));
    await flush();
    assert.ok(ui.container.querySelector('[data-intake-checkpoint="complete"]'), "the late answer is dropped");
    assert.equal(ui.container.querySelector('[data-intake-checkpoint="current"]'), null);
  } finally { ui.close(); net.restore(); }
});

test("a live board invalidation refreshes the reading without a new project record", async () => {
  const { LiveBoardStateContext } = await import("../live-board-state.tsx");
  let served = reading("current", settled(6));
  const net = mockFetch(() => answer(served)());
  const props = { project: withPlan, onUpdate: () => {} };
  const tree = (board) => createElement(LiveBoardStateContext.Provider, { value: { revisions: { board } } },
    createElement(ProjectCheckpointsPanel, props));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(tree(1)));
    await flush();
    assert.ok(container.querySelector('[data-intake-checkpoint="current"]'));
    // Same project object, same board revision: nothing is asked again.
    await act(async () => root.render(tree(1)));
    await flush();
    assert.equal(net.calls.length, 1);
    // The board is invalidated (a task changed). The project object is the same one.
    served = reading("complete", settled(7));
    await act(async () => root.render(tree(2)));
    await flush();
    assert.equal(net.calls.length, 2);
    assert.ok(container.querySelector('[data-intake-checkpoint="complete"]'));
    assert.equal(container.querySelector('[data-intake-checkpoint="current"]'), null);
  } finally { act(() => root.unmount()); container.remove(); net.restore(); }
});
