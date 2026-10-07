import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { setParams } from './stubs/next-navigation.mjs';
import ChatTurnPage from '../src/app/chat/turns/[id]/page.tsx';

for (const state of ['rejected', 'uncertain']) {
  test(`saved ${state} receipt shows its actual explanation and only reads status`, async () => {
    const original = globalThis.fetch, calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ state, error: state === 'rejected' ? 'cli_model_incompatible' : 'outcome_uncertain', retryable: false,
        reply: { state, response: 'The model client rejected this request. [Review model control](/model-control).' } });
    };
    setParams({ id: 'saved-test-turn' });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(ChatTurnPage)); await new Promise(setImmediate); });
      assert.match(container.textContent, /The model client rejected this request/);
      assert.equal(container.querySelector('a[href="/model-control"]')?.textContent, 'Review model control');
      assert.doesNotMatch(container.querySelector('h1').textContent, /Saved reply/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, '/api/ai/chat/turns/saved-test-turn');
      assert.equal(calls[0].init.method ?? 'GET', 'GET');
      await act(async () => container.querySelector('button').click());
      assert.equal(calls.length, 2);
      assert.ok(calls.every(call => (call.init.method ?? 'GET') === 'GET'));
    } finally { act(() => root.unmount()); container.remove(); globalThis.fetch = original; }
  });
}
