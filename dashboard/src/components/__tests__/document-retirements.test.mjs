import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';
import { NamedAsReplacedNotice, ReplacesPanel, RetirementBanner } from '../document-review/retirement-panel.tsx';

// Retiring replaced documents on the review page (task d9f46e2f, contract §13): the retired page says what replaced it
// with a link, the replacing page lists what it retired and why anything stayed, and a manual close of 2026-11-18/19
// reads in the same form. Every document, task and response here is synthetic; nothing reaches a real registry.
const CONTENT = ['# Launch brief', '', 'First draft of the launch plan.'].join('\n');
const REVISION = { id: 'rev-1', document_id: 'doc-1', content_hash: 'a'.repeat(64), byte_length: CONTENT.length, line_count: 3, captured_at: '2026-11-19T10:00:00Z' };
const DOCUMENT = { id: 'doc-1', title: 'Launch brief', path: '/private/tmp/synthetic/brief-v1.md', kind: 'document', task_id: 'task-old', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: 'rev-1', created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z', requires_review: false, intended_action: 'send', blocking_task_ids: ['task-waiting'] };
const SOURCE = { task: { id: 'task-old', title: 'Draft the launch brief', status: 'completed', status_message: null, project_id: 'proj-1', updated_at: null }, project: { id: 'proj-1', name: 'Synthetic launch', path: '/private/tmp/synthetic' } };
const LINKS = { review_url: 'https://nexus.example.invalid/documents/doc-1', raw_url: '/api/documents/doc-1/raw' };
const ref = (id, title, status = 'needs_review') => ({ document_id: id, title, exists: true, review_path: `/documents/${id}`, review_status: status });

/** A registration's retirement as GET /api/documents/:id reports it (retirementView in server/routes/documents.js). */
const RETIRED = {
  id: 'rt-1', source: 'replacement', state: 'retired', retired_at: '2026-11-19T15:50:00Z', retired_by: 'praxis-claude-code:test',
  reason: 'Replaced by a later document registered for your review. Moved to Reference without a decision: nothing was approved, no changes were requested and its intended action was not carried out.',
  replaced_by: ref('doc-2', 'Launch brief, rewritten'), replaced_by_revision_id: 'rev-9', registration_id: 'reg-12345678abcd', task_id: 'task-new-0001', task_path: '/task/task-new-0001',
  trigger: 'registration', named_as: { deliverable_key: 'launch-brief-v1' },
  previous: { requires_review: true, review_status: 'needs_review', list_bucket: 'needs_review', blocking_task_ids: ['task-waiting'], intended_action: 'send' },
  reopened_at: null, reopened_by: null, reopened_via: null,
};
/** A manual close (metadata.review_closed) read into the same shape. */
const MANUAL = {
  id: null, source: 'manual', state: 'retired', retired_at: '2026-11-18T21:04:00Z', retired_by: 'praxis-claude-code:manual-close',
  reason: 'Superseded by the rewritten launch brief; closed by hand without review. Not an approval.',
  replaced_by: ref('doc-2', 'Launch brief, rewritten'), replaced_by_revision_id: null, registration_id: null, task_id: null, task_path: null,
  trigger: 'manual', named_as: null, previous: { requires_review: true, intended_action: 'none' }, reopened_at: null, reopened_by: null, reopened_via: null,
};
const name = (over) => ({
  id: 'n-1', source: 'registration', named_as: { deliverable_key: 'k' }, outcome: 'retired', reasons: [], target: null, candidates: [],
  registration_id: 'reg-1', revision_id: 'rev-9', task_id: 'task-new-0001', declared_by: 'praxis', created_at: '2026-11-19T15:50:00Z',
  updated_at: '2026-11-19T15:50:00Z', evaluated_at: '2026-11-19T15:50:00Z', retirement: null, ...over,
});

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
const button = (c, label) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === label);
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = function () {};

function mountPage(read) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://localhost');
    const method = init.method ?? 'GET';
    calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'GET' && u.pathname === '/api/documents/doc-1') {
      return response({ document: DOCUMENT, revision: REVISION, content: CONTENT, file_state: 'ok', file_error: null, source: SOURCE, review: null, review_status: 'reference', links: LINKS, ...read });
    }
    if (method === 'GET' && u.pathname === '/api/documents/review-task-options') return response({ tasks: [] });
    if (method === 'POST' && u.pathname === '/api/documents/doc-1/request-review') return response({ document: { ...DOCUMENT, requires_review: true }, review_status: 'needs_review', blocking_tasks: [], retirement: { ...RETIRED, action: 'reopened', state: 'reopened' }, replaces: [] });
    return response({ error: `unexpected ${method} ${u.pathname}` }, 404);
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentReviewPage, { documentId: 'doc-1', timings: { pollMs: 20, summaryDebounceMs: 20 } })));
  return { container, calls, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

function mount(component, props) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(component, props)));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); } };
}

test('a retired document\'s review page says what replaced it, with a link, when, why and from which task; Move to review queue is the way back (criteria 3, 5)', async () => {
  const t = mountPage({ retirement: RETIRED, retirement_history: [RETIRED], replaces: [], named_as_replaced: [] });
  try {
    await settle();
    const banner = t.container.querySelector('[data-retirement-banner="replacement"]');
    assert.ok(banner, 'the retirement banner is on the page');
    const link = banner.querySelector('[data-retirement-replacement-link="doc-2"]');
    assert.equal(link.getAttribute('href'), '/documents/doc-2');
    assert.equal(link.textContent, 'Launch brief, rewritten');
    assert.match(banner.textContent, /Retired/);
    assert.match(banner.textContent, /Moved to Reference/);
    assert.match(banner.querySelector('[data-retirement-reason]').textContent, /without a decision: nothing was approved, no changes were requested and its intended action was not carried out/);
    assert.equal(banner.querySelector('[data-retirement-task-link]').getAttribute('href'), '/task/task-new-0001');
    assert.match(banner.textContent, /registration reg-1234/);
    assert.match(banner.textContent, /named it by deliverable key launch-brief-v1/);
    assert.match(banner.textContent, /No decision was recorded and nothing was carried out\. Move to review queue \(in the review panel\) puts it back, where it was: Needs your review\./);

    // The existing request-review call, from the review panel: never a decision.
    await click(button(t.container, 'Move to review queue'));
    await click(button(t.container, 'Save review requirements'));
    const reopen = t.calls.find(c => c.method === 'POST' && c.path === '/api/documents/doc-1/request-review');
    assert.ok(reopen, 'request-review was called');
    assert.deepEqual(reopen.body, { blocking_task_ids: ['task-waiting'] });
    assert.ok(!t.calls.some(c => c.path.endsWith('/decisions')), 'no decision is recorded');
  } finally { t.cleanup(); }
});

test('a manual close of 2026-11-18/19 shows its reason and replacement in the same form (criterion 7)', async () => {
  const t = mountPage({ retirement: MANUAL, retirement_history: [MANUAL], replaces: [], named_as_replaced: [] });
  try {
    await settle();
    const banner = t.container.querySelector('[data-retirement-banner="manual"]');
    assert.ok(banner, 'the manual close renders in the retirement banner');
    assert.match(banner.textContent, /Closed by hand/);
    assert.equal(banner.querySelector('[data-retirement-replacement-link="doc-2"]').getAttribute('href'), '/documents/doc-2');
    assert.equal(banner.querySelector('[data-retirement-reason]').textContent, `Reason: ${MANUAL.reason}`);
    assert.equal(banner.querySelector('[data-retirement-task-link]'), null);
    // Same structure as a registration's retirement: the same labelled lines in the same order.
    const lines = b => [...b.querySelectorAll('[data-retirement-replaced-by], [data-retirement-reason]')].map(n => Object.keys(n.dataset)[0]);
    const other = mount(RetirementBanner, { retirement: RETIRED });
    try { assert.deepEqual(lines(banner), lines(other.container)); } finally { other.cleanup(); }
  } finally { t.cleanup(); }
});

test('the replacing document\'s page lists what it retired, and every reason a name retired nothing (criteria 3, 4, 6)', async () => {
  const replaces = [
    name({ id: 'n-1', named_as: { deliverable_key: 'launch-brief-v1' }, outcome: 'retired', target: ref('doc-1', 'Launch brief', 'reference'), retirement: { id: 'rt-1', state: 'retired', retired_at: '2026-11-19T15:50:00Z', trigger: 'registration', reopened_at: null, reopened_by: null, reopened_via: null, reason: null } }),
    name({ id: 'n-2', named_as: { document_id: 'doc-3' }, outcome: 'left_waiting', target: ref('doc-3', 'Launch checklist'), reasons: [
      { code: 'draft_comments', message: 'It has review comments not yet submitted (2 comments in 1 draft); they are never discarded' },
      { code: 'waiting_tasks', message: 'A task is waiting on it: Ship the launch' },
    ] }),
    name({ id: 'n-3', named_as: { deliverable_key: 'no-such-key' }, outcome: 'not_found', reasons: [{ code: 'not_found', message: 'No registered document has this deliverable key; nothing was retired' }] }),
    name({ id: 'n-4', named_as: { path: '/private/tmp/synthetic/shared.md' }, outcome: 'ambiguous', candidates: [ref('doc-5', 'Shared (task A)'), ref('doc-6', 'Shared (task B)')], reasons: [{ code: 'ambiguous', message: 'This path is registered as 2 documents (one per task); name the one it replaces by document id or deliverable key. Nothing was retired' }] }),
    name({ id: null, source: 'manual', named_as: null, outcome: 'retired', target: ref('doc-7', 'Old launch memo', 'reference'), retirement: { id: null, state: 'retired', retired_at: '2026-11-18T21:04:00Z', trigger: 'manual', reopened_at: null, reopened_by: null, reopened_via: null, reason: 'Closed by hand' } }),
  ];
  const t = mountPage({ document: { ...DOCUMENT, id: 'doc-1', requires_review: true }, review_status: 'needs_review', retirement: null, retirement_history: [], replaces, named_as_replaced: [] });
  try {
    await settle();
    assert.equal(t.container.querySelector('[data-retirement-banner]'), null);
    const panel = t.container.querySelector('[data-replaces-panel]');
    assert.ok(panel, 'the replaces panel is on the page');
    assert.match(panel.textContent, /names 5 documents it replaces; 2 moved to Reference/);
    const rows = [...panel.querySelectorAll('[data-replaces-row]')];
    assert.deepEqual(rows.map(r => r.dataset.replacesRow), ['retired', 'left_waiting', 'not_found', 'ambiguous', 'retired']);
    assert.equal(rows[0].querySelector('[data-replaces-target-link="doc-1"]').getAttribute('href'), '/documents/doc-1');
    assert.match(rows[0].textContent, /Moved to Reference/);
    assert.deepEqual([...rows[1].querySelectorAll('[data-reason-code]')].map(n => n.dataset.reasonCode), ['draft_comments', 'waiting_tasks']);
    assert.match(rows[1].textContent, /Left waiting/);
    assert.match(rows[1].textContent, /2 comments in 1 draft/);
    assert.match(rows[2].textContent, /deliverable key no-such-key/);
    assert.match(rows[2].textContent, /No registered document has this deliverable key/);
    assert.equal(rows[3].querySelectorAll('[data-replaces-candidate-link]').length, 2);
    assert.equal(rows[4].dataset.replacesSource, 'manual');
    assert.match(rows[4].textContent, /closed by hand/);
  } finally { t.cleanup(); }
});

test('a document named but left waiting says who named it and why it stays; a pending name says it is not applied yet', () => {
  const items = [
    name({ id: 'n-2', outcome: 'left_waiting', replacing: ref('doc-2', 'Launch brief, rewritten'), reasons: [{ code: 'outgoing_unsent', message: 'It has an outgoing message that is not sent (draft)' }] }),
    name({ id: 'n-8', outcome: 'pending', replacing: ref('doc-9', 'Launch board'), reasons: [{ code: 'replacement_not_ready', message: 'The replacing document is waiting for review but it is not ready to view yet (0/1 required assets servable).' }] }),
  ];
  const t = mount(NamedAsReplacedNotice, { items });
  try {
    const rows = [...t.container.querySelectorAll('[data-named-as-replaced-row]')];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector('[data-named-by-link="doc-2"]').getAttribute('href'), '/documents/doc-2');
    assert.match(rows[0].textContent, /names this document as replaced, but it stays in your queue:/);
    assert.match(rows[0].textContent, /outgoing message that is not sent/);
    assert.match(rows[1].textContent, /Not applied yet/);
    assert.match(rows[1].textContent, /not ready to view yet/);
  } finally { t.cleanup(); }
});

test('nothing renders when the API predates retirements or there is nothing to show', async () => {
  const t = mountPage({ document: { ...DOCUMENT, requires_review: true }, review_status: 'needs_review' });
  try {
    await settle();
    assert.ok(t.container.querySelector('h1'), 'the page rendered');
    assert.equal(t.container.querySelector('[data-retirement-banner], [data-replaces-panel], [data-named-as-replaced]'), null);
  } finally { t.cleanup(); }
  const empty = mount(ReplacesPanel, { replaces: [] });
  try { assert.equal(empty.container.innerHTML, ''); } finally { empty.cleanup(); }
});
