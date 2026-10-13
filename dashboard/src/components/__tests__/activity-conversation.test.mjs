import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EventRow } from '../activity-feed.tsx';
import { readChatDraft, writeChatDraft, clearChatDraft } from '../../lib/chat-draft.ts';

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
