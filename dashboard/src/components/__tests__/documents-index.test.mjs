import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import DocumentsPage from '../../app/documents/page.tsx';
import { entry, registryHandler, response, stubFetch, syntheticRegistry } from './document-registry-fake.mjs';

async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }

function setup(handler, search = '') {
  window.history.replaceState(null, '', `/documents${search}`);
  const stub = stubFetch(handler);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentsPage)));
  return { container, calls: stub.calls, cleanup() { act(() => root.unmount()); container.remove(); stub.restore(); window.history.replaceState(null, '', '/'); } };
}

const listCalls = calls => calls.filter(c => c.path === '/api/documents');
const lastList = calls => listCalls(calls).at(-1).query;
const ids = c => [...c.querySelectorAll('[data-document-id]')].map(li => li.dataset.documentId);
const tab = (c, key) => c.querySelector(`[data-status-tab="${key}"]`);
const tabCount = (c, key) => tab(c, key).querySelector('[data-status-count]')?.textContent ?? null;
const button = (c, label) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === label);
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }
async function choose(select, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle();
}
async function type(field, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('opens on Needs your review with server counts, purpose, version and same-origin Open links', async () => {
  const t = setup(registryHandler(syntheticRegistry()));
  try {
    await settle();
    const q = lastList(t.calls);
    assert.equal(q.get('status'), 'needs_review', 'Needs your review is the default view');
    assert.equal(q.get('limit'), '25');
    assert.equal(tab(t.container, 'needs_review').getAttribute('aria-pressed'), 'true');
    assert.equal(tabCount(t.container, 'needs_review'), '104');
    assert.equal(tabCount(t.container, 'changes_requested'), '10');
    assert.equal(tabCount(t.container, 'approved'), '6');
    assert.equal(tabCount(t.container, 'reference'), '10');
    assert.equal(tabCount(t.container, 'all'), '130');
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /Showing 1–25 of 104 · Needs your review/);
    assert.equal(ids(t.container).length, 25);
    assert.equal(ids(t.container)[0], 'doc-104', 'newest first');

    const row = t.container.querySelector('[data-document-id="doc-104"]');
    assert.match(row.querySelector('[data-document-purpose]').textContent, /Synthetic purpose 104/);
    assert.equal(row.querySelector('[data-document-status]').dataset.documentStatus, 'needs_review');
    assert.match(row.querySelector('[data-document-status]').textContent, /Review pending/);
    assert.match(row.querySelector('[data-document-version]').textContent, /rev 88888888/);
    assert.match(row.querySelector('[data-feedback-state]').textContent, /No feedback yet/);
    const links = [...t.container.querySelectorAll('a[data-review-link]')];
    assert.equal(links[0].getAttribute('href'), '/documents/doc-104');
    assert.ok(links.every(a => a.getAttribute('href').startsWith('/documents/') && a.getAttribute('target') === null), 'relative in-app routes, never a new window');
    assert.ok(![...t.container.querySelectorAll('a')].some(a => /^https?:/.test(a.getAttribute('href'))), 'no absolute (external sign-in) links');
    assert.ok(row.querySelector('a[href="/task/task-2"]'));
    assert.equal(row.querySelector('a[href="/project/p2"]').textContent, 'Synthetic Two');
    assert.ok(t.container.querySelector('a[href="/"]'), 'back to the bridge');
  } finally { t.cleanup(); }
});

test('pages through more than 100 pending documents with truthful counts and reaches every one', async () => {
  const t = setup(registryHandler(syntheticRegistry()));
  try {
    await settle();
    const seen = new Set(ids(t.container));
    for (let page = 2; page <= 5; page++) {
      await click(button(t.container, 'Next'));
      for (const id of ids(t.container)) seen.add(id);
      assert.match(t.container.querySelector('[data-documents-pager]').textContent, new RegExp(`Page ${page} of 5`));
    }
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /Showing 101–104 of 104/);
    assert.equal(button(t.container, 'Next').disabled, true, 'no page past the last');
    assert.equal(seen.size, 104, 'every pending document is reachable');
    assert.equal(lastList(t.calls).get('offset'), '100');
    assert.match(window.location.search, /offset=100/, 'the page survives a reload');
    await click(button(t.container, 'Previous'));
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /Showing 76–100 of 104/);

    // All: 130 documents, reference ones included and not pending.
    await click(tab(t.container, 'all'));
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /Showing 1–25 of 130 · All/);
    assert.equal(lastList(t.calls).get('offset'), null, 'a new view starts at its first page');
    assert.ok(ids(t.container).includes('doc-130'));
    assert.equal(t.container.querySelector('[data-document-id="doc-130"] [data-document-status]').textContent, 'Reference');
    await click(tab(t.container, 'reference'));
    assert.deepEqual(ids(t.container), ['doc-130', 'doc-129', 'doc-128', 'doc-127', 'doc-126', 'doc-125', 'doc-124', 'doc-123', 'doc-122', 'doc-121']);
    assert.equal(tabCount(t.container, 'needs_review'), '104', 'reference documents never count as pending');
  } finally { t.cleanup(); }
});

test('search, project, task and kind filters are applied by the server with matching counts', async () => {
  const t = setup(registryHandler(syntheticRegistry()));
  try {
    await settle();
    await type(t.container.querySelector('input[aria-label="Search documents"]'), 'report 042');
    await settle(400);
    assert.equal(lastList(t.calls).get('q'), 'report 042');
    assert.equal(t.calls.filter(c => c.path === '/api/documents/counts').at(-1).query.get('q'), 'report 042', 'counts use the same search');
    assert.deepEqual(ids(t.container), ['doc-042']);
    assert.equal(tabCount(t.container, 'needs_review'), '1');
    assert.equal(tabCount(t.container, 'all'), '1');
    await click(button(t.container, 'Clear filters'));
    assert.equal(lastList(t.calls).get('q'), null);

    await choose(t.container.querySelector('select[aria-label="Filter by project"]'), 'p2');
    assert.equal(lastList(t.calls).get('project_id'), 'p2');
    assert.equal(tabCount(t.container, 'needs_review'), '52');
    assert.ok(ids(t.container).every(id => Number(id.slice(4)) % 2 === 0), 'only project p2 documents');
    const taskSelect = t.container.querySelector('select[aria-label="Filter by task"]');
    assert.ok(taskSelect, 'task filter appears once a project is chosen');
    await settle();
    await choose(taskSelect, 'task-2');
    assert.equal(lastList(t.calls).get('task_id'), 'task-2');

    await choose(t.container.querySelector('select[aria-label="Filter by kind"]'), 'spec');
    assert.equal(lastList(t.calls).get('kind'), 'spec');
    assert.ok(ids(t.container).every(id => Number(id.slice(4)) % 6 === 0), 'project p2 specs only');
    assert.match(window.location.search, /project_id=p2/);
    assert.match(window.location.search, /kind=spec/);
  } finally { t.cleanup(); }
});

test('filters in the address bar (from task and project links) open the matching view', async () => {
  const t = setup(registryHandler(syntheticRegistry()), '?status=all&task_id=task-1&project_id=p1');
  try {
    await settle();
    const first = listCalls(t.calls)[0].query;
    assert.equal(first.get('status'), 'all');
    assert.equal(first.get('task_id'), 'task-1');
    assert.equal(first.get('project_id'), 'p1');
    assert.equal(tab(t.container, 'all').getAttribute('aria-pressed'), 'true');
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /of 65 · All/);
  } finally { t.cleanup(); }
});

test('loading, error, zero and nothing-pending are distinct states', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = setup(async (url, init) => { await gate; return registryHandler([])(url, init); });
  try {
    await settle();
    assert.ok(slow.container.querySelector('[data-documents-loading]'), 'loading is shown while the first page is in flight');
    assert.equal(slow.container.querySelector('[data-documents-empty]'), null, 'loading is not an empty queue');
    release();
    await settle();
    assert.equal(slow.container.querySelector('[data-documents-loading]'), null);
    assert.match(slow.container.querySelector('[data-documents-empty]').textContent, /No documents registered yet/);
    assert.match(slow.container.querySelector('[data-documents-summary]').textContent, /0 documents/);
  } finally { slow.cleanup(); }

  const caughtUp = setup(registryHandler([entry(1, { review_status: 'approved' }), entry(2, { review_status: 'reference', requires_review: false })]));
  try {
    await settle();
    assert.match(caughtUp.container.querySelector('[data-documents-empty]').textContent, /Nothing is waiting for your review/);
    await click(button(caughtUp.container, 'Show all 2 documents'));
    assert.deepEqual(ids(caughtUp.container), ['doc-002', 'doc-001'], 'reference and approved documents remain under All');
  } finally { caughtUp.cleanup(); }

  let fail = 'database is locked';
  const broken = setup(registryHandler(syntheticRegistry(3), { get fail() { return fail; } }));
  try {
    await settle();
    const alert = broken.container.querySelector('[data-documents-error]');
    assert.match(alert.textContent, /Could not load documents: database is locked/);
    assert.equal(broken.container.querySelector('[data-documents-empty]'), null, 'an error is never shown as an empty queue');
    assert.equal(broken.container.querySelector('[data-documents-summary]'), null, 'no count is claimed on error');
    fail = null;
    await click(button(broken.container, 'Retry'));
    assert.equal(broken.container.querySelector('[data-documents-error]'), null);
    assert.equal(ids(broken.container).length, 3);
  } finally { broken.cleanup(); }

  const noCounts = setup(registryHandler(syntheticRegistry(3), { failCounts: true }));
  try {
    await settle();
    assert.equal(ids(noCounts.container).length, 3);
    assert.equal(tabCount(noCounts.container, 'needs_review'), null, 'a failed count is left blank, never shown as 0');
  } finally { noCounts.cleanup(); }
});

test('a pre-contract API is labelled honestly instead of faking counts or filters', async () => {
  const t = setup(registryHandler(syntheticRegistry(4), { legacy: true }));
  try {
    await settle();
    assert.ok(t.container.querySelector('[data-legacy-notice]'));
    assert.equal(tabCount(t.container, 'needs_review'), null);
    assert.ok(tab(t.container, 'needs_review').disabled);
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /Showing the 4 registered documents this API returned/);
    assert.equal(ids(t.container).length, 4);
    assert.equal(t.container.querySelector('[data-documents-pager]'), null);
  } finally { t.cleanup(); }
});

test('a page emptied by decisions steps back to the last page with documents', async () => {
  let docs = syntheticRegistry(30);
  let hold = null;
  const t = setup(async (url, init) => {
    if (hold && url.pathname === '/api/documents' && !url.searchParams.get('offset')) await hold;
    return registryHandler(docs)(url, init);
  }, '?offset=25');
  try {
    await settle();
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /Showing 26–30 of 30/);
    docs = docs.filter(d => Number(d.id.slice(4)) > 6);
    let release;
    hold = new Promise(resolve => { release = resolve; });
    await click(t.container.querySelector('button[aria-label="Refresh documents"]'));
    await settle();
    // While the step-back request is in flight nothing claims the view is empty.
    assert.equal(t.container.querySelector('[data-documents-empty]')?.textContent ?? null, null);
    assert.match(t.container.querySelector('[data-documents-stepping-back]')?.textContent ?? '', /loading the last page of the 24 remaining/);
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /^24 documents · Needs your review/);
    release();
    hold = null;
    await settle();
    await settle();
    assert.match(t.container.querySelector('[data-documents-summary]').textContent, /Showing 1–24 of 24/);
    assert.equal(t.container.querySelector('[data-documents-stepping-back]')?.textContent ?? null, null);
    assert.equal(t.container.querySelector('[data-documents-empty]'), null);
  } finally { t.cleanup(); }
});

test('the empty-response guard does not misreport a legitimately empty first page', async () => {
  const t = setup(() => response({ documents: [], total: 0, limit: 25, offset: 0, has_more: false, status: 'needs_review' }));
  try {
    await settle();
    assert.ok(t.container.querySelector('[data-documents-empty]'));
  } finally { t.cleanup(); }
});
