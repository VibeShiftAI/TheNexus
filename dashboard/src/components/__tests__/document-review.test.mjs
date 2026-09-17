import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';

const CONTENT = ['# Readiness', '', 'Restart survived the drill.', '', '## Gaps', '', '- alerting is manual', '- no runbook'].join('\n');
const REVISION = { id: 'rev-1', document_id: 'doc-1', content_hash: 'a'.repeat(64), byte_length: CONTENT.length, line_count: 8, captured_at: '2026-09-10T10:00:00Z' };
const DOCUMENT = { id: 'doc-1', title: 'Reliability readiness', path: '/Volumes/Projects/Praxis/docs/reports/r.md', kind: 'report', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: { as_of: '2026-09-10' }, current_revision_id: 'rev-1', created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z' };
const SOURCE = { task: { id: 'task-1', title: 'Verify repairs', status: 'completed', status_message: 'QA passed (cross-executor review)', project_id: 'proj-1', updated_at: null }, project: { id: 'proj-1', name: 'Praxis', path: '/Volumes/Projects/Praxis' } };
const LINKS = { review_url: 'https://nexus.vibeshiftai.com/documents/doc-1', raw_url: '/api/documents/doc-1/raw' };
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

function makeReview(overrides = {}) {
  return { id: 'rev-A', document_id: 'doc-1', revision_id: 'rev-1', reviewer_id: 'local_user', status: 'draft', summary: '', comments: [], pinned_revision: REVISION, document_changed: false, submission: null, created_at: '2026-09-10T10:05:00Z', updated_at: '2026-09-10T10:05:00Z', submitted_at: null, ...overrides };
}

/** Minimal in-memory server that mirrors the review API the page talks to. */
function server(options = {}) {
  const state = { review: options.review ?? null, comments: options.review?.comments ?? [], submission: options.review?.submission ?? null, failNextComment: false, failNextFinish: options.failNextFinish ?? null, loseFinishResponse: options.loseFinishResponse ?? false, deliveredAfterPolls: options.deliveredAfterPolls ?? 1, polls: 0 };
  const calls = [];
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    if (method === 'GET' && p === '/api/documents/doc-1') {
      return response({ document: DOCUMENT, revision: REVISION, content: options.content ?? CONTENT, file_state: 'ok', file_error: null, source: SOURCE, review: state.review, links: LINKS });
    }
    if (method === 'POST' && p === '/api/documents/doc-1/reviews') {
      if (!state.review || state.review.status !== 'draft') { state.review = makeReview({ id: `rev-${calls.length}` }); state.comments = []; state.submission = null; }
      return response({ review: { ...state.review, comments: state.comments, submission: state.submission } }, 201);
    }
    const m = p.match(/^\/api\/documents\/reviews\/([^/]+)(.*)$/);
    if (!m) return response({ error: `unexpected ${method} ${p}` }, 404);
    const rest = m[2];
    if (method === 'POST' && rest === '/comments') {
      if (state.failNextComment) { state.failNextComment = false; return response({ error: 'database is locked', code: 'save_failed' }, 503); }
      const existing = state.comments.find(c => c.client_id === body.client_id);
      if (existing) return response({ comment: existing, duplicate: true });
      const comment = { id: `c${state.comments.length + 1}`, review_id: state.review.id, client_id: body.client_id, kind: body.kind, start_line: body.start_line ?? null, end_line: body.end_line ?? null, quote: body.quote ?? null, selection: body.selection ?? null, body: body.body, created_at: '2026-09-10T10:06:00Z', updated_at: '2026-09-10T10:06:00Z', anchor: body.kind === 'passage' ? { state: 'intact', current_start_line: body.start_line } : { state: 'document' } };
      state.comments.push(comment);
      return response({ comment }, 201);
    }
    if (method === 'PATCH' && rest === '') { state.review = { ...state.review, summary: body.summary }; return response({ review: { ...state.review, comments: state.comments } }); }
    if (method === 'GET' && rest === '') return response({ review: { ...state.review, comments: state.comments, submission: state.submission } });
    if (method === 'POST' && rest === '/finish') {
      if (state.failNextFinish) { const status = state.failNextFinish; state.failNextFinish = null; return response({ error: 'database is locked', code: 'save_failed' }, status); }
      if (state.review.status === 'submitted') return response({ review: { ...state.review, comments: state.comments }, submission: state.submission, duplicate: true });
      state.review = { ...state.review, status: 'submitted', summary: body.summary ?? state.review.summary, submitted_at: '2026-09-10T10:10:00Z' };
      state.submission = { id: 'sub-1', review_id: state.review.id, delivery_status: 'queued', delivery_attempts: 0, next_attempt_at: null, last_error: null, delivered_at: null, receipt: null, created_at: '2026-09-10T10:10:00Z', updated_at: '2026-09-10T10:10:00Z' };
      // The server processed the finish, but the response never reached the client.
      if (state.loseFinishResponse) { state.loseFinishResponse = false; throw new TypeError('Failed to fetch'); }
      return response({ review: { ...state.review, comments: state.comments, submission: state.submission }, submission: state.submission }, 202);
    }
    if (method === 'GET' && rest === '/submission') {
      state.polls += 1;
      if (state.polls >= state.deliveredAfterPolls) state.submission = { ...state.submission, delivery_status: 'delivered', delivery_attempts: 1, delivered_at: '2026-09-10T10:10:05Z', receipt: { conversation_id: 'conv-1234567890', user_message_id: 'docreview:sub-1', assistant_message_id: 'docreview:sub-1:reply', delivered_at: '2026-09-10T10:10:05Z' } };
      return response({ submission: state.submission });
    }
    if (method === 'POST' && rest === '/submission/retry') { state.submission = { ...state.submission, delivery_status: 'queued' }; return response({ submission: state.submission, retried: true }, 202); }
    return response({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { state, calls, handler };
}

function mount(srv) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => srv.handler(new URL(String(url), 'http://localhost'), init);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(DocumentReviewPage, { documentId: 'doc-1', timings: { pollMs: 20, summaryDebounceMs: 20 } })));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

test('renders the report with its source task and anchors a tapped block comment to real lines', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.querySelector('h1').textContent, /Reliability readiness/);
    assert.match(c.textContent, /Verify repairs/);
    assert.match(c.textContent, /QA passed \(cross-executor review\)/);
    assert.match(c.textContent, /rev aaaaaaaa/);
    assert.match(c.textContent, /as of 2026-09-10/);
    assert.ok(c.querySelector('a[href="/task/task-1"]'));
    assert.ok(c.querySelector('table, ul li'), 'GFM rendered');
    assert.equal(srv.calls.filter(x => x.method !== 'GET').length, 0, 'reads only until the reviewer acts');

    await click(c.querySelector('#L7 [data-block-comment-button]'));
    const composer = c.querySelector('[data-composer]');
    assert.match(composer.textContent, /Comment on lines 7–8/);
    assert.match(composer.textContent, /alerting is manual/);
    await type(composer.querySelector('textarea[aria-label="Comment text"]'), 'Add the runbook link here.');
    await settle();
    await click(button(composer, 'Save comment'));

    const post = srv.calls.find(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.ok(srv.calls.find(x => x.method === 'POST' && x.path === '/api/documents/doc-1/reviews'), 'a draft was opened lazily');
    assert.equal(post.body.kind, 'passage');
    assert.equal(post.body.start_line, 7);
    assert.equal(post.body.end_line, 8);
    assert.equal(post.body.quote, '- alerting is manual\n- no runbook');
    assert.equal(post.body.body, 'Add the runbook link here.');
    assert.match(post.body.client_id, /^[A-Za-z0-9_-]{8,}$/);
    assert.ok(!c.querySelector('[data-composer]'), 'composer closes after saving');
    assert.match(c.querySelector('[data-comment-list]').textContent, /Lines 7–8[\s\S]*Add the runbook link here\./);
    assert.match(c.textContent, /Saved/);
    assert.equal(c.querySelector('#L7 [data-block-comment-button]').textContent.trim(), '1');
    assert.equal(srv.calls.filter(x => x.path.endsWith('/finish')).length, 0, 'nothing delivered before Finish review');
  } finally { t.cleanup(); }
});

test('a failed save keeps the text and retries with the same client id; whole-document notes save too', async () => {
  const srv = server({ review: makeReview() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    srv.state.failNextComment = true;
    await click(c.querySelector('#L3 [data-block-comment-button]'));
    await type(c.querySelector('[data-composer] textarea'), 'Say which drill.');
    await settle();
    await click(button(c.querySelector('[data-composer]'), 'Save comment'));
    assert.match(c.textContent, /Save failed: database is locked/);
    assert.equal(c.querySelector('[data-composer] textarea').value, 'Say which drill.');
    await click(button(c.querySelector('[data-composer]'), 'Save comment'));
    const posts = srv.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments'));
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body.client_id, posts[1].body.client_id);
    assert.match(c.querySelector('[data-comment-list]').textContent, /Say which drill\./);

    await click(button(c, 'Add a note about the whole document'));
    await type(c.querySelector('[data-composer] textarea'), 'Overall this reads well.');
    await settle();
    await click(button(c.querySelector('[data-composer]'), 'Save comment'));
    const note = srv.calls.filter(x => x.method === 'POST' && x.path.endsWith('/comments')).at(-1);
    assert.equal(note.body.kind, 'document');
    assert.equal(note.body.start_line, undefined);
    assert.match(c.querySelector('[data-comment-list]').textContent, /Whole document[\s\S]*Overall this reads well\./);
    assert.match(c.textContent, /Comments \(2\)/);
  } finally { t.cleanup(); }
});

test('Finish review submits once with the summary and shows queued then delivered with a receipt', async () => {
  const srv = server({ review: makeReview({ comments: [{ id: 'c1', review_id: 'rev-A', client_id: 'x1', kind: 'passage', start_line: 3, end_line: 3, quote: 'Restart survived the drill.', selection: null, body: 'Which drill?', created_at: '2026-09-10T10:06:00Z', updated_at: '2026-09-10T10:06:00Z', anchor: { state: 'intact', current_start_line: 3 } }] }), deliveredAfterPolls: 2 });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.querySelector('[data-comment-list]').textContent, /Which drill\?/, 'draft resumed from the server after reload');
    await click(button(c, 'Finish review'));
    const panel = c.querySelector('[data-finish-panel]');
    await type(panel.querySelector('textarea'), 'Good enough to resume; fix the two gaps.');
    await settle(40);
    assert.ok(srv.calls.some(x => x.method === 'PATCH'), 'summary autosaved before finishing');
    await click(button(panel, 'Send to Praxis'));
    const finish = srv.calls.filter(x => x.path.endsWith('/finish'));
    assert.equal(finish.length, 1);
    assert.equal(finish[0].body.summary, 'Good enough to resume; fix the two gaps.');
    assert.match(c.textContent, /Queued for delivery/);
    assert.ok(!button(c, 'Finish review'), 'no second finish control');
    await settle(60);
    assert.match(c.textContent, /Delivered to Praxis/);
    assert.match(c.textContent, /Receipt: delivered/);
    assert.match(c.textContent, /Finished/);
    assert.ok(srv.calls.filter(x => x.method === 'GET' && x.path.endsWith('/submission')).length >= 2, 'delivery state was polled');
    assert.ok(button(c, 'Start a new review of this document'));
  } finally { t.cleanup(); }
});

test('finishing with zero comments opens a draft and submits it', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.textContent, /No comments yet/);
    await click(button(c, 'Finish review'));
    await click(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'));
    const order = srv.calls.filter(x => x.method === 'POST').map(x => x.path);
    assert.deepEqual(order, ['/api/documents/doc-1/reviews', `/api/documents/reviews/${srv.state.review.id}/finish`]);
    await settle(40);
    assert.match(c.textContent, /Delivered to Praxis/);
  } finally { t.cleanup(); }
});

test('a changed document shows the reviewed revision with honest anchor states and no annotation on the current file', async () => {
  const pinned = CONTENT;
  const current = ['# Readiness', '', 'New intro line.', '', 'Restart survived the drill.', '', '## Gaps', '', '- alerting is automatic now'].join('\n');
  const review = makeReview({ document_changed: true, pinned_content: pinned, comments: [
    { id: 'c1', review_id: 'rev-A', client_id: 'x1', kind: 'passage', start_line: 3, end_line: 3, quote: 'Restart survived the drill.', selection: null, body: 'Which drill?', created_at: '2026-09-10T10:06:00Z', updated_at: '2026-09-10T10:06:00Z', anchor: { state: 'moved', current_start_line: 5 } },
    { id: 'c2', review_id: 'rev-A', client_id: 'x2', kind: 'passage', start_line: 7, end_line: 8, quote: '- alerting is manual\n- no runbook', selection: null, body: 'Link the runbook.', created_at: '2026-09-10T10:07:00Z', updated_at: '2026-09-10T10:07:00Z', anchor: { state: 'orphaned', current_start_line: null } },
  ] });
  const srv = server({ review, content: current });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.querySelector('[data-changed-banner]').textContent, /viewing the revision you reviewed/);
    assert.match(c.textContent, /no runbook/, 'pinned revision content shown');
    assert.match(c.querySelector('[data-comment-list]').textContent, /now at line 5/);
    assert.match(c.querySelector('[data-comment-list]').textContent, /passage no longer in current revision/);
    assert.ok(c.querySelector('#L7 [data-block-comment-button]'), 'annotating the pinned revision is allowed');
    await click(button(c, 'View current file'));
    assert.match(c.textContent, /alerting is automatic now/);
    assert.equal(c.querySelectorAll('[data-block-comment-button]').length, 0, 'current file is read-only for anchors');
    assert.match(c.querySelector('[data-changed-banner]').textContent, /not moved/);
    assert.equal(srv.calls.filter(x => x.method !== 'GET').length, 0);
  } finally { t.cleanup(); }
});

function failedSubmission(overrides = {}) {
  return { id: 'sub-1', review_id: 'rev-A', document_id: 'doc-1', revision_id: 'rev-1', delivery_status: 'failed', delivery_attempts: 1, next_attempt_at: '2026-09-10T10:11:00Z', last_error: 'fetch failed', delivered_at: null, receipt: null, review_url: LINKS.review_url, created_at: '2026-09-10T10:10:00Z', updated_at: '2026-09-10T10:10:00Z', ...overrides };
}

test('a scheduled automatic retry keeps being observed until its outcome is known', async () => {
  const srv = server({ review: makeReview({ status: 'submitted', submitted_at: '2026-09-10T10:10:00Z', submission: failedSubmission() }), deliveredAfterPolls: 2 });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.match(c.querySelector('[data-submission-card]').textContent, /Automatic retry at/);
    await settle(120);
    assert.ok(srv.state.polls >= 2, `expected the scheduled retry to be polled, saw ${srv.state.polls}`);
    assert.match(c.textContent, /Delivered to Praxis/);
    assert.doesNotMatch(c.textContent, /Delivery failed/);
    assert.match(c.textContent, /Receipt: delivered/);
  } finally { t.cleanup(); }
});

test('a terminal delivery failure is shown as final and is not polled', async () => {
  const srv = server({ review: makeReview({ status: 'submitted', submitted_at: '2026-09-10T10:10:00Z', submission: failedSubmission({ next_attempt_at: null, last_error: 'Praxis returned 500' }) }) });
  const t = mount(srv);
  try {
    await settle(120);
    const c = t.container;
    assert.equal(srv.state.polls, 0, 'nothing to observe once the failure is final');
    assert.match(c.textContent, /Delivery failed/);
    assert.match(c.textContent, /Praxis returned 500/);
    assert.ok(button(c, 'Retry delivery'));
  } finally { t.cleanup(); }
});

test('a finish whose response was lost reconciles with the server instead of claiming nothing was sent', async () => {
  const srv = server({ review: makeReview(), loseFinishResponse: true, deliveredAfterPolls: 1 });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(button(c, 'Finish review'));
    await click(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'));
    assert.equal(srv.calls.filter(x => x.path.endsWith('/finish')).length, 1, 'the finish was not re-sent');
    assert.ok(srv.calls.some(x => x.method === 'GET' && x.path === '/api/documents/reviews/rev-A'), 'reconciled with the server after the transport error');
    assert.doesNotMatch(c.textContent, /nothing was sent/);
    assert.match(c.textContent, /Finished/);
    assert.ok(!button(c, 'Finish review'), 'the submitted review offers no second finish');
    await settle(60);
    assert.match(c.textContent, /Delivered to Praxis/);
  } finally { t.cleanup(); }
});

test('a finish rejected before it was processed says so and keeps the draft editable', async () => {
  const srv = server({ review: makeReview(), failNextFinish: 503 });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(button(c, 'Finish review'));
    await click(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'));
    assert.match(c.textContent, /database is locked/);
    assert.match(c.textContent, /nothing was sent; your draft is intact/);
    assert.equal(srv.state.review.status, 'draft');
    assert.ok(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'), 'the draft can still be finished');
    assert.ok(!c.querySelector('[data-submission-card]'));
  } finally { t.cleanup(); }
});

test('on the phone, adding a whole-document note closes the review drawer so the composer is reachable, then returns to it', async () => {
  const srv = server({ review: makeReview() });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(c.querySelector('[data-open-review]'));
    assert.ok(c.querySelector('[data-review-drawer]'));
    await click(button(c.querySelector('[data-review-drawer]'), 'Add a note about the whole document'));
    assert.ok(!c.querySelector('[data-review-drawer]'), 'the drawer closes while the note is composed');
    const sheet = c.querySelector('[data-composer-sheet]');
    assert.ok(sheet && sheet.querySelector('textarea'), 'the phone composer sheet is present');
    await type(sheet.querySelector('textarea'), 'Overall this reads well.');
    await settle();
    await click(button(c.querySelector('[data-composer-sheet]'), 'Save comment'));
    assert.ok(!c.querySelector('[data-composer-sheet]'), 'the sheet closes after saving');
    assert.ok(c.querySelector('[data-review-drawer]'), 'the drawer reopens after saving');
    assert.match(c.querySelector('[data-review-drawer] [data-comment-list]').textContent, /Whole document[\s\S]*Overall this reads well\./);
    assert.match(c.querySelector('[data-review-drawer]').textContent, /Comments \(1\)/);
  } finally { t.cleanup(); }
});
