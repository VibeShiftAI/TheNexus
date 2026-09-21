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

// Activity evidence rules (docs/contracts/activity-evidence.md): durable
// lifecycle is preserved separately from fresh activity, unavailable telemetry
// is null plus a reason, feed conflicts are reconciled by freshness and kept,
// and a cached phase never implies a tool sub-phase or provider health.
test('a cached tool phase older than the freshness window shows Running and keeps the durable record separately', () => {
  const v=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,updatedAt:'2026-09-07T12:40:00Z'}]}}});
  const item=v.groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(item.status,'running');
  assert.equal(item.stage,'Running');
  assert.equal(item.evidence.phase.value,null);
  assert.match(item.evidence.phase.reason!,/No phase report in the last 5 min/);
  assert.match(item.evidence.phase.reason!,/Testing/);
  assert.deepEqual({run:item.lifecycle.run,runPhase:item.lifecycle.runPhase,runAt:item.lifecycle.runAt,board:item.lifecycle.board},{run:'active',runPhase:'testing',runAt:'2026-09-07T12:40:00Z',board:'in_progress'});
  assert.equal(item.stale,true);
});
test('the spawn-time thinking default is not phase evidence; a tool report carrying thinking is', () => {
  const spawn={type:'executor.progress',at:'2026-09-07T12:59:40Z',progress:{taskId:'a',executor:'codex',phase:'thinking',at:'2026-09-07T12:59:40Z'}};
  const bare=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,phase:'thinking'}]}},events:[spawn]}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(bare.stage,'Running');
  assert.match(bare.evidence.phase.reason!,/start default/);
  const registryOnly=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,phase:'thinking'}]}}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(registryOnly.stage,'Running');
  assert.match(registryOnly.evidence.phase.reason!,/start default/);
  const evidenced=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,phase:'thinking'}]}},events:[{...spawn,progress:{...spawn.progress,message:'Read src/cards.tsx'}}]}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(evidenced.stage,'Thinking');
  assert.equal(evidenced.evidence.phase.value,'thinking');
  assert.equal(evidenced.evidence.phase.source,'progress report');
  // Praxis lifecycle steps are not tool claims and stay visible as recorded.
  const finishing=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,phase:'completing',updatedAt:'2026-09-07T12:00:00Z'}]}}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(finishing.stage,'Finishing');
});
test('model attribution says where it came from, and a missing value carries a reason instead of a guess', () => {
  const sessions=[{taskId:'a',executor:'codex',model:'gpt-6-astra',status:'open',lastUsedAt:'2026-09-07T12:50:00Z'}];
  const fromRun=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,model:'gpt-6-nova'}],sessions}}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.deepEqual({value:fromRun.evidence.model.value,source:fromRun.evidence.model.source,model:fromRun.model},{value:'gpt-6-nova',source:'run',model:'gpt-6-nova'});
  const fromSession=deriveCurrentFocus({...base,state:{executors:{runs:[run],sessions}}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(fromSession.model,'gpt-6-astra');
  assert.equal(fromSession.evidence.model.source,'saved session');
  assert.match(fromSession.evidence.model.reason!,/proves neither provider health nor a live turn/);
  const missing=deriveCurrentFocus(base).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(missing.model,null);
  assert.match(missing.evidence.model.reason!,/No model reported by the run or by a saved session/);
  const boardOnly=deriveCurrentFocus({...base,state:null}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(boardOnly.status,'unconfirmed');
  assert.match(boardOnly.evidence.phase.reason!,/feed unavailable/);
  assert.match(boardOnly.evidence.model.reason!,/feed unavailable/);
});
test('queue and run claims for one task are reconciled by freshness and the losing claim is kept', () => {
  const queue=[{taskId:'a',executor:'codex',state:'claimed',enqueuedAt:'2026-09-07T12:30:00Z'}];
  const runWins=deriveCurrentFocus({...base,state:{executors:{runs:[run],cliQueue:queue}}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(runWins.status,'running');
  assert.equal(runWins.conflicts.length,1);
  assert.match(runWins.conflicts[0],/queue entry \(claimed\).*showing active run \(codex\) because it is newer/);
  const queueWins=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,updatedAt:'2026-09-07T12:10:00Z'}],cliQueue:queue}}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(queueWins.status,'queued');
  assert.match(queueWins.conflicts[0],/active run \(codex\).*showing queue entry \(claimed\) because it is newer/);
  assert.equal(queueWins.lifecycle.run,'active');
  assert.equal(queueWins.lifecycle.runPhase,'testing');
});
test('a run against a task the board no longer lists as active is reported as a disagreement, and a superseding terminal event is kept as lifecycle', () => {
  const done=deriveCurrentFocus({projects:[{id:'p1',name:'Meeple Magnate',tasks:[{id:'a',name:'Improve cards',status:'completed'}]}],state:{executors:{runs:[run]}},now}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(done.status,'running');
  assert.match(done.conflicts[0],/Board status is completed while a run is active/);
  const ended=deriveCurrentFocus({...base,events:[{type:'task.failed',taskId:'a',at:'2026-09-07T12:59:30Z'}]}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(ended.status,'unconfirmed');
  assert.deepEqual({run:ended.lifecycle.run,runAt:ended.lifecycle.runAt},{run:'failed',runAt:'2026-09-07T12:59:30Z'});
  assert.equal(ended.conflicts.length,0);
});
test('an open question and a newer run coexist: the run shows, the request stays linked, and no disagreement is claimed', () => {
  const v=deriveCurrentFocus({...base,requests:[{id:'ask',taskId:'a',question:'Which style?',requestedAt:'2026-09-07T12:30:00Z'}]});
  const item=v.groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(item.status,'running');
  assert.equal(item.approvalId,'ask');
  assert.deepEqual(item.conflicts,[]);
  // QA finding 2026-09-20: a question newer than the run must not replace
  // run evidence with "no run reported"; ask_robert proceeds without
  // suspending the run and the request carries no blocking flag.
  const newerAsk=deriveCurrentFocus({...base,state:{executors:{runs:[{...run,model:'gpt-6-nova'}]}},requests:[{id:'ask',taskId:'a',question:'Which style?',requestedAt:'2026-09-07T12:59:30Z'}]}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(newerAsk.status,'running');
  assert.equal(newerAsk.approvalId,'ask');
  assert.equal(newerAsk.model,'gpt-6-nova');
  assert.equal(newerAsk.evidence.phase.value,'testing');
  assert.equal(newerAsk.lifecycle.run,'active');
  assert.deepEqual(newerAsk.conflicts,[]);
  // With no run at all, the question row says only what the feed supports.
  const alone=deriveCurrentFocus({...base,state:{executors:{runs:[]}},requests:[{id:'ask',taskId:'b',question:'Which style?',requestedAt:'2026-09-07T12:30:00Z'}]}).groups[0].items.find(x=>x.taskId==='b')!;
  assert.equal(alone.status,'awaiting_input');
  assert.match(alone.evidence.phase.reason!,/No active run is reported for this task while this question is open/);
  const feedDown=deriveCurrentFocus({...base,state:null,requests:[{id:'ask',taskId:'b',question:'Which style?',requestedAt:'2026-09-07T12:30:00Z'}]}).groups[0].items.find(x=>x.taskId==='b')!;
  assert.match(feedDown.evidence.phase.reason!,/feed unavailable/);
  assert.match(feedDown.evidence.model.reason!,/feed unavailable/);
});
test('a feed that stopped refreshing withholds live sub-phase claims from its frozen snapshot and keeps the record', () => {
  const feed={available:false,snapshotAt:'2026-09-07T12:59:10Z'};
  const fresh=deriveCurrentFocus({...base,feed}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(fresh.status,'running');
  assert.equal(fresh.stage,'Running');
  assert.equal(fresh.evidence.phase.value,null);
  assert.match(fresh.evidence.phase.reason!,/Run feed has not refreshed since 12:59 UTC/);
  assert.equal(fresh.stale,false,'a snapshot inside the window is old news, not yet stale');
  assert.equal(fresh.lifecycle.runPhase,'testing');
  const old=deriveCurrentFocus({...base,feed:{available:false,snapshotAt:'2026-09-07T12:50:00Z'}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(old.stale,true);
  const queued=deriveCurrentFocus({...base,state:{executors:{runs:[],cliQueue:[{taskId:'c',executor:'codex',enqueuedAt:'2026-09-07T12:00:00Z'}]}},feed}).groups.flatMap(g=>g.items).find(x=>x.taskId==='c')!;
  assert.match(queued.evidence.phase.reason!,/has not refreshed since/);
  const healthy=deriveCurrentFocus({...base,feed:{available:true,snapshotAt:'2026-09-07T12:59:50Z'}}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(healthy.stage,'Testing');
});

test('an open question cannot change execution reconciliation against newer holds', () => {
  const oldRun={...run,startedAt:'2026-09-07T12:40:00Z',updatedAt:'2026-09-07T12:50:00Z'};
  const requests=[{id:'ask',taskId:'a',question:'Which style?',requestedAt:'2026-09-07T12:59:00Z'}];
  const scenarios=[
    {...base,state:{executors:{runs:[oldRun],cliQueue:[{taskId:'a',state:'reconciliation_required',enqueuedAt:'2026-09-07T12:55:00Z'}]}}},
    {...base,state:{executors:{runs:[oldRun],cliQueue:[{taskId:'a',state:'queued',enqueuedAt:'2026-09-07T12:55:00Z'}]}}},
    {...base,state:{executors:{runs:[oldRun],usageWaits:{available:true,items:[{taskId:'a',kind:'session_recovery',requiresAction:true,limitedAt:'2026-09-07T12:55:00Z',resumeAt:'2026-09-07T14:00:00Z'}]}}}},
    {...base,projects:[{id:'p1',name:'Project',tasks:[{id:'a',status:'blocked',updated_at:'2026-09-07T12:55:00Z'}]}],state:{executors:{runs:[oldRun]}}},
  ];
  for(const scenario of scenarios) {
    const without=deriveCurrentFocus(scenario).groups[0].items.find(x=>x.taskId==='a')!;
    const withQuestion=deriveCurrentFocus({...scenario,requests}).groups[0].items.find(x=>x.taskId==='a')!;
    assert.deepEqual(withQuestion,{...without,approvalId:'ask'});
    assert.ok(withQuestion.conflicts.every(c=>!c.includes('showing open input request')));
  }
});

test('fresh independent progress survives a dispatch snapshot outage and ages on its own clock', () => {
  const at='2026-09-07T12:59:50Z';
  const input={...base,state:{executors:{runs:[{...run,startedAt:'2026-09-07T12:40:00Z',updatedAt:'2026-09-07T12:50:00Z'}]}},feed:{available:false,snapshotAt:'2026-09-07T12:50:00Z'},events:[{type:'executor.progress',at,progress:{taskId:'a',executor:'codex',phase:'testing',at}}]};
  const fresh=deriveCurrentFocus(input).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(fresh.evidence.phase.value,'testing');
  assert.equal(fresh.evidence.phase.source,'progress report');
  assert.equal(fresh.evidence.phase.reason,null);
  assert.equal(fresh.stale,false);
  assert.equal(fresh.lifecycle.runAt,'2026-09-07T12:50:00Z');
  const old=deriveCurrentFocus({...input,now:now+6*60_000}).groups[0].items.find(x=>x.taskId==='a')!;
  assert.equal(old.evidence.phase.value,null);
  assert.match(old.evidence.phase.reason!,/No phase report in the last 5 min/);
  assert.doesNotMatch(old.evidence.phase.reason!,/frozen snapshot/);
  assert.equal(old.stale,true);
});

test('all reconciled conflicts describe the final execution claim when multiple feeds coexist', () => {
  const item=deriveCurrentFocus({...base,
    projects:[{id:'p1',name:'Project',tasks:[{id:'a',status:'blocked',updated_at:'2026-09-07T12:40:00Z'}]}],
    state:{executors:{runs:[run],cliQueue:[{taskId:'a',state:'reconciliation_required',enqueuedAt:'2026-09-07T12:55:00Z'}]}},
    requests:[{id:'ask',taskId:'a',question:'Style?',requestedAt:'2026-09-07T12:59:30Z'}],
  }).groups[0].items[0];
  assert.equal(item.status,'running');
  assert.equal(item.approvalId,'ask');
  assert.equal(item.conflicts.length,2);
  for(const conflict of item.conflicts) assert.match(conflict,/showing active run \(codex\) because it is newer/);
});
