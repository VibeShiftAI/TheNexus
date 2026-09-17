import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCoverage,
  describeUnknownRuns,
} from '../../lib/dispatch-insight.ts';

/**
 * Missing usage must read as UNKNOWN, estimates must be distinguishable from
 * measurements, and every aggregate must carry its coverage. The failure these
 * guard against is arXiv:2609.11987 §5.1, where 58 runs with no usage record
 * left a billed cost ordering unresolved: a total summed over partial
 * telemetry is not the whole figure, and silence about the gap hides that.
 */

const rollup = (over) => ({
  totalRuns: 0, pricedRuns: 0, unknownRuns: 0, unknownByReason: {},
  estimatedUsd: null, estimated: true, coverage: null, ...over,
});

test('coverage always states the denominator, never a bare percentage', () => {
  assert.equal(
    formatCoverage(rollup({ totalRuns: 19, pricedRuns: 12, unknownRuns: 7 })),
    '12 of 19 runs priced (63%)',
  );
  // Singular runs read naturally.
  assert.equal(
    formatCoverage(rollup({ totalRuns: 1, pricedRuns: 1 })),
    '1 of 1 run priced (100%)',
  );
  assert.equal(formatCoverage(rollup({})), 'no runs yet');
});

test('zero priced runs reports 0% coverage rather than implying completeness', () => {
  const r = rollup({ totalRuns: 8, pricedRuns: 0, unknownRuns: 8, coverage: 0 });
  assert.equal(formatCoverage(r), '0 of 8 runs priced (0%)');
  // And the aggregate itself stays null — zero priced runs is not zero spend.
  assert.equal(r.estimatedUsd, null);
});

test('unknown runs are explained by cause, biggest group first', () => {
  const text = describeUnknownRuns(rollup({
    totalRuns: 10, pricedRuns: 2, unknownRuns: 8,
    unknownByReason: { no_model: 2, no_token_record: 5, unpriced_model: 1 },
  }));
  assert.equal(text, '5 left no usage record · 2 recorded no model · 1 ran on a model with no verified rate');
});

test('a fully covered aggregate reports no unknown causes', () => {
  assert.equal(describeUnknownRuns(rollup({ totalRuns: 4, pricedRuns: 4 })), '');
});

// ── Rendered surface ─────────────────────────────────────────────────────
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {MissionBrief} from '../project-brief/mission-brief.tsx';

const project = {id:'p1', name:'TheNexus', status:'active', description:null, tags:[]};
const baseBrief = (crew) => ({
  lastActivityAt: new Date().toISOString(),
  tasks:{active:1,activeNames:['x'],queued:0,attention:0,review:0,done7d:0,total:1},
  crew,
});

async function render(node, el) {
  const root = createRoot(node);
  await act(async () => { root.render(el); });
  return root;
}

test('a 7d token sum shows the coverage behind it, not a bare number', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const brief = baseBrief({
    running:0, last:null, tokens24h:0, tokens7d:500_000, dispatches7d:8,
    tokensCounted7d:3, tokensEstimated:false,
  });
  const root = await render(node, React.createElement(MissionBrief,{project,brief}));
  try {
    assert.match(node.textContent, /3 of 8 runs reported/);
    assert.match(node.textContent, /500\.0k/);
  } finally {
    await act(async()=>root.unmount()); node.remove();
  }
});

test('estimated tokens are visibly marked, never shown as a measurement', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const brief = baseBrief({
    running:0, last:null, tokens24h:0, tokens7d:500_000, dispatches7d:4,
    tokensCounted7d:4, tokensEstimated:true,
  });
  const root = await render(node, React.createElement(MissionBrief,{project,brief}));
  try {
    assert.match(node.textContent, /Tokens · 7d \(est\)/);
    assert.match(node.textContent, /~500\.0k/);
  } finally {
    await act(async()=>root.unmount()); node.remove();
  }
});

test('runs that reported no usage read as unknown, never as a zero', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const brief = baseBrief({
    running:0, last:null, tokens24h:0, tokens7d:0, dispatches7d:6,
    tokensCounted7d:0, tokensEstimated:false,
  });
  const root = await render(node, React.createElement(MissionBrief,{project,brief}));
  try {
    assert.match(node.textContent, /unknown/);
    assert.match(node.textContent, /no usage reported \(0 of 6 runs\)/);
    // The defect this replaces: "0" presented as a measured token count.
    assert.doesNotMatch(node.textContent, /Tokens · 7d0/);
  } finally {
    await act(async()=>root.unmount()); node.remove();
  }
});

// ── Dispatch console: the per-task attribution surface ───────────────────
import {TaskDispatchConsole} from '../task-view/dispatch-console.tsx';

const run = (id, over) => ({
  id, task_id:'t1', project_id:null, kind:'dispatch', parent_id:null,
  executor:'claude-code', model:'claude-opus-5', prompt:null, instructions:null,
  output:null, error:null, outcome:'success', session_id:null, workspace:null,
  log_path:null, started_at:new Date(Date.now()-3600_000).toISOString(),
  completed_at:new Date().toISOString(), ...over,
});
const runInsight = (id, over) => ({
  dispatchId:id, executor:'claude-code', model:'claude-opus-5', outcome:'success',
  startedAt:new Date(Date.now()-3600_000).toISOString(), completedAt:new Date().toISOString(),
  elapsedMs:3600_000, ceiling:{ms:10800000,source:'default_assumed'}, overdue:false,
  cost:null, tokens:null, tokensEstimated:false, usageUnknown:null,
  verification:null, guardrails:[], canKill:false, ...over,
});

async function renderConsole(node, {dispatches, insight}) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/dispatch-insight/task/')) return new Response(JSON.stringify(insight),{status:200});
    if (u.includes('/api/dispatches')) return new Response(JSON.stringify({dispatches}),{status:200});
    return new Response(JSON.stringify({}),{status:200});
  };
  const root = createRoot(node);
  await act(async () => {
    root.render(React.createElement(TaskDispatchConsole,{taskId:'t1',projectId:null}));
  });
  await act(async () => { await new Promise(r=>setTimeout(r,0)); });
  return {root, restore:()=>{globalThis.fetch=oldFetch;}};
}

test('the task cost aggregate is never shown without its coverage', async () => {
  const node = document.createElement('div'); document.body.append(node);
  const dispatches = [run('d1',{tokens:1_000_000}), run('d2'), run('d3')];
  const insight = {
    taskId:'t1', ceiling:{ms:10800000,source:'default_assumed'},
    scheduleEstimateMinutes:null, spineAvailable:true, praxisReachable:true,
    latestVerification:null,
    usageRollup:{totalRuns:3,pricedRuns:1,unknownRuns:2,
      unknownByReason:{no_token_record:2}, estimatedUsd:2.275, estimated:true, coverage:1/3},
    runs:[
      runInsight('d1',{cost:{usd:2.275,estimated:true},tokens:1_000_000}),
      runInsight('d2',{usageUnknown:{reason:'no_token_record',detail:'This run left no usage record, so its token count is unknown.'}}),
      runInsight('d3',{usageUnknown:{reason:'no_token_record',detail:'This run left no usage record, so its token count is unknown.'}}),
    ],
  };
  const {root, restore} = await renderConsole(node,{dispatches,insight});
  try {
    assert.match(node.textContent, /Run cost/);
    assert.match(node.textContent, /~\$2\.27 est/);
    // The coverage must sit beside the figure, not be inferable only from tooltips.
    assert.match(node.textContent, /1 of 3 runs priced \(33%\)/);
  } finally {
    await act(async()=>root.unmount()); node.remove(); restore();
  }
});

test('runs with no usage record read as unknown instead of vanishing', async () => {
  const node = document.createElement('div'); document.body.append(node);
  const dispatches = [run('d2')];
  const insight = {
    taskId:'t1', ceiling:{ms:10800000,source:'default_assumed'},
    scheduleEstimateMinutes:null, spineAvailable:true, praxisReachable:true,
    latestVerification:null,
    usageRollup:{totalRuns:1,pricedRuns:0,unknownRuns:1,
      unknownByReason:{no_token_record:1}, estimatedUsd:null, estimated:true, coverage:0},
    runs:[runInsight('d2',{usageUnknown:{reason:'no_token_record',detail:'This run left no usage record, so its token count is unknown.'}})],
  };
  const {root, restore} = await renderConsole(node,{dispatches,insight});
  try {
    // Before: both chips were simply omitted, which reads as "no spend".
    assert.match(node.textContent, /tokens unknown/);
    assert.match(node.textContent, /cost unknown/);
    // A task with nothing priced reports unknown, never $0.00.
    assert.match(node.textContent, /Run cost.*unknown/s);
    assert.doesNotMatch(node.textContent, /\$0\.00/);
  } finally {
    await act(async()=>root.unmount()); node.remove(); restore();
  }
});

test('measured token counts are labelled differently from estimated ones', async () => {
  const node = document.createElement('div'); document.body.append(node);
  const insight = {
    taskId:'t1', ceiling:{ms:10800000,source:'default_assumed'},
    scheduleEstimateMinutes:null, spineAvailable:true, praxisReachable:true,
    latestVerification:null,
    usageRollup:{totalRuns:2,pricedRuns:2,unknownRuns:0,unknownByReason:{},
      estimatedUsd:4.55, estimated:true, coverage:1},
    runs:[runInsight('d1',{cost:{usd:2.275,estimated:true},tokens:1_000_000}),
          runInsight('d2',{cost:{usd:2.275,estimated:true},tokens:1_000_000,tokensEstimated:true})],
  };
  const dispatches = [run('d1',{tokens:1_000_000}), run('d2',{tokens:1_000_000,tokens_estimated:1})];
  const {root, restore} = await renderConsole(node,{dispatches,insight});
  try {
    assert.match(node.textContent, /1,000,000 tokmeasured/);
    assert.match(node.textContent, /~1,000,000 tokest/);
    assert.match(node.textContent, /all 2 runs|2 of 2 runs priced \(100%\)/);
  } finally {
    await act(async()=>root.unmount()); node.remove(); restore();
  }
});

// ── Now strip: coverage must reach the UI, not stop at the API ───────────
// /api/dispatches/active reports tokensCountedRuns / tokensTotalRuns. The
// strip previously rendered the cumulative sum bare, so a total drawn from 1
// of 8 runs read exactly like one drawn from 8 of 8.
import {NowStrip} from '../bridge/now-strip.tsx';
import {LLMActivityWidget} from '../llm-activity-widget.tsx';
import {PowerStation} from '../bridge/power-station.tsx';

const ok = (body) => ({ok: true, json: async () => body});

async function mountWith(element, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  await act(async () => root.render(element));
  return {
    node,
    dispose: async () => {
      await act(async () => root.unmount());
      node.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

const activeDispatch = (over) => ({
  id: 'd1', taskId: 'task-1', projectId: 'p1', executor: 'claude-code', kind: 'task',
  model: 'claude-opus-5', tokens: 12_345, tokensEstimated: false,
  tokensCountedRuns: 1, tokensTotalRuns: 8, title: 'A task',
  startedAt: new Date().toISOString(), ...over,
});

const activeFetch = (dispatch) => async (url) =>
  String(url).includes('/api/dispatches/active')
    ? ok({active: dispatch ? [dispatch] : []})
    : ok({});

test('the now strip qualifies a cumulative total that covers only some runs', async () => {
  const h = await mountWith(React.createElement(NowStrip), activeFetch(activeDispatch()));
  try {
    // The number is still shown, but never on its own.
    assert.match(h.node.textContent, /12\.3k/);
    assert.match(h.node.textContent, /1\/8 runs/);
  } finally {
    await h.dispose();
  }
});

test('the now strip adds no coverage caveat when every run reported usage', async () => {
  const h = await mountWith(
    React.createElement(NowStrip),
    activeFetch(activeDispatch({tokensCountedRuns: 8, tokensTotalRuns: 8})),
  );
  try {
    assert.match(h.node.textContent, /12\.3k/);
    // Full coverage earns a clean figure: the caveat is information, not decoration.
    assert.doesNotMatch(h.node.textContent, /8\/8 runs/);
  } finally {
    await h.dispose();
  }
});

test('the now strip says unknown, not a dash, when no run reported usage', async () => {
  const h = await mountWith(
    React.createElement(NowStrip),
    activeFetch(activeDispatch({tokens: null, tokensCountedRuns: 0, tokensTotalRuns: 5})),
  );
  try {
    assert.match(h.node.textContent, /unknown/);
  } finally {
    await h.dispose();
  }
});

// ── LLM rollup widgets: both consume the same coverage caveat ────────────
const llmLog = (missing) => ok({
  aggregates: {
    by_caller: [{caller: 'praxis.agent', calls: 130, tokens: 900_000, failures: 0}],
    by_provider: [{provider: 'anthropic', calls: 130}],
    total_calls: 130,
    since_hours: 1,
    ...(missing === null ? {} : {missing_usage_calls: missing}),
  },
});

test('the LLM activity widget reports how many calls left no usage record', async () => {
  const h = await mountWith(React.createElement(LLMActivityWidget), async () => llmLog(60));
  try {
    assert.match(h.node.textContent, /usage unknown for 60 of 130 calls/);
  } finally {
    await h.dispose();
  }
});

test('the LLM activity widget stays quiet when usage is complete', async () => {
  const h = await mountWith(React.createElement(LLMActivityWidget), async () => llmLog(0));
  try {
    assert.match(h.node.textContent, /130/);
    assert.doesNotMatch(h.node.textContent, /usage unknown/);
  } finally {
    await h.dispose();
  }
});

// The station also polls /api/token-usage for its charge meter; that feed is
// not under test, so it degrades (err) rather than supplying a fixture.
const powerStationFetch = (missing) => async (url) =>
  String(url).includes('/api/praxis/llm-log')
    ? llmLog(missing)
    : {ok: false, status: 503, json: async () => ({})};

test('the power station carries the same caveat the details page shows', async () => {
  const h = await mountWith(React.createElement(PowerStation), powerStationFetch(60));
  try {
    assert.match(h.node.textContent, /tokens unknown for 60 of 130 calls/);
  } finally {
    await h.dispose();
  }
});

test('the power station stays quiet when usage is complete', async () => {
  const h = await mountWith(React.createElement(PowerStation), powerStationFetch(0));
  try {
    assert.doesNotMatch(h.node.textContent, /tokens unknown for/);
  } finally {
    await h.dispose();
  }
});
