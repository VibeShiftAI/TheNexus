import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HitlRequestCard } from '../hitl-card.tsx';

const accept = 'accept as-is — mark complete';

test('desktop accept-as-is is a normal actionable option and sends the server-defaulted payload', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls = [];
  const request = {
    id: 'desktop-accept-fixture', reason: 'qa-blocked', question: 'Review rejected work',
    requestedAt: new Date().toISOString(), options: ['leave blocked', accept],
  };
  try {
    await act(async () => root.render(React.createElement(HitlRequestCard, {
      request, resolving: false, onResolve: async (...args) => { calls.push(args); },
    })));
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === accept);
    assert.ok(button, 'accept is labeled without a phone restriction');
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('title'), null);
    assert.doesNotMatch(container.textContent, /phone|one-time key|Nexus Mobile/i);
    await act(async () => button.click());
    assert.deepEqual(calls, [[request.id, { choice: accept, freeText: undefined }]]);
    assert.equal(Object.hasOwn(calls[0][1], 'resolvedBy'), false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
