import test from "node:test";
import assert from "node:assert/strict";
import {
  endpointReadiness,
  needPatch,
  proposalAcceptance,
  canSatisfyNeed,
} from "../project-endpoint";
import * as lifecycle from "../project-endpoint";
const { verificationPatch, applicationPatch, knowledgeLifecycle, evidenceLink } = lifecycle;
import { addProjectNeed, patchProjectNeed } from "../nexus/project-needs";

const knowledge = {
  question: "What works?", purpose:"Choose the approach", resolution:{method:"experiment"},
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

test('completed application leaves the action queue, while partial or revised application remains actionable', () => {
  const completed = {...need, status:'met', knowledge:{...knowledge, revision:2, verified_at:'2026-10-17T00:00:00Z', verification:{revision:2}, task_ids:['t'], applications:[{id:'a',task_id:'t',answer_revision:2,status:'applied'}]}};
  assert.equal(knowledgeLifecycle(completed).complete, true);
  assert.equal(knowledgeLifecycle(completed).actionRequired, false);
  assert.equal(knowledgeLifecycle(completed).applied, true);
  assert.equal(knowledgeLifecycle({...completed, knowledge:{...completed.knowledge,task_ids:['t','other']}}).actionRequired,true);
  assert.equal(knowledgeLifecycle({...completed,status:'open',knowledge:{...completed.knowledge,revision:3,research_status:'stale'}}).actionRequired,true);
  assert.equal(knowledgeLifecycle({...need,knowledge:{...knowledge,deferred_reason:'Later'}}).actionRequired,false);
  assert.equal(knowledgeLifecycle({...need,kind:'capability',knowledge:undefined,status:'met'}).actionRequired,false);
});

test('legacy application counts only at its own revision and latest per-task outcome wins', () => {
  const legacy={...need,status:'met',knowledge:{...knowledge,verified_at:'2026-10-17T00:00:00Z',task_ids:['t'],application:{task_id:'t',status:'applied'}}};
  assert.equal(knowledgeLifecycle(legacy).complete,true);
  assert.equal(knowledgeLifecycle({...legacy,knowledge:{...legacy.knowledge,revision:2,verification:{revision:2}}}).complete,false);
  const challenged={...legacy,knowledge:{...legacy.knowledge,applications:[{task_id:'t',answer_revision:0,status:'applied'},{task_id:'t',answer_revision:0,status:'insufficient'}]}};
  assert.equal(knowledgeLifecycle(challenged).complete,false);
});

test('an unlinked task application still needs attention when its latest outcome is pending or failed', () => {
  const verified={...need,status:'met',knowledge:{...knowledge,revision:2,verified_at:'2026-10-17T00:00:00Z',verification:{revision:2},task_ids:[],applications:[{task_id:'done',answer_revision:2,status:'applied'},{task_id:'remaining',answer_revision:2,status:'ready'}]}};
  for (const status of ['ready','insufficient','outdated']) {
    const n={...verified,knowledge:{...verified.knowledge,applications:[verified.knowledge.applications[0],{task_id:'remaining',answer_revision:2,status}]}};
    assert.equal(knowledgeLifecycle(n).complete,false);
    assert.equal(knowledgeLifecycle(n).actionRequired,true);
    assert.deepEqual(knowledgeLifecycle(n).remainingTaskIds,['remaining']);
  }
});

test('actionable questions sort by checkpoint blockers, other blockers, unfinished work, then other questions', () => {
  assert.equal(typeof lifecycle.prioritizeKnowledgeNeeds,'function');
  const make=(id,patch={})=>({...need,id,knowledge:{...knowledge,blocking:false,criterion_ids:[],...patch}});
  const current=make('current',{blocking:true,criterion_ids:['current-criterion']});
  const blocking=make('blocking',{blocking:true});
  const linked=make('linked',{task_ids:['pending-task']});
  const ordinary=make('ordinary');
  const project={checkpoints:{revision:'r',archived:[],items:[{id:'cp',status:'pending',criteria:[{id:'current-criterion'}],need_ids:[]}]}};
  const ordered=lifecycle.prioritizeKnowledgeNeeds([ordinary,linked,blocking,current],project,[{id:'pending-task',status:'idea'}]);
  assert.deepEqual(ordered.map(n=>n.id),['current','blocking','linked','ordinary']);
});

test('reverse task links keep unapplied work actionable without resurrecting prior applied tasks', () => {
  const n={...need,status:'met',knowledge:{...knowledge,blocking:false,revision:2,verified_at:'2026-10-17T00:00:00Z',verification:{revision:2},task_ids:['done'],applications:[{task_id:'done',answer_revision:2,status:'applied'},{task_id:'old',answer_revision:1,status:'applied'}]}};
  const tasks=[{id:'pending',status:'planning',metadata:{knowledge_need_ids:['n']}},{id:'context',status:'idea',metadata:{knowledge_context:{requirements:[{need_id:'n'}]}}},{id:'old',status:'completed',metadata:{knowledge_need_ids:['n']}}];
  assert.equal(knowledgeLifecycle(n,undefined,tasks).complete,false);
  assert.deepEqual(knowledgeLifecycle(n,undefined,tasks).remainingTaskIds,['pending','context']);
  assert.equal(lifecycle.knowledgePriority(n,{},tasks).rank,2);
  assert.equal(knowledgeLifecycle(n,undefined,[tasks[2]]).complete,true);
  const routed=[...tasks,{id:'done',status:'planning',metadata:{knowledge_changes:[{need_id:'n',revision:2,previous_task_ids:['pending','context','old']}]}}];
  assert.equal(knowledgeLifecycle(n,undefined,routed).complete,true);
  const newlyLinked=[...routed,{id:'new',status:'idea',metadata:{knowledge_need_ids:['n']}}];
  assert.deepEqual(knowledgeLifecycle(n,undefined,newlyLinked).remainingTaskIds,['new']);
  const reverified={...n,knowledge:{...n.knowledge,revision:3,verification:{revision:3},applications:[...n.knowledge.applications,{task_id:'done',answer_revision:3,status:'applied'}]}};
  assert.equal(knowledgeLifecycle(reverified,undefined,routed).complete,true);
});

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
    { expected_knowledge_revision: 0, knowledge: { research_status: "researching" } },
  );
  assert.deepEqual(needPatch(need, { ...need, status: "met" }), {
    status: "met", expected_knowledge_revision: 0,
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

test('lifecycle review stays actionable with received evidence and no answer, and excludes deferred/superseded work', () => {
  assert.equal(typeof knowledgeLifecycle, "function");
  const missing = { ...need, knowledge: { ...knowledge, answer: '', research_status: 'evidence_received' } };
  const state = knowledgeLifecycle(missing);
  assert.equal(state.needsAnswer, true);
  assert.equal(knowledgeLifecycle({ ...need, kind: "capability", knowledge: undefined }).needsAnswer, false);
  assert.equal(state.evidenceToReview, true);
  assert.match(state.verificationProblems.join(' '), /Record an answer/);
  assert.equal(state.primaryAction, 'Review evidence');
  assert.equal(knowledgeLifecycle({ ...missing, status: 'dropped' }).active, false);
  assert.equal(knowledgeLifecycle({ ...missing, knowledge:{...missing.knowledge,deferred_reason:'After route is proven'} }).active,false);
  assert.equal(knowledgeLifecycle({ ...missing, knowledge: { ...missing.knowledge, deferred_until: '2099-01-01T00:00:00Z' } }).active, false);
  assert.equal(knowledgeLifecycle({ ...missing, knowledge: { ...missing.knowledge, superseded_by: ['successor'] } }).active, false);
  const stale = knowledgeLifecycle({ ...need, knowledge: { ...knowledge, research_status: 'stale' } });
  assert.equal(stale.needsReview, true);
  assert.equal(stale.verified, false);
});
test('verification explicitly binds rationale and selected evidence to the saved revision', () => {
  assert.equal(typeof verificationPatch, "function");
  const scoped = { ...need, knowledge: { ...knowledge, revision: 4 } };
  assert.throws(() => verificationPatch(scoped, '', ['report.md']), /rationale/i);
  assert.throws(() => verificationPatch(scoped, 'Trial meets the test.', []), /evidence/i);
  assert.throws(() => verificationPatch(scoped, 'Trial meets the test.', ['other']), /current/i);
  assert.deepEqual(verificationPatch(scoped, 'Trial meets the test.', ['report.md']), { status: 'met', expected_knowledge_revision: 4, knowledge: { verification: { rationale: 'Trial meets the test.', evidence_refs: ['report.md'] } } });
});
test('ordinary saves guard edits and never forward server-owned histories or verification', () => {
  const before = { ...need, knowledge: { ...knowledge, revision: 4 } };
  const patch = needPatch(before, { ...before, knowledge: { ...before.knowledge, answer: 'Use B', revision: 99, history: [], applications: [], verified_at: 'forged', verified_by: 'forged', verification: { rationale: 'forged', evidence_refs: ['report.md'] }, application: { status: 'successful' } } });
  assert.deepEqual(patch, { expected_knowledge_revision: 4, knowledge: { answer: 'Use B' } });
  assert.deepEqual(needPatch(before, before), {});
});
test('task application is separate, explained, evidence-bound and version-bound', () => {
  const verified = { ...need, status: 'met', knowledge: { ...knowledge, revision: 4, verified_at: '2026-10-17T12:00:00Z', verification: { rationale: 'Trial passed', evidence_refs: ['report.md'], revision: 4 } } };
  assert.equal(typeof applicationPatch, "function");
  const application = { id: 'app-1', task_id: 't', status: 'applied', evidence_ref: 'task:t', notes: 'Changed the database configuration.' };
  assert.throws(() => applicationPatch(need, application), /verified/i);
  assert.throws(() => applicationPatch(verified, { ...application, notes: '' }), /explanation/i);
  assert.throws(() => applicationPatch(verified, { ...application, evidence_ref: '' }), /evidence/i);
  assert.deepEqual(applicationPatch(verified, application), { expected_knowledge_revision: 4, record_application: { ...application, answer_revision: 4 } });
  assert.equal(knowledgeLifecycle(verified).awaitingApplication, true);
  assert.equal(knowledgeLifecycle({ ...verified, knowledge: { ...verified.knowledge, applications: [{ ...application, answer_revision: 4 }] } }).awaitingApplication, false);
});
test('evidence references use verified routes and unsafe or local paths remain copyable text', () => {
  assert.equal(typeof evidenceLink, "function");
  assert.equal(evidenceLink('task:t1')?.href, '/task/t1');
  assert.equal(evidenceLink('document:doc1')?.href, '/documents/doc1');
  assert.equal(evidenceLink('praxis:hitl:ask-1')?.href, '/inbox#ask-1');
  assert.equal(evidenceLink('vault:memories/trial.md')?.href, '/activity?document=memories%2Ftrial.md');
  assert.equal(evidenceLink('praxis:feedback:query:q1#answer')?.href, '/mail');
  assert.equal(evidenceLink('praxis:feedback:inbound:mail1')?.href, '/mail');
  for (const ref of ['javascript:alert(1)', 'file:///private/notes.md', '/Volumes/Projects/app/notes.md', 'vault:../../secret.md', '//evil.example']) assert.equal(evidenceLink(ref), null);
});


test('a later failed task application stays in the application queue without invalidating knowledge', () => {
  const n={...need,status:'met',knowledge:{...knowledge,revision:2,verified_at:'2026-10-17T00:00:00Z',verification:{revision:2,rationale:'Trial',evidence_refs:['report.md']},task_ids:['t'],applications:[{id:'a',task_id:'t',answer_revision:2,status:'applied'},{id:'b',task_id:'t',answer_revision:2,status:'insufficient',challenges_knowledge:false}]}};
  assert.equal(knowledgeLifecycle(n).verified,true);
  assert.equal(knowledgeLifecycle(n).awaitingApplication,true);
  const ref='/api/documents/doc-1/raw?revision=rev-2';
  assert.equal(evidenceLink(ref)?.href,ref);
});
