import test from 'node:test';
import assert from 'node:assert/strict';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {UsageRoutingPanel} from '../usage-routing-panel.tsx';
import {fmtTokens} from '../../lib/token-usage.ts';

test('unknown aggregate tokens render distinctly from measured zero', () => {
  assert.equal(fmtTokens(null),'Unknown');
  assert.equal(fmtTokens(0),'0');
});

test('usage panel renders missing model prices as Unknown without a zero dollar claim', async () => {
  const family = {today:{events:1,inputTokens:100,outputTokens:10,cacheReadTokens:0,cacheWriteTokens:0,byModel:{},estCostUsd:null,unpricedEvents:1,pricedSubtotalUsd:1.25},window:null,rateLimits:[],limit:{coolingDown:false},modelLimits:{}};
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({generatedAt:Date.now(),families:{claude:family,codex:family},recentDecisions:[]}),{status:200});
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => { root.render(React.createElement(UsageRoutingPanel)); });
    assert.match(node.textContent,/Unknown/);
    assert.match(node.textContent,/1 events without a price/);
    assert.match(node.textContent,/Priced subtotal: \$1.25/);
    assert.doesNotMatch(node.textContent,/\$0\.00/);
  } finally {
    await act(async()=>root.unmount());
    node.remove();
    globalThis.fetch=oldFetch;
  }
});
