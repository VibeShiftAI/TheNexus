import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomaticStartControl } from '../automatic-start-control.tsx';
const base={taskId:'canva',title:'Canva export',lane:'waiting',taskVersion:7,autoStart:false,waitingOn:[{taskId:'card',title:'Card',lane:'running'}]};
async function mount(item,respond){
 const calls=[];const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init,body:JSON.parse(init?.body||'{}')});return respond(calls.at(-1));};
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);let refreshed=0;
 await act(async()=>root.render(createElement(AutomaticStartControl,{item,onChanged:()=>{refreshed++;}})));
 return {container,calls,get refreshed(){return refreshed;},async click(){await act(async()=>container.querySelector('button').click());},async close(){await act(async()=>root.unmount());container.remove();globalThis.fetch=original;}};
}
const reply=data=>new Response(JSON.stringify(data),{status:200});
test('prepared follow-up only authorized on click; cancel targets exact saved request',async()=>{
 const request={taskId:'canva',state:'waiting',requestedAt:'2026-10-08T23:00:00.000Z',detail:'Waiting on Card'};
 const h=await mount(base,c=>reply({request:c.init.method==='DELETE'?{...request,state:'cancelled'}:request}));
 try{assert.equal(h.calls.length,0);assert.match(h.container.textContent,/Start automatically after predecessors/);
 await h.click();assert.deepEqual(h.calls[0].body,{taskId:'canva',expectedVersion:7});assert.equal(h.calls[0].init.method,'POST');
 assert.match(h.container.textContent,/Cancel automatic start/);await h.click();assert.equal(h.calls[1].init.method,'DELETE');assert.deepEqual(h.calls[1].body,{expectedRequestedAt:request.requestedAt});assert.equal(h.refreshed,2);
 }finally{await h.close();}
});
test('completed prerequisites offer queue now; refusal stays visible with task link',async()=>{
 const h=await mount({...base,waitingOn:[]},()=>new Response(JSON.stringify({error:'Task changed; refresh and review.'}),{status:409}));
 try{assert.match(h.container.textContent,/Queue to start now/);await h.click();assert.match(h.container.textContent,/Task changed/);assert.ok(h.container.querySelector('a[href="/task/canva"]'));assert.doesNotMatch(h.container.textContent,/Cancel automatic start/);}finally{await h.close();}
});
test('uncertain and starting requests offer neither cancel nor duplicate start',async()=>{
 for(const state of ['uncertain','starting']){const h=await mount({...base,automaticStart:{taskId:'canva',state,requestedAt:'2026-10-08T23:00:00Z',detail:'Check task execution before retrying.'}},()=>{throw Error('must not call');});try{assert.equal(h.container.querySelector('button'),null);assert.match(h.container.textContent,/Check task execution/);}finally{await h.close();}}
});


test('new task version zero can be explicitly queued',async()=>{
 const h=await mount({...base,taskVersion:0},()=>reply({request:{taskId:'canva',state:'waiting',requestedAt:'2026-10-08T23:00:00Z'}}));
 try{assert.equal(h.container.querySelector('button').disabled,false);await h.click();assert.equal(h.calls[0].body.expectedVersion,0);}finally{await h.close();}
});


test('unavailable automatic-start service cannot look like an empty healthy queue',async()=>{
 const h=await mount({...base,automaticStartError:'Saved requests could not be read.'},()=>{throw Error('must not call');});
 try{assert.equal(h.container.querySelector('button').disabled,true);assert.match(h.container.textContent,/Saved requests could not be read/);assert.ok(h.container.querySelector('a[href="/system-monitor"]'));}finally{await h.close();}
});


test('shows approved-plan lineage even after predecessors finish, without granting approval',async()=>{
 const h=await mount({...base,waitingOn:[],followsToday:[{taskId:'card',title:'Approved card proof'}]},()=>{throw Error('must not call');});
 try{assert.match(h.container.textContent,/Follows today’s approved work/);assert.match(h.container.textContent,/Approved card proof/);assert.ok(h.container.querySelector('a[href="/task/card"]'));assert.equal(h.calls.length,0);}finally{await h.close();}
});

test('optional improvement rows cannot restart the completed parent task',async()=>{
 const h=await mount({...base,improvement:{id:'r1',status:'waiting',reason:'Approved work runs first'}},()=>{throw Error('must not call');});
 try{assert.equal(h.container.querySelector('button'),null);assert.equal(h.calls.length,0);}finally{await h.close();}
});
