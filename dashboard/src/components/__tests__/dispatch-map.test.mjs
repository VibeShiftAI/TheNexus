import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DispatchMap } from '../bridge/dispatch-map.tsx';
import { deriveCliLane, formatDuration } from '../../lib/cli-lane.ts';
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
    // The provider no longer wears one phase word: its run is a child node that
    // names the task and carries the live phase.
    const run = pod.querySelector('[data-run]');
    assert.match(run.textContent, /Build the cockpit/);
    assert.equal(run.querySelector('.dispatch-run-phase').textContent, 'writing');
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
   // The row tracks used to be an inline style sized for fixed pods. A provider
   // now grows with its run list, so the tracks live in globals.css and the map
   // carries no inline track sizes; a quiet map has no run nodes at all.
   assert.equal(container.querySelector('.dispatch-map').style.gridTemplateRows,'');
   assert.equal(container.querySelectorAll('.dispatch-column').length,2);
   assert.equal(container.querySelectorAll('[data-run]').length,0);
   assert.equal(container.querySelector('.dispatch-map').dataset.runs,'0');
   assert.ok(container.querySelector('[aria-label="Dispatch queue"]'));
   assert.equal(container.querySelectorAll('.dispatch-seat').length,view.executors.length);
 });
});


test('active providers and council seats show actual models, including multiple Claude models', async () => {
  await mounted({activeItems: [{executor:'claude-code',model:'claude-fable-5-1',phase:'writing',status:'active'}],
    council:{phase:'deliberation',voices:[{name:'cli:claude-code/claude-opus-5',model:'cli:claude-code/claude-opus-5',status:'running'}]},
  }, container => {
    // The provider label is the provider's name again; each model is on the run
    // node it belongs to (before, the label joined them: "Fable 5.1 · Opus 5").
    const pod = container.querySelector('[data-provider="claude-code"]');
    assert.equal(pod.querySelector('.dispatch-provider-label').textContent, 'Claude Code');
    assert.deepEqual([...pod.querySelectorAll('.dispatch-run')].map(r => [r.dataset.role, r.querySelector('.dispatch-run-model').textContent]),
      [['building', 'Fable 5.1'], ['council', 'Opus 5']]);
    assert.equal(container.querySelector('.dispatch-voice span:last-child').textContent, 'Opus 5');
  });
});

// One child node per live run (task 56c15b54).
const NOW = Date.parse('2026-11-23T14:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();
const laneView = runs => deriveCliLane({executors: {runs: runs.map(r => ({status: 'active', ...r})), cliQueue: [],
  cliConcurrency: {limit: 6, active: runs.length, free: Math.max(0, 6 - runs.length), queued: 0, burst: true, reason: 'burst: healthy'}}}, NOW);

test('several runs on one provider each get a child node with task, model, role and elapsed time, and each opens the drill-down', async () => {
  const opened = [];
  await mounted({now: NOW, onInspect: id => opened.push(id), view: laneView([
    {taskId: 'a', executor: 'claude-code', title: 'Expand the Ops graphic', kind: 'task', startedAt: ago(754_000), requestedModel: 'claude-fable-5-1', requestedEffort: 'high', slotNumber: 2},
    {taskId: 'b', executor: 'claude-code', title: 'Repair the intake form', kind: 'task', startedAt: ago(61_000), servedModel: 'claude-opus-5'},
    {taskId: 'qa--c', executor: 'claude-code', title: 'Review: document decisions', kind: 'qa', startedAt: ago(9_000)},
    {taskId: 'd', executor: 'codex', title: 'Token usage scan', kind: 'task', startedAt: ago(3_000), model: 'gpt-5.5'},
  ])}, async container => {
    const pod = container.querySelector('[data-provider="claude-code"]');
    assert.equal(pod.dataset.expanded, 'true');
    assert.match(pod.querySelector('.dispatch-phase').textContent, /2 building · 1 reviewing/);
    const rows = [...pod.querySelectorAll('.dispatch-run')].map(r => ({
      key: r.dataset.run, role: r.querySelector('.dispatch-run-role').textContent, title: r.querySelector('.dispatch-run-title').textContent,
      model: r.querySelector('.dispatch-run-model').textContent, elapsed: r.querySelector('.dispatch-run-elapsed').textContent,
      slot: r.querySelector('.dispatch-run-slot')?.textContent ?? null, effort: r.querySelector('.dispatch-run-effort')?.textContent ?? null,
    }));
    assert.deepEqual(rows, [
      {key: 'a', role: 'building', title: 'Expand the Ops graphic', model: 'Fable 5.1', elapsed: formatDuration(754_000), slot: 'S2', effort: 'high'},
      {key: 'b', role: 'building', title: 'Repair the intake form', model: 'Opus 5', elapsed: formatDuration(61_000), slot: null, effort: null},
      {key: 'qa--c', role: 'reviewing', title: 'Review: document decisions', model: 'unknown', elapsed: formatDuration(9_000), slot: null, effort: null},
    ]);
    assert.equal(pod.querySelector('[data-run="qa--c"] .dispatch-run-model').dataset.known, 'false');
    assert.equal(container.querySelectorAll('[data-provider="codex"] .dispatch-run').length, 1);
    assert.equal(container.querySelector('.dispatch-map').dataset.runs, '4');
    for (const run of pod.querySelectorAll('.dispatch-run')) await act(async () => run.click());
    await act(async () => container.querySelector('[data-provider="codex"] .dispatch-run').click());
    assert.deepEqual(opened, ['claude-code', 'claude-code', 'claude-code', 'codex']);
  });
});

test('a run with a slot shows S<number>; a run without one renders no tag and no placeholder', async () => {
  await mounted({now: NOW, view: laneView([
    {taskId: 'a', executor: 'codex', title: 'Tagged run', kind: 'task', startedAt: ago(5_000), slotNumber: 7},
    {taskId: 'b', executor: 'codex', title: 'Untagged run', kind: 'task', startedAt: ago(4_000)},
  ])}, container => {
    const [withSlot, without] = container.querySelectorAll('[data-provider="codex"] .dispatch-run');
    assert.equal(withSlot.querySelector('.dispatch-run-slot').textContent, 'S7');
    assert.equal(without.querySelector('.dispatch-run-slot'), null);
    // Nothing stands in for the missing tag: the head holds the title alone.
    assert.equal(without.querySelector('.dispatch-run-head').children.length, 1);
    assert.equal(without.querySelector('.dispatch-run-head').textContent, 'Untagged run');
    assert.doesNotMatch(without.getAttribute('aria-label'), /slot/i);
    assert.match(withSlot.getAttribute('aria-label'), /^Slot 7; Tagged run; building on Codex/);
  });
});

test('more runs than fit one row: every run is present with its own title and wire, nothing merged or counted away', async () => {
  const runs = Array.from({length: 23}, (_, i) => ({taskId: `t${i}`, executor: i % 3 === 0 ? 'codex' : 'claude-code',
    title: `Concurrent task number ${i}`, kind: i % 4 === 0 ? 'qa' : 'task', startedAt: ago((30 - i) * 1000), requestedModel: 'claude-fable-5-1'}));
  await mounted({now: NOW, view: laneView(runs)}, container => {
    const shown = [...container.querySelectorAll('.dispatch-run')];
    assert.equal(shown.length, 23);
    assert.deepEqual(shown.map(r => r.dataset.run).sort(), runs.map(r => r.taskId).sort());
    for (const r of runs) assert.equal(container.querySelector(`[data-run="${r.taskId}"] .dispatch-run-title`).textContent, r.title);
    assert.doesNotMatch(container.querySelector('[data-provider="claude-code"]').textContent, /\+\d+ more|and \d+ more/);
    assert.equal(container.querySelectorAll('path[data-wire="run"]').length, 23);
    assert.equal(container.querySelectorAll('path[data-wire="run-flow"].module-flow').length, 23);
  });
});

test('work flows on the wires of busy providers only; an idle provider collapses to no run list', async () => {
  await mounted({now: NOW, view: laneView([{taskId: 'a', executor: 'codex', title: 'Only run', kind: 'task', startedAt: ago(2_000)}])}, container => {
    const flowing = [...container.querySelectorAll('path[data-wire="spoke-flow"].module-flow')].map(p => p.parentElement.dataset.wires);
    assert.deepEqual(flowing, ['codex']);
    const idle = container.querySelector('[data-provider="claude-code"]');
    assert.equal(idle.dataset.expanded, 'false');
    assert.equal(idle.querySelector('.dispatch-runs'), null);
    assert.match(idle.textContent, /Standing by/);
    assert.equal(container.querySelectorAll('[data-wires="claude-code"] path[data-wire="run"]').length, 0);
  });
});

test('the four named vendors draw their logo file; OpenRouter and an unknown worker keep a glyph', async () => {
  const extra = laneView([]);
  const withFuture = {...extra, executors: [...extra.executors, {name: 'openrouter', label: 'OpenRouter', runs: [], slots: 1, free: 1, suspended: false},
    {name: 'future-worker', label: 'Future worker', runs: [], slots: 1, free: 1, suspended: false}]};
  await mounted({view: withFuture}, container => {
    for (const [id, src] of [['claude-code', '/brand/claude-color.svg'], ['antigravity', '/brand/antigravity-color.svg']])
      assert.equal(container.querySelector(`[data-provider="${id}"] img[data-logo]`).getAttribute('src'), src);
    assert.match(container.querySelector('[data-provider="codex"] [data-logo="codex"]').style.mask ?? container.querySelector('[data-provider="codex"] [data-logo="codex"]').getAttribute('style'), /\/brand\/codex\.svg/);
    assert.ok(container.querySelector('.dispatch-local [data-logo="local-llm"]'));
    assert.equal(container.querySelector('[data-provider="openrouter"] [data-logo]'), null);
    assert.equal(container.querySelector('[data-provider="openrouter"] .dispatch-logo-glyph').textContent, '↗');
    assert.equal(container.querySelector('[data-provider="future-worker"] .dispatch-logo-glyph').textContent, 'F');
  });
});
