import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import DocumentsPage from '../../app/documents/page.tsx';

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

function setup(handler) {
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
  act(() => root.render(createElement(DocumentsPage)));
  return { container, calls, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

const doc = (id, review_state = null, extra = {}) => ({
  id, title: `Report ${id}`, path: `/Volumes/Projects/Praxis/docs/reports/${id}.md`, kind: 'report', task_id: 'task-1', project_id: 'p1', metadata: {},
  current_revision: { id: 'rev-1', content_hash: 'abcdef1234567890', captured_at: '2026-09-10T10:00:00Z', byte_length: 10, line_count: 1 },
  review_url: `https://nexus.vibeshiftai.com/documents/${id}`, review_state, ...extra,
});

test('lists every registered document with same-origin reviewer links and truthful state', async () => {
  const t = setup(() => response({ documents: [
    doc('d1'),
    doc('d2', { review_id: 'r2', status: 'draft', updated_at: '2026-09-10T11:00:00Z', comment_count: 3, delivery_status: null }),
    doc('d3', { review_id: 'r3', status: 'submitted', updated_at: '2026-09-10T11:00:00Z', comment_count: 1, delivery_status: 'delivered' }),
  ] }));
  try {
    await settle();
    assert.equal(t.calls[0].path, '/api/documents');
    assert.equal(t.calls[0].query.get('task_id'), null, 'the index asks for every document, not one task');
    const page = t.container.querySelector('[data-documents-index]');
    assert.ok(page);
    const links = [...page.querySelectorAll('a[data-review-link]')];
    assert.deepEqual(links.map(a => a.getAttribute('href')), ['/documents/d1', '/documents/d2', '/documents/d3']);
    assert.deepEqual(links.map(a => a.textContent.trim()), ['Review document', 'Continue review', 'Open review']);
    assert.ok(links.every(a => a.getAttribute('target') === null), 'never a new window');
    const row = id => page.querySelector(`[data-document-id="${id}"]`);
    assert.match(row('d1').textContent, /Not reviewed yet/);
    assert.match(row('d2').textContent, /Draft.*3 comments/);
    assert.match(row('d3').textContent, /Review sent to Praxis/);
    assert.match(row('d1').textContent, /d1\.md/);
    assert.equal(row('d1').querySelector('a[href="/task/task-1"]').textContent, 'from task');
    assert.ok(page.querySelector('a[href="/"]'), 'back to the bridge');
  } finally { t.cleanup(); }
});

test('filters between documents that still need a review and those sent to Praxis', async () => {
  const t = setup(() => response({ documents: [
    doc('open-1'),
    doc('sent-1', { review_id: 'r', status: 'submitted', updated_at: '2026-09-10T11:00:00Z', comment_count: 1, delivery_status: 'delivered' }),
  ] }));
  try {
    await settle();
    const button = label => [...t.container.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(label));
    assert.match(button('Needs your review').textContent, /\(1\)/);
    await act(async () => button('Needs your review').click());
    assert.deepEqual([...t.container.querySelectorAll('[data-document-id]')].map(li => li.dataset.documentId), ['open-1']);
    await act(async () => button('Sent to Praxis').click());
    assert.deepEqual([...t.container.querySelectorAll('[data-document-id]')].map(li => li.dataset.documentId), ['sent-1']);
    await act(async () => button('All').click());
    assert.equal(t.container.querySelectorAll('[data-document-id]').length, 2);
  } finally { t.cleanup(); }
});

test('shows an empty state without documents and a retry on errors', async () => {
  const empty = setup(() => response({ documents: [] }));
  try { await settle(); assert.ok(empty.container.querySelector('[data-documents-empty]')); } finally { empty.cleanup(); }
  let fail = true;
  const t = setup(() => (fail ? response({ error: 'boom' }, 500) : response({ documents: [doc('d9')] })));
  try {
    await settle();
    assert.match(t.container.querySelector('[role="alert"]').textContent, /boom/);
    fail = false;
    const retry = [...t.container.querySelectorAll('button')].find(b => /retry/i.test(b.textContent));
    await act(async () => retry.click());
    await settle();
    assert.ok(t.container.querySelector('a[data-review-link][href="/documents/d9"]'));
    assert.equal(t.container.querySelector('[role="alert"]'), null);
  } finally { t.cleanup(); }
});
