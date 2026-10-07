import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import InboxPage from '../../app/inbox/page.tsx';

test('old inbox link fetches its resolved request beyond the recent-history window and displays the whole answer', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  window.history.replaceState(null, '', '/inbox#old-request');
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes('/hitl/old-request')) return Response.json({ id: 'old-request', reason: 'explicit_request', requestedAt: '2026-09-01T00:00:00Z', question: 'Use [staging](/task/t1)?', resolution: { choice: 'yes', freeText: 'Preserve both paragraphs.\n\nAnd the second instruction.', resolvedAt: '2026-09-01T01:00:00Z' } });
    return Response.json({ requests: [] });
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(InboxPage)));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(calls.some(url => url.includes('/hitl/old-request')));
    assert.match(container.textContent, /Request closed/);
    assert.match(container.textContent, /Preserve both paragraphs/);
    assert.match(container.textContent, /And the second instruction/);
    assert.ok(container.querySelector('a[href="/task/t1"]'));
    assert.equal(container.querySelector('textarea'), null);
    assert.equal(document.activeElement?.id, 'hitl-old-request');
    const refresh = container.querySelector('button[title="Refresh"]'); refresh.focus();
    await act(async () => refresh.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(document.activeElement?.getAttribute('title'), 'Refresh', 'background refresh must not steal focus back to history');
    await act(async () => { window.history.replaceState(null, '', '/inbox'); window.dispatchEvent(new window.Event('hashchange')); });
    assert.doesNotMatch(container.textContent, /Linked request|Preserve both paragraphs/);
  } finally {
    await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch;
    window.history.replaceState(null, '', '/');
  }
});

test('a background inbox refresh preserves the mounted answer and its typed draft', async () => {
  const originalFetch = globalThis.fetch;
  const request = { id: 'draft-question', question: 'Which environment?', reason: 'explicit_request', requestedAt: new Date().toISOString() };
  let pendingReads = 0, finish;
  window.history.replaceState(null, '', '/inbox');
  globalThis.fetch = async url => {
    if (String(url).endsWith('/hitl/pending')) {
      if (++pendingReads === 1) return Response.json({ requests: [request] });
      return new Promise(resolve => { finish = resolve; });
    }
    return Response.json({ requests: [] });
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(InboxPage)));
    const textarea = container.querySelector('textarea');
    assert.ok(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Use staging; keep production untouched.');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('button[title="Refresh"]').click());
    assert.equal(container.querySelector('textarea') === textarea, true, 'a pending refresh must not unmount the card');
    assert.equal(textarea.value, 'Use staging; keep production untouched.');
    await act(async () => { finish(Response.json({ requests: [request] })); });
    assert.equal(container.querySelector('textarea') === textarea, true);
    assert.equal(textarea.value, 'Use staging; keep production untouched.');
  } finally {
    await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch;
    window.history.replaceState(null, '', '/');
  }
});
