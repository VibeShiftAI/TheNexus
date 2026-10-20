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
    purpose: "Choose the recovery architecture", resolution: { method: "experiment", owner: "Operator", next_action: "Run the recovery trial" }, revision: 4,
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
async function inputValue(container, label, value) {
  const element = [...container.querySelectorAll("label")].find(l => l.textContent.startsWith(label))?.querySelector("input, textarea, select");
  assert.ok(element, `Missing field ${label}`);
  await act(async () => {
    const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function verify(ui) {
  assert.ok(button(ui.container, "Verify answer"));
  await act(async () => button(ui.container, "Verify answer").click());
  await inputValue(ui.container, "Verification rationale", "The trial demonstrates the documented recovery test.");
  await act(async () => ui.container.querySelector('[aria-label="Evidence for verification"] input[type="checkbox"]').click());
  await act(async () => button(ui.container, "Confirm verification").click());
}
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

test('main knowledge list contains only action items; completed steps and revision consequences stay in history', async () => {
  const complete={...need,id:'complete',status:'met',knowledge:{...need.knowledge,question:'Already applied question',verified_at:at,verification:{revision:4,rationale:'Trial passed',evidence_refs:['trial.md']},applications:[{id:'a',task_id:'t',answer_revision:4,status:'applied',notes:'Implemented'}]}};
  const deferred={...need,id:'later',knowledge:{...need.knowledge,deferred_reason:'After launch'}};
  const ui=await mount(ProjectNeedsPanel,{project:{...project,needs:[complete,deferred,need]},tasks:[],onUpdate:()=>{}});
  try {
    const actions=ui.container.querySelector('[aria-label="Needs requiring action"]');
    assert.ok(actions);
    assert.deepEqual([...actions.children].map(n=>n.id),['need-n']);
    const history=[...ui.container.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Completed needs (1)');
    assert.ok(history);
    assert.equal(history.open,false);
    assert.ok(button(history,'Verified').disabled);
    assert.ok(button(history,'Applied').disabled);
    assert.doesNotMatch(history.textContent,/Blocking/);
    assert.match(history.textContent,/Nothing left to do for this answer/);
    await act(async()=>button(history,'Revise applied answer').click());
    assert.match(ui.container.textContent,/Started or completed work gets a new follow-up task/);
    await inputValue(ui.container,'Answer','Use B instead');
    assert.ok(button(ui.container,'Save revision & update work'));
    assert.ok(button(actions,'Apply after verification').disabled);
  } finally {ui.close();}
});

test('partially applied legacy answers can obtain explicit verification before applying to remaining work', async () => {
  const legacy={...need,status:'met',knowledge:{...need.knowledge,revision:0,verified_at:at,verification:undefined,task_ids:['t','remaining'],application:{status:'applied',task_id:'t'}}};
  const ui=await mount(ProjectNeedsPanel,{project:{...project,needs:[legacy]},tasks:[],onUpdate:()=>{}});
  try {
    assert.ok(button(ui.container,'Verify answer'));
    assert.equal(button(ui.container,'Verify answer').disabled,false);
    assert.ok(button(ui.container,'Apply after verification').disabled);
    await act(async()=>button(ui.container,'Verify answer').click());
    assert.ok(button(ui.container,'Confirm verification'));
  } finally {ui.close();}
});

test('retired applied questions require reopening or their successor before revision', async () => {
  for (const retired of [{status:'dropped'},{status:'met',superseded_by:['successor']}]) {
    const n={...need,status:retired.status,knowledge:{...need.knowledge,superseded_by:retired.superseded_by,applications:[{task_id:'t',status:'applied',answer_revision:4}]}};
    const ui=await mount(ProjectNeedsPanel,{project:{...project,needs:[n]},tasks:[],onUpdate:()=>{}});
    try {
      assert.ok(button(ui.container,'Revise applied answer').disabled);
      if (retired.status==='dropped') assert.equal(button(ui.container,'Reopen').disabled,false);
      else assert.match(ui.container.textContent,/Revise the successor question/);
    } finally {ui.close();}
  }
});

test('reverse-linked pending tasks remain visible in the action list', async () => {
  const n={...need,status:'met',knowledge:{...need.knowledge,blocking:false,verified_at:at,verification:{revision:4,rationale:'Trial passed',evidence_refs:['trial.md']},applications:[{task_id:'t',answer_revision:4,status:'applied'}]}};
  const ui=await mount(ProjectNeedsPanel,{project:{...project,needs:[n]},tasks:[{id:'pending',title:'Pending application',status:'planning',metadata:{knowledge_need_ids:['n']}}],onUpdate:()=>{}});
  try {
    const actions=ui.container.querySelector('[aria-label="Needs requiring action"]');
    assert.equal(actions.children.length,1);
    assert.match(actions.textContent,/Linked to unfinished work/);
    assert.match(actions.textContent,/Pending application/);
    assert.ok(button(actions,'Apply to task'));
  } finally {ui.close();}
});

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

test("structured need verifies through an explicit guarded review and tag opens actual knowledge retrieval", async () => {
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
    await verify(ui);
    const call = calls.find((c) => c.options?.method === "PATCH");
    assert.match(call.url, /\/projects\/p\/needs\/n\?/);
    assert.deepEqual(JSON.parse(call.options.body), {
      status: "met",
      expected_knowledge_revision: 4,
      knowledge: { verification: { rationale: "The trial demonstrates the documented recovery test.", evidence_refs: ["trial.md"] } },
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
    assert.ok(button(ui.container, "Review answer"));
    assert.equal(button(ui.container, "Review answer").disabled, false);
    assert.equal(button(ui.container, "Verify answer").disabled, true);
    assert.match(ui.container.textContent, /Add an evidence reference/);
    await act(async () => button(ui.container, "#database").click());
    assert.match(ui.container.textContent, /Cortex offline/);
    assert.match(ui.container.textContent, /unavailable/i);
  } finally {
    ui.close();
    globalThis.fetch = original;
  }
});

test("application records use a stable id and separate version-bound payload", async () => {
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (!options?.method) return { ok: true, json: async () => project };
    calls.push(JSON.parse(options.body));
    return { ok: false, status: 409, json: async () => ({ error: "Reload before saving; your text is preserved" }) };
  };
  const verified = { ...need, status: "met", knowledge: { ...need.knowledge, verified_at: at, verification: { rationale: "Trial passed", evidence_refs: ["trial.md"], revision: 4 } } };
  const ui = await mount(ProjectNeedsPanel, { project: { ...project, needs: [verified] }, tasks: [{ id: "t", title: "Ship recovery" }], onUpdate: () => {} });
  try {
    assert.ok(button(ui.container, "Apply to task"));
    await act(async () => button(ui.container, "Apply to task").click());
    await inputValue(ui.container, "Application outcome", "applied");
    await inputValue(ui.container, "Application evidence reference", "task:t");
    await inputValue(ui.container, "Application explanation", "Used the trial to configure recovery.");
    await act(async () => button(ui.container, "Record application").click());
    assert.match(ui.container.textContent, /your text is preserved/);
    await act(async () => button(ui.container, "Record application").click());
    assert.equal(calls[0].record_application.id, calls[1].record_application.id);
    assert.equal(calls[0].record_application.answer_revision, 4);
    assert.equal(calls[0].record_application.task_id, "t");
    assert.equal(calls[0].record_application.evidence_ref, "task:t");
    assert.equal(calls[0].knowledge, undefined);
  } finally { ui.close(); globalThis.fetch = original; }
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
    await verify(ui);
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

test("received evidence without an answer opens a usable editor and preserves text on a conflict", async () => {
  const original = fetch;
  const calls = [];
  globalThis.fetch = async (_, options) => { calls.push(JSON.parse(options.body)); return { ok: false, status: 409, json: async () => ({ error: "Knowledge revision changed; reload before saving" }) }; };
  const ui = await mount(ProjectNeedsPanel, { project: { ...project, needs: [{ ...need, knowledge: { ...need.knowledge, answer: "", research_status: "evidence_received" } }] }, tasks: [], onUpdate: () => {} });
  try {
    assert.match(ui.container.textContent, /Record an answer before verification/);
    assert.ok(button(ui.container, "Review evidence"));
    assert.equal(button(ui.container, "Review evidence").disabled, false);
    await act(async () => button(ui.container, "Review evidence").click());
    await inputValue(ui.container, "Answer", "The observed failover supports A.");
    await act(async () => button(ui.container, "Save need").click());
    assert.equal(calls[0].expected_knowledge_revision, 4);
    assert.deepEqual(calls[0].knowledge, { answer: "The observed failover supports A." });
    assert.match(ui.container.textContent, /Knowledge revision changed/);
    assert.equal([...ui.container.querySelectorAll("label")].find(l => l.textContent.startsWith("Answer")).querySelector("textarea").value, "The observed failover supports A.");
  } finally { ui.close(); globalThis.fetch = original; }
});

test("stale questions show context, separate history, and require deliberate evidence selection", async () => {
  const stale = { ...need, knowledge: { ...need.knowledge, research_status: "stale", review_reason: "Platform changed", history: [{ revision: 3, question: "Old question", satisfaction_test: "Old test", answer: "Earlier answer", evidence: [{ ref: "task:t" }], at }], applications: [{ id: "app-old", task_id: "t", status: "insufficient", answer_revision: 3, notes: "Old application result", at }] } };
  const ui = await mount(ProjectNeedsPanel, { project: { ...project, needs: [stale] }, tasks: [{ id: "t", title: "Recovery task" }], onUpdate: () => {} });
  try {
    for (const text of ["Choose the recovery architecture", "Run the recovery trial", "Operator", "Platform changed", "Earlier answer", "Old application result"]) assert.ok(ui.container.textContent.includes(text), text);
    assert.equal(button(ui.container, "Satisfy"), undefined);
    await act(async () => button(ui.container, "Verify answer").click());
    const dialog = ui.container.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /Document a recovery trial/);
    assert.equal(button(ui.container, "Confirm verification").disabled, true);
    await inputValue(ui.container, "Verification rationale", "The current scope is covered.");
    assert.equal(button(ui.container, "Confirm verification").disabled, true);
    await act(async () => dialog.querySelector('input[type="checkbox"]').click());
    assert.equal(button(ui.container, "Confirm verification").disabled, false);
  } finally { ui.close(); }
});
