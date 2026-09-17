import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DispatchMap } from '../bridge/dispatch-map.tsx';
import { deriveCliLane } from '../../lib/cli-lane.ts';
import { deriveChatActivity } from '../../lib/chat-activity.ts';

const view = deriveCliLane({executors: {cliQueue: [], cliConcurrency: {
  limit: 3, active: 1, free: 2, queued: 0, burst: true, reason: 'burst: healthy',
}}});
const base = {view, available: true, activeItems: [], recentItems: [], council: null,
  councilAvailable: true, memory: {availPct: 52, availBytes: 32 * 1024 ** 3, totalBytes: 64 * 1024 ** 3},
  local: {running: 0, queued: 0, paused: false}, onInspect() {}};

async function mounted(props, check) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try { await act(async () => root.render(createElement(DispatchMap, {...base, ...props}))); await check(container); }
  finally { await act(async () => root.unmount()); container.remove(); }
}

test('dispatch map represents execution and council roles together without fake progress', async () => {
  let inspected;
  await mounted({
    onInspect: id => inspected = id,
    activeItems: [{id: 'r', executor: 'codex', phase: 'writing', channel: 'working', status: 'active', title: 'Build the cockpit'}],
    council: {phase: 'deliberation', topic: 'Next improvements', voices: [{name: 'cli:codex', status: 'running'}]},
  }, async container => {
    const pod = container.querySelector('[data-provider="codex"]');
    assert.match(pod.textContent, /writing/);
    assert.match(pod.textContent, /deliberating/);
    assert.equal(pod.querySelector('[role="progressbar"]'), null);
    await act(async () => pod.querySelector('button').click());
    assert.equal(inspected, 'codex');
    assert.ok(container.querySelector('a[href="/council"]'));
    assert.match(container.textContent, /52%/);
  });
});

test('central capacity instrument opens the existing full gate report and restores focus', async () => {
  await mounted({}, async container => {
    const button = container.querySelector('button[aria-label^="Inspect executor capacity"]');
    button.focus(); await act(async () => button.click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /burst: healthy/);
    assert.ok(dialog.querySelector('a[href="/ops"]'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, button);
  });
});

test('unavailable telemetry never animates cached executor activity', async () => {
  await mounted({available: false, activeItems: [{executor:'codex', channel:'working', status:'active'}]}, container => {
    assert.equal(container.querySelector('[data-provider="codex"]').getAttribute('data-active'), 'false');
    assert.match(container.textContent, /Signal delayed/);
  });
});

test('all reported lanes and each configured council seat survive roster expansion', async () => {
  const expandedView = {...view, executors: [...view.executors, {name:'future-worker',label:'Future worker',runs:[],slots:2,free:2,suspended:false}]};
  await mounted({view: expandedView, bench: {references:[{id:'api/a',label:'API A'},{id:'api/b',label:'API B'},{id:'api/c',label:'API C'}],aggregator:{id:'cli:codex',label:'Codex'}}}, container => {
    assert.ok(container.querySelector('[data-provider="future-worker"]'));
    const seats = container.querySelector('[aria-label="Council seats"]');
    for (const label of ['API A','API B','API C','Codex']) assert.ok(seats.textContent.includes(label));
    assert.equal(seats.querySelectorAll('a').length, 4);
  });
});

test('second-round council voices update the original seat and QA completion keeps review color', async () => {
  await mounted({recentItems:[{executor:'codex',channel:'qa',status:'recorded'}],council:{phase:'deliberation',voices:[
    {name:'cli:codex/gpt-test',model:'cli:codex/gpt-test',status:'success'},
    {name:'cli:codex/gpt-test (round 2)',model:'cli:codex/gpt-test',status:'running'},
  ]}}, container => {
    const seats=container.querySelector('[aria-label="Council seats"]');
    assert.equal(seats.querySelectorAll('a').length,1);
    assert.equal(seats.querySelector('a').dataset.status,'running');
    assert.equal(container.querySelector('[data-provider="codex"]').style.getPropertyValue('--module-color'),'#a78bfa');
    assert.match(container.querySelector('[data-provider="codex"]').textContent,/Review recorded/);
  });
});

test('chat center has its own activity and opens the message receipt, independent of busy executors',async()=>{
 const now=Date.now();const idle=deriveChatActivity({now,conversationId:'chat',local:null,snapshot:{at:new Date(now).toISOString(),turns:[]}});
 await mounted({chat:idle,activeItems:[{executor:'codex',phase:'writing',channel:'working',status:'active'}]},container=>{
   assert.equal(container.querySelector('.dispatch-chat-core').dataset.active,'false');
   assert.equal(container.querySelector('[data-provider="codex"]').dataset.active,'true');
 });
 const chat=deriveChatActivity({now,conversationId:'chat',local:null,snapshot:{at:new Date(now).toISOString(),turns:[{id:'message',conversationId:'chat',phase:'received',preview:'Did you get this?',receivedAt:new Date(now-1000).toISOString(),updatedAt:new Date(now).toISOString()}]}});
 await mounted({chat},async container=>{
   const center=container.querySelector('.dispatch-chat-core');assert.equal(center.dataset.phase,'received');
   await act(async()=>center.click());
   const dialog=document.querySelector('[role="dialog"]');assert.match(dialog.textContent,/Did you get this\?/);assert.ok(dialog.querySelector('a[href="/#station-core"]'));
   assert.ok(container.querySelector('button[aria-label^="Inspect executor capacity"]'),'capacity remains separately clickable');
 });
});

test('quiet and queued map states reserve identical tracks and keep council captions mounted',async()=>{
 await mounted({},container=>{
   assert.equal(container.querySelector('.dispatch-map').style.gridTemplateRows,'100px repeat(2, 108px) 36px 58px');
   assert.ok(container.querySelector('[aria-label="Dispatch queue"]'));
   assert.equal(container.querySelectorAll('.dispatch-seat').length,view.executors.length);
 });
});


test('active providers and council seats show actual models, including multiple Claude models', async () => {
  await mounted({activeItems: [{executor:'claude-code',model:'claude-fable-5-1',phase:'writing',status:'active'}],
    council:{phase:'deliberation',voices:[{name:'cli:claude-code/claude-opus-5',model:'cli:claude-code/claude-opus-5',status:'running'}]},
  }, container => {
    assert.equal(container.querySelector('[data-provider="claude-code"] .dispatch-provider-label').textContent, 'Fable 5.1 · Opus 5');
    assert.equal(container.querySelector('.dispatch-voice span:last-child').textContent, 'Opus 5');
  });
});
