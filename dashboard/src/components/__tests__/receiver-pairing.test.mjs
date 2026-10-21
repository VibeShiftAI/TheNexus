import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ReceiverPairing } from '../presentation/receiver-pairing.tsx';

test('a launched Cast receiver enrolls without cookies, reads only its paired view, and clears on sender loss', async () => {
  const fetchBefore = globalThis.fetch, calls = [];
  let left, stopped = 0;
  window.cast = { framework: {
    messages: { MessageType: { LOAD: 'LOAD', QUEUE_LOAD: 'QUEUE_LOAD' } },
    system: { EventType: { SENDER_DISCONNECTED: 'left' } },
    CastReceiverContext: { getInstance: () => ({ start() {}, stop() { stopped++; }, getSenders: () => [],
      addEventListener(_type, callback) { left = callback; }, removeEventListener() {},
      getPlayerManager: () => ({ setMessageInterceptor() {} }),
    }) },
  } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.credentials, 'omit');
    if (url === '/receiver/pairings') {
      assert.deepEqual(JSON.parse(init.body), { name: 'Cast display' });
      return Response.json({ code: 'ABCDEF', pollToken: 'poll-only', expiresAt: new Date(Date.now() + 60000).toISOString() });
    }
    if (url === '/receiver/pairings/ABCDEF') { assert.equal(init.headers.Authorization, 'Bearer poll-only'); return Response.json({ state: 'paired', token: 'selected-view-only' }); }
    assert.equal(url, '/receiver/view'); assert.equal(init.headers.Authorization, 'Bearer selected-view-only');
    return Response.json({ version: 1, sampledAt: new Date().toISOString(), session: { id: 'paired-session', state: 'active', expiresAt: new Date(Date.now() + 60000).toISOString() }, content: { kind: 'ambient', label: 'Selected fixture view', counts: { active: 1 } } });
  };
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(ReceiverPairing, { cast: true })));
    assert.match(div.textContent, /Selected fixture view/);
    assert.equal(calls.filter(call => call.url === '/receiver/pairings').length, 1);
    await act(async () => left());
    assert.doesNotMatch(div.textContent, /Selected fixture view|ABCDEF/);
    assert.match(div.textContent, /Presentation ended/); assert.equal(stopped, 1);
  } finally { await act(async () => root.unmount()); div.remove(); globalThis.fetch = fetchBefore; delete window.cast; }
});

test('missing Cast SDK never enrolls a receiver or silently falls back to a browser', async () => {
  const fetchBefore = globalThis.fetch; delete window.cast;
  globalThis.fetch = async () => assert.fail('No enrollment without Cast runtime');
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(ReceiverPairing, { cast: true })));
    assert.match(div.textContent, /Cast receiver SDK is unavailable/);
    assert.equal(div.querySelector('form'), null);
  } finally { await act(async () => root.unmount()); div.remove(); globalThis.fetch = fetchBefore; }
});
