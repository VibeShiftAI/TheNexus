import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskProgressView } from '../task-view/task-progress-panel.tsx';
const now = Date.now(); const source = data => ({ data, at: now, error: null });
test('summary separates reported text from evidence and renders chronological questions between attempts', () => {
 const input = { task: { id: 't', status: 'completed' }, now,
 progress: source({ taskId: 't', attempts: [{ id: 'd', executor: 'codex', kind: 'dispatch', outcome: 'success', startedAt: '2026-10-09T10:00:00Z', completedAt: '2026-10-09T11:00:00Z', commentary: { available: true, messages: [{ text: 'Tests passed.', at: null, sequence: 1 }] } }], events: [], eventsAvailable: true }), live: source({ praxis: { reachable: true }, items: [] }), pending: source([]), recent: source([{ id: 'q', taskId: 't', question: 'Proceed with the fixture?', requestedAt: '2026-10-09T10:10:00Z', resolution: { choice: 'Yes', resolvedAt: '2026-10-09T10:20:00Z' } }]), evidence: source(null) };
 const html = renderToStaticMarkup(createElement(TaskProgressView, { input })); const div = document.createElement('div'); div.innerHTML = html;
 assert.match(div.textContent, /Worker-reported/); assert.match(div.textContent, /Verification unavailable/); assert.match(div.textContent, /Message update time unavailable/);
 assert.deepEqual([...div.querySelectorAll('[data-timeline-title]')].map(e=>e.textContent), ['Attempt started · codex', 'Question requested', 'Response recorded', 'Attempt ended · success']);
 assert.ok(div.querySelector('a[href="/inbox#q"]')); assert.ok(div.querySelector('a[href="#dispatch-d"]'));
});
test('unfinished task does not link to absent completion dossier anchors', () => {
 const input = { task: { id:'t',status:'in_progress' }, now, progress: source({attempts:[],events:[],eventsAvailable:true}), live: source({praxis:{reachable:true},items:[]}), pending:source([]), recent:source([]), evidence:source({state:'not_completed',missing:[],pieces:[{key:'qa',label:'QA',status:'absent'}]}) };
 const div = document.createElement('div'); div.innerHTML=renderToStaticMarkup(createElement(TaskProgressView,{input})); assert.equal(div.querySelector('a[href="#evidence-qa"]'),null);
});

test('renders source message timestamp next to update independently from task start', () => {
 const input = {task:{id:'t',status:'in_progress'},now,progress:source({attempts:[{id:'d',executor:'claude-code',outcome:'running',startedAt:'2026-10-10T15:54:29Z',commentary:{available:true,messages:[{text:'Checking links.',at:'2026-10-10T16:04:15Z',sequence:1}]}}],events:[],eventsAvailable:true}),live:source({praxis:{reachable:true},items:[{taskId:'t',lane:'running',startedAt:'2026-10-10T15:54:29Z'}]}),pending:source([]),recent:source([]),evidence:source(null)};
 const div=document.createElement('div'); div.innerHTML=renderToStaticMarkup(createElement(TaskProgressView,{input}));
 assert.equal(div.querySelector('[data-message-updated] time').getAttribute('datetime'),'2026-10-10T16:04:15Z');
 assert.match(div.textContent,/Started/); assert.match(div.textContent,/Message updated/);
});

const admissionInput = (status = 'todo', decision = 'needs_evidence') => ({
 task: { id: 't', status, metadata: { work_admission: { decision, reason: 'Possible scope overlap requires a bounded evidence comparison.', checked_at: '2026-10-10T16:00:00Z', matches: [{ task_id: 'compared/task', title: 'Earlier delivery' }] } } }, now,
 progress: source({ taskId: 't', attempts: [], events: [], eventsAvailable: true }), live: source({ praxis: { reachable: true }, items: [] }), pending: source([]), recent: source([]), evidence: source(null),
});
const renderProgress = input => { const div = document.createElement('div'); div.innerHTML = renderToStaticMarkup(createElement(TaskProgressView, { input })); return div; };
test('pending admission shows factual reason, checked time and compared task links without requesting user action', () => {
 const div = renderProgress(admissionInput()); const hold = div.querySelector('[data-work-admission]');
 assert.ok(hold, 'routine admission hold is visible');
 assert.match(div.textContent, /Waiting for admission/);
 assert.match(hold.textContent, /Possible scope overlap requires a bounded evidence comparison/);
 assert.match(hold.textContent, /Praxis compares retained evidence automatically before starting/);
 assert.equal(hold.querySelector('time').getAttribute('datetime'), '2026-10-10T16:00:00Z');
 assert.equal(hold.querySelector('a').getAttribute('href'), '/task/compared%2Ftask');
 assert.match(hold.textContent, /Earlier delivery/);
 assert.doesNotMatch(hold.textContent, /currently reviewing|your response|resolve this/i);
 assert.equal(hold.querySelector('[role="alert"]'), null);
});
test('all blocking routine admission decisions appear but allowed and contract holds do not duplicate', () => {
 for (const decision of ['covered_by_open', 'already_delivered', 'partial_overlap']) assert.ok(renderProgress(admissionInput('todo', decision)).querySelector('[data-work-admission]'));
 assert.equal(renderProgress(admissionInput('todo', 'new_work')).querySelector('[data-work-admission]'), null);
 const input = admissionInput(); input.task.metadata.work_admission.hold_kind = 'contract_drift'; input.task.metadata.work_admission.contract_hold = {};
 assert.equal(renderProgress(input).querySelector('[data-work-admission]'), null);
});
test('historical admission holds are absent from active and terminal tasks and confirmed running work', () => {
 for (const status of ['in_progress', 'completed', 'done', 'cancelled', 'archived']) assert.equal(renderProgress(admissionInput(status)).querySelector('[data-work-admission]'), null);
 const input = admissionInput(); input.live.data.items = [{ taskId: 't', lane: 'running', startedAt: '2026-10-10T16:05:00Z' }];
 const div = renderProgress(input); assert.equal(div.querySelector('[data-work-admission]'), null); assert.match(div.textContent, /Active/);
});
test('scheduled work also exposes its admission hold before dispatch', () => {
 assert.ok(renderProgress(admissionInput('scheduled')).querySelector('[data-work-admission]'));
});
test('partial overlap names remaining scope without promising automatic re-review', () => {
 const panel = renderProgress(admissionInput('todo', 'partial_overlap')).querySelector('[data-work-admission]');
 assert.match(panel.textContent, /remaining scope/i);
 assert.doesNotMatch(panel.textContent, /compares retained evidence automatically/i);
});
test('resumable nonterminal statuses show admission while active and terminal states suppress historical receipts', () => {
 for (const status of ['idea', 'planning', 'on_hold', 'future', 'needs_input', 'failed', 'waiting_for_dependency']) assert.ok(renderProgress(admissionInput(status)).querySelector('[data-work-admission]'), status);
 for (const status of ['dispatched', 'in_progress', 'ready_for_review', 'review', 'completed', 'done', 'cancelled', 'archived']) assert.equal(renderProgress(admissionInput(status)).querySelector('[data-work-admission]'), null, status);
});

test('background hold renders exact reason and only links a recorded recovery question', () => {
 const input = { task: { id: 't', status: 'in_progress' }, now,
  progress: source({ attempts: [], events: [], eventsAvailable: true }),
  live: source({ praxis: { reachable: true }, items: [{ taskId: 't', lane: 'waiting', backgroundObligation: { executionId: 'execution', state: 'held', detail: 'Held for background evidence: Artifact is not fresh: /tmp/gr-browser-1.txt' } }] }), pending: source([]), recent: source([]), evidence: source(null) };
 const div = document.createElement('div');
 div.innerHTML = renderToStaticMarkup(createElement(TaskProgressView, { input }));
 assert.match(div.querySelector('[data-runtime-hold]').textContent, /Artifact is not fresh/);
 assert.match(div.textContent, /No pending recovery request is recorded/);
 assert.equal(div.querySelector('a[href^="/inbox#"]'), null);
 input.pending.data = [{ id: 'recovery', taskId: 't', question: 'Repair the background evidence?', requestedAt: new Date(now).toISOString() }];
 div.innerHTML = renderToStaticMarkup(createElement(TaskProgressView, { input }));
 assert.match(div.textContent, /Waiting for you/);
 assert.ok(div.querySelector('a[href="/inbox#recovery"]'));
 assert.match(div.querySelector('[data-runtime-hold]').textContent, /Artifact is not fresh/);
});
