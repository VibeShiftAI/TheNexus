import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {HitlCard} from '../hitl-card.tsx';
test('QA slate uses normal task controls and sends overrides instead of raw review prose',async()=>{
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const calls=[];
 const request={id:'qa-card',reason:'explicit_request',question:'RAW REVIEW SHOULD NOT RENDER',requestedAt:new Date().toISOString(),options:['approve','reject'],metadata:{kind:'qa-followup-slate',presentationVersion:2,date:'2026-10-21',nightlySummary:'Two recommended tasks.',slots:[1,2].map(n=>({slotNumber:n,nexusTaskId:`f${n}`,parentTaskId:`p${n}`,title:`Fix issue ${n}`,executor:'codex',workspace:'/project',objective:'Validation succeeds',instructions:'Handle the missing case',startTime:'',estimatedMinutes:0}))}};
 try{
 await act(async()=>root.render(React.createElement(HitlCard,{request,resolving:false,onResolve:async(...a)=>calls.push(a)})));
 assert.match(container.textContent,/QA follow-up slate/);assert.doesNotMatch(container.textContent,/RAW REVIEW|Morning Plan|Invalid Date/);
 assert.ok(container.querySelectorAll('select').length>=2);
 const expand=[...container.querySelectorAll('button')].find(b=>b.textContent.includes('Fix issue 1'));await act(async()=>expand.click());assert.match(container.textContent,/Handle the missing case/);
 const worker=container.querySelector('select');await act(async()=>{worker.value='claude-code';worker.dispatchEvent(new window.Event('change',{bubbles:true}))});
 const approve=[...container.querySelectorAll('button')].find(b=>b.textContent.includes('Approve slate'));assert.ok(approve);await act(async()=>approve.click());
 assert.equal(calls[0][1].payload.scheduleOverrides.executors.f1,'claude-code');
 }finally{await act(async()=>root.unmount());container.remove()}
});
