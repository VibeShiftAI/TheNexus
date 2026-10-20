import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskDispatchConsole } from '../task-view/dispatch-console.tsx';
test('an in-page progress link opens and scrolls the selected dispatch after mount', async () => {
 const original = globalThis.fetch; const scroll = window.HTMLElement.prototype.scrollIntoView; const scrolled = [];
 window.HTMLElement.prototype.scrollIntoView = function() { scrolled.push(this.id); };
 const rows = ['new', 'old'].map(id => ({ id, task_id:'t', executor:'codex', outcome:'success', kind:'dispatch', started_at:'2026-10-09T10:00:00Z', completed_at:'2026-10-09T11:00:00Z', output:`Output for ${id}` }));
 globalThis.fetch = async url => String(url).startsWith('/api/dispatches?') ? new Response(JSON.stringify({ dispatches:rows })) : new Response('{}',{status:503});
 window.history.replaceState(null,'','/task/t'); const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
 try {
  await act(async () => { root.render(createElement(TaskDispatchConsole,{taskId:'t',projectId:null})); });
  await act(async () => { await new Promise(r=>setTimeout(r,0)); });
  assert.equal(div.querySelectorAll('article')[1].querySelector('[role="button"]').getAttribute('aria-expanded'),'false');
  await act(async () => { window.history.replaceState(null,'','/task/t#dispatch-old'); window.dispatchEvent(new window.HashChangeEvent('hashchange')); });
  const target = div.querySelector('#dispatch-old'); assert.ok(target); assert.equal(target.querySelector('[role="button"]').getAttribute('aria-expanded'),'true'); assert.ok(scrolled.includes('dispatch-old'));
 } finally { act(()=>root.unmount()); div.remove(); globalThis.fetch=original; window.HTMLElement.prototype.scrollIntoView=scroll; window.history.replaceState(null,'','/'); }
});
