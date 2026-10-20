import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskProgress } from '../task-progress';
const now = Date.parse('2026-10-09T12:00:00Z');
const source = (data: any) => ({ data, at: now, error: null });
const attempt = (id: string, outcome: string, startedAt: string) => ({ id, outcome, executor: 'codex', kind: 'dispatch', parentId: null, startedAt, completedAt: outcome === 'running' ? null : startedAt, commentary: { available: true, messages: [{ text: id === 'new' ? 'Checking the integration tests.' : 'Old failure.', sequence: 1, at: null }], reason: null, truncated: false } });
const base = () => ({ task: { id: 't1', status: 'in_progress' }, now, progress: source({ taskId: 't1', attempts: [attempt('new', 'running', '2026-10-09T11:50:00Z'), attempt('old', 'failure', '2026-10-09T10:00:00Z')], events: [], eventsAvailable: true }), live: source({ at: new Date(now).toISOString(), praxis: { reachable: true }, items: [{ taskId: 't1', lane: 'running', startedAt: '2026-10-09T11:50:00Z' }] }), pending: source([]), recent: source([]), evidence: source(null) });
test('latest attempt supplies commentary while earlier failures stay historical', () => {
 const view = buildTaskProgress(base() as any); assert.equal(view.state, 'Active'); assert.equal(view.currentStep, 'Checking the integration tests.'); assert.equal(view.latest?.id, 'new'); assert.equal(view.action, 'No action needed from you.'); assert.deepEqual(view.attempts.map((a: any) => a.id), ['old', 'new']);
});
test('unavailable or stale sources never assert no action or currently active', () => {
 const input = base(); input.pending = { data: [], at: now - 61000, error: 'offline' }; input.live.at = now - 61000;
 const view = buildTaskProgress(input as any); assert.equal(view.state, 'Unknown'); assert.match(view.action, /cannot confirm/i); assert.ok(view.gaps.some((g: string) => /stale/i.test(g)));
});
test('pending exact question wins while expired and unrelated questions are ignored', () => {
 const input = base(); input.pending.data = [{ id: 'q1', taskId: 't1', question: 'Which fixture should be kept?', requestedAt: new Date(now).toISOString() }, { id: 'q2', taskId: 'other', question: 'other' }, { id: 'q3', taskId: 't1', question: 'expired', requestedAt: '2026-10-09T10:00:00Z', ttlSeconds: 5 }];
 const view = buildTaskProgress(input as any); assert.equal(view.state, 'Waiting for you'); assert.deepEqual(view.questions.map((q: any) => q.id), ['q1']); assert.equal(view.questions[0].question, 'Which fixture should be kept?');
});
test('success stays reported until evidence confirms verification', () => {
 const input = base(); input.task.status = 'completed'; input.live.data.items = []; input.progress.data.attempts[0].outcome = 'success';
 let view = buildTaskProgress(input as any); assert.match(view.verification, /unavailable/i);
 input.evidence.data = { state: 'verified', summary: 'All completion evidence recorded.', missing: [], pieces: [], sources: { spine: { available: true } } };
 view = buildTaskProgress(input as any); assert.equal(view.verification, 'Verified completion');
});
test('HITL answers remain separate task history and do not invent the retry cause', () => {
 const input = base(); input.recent.data = [{ id: 'q1', taskId: 't1', question: 'Proceed?', requestedAt: '2026-10-09T10:05:00Z', resolution: { choice: 'Yes', resolvedAt: '2026-10-09T10:06:00Z' } }];
 const view = buildTaskProgress(input as any); assert.equal(view.history.length, 2); assert.match(view.history[1].text, /Yes/); assert.equal(view.history[1].attemptId, undefined); assert.equal(view.state, 'Active');
});
test('old verified dossier never verifies a new active attempt', () => {
 const input = base(); input.evidence.data = { state: 'verified', missing: [], pieces: [], verification: { ts: '2026-10-09T10:10:00Z' }, sources: { spine: { available: true } } };
 const view = buildTaskProgress(input as any); assert.match(view.verification, /earlier/i); assert.doesNotMatch(view.remaining, /No completion evidence/);
});
test('stopped work without a pending request names the missing recovery action', () => {
 const input = base(); input.live.data.items = []; input.task.status = 'blocked'; input.progress.data.attempts[0].outcome = 'failure';
 const view = buildTaskProgress(input as any); assert.equal(view.state, 'Stopped'); assert.match(view.action, /recovery action.*not recorded/i);
});
test('a newly running execution never inherits the older dispatch commentary', () => {
 const input = base(); input.progress.data.attempts[0].outcome = 'success'; input.progress.data.attempts[0].completedAt = '2026-10-09T11:55:00Z'; input.live.data.items[0].startedAt = '2026-10-09T11:59:00Z';
 const view = buildTaskProgress(input as any); assert.equal(view.state, 'Active'); assert.match(view.currentStep, /unavailable/i);
});
test('progress preview extracts readable prose without raw protocol fields or markdown', async () => {
 const { progressPreview } = await import('../task-progress');
 const text = '**CLI qualification is complete:** all roles passed.\n\nPRAXIS_CRITERION: huge machine packet\n- implementation_dump';
 assert.equal(progressPreview(text), 'CLI qualification is complete: all roles passed.');
 assert.equal(progressPreview('PRAXIS_CRITERION: passed\nPRAXIS_QUALITY_GATES: verify=done'), 'Technical result recorded. Expand the full message to read it.');
 assert.ok(progressPreview('A'.repeat(2000)).length <= 401);
});
test('latest message time stays distinct from start time and never uses log modification time', () => {
 const input = base(); const commentary = input.progress.data.attempts[0].commentary as any;
 commentary.messages[0].at = '2026-10-09T11:59:00Z'; commentary.observedAt='2026-10-09T12:00:00Z';
 assert.equal(buildTaskProgress(input as any).currentStepAt, '2026-10-09T11:59:00Z');
 commentary.messages[0].at=null;
 assert.equal(buildTaskProgress(input as any).currentStepAt,null);
 input.progress.at=now-61000;
 assert.equal(buildTaskProgress(input as any).currentStepAt,null);
});
test('optional improvement attempts never replace the completed parent or invalidate its QA', () => {
 for (const outcome of ['running', 'success', 'failure']) {
  const input = base() as any;
  input.task.status = 'completed';
  input.live.data.items = [{taskId:"t1", lane:"running", improvement:{id:"r1",status:"running",reason:"Optional follow-up"}}];
  input.progress.data.attempts = [
   { ...attempt('improvement', outcome, '2026-10-09T11:50:00Z'), kind: 'follow_up', parentId: 'parent' },
   attempt('parent', 'success', '2026-10-09T10:00:00Z'),
  ];
  input.progress.data.improvements = { available:true, items:[{id:'r1',dispatchId:'improvement',status:outcome==='running'?'running':'reviewing',suggestions:[]}] };
  input.evidence.data = {state:'verified',missing:[],pieces:[],verification:{ts:'2026-10-09T11:00:00Z'}};
  const view = buildTaskProgress(input);
  assert.equal(view.latest?.id, 'parent');
  assert.equal(view.state, 'Completed');
  assert.equal(view.verification, 'Verified completion');
  assert.equal(view.remaining, 'No completion evidence gates remain open.');
  assert.deepEqual(view.attempts.map(a => a.id), ['parent','improvement']);
 }
});
test('explicit reopened task and unrelated follow-up still require their own QA', () => {
 for(const kind of ['dispatch','follow_up']) {
  const input = base() as any;
  input.progress.data.attempts[0].kind = kind;
  input.progress.data.improvements = {available:true,items:[{id:'r1',dispatchId:'older-improvement',status:'verified',suggestions:[]}]};
  input.evidence.data = {state:'verified',missing:[],pieces:[],verification:{ts:'2026-10-09T11:00:00Z'}};
  const view=buildTaskProgress(input);
  assert.equal(view.latest?.id,'new'); assert.equal(view.state,'Active');
  assert.match(view.verification,/Earlier completion was verified; current attempt is not verified/);
 }
});
test('background evidence hold has a runtime reason and never invents an operator request', () => {
 const input = base() as any;
 input.live.data.items = [{ taskId: 't1', lane: 'waiting', updatedAt: '2026-10-09T11:59:00Z', backgroundObligation: { state: 'held', detail: 'Held for background evidence: Artifact is not fresh: /tmp/gr-browser-1.txt' } }];
 const view = buildTaskProgress(input);
 assert.equal(view.state, 'Held for background evidence');
 assert.match(view.statusReason, /Artifact is not fresh/);
 assert.equal(view.action, 'No pending recovery request is recorded.');
 assert.equal(view.questions.length, 0);
 input.pending.data = [{ id: 'recovery', taskId: 't1', question: 'Repair the evidence?', requestedAt: new Date(now).toISOString() }];
 const withQuestion = buildTaskProgress(input);
 assert.equal(withQuestion.state, 'Waiting for you');
 assert.match(withQuestion.statusReason, /Artifact is not fresh/);
 assert.equal(withQuestion.questions[0].id, 'recovery');
});
