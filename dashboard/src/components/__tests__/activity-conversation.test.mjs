import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EventRow } from '../activity-feed.tsx';
import { readChatDraft, writeChatDraft, clearChatDraft } from '../../lib/chat-draft.ts';

test('Activity leads with a validated update and retains complete raw evidence and destinations', async t => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host); t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  const raw = 'Raw evidence: worker=qa--123 exit=137. [Quality review](/documents/review-1)\n\nFinal diagnostic line.';
  const event = { id: 43, event_type: 'document_delivery', title: 'Review run', severity: 'info', message: raw, task_id: 'task-1', source: 'praxis', metadata: JSON.stringify({ brief: { kind: 'update', project: 'Praxis', situation: 'Memory pressure stopped the quality review.', problem: '', ask: '' }, taskTitle: 'Check quality reviews', hitlId: 'quality-review-question' }), requires_action: 1, created_at: '2026-10-28T12:00:00Z' };
  const opened = [];
  await act(async () => root.render(React.createElement(EventRow, { event, onOpenTask: id => opened.push(id), evidence: { hitls: { 'quality-review-question': { id: 'quality-review-question', question: 'Technical wrapper worker=qa--123' } }, tasks: {} } })));
  assert.match(host.textContent, /Memory pressure stopped the quality review/);
  assert.doesNotMatch(host.textContent, /worker=qa--123|Final diagnostic line|What I need from you/);
  assert.equal(host.querySelector('a[href="/documents/review-1"]')?.textContent, 'Quality review');
  assert.ok(host.querySelector('a[href="/inbox#quality-review-question"]'));
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Check quality reviews')).click());
  assert.deepEqual(opened, ['task-1']);
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Detail').click());
  assert.match(host.textContent, /worker=qa--123 exit=137/);
  assert.match(host.textContent, /Final diagnostic line/);
  assert.equal(event.message, raw);
});

test('Ask Praxis preserves an unsent draft and seeds a question without sending', async t => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host); t.after(async()=>{await act(async()=>root.unmount());host.remove();clearChatDraft();});
  writeChatDraft('My unfinished thought.');
  const seeds=[]; const onSeed=e=>seeds.push(e.detail.text);
  window.addEventListener('nexus:chat-seed',onSeed);t.after(()=>window.removeEventListener('nexus:chat-seed',onSeed));
  const event={id:42,event_type:'task_qa_passed',title:'Room recovery passed',severity:'info',message:'Tests passed.',task_id:'t1',source:'praxis',metadata:{},requires_action:0,created_at:'2026-10-13T12:00:00Z'};
  await act(async()=>root.render(React.createElement(EventRow,{event,onOpenTask:()=>{}})));
  const button=[...host.querySelectorAll('button')].find(b=>b.textContent==='Ask Praxis');
  await act(async()=>button.click());
  assert.equal(seeds.length,1);assert.equal(readChatDraft(),seeds[0]);
  assert.match(seeds[0],/^My unfinished thought\./);assert.match(seeds[0],/Room recovery passed/);assert.match(seeds[0],/Event 42/);
});

test('grouped Activity exposes each original revision in expandable details',async t=>{
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
 t.after(async()=>{await act(async()=>root.unmount());host.remove();});
 const event={id:2,event_type:'document_delivery',title:'Brief updated',severity:'info',message:'[Revision two](/documents/d1)',task_id:'t1',source:'praxis',metadata:{},requires_action:0,created_at:'2026-10-13T12:00:00Z'};
 await act(async()=>root.render(React.createElement(EventRow,{event,history:[event,{...event,id:1,message:'[Revision one](/documents/d1)'}],onOpenTask:()=>{}})));
 assert.match(host.textContent,/2 updates/);assert.doesNotMatch(host.textContent,/Revision one/);
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Detail').click());
 assert.match(host.textContent,/Revision one/);assert.match(host.textContent,/Revision two/);
});
