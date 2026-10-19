/**
 * Unsaved review text across a reload (task 1390fc34, 2026-10-19).
 *
 * A "reload" here is an unmount and a fresh mount against the same fake
 * server: exactly what a full Fast Refresh reload of the dev server, a crash
 * or a closed tab does to the page. Storage is jsdom's real localStorage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';
import { reviewDraftKey } from '../../lib/review-drafts.ts';

const CONTENT = ['# Readiness', '', 'Restart survived the drill.', '', '## Gaps', '', '- alerting is manual', '- no runbook'].join('\n');
const CONTENT_2 = ['# Readiness', '', 'Preface added.', '', 'Restart survived the drill.', '', '## Gaps', '', '- alerting is manual', '- no runbook'].join('\n');
const REVISION = { id: 'rev-1', document_id: 'doc-1', content_hash: 'a'.repeat(64), byte_length: CONTENT.length, line_count: 8, captured_at: '2026-10-12T16:11:42Z' };
const REVISION_2 = { id: 'rev-2', document_id: 'doc-1', content_hash: 'b'.repeat(64), byte_length: CONTENT_2.length, line_count: 10, captured_at: '2026-10-19T19:01:57Z' };
const DOCUMENT = { id: 'doc-1', title: 'Launch readiness', path: '/Volumes/Projects/Praxis/docs/reports/r.md', kind: 'report', task_id: null, project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: 'rev-1', created_at: '2026-10-12T16:11:42Z', updated_at: '2026-10-12T16:11:42Z' };
const DOCUMENT_2 = { ...DOCUMENT, id: 'doc-2', title: 'Other brief' };
const SOURCE = { task: null, project: { id: 'proj-1', name: 'Praxis', path: '/Volumes/Projects/Praxis' } };
const links = id => ({ review_url: `https://nexus.vibeshiftai.com/documents/${id}`, raw_url: `/api/documents/${id}/raw` });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
function button(container, label) { return [...container.querySelectorAll('button')].find(b => b.textContent.trim() === label); }
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }
async function type(field, value) {
  await act(async () => {
    const proto = Object.getPrototypeOf(field);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = function () {};
const KEY = reviewDraftKey('doc-1');
const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? 'null');

function makeReview(overrides = {}) {
  return { id: 'review-1', document_id: 'doc-1', revision_id: 'rev-1', reviewer_id: 'local_user', status: 'draft', summary: '', comments: [], pinned_revision: REVISION, document_changed: false, submission: null, created_at: '2026-10-19T19:00:00Z', updated_at: '2026-10-19T19:00:00Z', submitted_at: null, ...overrides };
}

/** In-memory review API. `state.gate` holds every GET of the document until the test releases it; `state.slowComment` holds the comment POST. */
function server(options = {}) {
  const state = { review: options.review ?? null, comments: options.review?.comments ?? [], revision: REVISION, content: CONTENT, viewer: options.viewer === undefined ? { id: 'local_user' } : options.viewer, failNextComment: false, gate: null, slowComment: null, submission: null };
  const calls = [];
  // `legacy`: the API as it was before client ids were reported (the live :4000 until it restarts). The server still
  // stores client ids and dedupes saves on them; it just never echoes them, so the page cannot confirm a save by id.
  const shown = comment => { if (!options.legacy) return comment; const { client_id, ...rest } = comment; void client_id; return rest; };
  const view = () => state.review && { ...state.review, comments: state.comments.map(shown), submission: state.submission };
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    const docMatch = p.match(/^\/api\/documents\/(doc-[12])$/);
    if (method === 'GET' && docMatch) {
      const snapshot = view();
      if (state.gate) await state.gate;
      if (docMatch[1] === 'doc-2') return response({ document: DOCUMENT_2, revision: { ...REVISION, id: 'd2-rev-1', document_id: 'doc-2' }, content: '# Other\n\nShort.', file_state: 'ok', file_error: null, source: SOURCE, review: null, viewer: state.viewer, links: links('doc-2') });
      return response({ document: { ...DOCUMENT, current_revision_id: state.revision.id }, revision: state.revision, content: state.content, file_state: 'ok', file_error: null, source: SOURCE, review: snapshot, viewer: state.viewer, links: links('doc-1') });
    }
    if (method === 'POST' && p === '/api/documents/doc-1/reviews') {
      if (!state.review || state.review.status !== 'draft') { state.review = makeReview({ id: `review-${calls.length}`, revision_id: state.revision.id, pinned_revision: state.revision }); state.comments = []; state.submission = null; }
      return response({ review: view() }, 201);
    }
    const m = p.match(/^\/api\/documents\/reviews\/([^/]+)(.*)$/);
    if (!m) return response({ error: `unexpected ${method} ${p}` }, 404);
    const rest = m[2];
    if (method === 'POST' && rest === '/comments') {
      if (state.failNextComment) { state.failNextComment = false; return response({ error: 'database is locked', code: 'save_failed' }, 503); }
      const existing = state.comments.find(c => c.client_id === body.client_id);
      if (existing) return response({ comment: shown(existing), duplicate: true });
      const comment = { id: `c${state.comments.length + 1}`, review_id: state.review.id, client_id: body.client_id, kind: body.kind, start_line: body.start_line ?? null, end_line: body.end_line ?? null, quote: body.quote ?? null, selection: body.selection ?? null, parent_id: body.parent_id ?? null, body: body.body, created_at: '2026-10-19T19:05:00Z', updated_at: '2026-10-19T19:05:00Z', anchor: body.kind === 'passage' ? { state: 'intact', current_start_line: body.start_line } : { state: 'document' } };
      state.comments.push(comment);
      if (state.slowComment) await state.slowComment;
      return response({ comment: shown(comment) }, 201);
    }
    const commentMatch = rest.match(/^\/comments\/([^/]+)$/);
    if (method === 'PATCH' && commentMatch) {
      const comment = state.comments.find(c => c.id === commentMatch[1]);
      if (body.body !== undefined) comment.body = body.body;
      return response({ comment: { ...comment } });
    }
    if (method === 'PATCH' && rest === '') { state.review = { ...state.review, summary: body.summary }; return response({ review: view() }); }
    if (method === 'GET' && rest === '') return response({ review: view() });
    if (method === 'POST' && rest === '/finish') {
      state.review = { ...state.review, status: 'submitted', summary: body.summary ?? state.review.summary, submitted_at: '2026-10-19T19:10:00Z' };
      state.submission = { id: 'sub-1', review_id: state.review.id, delivery_status: 'delivered', delivery_attempts: 1, next_attempt_at: null, last_error: null, delivered_at: '2026-10-19T19:10:05Z', receipt: null, created_at: '2026-10-19T19:10:00Z', updated_at: '2026-10-19T19:10:05Z' };
      return response({ review: view(), submission: state.submission }, 202);
    }
    return response({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { state, calls, handler };
}

function mount(srv, documentId = 'doc-1') {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => srv.handler(new URL(String(url), 'http://localhost'), init);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = id => act(() => root.render(createElement(DocumentReviewPage, { documentId: id, timings: { pollMs: 1000, summaryDebounceMs: 60_000 } })));
  render(documentId);
  return { container, render, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

function fresh() { window.localStorage.clear(); window.sessionStorage.clear(); }

test('a passage comment being typed survives a reload with its anchor and client id, and saving it clears the draft', async () => {
  fresh();
  const srv = server();
  let t = mount(srv);
  try {
    await settle();
    await click(t.container.querySelector('#L7 [data-block-comment-button]'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Name the on-call owner here.');
    await settle();
    const draft = stored();
    assert.equal(draft.composer.text, 'Name the on-call owner here.');
    assert.deepEqual(draft.composer.block, { start: 7, end: 8 });
    assert.equal(draft.revision_id, 'rev-1');
    assert.equal(draft.reviewer_id, 'local_user');
    assert.equal(draft.review_id, null, 'no review was opened just by typing');
    assert.equal(srv.calls.filter(x => x.method !== 'GET').length, 0, 'typing sends nothing');

    t.cleanup();
    t = mount(srv);
    await settle();
    const composer = t.container.querySelector('[data-composer]');
    assert.ok(composer, 'the composer is back after the reload');
    assert.match(composer.textContent, /Comment on lines 7–8/);
    assert.equal(composer.querySelector('textarea').value, 'Name the on-call owner here.');
    assert.ok(composer.querySelector('[data-composer-restored]'), 'the reader is told it is not saved');
    assert.match(t.container.querySelector('#L7 [data-block-comment-button]').closest('[data-review-block]').className, /bg-cyan-500\/10/, 'the passage is highlighted again');

    await click(button(composer, 'Save comment'));
    const post = srv.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.equal(post.body.client_id, draft.composer.client_id, 'the save carries the id minted before the reload');
    assert.deepEqual([post.body.kind, post.body.start_line, post.body.end_line, post.body.body], ['passage', 7, 8, 'Name the on-call owner here.']);
    assert.match(t.container.querySelector('[data-comment-list]').textContent, /Name the on-call owner here\./);
    assert.equal(window.localStorage.getItem(KEY), null, 'nothing left in storage once the server has it');
  } finally { t.cleanup(); }
});

test('a reply, a comment edit and the summary each come back after a reload bound to the right comment and review', async () => {
  fresh();
  const srv = server({ review: makeReview({ comments: [{ id: 'k1', review_id: 'review-1', client_id: 'c-k1', kind: 'document', start_line: null, end_line: null, quote: null, selection: null, parent_id: null, body: 'Root comment.', created_at: '2026-10-19T19:00:00Z', updated_at: '2026-10-19T19:00:00Z', anchor: { state: 'document' } }], summary: 'Server summary.' }) });
  let t = mount(srv);
  try {
    await settle();
    await click(t.container.querySelector('[data-comment-id="k1"] [data-comment-reply]'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Agreed, and add the date.');
    await settle();
    t.cleanup(); t = mount(srv); await settle();
    let composer = t.container.querySelector('[data-composer]');
    assert.match(composer.textContent, /Reply to Whole document/);
    assert.equal(composer.querySelector('textarea').value, 'Agreed, and add the date.');
    await click(button(composer, 'Cancel'));
    assert.equal(window.localStorage.getItem(KEY), null, 'cancelling discards the draft');

    await click([...t.container.querySelectorAll('[data-comment-id="k1"] button')].find(b => b.textContent.trim() === 'Edit'));
    await type(t.container.querySelector('textarea[aria-label="Edit comment"]'), 'Root comment, with the date.');
    await settle();
    assert.deepEqual(stored().edit, { comment_id: 'k1', base_body: 'Root comment.', text: 'Root comment, with the date.' });
    t.cleanup(); t = mount(srv); await settle();
    const edit = t.container.querySelector('textarea[aria-label="Edit comment"]');
    assert.ok(edit, 'the edit box is open again');
    assert.equal(edit.value, 'Root comment, with the date.');
    await click([...t.container.querySelectorAll('[data-comment-id="k1"] button')].find(b => b.textContent.trim() === 'Save'));
    assert.equal(srv.state.comments[0].body, 'Root comment, with the date.');
    assert.equal(window.localStorage.getItem(KEY), null);

    await type(t.container.querySelector('#review-summary'), 'Server summary. Ship after the runbook lands.');
    await settle();
    assert.deepEqual(stored().summary, { text: 'Server summary. Ship after the runbook lands.', base: 'Server summary.' });
    assert.equal(srv.calls.filter(x => x.method === 'PATCH' && !x.path.includes('/comments')).length, 0, 'the autosave has not fired yet');
    t.cleanup(); t = mount(srv); await settle();
    assert.equal(t.container.querySelector('#review-summary').value, 'Server summary. Ship after the runbook lands.');
    const notice = t.container.querySelector('[data-summary-restored]');
    assert.ok(notice, 'the reader is told the summary is not saved yet');
    await click(button(notice, 'Save now'));
    const patch = srv.calls.find(x => x.method === 'PATCH' && !x.path.includes('/comments'));
    assert.equal(patch.body.summary, 'Server summary. Ship after the runbook lands.');
    assert.equal(t.container.querySelector('[data-summary-restored]'), null);
    assert.equal(window.localStorage.getItem(KEY), null);
  } finally { t.cleanup(); }
});

test('a reload during the save: the comment reached the server, so it is listed once and the draft is gone', async () => {
  fresh();
  const srv = server({ review: makeReview() });
  let t = mount(srv);
  try {
    await settle();
    let release;
    srv.state.slowComment = new Promise(resolve => { release = resolve; });
    await click(button(t.container, 'Add a note about the whole document'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Overall ready, pending the alerting gap.');
    await settle();
    act(() => { button(t.container.querySelector('[data-composer]'), 'Save comment').click(); });
    await settle();
    assert.equal(srv.state.comments.length, 1, 'the server stored the comment while the response was still pending');
    assert.ok(stored().composer, 'the draft is still held until the server acknowledges');
    t.cleanup();
    release();
    t = mount(srv); await settle();
    assert.equal(t.container.querySelector('[data-composer]'), null, 'no composer: the save landed');
    assert.equal(t.container.querySelector('[data-recovered-drafts]'), null);
    assert.equal((t.container.querySelector('[data-comment-list]').textContent.match(/Overall ready, pending the alerting gap\./g) ?? []).length, 1);
    assert.equal(window.localStorage.getItem(KEY), null);
  } finally { t.cleanup(); }
});

test('a document read that started before a save cannot hide the saved comment', async () => {
  fresh();
  const srv = server({ review: makeReview() });
  let release;
  srv.state.gate = new Promise(resolve => { release = resolve; });
  const t = mount(srv);
  try {
    await settle();
    assert.equal(t.container.querySelector('h1').textContent, 'Document', 'the first read is still in flight');
    await click(button(t.container, 'Add a note about the whole document'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Saved before the page finished loading.');
    await settle();
    await click(button(t.container.querySelector('[data-composer]'), 'Save comment'));
    assert.equal(srv.state.comments.length, 1);
    assert.match(t.container.querySelector('[data-comment-list]').textContent, /Saved before the page finished loading\./);
    release();
    await settle(10);
    assert.match(t.container.querySelector('h1').textContent, /Launch readiness/, 'the slow read arrived');
    assert.match(t.container.querySelector('[data-comment-list]').textContent, /Saved before the page finished loading\./, 'its older copy of the review did not replace the saved comment');
    assert.equal(t.container.querySelector('[data-composer]'), null);
  } finally { t.cleanup(); }
});

test('a passage comment typed on one revision is recovered, never moved, when the page comes back on a newer one', async () => {
  fresh();
  const srv = server();
  let t = mount(srv);
  try {
    await settle();
    await click(t.container.querySelector('#L3 [data-block-comment-button]'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Which drill, and when?');
    await settle();
    t.cleanup();
    srv.state.revision = REVISION_2; srv.state.content = CONTENT_2;
    t = mount(srv); await settle();
    assert.equal(t.container.querySelector('[data-composer]'), null, 'no composer: line 3 of rev-1 is not line 3 of rev-2');
    const card = t.container.querySelector('[data-recovered-drafts]');
    assert.ok(card, 'the text is shown as recovered');
    assert.match(card.textContent, /Comment on line 3/);
    assert.match(card.textContent, /earlier revision/);
    assert.equal(card.querySelector('[data-recovered-text]').textContent, 'Which drill, and when?');
    assert.equal(stored().recovered.length, 1, 'recovered text is kept across the next reload too');
    assert.equal(stored().composer, null);
    t.cleanup(); t = mount(srv); await settle();
    assert.ok(t.container.querySelector('[data-recovered-drafts]'), 'still there after another reload');
    await click(button(t.container, 'Use as a note about the whole document'));
    const composer = t.container.querySelector('[data-composer]');
    assert.equal(composer.dataset.composerKind, 'document');
    assert.equal(composer.querySelector('textarea').value, 'Which drill, and when?');
    assert.equal(t.container.querySelector('[data-recovered-drafts]'), null);
    assert.equal(srv.calls.filter(x => x.method !== 'GET').length, 0, 'placing it saves nothing by itself');
    await click(button(composer, 'Cancel'));
    assert.equal(window.localStorage.getItem(KEY), null);

    // Discard is the other way out.
    await click(t.container.querySelector('#L3 [data-block-comment-button]'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Second attempt.');
    await settle();
    t.cleanup();
    srv.state.revision = { ...REVISION_2, id: 'rev-3', content_hash: 'c'.repeat(64) };
    t = mount(srv); await settle();
    await click(button(t.container.querySelector('[data-recovered-drafts]'), 'Discard'));
    assert.equal(t.container.querySelector('[data-recovered-drafts]'), null);
    assert.equal(window.localStorage.getItem(KEY), null);
  } finally { t.cleanup(); }
});

test('a draft stays with its document: another document shows nothing of it, and it is back on return', async () => {
  fresh();
  const srv = server();
  let t = mount(srv);
  try {
    await settle();
    await click(button(t.container, 'Add a note about the whole document'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Belongs to doc-1.');
    await settle();
    await t.render('doc-2'); await settle();
    assert.match(t.container.querySelector('h1').textContent, /Other brief/);
    assert.equal(t.container.querySelector('[data-composer]'), null, 'the composer does not follow the route to another document');
    assert.equal(window.localStorage.getItem(reviewDraftKey('doc-2')), null, 'nothing of doc-1 is written under doc-2');
    assert.equal(stored().composer.text, 'Belongs to doc-1.');
    await t.render('doc-1'); await settle();
    assert.equal(t.container.querySelector('[data-composer] textarea').value, 'Belongs to doc-1.');
    t.cleanup();
    t = mount(srv, 'doc-2'); await settle();
    assert.equal(t.container.querySelector('[data-composer]'), null);
    assert.equal(stored().composer.text, 'Belongs to doc-1.', 'a reload on another document leaves it intact');
  } finally { t.cleanup(); }
});

test('a draft written for another reviewer is left alone, and a failed save keeps text and client id across a reload', async () => {
  fresh();
  window.localStorage.setItem(KEY, JSON.stringify({ document_id: 'doc-1', revision_id: 'rev-1', content_hash: null, reviewer_id: 'someone-else', review_id: null, composer: { client_id: 'c-theirs', kind: 'document', text: 'Not yours.' }, edit: null, summary: null, recovered: [], saved_at: new Date().toISOString() }));
  const srv = server({ review: makeReview() });
  let t = mount(srv);
  try {
    await settle();
    assert.equal(t.container.querySelector('[data-composer]'), null, 'another reviewer\'s text is not shown');
    assert.equal(stored().composer.text, 'Not yours.', 'and not erased');
    t.cleanup();
    fresh();
    t = mount(srv); await settle();
    srv.state.failNextComment = true;
    await click(button(t.container, 'Add a note about the whole document'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Keep me through the failure.');
    await settle();
    await click(button(t.container.querySelector('[data-composer]'), 'Save comment'));
    assert.match(t.container.textContent, /Save failed: database is locked/);
    const clientId = stored().composer.client_id;
    t.cleanup(); t = mount(srv); await settle();
    const composer = t.container.querySelector('[data-composer]');
    assert.equal(composer.querySelector('textarea').value, 'Keep me through the failure.');
    await click(button(composer, 'Save comment'));
    const posts = srv.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.equal(posts.length, 2);
    assert.equal(posts[1].body.client_id, clientId, 'the retry after the reload is the same save');
    assert.equal(window.localStorage.getItem(KEY), null);
  } finally { t.cleanup(); }
});

test('finishing the review clears the stored draft and a finished review turns leftover text into recovered text', async () => {
  fresh();
  const srv = server({ review: makeReview() });
  let t = mount(srv);
  try {
    await settle();
    await type(t.container.querySelector('#review-summary'), 'Ready to ship.');
    await settle();
    assert.equal(stored().summary.text, 'Ready to ship.');
    await click(t.container.querySelector('[data-finish-button]'));
    await click(button(t.container, 'Send to Praxis'));
    assert.equal(srv.state.review.status, 'submitted');
    assert.equal(window.localStorage.getItem(KEY), null, 'nothing unsaved remains once the review is sent');

    window.localStorage.setItem(KEY, JSON.stringify({ document_id: 'doc-1', revision_id: 'rev-1', content_hash: null, reviewer_id: 'local_user', review_id: 'review-1', composer: { client_id: 'c-late', kind: 'document', text: 'Typed before the send.' }, edit: null, summary: null, recovered: [], saved_at: new Date().toISOString() }));
    t.cleanup(); t = mount(srv); await settle();
    assert.equal(t.container.querySelector('[data-composer]'), null);
    const card = t.container.querySelector('[data-recovered-drafts]');
    assert.match(card.textContent, /review that has since been finished/);
    assert.equal(button(card, 'Use as a note about the whole document'), undefined, 'a finished review takes no new comment');
  } finally { t.cleanup(); }
});

/** The 2026-10-19 QA probe: "Please clarify." saved on lines 7-8, typed again on line 3, page reloaded. */
async function saveThenRepeatElsewhere(srv) {
  const t = mount(srv);
  await settle();
  await click(t.container.querySelector('#L7 [data-block-comment-button]'));
  await type(t.container.querySelector('[data-composer] textarea'), 'Please clarify.');
  await click(button(t.container.querySelector('[data-composer]'), 'Save comment'));
  assert.equal(srv.state.comments.length, 1);
  assert.equal(srv.state.comments[0].start_line, 7);
  await click(t.container.querySelector('#L3 [data-block-comment-button]'));
  await type(t.container.querySelector('[data-composer] textarea'), 'Please clarify.');
  await settle();
  const before = stored();
  assert.equal(before.composer.text, 'Please clarify.');
  assert.deepEqual(before.composer.block, { start: 3, end: 3 });
  assert.notEqual(before.composer.client_id, srv.state.comments[0].client_id, 'a second comment has its own client id');
  return { t, before };
}

for (const legacy of [false, true]) {
  test(`the same words saved at another passage do not swallow an unsaved comment after a reload (${legacy ? 'API without client ids' : 'API with client ids'})`, async () => {
    fresh();
    const srv = server({ review: makeReview(), legacy });
    let { t, before } = await saveThenRepeatElsewhere(srv);
    try {
      t.cleanup(); t = mount(srv); await settle();
      const composer = t.container.querySelector('[data-composer]');
      assert.ok(composer, 'the unsaved comment on line 3 is back');
      assert.equal(composer.querySelector('textarea').value, 'Please clarify.');
      assert.ok(composer.querySelector('[data-composer-restored]'));
      assert.equal(composer.querySelector('[data-composer-same-as]'), null, 'the saved comment is at another place, so it is not pointed out as this one');
      assert.equal(stored().composer.client_id, before.composer.client_id, 'the draft kept its own client id');
      assert.deepEqual(stored().composer.block, { start: 3, end: 3 });
      assert.equal(srv.state.comments.length, 1, 'restoring saved nothing');
      await click(button(composer, 'Save comment'));
      assert.equal(srv.state.comments.length, 2, 'saving the restored draft adds the second comment');
      assert.deepEqual(srv.state.comments.map(c => c.start_line), [7, 3]);
      assert.equal(t.container.querySelector('[data-composer]'), null);
      assert.equal(window.localStorage.getItem(KEY), null);
    } finally { t.cleanup(); }
  });
}

test('without client ids from the API a reload during the save keeps the draft, points at the saved twin, and saving again adds nothing', async () => {
  fresh();
  const srv = server({ review: makeReview(), legacy: true });
  let t = mount(srv);
  try {
    await settle();
    let release;
    srv.state.slowComment = new Promise(resolve => { release = resolve; });
    await click(t.container.querySelector('#L7 [data-block-comment-button]'));
    await type(t.container.querySelector('[data-composer] textarea'), 'Please clarify.');
    await settle();
    act(() => { button(t.container.querySelector('[data-composer]'), 'Save comment').click(); });
    await settle();
    assert.equal(srv.state.comments.length, 1, 'the server stored the comment while the response was still pending');
    const clientId = stored().composer.client_id;
    t.cleanup();
    release();
    t = mount(srv); await settle();
    const composer = t.container.querySelector('[data-composer]');
    assert.ok(composer, 'the API could not confirm the save by id, so the draft is kept rather than discarded');
    assert.equal(composer.querySelector('textarea').value, 'Please clarify.');
    assert.equal(composer.querySelector('[data-composer-same-as]')?.dataset.composerSameAs, 'c1', 'the saved comment at the same place is pointed out');
    assert.match(composer.querySelector('[data-composer-restored]').textContent, /A saved comment with the same text is already at this place/);
    assert.equal((t.container.querySelector('[data-comment-list]').textContent.match(/Please clarify\./g) ?? []).length, 1);
    await click(button(composer, 'Save comment'));
    assert.equal(srv.state.comments.length, 1, 'the server deduped the retry on its stored client id');
    assert.equal(srv.calls.filter(c => c.method === 'POST' && c.path.endsWith('/comments')).at(-1).body.client_id, clientId, 'the retry carried the same client id');
    assert.equal(t.container.querySelector('[data-composer]'), null);
    assert.equal((t.container.querySelector('[data-comment-list]').textContent.match(/Please clarify\./g) ?? []).length, 1, 'still listed once');
    assert.equal(window.localStorage.getItem(KEY), null);
  } finally { t.cleanup(); }
});
