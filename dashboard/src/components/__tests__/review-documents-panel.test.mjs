import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewDocumentsPanel } from '../task-view/review-documents-panel.tsx';
import { entry, registryHandler, stubFetch, syntheticRegistry } from './document-registry-fake.mjs';

async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

function setup(handler, taskId = 'task-1', projectId = 'p1') {
  const stub = stubFetch(handler);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ReviewDocumentsPanel, { taskId, projectId })));
  return { container, calls: stub.calls, cleanup() { act(() => root.unmount()); container.remove(); stub.restore(); } };
}

const taskDocs = () => [
  entry(1, { purpose: 'Decide whether the repair plan is ready' }),
  entry(2, { review_state: { review_id: 'r2', status: 'draft', updated_at: '2026-10-01T11:00:00Z', comment_count: 3, delivery_status: null } }),
  entry(3, { review_status: 'approved', review_state: { review_id: 'r3', status: 'submitted', updated_at: '2026-10-01T11:00:00Z', comment_count: 1, delivery_status: 'delivered' } }),
  entry(4, { review_status: 'changes_requested', review_state: { review_id: 'r4', status: 'submitted', updated_at: '2026-10-01T11:00:00Z', comment_count: 0, delivery_status: 'failed' } }),
  entry(5, { review_status: 'reference', requires_review: false }),
  entry(6, { task_id: 'other-task' }),
];

test('lists the task deliverables with purpose, version, document status and a direct Open', async () => {
  const t = setup(registryHandler(taskDocs()));
  try {
    await settle();
    const list = t.calls.find(c => c.path === '/api/documents');
    assert.equal(list.query.get('task_id'), 'task-1');
    assert.equal(list.query.get('status'), 'all', 'every deliverable of the task, reference ones included');
    const panel = t.container.querySelector('[data-review-documents-panel]');
    assert.match(panel.querySelector('h3').textContent, /Deliverables/);
    const links = [...panel.querySelectorAll('a[data-review-link]')];
    assert.deepEqual(links.map(a => a.getAttribute('href')), ['/documents/doc-005', '/documents/doc-004', '/documents/doc-003', '/documents/doc-002', '/documents/doc-001']);
    assert.ok(links.every(a => a.textContent.trim() === 'Open' && a.getAttribute('target') === null));
    const row = id => panel.querySelector(`[data-document-id="${id}"]`);
    assert.match(row('doc-001').querySelector('[data-document-purpose]').textContent, /Decide whether the repair plan is ready/);
    assert.match(row('doc-001').querySelector('[data-document-version]').textContent, /rev 11111111/);
    assert.equal(row('doc-001').querySelector('[data-document-status]').textContent, 'Review pending');
    assert.equal(row('doc-003').querySelector('[data-document-status]').textContent, 'Document approved');
    assert.equal(row('doc-004').querySelector('[data-document-status]').textContent, 'Changes requested');
    assert.equal(row('doc-005').querySelector('[data-document-status]').textContent, 'Reference');
    assert.match(row('doc-001').textContent, /No feedback yet/);
    assert.match(row('doc-002').textContent, /Draft feedback · 3 comments/);
    assert.match(row('doc-003').textContent, /Feedback sent to Praxis/);
    assert.match(row('doc-004').textContent, /Feedback delivery failed/);
    assert.equal(row('doc-001').querySelector('a[href^="/task/"]'), null, 'no link back to the task it is already on');
    // The pending number is the server's count for the task: two need review (doc-001, doc-002).
    assert.equal(panel.querySelector('[data-deliverables-pending]').textContent.trim(), '2 awaiting your review');
    assert.match(panel.textContent, /task status and QA verdicts on this page are about the work, not the document/);
  } finally { t.cleanup(); }
});

test('a task with more deliverables than the panel shows links to the full filtered queue', async () => {
  const docs = syntheticRegistry(130).map(d => ({ ...d, task_id: 'task-1' }));
  const t = setup(registryHandler(docs));
  try {
    await settle();
    const panel = t.container.querySelector('[data-review-documents-panel]');
    assert.equal(panel.querySelectorAll('[data-document-id]').length, 50);
    assert.equal(panel.querySelector('[data-deliverables-pending]').textContent.trim(), '104 awaiting your review', 'counted by the server, not from the 50 shown');
    const more = [...panel.querySelectorAll('a')].find(a => /All 130 in Reviews/.test(a.textContent));
    assert.equal(more.getAttribute('href'), '/documents?status=all&task_id=task-1&project_id=p1');
  } finally { t.cleanup(); }
});

test('renders nothing without deliverables and shows a retry on errors', async () => {
  const empty = setup(registryHandler([]));
  try { await settle(); assert.equal(empty.container.innerHTML, ''); } finally { empty.cleanup(); }
  let fail = 'boom';
  const t = setup(registryHandler([entry(9)], { get fail() { return fail; } }));
  try {
    await settle();
    assert.match(t.container.querySelector('[role="alert"]').textContent, /boom/);
    fail = null;
    const retry = [...t.container.querySelectorAll('button')].find(b => /retry/i.test(b.textContent));
    await act(async () => retry.click());
    await settle();
    assert.ok(t.container.querySelector('a[href="/documents/doc-009"]'));
    assert.equal(t.container.querySelector('[role="alert"]'), null);
  } finally { t.cleanup(); }
});

test('on a pre-contract API it still lists the task documents but claims no pending count', async () => {
  const t = setup(registryHandler(taskDocs(), { legacy: true }));
  try {
    await settle();
    const panel = t.container.querySelector('[data-review-documents-panel]');
    assert.equal(panel.querySelectorAll('[data-document-id]').length, 5);
    assert.equal(panel.querySelector('[data-deliverables-pending]'), null);
  } finally { t.cleanup(); }
});
