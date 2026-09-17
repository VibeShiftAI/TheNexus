import test from 'node:test';
import assert from 'node:assert/strict';
import React, {act, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {AutonomyControl, useAutonomyControl} from '../autonomy-control.tsx';
const running={paused:false,flag:null,inFlight:[]};
const paused={paused:true,flag:{paused:true,since:'2026-09-07T12:00:00Z',requestedBy:'Robert',reason:'ops_console'},inFlight:[{taskId:'task-1',title:'Finish report',executor:'codex'}]};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
async function mount(handler){
 const original=globalThis.fetch;globalThis.fetch=handler;
 const node=document.createElement('div');document.body.append(node);const root=createRoot(node);const messages=[];
 const onMessage=message=>messages.push(message);let control;
 function Harness(){control=useAutonomyControl(onMessage);useEffect(()=>{void control.refresh();},[control.refresh]);return React.createElement(AutonomyControl,control);}
 await act(async()=>root.render(React.createElement(Harness)));
 return {node,messages,refresh:()=>control.refresh(),dispose:async()=>{await act(async()=>root.unmount());node.remove();globalThis.fetch=original;}};
}
test('one-click pause and resume verify state, attribution and surviving runs',async()=>{
 let current=running;const requests=[];
 const h=await mount(async(url,options={})=>{requests.push([url,options]);if(options.method==='POST'){current=url.endsWith('/pause')?paused:running;return json({ok:true});}return json(current);});
 try{
 assert.match(h.node.textContent,/RUNNING/);await act(async()=>h.node.querySelector('button').click());
 for(const pattern of [/PAUSED/,/Robert/,/ops_console/,/2026/,/1 run still finishing/,/Pausing does not kill in-flight runs/,/Finish report/])assert.match(h.node.textContent,pattern);
 assert.deepEqual(JSON.parse(requests.find(([url])=>url.endsWith('/pause'))[1].body),{by:'Robert',reason:'ops_console'});
 await act(async()=>h.node.querySelector('button').click());assert.match(h.node.textContent,/RUNNING/);
 assert.deepEqual(JSON.parse(requests.find(([url])=>url.endsWith('/resume'))[1].body),{by:'Robert'});
 assert.equal(requests.filter(([,opts])=>opts.method!=='POST').length,3);
 }finally{await h.dispose();}
});
test('rejected POST reports failure without claiming rejected state',async()=>{
 const h=await mount(async(_url,opts={})=>opts.method==='POST'?json({error:'write failed'},500):json(running));
 try{await act(async()=>h.node.querySelector('button').click());assert.match(h.node.textContent,/RUNNING/);assert.doesNotMatch(h.node.textContent,/PAUSED/);assert.match(h.messages.at(-1),/write failed/);}finally{await h.dispose();}
});
test('unreachable or invalid state is UNKNOWN and disables action',async()=>{
 for(const value of [null,{paused:'false',inFlight:[]},{...paused,inFlight:[{taskId:'bad-run',executor:'codex',title:{bad:true}}]}]){
 const h=await mount(async()=>{if(value===null)throw new Error('offline');return json(value);});
 try{assert.match(h.node.textContent,/UNKNOWN/);assert.equal(h.node.querySelector('button').disabled,true);assert.match(h.node.textContent,/unavailable|Invalid/i);}finally{await h.dispose();}
 }
});
test('accepted action with failed verification displays UNKNOWN',async()=>{
 let changed=false;const h=await mount(async(_url,opts={})=>{if(opts.method==='POST'){changed=true;return json({ok:true});}if(changed)throw new Error('offline');return json(running);});
 try{await act(async()=>h.node.querySelector('button').click());assert.match(h.node.textContent,/UNKNOWN/);assert.match(h.messages.at(-1),/accepted.*could not verify/i);}finally{await h.dispose();}
});
test('a refresh requested before pause cannot overwrite the confirmed pause',async()=>{
 let count=0;let resolveStale;let active=running;
 const h=await mount(async(_url,opts={})=>{
  if(opts.method==='POST'){active=paused;return json({ok:true});}
  count++;if(count===2)return new Promise(resolve=>{resolveStale=resolve;});
  return json(active);
 });
 try{
  let pending;await act(async()=>{pending=h.refresh();});
  await act(async()=>h.node.querySelector('button').click());assert.match(h.node.textContent,/PAUSED/);
  await act(async()=>{resolveStale(json(running));await pending;});assert.match(h.node.textContent,/PAUSED/);
 }finally{await h.dispose();}
});
test('offline POST is visible and disables control until state can be verified',async()=>{
 let offline=false;const h=await mount(async(_url,opts={})=>{if(opts.method==='POST')offline=true;if(offline)throw new Error('Praxis unreachable');return json(running);});
 try{await act(async()=>h.node.querySelector('button').click());assert.match(h.messages.at(-1),/pause failed: Praxis unreachable/);assert.match(h.node.textContent,/UNKNOWN/);assert.equal(h.node.querySelector('button').disabled,true);}finally{await h.dispose();}
});
