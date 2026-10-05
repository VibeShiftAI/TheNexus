import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';
import { decisionNoteDraftKey } from '../../lib/decision-note-draft.ts';

// The 2026-10-04 symptom: Robert finished a review of the vitality memo, the requested change was
// registered as a newer revision, and opening the memo from "Ready for your review" or from its task
// still showed the revision he had reviewed. Synthetic documents only; nothing reaches a real registry.
const CONTENT_1 = ['# Vitality memo', '', 'Scores rest on three studies.', '', '## Limits', '', '- sample sizes are small'].join('\n');
const CONTENT_2 = ['# Vitality memo', '', 'Scores rest on three studies, summarised below.', '', '## Limits', '', '- sample sizes are small', '', 'Provenance: registered after review.'].join('\n');
const CONTENT_3 = `${CONTENT_2}\n\nAddendum: a third revision registered while the page was open.`;
const rev = (id, ch, content, at, documentId = 'doc-1') => ({ id, document_id: documentId, content_hash: ch.repeat(64), byte_length: content.length, line_count: content.split('\n').length, file_mtime: null, captured_at: at });
const REV_1 = rev('rev-1', 'a', CONTENT_1, '2026-10-03T23:39:00Z');
const REV_2 = rev('rev-2', 'b', CONTENT_2, '2026-10-04T18:30:00Z');
const REV_3 = rev('rev-3', 'c', CONTENT_3, '2026-10-04T19:00:00Z');
const BY_ID = { 'rev-1': [REV_1, CONTENT_1], 'rev-2': [REV_2, CONTENT_2], 'rev-3': [REV_3, CONTENT_3] };
const DOC_1 = { id: 'doc-1', title: 'Vitality memo', file: 'vitality.md', byId: BY_ID };
// A second, unrelated deliverable with its own ids, hashes and bytes, so reusing doc-1's response shows up.
const DOC2_CONTENT_1 = ['# Sleep study brief', '', 'Draft scope: two cohorts.'].join('\n');
const DOC2_CONTENT_2 = ['# Sleep study brief', '', 'Final scope: three cohorts, one added after review.'].join('\n');
const DOC_2 = { id: 'doc-2', title: 'Sleep study brief', file: 'sleep-brief.md', byId: {
  'd2-rev-1': [rev('d2-rev-1', 'd', DOC2_CONTENT_1, '2026-10-04T10:00:00Z', 'doc-2'), DOC2_CONTENT_1],
  'd2-rev-2': [rev('d2-rev-2', 'e', DOC2_CONTENT_2, '2026-10-04T12:00:00Z', 'doc-2'), DOC2_CONTENT_2],
} };
const SOURCE = { task: { id: 'task-1', title: 'Research the vitality score', status: 'complete', status_message: null, project_id: 'proj-1', updated_at: null }, project: { id: 'proj-1', name: 'Synthetic', path: '/private/tmp/synthetic' } };
const COMMENT = { id: 'c1', review_id: 'review-1', client_id: 'cl-1', kind: 'passage', start_line: 3, end_line: 3, quote: 'Scores rest on three studies.', selection: null, body: 'Summarise the studies here.', created_at: '2026-10-04T18:05:00Z', updated_at: '2026-10-04T18:05:00Z', anchor: { state: 'orphaned', current_start_line: null } };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
const button = (c, label) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === label);
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }
async function type(field, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = function () {};

/** In-memory documents API: GET /api/documents/:id answers like server/routes/documents.js (latest review, current revision, pinned_content when they differ). */
function server({ review, current = 'rev-2', doc = DOC_1 }) {
  const { id, byId } = doc;
  const base = `/api/documents/${id}`;
  const state = { current, review, decisions: [], comments: review.comments };
  const calls = [];
  const statusOf = () => {
    const latest = state.decisions.at(-1);
    if (!latest || latest.revision_id !== state.current) return 'needs_review';
    return latest.decision === 'approve' ? 'approved' : 'changes_requested';
  };
  const reviewView = () => {
    const changed = state.review.revision_id !== state.current;
    return { ...state.review, comments: state.comments, pinned_revision: byId[state.review.revision_id][0], document_changed: changed, ...(changed ? { pinned_content: byId[state.review.revision_id][1] } : {}) };
  };
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body, cache: init.cache });
    const p = url.pathname;
    const [revision, content] = byId[state.current];
    if (method === 'GET' && p === base) {
      const document = { id, title: doc.title, path: `/private/tmp/synthetic/${doc.file}`, kind: 'research', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: state.current, created_at: Object.values(byId)[0][0].captured_at, updated_at: revision.captured_at, purpose: 'Decide whether the memo is ready', requires_review: true, intended_action: 'none' };
      const latest = state.decisions.at(-1) ?? null;
      return response({ document, revision, content, file_state: 'ok', file_error: null, source: SOURCE, review: reviewView(), review_status: statusOf(), current_decision: latest && { ...latest, applies_to_current_revision: latest.revision_id === state.current }, links: { review_url: `https://nexus.example.test/documents/${id}`, raw_url: `${base}/raw`, review_path: `/documents/${id}` } });
    }
    if (method === 'GET' && p === `${base}/history`) {
      return response({ document_id: id, current_revision_id: state.current, review_status: statusOf(), revisions: Object.values(byId).map(([r]) => r).filter(r => r.id <= state.current), decisions: state.decisions, registrations: [], reviews: [] });
    }
    if (method === 'PATCH' && p === `/api/documents/reviews/${state.review.id}`) {
      state.review = { ...state.review, summary: body.summary };
      return response({ review: reviewView() });
    }
    if (method === 'POST' && p === `${base}/decisions`) {
      if (body.revision_id !== state.current) return response({ error: 'The document changed after the revision you reviewed; reopen it and decide on the current revision', code: 'stale_revision', revision_id: body.revision_id, current_revision: revision }, 409);
      const decision = { id: `dec-${state.decisions.length + 1}`, document_id: id, revision_id: body.revision_id, content_hash: revision.content_hash, decision: body.decision, actor_id: 'local_user', authority: 'access_user', note: body.note ?? '', client_decision_id: body.client_decision_id, intended_action: 'none', created_at: '2026-10-04T19:10:00Z' };
      state.decisions.push(decision);
      return response({ decision, review_status: statusOf(), document: {} }, 201);
    }
    return response({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { state, calls, handler };
}

function mount(srv) {
  window.localStorage.removeItem(decisionNoteDraftKey('doc-1'));
  window.sessionStorage.removeItem(decisionNoteDraftKey('doc-1'));
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => srv.handler(new URL(String(url), 'http://localhost'), init);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // A long autosave delay keeps typed summary text unsaved for the duration of a test.
  act(() => root.render(createElement(DocumentReviewPage, { documentId: 'doc-1', timings: { pollMs: 1000, summaryDebounceMs: 60_000 } })));
  return { container, root, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

const card = c => c.querySelector('[data-decision-card]');
const article = c => c.querySelector('article');
const headerRevision = c => c.querySelector('header').textContent.match(/rev ([0-9a-f]{8})/)?.[1];
// Compared as attribute values: jsdom's selector engine does not match an `&` inside [href="..."].
const downloadHrefs = c => [...c.querySelectorAll('a[href*="/raw"]')].map(a => a.getAttribute('href'));
const decisionCalls = srv => srv.calls.filter(x => x.path === '/api/documents/doc-1/decisions');
const submittedReview = () => ({ id: 'review-1', document_id: 'doc-1', revision_id: 'rev-1', reviewer_id: 'local_user', status: 'submitted', summary: 'Needs a summary of each study.', comments: [COMMENT], submission: null, created_at: '2026-10-04T18:04:00Z', updated_at: '2026-10-04T18:06:00Z', submitted_at: '2026-10-04T18:06:00Z' });
const draftReview = () => ({ ...submittedReview(), status: 'draft', summary: '', submitted_at: null });

test('opening a document whose latest revision was registered after a finished review shows the latest revision, not the reviewed one', async () => {
  const srv = server({ review: submittedReview() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.ok(srv.calls.find(x => x.path === '/api/documents/doc-1').cache === 'no-store', 'the document is read fresh, never from an HTTP cache');
    assert.match(article(c).textContent, /Provenance: registered after review\./, 'the latest registered content is on screen');
    assert.doesNotMatch(article(c).textContent, /Scores rest on three studies\.(?! summarised)/);
    assert.equal(headerRevision(c), 'bbbbbbbb', 'the header names the latest revision');
    assert.match(card(c).textContent, /Records your decision on rev bbbbbbbb/, 'deciding targets the revision on screen');
    assert.equal(card(c).querySelector('[data-decision-blocked]')?.textContent ?? null, null);
    const banner = c.querySelector('[data-changed-banner]');
    assert.match(banner.textContent, /latest revision \(rev bbbbbbbb\)/);
    assert.match(banner.textContent, /you reviewed rev aaaaaaaa/);
    assert.deepEqual(downloadHrefs(c), ['/api/documents/doc-1/raw?download=1'], 'Download serves the latest revision');
    // The finished review keeps its own revision: the comment keeps its original line and quote, flagged honestly.
    const list = c.querySelector('[data-comment-list]');
    assert.match(list.textContent, /Line 3/);
    assert.match(list.textContent, /Scores rest on three studies\./);
    assert.match(list.textContent, /passage no longer in current revision/);
    assert.equal(srv.calls.filter(x => x.method !== 'GET').length, 0, 'opening writes nothing');
  } finally { t.cleanup(); }
});

test('the reviewed revision stays one explicit click away, read-only for decisions, and the latest is one click back', async () => {
  const srv = server({ review: submittedReview() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(button(c, 'View reviewed revision'));
    assert.match(article(c).textContent, /Scores rest on three studies\./);
    assert.doesNotMatch(article(c).textContent, /Provenance: registered after review/);
    assert.equal(headerRevision(c), 'aaaaaaaa');
    assert.match(c.querySelector('[data-changed-banner]').textContent, /viewing rev aaaaaaaa, the revision you reviewed/);
    assert.ok(card(c).querySelector('[data-decision-blocked]'), 'no decision while an older revision is on screen');
    assert.deepEqual(downloadHrefs(c), ['/api/documents/doc-1/raw?revision=rev-1&download=1'], 'Download serves the reviewed bytes');
    await click(button(c, 'View current file'));
    assert.equal(headerRevision(c), 'bbbbbbbb');
    assert.match(card(c).textContent, /Records your decision on rev bbbbbbbb/);
  } finally { t.cleanup(); }
});

test('return navigation after a newer revision is registered opens on that newer revision', async () => {
  // First visit: nothing changed since the review, so the reviewed and latest revisions are the same.
  const srv = server({ review: submittedReview(), current: 'rev-1' });
  let t = mount(srv);
  try {
    await settle();
    assert.equal(headerRevision(t.container), 'aaaaaaaa');
    assert.equal(t.container.querySelector('[data-changed-banner]')?.textContent ?? null, null);
  } finally { t.cleanup(); }
  // Robert leaves (back to the task or the bridge); the requested change is registered as rev-2.
  srv.state.current = 'rev-2';
  t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.equal(headerRevision(c), 'bbbbbbbb', 'coming back shows the newly registered revision');
    assert.match(article(c).textContent, /Provenance: registered after review\./);
    assert.match(card(c).textContent, /Records your decision on rev bbbbbbbb/);
  } finally { t.cleanup(); }
});

test('moving to another document in the same mounted page opens that document on its latest revision, even from the reviewed-revision view', async () => {
  // Each document answers from its own in-memory server under its own id; doc-2 has its own review, revisions and bytes.
  const one = server({ review: submittedReview() });
  const doc2Review = { ...submittedReview(), id: 'review-2', document_id: 'doc-2', revision_id: 'd2-rev-1', summary: 'Scope looks thin.', comments: [] };
  const two = server({ review: doc2Review, current: 'd2-rev-2', doc: DOC_2 });
  const t = mount(one);
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    const parsed = new URL(String(url), 'http://localhost');
    return parsed.pathname.startsWith('/api/documents/doc-2') ? two.handler(parsed, init) : one.handler(parsed, init);
  };
  try {
    await settle();
    const c = t.container;
    await click(button(c, 'View reviewed revision'));
    assert.equal(headerRevision(c), 'aaaaaaaa', 'the reviewed revision is selected before navigating');
    // Same mounted page, new id: what an in-app link from one deliverable to another does.
    act(() => t.root.render(createElement(DocumentReviewPage, { documentId: 'doc-2', timings: { pollMs: 1000, summaryDebounceMs: 60_000 } })));
    await settle();
    assert.ok(two.calls.some(x => x.method === 'GET' && x.path === '/api/documents/doc-2'), 'the second document was loaded');
    assert.equal(headerRevision(c), 'eeeeeeee', 'the next document opens on its own latest revision, not the previous view choice');
    assert.match(article(c).textContent, /Final scope: three cohorts/);
    assert.doesNotMatch(article(c).textContent, /Draft scope|Vitality memo|Provenance: registered after review/, 'neither its reviewed bytes nor the first document are on screen');
    assert.equal(card(c).querySelector('[data-decision-blocked]')?.textContent ?? null, null);
    assert.match(card(c).textContent, /Records your decision on rev eeeeeeee/);
    assert.deepEqual(downloadHrefs(c), ['/api/documents/doc-2/raw?download=1']);
    // Its own reviewed revision is still one explicit click away.
    await click(button(c, 'View reviewed revision'));
    assert.equal(headerRevision(c), 'dddddddd');
    assert.match(article(c).textContent, /Draft scope: two cohorts\./);
  } finally { globalThis.fetch = original; t.cleanup(); }
});

test('an open draft on the older revision keeps its unsaved text and its revision; approval targets the latest on screen and the stale guard still holds', async () => {
  const srv = server({ review: draftReview() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.equal(headerRevision(c), 'bbbbbbbb', 'the draft does not pull the page back to the older revision');
    assert.equal(c.querySelectorAll('[data-block-comment-button]').length, 0, 'the latest revision is not annotated with the older draft');

    // Unsaved draft text: the review summary (autosave not yet fired) and the decision note.
    await type(c.querySelector('textarea#review-summary'), 'Unsaved overall impression.');
    await click(card(c).querySelector('[data-decision-button="approve"]'));
    await type(card(c).querySelector('textarea#decision-note'), 'Approving the revised memo.');

    // Continuing the draft on its own revision is explicit; a passage composer opened there survives the round trip.
    await click(button(c, 'View reviewed revision'));
    assert.equal(headerRevision(c), 'aaaaaaaa');
    await click(c.querySelector('#L3 [data-block-comment-button]'));
    await type(c.querySelector('textarea[aria-label="Comment text"]'), 'Unsaved passage comment.');
    await click(button(c, 'View current file'));
    assert.equal(c.querySelector('textarea#review-summary').value, 'Unsaved overall impression.');
    assert.equal(c.querySelector('textarea[aria-label="Comment text"]').value, 'Unsaved passage comment.');
    assert.equal(srv.calls.filter(x => x.method === 'PATCH' || x.path.endsWith('/comments')).length, 0, 'nothing was saved behind the reader');

    // A third revision is registered while the page is open: the server refuses, nothing is recorded.
    srv.state.current = 'rev-3';
    await click(card(c).querySelector('[data-decision-button="approve"]'));
    assert.equal(card(c).querySelector('textarea#decision-note').value, 'Approving the revised memo.');
    await click(card(c).querySelector('[data-decision-submit]'));
    assert.equal(decisionCalls(srv)[0].body.revision_id, 'rev-2', 'the attempt targeted the revision on screen');
    assert.equal(srv.state.decisions.length, 0, 'the stale guard recorded nothing');
    assert.match(card(c).querySelector('[data-decision-notice="stale"]').textContent, /nothing was recorded/);
    // The reload shows the newest bytes, still without pinning back, and the unsaved text is intact.
    assert.equal(headerRevision(c), 'cccccccc');
    assert.match(article(c).textContent, /Addendum: a third revision registered/);
    assert.equal(c.querySelector('textarea#review-summary').value, 'Unsaved overall impression.');
    assert.equal(c.querySelector('textarea[aria-label="Comment text"]').value, 'Unsaved passage comment.');
    // Only a fresh, deliberate click records, and it records on the revision now on screen.
    assert.equal(card(c).querySelector('[data-decision-confirm]')?.textContent ?? null, null, 'the refused attempt is not resubmitted automatically');
    await click(card(c).querySelector('[data-decision-button="approve"]'));
    await click(card(c).querySelector('[data-decision-submit]'));
    assert.equal(decisionCalls(srv).at(-1).body.revision_id, 'rev-3');
    assert.equal(decisionCalls(srv).at(-1).body.content_hash, 'c'.repeat(64));
    assert.equal(srv.state.decisions.length, 1);
    // The draft review still belongs to the revision it was opened on.
    assert.equal(srv.state.review.revision_id, 'rev-1');
    assert.match(c.querySelector('[data-comment-list]').textContent, /Summarise the studies here\./);
  } finally { t.cleanup(); }
});
