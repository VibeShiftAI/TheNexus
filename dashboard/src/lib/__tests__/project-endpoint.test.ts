import test from "node:test";
import assert from "node:assert/strict";
import {
  endpointReadiness,
  needPatch,
  proposalAcceptance,
  canSatisfyNeed,
} from "../project-endpoint";
import { addProjectNeed, patchProjectNeed } from "../nexus/project-needs";

const knowledge = {
  question: "What works?",
  tags: ["proof"],
  satisfaction_test: "Measured in production",
  criterion_ids: ["c"],
  task_ids: [],
  blocking: true,
  research_status: "evidence_ready",
  answer: "Use A",
  evidence: [
    { ref: "report.md", summary: "trial", checked_at: "2026-09-07T10:00:00Z" },
  ],
};
const need = {
  id: "n",
  kind: "information",
  description: "Choose",
  status: "open",
  created_at: "today",
  knowledge,
};

test("empty criteria and stale assessments never imply achievement", () => {
  assert.equal(
    endpointReadiness({
      end_state_criteria: [],
      end_state_assessment: {
        achieved: true,
        results: [],
        knowledge: { required: 0, satisfied: 0, unresolved: 0 },
      },
    }).achieved,
    false,
  );
  const project = {
    end_state_updated_at: "r2",
    end_state_criteria: [{ id: "c", enabled: true }],
    end_state_assessment: {
      endpoint_revision: "r1",
      achieved: true,
      results: [{ id: "c", status: "pass", pass: true }],
      knowledge: { required: 0, satisfied: 0, unresolved: 0 },
    },
  };
  assert.equal(endpointReadiness(project).results.get("c"), undefined);
  assert.equal(endpointReadiness(project).achieved, false);
});

test("unresolved blocking knowledge prevents a green endpoint", () => {
  const project = {
    end_state_criteria: [{ id: "c" }],
    needs: [need],
    end_state_assessment: {
      achieved: true,
      results: [{ id: "c", status: "pass", pass: true }],
      knowledge: { required: 0, satisfied: 0, unresolved: 0 },
    },
  };
  assert.equal(endpointReadiness(project).achieved, false);
});

test("criterion links alone do not make knowledge blocking", () => {
  const project = {
    end_state_criteria: [{ id: "c" }],
    needs: [{ ...need, knowledge: { ...knowledge, blocking: false } }],
    end_state_assessment: {
      achieved: true,
      results: [{ id: "c", status: "pass", pass: true }],
      knowledge: { required: 0, satisfied: 0, unresolved: 0 },
    },
  };
  assert.equal(endpointReadiness(project).required, 0);
  assert.equal(endpointReadiness(project).achieved, true);
});

test("met knowledge requires current verified evidence, consistent with runtime readiness", () => {
  const project = {
    end_state_updated_at: "r2",
    end_state_criteria: [{ id: "c" }],
    end_state_assessment: {
      endpoint_revision: "r2",
      achieved: true,
      results: [{ id: "c", status: "pass", pass: true }],
      knowledge: { required: 1, satisfied: 1, unresolved: 0 },
    },
  };
  const verified = {
    ...need,
    status: "met",
    knowledge: {
      ...knowledge,
      verified_at: "2026-09-07T10:00:00Z",
      endpoint_revision: "r2",
    },
  };
  assert.equal(
    endpointReadiness({ ...project, needs: [verified] }).achieved,
    true,
  );
  for (const patch of [
    { research_status: "stale" },
    { verified_at: undefined },
    { verified_at: "invalid" },
    { answer: " " },
    { evidence: [] },
    { endpoint_revision: "r1" },
  ]) {
    const result = endpointReadiness({
      ...project,
      needs: [{ ...verified, knowledge: { ...verified.knowledge, ...patch } }],
    });
    assert.equal(result.unresolved, 1, JSON.stringify(patch));
    assert.equal(result.achieved, false, JSON.stringify(patch));
  }
});

test("status and research edits send only changed knowledge fields and retain evidence on server", () => {
  assert.deepEqual(
    needPatch(need, {
      ...need,
      knowledge: { ...knowledge, research_status: "researching" },
    }),
    { knowledge: { research_status: "researching" } },
  );
  assert.deepEqual(needPatch(need, { ...need, status: "met" }), {
    status: "met",
  });
  assert.equal(canSatisfyNeed(need), true);
  assert.equal(
    canSatisfyNeed({ ...need, knowledge: { ...knowledge, answer: " " } }),
    false,
  );
  assert.equal(
    canSatisfyNeed({ ...need, knowledge: { ...knowledge, evidence: [] } }),
    false,
  );
});

test("a next endpoint changes the current sentence only in the explicit acceptance payload", () => {
  const project = {
    end_state: "Current",
    updated_at: "v1",
    endpoint: {
      scope: "Keep scope",
      completion_policy: "propose_next",
      proposed_next: "Next",
    },
  };
  const patch = proposalAcceptance(project);
  assert.equal(project.end_state, "Current");
  assert.equal(patch.end_state, "Next");
  assert.equal(patch.endpoint.scope, "Keep scope");
  assert.equal(patch.endpoint.proposed_next, "");
  assert.equal(patch.expected_updated_at, "v1");
});

test("need API calls address one need and round-trip full response and actionable conflicts", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
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
  try {
    const result = await patchProjectNeed("p/x", "n/x", {
      knowledge: { research_status: "stale" },
    });
    assert.equal(result.needs[0].knowledge.evidence[0].summary, "trial");
    assert.match(calls[0].url, /\/p%2Fx\/needs\/n%2Fx\?/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      knowledge: { research_status: "stale" },
    });
    await addProjectNeed("p", {
      kind: "information",
      description: "Choose",
      knowledge,
    });
    assert.equal(calls[1].options.method, "POST");
    globalThis.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "Project changed" }),
    });
    await assert.rejects(
      patchProjectNeed("p", "n", { status: "met" }),
      /Project changed/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('final readiness defers checkpoint-only needs and enforces unfinished sequence gate', () => {
  const project = {
    end_state_criteria: [{ id: 'final' }], needs: [need],
    checkpoints: { revision: 'r', archived: [], items: [{ id: 'cp', status: 'completed', criteria: [{ id: 'c' }], need_ids: [] }] },
    end_state_assessment: { achieved: true, results: [{ id: 'final', status: 'pass', pass: true }], knowledge: { required: 0, satisfied: 0, unresolved: 0 } },
  };
  assert.equal(endpointReadiness(project).achieved, true);
  assert.equal(endpointReadiness(project).required, 0);
  project.checkpoints.items[0].status = 'pending';
  assert.equal(endpointReadiness(project).achieved, false);
});
