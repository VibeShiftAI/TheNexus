import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeHealthBanner } from '../runtime-health-banner.tsx';
import SystemMonitor from '../../app/system-monitor/page.tsx';
import { OpsConnectionStatus } from '../ops-connection-status.tsx';
import { CliLanePanel } from '../bridge/cli-lane-panel.tsx';
import { deriveCliLane } from '../../lib/cli-lane.ts';
import { StatusStrip } from '../bridge/status-strip.tsx';
import { __setConnectionLifecycleForTests, createConnectionLifecycle } from '../../lib/connection-lifecycle.ts';
import { refreshDispatchState } from '../../hooks/use-dispatch-state.ts';

const healthy = { status:'healthy', causes:[], unavailable:[] };
const system = { system:{cpu:{usage:2},memory:{usagePercent:5}}, ports:[{port:4000,type:'node',process:'node',pid:1}], portCount:1, praxis:{status:'online',dailyCallCount:2,quota:{resetTime:'1 hour',providers:{openai:{requestsToday:2}}}} };
const usage = {totals:{totalTokens:0},byDay:[],byProvider:[],recentUsage:[]};
const green = node => Array.from(node.querySelectorAll('[class]')).filter(el => /(?:text|bg|border|from|via|to)-(?:emerald|green)-/.test(el.getAttribute('class')));

for (const [id, detail] of [['wedged','codex: wedged executor'], ['usage','codex usage limit'], ['silent','Silent failure: no attempt'], ['day','day activity: 0 dispatched']]) {
  test(`banner and summary/monitor share ${id} degradation, then recover and fail closed on unreachable`, async t => {
    const lifecycle = createConnectionLifecycle({ probe: async () => 'unreachable', target: window, isVisible: () => true, storage: null });
    __setConnectionLifecycleForTests(lifecycle);
    let health = { status:'degraded', causes:[{id,detail,href:'/ops'}], unavailable:[] };
    let offline = false;
    t.mock.method(globalThis, 'fetch', async url => {
      if (String(url).includes('/dispatch-state')) {
        if (offline) throw new Error('Praxis unavailable');
        return Response.json({runtimeHealth:health,executors:{runs:[],sessions:[],cliQueue:[],usageWaits:{available:true,items:[]}},cron:[],localLlm:{jobs:[]}});
      }
      if (String(url).includes('/system/status')) return Response.json(system);
      if (String(url).includes('/token-usage')) return Response.json({today:{total:0}});
      if (String(url).includes('/usage')) return Response.json(usage);
      return Response.json({projects:[],tasks:[],requests:[],events:[],items:[],schedule:null});
    });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        await refreshDispatchState();
        root.render(h('div', null, h(RuntimeHealthBanner), h('section',{'data-summary':true}, h(StatusStrip), h(OpsConnectionStatus,{phase:'live',loadedAt:Date.now(),err:null,onRetry(){},onReauth(){},onSignInHere(){}}), h(CliLanePanel,{view:deriveCliLane({executors:{runs:[],cliQueue:[],cliConcurrency:{limit:1,active:0,free:1}}})})), h('section',{'data-monitor':true}, h(SystemMonitor))));
        await new Promise(resolve => setImmediate(resolve));
      });
      const banner = () => container.querySelector('[data-runtime-banner]');
      assert.equal(container.firstChild.firstChild, banner(), 'banner precedes cockpit content');
      assert.match(banner().textContent, /Runtime degraded/);
      assert.ok(banner().textContent.includes(detail));
      assert.equal(banner().querySelector('a').getAttribute('href'), '/ops');
      for (const selector of ['[data-summary]','[data-monitor]']) {
        assert.equal(green(container.querySelector(selector)).length, 0, `${selector} has no healthy green indicators`);
        assert.doesNotMatch(container.querySelector(selector).textContent, /TUNNEL ACTIVE|WITHIN BUDGET|VIBE: HIGH|PRAXIS \/\/ ACTIVE/);
      }
      assert.equal(container.querySelectorAll('[style*="34, 197, 94"], [style*="22c55e"]').length, 0, 'provider quota indicators are not green');
      health = healthy;
      await act(async () => { await refreshDispatchState(); });
      assert.equal(banner(), null);
      assert.ok(green(container.querySelector('[data-summary]')).length > 0, 'healthy summary restored');
      offline = true;
      await act(async () => { await refreshDispatchState(); });
      assert.match(banner().textContent, /Status unknown/);
      assert.equal(green(container.querySelector('[data-summary]')).length, 0);
      assert.equal(green(container.querySelector('[data-monitor]')).length, 0);
    } finally { act(() => root.unmount()); container.remove(); lifecycle.dispose(); __setConnectionLifecycleForTests(null); }
  });
}

test('missing health field is unknown even when dispatch telemetry responds', async t => {
  t.mock.method(globalThis,'fetch',async () => Response.json({executors:{runs:[]}}));
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => { await refreshDispatchState(); root.render(h(RuntimeHealthBanner)); });
    assert.match(container.textContent,/Status unknown/);
  } finally { act(() => root.unmount()); }
});
