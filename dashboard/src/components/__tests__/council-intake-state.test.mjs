import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import CouncilPage from '../../app/council/page.tsx';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const response = data => ({ ok: true, json: async () => data });
const receipt = (id, state = 'queued') => response({ ok: true, project_id: id, operation_id: `${id}:preparation`, session_id: `intake-${id}`, state });

async function mount() {
  const originalFetch = globalThis.fetch;
  const statuses = []; const captures = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/praxis/council/problem') {
      const body = JSON.parse(options.body);
      if (body.action === 'status') { const pending = deferred(); statuses.push({ ...pending, body }); return pending.promise; }
      captures.push(body); return receipt(body.problem);
    }
    if (url === '/api/praxis/council/benches') return response({ benches: [], catalog: { cli: [], openrouter: [] } });
    if (String(url).includes('/sessions?')) return response({ sessions: [] });
    if (String(url).includes('/sessions/')) return response({ sessionId: String(url).split('/').at(-1), topic: 'Intake', phase: 'setup', createdAt: Date.now(), metadata: {}, voices: [], theses: [], stats: { voiceCount: 0, thesisCount: 0, successCount: 0, failureCount: 0, hasSynthesis: false, elapsedMs: 0 }, sharedFindings: [], consensusTracking: {}, finalRecommendations: [] });
    throw Error(`Unexpected network call: ${url}`);
  };
  localStorage.clear(); window.history.replaceState(null, '', '/council');
  window.Element.prototype.scrollIntoView = () => {};
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const button = label => [...container.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await act(async () => { root.render(createElement(CouncilPage)); await flush(); });
  const click = label => act(async () => { assert.ok(button(label), label); button(label).click(); await flush(); });
  await click('Prepare an intake');
  return {
    container, statuses, captures, click,
    async submit(problem) {
      await act(async () => {
        const input = container.querySelector('textarea');
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, problem);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await act(async () => { container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush(); });
    },
    async finish(index, value) { await act(async () => { statuses[index].resolve(value); await flush(); }); },
    link() { return [...container.querySelectorAll('a')].find(node => node.textContent === 'Open saved project intake')?.getAttribute('href'); },
    close() { act(() => root.unmount()); container.remove(); globalThis.fetch = originalFetch; },
  };
}

test('a slow status from the previous intake cannot replace a newly saved project receipt', async () => {
  const ui = await mount();
  try {
    await ui.submit('A'); await ui.click('Check preparation status');
    await ui.submit('B'); assert.equal(ui.link(), '/project/B');
    await ui.finish(0, receipt('A', 'applied'));
    assert.equal(ui.link(), '/project/B');
  } finally { ui.close(); }
});

test('out-of-order status responses preserve the newest result and ignore stale errors', async () => {
  const ui = await mount();
  try {
    await ui.submit('A'); await ui.click('Check preparation status'); await ui.click('Check preparation status');
    await ui.finish(1, receipt('A', 'applied'));
    await ui.finish(0, receipt('A', 'queued'));
    assert.match(ui.container.textContent, /Intake preparation: applied/);
    await ui.click('Check preparation status'); await ui.click('Check preparation status');
    await ui.finish(3, receipt('A', 'applied'));
    await ui.finish(2, { ok: false, json: async () => ({ error: 'stale failure' }) });
    assert.doesNotMatch(ui.container.textContent, /stale failure/);
  } finally { ui.close(); }
});

test('changing council mode invalidates an in-flight preparation status', async () => {
  const ui = await mount();
  try {
    await ui.submit('A'); await ui.click('Check preparation status'); await ui.click('Deliberation');
    await ui.finish(0, receipt('A', 'applied'));
    assert.doesNotMatch(ui.container.textContent, /Intake preparation:/);
  } finally { ui.close(); }
});
