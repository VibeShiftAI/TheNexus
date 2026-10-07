import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DeliverableRow } from '../document-review/deliverable-row.tsx';
import { ReviewRequirements } from '../document-review/review-requirements.tsx';
import { entry, response, stubFetch } from './document-registry-fake.mjs';
const waiting = { id: 'waiting-task', title: 'Implement the approved plan', status: 'planning', project_id: 'p1' };
function mount(component, props) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); act(() => root.render(createElement(component, props)));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); } };
}
async function click(c, text) {
  const node = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  assert.ok(node, `button ${text}`);
  await act(async () => { node.click(); await new Promise(r => setTimeout(r, 0)); });
}
test('blocking badge links to waiting tasks in full and compact rows; producer is separate', () => {
  for (const compact of [true, false]) {
    const t = mount(DeliverableRow, { compact, entry: entry(1, { blocking_tasks: [waiting], blocking_task_count: 1 }) });
    try {
      assert.match(t.container.textContent, /Blocking 1 task/);
      assert.equal(t.container.querySelector('a[href="/task/waiting-task"]').textContent, waiting.title);
      assert.ok(t.container.querySelector('a[href="/task/task-1"]'));
    } finally { t.cleanup(); }
  }
  const t = mount(DeliverableRow, { entry: entry(2) });
  try { assert.doesNotMatch(t.container.textContent, /Blocking/); } finally { t.cleanup(); }
});
test('reference can be promoted with a named waiting task and refreshes the reader', async () => {
  let refreshed = 0;
  const stub = stubFetch((url) => {
    if (url.pathname === '/api/documents/review-task-options') return response({ tasks: [waiting] });
    if (url.pathname === '/api/documents/doc-001/request-review') return response({ document: {}, review_status: 'needs_review', blocking_tasks: [waiting] });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const t = mount(ReviewRequirements, { document: entry(1, { review_status: 'reference' }), onRefresh: () => { refreshed++; } });
  try {
    await click(t.container, 'Move to review queue');
    assert.match(t.container.textContent, /Implement the approved plan/);
    await act(async () => t.container.querySelector('input[type="checkbox"]').click());
    await click(t.container, 'Save review requirements');
    const call = stub.calls.find(c => c.path.endsWith('/request-review'));
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, { blocking_task_ids: ['waiting-task'] });
    assert.equal(refreshed, 1);
    assert.ok(!stub.calls.some(c => c.path.endsWith('/decisions')));
  } finally { t.cleanup(); stub.restore(); }
});
test('a failed save keeps the selection and exposes an error for retry', async () => {
  const stub = stubFetch(url => url.pathname.endsWith('/review-task-options')
    ? response({ tasks: [waiting] }) : response({ error: 'Task is unavailable' }, 404));
  const t = mount(ReviewRequirements, { document: entry(1, { blocking_task_ids: [waiting.id] }), onRefresh: () => assert.fail('must not refresh') });
  try {
    await click(t.container, 'Edit waiting tasks');
    await click(t.container, 'Save review requirements');
    assert.match(t.container.querySelector('[role="alert"]').textContent, /Task is unavailable/);
    assert.equal(t.container.querySelector('input[type="checkbox"]').checked, true);
  } finally { t.cleanup(); stub.restore(); }
});
