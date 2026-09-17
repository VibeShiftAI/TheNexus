import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { ProjectCheckpointsPanel } from "../project-endpoint/checkpoints-panel.tsx";
import { MissionBrief } from "../project-brief/mission-brief.tsx";

const at = "2026-09-07T10:00:00Z";
const later = "2026-09-08T10:00:00Z";
const criterion = (id, description) => ({ id, kind: "manual", description, enabled: true });
const base = { need_ids: [], created_at: at, definition_revision: at, completion: null, assessment: null, history: [] };
const completed = {
  ...base,
  id: "cp-a",
  title: "Foundation",
  goal: "The core loop runs unattended",
  criteria: [criterion("a1", "Loop survives a week")],
  status: "completed",
  completion: {
    at: later,
    definition_revision: at,
    source: "praxis-steward",
    assessment: {
      checkpoint_id: "cp-a",
      definition_revision: at,
      evaluated_at: later,
      results: [{ id: "a1", pass: true, status: "pass", checked_at: later, detail: "Observed pass", evidence_ref: "https://example.test/evidence" }],
      knowledge: { required: 0, satisfied: 0, unresolved: 0 },
      achieved: true,
    },
  },
  history: [{ kind: "completed", at: later, definition_revision: at, source: "praxis-steward" }],
};
const current = {
  ...base,
  id: "cp-b",
  title: "Containment",
  goal: "Gates hold under load",
  criteria: [criterion("b1", "Gate test passes"), criterion("b2", "No regressions")],
  need_ids: ["n"],
  status: "pending",
  assessment: {
    checkpoint_id: "cp-b",
    definition_revision: at,
    evaluated_at: later,
    results: [
      { id: "b1", pass: true, status: "pass", checked_at: later },
      { id: "b2", pass: false, status: "fail", checked_at: later, detail: "Regression in gate 2" },
    ],
    knowledge: { required: 1, satisfied: 0, unresolved: 1 },
    achieved: false,
  },
};
const upcoming = { ...base, id: "cp-c", title: "Value ledger", goal: "Ledger live", criteria: [criterion("c1", "Ledger records a week")], status: "pending" };
const need = {
  id: "n",
  kind: "information",
  description: "Choose a load model",
  status: "open",
  created_at: at,
  knowledge: { question: "Which load model reflects production?", tags: ["load"], satisfaction_test: "A replayed day matches", criterion_ids: [], task_ids: [], blocking: true, research_status: "open", evidence: [] },
};
const project = {
  id: "p",
  name: "Test",
  path: "/test",
  type: "tool",
  updated_at: at,
  end_state_updated_at: at,
  end_state: "Long-term: Praxis runs itself",
  end_state_criteria: [criterion("final", "Final proof")],
  needs: [need],
  checkpoints: { items: [completed, current, upcoming], archived: [], revision: "rev-1", sequence_completed_at: null },
};
const button = (root, label) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const valueSetter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, "value").set;
function type(input, value) {
  valueSetter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
async function mount(Component, props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, props)));
  return { container, root, close() { act(() => root.unmount()); container.remove(); } };
}
function mockFetch(respond) {
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), method: options?.method ?? "GET", body });
    return respond(calls.at(-1));
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test("shows the long-term goal, the current checkpoint with its evidence, upcoming and completed history", async () => {
  const ui = await mount(ProjectCheckpointsPanel, { project, onUpdate: () => {} });
  try {
    const text = ui.container.textContent;
    assert.match(text, /Long-term goal/);
    assert.match(text, /Long-term: Praxis runs itself/);
    assert.match(text, /Working toward now/);
    assert.match(text, /checkpoint 2 of 3/);
    assert.match(text, /Containment/);
    assert.match(text, /1 of 3 verified/);
    assert.match(text, /Evidence recorded, not verified/);
    assert.match(text, /1 of 2 criteria not passing, 1 required knowledge unresolved/);
    assert.match(text, /Regression in gate 2/);
    assert.match(text, /Which load model reflects production\?/);
    assert.match(text, /Upcoming/);
    assert.match(text, /Value ledger/);
    assert.match(text, /Completed/);
    assert.match(text, /Foundation/);
    assert.match(text, /Verified/);
    assert.ok(ui.container.querySelector('a[href="https://example.test/evidence"]'), "completion evidence link retained");
    assert.match(text, /Observed pass/);
  } finally {
    ui.close();
  }
});

test("distinguishes no checkpoints, waiting for evidence, and an unverified final goal after the sequence", async () => {
  const none = await mount(ProjectCheckpointsPanel, { project: { ...project, checkpoints: null }, onUpdate: () => {} });
  try {
    assert.match(none.container.textContent, /No checkpoints defined/);
    assert.ok(button(none.container, "Add checkpoints"));
    assert.doesNotMatch(none.container.textContent, /Working toward now/);
  } finally {
    none.close();
  }
  const waiting = await mount(ProjectCheckpointsPanel, {
    project: { ...project, checkpoints: { ...project.checkpoints, items: [completed, { ...current, assessment: null }, upcoming] } },
    onUpdate: () => {},
  });
  try {
    assert.match(waiting.container.textContent, /Waiting for evidence/);
    assert.match(waiting.container.textContent, /has not evaluated this definition yet/);
  } finally {
    waiting.close();
  }
  const done = await mount(ProjectCheckpointsPanel, {
    project: {
      ...project,
      checkpoints: {
        ...project.checkpoints,
        items: [completed, { ...current, status: "completed", completion: completed.completion, assessment: null }, { ...upcoming, status: "completed", completion: completed.completion }],
        sequence_completed_at: later,
      },
    },
    onUpdate: () => {},
  });
  try {
    assert.match(done.container.textContent, /All 3 checkpoints verified/);
    assert.match(done.container.textContent, /Final goal not yet verified/);
    assert.doesNotMatch(done.container.textContent, /Working toward now/);
  } finally {
    done.close();
  }
});

test("authoring reorders, removes and adds checkpoints and saves the whole ordered plan under both guards", async () => {
  const updates = [];
  const saved = { ...project, updated_at: "v2", checkpoints: { ...project.checkpoints, revision: "rev-2" } };
  const net = mockFetch(() => ({ ok: true, json: async () => saved }));
  const ui = await mount(ProjectCheckpointsPanel, { project, onUpdate: (p) => updates.push(p) });
  try {
    await act(async () => button(ui.container, "Edit checkpoints").click());
    let fieldsets = [...ui.container.querySelectorAll("fieldset[data-checkpoint]")];
    assert.equal(fieldsets.length, 3);
    // Move the last checkpoint ahead of the current one, drop the first, add a new one.
    await act(async () => button(fieldsets[2], "Move up").click());
    fieldsets = [...ui.container.querySelectorAll("fieldset[data-checkpoint]")];
    assert.equal(fieldsets[1].dataset.checkpoint, "cp-c");
    await act(async () => button(fieldsets[0], "Remove").click());
    await act(async () => button(ui.container, "Add checkpoint").click());
    fieldsets = [...ui.container.querySelectorAll("fieldset[data-checkpoint]")];
    assert.equal(fieldsets.length, 3);
    const title = fieldsets[2].querySelector("input");
    await act(async () => type(title, "Adoption"));
    // Link the new checkpoint to the blocking knowledge need.
    const checkbox = fieldsets[2].querySelector('input[type="checkbox"]');
    await act(async () => checkbox.click());
    await act(async () => button(ui.container, "Save checkpoints").click());
    const call = net.calls.find((c) => c.method === "PATCH");
    assert.match(new URL(call.url, "http://localhost").pathname, /\/projects\/p$/);
    assert.equal(call.body.expected_checkpoints_revision, "rev-1");
    assert.equal(call.body.expected_updated_at, at);
    assert.equal(call.body.end_state_source, "operator");
    assert.deepEqual(call.body.checkpoints.map((c) => c.id ?? null), ["cp-c", "cp-b", null]);
    assert.equal(call.body.checkpoints[2].title, "Adoption");
    assert.deepEqual(call.body.checkpoints[2].need_ids, ["n"]);
    assert.deepEqual(call.body.checkpoints[1].criteria.map((c) => c.id), ["b1", "b2"]);
    assert.equal(Object.hasOwn(call.body.checkpoints[0], "status"), false, "server fields are never written");
    assert.equal(updates[0].checkpoints.revision, "rev-2");
    assert.doesNotMatch(ui.container.textContent, /Save checkpoints/);
  } finally {
    ui.close();
    net.restore();
  }
});

test("a stale plan revision is reported and the draft stays open", async () => {
  const net = mockFetch(() => ({ ok: false, status: 409, json: async () => ({ error: "Checkpoint plan changed: reload before saving.", code: "CHECKPOINT_REVISION_STALE" }) }));
  const ui = await mount(ProjectCheckpointsPanel, { project, onUpdate: () => {} });
  try {
    await act(async () => button(ui.container, "Edit checkpoints").click());
    await act(async () => button(ui.container, "Save checkpoints").click());
    assert.match(ui.container.querySelector("[role=alert]").textContent, /Reload the project before saving again/);
    assert.ok(button(ui.container, "Save checkpoints"));
  } finally {
    ui.close();
    net.restore();
  }
});

test("reopening a verified checkpoint is an explicit guarded action; nothing in the panel completes one", async () => {
  const updates = [];
  const reopened = { ...project, checkpoints: { ...project.checkpoints, revision: "rev-3", items: [{ ...completed, status: "pending", completion: null }, current, upcoming] } };
  const net = mockFetch(() => ({ ok: true, json: async () => ({ success: true, current_checkpoint_id: "cp-a", project: reopened }) }));
  const ui = await mount(ProjectCheckpointsPanel, { project, onUpdate: (p) => updates.push(p) });
  try {
    assert.equal([...ui.container.querySelectorAll("button")].some((b) => /complete|verify|advance/i.test(b.textContent)), false);
    await act(async () => button(ui.container, "Reopen checkpoint").click());
    assert.equal(net.calls.length, 0);
    const reason = [...ui.container.querySelectorAll("input")].at(-1);
    await act(async () => type(reason, "Loop regressed after the upgrade"));
    await act(async () => button(ui.container, "Confirm reopen").click());
    assert.equal(net.calls.length, 1);
    assert.match(new URL(net.calls[0].url, "http://localhost").pathname, /\/projects\/p\/checkpoints\/cp-a\/reopen$/);
    assert.equal(net.calls[0].method, "POST");
    assert.deepEqual(net.calls[0].body, { reason: "Loop regressed after the upgrade", expected_checkpoints_revision: "rev-1" });
    assert.equal(updates[0].checkpoints.revision, "rev-3");
  } finally {
    ui.close();
    net.restore();
  }
});

test("the mission brief keeps the directive and names the current checkpoint", async () => {
  const ui = await mount(MissionBrief, { project, brief: null });
  try {
    assert.match(ui.container.textContent, /Mission directive/);
    assert.match(ui.container.textContent, /Long-term: Praxis runs itself/);
    assert.match(ui.container.textContent, /Working toward now/);
    assert.match(ui.container.textContent, /checkpoint 2 of 3/);
    assert.match(ui.container.textContent, /Containment/);
    assert.match(ui.container.textContent, /Gates hold under load/);
    assert.match(ui.container.textContent, /Current checkpoint acceptance criteria/);
    assert.match(ui.container.textContent, /Gate test passes/);
    assert.doesNotMatch(ui.container.textContent, /Final proof/);
  } finally {
    ui.close();
  }
  const plain = await mount(MissionBrief, { project: { ...project, checkpoints: null }, brief: null });
  try {
    assert.doesNotMatch(plain.container.textContent, /Working toward now/);
  } finally {
    plain.close();
  }
});


test("editing retains the original guard when fresher props arrive", async () => {
  const net = mockFetch(() => ({ ok: false, status: 409, json: async () => ({ error: "conflict" }) }));
  const ui = await mount(ProjectCheckpointsPanel, { project, onUpdate: () => {} });
  try {
    await act(async () => button(ui.container, "Edit checkpoints").click());
    await act(async () => ui.root.render(createElement(ProjectCheckpointsPanel, { project: { ...project, updated_at: later, checkpoints: { ...project.checkpoints, revision: "newer" } }, onUpdate: () => {} })));
    await act(async () => button(ui.container, "Save checkpoints").click());
    assert.equal(net.calls.find(c => c.method === "PATCH").body.expected_checkpoints_revision, "rev-1");
  } finally { ui.close(); net.restore(); }
});
