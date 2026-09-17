import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { KnowledgeCommunity } from '../bridge/knowledge-community.tsx';
import { ActiveRow } from '../bridge/taskboard-station.tsx';
import { useArrivalPulse } from '../../hooks/use-arrival-pulse.ts';
import { RunRow } from '../bridge/executor-detail.tsx';

async function mounted(Component, props, check) {
 const container=document.createElement('div'); document.body.append(container); const root=createRoot(container);
 try { await act(async()=>root.render(createElement(Component,props))); await check(container,async next=>act(async()=>root.render(createElement(Component,next)))); }
 finally { await act(async()=>root.unmount()); container.remove(); }
}

test('community inspection can follow a bridge and open an encoded entity report', async()=>{
 const topic={id:1,title:'Knowledge',size:42,top_entities:['Graph & memory']};
 const other={id:2,title:'Reasoning',size:20,top_entities:['Planning']}; let selected;
 await mounted(KnowledgeCommunity,{topic,data:{nodes:[topic,other],links:[{source:1,target:2,weight:4}]},onSelect:value=>selected=value}, async container=>{
  assert.ok(container.querySelector('a[href="/knowledge-ingestion?term=Graph%20%26%20memory#knowledge-explorer"]'));
  await act(async()=>container.querySelector('button').click()); assert.equal(selected.id,2);
 });
});

test('a board status alone never animates execution; a live QA run points to its report', async()=>{
 const task={id:'t',title:'Work',status:'in_progress'};
 await mounted(ActiveRow,{task},async (container,rerender)=>{
  assert.equal(container.querySelector('a').dataset.working,'false'); assert.match(container.textContent,/No live run/);
  await rerender({task,activity:{channel:'qa',phase:'testing',href:'/task/t#qa-reviews'}});
  assert.equal(container.querySelector('a').dataset.working,'true');
  assert.equal(container.querySelector('a').getAttribute('href'),'/task/t#qa-reviews'); assert.match(container.textContent,/QA/);
 });
});

test('existing history stays quiet and only newly arriving identifiers pulse', async()=>{
 function Probe({ids,ready}) { const arrivals=useArrivalPulse(ids,ready); return createElement('span',null,[...arrivals].join(',')); }
 await mounted(Probe,{ids:[],ready:false},async (container,rerender)=>{
  await rerender({ids:['old'],ready:true}); assert.equal(container.textContent,'');
  await rerender({ids:['new','old'],ready:true}); assert.equal(container.textContent,'new');
 });
});

test('executor detail points a QA shadow run to the original task evidence', async()=>{
 await mounted(RunRow,{run:{taskId:'qa--original',kind:'qa',status:'completed',title:'Review',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}},container=>{
  assert.equal(container.querySelector('a').getAttribute('href'),'/task/original#qa-reviews');
 });
});
