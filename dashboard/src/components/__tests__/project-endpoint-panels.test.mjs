import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { ProjectEndpointPanel } from "../project-endpoint/endpoint-panel.tsx";
import { ProjectNeedsPanel } from "../project-endpoint/needs-panel.tsx";
import { ProjectSettings } from "../project-settings.tsx";
import { MissionBrief } from "../project-brief/mission-brief.tsx";

const at = "2026-09-07T10:00:00Z";
const need = {
  id: "n",
  kind: "information",
  description: "Choose a database",
  status: "open",
  created_at: at,
  knowledge: {
    question: "Which database survives failover?",
    tags: ["database"],
    satisfaction_test: "Document a recovery trial",
    criterion_ids: ["c"],
    task_ids: ["t"],
    blocking: true,
    research_status: "evidence_ready",
    answer: "Use A",
    evidence: [
      { ref: "trial.md", summary: "Recovery verified", checked_at: at },
    ],
  },
};
const project = {
  id: "p",
  name: "Test",
  path: "/test",
  type: "tool",
  updated_at: at,
  end_state_updated_at: at,
  end_state: "Current endpoint",
  endpoint: {
    completion_policy: "propose_next",
    proposed_next: "Next endpoint",
  },
  needs: [need],
  end_state_criteria: [
    { id: "c", kind: "manual", description: "Recovery works", enabled: true },
  ],
  end_state_assessment: {
    endpoint_revision: at,
    evaluated_at: at,
    knowledge: { required: 1, satisfied: 0, unresolved: 1 },
    results: [
      {
        id: "c",
        pass: false,
        status: "unverifiable",
        checked_at: at,
        detail: "No trial log",
      },
    ],
  },
};
const button = (container, label) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === label,
  );
async function mount(Component, props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, props)));
  return {
    container,
    root,
    close() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("endpoint shows unverifiable evidence and accepts a proposal only after the explicit action", async () => {
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ ...project, ...calls.at(-1).body }),
    };
  };
  const ui = await mount(ProjectEndpointPanel, { project, onUpdate: () => {} });
  try {
    assert.match(ui.container.textContent, /unverifiable/);
    assert.match(ui.container.textContent, /No trial log/);
    assert.match(ui.container.textContent, /1 unresolved/);
    assert.match(ui.container.textContent, /Current endpoint/);
    assert.equal(calls.length, 0);
    await act(async () => button(ui.container, "Review proposal").click());
    assert.equal(calls.length, 0);
    await act(async () =>
      button(ui.container, "Accept as current endpoint").click(),
    );
    assert.equal(calls[0].body.end_state, "Next endpoint");
    assert.equal(calls[0].body.expected_updated_at, at);
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

test("structured need satisfies through a scoped PATCH and tag opens actual knowledge retrieval", async () => {
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (!options?.method && !String(url).includes("ingestion-control"))
      return {
        ok: true,
        json: async () => ({
          ...project,
          end_state: "Concurrent endpoint update",
          endpoint: { ...project.endpoint, scope: "New scope" },
          needs: [{ ...need, status: "met" }],
          updated_at: "v2",
          end_state_assessment: null,
        }),
      };
    return {
      ok: true,
      json: async () =>
        String(url).includes("ingestion-control")
          ? {
              term: "database",
              cortex: { status: "ok" },
              facts: [
                {
                  fact: "Recovery trial used A",
                  is_current: true,
                  observed_at: at,
                },
              ],
              semantic_context: "Trial evidence",
              graph: { nodes: [], edges: [] },
            }
          : {
              success: true,
              need: { ...need, status: "met" },
              needs: [{ ...need, status: "met" }],
              updated_at: "v2",
            },
    };
  };
  const updates = [];
  const ui = await mount(ProjectNeedsPanel, {
    project,
    tasks: [],
    onUpdate: (p) => updates.push(p),
  });
  try {
    assert.match(ui.container.textContent, /Blocking/);
    await act(async () => button(ui.container, "#database").click());
    assert.match(
      calls[0].url,
      /\/api\/ingestion-control\/knowledge\?term=database/,
    );
    assert.match(ui.container.textContent, /Recovery trial used A/);
    await act(async () => button(ui.container, "Satisfy").click());
    const call = calls.find((c) => c.options?.method === "PATCH");
    assert.match(call.url, /\/projects\/p\/needs\/n\?/);
    assert.deepEqual(JSON.parse(call.options.body), {
      status: "met",
      source: "operator",
    });
    assert.equal(
      updates[0].needs[0].knowledge.evidence[0].summary,
      "Recovery verified",
    );
    assert.equal(updates[0].end_state_assessment, null);
    assert.equal(updates[0].end_state, "Concurrent endpoint update");
    assert.equal(updates[0].endpoint.scope, "New scope");
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

test("need without evidence cannot be satisfied, and retrieval failure is explicit", async () => {
  const original = fetch;
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ error: "Cortex offline" }),
  });
  const ui = await mount(ProjectNeedsPanel, {
    project: {
      ...project,
      needs: [{ ...need, knowledge: { ...need.knowledge, evidence: [] } }],
    },
    tasks: [],
    onUpdate: () => {},
  });
  try {
    assert.equal(button(ui.container, "Satisfy").disabled, true);
    await act(async () => button(ui.container, "#database").click());
    assert.match(ui.container.textContent, /Cortex offline/);
    assert.match(ui.container.textContent, /unavailable/i);
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

test("editing application feedback sends a partial knowledge patch and retains verified evidence", async () => {
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (!options?.method) return { ok: true, json: async () => project };
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        success: true,
        need,
        needs: [need],
        updated_at: "v2",
      }),
    };
  };
  const ui = await mount(ProjectNeedsPanel, {
    project,
    tasks: [],
    onUpdate: () => {},
  });
  try {
    await act(async () => button(ui.container, "Edit need").click());
    const outcome = [...ui.container.querySelectorAll("label")]
      .find((l) => l.textContent.startsWith("Application outcome"))
      .querySelector("select");
    await act(async () => {
      outcome.value = "insufficient";
      outcome.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await act(async () => button(ui.container, "Save need").click());
    assert.equal(calls[0].knowledge.application.status, "insufficient");
    assert.ok(calls[0].knowledge.application.at);
    assert.equal("evidence" in calls[0].knowledge, false);
    assert.equal("answer" in calls[0].knowledge, false);
    assert.equal("criterion_ids" in calls[0].knowledge, false);
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

test("a successful need save with a failed project refresh never promotes its new guard onto stale fields", async () => {
  const original = fetch;
  const updates = [];
  globalThis.fetch = async (url, options) =>
    options?.method
      ? {
          ok: true,
          json: async () => ({
            success: true,
            need,
            needs: [need],
            updated_at: "v2",
          }),
        }
      : { ok: false };
  const ui = await mount(ProjectNeedsPanel, {
    project,
    tasks: [],
    onUpdate: (p) => updates.push(p),
  });
  try {
    await act(async () => button(ui.container, "Satisfy").click());
    assert.equal(updates.length, 0);
    assert.match(ui.container.textContent, /Need saved.*reload/i);
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

test("endpoint editor preserves metric values, sampling windows and observations in its guarded request", async () => {
  const criterion = {
    id: "m",
    kind: "metric",
    description: "Recovery under 30 seconds",
    enabled: true,
    metric: {
      baseline: 60,
      target: 30,
      operator: "lte",
      unit: "seconds",
      window_days: 7,
      min_samples: 3,
    },
    observation: {
      status: "pass",
      observed_at: at,
      evidence_ref: "trial.md",
      value: 25,
      sample_size: 5,
      detail: "Recovery timed",
    },
  };
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ...project, ...calls.at(-1) }) };
  };
  const ui = await mount(ProjectEndpointPanel, {
    project: { ...project, end_state_criteria: [criterion] },
    onUpdate: () => {},
  });
  try {
    await act(async () => button(ui.container, "Edit endpoint").click());
    assert.match(ui.container.textContent, /Evidence window \(days\)/);
    assert.match(ui.container.textContent, /Minimum samples/);
    await act(async () => button(ui.container, "Save endpoint").click());
    assert.deepEqual(calls[0].end_state_criteria, [criterion]);
    assert.equal(calls[0].expected_updated_at, at);
    assert.equal(calls[0].end_state, "Current endpoint");
    assert.equal(calls[0].endpoint.proposed_next, "Next endpoint");
    assert.equal("needs" in calls[0], false);
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

test("general settings use the editing snapshot guard and leave full knowledge data to scoped editors", async () => {
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => project };
  };
  const ui = await mount(ProjectSettings, { project, onUpdate: () => {} });
  try {
    await act(async () =>
      ui.container
        .querySelector('[aria-label="Edit project settings"]')
        .click(),
    );
    await act(async () => button(ui.container, "Save").click());
    assert.equal(calls[0].expected_updated_at, at);
    assert.equal("needs" in calls[0], false);
    assert.equal("end_state_criteria" in calls[0], false);
    assert.equal("end_state" in calls[0], false);
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

for (const action of ["clear observation", "switch to metric"]) {
  test(`${action} explicitly clears historical manual evidence on the wire`, async () => {
    const original = fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => project };
    };
    const criterion = {
      id: "manual",
      kind: "manual",
      description: "Recovery rehearsal",
      enabled: true,
      observation: {
        status: "pass",
        observed_at: at,
        evidence_ref: "manual-trial.md",
      },
    };
    const ui = await mount(ProjectEndpointPanel, {
      project: { ...project, end_state_criteria: [criterion] },
      onUpdate: () => {},
    });
    try {
      await act(async () => button(ui.container, "Edit endpoint").click());
      if (action === "clear observation") {
        const checkbox = [...ui.container.querySelectorAll("label")]
          .find((l) => l.textContent.includes("Record an evidence observation"))
          .querySelector("input");
        await act(async () => checkbox.click());
      } else {
        const select = [...ui.container.querySelectorAll("label")]
          .find((l) => l.textContent.startsWith("Criterion kind"))
          .querySelector("select");
        await act(async () => {
          select.value = "metric";
          select.dispatchEvent(new window.Event("change", { bubbles: true }));
        });
      }
      await act(async () => button(ui.container, "Save endpoint").click());
      assert.equal(calls[0].end_state_criteria[0].observation, null);
      if (action === "switch to metric")
        assert.equal(calls[0].end_state_criteria[0].kind, "metric");
    } finally {
      ui.close();
      globalThis.fetch = original;
    }
  });
}

test("mission brief keeps stale met knowledge visible among outstanding needs", async () => {
  const ui = await mount(MissionBrief, {
    project: {
      ...project,
      needs: [
        {
          ...need,
          status: "met",
          knowledge: { ...need.knowledge, research_status: "stale" },
        },
      ],
    },
    brief: null,
  });
  try {
    assert.match(ui.container.textContent, /Outstanding needs/);
    assert.match(ui.container.textContent, /Which database survives failover/);
  } finally {
    ui.close();
  }
});
