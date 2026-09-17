import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewDocumentsPanel } from '../task-view/review-documents-panel.tsx';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

function setup(handler, taskId = 'task-1') {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url), 'http://localhost');
    calls.push({ path: parsed.pathname, method: options.method ?? 'GET', query: parsed.searchParams });
    return handler(parsed, options);
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ReviewDocumentsPanel, { taskId })));
  return { container, calls, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

const doc = (id, review_state = null) => ({
  id, title: `Report ${id}`, path: `/Volumes/Projects/Praxis/docs/${id}.md`, kind: 'report', task_id: 'task-1', project_id: 'p1', metadata: {},
  current_revision: { id: 'rev-1', content_hash: 'abcdef1234567890', captured_at: '2026-09-10T10:00:00Z', byte_length: 10, line_count: 1 },
  review_url: `https://nexus.vibeshiftai.com/documents/${id}`, review_state,
});

test('lists the task documents with a Review document link and truthful review state', async () => {
  const t = setup(() => response({ documents: [
    doc('d1'),
    doc('d2', { review_id: 'r2', status: 'draft', updated_at: '2026-09-10T11:00:00Z', comment_count: 3, delivery_status: null }),
    doc('d3', { review_id: 'r3', status: 'submitted', updated_at: '2026-09-10T11:00:00Z', comment_count: 1, delivery_status: 'delivered' }),
    doc('d4', { review_id: 'r4', status: 'submitted', updated_at: '2026-09-10T11:00:00Z', comment_count: 0, delivery_status: 'failed' }),
  ] }));
  try {
    await settle();
    assert.equal(t.calls[0].path, '/api/documents');
    assert.equal(t.calls[0].query.get('task_id'), 'task-1');
    const panel = t.container.querySelector('[data-review-documents-panel]');
    assert.ok(panel);
    const links = [...panel.querySelectorAll('a')].filter(a => a.textContent.includes('Review document'));
    assert.deepEqual(links.map(a => a.getAttribute('href')), ['/documents/d1', '/documents/d2', '/documents/d3', '/documents/d4']);
    const row = id => panel.querySelector(`[data-document-id="${id}"]`).textContent;
    assert.match(row('d1'), /Not reviewed yet/);
    assert.match(row('d2'), /Draft.*3 comments/);
    assert.match(row('d3'), /Review sent to Praxis/);
    assert.match(row('d4'), /delivery failed/i);
    assert.match(row('d1'), /abcdef12/);
  } finally { t.cleanup(); }
});

test('renders nothing without documents and shows a retry on errors', async () => {
  const empty = setup(() => response({ documents: [] }));
  try { await settle(); assert.equal(empty.container.innerHTML, ''); } finally { empty.cleanup(); }
  let fail = true;
  const t = setup(() => (fail ? response({ error: 'boom' }, 500) : response({ documents: [doc('d9')] })));
  try {
    await settle();
    assert.match(t.container.textContent, /boom/);
    fail = false;
    const retry = [...t.container.querySelectorAll('button')].find(b => /retry/i.test(b.textContent));
    await act(async () => retry.click());
    await settle();
    assert.ok(t.container.querySelector('a[href="/documents/d9"]'));
  } finally { t.cleanup(); }
});
