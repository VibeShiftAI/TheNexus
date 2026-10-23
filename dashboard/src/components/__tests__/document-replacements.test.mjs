import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';
import DocumentsPage from '../../app/documents/page.tsx';
import { ProjectDeliverables } from '../project-deliverables.tsx';
import { entry, registryHandler, response, stubFetch } from './document-registry-fake.mjs';

// Versions, the current revision and replacement work (contract §12, task 6b46dcc8). The 2026-10-23 incident: Robert
// requested a change on a report whose source task had completed; nothing linked the request to work, the old delivery
// receipt still presented the stale bytes as current, and his draft round stayed open against a version that was about to
// be replaced. Every document, review and task here is synthetic; nothing reaches a real registry or sends anything.
const V1 = ['# Client install status', '', '| Client | Status |', '| --- | --- |', '| HWC | Pending |'].join('\n');
const V2 = ['# Client install status', '', '| Client | Status |', '| --- | --- |', '| HWC | Installed and verified |'].join('\n');
const rev = (id, ch, content, at, version) => ({ id, document_id: 'doc-1', content_hash: ch.repeat(64), byte_length: content.length, line_count: content.split('\n').length, file_mtime: null, captured_at: at, source: 'registration', version });
const REV_1 = rev('rev-1', 'a', V1, '2026-10-23T13:00:00Z', 1);
const REV_2 = rev('rev-2', 'b', V2, '2026-10-23T15:00:00Z', 2);
const BY_ID = { 'rev-1': [REV_1, V1], 'rev-2': [REV_2, V2] };
const SOURCE = { task: { id: 'task-1', title: 'Report client install status', status: 'complete', status_message: null, project_id: 'proj-1', updated_at: null }, project: { id: 'proj-1', name: 'Synthetic', path: '/private/tmp/synthetic' } };
const COMMENT = { id: 'c1', review_id: 'review-1', client_id: 'cl-1', kind: 'document', start_line: null, end_line: null, quote: null, selection: null, parent_id: null, body: 'The HWC row is out of date.', created_at: '2026-10-23T14:00:00Z', updated_at: '2026-10-23T14:00:00Z', resolved: false, anchor: { state: 'document', current_start_line: null } };

const baseReview = () => ({ id: 'review-1', document_id: 'doc-1', revision_id: 'rev-1', reviewer_id: 'local_user', status: 'draft', summary: '', comments: [COMMENT], submission: null, created_at: '2026-10-23T13:50:00Z', updated_at: '2026-10-23T14:00:00Z', submitted_at: null, closed_at: null, closed_reason: null, replacement_id: null });
const submittedReview = () => ({ ...baseReview(), status: 'submitted', summary: 'Fix the HWC row.', submitted_at: '2026-10-23T14:05:00Z' });
const supersededReview = () => ({ ...baseReview(), status: 'superseded', closed_at: '2026-10-23T14:10:00Z', closed_reason: 'superseded', replacement_id: 'rp-1' });
/** Replacement work as GET /api/documents/:id reports it (replacementView in server/routes/documents.js). */
const replacement = (over = {}) => ({
  id: 'rp-1', document_id: 'doc-1', state: 'running', open: true, terminal: false, detail: null, qa_state: null,
  base_revision_id: 'rev-1', result_revision_id: null, task_id: 'task-2', execution_id: 'exec-1', attempt: 1, recovers_replacement_id: null,
  client_request_id: 'req-1', source: { submission_id: 'sub-1', review_id: 'review-1', decision_id: null, authority: 'access_user', submission_delivery_status: 'delivered' },
  superseded_review_ids: [], accepted_by: 'praxis', created_at: '2026-10-23T14:10:00Z', updated_at: '2026-10-23T14:12:00Z', completed_at: null,
  links: { task_path: '/task/task-2', review_path: '/documents/doc-1', result_raw_path: null, self_path: '/api/documents/doc-1/replacements/rp-1' },
  ...over,
});
const failedReplacement = (over = {}) => replacement({ state: 'failed', open: false, terminal: true, detail: 'Build broke', qa_state: 'failed', completed_at: '2026-10-23T14:40:00Z', ...over });

async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
const button = (c, label) => [...c.querySelectorAll('button')].find(b => (label instanceof RegExp ? label.test(b.textContent.trim()) : b.textContent.trim() === label));
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }
async function type(field, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = function () {};

/** In-memory documents API shaped like server/routes/documents.js after task 6b46dcc8: version, reviewable and replacement on the read, refusals on stale or closed actions. */
function server({ review, current = 'rev-1', replacement: rp = null }) {
  const base = '/api/documents/doc-1';
  const state = { current, review, replacement: rp, decisions: [], created: 0 };
  const calls = [];
  // Open work closes the version; so do the bytes of a failed or cancelled attempt while they are the current revision (contract §12.5).
  const gate = () => (state.replacement && state.replacement.open
    ? { ok: false, reason: 'replacement_in_progress', replacement_id: state.replacement.id }
    : state.replacement && state.replacement.state !== 'ready' && state.replacement.result_revision_id === state.current
      ? { ok: false, reason: 'replacement_failed', replacement_id: state.replacement.id }
      : { ok: true, reason: null, replacement_id: null });
  const statusOf = () => {
    const latest = state.decisions.at(-1);
    if (!latest || latest.revision_id !== state.current) return 'needs_review';
    return latest.decision === 'approve' ? 'approved' : 'changes_requested';
  };
  const reviewView = () => state.review && {
    ...state.review,
    pinned_revision: BY_ID[state.review.revision_id][0],
    document_changed: state.review.revision_id !== state.current,
    ...(state.review.revision_id !== state.current ? { pinned_content: BY_ID[state.review.revision_id][1] } : {}),
    is_current_revision: state.review.revision_id === state.current,
  };
  const refuse = (status, code, error, extra = {}) => response({ error, code, ...extra }, status);
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const p = url.pathname;
    calls.push({ method, path: p, body });
    const [revision, content] = BY_ID[state.current];
    const versions = Object.values(BY_ID).map(([r]) => r).filter(r => r.version <= revision.version);
    if (method === 'GET' && p === base) {
      const document = { id: 'doc-1', title: 'Client install status', path: '/private/tmp/synthetic/client-install-status.md', kind: 'report', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: state.current, created_at: REV_1.captured_at, updated_at: revision.captured_at, purpose: 'Decide whether the install status is accurate', requires_review: true, intended_action: 'none' };
      const latest = state.decisions.at(-1) ?? null;
      return response({
        document, revision, content, file_state: 'ok', file_error: null, source: SOURCE, review: reviewView(), review_status: statusOf(),
        current_decision: latest && { ...latest, applies_to_current_revision: latest.revision_id === state.current },
        replacement: state.replacement, reviewable: gate(),
        version: { current_revision_id: state.current, current_version: revision.version, revision_count: versions.length },
        viewer: { id: 'local_user' },
        links: { review_url: 'https://nexus.example.test/documents/doc-1', raw_url: `${base}/raw`, review_path: '/documents/doc-1' },
      });
    }
    if (method === 'GET' && p === `${base}/history`) {
      const r = state.review;
      return response({
        document_id: 'doc-1', current_revision_id: state.current, review_status: statusOf(), current_version: revision.version, reviewable: gate().ok,
        revisions: versions.map(v => ({ ...v, is_current: v.id === state.current })), decisions: state.decisions, registrations: [], edits: [],
        reviews: r ? [{ id: r.id, revision_id: r.revision_id, reviewer_id: 'local_user', status: r.status, created_at: r.created_at, submitted_at: r.submitted_at, comment_count: r.comments.length, delivery_status: null, closed_at: r.closed_at, closed_reason: r.closed_reason, replacement_id: r.replacement_id, is_current_revision: r.revision_id === state.current }] : [],
        replacements: state.replacement ? [state.replacement] : [],
      });
    }
    if (method === 'POST' && p === `${base}/reviews`) {
      if (body?.revision_id && body.revision_id !== state.current) return refuse(409, 'stale_revision', 'The document has a newer revision than the one on screen; reload to review the current version', { revision_id: body.revision_id, current_revision: revision });
      if (!gate().ok) return refuse(409, gate().reason, 'This version takes no new review: a new version is being produced, or the current bytes are the unaccepted result of a failed attempt', { replacement: state.replacement });
      state.created += 1;
      state.review = { ...baseReview(), id: `review-${state.created + 1}`, revision_id: state.current, comments: [], created_at: '2026-10-23T16:00:00Z', updated_at: '2026-10-23T16:00:00Z' };
      return response({ review: reviewView(), created: true }, 201);
    }
    if (method === 'PATCH' && state.review && p === `/api/documents/reviews/${state.review.id}`) {
      if (state.review.status === 'superseded') return refuse(409, 'review_superseded', 'This review was closed when replacement work on the document was accepted; it takes no further changes', { closed_at: state.review.closed_at, replacement: state.replacement });
      state.review = { ...state.review, summary: body.summary };
      return response({ review: reviewView() });
    }
    if (method === 'POST' && p === `${base}/decisions`) {
      if (!gate().ok) return refuse(409, gate().reason, 'This version takes no decision; nothing was recorded', { replacement: state.replacement });
      if (body.revision_id !== state.current) return refuse(409, 'stale_revision', 'The document changed; decide on the current revision', { revision_id: body.revision_id, current_revision: revision });
      const decision = { id: `dec-${state.decisions.length + 1}`, document_id: 'doc-1', revision_id: body.revision_id, content_hash: revision.content_hash, decision: body.decision, actor_id: 'local_user', authority: 'access_user', note: body.note ?? '', client_decision_id: body.client_decision_id, intended_action: 'none', created_at: '2026-10-23T16:10:00Z' };
      state.decisions.push(decision);
      return response({ decision, review_status: statusOf(), document: {} }, 201);
    }
    return response({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { state, calls, handler };
}

function mount(srv, timings = { pollMs: 60_000, summaryDebounceMs: 60_000 }) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => srv.handler(new URL(String(url), 'http://localhost'), init);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentReviewPage, { documentId: 'doc-1', timings })));
  return { container, root, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

const card = c => c.querySelector('[data-decision-card]');
const writes = srv => srv.calls.filter(x => x.method !== 'GET');

test('a version with replacement work in progress is read-only on the desktop reader: banner with the task, blocked decision, superseded round kept, nothing written', async () => {
  window.localStorage.clear();
  const srv = server({ review: supersededReview(), replacement: replacement() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    const banner = c.querySelector('[data-replacement-banner]');
    assert.equal(banner?.dataset.replacementBanner, 'running');
    assert.match(banner.textContent, /A new version of this document is being produced by revision task task-2/);
    assert.match(banner.textContent, /You are reading the current version \(v1\); it takes no new review, decision or edit/);
    assert.equal(banner.querySelector('[data-replacement-task-link]').getAttribute('href'), '/task/task-2', 'the work is one click away, in-app');
    assert.match(c.querySelector('[data-revision-chip]').textContent, /v1 · rev aaaaaaaa/, 'the header names the version as well as the revision');

    // The decision card explains the closed version instead of offering buttons.
    const cardNode = card(c);
    assert.equal(cardNode.querySelector('[data-decision-blocked]')?.dataset.decisionBlocked, 'replacement_in_progress');
    assert.match(cardNode.querySelector('[data-decision-blocked]').textContent, /takes no decision until the new version is ready/);
    assert.equal(cardNode.querySelectorAll('[data-decision-button]').length, 0, 'no approve or request-changes button');
    assert.equal(cardNode.querySelector('[data-replacement-note]')?.dataset.replacementNote, 'running');
    assert.equal(cardNode.querySelector('[data-replacement-task]').getAttribute('href'), '/task/task-2');

    // The superseded round: readable, closed, nothing to send and no edits.
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'superseded');
    const notice = c.querySelector('[data-review-superseded]');
    assert.equal(notice.dataset.reviewSuperseded, 'rp-1');
    assert.match(notice.textContent, /closed, read-only, when revision work on this document was accepted/);
    assert.match(notice.textContent, /Its 1 comment is kept and was not sent/);
    assert.equal(c.querySelector('[data-finish-button]'), null, 'nothing to finish');
    assert.equal(button(c, /^Start a new review/), undefined, 'no new round on a version being replaced');
    assert.equal(button(c, /^Add a note about the whole/), undefined, 'no new comments either');
    assert.equal(c.querySelector('[data-review-closed]').dataset.reviewClosed, 'replacement_in_progress');
    const list = c.querySelector('[data-comment-list]');
    assert.match(list.textContent, /The HWC row is out of date\./, 'the comment is still readable');
    assert.ok(![...list.querySelectorAll('button')].some(b => /Edit|Delete/.test(b.textContent)), 'comments take no edits');

    // History: versions numbered, the superseded round labelled as such, the work listed with its task.
    await click(cardNode.querySelector('[data-history-toggle]'));
    assert.ok(cardNode.querySelector('[data-history-version="1"]'), 'revisions carry their version number');
    assert.match(cardNode.querySelector('[data-history-feedback="superseded"]').textContent, /superseded .*\(read-only, comments kept\)/);
    const work = cardNode.querySelector('[data-history-replacements]');
    assert.equal(work.querySelector('[data-history-replacement]').dataset.historyReplacement, 'running');
    assert.equal(work.querySelector('[data-history-replacement-task]').getAttribute('href'), '/task/task-2');
    assert.deepEqual(writes(srv), [], 'reading a closed version writes nothing');
  } finally { t.cleanup(); }
});

test('the phone drawer shows the same closed state as the desktop rail', async () => {
  window.localStorage.clear();
  const srv = server({ review: supersededReview(), replacement: replacement({ state: 'held', detail: 'waiting for Robert', attempt: 2 }) });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.querySelector('[data-replacement-banner]').textContent, /Revision held · attempt 2/, 'the banner is in the article, visible on the phone without opening the drawer');
    await click(c.querySelector('[data-open-review]'));
    const drawer = c.querySelector('[data-review-drawer]');
    assert.ok(drawer, 'Review & decide opens the drawer');
    assert.equal(drawer.querySelector('[data-decision-blocked]').dataset.decisionBlocked, 'replacement_in_progress');
    assert.equal(drawer.querySelectorAll('[data-decision-button]').length, 0);
    assert.equal(drawer.querySelector('[data-review-round]').dataset.reviewRound, 'superseded');
    assert.equal(drawer.querySelector('[data-review-closed]').dataset.reviewClosed, 'replacement_in_progress');
    assert.equal(drawer.querySelector('[data-finish-button]'), null);
    assert.equal(drawer.querySelector('[data-replacement-note]').dataset.replacementNote, 'held');
    assert.deepEqual(writes(srv), []);
  } finally { t.cleanup(); }
});

test('a stale tab that starts a new review is refused and shown the current version; the next attempt names that version', async () => {
  window.localStorage.clear();
  const srv = server({ review: submittedReview() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.querySelector('[data-revision-chip]').textContent, /v1 · rev aaaaaaaa/);
    // A new version lands while this tab still shows v1.
    srv.state.current = 'rev-2';
    await click(button(c, /^Start a new review/));
    const attempt = writes(srv).at(-1);
    assert.deepEqual([attempt.path, attempt.body], ['/api/documents/doc-1/reviews', { revision_id: 'rev-1' }], 'the round is asked for the revision on screen, not whatever is current');
    assert.equal(srv.state.created, 0, 'nothing opened');
    const notice = c.querySelector('[data-version-notice]');
    assert.match(notice.textContent, /newer revision than the one on screen/);
    assert.match(notice.textContent, /Nothing was recorded; the page now shows the document as it is\./);
    assert.match(c.querySelector('[data-revision-chip]').textContent, /v2 · rev bbbbbbbb/, 'the page moved to the current version');
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'finished', 'the finished round is still the one shown');
    // Now the tab is current: the round opens on v2.
    await click(button(c, /^Start a new review/));
    assert.deepEqual(writes(srv).at(-1).body, { revision_id: 'rev-2' });
    assert.equal(srv.state.created, 1);
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'draft');
    assert.equal(c.querySelector('[data-version-notice]'), null, 'the notice is cleared once a round opens');
  } finally { t.cleanup(); }
});

test('replacement work accepted while a draft round is open: the next save is refused, the round shows superseded, unsaved text is kept (also across a reload)', async () => {
  window.localStorage.clear();
  const srv = server({ review: baseReview() });
  const t = mount(srv, { pollMs: 60_000, summaryDebounceMs: 10 });
  try {
    await settle();
    const c = t.container;
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'draft');
    assert.ok(c.querySelector('#review-summary'));
    // Praxis accepts replacement work: the server closes this round read-only and the document gains an open replacement.
    srv.state.replacement = replacement();
    srv.state.review = { ...srv.state.review, status: 'superseded', closed_at: '2026-10-23T14:10:00Z', closed_reason: 'superseded', replacement_id: 'rp-1' };
    await type(c.querySelector('#review-summary'), 'HWC is installed and verified; update the row.');
    await settle(60);
    const patch = writes(srv).find(x => x.method === 'PATCH');
    assert.ok(patch, 'the autosave was attempted');
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'superseded', 'the refusal reloads the page into the closed state');
    assert.equal(c.querySelector('#review-summary'), null, 'the closed round takes no more typing');
    assert.match(c.querySelector('[data-unsaved-summary]').textContent, /HWC is installed and verified; update the row\./, 'the typed text is kept on screen');
    assert.equal(c.querySelector('[data-replacement-banner]').dataset.replacementBanner, 'running');
    assert.ok(c.querySelector('[data-review-superseded]'));
    assert.equal(c.querySelector('[data-finish-button]'), null);
    assert.equal(srv.state.created, 0, 'no round was silently reopened');
    assert.equal(srv.calls.filter(x => x.path.endsWith('/finish')).length, 0, 'nothing was sent');
  } finally { t.cleanup(); }
  // The same browser reloads the page: the unsaved summary comes back as recovered text, not restored into a closed round and not dropped.
  const again = mount(srv);
  try {
    await settle();
    const c = again.container;
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'superseded');
    const recovered = c.querySelector('[data-recovered-drafts]');
    assert.ok(recovered, 'unsaved text from before the reload is offered back');
    assert.match(recovered.textContent, /HWC is installed and verified; update the row\./);
    assert.match(recovered.textContent, /finished or superseded/);
    assert.equal(c.querySelector('#review-summary'), null);
  } finally { again.cleanup(); }
});

test('a failed attempt leaves the version current and reviewable with the failure explained; an attempt on an older version is history only', async () => {
  window.localStorage.clear();
  const srv = server({ review: submittedReview(), replacement: failedReplacement() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    const banner = c.querySelector('[data-replacement-banner]');
    assert.equal(banner.dataset.replacementBanner, 'failed');
    assert.match(banner.textContent, /The last attempt to produce a new version failed: Build broke/);
    assert.match(banner.textContent, /This version stays current and reviewable; a retry is a new attempt, never a silent reopening of the old one\./);
    assert.equal(banner.querySelector('[data-replacement-task-link]').getAttribute('href'), '/task/task-2');
    const cardNode = card(c);
    assert.equal(cardNode.querySelector('[data-decision-blocked]'), null, 'decisions are open again');
    assert.ok(cardNode.querySelector('[data-decision-button="approve"]'));
    assert.ok(cardNode.querySelector('[data-decision-button="request_changes"]'));
    assert.equal(cardNode.querySelector('[data-replacement-note]').dataset.replacementNote, 'failed');
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'finished');
    assert.ok(button(c, /^Start a new review/), 'a new round may start on the current version');
    assert.equal(c.querySelector('[data-review-closed]'), null);
  } finally { t.cleanup(); }

  // The failed attempt targeted v1 and registered nothing; once v2 is current it is no longer a banner, only history.
  const later = server({ review: submittedReview(), current: 'rev-2', replacement: failedReplacement() });
  const u = mount(later);
  try {
    await settle();
    const c = u.container;
    assert.equal(c.querySelector('[data-replacement-banner]'), null);
    assert.equal(card(c).querySelector('[data-replacement-note]'), null);
    await click(card(c).querySelector('[data-history-toggle]'));
    assert.equal(card(c).querySelector('[data-history-replacement]').dataset.historyReplacement, 'failed');
  } finally { u.cleanup(); }
});

// QA repair round (2026-10-23): a failed attempt that did register bytes leaves those bytes as the current revision. They were never
// declared ready, so the version is closed (reviewable.reason = replacement_failed) until an explicit recovery delivers a new one,
// and the reader must say so even though the current revision differs from the attempt's base.
test('a failed attempt whose registered bytes are the current version closes it until recovery: banner, blocked decision and no new round, on desktop and in the phone drawer', async () => {
  window.localStorage.clear();
  const closedByFailure = () => server({ review: submittedReview(), current: 'rev-2', replacement: failedReplacement({ result_revision_id: 'rev-2', links: { task_path: '/task/task-2', review_path: '/documents/doc-1', result_raw_path: '/api/documents/doc-1/raw?revision=rev-2', self_path: '/api/documents/doc-1/replacements/rp-1' } }) });
  const srv = closedByFailure();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    const banner = c.querySelector('[data-replacement-banner]');
    assert.equal(banner?.dataset.replacementBanner, 'failed', 'the failure is a banner even though v2, not the base v1, is current');
    assert.match(banner.textContent, /The last attempt to produce a new version failed: Build broke/);
    assert.match(banner.textContent, /You are reading the bytes that attempt registered \(v2\); they were never declared ready, so this version takes no review, decision or edit\./);
    assert.match(banner.textContent, /Review reopens on the new version an explicit recovery delivers, never by reopening this one\./);
    assert.equal(banner.querySelector('[data-replacement-task-link]').getAttribute('href'), '/task/task-2');
    assert.match(c.querySelector('[data-revision-chip]').textContent, /v2 · rev bbbbbbbb/);

    const cardNode = card(c);
    assert.equal(cardNode.querySelector('[data-decision-blocked]')?.dataset.decisionBlocked, 'replacement_failed');
    assert.match(cardNode.querySelector('[data-decision-blocked]').textContent, /registered by a revision attempt that failed and was never declared ready, so it takes no decision/);
    assert.equal(cardNode.querySelectorAll('[data-decision-button]').length, 0, 'no approve or request-changes button on failed bytes');
    const note = cardNode.querySelector('[data-replacement-note]');
    assert.equal(note.dataset.replacementNote, 'failed');
    assert.match(note.textContent, /These bytes are its unaccepted result and take no decision; decisions reopen on the new version an explicit recovery delivers\./);

    // The finished round on v1 stays readable; no new round starts, and the reason is the closure, not work in progress.
    assert.equal(c.querySelector('[data-review-round]').dataset.reviewRound, 'finished');
    assert.equal(button(c, /^Start a new review/), undefined, 'no new round on the unaccepted result');
    assert.equal(c.querySelector('[data-review-closed]').dataset.reviewClosed, 'replacement_failed');
    assert.match(c.querySelector('[data-review-closed]').textContent, /registered by a revision attempt that failed or was cancelled and were never declared ready/);
    await click(cardNode.querySelector('[data-history-toggle]'));
    assert.equal(cardNode.querySelector('[data-history-replacement]').dataset.historyReplacement, 'failed');
    assert.deepEqual(writes(srv), [], 'reading a closed version writes nothing');
  } finally { t.cleanup(); }

  // Phone: the banner sits in the article, and the drawer shows the same closure.
  const phoneSrv = closedByFailure();
  const u = mount(phoneSrv);
  try {
    await settle();
    const c = u.container;
    assert.equal(c.querySelector('[data-replacement-banner]').dataset.replacementBanner, 'failed');
    await click(c.querySelector('[data-open-review]'));
    const drawer = c.querySelector('[data-review-drawer]');
    assert.ok(drawer, 'Review & decide opens the drawer');
    assert.equal(drawer.querySelector('[data-decision-blocked]').dataset.decisionBlocked, 'replacement_failed');
    assert.equal(drawer.querySelectorAll('[data-decision-button]').length, 0);
    assert.equal(drawer.querySelector('[data-review-closed]').dataset.reviewClosed, 'replacement_failed');
    assert.equal(drawer.querySelector('[data-replacement-note]').dataset.replacementNote, 'failed');
    assert.deepEqual(writes(phoneSrv), []);
  } finally { u.cleanup(); }
});

// Lists and counts: a document with open replacement work sits in Being revised, not in its editorial bucket, and its row names the work.
const inProgressRegistry = () => {
  const base = entry(3);
  return [
    entry(1, { review_status: 'needs_review', project_id: 'p1', root_project_id: 'p1' }),
    entry(2, { review_status: 'changes_requested', project_id: 'p2', root_project_id: 'p2' }),
    entry(3, { review_status: 'changes_requested', project_id: 'p1', root_project_id: 'p1', reviewable: false, replacement: { id: 'rp-9', state: 'running', task_id: 'task-9', attempt: 2, open: true }, current_revision: { ...base.current_revision, version: 3 } }),
    entry(4, { review_status: 'approved', project_id: 'p1', root_project_id: 'p1' }),
    entry(5, { review_status: 'reference', requires_review: false, project_id: 'p1', root_project_id: 'p1' }),
    entry(6, { review_status: 'changes_requested', project_id: 'p1', root_project_id: 'p1' }),
  ];
};

function mountQueue(handler, search = '') {
  window.history.replaceState(null, '', `/documents${search}`);
  const stub = stubFetch(handler);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentsPage)));
  return { container, calls: stub.calls, cleanup() { act(() => root.unmount()); container.remove(); stub.restore(); window.history.replaceState(null, '', '/'); } };
}
const tab = (c, key) => c.querySelector(`[data-status-tab="${key}"]`);
const tabCount = (c, key) => tab(c, key).querySelector('[data-status-count]')?.textContent ?? null;
const ids = c => [...c.querySelectorAll('[data-document-id]')].map(li => li.dataset.documentId);

test('the Reviews queue has a Being revised view whose count the other buckets exclude, and the row names the work and the version', async () => {
  const t = mountQueue(registryHandler(inProgressRegistry()), '?status=in_progress');
  try {
    await settle();
    const c = t.container;
    assert.equal(t.calls.filter(x => x.path === '/api/documents').at(-1).query.get('status'), 'in_progress', 'the address bar filter is accepted');
    assert.equal(tab(c, 'in_progress').textContent.replace(/\d+$/, '').trim(), 'Being revised');
    assert.equal(tabCount(c, 'in_progress'), '1');
    assert.equal(tabCount(c, 'changes_requested'), '2', 'the document being revised is not counted as changes requested');
    assert.equal(tabCount(c, 'needs_review'), '1');
    assert.equal(tabCount(c, 'all'), '6', 'all sums the five buckets');
    assert.deepEqual(ids(c), ['doc-003']);
    assert.match(c.querySelector('[data-documents-summary]').textContent, /of 1 · Being revised/);
    const row = c.querySelector('[data-document-id="doc-003"]');
    assert.equal(row.querySelector('[data-replacement-badge]').dataset.replacementBadge, 'running');
    assert.match(row.querySelector('[data-replacement-badge]').textContent, /Revision in progress · attempt 2/);
    assert.match(row.querySelector('[data-document-version]').textContent, /^v3 · rev /);
    assert.equal(row.querySelector('[data-document-status]').dataset.documentStatus, 'changes_requested', 'the editorial state is still shown truthfully');
    await click(tab(c, 'changes_requested'));
    assert.deepEqual(ids(c), ['doc-006', 'doc-002'], 'the version being replaced is not offered for review');
  } finally { t.cleanup(); }
  const empty = mountQueue(registryHandler(inProgressRegistry().filter(d => !d.replacement)), '?status=in_progress');
  try {
    await settle();
    assert.equal(tabCount(empty.container, 'in_progress'), '0');
    assert.match(empty.container.querySelector('[data-documents-empty]').textContent, /No documents are being revised right now\./);
  } finally { empty.cleanup(); }
});

// QA repair round: a document whose current bytes are a failed attempt's unaccepted result lists under Being revised too (open: false);
// its badge and tooltip describe the closure, not work in progress.
test('a Being revised row closed by a failed attempt wears the failed badge and explains the closure, not work in progress', async () => {
  const closed = inProgressRegistry().map(d => (d.id === 'doc-003' ? { ...d, replacement: { id: 'rp-9', state: 'failed', task_id: 'task-9', attempt: 1, open: false } } : d));
  const t = mountQueue(registryHandler(closed), '?status=in_progress');
  try {
    await settle();
    const c = t.container;
    assert.deepEqual(ids(c), ['doc-003'], 'the closed document is listed under Being revised');
    const badge = c.querySelector('[data-document-id="doc-003"] [data-replacement-badge]');
    assert.equal(badge.dataset.replacementBadge, 'failed');
    assert.match(badge.textContent, /Revision failed/);
    assert.match(badge.getAttribute('title'), /never declared ready/);
    assert.match(badge.getAttribute('title'), /explicit recovery/);
    assert.doesNotMatch(badge.getAttribute('title'), /is being produced/);
  } finally { t.cleanup(); }
});

test('project deliverables agree: a Being revised tab with the same count, row and empty state', async () => {
  const stub = stubFetch(registryHandler(inProgressRegistry()));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(ProjectDeliverables, { projectId: 'p1' })));
    await settle();
    assert.equal(tabCount(container, 'in_progress'), '1');
    assert.equal(tabCount(container, 'changes_requested'), '1', 'p1 has one changes-requested document that is not being revised');
    assert.equal(tabCount(container, 'all'), '5');
    await click(tab(container, 'in_progress'));
    assert.equal(stub.calls.filter(x => x.path === '/api/documents').at(-1).query.get('status'), 'in_progress');
    assert.deepEqual(ids(container), ['doc-003']);
    assert.equal(container.querySelector('[data-replacement-badge]').dataset.replacementBadge, 'running');
    assert.match(container.querySelector('[data-document-version]').textContent, /^v3 · rev /);
    // Compared as an attribute value: jsdom's selector engine does not match an `&` inside [href="..."].
    const queueLink = [...container.querySelectorAll('a')].find(a => a.textContent.trim().startsWith('Open in Reviews'));
    assert.equal(queueLink?.getAttribute('href'), '/documents?status=in_progress&project_id=p1', 'the queue link carries the same view');
  } finally { act(() => root.unmount()); container.remove(); stub.restore(); }

  const none = stubFetch(registryHandler(inProgressRegistry().filter(d => !d.replacement)));
  const c2 = document.createElement('div');
  document.body.appendChild(c2);
  const r2 = createRoot(c2);
  try {
    act(() => r2.render(createElement(ProjectDeliverables, { projectId: 'p1' })));
    await settle();
    await click(tab(c2, 'in_progress'));
    assert.match(c2.querySelector('[data-documents-empty]').textContent, /Nothing in this project is being revised right now\./);
  } finally { act(() => r2.unmount()); c2.remove(); none.restore(); }
});
