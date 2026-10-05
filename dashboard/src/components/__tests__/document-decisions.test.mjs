import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';
import { decisionNoteDraftKey } from '../../lib/decision-note-draft.ts';

// Synthetic document, revisions and decisions only: these tests never reach a real registry.
const CONTENT_1 = ['# Rollout plan', '', 'Ship to the pilot group first.', '', '## Risks', '', '- rollback is manual'].join('\n');
const CONTENT_2 = ['# Rollout plan', '', 'Ship to the pilot group first, then everyone.', '', '## Risks', '', '- rollback is scripted'].join('\n');
const REV_1 = { id: 'rev-1', document_id: 'doc-1', content_hash: 'a'.repeat(64), byte_length: CONTENT_1.length, line_count: 7, file_mtime: null, captured_at: '2026-10-01T10:00:00Z' };
const REV_2 = { id: 'rev-2', document_id: 'doc-1', content_hash: 'b'.repeat(64), byte_length: CONTENT_2.length, line_count: 7, file_mtime: null, captured_at: '2026-10-01T12:00:00Z' };
const SOURCE = { task: { id: 'task-1', title: 'Draft the rollout plan', status: 'complete', status_message: 'QA passed', project_id: 'proj-1', updated_at: null }, project: { id: 'proj-1', name: 'Synthetic', path: '/private/tmp/synthetic' } };
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

/** In-memory documents API with the decision rules of server/routes/documents.js. */
function server(options = {}) {
  const state = {
    revision: REV_1, content: CONTENT_1, revisions: [REV_1], decisions: [], review: options.review ?? null,
    requiresReview: options.requiresReview ?? true, legacy: options.legacy ?? false,
    deny: options.deny ?? null, loseNextDecisionResponse: false,
  };
  const calls = [];
  const statusOf = () => {
    if (!state.requiresReview) return 'reference';
    const latest = state.decisions.at(-1);
    if (!latest || latest.revision_id !== state.revision.id) return 'needs_review';
    return latest.decision === 'approve' ? 'approved' : 'changes_requested';
  };
  const reviewView = () => state.review && {
    ...state.review,
    document_changed: state.review.revision_id !== state.revision.id,
    pinned_revision: REV_1,
    pinned_content: state.review.revision_id !== state.revision.id ? CONTENT_1 : undefined,
  };
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body, headers: init.headers ?? {} });
    const p = url.pathname;
    if (method === 'GET' && p === '/api/documents/doc-1') {
      const document = { id: 'doc-1', title: 'Rollout plan', path: '/private/tmp/synthetic/rollout.md', kind: 'plan', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: state.revision.id, created_at: REV_1.captured_at, updated_at: state.revision.captured_at, purpose: 'Decide whether the rollout can start', requires_review: state.requiresReview, intended_action: 'implement' };
      const latest = state.decisions.at(-1) ?? null;
      const contract = state.legacy ? {} : { review_status: statusOf(), current_decision: latest && { ...latest, applies_to_current_revision: latest.revision_id === state.revision.id } };
      return response({ document, revision: state.revision, content: state.content, file_state: 'ok', file_error: null, source: SOURCE, review: reviewView(), links: { review_url: 'https://nexus.example.test/documents/doc-1', raw_url: '/api/documents/doc-1/raw', review_path: '/documents/doc-1' }, ...contract });
    }
    if (method === 'GET' && p === '/api/documents/doc-1/history') {
      return response({
        document_id: 'doc-1', current_revision_id: state.revision.id, review_status: statusOf(), revisions: state.revisions, decisions: state.decisions, registrations: [],
        reviews: state.review ? [{ id: state.review.id, revision_id: state.review.revision_id, reviewer_id: 'local_user', status: state.review.status, created_at: state.review.created_at, submitted_at: state.review.submitted_at, comment_count: state.review.comments.length, delivery_status: null }] : [],
      });
    }
    if (method === 'POST' && p === '/api/documents/doc-1/decisions') {
      if (state.deny) return response(state.deny.body, state.deny.status);
      const prior = state.decisions.find(d => d.client_decision_id === body.client_decision_id);
      if (prior) return response({ decision: prior, duplicate: true, review_status: statusOf() });
      if (!state.requiresReview) return response({ error: 'This is a reference document; it does not take review decisions', code: 'review_not_required' }, 409);
      if (body.revision_id !== state.revision.id) {
        return response({ error: 'The document changed after the revision you reviewed; reopen it and decide on the current revision', code: 'stale_revision', revision_id: body.revision_id, current_revision: state.revision }, 409);
      }
      const decision = { id: `dec-${state.decisions.length + 1}`, document_id: 'doc-1', revision_id: body.revision_id, content_hash: state.revision.content_hash, decision: body.decision, actor_id: 'local_user', authority: 'access_user', note: body.note ?? '', client_decision_id: body.client_decision_id, intended_action: 'implement', created_at: '2026-10-01T13:00:00Z' };
      state.decisions.push(decision);
      if (state.loseNextDecisionResponse) { state.loseNextDecisionResponse = false; throw new TypeError('Failed to fetch'); }
      return response({ decision, review_status: statusOf(), document: {} }, 201);
    }
    if (method === 'POST' && p === '/api/documents/doc-1/reviews') {
      state.review = state.review ?? { id: 'review-1', document_id: 'doc-1', revision_id: state.revision.id, reviewer_id: 'local_user', status: 'draft', summary: '', comments: [], submission: null, created_at: '2026-10-01T10:05:00Z', updated_at: '2026-10-01T10:05:00Z', submitted_at: null };
      return response({ review: reviewView() }, 201);
    }
    if (method === 'POST' && p === '/api/documents/reviews/review-1/finish') {
      state.review = { ...state.review, status: 'submitted', submitted_at: '2026-10-01T10:10:00Z' };
      const submission = { id: 'sub-1', review_id: 'review-1', delivery_status: 'queued', delivery_attempts: 0, next_attempt_at: null, last_error: null, delivered_at: null, receipt: null, created_at: '2026-10-01T10:10:00Z', updated_at: '2026-10-01T10:10:00Z' };
      state.review.submission = submission;
      return response({ review: reviewView(), submission }, 202);
    }
    if (method === 'GET' && p === '/api/documents/reviews/review-1/submission') return response({ submission: state.review.submission });
    return response({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { state, calls, handler };
}

const DRAFT_KEY = decisionNoteDraftKey('doc-1');
/** `keepDraft` mounts as a reload of the same device would: the stored decision note stays. */
function mount(srv, { keepDraft = false } = {}) {
  if (!keepDraft) {
    window.localStorage.removeItem(DRAFT_KEY);
    window.sessionStorage.removeItem(DRAFT_KEY);
  }
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => srv.handler(new URL(String(url), 'http://localhost'), init);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentReviewPage, { documentId: 'doc-1', timings: { pollMs: 1000, summaryDebounceMs: 20 } })));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

const card = c => c.querySelector('[data-decision-card]');
const decisionCalls = srv => srv.calls.filter(x => x.path === '/api/documents/doc-1/decisions');

test('task status, QA verdict and the document decision are labelled apart; Approve document targets the revision on screen', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    const taskStatus = c.querySelector('[data-task-status]');
    assert.equal(taskStatus.textContent.trim(), 'Task: complete · QA passed');
    const headerBadge = c.querySelector('header [data-document-status]');
    assert.equal(headerBadge.textContent, 'Document: review pending');
    assert.notEqual(headerBadge.className, taskStatus.className, 'different visual treatment');
    assert.equal(card(c).dataset.decisionCard, 'needs_review');
    assert.match(card(c).querySelector('[data-decision-purpose]').textContent, /Decide whether the rollout can start/);
    assert.match(card(c).textContent, /Approval is what allows implementing it/);
    assert.match(card(c).textContent, /Nothing is sent or published from here/);

    await click(card(c).querySelector('[data-decision-button="approve"]'));
    assert.match(card(c).querySelector('[data-decision-confirm]').textContent, /Approve rev aaaaaaaa exactly as shown/);
    await type(card(c).querySelector('textarea#decision-note'), 'Pilot first is right.');
    await click(card(c).querySelector('[data-decision-submit]'));

    const [post] = decisionCalls(srv);
    assert.equal(post.method, 'POST');
    assert.equal(post.body.decision, 'approve');
    assert.equal(post.body.revision_id, 'rev-1');
    assert.equal(post.body.content_hash, 'a'.repeat(64));
    assert.equal(post.body.note, 'Pilot first is right.');
    assert.match(post.body.client_decision_id, /^[A-Za-z0-9_-]{8,}$/);
    assert.match(card(c).querySelector('[data-decision-notice="ok"]').textContent, /Approved rev aaaaaaaa\. Nothing was sent or published\./);
    assert.equal(c.querySelector('header [data-document-status]').textContent, 'Document: approved');
    assert.equal(card(c).dataset.decisionCard, 'approved');
    assert.ok(card(c).querySelector('[data-decision-button="approve"]').disabled, 'already approved on this revision');
    assert.equal(c.querySelector('[data-task-status]').textContent.trim(), 'Task: complete · QA passed', 'the task status is untouched');
    assert.equal(srv.calls.filter(x => /\/finish$|\/reviews$/.test(x.path)).length, 0, 'a decision never finishes or opens a feedback round');
    assert.equal(srv.calls.filter(x => x.method !== 'GET' && x.path !== '/api/documents/doc-1/decisions').length, 0, 'nothing else is written, sent or published');
  } finally { t.cleanup(); }
});

test('a new revision captured while reading turns the decision into a conflict; comments and history persist', async () => {
  const comment = { id: 'c1', review_id: 'review-1', client_id: 'cl-1', kind: 'passage', start_line: 7, end_line: 7, quote: '- rollback is manual', selection: null, body: 'Script the rollback.', created_at: '2026-10-01T10:06:00Z', updated_at: '2026-10-01T10:06:00Z', anchor: { state: 'intact', current_start_line: 7 } };
  const srv = server({ review: { id: 'review-1', document_id: 'doc-1', revision_id: 'rev-1', reviewer_id: 'local_user', status: 'draft', summary: '', comments: [comment], submission: null, created_at: '2026-10-01T10:05:00Z', updated_at: '2026-10-01T10:06:00Z', submitted_at: null } });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    // Producer rewrites the file while Robert reads rev-1.
    srv.state.revision = REV_2;
    srv.state.content = CONTENT_2;
    srv.state.revisions = [REV_1, REV_2];

    await click(card(c).querySelector('[data-decision-button="request_changes"]'));
    assert.match(card(c).querySelector('[data-decision-confirm]').textContent, /To tell Praxis what to change, add comments and use Finish review/);
    await click(card(c).querySelector('[data-decision-submit]'));

    assert.equal(decisionCalls(srv)[0].body.revision_id, 'rev-1', 'the decision targeted the revision that was on screen');
    assert.equal(srv.state.decisions.length, 0, 'nothing was recorded');
    assert.match(card(c).querySelector('[data-decision-notice="stale"]').textContent, /newer revision of this document was captured while you were reading, so nothing was recorded/);
    // The reader reloaded: the changed banner is up, the comment is still there, and the page shows the newer revision.
    assert.ok(c.querySelector('[data-changed-banner]'));
    assert.match(c.querySelector('[data-comment-list]').textContent, /Script the rollback\./);
    assert.match(c.querySelector('article').textContent, /then everyone/, 'the reload opens on the newer revision, not the reviewed one');
    assert.equal(card(c).querySelector('[data-decision-confirm]')?.textContent ?? null, null, 'the refused attempt is not resubmitted');
    await click(button(c, 'View reviewed revision'));
    assert.ok(card(c).querySelector('[data-decision-blocked]'), 'no decision while the pinned (old) revision is on screen');

    await click(button(c, 'View current file'));
    assert.match(c.textContent, /rev bbbbbbbb/);
    await click(card(c).querySelector('[data-decision-button="approve"]'));
    await click(card(c).querySelector('[data-decision-submit]'));
    assert.equal(decisionCalls(srv).at(-1).body.revision_id, 'rev-2');
    assert.equal(decisionCalls(srv).at(-1).body.content_hash, 'b'.repeat(64));
    assert.equal(srv.state.decisions.length, 1);
    assert.notEqual(decisionCalls(srv)[0].body.client_decision_id, decisionCalls(srv).at(-1).body.client_decision_id, 'a refused decision is not replayed under a new revision');

    await click(card(c).querySelector('[data-history-toggle]'));
    await settle();
    const history = card(c).querySelector('[data-document-history]');
    assert.equal(history.querySelectorAll('[data-history-revision]').length, 2);
    assert.match(history.querySelector('[data-history-revision="rev-2"]').textContent, /rev bbbbbbbb[\s\S]*current[\s\S]*Approved/);
    assert.match(history.querySelector('[data-history-revision="rev-1"]').textContent, /Feedback draft · 1 comment/);
    assert.match(c.querySelector('[data-comment-list]').textContent, /Script the rollback\./, 'old comments persist after the decision');
  } finally { t.cleanup(); }
});

test('without an operator session nothing is recorded and the message says where decisions can be made', async () => {
  const srv = server({ deny: { status: 403, body: { error: 'Recording a document decision needs Robert’s verified operator session or operator credential; this request carries neither', code: 'operator_required', reason: 'no_access_assertion' } } });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(card(c).querySelector('[data-decision-button="approve"]'));
    await click(card(c).querySelector('[data-decision-submit]'));
    const notice = card(c).querySelector('[data-decision-notice="error"]');
    assert.match(notice.textContent, /needs Robert’s verified operator session/);
    assert.match(notice.textContent, /Nothing was recorded/);
    assert.match(notice.textContent, /phone or Windows app/);
    assert.equal(card(c).querySelectorAll('a').length, 0, 'no sign-in detour link');
    assert.equal(c.querySelector('header [data-document-status]').textContent, 'Document: review pending');
    assert.ok(card(c).querySelector('[data-decision-confirm]'), 'the confirm stays open for a retry');
  } finally { t.cleanup(); }
});

test('a decision whose response was lost is retried with the same id and answered from the record', async () => {
  const srv = server();
  srv.state.loseNextDecisionResponse = true;
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(card(c).querySelector('[data-decision-button="approve"]'));
    await click(card(c).querySelector('[data-decision-submit]'));
    assert.match(card(c).querySelector('[data-decision-notice="error"]').textContent, /unclear whether the decision was recorded; trying again is safe/);
    await click(card(c).querySelector('[data-decision-submit]'));
    const [first, second] = decisionCalls(srv);
    assert.equal(first.body.client_decision_id, second.body.client_decision_id);
    assert.equal(srv.state.decisions.length, 1, 'recorded once');
    assert.match(card(c).querySelector('[data-decision-notice="ok"]').textContent, /already on record/);
  } finally { t.cleanup(); }
});

test('Finish review sends feedback only: it records no decision and says so', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(c.querySelector('[data-finish-button]'));
    assert.match(c.querySelector('[data-finish-scope]').textContent, /feedback only: it does not approve the document, and nothing goes to anyone else or gets published/);
    await click(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'));
    assert.ok(srv.calls.some(x => x.path === '/api/documents/reviews/review-1/finish'));
    assert.equal(decisionCalls(srv).length, 0, 'finishing never records a decision');
    assert.equal(c.querySelector('header [data-document-status]').textContent, 'Document: review pending');
    assert.ok(c.querySelector('[data-submission-card]'));
  } finally { t.cleanup(); }
});

test('reference documents take no decision, and a pre-contract API offers none', async () => {
  const reference = server({ requiresReview: false });
  const r = mount(reference);
  try {
    await settle();
    assert.equal(card(r.container).dataset.decisionCard, 'reference');
    assert.equal(card(r.container).querySelector('[data-decision-button]'), null);
    assert.match(card(r.container).textContent, /no decision needed/);
  } finally { r.cleanup(); }

  const legacy = server({ legacy: true });
  const l = mount(legacy);
  try {
    await settle();
    assert.equal(card(l.container).dataset.decisionCard, 'unavailable');
    assert.equal(card(l.container).querySelector('[data-decision-button]'), null);
    assert.equal(l.container.querySelector('header [data-document-status]'), null);
    assert.equal(legacy.calls.filter(x => x.path.endsWith('/history')).length, 0);
  } finally { l.cleanup(); }
});

// 2026-10-04 (task a1cc8616): Robert's Request changes on the Best Self Capital brief was refused with
// "The operator credential is not configured; no decision can be recorded with it". His review was
// pinned to an older revision (changed banner up), the decision targeted the current revision, and
// the request carried the shared helper's placeholder bearer, which the server checked instead of
// his session. The client sends no bearer now; a credential-path refusal keeps the note and says what to do.
test('Request changes on the current revision while the review is pinned to an older one: no bearer is sent, a credential refusal keeps the note, and the retry records on that exact revision', async () => {
  const comment = { id: 'c1', review_id: 'review-1', client_id: 'cl-1', kind: 'passage', start_line: 7, end_line: 7, quote: '- rollback is manual', selection: null, body: 'Script the rollback.', created_at: '2026-10-01T10:06:00Z', updated_at: '2026-10-01T10:06:00Z', anchor: { state: 'intact', current_start_line: 7 } };
  const srv = server({ review: { id: 'review-1', document_id: 'doc-1', revision_id: 'rev-1', reviewer_id: 'local_user', status: 'draft', summary: '', comments: [comment], submission: null, created_at: '2026-10-01T10:05:00Z', updated_at: '2026-10-01T10:06:00Z', submitted_at: null } });
  // The producer rewrote the file after the review started; the page opens on the current file.
  srv.state.revision = REV_2;
  srv.state.content = CONTENT_2;
  srv.state.revisions = [REV_1, REV_2];
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.ok(c.querySelector('[data-changed-banner]'), 'the changed banner is up');
    if (card(c).querySelector('[data-decision-blocked]')) await click(button(c, 'View current file'));
    assert.match(card(c).textContent, /Records your decision on rev bbbbbbbb/);

    await click(card(c).querySelector('[data-decision-button="request_changes"]'));
    const note = 'Change the "identity" column in the table below to be a summary of the documents instead of just listing what documents are available.';
    await type(card(c).querySelector('textarea#decision-note'), note);
    srv.state.deny = { status: 503, body: { error: 'The operator credential is not configured; no decision can be recorded with it', code: 'operator_credential_unconfigured', reason: 'assertion-missing' } };
    await click(card(c).querySelector('[data-decision-submit]'));

    const [first] = decisionCalls(srv);
    assert.equal(first.body.revision_id, 'rev-2', 'the decision targets the revision on screen, not the reviewed one');
    assert.equal(first.body.content_hash, 'b'.repeat(64));
    assert.equal(first.body.note, note);
    assert.ok(!Object.keys(first.headers).some(k => k.toLowerCase() === 'authorization'), `no bearer on the decision request (headers: ${Object.keys(first.headers).join(', ')})`);
    const notice = card(c).querySelector('[data-decision-notice="error"]');
    assert.match(notice.textContent, /no operator sign-in/);
    assert.match(notice.textContent, /Nothing was recorded and your note is kept/);
    assert.match(notice.textContent, /phone or Windows app/);
    assert.equal(card(c).querySelector('textarea#decision-note').value, note, 'the typed note survives the refusal');
    assert.equal(srv.state.decisions.length, 0, 'nothing was recorded');
    assert.equal(c.querySelector('header [data-document-status]').textContent, 'Document: review pending');

    // The session is accepted on the retry: same attempt id, same note, same revision.
    srv.state.deny = null;
    await click(card(c).querySelector('[data-decision-submit]'));
    const [, second] = decisionCalls(srv);
    assert.equal(second.body.client_decision_id, first.body.client_decision_id, 'a refusal that recorded nothing is retried as the same attempt');
    assert.equal(second.body.note, note);
    assert.equal(second.body.revision_id, 'rev-2');
    assert.ok(!Object.keys(second.headers).some(k => k.toLowerCase() === 'authorization'));
    assert.equal(srv.state.decisions.length, 1);
    assert.equal(srv.state.decisions[0].revision_id, 'rev-2');
    assert.equal(srv.state.decisions[0].note, note);
    assert.match(card(c).querySelector('[data-decision-notice="ok"]').textContent, /Changes requested rev bbbbbbbb/);
    assert.equal(c.querySelector('header [data-document-status]').textContent, 'Document: changes requested');

    // Nothing moved the feedback: the review and its passage comment stay pinned to rev-1.
    assert.equal(srv.state.review.revision_id, 'rev-1');
    assert.match(c.querySelector('[data-comment-list]').textContent, /Script the rollback\./);
    assert.equal(srv.calls.filter(x => x.method !== 'GET' && x.path !== '/api/documents/doc-1/decisions').length, 0, 'no comment, review or finish call was made or moved');
  } finally { t.cleanup(); }
});

// QA round 1 (2026-10-04) exercised the recovery the refusal recommends: refusal, reload, reopen. The
// note was only in component state and came back empty. It is now kept on the device as it is typed,
// with the revision it was written for and the attempt it belongs to.
const SCREENSHOT_NOTE = 'Change the "identity" column in the table below to be a summary of the documents instead of just listing what documents are available.';
const CREDENTIAL_REFUSAL = { status: 503, body: { error: 'The operator credential is not configured; no decision can be recorded with it', code: 'operator_credential_unconfigured', reason: 'assertion-missing' } };

test('the recovery the refusal recommends keeps the note: after a reload it comes back with its revision and attempt id, and recording it clears it', async () => {
  const srv = server();
  let t = mount(srv);
  try {
    await settle();
    await click(card(t.container).querySelector('[data-decision-button="request_changes"]'));
    await type(card(t.container).querySelector('textarea#decision-note'), SCREENSHOT_NOTE);
    srv.state.deny = CREDENTIAL_REFUSAL;
    await click(card(t.container).querySelector('[data-decision-submit]'));
    const [first] = decisionCalls(srv);
    assert.match(card(t.container).querySelector('[data-decision-notice="error"]').textContent, /your note is kept on this device\. Reload the app and try again/);
    assert.equal(card(t.container).querySelector('textarea#decision-note').value, SCREENSHOT_NOTE);
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_KEY));
    assert.equal(stored.note, SCREENSHOT_NOTE);
    assert.equal(stored.kind, 'request_changes');
    assert.equal(stored.revision_id, 'rev-1');
    assert.equal(stored.origin_revision_id, 'rev-1');
    assert.equal(stored.client_decision_id, first.body.client_decision_id, 'the stored draft belongs to the refused attempt');
  } finally { t.cleanup(); }

  // The reload: everything on the page is gone, the device's storage is not.
  t = mount(srv, { keepDraft: true });
  try {
    await settle();
    const c = t.container;
    const hint = card(c).querySelector('[data-decision-draft="request_changes"]');
    assert.ok(hint, 'the kept note is announced before any button is pressed');
    assert.match(hint.textContent, /Unsaved note from .+, written for rev aaaaaaaa, is kept on this device; open Request changes to continue/);
    assert.equal(card(c).querySelector('textarea#decision-note'), null, 'the confirm panel is closed until reopened');

    await click(card(c).querySelector('[data-decision-button="request_changes"]'));
    assert.equal(card(c).querySelector('textarea#decision-note').value, SCREENSHOT_NOTE, 'the note is back after the reload');
    assert.equal(card(c).querySelector('[data-decision-draft]'), null, 'the announcement folds into the open panel');
    const origin = card(c).querySelector('[data-decision-note-origin="restored"]');
    assert.match(origin.textContent, /Unsaved note restored from .+, written for rev aaaaaaaa\./);

    // The session is accepted now: the retry is the same attempt, same note, same revision.
    srv.state.deny = null;
    await click(card(c).querySelector('[data-decision-submit]'));
    const [first, second] = decisionCalls(srv);
    assert.equal(second.body.client_decision_id, first.body.client_decision_id, 'the attempt resumes after the reload');
    assert.equal(second.body.note, SCREENSHOT_NOTE);
    assert.equal(second.body.revision_id, 'rev-1');
    assert.equal(srv.state.decisions.length, 1);
    assert.equal(srv.state.decisions[0].note, SCREENSHOT_NOTE);
    assert.match(card(c).querySelector('[data-decision-notice="ok"]').textContent, /Changes requested rev aaaaaaaa/);
    assert.equal(window.localStorage.getItem(DRAFT_KEY), null, 'a recorded decision leaves no draft behind');
    assert.equal(card(c).querySelector('[data-decision-draft]'), null);
  } finally { t.cleanup(); }

  t = mount(srv, { keepDraft: true });
  try {
    await settle();
    assert.equal(card(t.container).querySelector('[data-decision-draft]'), null, 'nothing to restore once recorded');
    await click(card(t.container).querySelector('[data-decision-button="approve"]'));
    assert.equal(card(t.container).querySelector('textarea#decision-note').value, '');
  } finally { t.cleanup(); }
});

test('a kept note never moves silently: after the file changed it says which revision it was written for, and the decision targets the revision on screen as a new attempt', async () => {
  const srv = server();
  let t = mount(srv);
  let firstAttemptId;
  try {
    await settle();
    await click(card(t.container).querySelector('[data-decision-button="request_changes"]'));
    await type(card(t.container).querySelector('textarea#decision-note'), SCREENSHOT_NOTE);
    srv.state.deny = CREDENTIAL_REFUSAL;
    await click(card(t.container).querySelector('[data-decision-submit]'));
    firstAttemptId = decisionCalls(srv)[0].body.client_decision_id;
    assert.equal(decisionCalls(srv)[0].body.revision_id, 'rev-1');
  } finally { t.cleanup(); }

  // The producer rewrote the file before the reload; the page opens on the current revision.
  srv.state.revision = REV_2;
  srv.state.content = CONTENT_2;
  srv.state.revisions = [REV_1, REV_2];
  srv.state.deny = null;
  t = mount(srv, { keepDraft: true });
  try {
    await settle();
    const c = t.container;
    assert.match(card(c).textContent, /Records your decision on rev bbbbbbbb/);
    assert.match(card(c).querySelector('[data-decision-draft]').textContent, /written for rev aaaaaaaa/);

    await click(card(c).querySelector('[data-decision-button="request_changes"]'));
    assert.equal(card(c).querySelector('textarea#decision-note').value, SCREENSHOT_NOTE);
    const origin = card(c).querySelector('[data-decision-note-origin="moved"]');
    assert.match(origin.textContent, /written for rev aaaaaaaa; you are now deciding on rev bbbbbbbb, so check that it still applies/);

    await click(card(c).querySelector('[data-decision-submit]'));
    const request = decisionCalls(srv).at(-1);
    assert.equal(request.body.revision_id, 'rev-2', 'the decision names the revision on screen');
    assert.equal(request.body.content_hash, 'b'.repeat(64));
    assert.equal(request.body.note, SCREENSHOT_NOTE);
    assert.notEqual(request.body.client_decision_id, firstAttemptId, 'a different revision is a new attempt, never a replay of the old one');
    assert.equal(srv.state.decisions.length, 1);
    assert.equal(srv.state.decisions[0].revision_id, 'rev-2');
    assert.equal(window.localStorage.getItem(DRAFT_KEY), null);
  } finally { t.cleanup(); }
});

test('Discard note removes the kept note from the device and the card', async () => {
  const srv = server();
  let t = mount(srv);
  try {
    await settle();
    await click(card(t.container).querySelector('[data-decision-button="approve"]'));
    await type(card(t.container).querySelector('textarea#decision-note'), 'Pilot first is right.');
    assert.equal(JSON.parse(window.localStorage.getItem(DRAFT_KEY)).kind, 'approve', 'kept as it is typed, before any save');
    await click(button(card(t.container), 'Cancel'));
    assert.match(card(t.container).querySelector('[data-decision-draft="approve"]').textContent, /open Approve document to continue/);
  } finally { t.cleanup(); }

  t = mount(srv, { keepDraft: true });
  try {
    await settle();
    const c = t.container;
    await click(card(c).querySelector('[data-decision-draft-discard]'));
    assert.equal(window.localStorage.getItem(DRAFT_KEY), null);
    assert.equal(card(c).querySelector('[data-decision-draft]'), null);
    await click(card(c).querySelector('[data-decision-button="approve"]'));
    assert.equal(card(c).querySelector('textarea#decision-note').value, '');
    assert.equal(card(c).querySelector('[data-decision-note-origin]'), null);
    assert.equal(decisionCalls(srv).length, 0, 'discarding records nothing');
  } finally { t.cleanup(); }
});

// QA quota reproduction: follow the recovery instruction through a full page remount.
test('localStorage quota failure falls back to sessionStorage and restores the exact note and attempt after reload', async () => {
  const originalSet = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = function (key, value) {
    if (this === window.localStorage) throw new window.DOMException('quota', 'QuotaExceededError');
    return originalSet.call(this, key, value);
  };
  const srv = server({ deny: CREDENTIAL_REFUSAL });
  let t = mount(srv);
  const note = 'Please preserve this review note.';
  try {
    window.sessionStorage.setItem('quota-probe', 'works');
    assert.equal(window.sessionStorage.getItem('quota-probe'), 'works');
    window.sessionStorage.removeItem('quota-probe');
    await settle();
    await click(card(t.container).querySelector('[data-decision-button="request_changes"]'));
    await type(card(t.container).querySelector('textarea'), note);
    await click(card(t.container).querySelector('[data-decision-submit]'));
    assert.match(card(t.container).querySelector('[data-decision-notice]').textContent, /Reload the app/);
    const first = decisionCalls(srv).at(-1).body;
    t.cleanup();
    t = mount(srv, { keepDraft: true });
    await settle();
    await click(card(t.container).querySelector('[data-decision-button="request_changes"]'));
    assert.equal(card(t.container).querySelector('textarea').value, note);
    assert.equal(window.localStorage.getItem(DRAFT_KEY), null);
    const saved = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY));
    assert.equal(saved.note, note);
    assert.equal(saved.revision_id, first.revision_id);
    assert.equal(saved.content_hash, first.content_hash);
    assert.equal(saved.client_decision_id, first.client_decision_id);
    srv.state.deny = null;
    await click(card(t.container).querySelector('[data-decision-submit]'));
    assert.deepEqual(decisionCalls(srv).at(-1).body, first);
    assert.equal(srv.state.decisions.length, 1);
    assert.equal(window.sessionStorage.getItem(DRAFT_KEY), null, 'recording clears the fallback copy');
  } finally { t.cleanup(); window.Storage.prototype.setItem = originalSet; }
});

for (const code of ['operator_credential_unconfigured', 'authentication_required', 'operator_check_unavailable']) {
  test(`${code}: when both stores fail, keep editable text and require copying before reload`, async () => {
    const originalSet = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function () { throw new window.DOMException('quota', 'QuotaExceededError'); };
    const srv = server({ deny: { status: code === 'authentication_required' ? 401 : 503, body: { error: 'Refused', code } } });
    const t = mount(srv);
    try {
      await settle();
      await click(card(t.container).querySelector('[data-decision-button="request_changes"]'));
      await type(card(t.container).querySelector('textarea'), 'Keep this only in the open page.');
      await click(card(t.container).querySelector('[data-decision-submit]'));
      const notice = card(t.container).querySelector('[data-decision-notice]').textContent;
      assert.match(notice, /[Cc]opy your note before reloading/);
      assert.doesNotMatch(notice, /kept on this device/);
      assert.equal(card(t.container).querySelector('textarea').value, 'Keep this only in the open page.');
      assert.equal(window.localStorage.getItem(DRAFT_KEY), null);
      assert.equal(window.sessionStorage.getItem(DRAFT_KEY), null);
      await type(card(t.container).querySelector('textarea'), 'Edited without leaving.');
      srv.state.deny = null;
      await click(card(t.container).querySelector('[data-decision-submit]'));
      assert.equal(srv.state.decisions[0].note, 'Edited without leaving.');
    } finally { t.cleanup(); window.Storage.prototype.setItem = originalSet; }
  });
}

// An optional absent note is not a failed storage write (QA repair attempt 2).
for (const code of ['operator_credential_unconfigured', 'authentication_required', 'operator_check_unavailable']) {
  for (const kind of ['approve', 'request_changes']) {
    for (const scenario of ['empty', 'whitespace', 'cleared-persisted', 'cleared-unpersisted']) {
      test(`${code} ${kind} ${scenario}: no-note refusal gives recovery without storage or note claims`, async () => {
        const originalSet = window.Storage.prototype.setItem;
        window.localStorage.setItem('healthy-probe', 'works');
        assert.equal(window.localStorage.getItem('healthy-probe'), 'works');
        window.localStorage.removeItem('healthy-probe');
        if (scenario === 'cleared-unpersisted') {
          window.Storage.prototype.setItem = function () { throw new window.DOMException('quota', 'QuotaExceededError'); };
        }
        const srv = server({ deny: { status: code === 'authentication_required' ? 401 : 503, body: { code, reason: 'assertion-missing' } } });
        const t = mount(srv);
        try {
          await settle();
          await click(card(t.container).querySelector(`[data-decision-button="${kind}"]`));
          if (scenario.startsWith('cleared-')) {
            await type(card(t.container).querySelector('textarea'), 'A note I chose to remove.');
            await click(card(t.container).querySelector('[data-decision-submit]'));
            const prior = card(t.container).querySelector('[data-decision-notice]').textContent;
            if (scenario === 'cleared-unpersisted') assert.match(prior, /Copy your note/);
            else assert.match(prior, /note is kept on this device/);
            await type(card(t.container).querySelector('textarea'), '');
          } else if (scenario === 'whitespace') {
            await type(card(t.container).querySelector('textarea'), '   ');
          }
          await click(card(t.container).querySelector('[data-decision-submit]'));
          const notice = card(t.container).querySelector('[data-decision-notice]').textContent;
          assert.doesNotMatch(notice, /note|storage/i, 'there is no note to preserve or copy');
          assert.match(notice, code === 'operator_check_unavailable' ? /try again in a moment/i : /Reload the app/);
          assert.equal(decisionCalls(srv).at(-1).body.note, undefined);
          assert.equal(card(t.container).querySelector('[data-decision-storage-warning]'), null);
          assert.equal(window.localStorage.getItem(DRAFT_KEY), null);
          assert.equal(window.sessionStorage.getItem(DRAFT_KEY), null);
          assert.equal(srv.state.decisions.length, 0);
        } finally { t.cleanup(); window.Storage.prototype.setItem = originalSet; }
      });
    }
  }
}

test('a restored note becomes unpersisted when its next write fails in both stores', async () => {
  const srv = server({ deny: CREDENTIAL_REFUSAL });
  const originalSet = window.Storage.prototype.setItem;
  let t = mount(srv);
  try {
    await settle();
    await click(card(t.container).querySelector('[data-decision-button="request_changes"]'));
    await type(card(t.container).querySelector('textarea'), 'Originally persisted note.');
    const saved = JSON.parse(window.localStorage.getItem(DRAFT_KEY));
    t.cleanup();
    t = mount(srv, { keepDraft: true });
    await settle();
    await click(card(t.container).querySelector('[data-decision-button="request_changes"]'));
    assert.equal(card(t.container).querySelector('textarea').value, saved.note);
    assert.ok(card(t.container).querySelector('[data-decision-note-origin="restored"]'));
    await click(card(t.container).querySelector('[data-decision-submit]'));
    assert.match(card(t.container).querySelector('[data-decision-notice]').textContent, /note is kept on this device/);

    window.Storage.prototype.setItem = function () { throw new window.DOMException('quota', 'QuotaExceededError'); };
    await type(card(t.container).querySelector('textarea'), 'Restored note with an unsaved edit.');
    await click(card(t.container).querySelector('[data-decision-submit]'));
    const notice = card(t.container).querySelector('[data-decision-notice]').textContent;
    assert.match(notice, /Copy your note before reloading/);
    assert.doesNotMatch(notice, /kept on this device/);
    assert.equal(card(t.container).querySelector('textarea').value, 'Restored note with an unsaved edit.');
    assert.equal(JSON.parse(window.localStorage.getItem(DRAFT_KEY)).note, saved.note, 'only the older note was persisted');
    assert.equal(window.sessionStorage.getItem(DRAFT_KEY), null);
    const request = decisionCalls(srv).at(-1).body;
    assert.equal(request.note, 'Restored note with an unsaved edit.');
    assert.equal(request.revision_id, saved.revision_id);
    assert.equal(request.client_decision_id, saved.client_decision_id);
  } finally { t.cleanup(); window.Storage.prototype.setItem = originalSet; }
});
