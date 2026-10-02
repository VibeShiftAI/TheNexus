import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ReadyForReview, ReviewsNavButton, useReviewQueue } from '../ready-for-review.tsx';
import { ProjectDeliverables } from '../project-deliverables.tsx';
import { entry, registryHandler, stubFetch, syntheticRegistry } from './document-registry-fake.mjs';

async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

/** The bridge's two consumers of the queue, wired the way app/page.tsx wires them. */
function Bridge() {
  const queue = useReviewQueue();
  return createElement('div', null,
    createElement('header', null, createElement(ReviewsNavButton, { pending: queue.pending })),
    createElement(ReadyForReview, { queue, projectNames: { p1: 'Synthetic One', p2: 'Synthetic Two' } }));
}

function mount(element, handler) {
  const stub = stubFetch(handler);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, calls: stub.calls, cleanup() { act(() => root.unmount()); container.remove(); stub.restore(); } };
}

test('the bridge header Reviews button and Ready for your review show the server pending count and newest items', async () => {
  const t = mount(createElement(Bridge), registryHandler(syntheticRegistry()));
  try {
    await settle();
    const q = t.calls.find(c => c.path === '/api/documents').query;
    assert.equal(q.get('status'), 'needs_review');
    assert.equal(q.get('limit'), '5');
    const nav = t.container.querySelector('header a[data-reviews-nav]');
    assert.equal(nav.getAttribute('href'), '/documents');
    assert.equal(nav.querySelector('[data-reviews-pending]').textContent, '99+');
    assert.equal(nav.getAttribute('aria-label'), 'Reviews: 104 documents need your review');
    const section = t.container.querySelector('[data-ready-for-review]');
    assert.equal(t.container.querySelector('[data-ready-count]').textContent, '104 pending');
    assert.deepEqual([...section.querySelectorAll('[data-document-id]')].map(li => li.dataset.documentId), ['doc-104', 'doc-103', 'doc-102', 'doc-101', 'doc-100']);
    assert.ok([...section.querySelectorAll('[data-document-status]')].every(b => b.dataset.documentStatus === 'needs_review'));
    assert.equal(section.querySelector('[data-document-id="doc-104"] a[href="/project/p2"]').textContent, 'Synthetic Two');
    assert.match(section.textContent, /and 99 more in Reviews/);
    assert.ok([...t.container.querySelectorAll('a')].every(a => a.getAttribute('href').startsWith('/')), 'every link stays inside the app');
  } finally { t.cleanup(); }
});

test('reference documents never count, and an empty queue says nothing is waiting', async () => {
  const t = mount(createElement(Bridge), registryHandler([entry(1, { review_status: 'reference', requires_review: false }), entry(2, { review_status: 'approved' })]));
  try {
    await settle();
    assert.equal(t.container.querySelector('[data-ready-count]').textContent, '0 pending');
    assert.ok(t.container.querySelector('[data-ready-empty]'));
    assert.equal(t.container.querySelector('[data-reviews-pending]'), null, 'no badge at zero');
    assert.equal(t.container.querySelector('[data-reviews-nav]').getAttribute('aria-label'), 'Reviews: 0 documents need your review');
  } finally { t.cleanup(); }
});

test('loading, error and a pre-contract API are not shown as a count', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = mount(createElement(Bridge), async (url, init) => { await gate; return registryHandler([entry(1)])(url, init); });
  try {
    await settle();
    assert.ok(slow.container.querySelector('[data-ready-loading]'));
    assert.equal(slow.container.querySelector('[data-ready-count]'), null);
    assert.equal(slow.container.querySelector('[data-reviews-nav]').getAttribute('aria-label'), 'Reviews');
    release();
    await settle();
    assert.equal(slow.container.querySelector('[data-ready-count]').textContent, '1 pending');
  } finally { slow.cleanup(); }

  const broken = mount(createElement(Bridge), registryHandler([], { fail: 'database is locked' }));
  try {
    await settle();
    assert.match(broken.container.querySelector('[role="alert"]').textContent, /Could not load reviews: database is locked/);
    assert.equal(broken.container.querySelector('[data-ready-count]'), null);
    assert.equal(broken.container.querySelector('[data-ready-empty]'), null);
    assert.equal(broken.container.querySelector('[data-reviews-pending]'), null);
  } finally { broken.cleanup(); }

  const legacy = mount(createElement(Bridge), registryHandler([entry(1)], { legacy: true }));
  try {
    await settle();
    assert.match(legacy.container.querySelector('[data-ready-for-review] [role="status"]').textContent, /unavailable until the Nexus API restarts/);
    assert.equal(legacy.container.querySelector('[data-ready-count]'), null);
    assert.equal(legacy.container.querySelector('[data-reviews-pending]'), null);
  } finally { legacy.cleanup(); }
});

test('project Deliverables reads the same registry for the project, opens on what needs review and pages', async () => {
  const t = mount(createElement(ProjectDeliverables, { projectId: 'p1' }), registryHandler(syntheticRegistry()));
  try {
    await settle();
    await settle();
    const panel = t.container.querySelector('[data-project-deliverables]');
    const list = t.calls.filter(c => c.path === '/api/documents').at(-1).query;
    assert.equal(list.get('project_id'), 'p1');
    assert.equal(list.get('status'), 'needs_review');
    const count = key => panel.querySelector(`[data-status-tab="${key}"] [data-status-count]`).textContent;
    assert.equal(count('needs_review'), '52');
    assert.equal(count('all'), '65');
    assert.equal(panel.querySelectorAll('[data-document-id]').length, 10);
    assert.ok([...panel.querySelectorAll('a[data-review-link]')].every(a => /^\/documents\/doc-\d+$/.test(a.getAttribute('href'))), 'Open goes to the one shared reviewer');
    assert.equal(panel.querySelector('a[href^="/project/"]'), null, 'no link to the project it is already on');
    const open = [...t.container.querySelectorAll('a')].find(a => /Open in Reviews/.test(a.textContent));
    assert.equal(open.getAttribute('href'), '/documents?status=needs_review&project_id=p1');
    const next = [...panel.querySelectorAll('button')].find(b => b.textContent.trim() === 'Next');
    await act(async () => next.click());
    await settle();
    assert.match(panel.querySelector('[data-documents-pager]').textContent, /11–20 of 52/);
    const all = panel.querySelector('[data-status-tab="all"]');
    await act(async () => all.click());
    await settle();
    assert.match(panel.querySelector('[data-documents-pager]').textContent, /1–10 of 65/);
  } finally { t.cleanup(); }
});

test('project Deliverables opens on All when nothing needs review, and says when there are none', async () => {
  const caughtUp = mount(createElement(ProjectDeliverables, { projectId: 'p1' }), registryHandler([entry(1, { review_status: 'approved' })]));
  try {
    await settle();
    await settle();
    assert.equal(caughtUp.container.querySelector('[data-status-tab="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(caughtUp.container.querySelectorAll('[data-document-id]').length, 1);
  } finally { caughtUp.cleanup(); }
  const none = mount(createElement(ProjectDeliverables, { projectId: 'p1' }), registryHandler([]));
  try {
    await settle();
    await settle();
    assert.match(none.container.querySelector('[data-documents-empty]').textContent, /No registered deliverables for this project yet/);
  } finally { none.cleanup(); }
});

test('project Deliverables steps back when a decision empties the page shown, instead of calling the view empty', async () => {
  // QA repro (task 75de5032): page to the last item, approve it elsewhere,
  // then the poll reloads the old offset and gets an empty page.
  const docs = Array.from({ length: 11 }, (_, i) => entry(i + 1));
  const pollers = [];
  const realSetInterval = window.setInterval;
  window.setInterval = (fn) => { pollers.push(fn); return 0; };
  let hold = null;
  const t = mount(createElement(ProjectDeliverables, { projectId: 'p1' }), async (url, init) => {
    if (hold && url.pathname === '/api/documents' && !url.searchParams.get('offset')) await hold;
    return registryHandler(docs)(url, init);
  });
  const panel = () => t.container.querySelector('[data-project-deliverables]');
  const pending = () => panel().querySelector('[data-status-tab="needs_review"] [data-status-count]').textContent;
  // Compare text, not elements: a failing assert on a jsdom node exhausts the heap serializing it.
  const text = selector => panel().querySelector(selector)?.textContent ?? null;
  const poll = async () => { await act(async () => { pollers.at(-1)(); }); await settle(); await settle(); };
  try {
    await settle();
    await settle();
    const next = [...panel().querySelectorAll('button')].find(b => b.textContent.trim() === 'Next');
    await act(async () => next.click());
    await settle();
    assert.match(panel().querySelector('[data-documents-pager]').textContent, /11–11 of 11/);
    assert.equal(pending(), '11');
    const open = panel().querySelector('a[data-review-link]');
    assert.equal(open.getAttribute('aria-label'), 'Open Synthetic report 001', 'Open names the document it opens');

    docs[0].review_status = 'approved';
    let release;
    hold = new Promise(resolve => { release = resolve; });
    await poll();
    assert.equal(pending(), '10');
    assert.equal(text('[data-documents-empty]'), null, 'never claims nothing needs review while 10 do');
    assert.match(text('[data-documents-stepping-back]') ?? '', /loading the last page of the 10 remaining/);
    assert.equal(t.calls.filter(c => c.path === '/api/documents').at(-1).query.get('offset'), null, 'reloads from the last page that has documents');

    release();
    hold = null;
    await settle();
    await settle();
    const rows = () => [...panel().querySelectorAll('[data-document-id]')].map(li => li.dataset.documentId);
    assert.deepEqual(rows(), ['doc-011', 'doc-010', 'doc-009', 'doc-008', 'doc-007', 'doc-006', 'doc-005', 'doc-004', 'doc-003', 'doc-002']);
    assert.equal(text('[data-documents-empty]'), null);
    assert.equal(text('[data-documents-stepping-back]'), null);
    assert.equal(panel().querySelector('[data-status-tab="needs_review"]').getAttribute('aria-pressed'), 'true');

    await poll();
    assert.equal(rows().length, 10, 'the next poll stays on a page with documents');
    assert.equal(pending(), '10');
  } finally { t.cleanup(); window.setInterval = realSetInterval; }
});

test('Reviews is the first entry of the navigation menu and sits in the bridge header and rail', () => {
  const sidebar = fs.readFileSync(new URL('../nav-sidebar.tsx', import.meta.url), 'utf8');
  const items = sidebar.slice(sidebar.indexOf('const navItems = ['));
  const firstHref = items.match(/href:\s*"([^"]+)"/)[1];
  assert.equal(firstHref, '/documents');
  assert.match(items, /href: "\/documents", label: "Reviews: Documents for Your Decision"/);

  const home = fs.readFileSync(new URL('../../app/page.tsx', import.meta.url), 'utf8');
  const header = home.slice(home.indexOf('<header'), home.indexOf('</header>'));
  assert.match(header, /<ReviewsNavButton pending=\{reviewQueue\.pending\} \/>/, 'header button with the pending count');
  assert.match(home, /id="panel-reviews"[\s\S]*?<ReadyForReview queue=\{reviewQueue\}/, 'rail section on wide screens');
  assert.match(home, /id="panel-reviews-compact"[\s\S]*?<ReadyForReview queue=\{reviewQueue\}/, 'above the stations on narrow screens');
  assert.equal((home.match(/useReviewQueue\(/g) || []).length, 1, 'one query feeds both');
});
