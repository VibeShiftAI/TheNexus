import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskProgressView } from '../task-view/task-progress-panel.tsx';
const now = Date.now();
const source = data => ({data, at:now, error:null});
function render(improvements, progressOverride = {}) {
 const input = { task:{id:'t', status:'completed'}, now, progress:{...source({taskId:'t', attempts:[], events:[], eventsAvailable:true, improvements}), ...progressOverride}, live:source({praxis:{reachable:true},items:[]}), pending:source([]),recent:source([]),evidence:source({state:'verified', verification:{ts:'2026-10-10T12:00:00Z'}, missing:[], pieces:[]}) };
 const div = document.createElement('div'); div.innerHTML = renderToStaticMarkup(createElement(TaskProgressView, {input}));
 return div;
}
const item = { id:'r1', status:'waiting', updatedAt:'2026-10-10T11:00:00Z', author:'codex', suggestions:[{source:'QA reviewer',text:'Full suggestion: add a regression test.\nKeep the edge case.'}], reason:'Awaiting follow-up review after thirty continuous idle minutes.' };
test('completed parent shows waiting improvement separately with full suggestion and timestamp', () => {
 const div = render({available:true,items:[item]});
 const panel = div.querySelector('[aria-label="QA improvements"]'); assert.ok(panel);
 assert.match(div.textContent,/Verified completion/);
 assert.match(panel.textContent,/Waiting — not started/); assert.ok(panel.querySelector('a[href="/calendar"]')); assert.match(panel.textContent,/thirty continuous idle minutes/);
 assert.doesNotMatch(panel.textContent,/including tasks held for checks/);
 assert.doesNotMatch(panel.textContent,/Optional suggestions have their own execution|Parent task QA does not verify/);
 assert.match(panel.querySelector('details').textContent,/Keep the edge case/);
 assert.equal(panel.querySelector('time').getAttribute('datetime'),item.updatedAt);
});
test('improvement review evidence and dispatch remain accessible for all terminal states', () => {
 for(const status of ['verified','declined','needs_attention','unknown','running','reviewing']) {
  const div=render({available:true,items:[{...item,status,dispatchId:'d1',review:{assessment:'pass',notes:'Reviewed changed files.',evidence:'Focused tests: 7 passed.',reviewer:'claude-code'},commitSha:'a'.repeat(40)}]});
  const panel=div.querySelector('[aria-label="QA improvements"]'); assert.ok(panel);
  assert.ok(panel.querySelector('a[href="#dispatch-d1"]')); assert.match(panel.textContent,/claude-code/); assert.match(panel.textContent,/Focused tests: 7 passed/);
 }
});
test('retained snapshots show stale status and unavailable API remains backwards compatible', () => {
 for(const override of [{at:now-61000}, {error:'Source unavailable'}]) {
  const panel=render({available:true,items:[item]},override).querySelector('[aria-label="QA improvements"]');
  assert.match(panel.textContent,/Stale snapshot/); assert.match(panel.textContent,/Last recorded status/);
 }
 assert.match(render(undefined).querySelector('[aria-label="QA improvements"]').textContent,/unavailable/i);
 assert.match(render({available:false,items:[]}).querySelector('[aria-label="QA improvements"]').textContent,/unavailable/i);
 assert.match(render({available:true,items:[]}).querySelector('[aria-label="QA improvements"]').textContent,/No QA improvement suggestions are recorded/);
});

test('linked follow-up is prominent and does not claim stale legacy execution status', () => {
 const optionalTaskId='0d1001a3-20b5-4d74-b6b1-a1a13cdb0945';
 const panel=render({available:true,items:[{...item,status:'linked',optionalTaskId,reason:'Follow the linked task for current status.'}]}).querySelector('[aria-label="QA improvements"]');
 const link=panel.querySelector(`a[href="/task/${optionalTaskId}"]`);
 assert.ok(link); assert.match(link.textContent,/Tracked in follow-up task/);
 assert.doesNotMatch(panel.textContent,/Waiting — not started|Running|Verified/);
 assert.ok(panel.querySelector('details'));
});

test('review-only completion shows decision rationale and evidence without claiming verification', () => {
 const panel=render({available:true,items:[{...item,status:'completed_after_review',followupReview:{status:'completed',priority:2,slateId:'slate-1',decisions:[{index:0,disposition:'complete',reason:'Already addressed.',evidence:['Existing test passes.']}]}}]}).querySelector('[aria-label="QA improvements"]');
 assert.match(panel.textContent,/Completed after review/);
 assert.match(panel.textContent,/No implementation or independent QA completion is implied/);
 assert.match(panel.textContent,/Already addressed/);
 assert.match(panel.textContent,/Existing test passes/);
 assert.match(panel.textContent,/Priority 2/);
});

// Shape of task f93e5ba5 (2026-11-13): the follow-up review reason is copied into
// the item reason and into its only decision, so the same paragraph used to show three times.
const occurrences = (text, paragraph) => text.split(paragraph).length - 1;
const retained = 'The critic\'s objections may matter, but I cannot read enough to decide.\nTwo facts are missing.';
test('a repeated follow-up reason renders once and keeps every decision, evidence line and suggestion', () => {
 const panel=render({available:true,items:[{...item,status:'retained',reason:retained,followupReview:{status:'retained',reviewedAt:'2026-11-13T11:01:01.800Z',reason:retained,priority:40,decisions:[{index:0,disposition:'retain',reason:retained,evidence:['evidence-9a751a']}]},suggestions:[{source:'adversarial-critic',text:'Resolve the two objections.'}]}]}).querySelector('[aria-label="QA improvements"]');
 assert.equal(occurrences(panel.textContent,retained),1,panel.textContent);
 assert.match(panel.textContent,/Finding 1 · Retained/);
 assert.match(panel.textContent,/evidence-9a751a/);
 assert.match(panel.textContent,/Priority 40/);
 assert.match(panel.querySelector('details').textContent,/adversarial-critic.*Resolve the two objections\./s);
 assert.doesNotMatch(panel.textContent,/Optional suggestions have their own execution|Parent task QA does not verify/);
});
test('a suggestion whose text repeats keeps its entry and source but not a second copy of the paragraph', () => {
 const text='Add a regression test for the empty schedule.\nKeep the edge case.';
 const panel=render({available:true,items:[{...item,suggestions:[{source:'QA reviewer',text},{source:'adversarial-critic',text:text.replace('\n','\n  ')}],review:{assessment:'pass',notes:item.reason,evidence:'Focused tests: 7 passed.',reviewer:'claude-code'}}]}).querySelector('[aria-label="QA improvements"]');
 const list=panel.querySelector('details ol');
 assert.equal(list.querySelectorAll('li').length,2);
 assert.match(panel.querySelector('details summary').textContent,/\(2\)/);
 assert.equal(occurrences(panel.textContent,'Add a regression test for the empty schedule.'),1,panel.textContent);
 assert.match(list.querySelectorAll('li')[1].textContent,/adversarial-critic.*Same text as suggestion 1\./s);
 // Review notes that repeat the reason point at it instead of repeating it.
 assert.equal(occurrences(panel.textContent,item.reason),1,panel.textContent);
 assert.match(panel.querySelectorAll('details')[1].textContent,/Same text as above\..*Focused tests: 7 passed/s);
});
