import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCurrentFocus } from '../current-focus';

const now = Date.parse('2026-09-07T13:00:00Z');
const projects = [{id:'p1',name:'Meeple Magnate',tasks:[{id:'a',name:'Improve cards',description:'Make cards easier to read.',status:'in_progress'},{id:'b',name:'Other work',status:'in_progress'}]}, {id:'p2',name:'Gay I Club',tasks:[{id:'c',name:'Review launch',status:'todo'}]}];
const run = {taskId:'a',title:'Improve cards',executor:'codex',kind:'task',phase:'testing',status:'active',startedAt:'2026-09-07T12:55:00Z',updatedAt:'2026-09-07T12:59:00Z'};
const base = {projects, state:{executors:{runs:[run],cliQueue:[],sessions:[],usageWaits:{available:true,items:[]}}}, requests:[], events:[], now};

test('groups by actual project and never treats a board label as execution', () => {
  const v = deriveCurrentFocus(base);
  assert.equal(v.running,1);
  assert.equal(v.groups[0].name,'Meeple Magnate');
  assert.equal(v.groups[0].items.find(x=>x.taskId==='b')?.status,'unconfirmed');
  assert.equal(v.groups[0].items.find(x=>x.taskId==='a')?.stage,'Testing');
  assert.equal(v.groups[0].items[0].model,null);
});
test('combines live task progress with exact task/executor session identity', () => {
  const v = deriveCurrentFocus({...base, state:{executors:{...base.state.executors,sessions:[{taskId:'a',executor:'claude-code',model:'wrong',status:'open'},{taskId:'a',executor:'codex',model:'gpt-6-astra',status:'open'}]}},events:[{type:'executor.progress',at:'2026-09-07T12:59:30Z',progress:{taskId:'a',executor:'codex',phase:'testing',message:'Checking the card layout',at:'2026-09-07T12:59:30Z'}}]});
  const item=v.groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(item.model,'gpt-6-astra');
  assert.equal(item.action,'Checking the card layout');
});
test('quota, queued and human-input waits remain visible and deduplicate by task', () => {
  const v=deriveCurrentFocus({...base,state:{executors:{runs:[],cliQueue:[{taskId:'c',executor:'codex',enqueuedAt:'2026-09-07T12:00:00Z'}],usageWaits:{available:true,items:[{taskId:'a',kind:'usage_limit',executor:'codex',model:'gpt-6-astra',resumeAt:'2026-09-08T12:00:00Z',limitedAt:'2026-09-07T12:59:00Z',requiresAction:false}]}}},requests:[{id:'ask',taskId:'b',question:'Which style?',requestedAt:'2026-09-07T12:30:00Z'}]});
  const items=v.groups.flatMap(g=>g.items);
  assert.equal(items.length,3);
  assert.equal(v.running,0);
  assert.equal(items.find(x=>x.taskId==='a')?.status,'quota');
  assert.equal(items.find(x=>x.taskId==='b')?.approvalId,'ask');
  assert.equal(items.find(x=>x.taskId==='c')?.status,'queued');
});
test('a recovery hold is not called a provider reset and stale actions do not imply freshness', () => {
  const v=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,updatedAt:'2026-09-07T12:00:00Z'}],usageWaits:{available:true,items:[{taskId:'c',kind:'session_recovery',requiresAction:true,resumeAt:'2026-09-07T12:00:00Z'}]}}}});
  assert.equal(v.groups.flatMap(g=>g.items).find(x=>x.taskId==='c')?.status,'blocked');
  assert.equal(v.groups[0].items.find(x=>x.taskId==='a')?.stale,true);
});
test('newer terminal events remove stale running signals and unknown tasks stay unattributed', () => {
  const v=deriveCurrentFocus({...base,state:{executors:{runs:[run,{...run,taskId:'unknown'}]}},events:[{type:'task.completed',taskId:'a',at:'2026-09-07T12:59:30Z'}]});
  assert.equal(v.running,1);
  assert.ok(v.groups.find(g=>g.name==='Project not reported')?.items.find(x=>x.taskId==='unknown'));
});
test('QA runtime ids link to the reviewed board task while preserving exact runtime telemetry matching', () => {
  const v=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,taskId:'qa--a',kind:'qa'}],sessions:[{taskId:'qa--a',executor:'codex',model:'gpt-6-astra',status:'open'}]}},events:[{type:'executor.progress',at:'2026-09-07T12:59:30Z',progress:{taskId:'qa--a',executor:'codex',phase:'thinking',message:'Reviewing card accessibility',at:'2026-09-07T12:59:30Z'}}]});
  assert.equal(v.groups.length,1);
  const item=v.groups[0].items.find(x=>x.status==='running')!;
  assert.equal(item.projectId,'p1');assert.equal(item.taskId,'a');assert.equal(item.model,'gpt-6-astra');assert.equal(item.action,'Reviewing card accessibility');
  assert.equal(v.groups[0].items.length,2);
});
test('canonical board work stages and queued local jobs remain visible without claiming execution', () => {
  const v=deriveCurrentFocus({projects:[{id:'p',name:'Project',tasks:['scheduled','dispatched','ready_for_review'].map((status,id)=>({id:String(id),name:status,status}))}],state:{localLlm:{jobs:[{id:'local',type:'Embedding batch',status:'queued'}]}},now});
  assert.equal(v.running,0);assert.equal(v.unconfirmed,3);assert.equal(v.waiting,1);
  assert.equal(v.groups.find(x=>x.name==='Background activity')?.items[0].status,'queued');
});
test('enabled cron schedules are not counted as executing work',()=>{
  const v=deriveCurrentFocus({projects:[],state:{cron:[{key:'nightly',label:'Nightly evaluation',running:true,lastRun:null}]},now});
  assert.equal(v.running,0);assert.equal(v.groups.length,0);
});
