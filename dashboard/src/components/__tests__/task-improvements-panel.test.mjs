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
const item = { id:'r1', status:'waiting', updatedAt:'2026-10-10T11:00:00Z', author:'codex', suggestions:[{source:'QA reviewer',text:'Full suggestion: add a regression test.\nKeep the edge case.'}], reason:'Improvement dispatch is deferred; approved work takes precedence.' };
test('completed parent shows waiting improvement separately with full suggestion and timestamp', () => {
 const div = render({available:true,items:[item]});
 const panel = div.querySelector('[aria-label="QA improvements"]'); assert.ok(panel);
 assert.match(div.textContent,/Verified completion/);
 assert.match(panel.textContent,/Waiting — not started/); assert.ok(panel.querySelector('a[href="/calendar"]')); assert.match(panel.textContent,/approved work takes precedence/);
 assert.match(panel.textContent,/Parent task QA does not verify/);
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
