import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';
import { choicesView, unsendableDraftAnswers } from '../../lib/document-choices.ts';
import { uncovered } from './tap-target-coverage.mjs';

// Structured document decisions answered in the viewer (task 50aa5747). Synthetic document, revisions and answers
// only: these tests never reach a real registry or Praxis.
const CONTENT_1 = ['# Rollout plan', '', 'Ship to the pilot group first.'].join('\n');
const CONTENT_2 = ['# Rollout plan', '', 'Ship to the pilot group in April.'].join('\n');
const REV_1 = { id: 'rev-1', document_id: 'doc-1', content_hash: 'a'.repeat(64), byte_length: CONTENT_1.length, line_count: 3, file_mtime: null, captured_at: '2026-11-14T10:00:00Z' };
const REV_2 = { id: 'rev-2', document_id: 'doc-1', content_hash: 'b'.repeat(64), byte_length: CONTENT_2.length, line_count: 3, file_mtime: null, captured_at: '2026-11-14T12:00:00Z' };
const SOURCE = { task: { id: 'task-1', title: 'Draft the rollout plan', status: 'complete', status_message: null, project_id: 'proj-1', updated_at: null }, project: { id: 'proj-1', name: 'Synthetic', path: '/private/tmp/synthetic' } };
const ITEMS = [
  { id: 'rollout', question: 'Which rollout should begin?', recommendation: 'Begin the pilot.', options: [{ id: 'pilot', label: 'Pilot', action: 'Prepare the pilot task.' }, { id: 'hold', label: 'Hold', action: 'Keep rollout on hold.' }] },
  { id: 'wording', question: 'Does the plan change?', recommendation: 'Keep it as written.', options: [{ id: 'keep', label: 'Keep as written', action: 'Leave the document as it is; do not edit it.' }, { id: 'revise', label: 'Revise', action: 'Revise the plan.' }] },
  { id: 'budget', question: 'What budget cap applies?', recommendation: 'Cap it at 5,000 USD.', action: 'Record the cap in the pilot plan.' },
];

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

/** In-memory documents API with the decision-answer rules of server/routes/documents.js. */
function server(options = {}) {
  const state = {
    revision: REV_1, content: CONTENT_1, review: null, sent: [],
    decisionItems: options.decisionItems === undefined ? { revision_id: 'rev-1', answerable: true, items: ITEMS } : options.decisionItems,
    reviewable: options.reviewable ?? { ok: true, reason: null, replacement_id: null },
  };
  const calls = [];
  // stale_answers as the server computes them: an answer whose decision is gone, or whose definition changed since it was saved.
  const staleAnswers = () => {
    if (state.review?.status !== 'draft' || state.review.revision_id !== state.revision.id) return [];
    const items = state.decisionItems?.revision_id === state.review.revision_id ? state.decisionItems.items : null;
    return state.review.decision_answers.flatMap(({ decision_id, answer, definition_hash }) => {
      const item = items?.find(i => i.id === decision_id);
      const reason = !items ? 'decisions_unavailable' : !item ? 'decision_removed' : definition_hash !== JSON.stringify(item) ? 'definition_changed' : null;
      return reason ? [{ decision_id, answer, reason }] : [];
    });
  };
  const reviewView = () => state.review && { ...state.review, stale_answers: staleAnswers(), document_changed: state.review.revision_id !== state.revision.id, pinned_revision: REV_1, is_current_revision: state.review.revision_id === state.revision.id };
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    if (method === 'GET' && p === '/api/documents/doc-1') {
      const document = { id: 'doc-1', title: 'Rollout plan', path: '/private/tmp/synthetic/rollout.md', kind: 'plan', task_id: 'task-1', project_id: 'proj-1', root_project_id: 'proj-1', metadata: {}, current_revision_id: state.revision.id, created_at: REV_1.captured_at, updated_at: state.revision.captured_at, purpose: 'Decide the rollout', requires_review: true, intended_action: 'implement' };
      // sent_answers: the latest answer per decision across the rounds finished on the bound revision, as the server reports them.
      const sentAnswers = new Map();
      for (const round of state.sent.filter(r => r.revision_id === state.decisionItems?.revision_id)) for (const a of round.answers) sentAnswers.set(a.decision_id, { decision_id: a.decision_id, answer: a.answer, review_id: round.review_id, submitted_at: round.submitted_at });
      const decisionItems = state.decisionItems && { ...state.decisionItems, answerable: state.decisionItems.revision_id === state.revision.id, sent_answers: [...sentAnswers.values()] };
      return response({ document, revision: state.revision, content: state.content, file_state: 'ok', file_error: null, source: SOURCE, review: reviewView(), decision_items: decisionItems, review_status: 'needs_review', current_decision: null, reviewable: state.reviewable, links: { review_url: 'https://nexus.example.test/documents/doc-1', raw_url: '/api/documents/doc-1/raw', review_path: '/documents/doc-1' } });
    }
    if (method === 'GET' && p === '/api/documents/doc-1/history') {
      return response({ document_id: 'doc-1', current_revision_id: state.revision.id, review_status: 'needs_review', revisions: [REV_1], decisions: [], registrations: [], reviews: [] });
    }
    if (method === 'POST' && p === '/api/documents/doc-1/reviews') {
      state.review = state.review?.status === 'draft' ? state.review : { id: `review-${calls.filter(x => x.path === p).length}`, document_id: 'doc-1', revision_id: state.revision.id, reviewer_id: 'local_user', status: 'draft', summary: '', comments: structuredClone(options.comments ?? []), decision_answers: [], submission: null, created_at: '2026-11-14T10:05:00Z', updated_at: '2026-11-14T10:05:00Z', submitted_at: null };
      return response({ review: reviewView() }, 201);
    }
    const answerPath = p.match(/^\/api\/documents\/reviews\/([^/]+)\/decision-answers\/([^/]+)$/);
    if (answerPath && state.review?.id === answerPath[1]) {
      if (state.review.status !== 'draft') return response({ error: 'Review is already finished; comments are frozen', code: 'review_submitted' }, 409);
      const decisionId = decodeURIComponent(answerPath[2]);
      if (method === 'DELETE') {
        state.review.decision_answers = state.review.decision_answers.filter(a => a.decision_id !== decisionId);
        return response({ cleared: true, decision_answers: state.review.decision_answers });
      }
      if (body.revision_id !== state.revision.id || state.review.revision_id !== state.revision.id) {
        return response({ error: `These decision answers are for revision ${body.revision_id}, but the current revision is ${state.revision.id}; nothing was saved. Answer the decisions on the current version`, code: 'stale_revision' }, 409);
      }
      const item = state.decisionItems?.items.find(i => i.id === decisionId);
      const entry = { decision_id: decisionId, answer: body.answer.trim(), definition_hash: JSON.stringify(item), answered_at: '2026-11-14T10:06:00Z', answered_by: 'local_user', authority: 'operator_credential' };
      state.review.decision_answers = [...state.review.decision_answers.filter(a => a.decision_id !== decisionId), entry];
      return response({ answer: entry, decision_answers: state.review.decision_answers });
    }
    if (method === 'POST' && state.review && p === `/api/documents/reviews/${state.review.id}/finish`) {
      if (state.finishRefusal) return response(state.finishRefusal, 409);
      if (staleAnswers().length) return response({ error: 'The decisions listed for this revision changed after you answered; review your answers and send again. Nothing was sent', code: 'decisions_changed', stale_answers: staleAnswers() }, 409);
      const submission = { id: 'sub-1', review_id: state.review.id, delivery_status: 'queued', delivery_attempts: 0, next_attempt_at: null, last_error: null, delivered_at: null, receipt: null, created_at: '2026-11-14T10:10:00Z', updated_at: '2026-11-14T10:10:00Z' };
      state.review = { ...state.review, status: 'submitted', submitted_at: '2026-11-14T10:10:00Z', submitted_authority: 'operator_credential', submission };
      state.sent.push({ review_id: state.review.id, revision_id: state.review.revision_id, submitted_at: state.review.submitted_at, answers: state.review.decision_answers, comments: state.review.comments });
      return response({ review: reviewView(), submission }, 202);
    }
    if (method === 'GET' && state.review && p === `/api/documents/reviews/${state.review.id}`) return response({ review: reviewView() });
    if (method === 'GET' && state.review && p === `/api/documents/reviews/${state.review.id}/submission`) return response({ submission: state.review.submission });
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
  act(() => root.render(createElement(DocumentReviewPage, { documentId: 'doc-1', timings: { pollMs: 60000, summaryDebounceMs: 20 } })));
  return { container, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

const card = c => c.querySelector('[data-document-choices]');
const choice = (c, id) => card(c).querySelector(`[data-choice="${id}"]`);
const option = (c, id, optionId) => choice(c, id).querySelector(`[data-choice-option="${optionId}"]`);
const answerCalls = srv => srv.calls.filter(x => x.path.includes('/decision-answers/'));

test('each decision shows its question, recommendation and answers with their actions at the top of the viewer, and two are answered independently on the revision on screen', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.equal(card(c).dataset.documentChoices, 'open');
    // At the top of the stage, ahead of the version marker and the document itself.
    const stage = c.querySelector('[data-stage]');
    assert.ok(stage.contains(card(c)));
    assert.ok(card(c).compareDocumentPosition(stage.querySelector('[data-version-marker]')) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'the decisions come before the version marker');
    assert.match(card(c).querySelector('h2').textContent, /3 decisions for you/);

    assert.deepEqual([...card(c).querySelectorAll('[data-choice]')].map(li => li.dataset.choice), ['rollout', 'wording', 'budget']);
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-question]').textContent, '1. Which rollout should begin?');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-recommendation]').textContent, 'Recommended: Begin the pilot.');
    assert.deepEqual([...choice(c, 'rollout').querySelectorAll('[data-choice-option]')].map(b => b.textContent), ['PilotPrepare the pilot task.', 'HoldKeep rollout on hold.']);
    assert.match(choice(c, 'budget').querySelector('[data-choice-action]').textContent, /Your answer is used to: Record the cap in the pilot plan\./);
    assert.ok(choice(c, 'budget').querySelector('textarea[data-choice-text]'), 'a free-text decision takes typed text');
    assert.match(card(c).querySelector('[data-choices-scope]').textContent, /an answer does not approve, edit, publish or send this document/);
    assert.ok(card(c).querySelector('[data-choices-send]').disabled, 'nothing to send before an answer');
    // Every control on the card is a 44px tap target below lg.
    assert.deepEqual(uncovered(card(c)), []);

    await click(option(c, 'rollout', 'hold'));
    assert.deepEqual(srv.calls.filter(x => x.method === 'POST' && x.path === '/api/documents/doc-1/reviews').map(x => x.body), [{ revision_id: 'rev-1' }], 'the first answer opens a round on the revision on screen');
    await click(option(c, 'wording', 'keep'));
    const [first, second] = answerCalls(srv);
    assert.deepEqual([first.method, first.path, first.body], ['PUT', '/api/documents/reviews/review-1/decision-answers/rollout', { answer: 'hold', revision_id: 'rev-1', content_hash: 'a'.repeat(64) }]);
    assert.deepEqual([second.method, second.path, second.body], ['PUT', '/api/documents/reviews/review-1/decision-answers/wording', { answer: 'keep', revision_id: 'rev-1', content_hash: 'a'.repeat(64) }]);
    assert.equal(option(c, 'rollout', 'hold').getAttribute('aria-pressed'), 'true');
    assert.equal(option(c, 'wording', 'keep').getAttribute('aria-pressed'), 'true');
    assert.equal(card(c).querySelector('[data-choices-progress]').textContent, '2 of 3 answered');

    // Changing one answer leaves the other alone.
    await click(option(c, 'rollout', 'pilot'));
    assert.equal(option(c, 'rollout', 'pilot').getAttribute('aria-pressed'), 'true');
    assert.equal(option(c, 'rollout', 'hold').getAttribute('aria-pressed'), 'false');
    assert.equal(option(c, 'wording', 'keep').getAttribute('aria-pressed'), 'true');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-saved]').textContent, 'Saved: Pilot');

    await type(choice(c, 'budget').querySelector('textarea'), 'Cap it at 4,000 USD.');
    await click(choice(c, 'budget').querySelector('[data-choice-save]'));
    assert.deepEqual(answerCalls(srv).at(-1).body, { answer: 'Cap it at 4,000 USD.', revision_id: 'rev-1', content_hash: 'a'.repeat(64) });
    assert.ok(choice(c, 'budget').querySelector('[data-choice-save]').disabled, 'the saved text needs no second save');

    await click(choice(c, 'wording').querySelector('[data-choice-clear]'));
    assert.deepEqual([answerCalls(srv).at(-1).method, answerCalls(srv).at(-1).path], ['DELETE', '/api/documents/reviews/review-1/decision-answers/wording']);
    assert.equal(option(c, 'wording', 'keep').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(srv.state.review.decision_answers.map(a => [a.decision_id, a.answer]), [['rollout', 'pilot'], ['budget', 'Cap it at 4,000 USD.']]);
    // Answering is not an editorial decision, an edit or a finish.
    assert.equal(srv.calls.filter(x => /\/decisions$|\/content$|\/finish$/.test(x.path)).length, 0);
  } finally { t.cleanup(); }
});

test('Send answers opens Finish review, which sends them with the review; the card then shows them sent and read-only', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(option(c, 'rollout', 'pilot'));
    await click(card(c).querySelector('[data-choices-send]'));
    const panel = c.querySelector('[data-finish-panel]');
    assert.ok(panel, 'Finish review is open');
    assert.match(panel.querySelector('[data-finish-answers]').textContent, /Your decision answer goes with it\. Praxis carries out each chosen action; an answer does not approve, edit, publish or send the document\./);
    await click(button(panel, 'Send to Praxis'));
    const finish = srv.calls.find(x => x.path.endsWith('/finish'));
    assert.deepEqual(finish.body, { summary: '' }, 'no approval grant rides along');

    assert.equal(card(c).dataset.documentChoices, 'sent');
    assert.ok(option(c, 'rollout', 'pilot').disabled && option(c, 'rollout', 'hold').disabled, 'a sent answer is read-only');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-saved]').textContent, 'Sent: Pilot');
    assert.equal(choice(c, 'wording').querySelector('[data-choice-unanswered]').textContent, 'Not answered in a review you sent');
    assert.equal(card(c).querySelector('[data-choice-clear]'), null);
    assert.match(card(c).querySelector('[data-choices-sent]').textContent, /Sent to Praxis: 1 of 3 answered\./);

    // The rest can be answered in a new round on the same version, beside what the first round already sent.
    await click(card(c).querySelector('[data-choices-new-round]'));
    assert.equal(card(c).dataset.documentChoices, 'open');
    assert.equal(srv.state.review.id, 'review-2');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-sent-earlier]').textContent, 'Sent earlier: Pilot');
    assert.equal(option(c, 'rollout', 'pilot').getAttribute('aria-pressed'), 'false', 'the new round starts with no answers of its own');
    assert.equal(choice(c, 'wording').querySelector('[data-choice-sent-earlier]'), null);
    assert.equal(card(c).querySelector('[data-choices-progress]').textContent, '0 of 3 answered');
    await click(option(c, 'wording', 'keep'));
    assert.equal(answerCalls(srv).at(-1).path, '/api/documents/reviews/review-2/decision-answers/wording');
    await click(option(c, 'rollout', 'hold'));
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-sent-earlier]').textContent, 'Sent earlier: Pilot (your new answer replaces it when you send)');

    // Sending the second round: the card counts every round sent on this version, the later answer winning.
    await click(card(c).querySelector('[data-choices-send]'));
    await click(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'));
    assert.equal(card(c).dataset.documentChoices, 'sent');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-saved]').textContent, 'Sent: Hold');
    assert.equal(choice(c, 'wording').querySelector('[data-choice-saved]').textContent, 'Sent: Keep as written');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-sent-earlier]'), null);
    assert.match(card(c).querySelector('[data-choices-sent]').textContent, /Sent to Praxis: 2 of 3 answered\./);
  } finally { t.cleanup(); }
});

test('a newer revision refuses the answer and the card says this version has none to answer; nothing is answerable on a closed version', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(option(c, 'rollout', 'pilot'));
    // The producer registers a new revision without decisions while Robert reads rev-1.
    srv.state.revision = REV_2;
    srv.state.content = CONTENT_2;
    await click(option(c, 'wording', 'keep'));
    await settle();
    assert.equal(answerCalls(srv).at(-1).body.revision_id, 'rev-1', 'the answer cited the revision that was on screen');
    assert.equal(srv.state.review.decision_answers.length, 1, 'nothing was saved');
    assert.equal(card(c).dataset.documentChoices, 'blocked');
    assert.match(card(c).querySelector('[data-choices-note]').textContent, /The 3 decisions listed with an earlier version do not apply to this one; this version has none to answer\./);
    assert.equal(card(c).querySelector('[data-choice]'), null, 'the earlier questions are not offered on this version');
  } finally { t.cleanup(); }

  const closed = server({ reviewable: { ok: false, reason: 'replacement_in_progress', replacement_id: 'rp-1' } });
  const t2 = mount(closed);
  try {
    await settle();
    const c = t2.container;
    assert.equal(card(c).dataset.documentChoices, 'blocked');
    assert.match(card(c).querySelector('[data-choices-note]').textContent, /takes no answers right now/);
    assert.ok([...card(c).querySelectorAll('[data-choice-option]')].every(b => b.disabled));
    assert.equal(card(c).querySelector('textarea'), null);
  } finally { t2.cleanup(); }

  const unbound = server({ decisionItems: { revision_id: null, answerable: false, items: ITEMS } });
  const t3 = mount(unbound);
  try {
    await settle();
    const c = t3.container;
    assert.match(card(c).querySelector('[data-choices-note]').textContent, /cannot be answered here\. Answer them in chat with Praxis\./);
    assert.ok([...card(c).querySelectorAll('[data-choice-option]')].every(b => b.disabled));
  } finally { t3.cleanup(); }
});

test('a finish refused because the decisions changed sends nothing, keeps the draft and reloads the card', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(option(c, 'rollout', 'pilot'));
    // The producer re-registers the same bytes declaring no decisions while the finish is on its way.
    srv.state.decisionItems = null;
    srv.state.finishRefusal = { error: 'The decisions on this version changed after you answered them; nothing was sent. Reload and answer them again', code: 'decisions_changed' };
    await click(card(c).querySelector('[data-choices-send]'));
    await click(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'));
    await settle();
    assert.equal(srv.state.review.status, 'draft');
    assert.match(c.querySelector('[data-finish-panel]').textContent, /nothing was sent; your draft is intact/);
    assert.equal(card(c) === null, true, 'the reload shows this version now asks for no decisions');
    assert.ok(srv.calls.filter(x => x.method === 'GET' && x.path === '/api/documents/doc-1').length >= 2, 'the document was read again');
  } finally { t.cleanup(); }
});

const COMMENT = { id: 'c1', review_id: 'review-1', client_id: 'cl-1', kind: 'document', start_line: null, end_line: null, quote: null, selection: null, parent_id: null, body: 'The pilot section reads well.', created_at: '2026-11-14T10:05:30Z', updated_at: '2026-11-14T10:05:30Z', resolved: false, anchor: { state: 'document', current_start_line: null } };
const finishNotes = panel => [...panel.querySelectorAll('[data-finish-answers]')].map(p => p.dataset.finishAnswers);

test('answers to decisions withdrawn on the same revision stay recoverable: a notice lists them, Finish says they cannot be sent, and clearing them sends the comments through a successful Finish', async () => {
  const srv = server({ comments: [COMMENT] });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(option(c, 'rollout', 'pilot'));
    // Same bytes, decisions withdrawn behind the viewer (the QA reproduction): the card goes on the next read.
    srv.state.decisionItems = null;
    await click(card(c).querySelector('[data-choices-send]'));
    const panel = () => c.querySelector('[data-finish-panel]');
    await click(button(panel(), 'Send to Praxis'));
    await settle();
    assert.equal(srv.state.review.status, 'draft', 'the refused finish sent nothing');
    assert.equal(card(c) === null, true, 'this version now lists no decisions');

    // The orphaned answer is shown with what it was and why it cannot go, with a way to clear it.
    const notice = c.querySelector('[data-stale-answers]');
    assert.equal(notice !== null, true, 'the stage shows the answers the card can no longer show');
    assert.deepEqual([...notice.querySelectorAll('[data-stale-answer]')].map(li => li.dataset.staleAnswer), ['rollout']);
    assert.match(notice.textContent, /Your review holds an answer that cannot be sent, so Finish review will refuse it\. Clearing it keeps your comments\./);
    assert.match(notice.querySelector('[data-stale-answer="rollout"]').textContent, /Your answer: pilot\. Not sent because this version no longer asks it\./);
    assert.deepEqual(uncovered(notice), []);
    // Finish no longer claims the answer goes with it.
    assert.deepEqual(finishNotes(panel()), ['stale']);
    assert.match(panel().querySelector('[data-finish-answers="stale"]').textContent, /One decision answer cannot be sent: the decisions changed or were withdrawn after you answered\. Clear it to send your comments alone\./);
    assert.equal(panel().querySelector('[data-clear-stale-answers]') !== null, true);

    // Clearing removes only the answer; the comment stays on the draft and on screen.
    await click(notice.querySelector('[data-stale-answers-clear]'));
    assert.deepEqual(answerCalls(srv).at(-1), { method: 'DELETE', path: '/api/documents/reviews/review-1/decision-answers/rollout', body: null });
    assert.equal(c.querySelector('[data-stale-answers]'), null);
    assert.deepEqual(finishNotes(panel()), []);
    assert.deepEqual(srv.state.review.comments.map(x => x.body), ['The pilot section reads well.']);
    assert.match(c.textContent, /The pilot section reads well\./);

    // Finish now succeeds with the comment and no answers.
    await click(button(panel(), 'Send to Praxis'));
    await settle();
    assert.equal(srv.state.review.status, 'submitted');
    assert.deepEqual(srv.calls.filter(x => x.path.endsWith('/finish')).at(-1).body, { summary: '' });
    assert.deepEqual(srv.state.sent.at(-1).answers, []);
    assert.deepEqual(srv.state.sent.at(-1).comments.map(x => x.body), ['The pilot section reads well.']);
  } finally { t.cleanup(); }
});

test('an answer whose decision changed under it is marked in the card; choosing it again reconfirms it, and Finish sends it', async () => {
  const srv = server();
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    await click(option(c, 'rollout', 'pilot'));
    // Same ids, new action: the saved answer no longer matches what the option now does.
    const changed = structuredClone(ITEMS);
    changed[0].options[0].action = 'Cancel the pilot task.';
    srv.state.decisionItems = { revision_id: 'rev-1', answerable: true, items: changed };
    await click(card(c).querySelector('[data-choices-send]'));
    const panel = () => c.querySelector('[data-finish-panel]');
    await click(button(panel(), 'Send to Praxis'));
    await settle();
    assert.equal(srv.state.review.status, 'draft');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-action]').textContent, 'Cancel the pilot task.');
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-stale]').dataset.choiceStale, 'definition_changed');
    assert.match(choice(c, 'rollout').querySelector('[data-choice-stale]').textContent, /Your answer cannot be sent: the question or its action changed after you answered\. Choose an answer again to confirm it, or clear it\./);
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-saved]'), null);
    assert.equal(c.querySelector('[data-stale-answers]'), null, 'the card shows it, so no second notice');
    assert.match(panel().querySelector('[data-finish-answers="stale"]').textContent, /Clear it to send your comments alone, or answer again in the decisions card\./);

    // Choosing the same option again saves it against the definition shown now.
    const before = answerCalls(srv).length;
    await click(option(c, 'rollout', 'pilot'));
    assert.equal(answerCalls(srv).length, before + 1);
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-stale]'), null);
    assert.equal(choice(c, 'rollout').querySelector('[data-choice-saved]').textContent, 'Saved: Pilot');
    assert.deepEqual(finishNotes(panel()), ['']);
    assert.match(panel().querySelector('[data-finish-answers]').textContent, /Your decision answer goes with it\./);
    await click(button(panel(), 'Send to Praxis'));
    await settle();
    assert.equal(srv.state.review.status, 'submitted');
    assert.deepEqual(srv.state.sent.at(-1).answers.map(a => [a.decision_id, a.answer]), [['rollout', 'pilot']]);
  } finally { t.cleanup(); }
});

test('a document without decisions shows no decisions card and finishes exactly as before', async () => {
  const srv = server({ decisionItems: null });
  const t = mount(srv);
  try {
    await settle();
    const c = t.container;
    assert.equal(card(c), null);
    await click(c.querySelector('[data-finish-button]'));
    assert.equal(c.querySelector('[data-finish-answers]'), null);
    await click(button(c.querySelector('[data-finish-panel]'), 'Send to Praxis'));
    assert.deepEqual(srv.calls.find(x => x.path.endsWith('/finish')).body, { summary: '' });
    assert.equal(answerCalls(srv).length, 0);
  } finally { t.cleanup(); }
});

test('choicesView: answers only on the latest version, on a round pinned to it', () => {
  const decisions = { revision_id: 'rev-1', answerable: true, items: ITEMS };
  const draft = { status: 'draft', revision_id: 'rev-1', decision_answers: [{ decision_id: 'rollout', answer: 'pilot' }] };
  const base = { decisions, review: draft, currentRevisionId: 'rev-1', showingEarlier: false, reviewable: true };
  assert.equal(choicesView({ ...base, decisions: null }), null);
  assert.deepEqual(choicesView(base), { state: 'open', showItems: true, answers: draft.decision_answers, sentAnswers: [], note: null });
  // Earlier sent answers ride beside an open round, and a sent round lays its own answers over them (the read may predate its finish).
  const earlier = [{ decision_id: 'rollout', answer: 'hold', review_id: 'review-0' }, { decision_id: 'budget', answer: 'Cap it.', review_id: 'review-0' }];
  assert.deepEqual(choicesView({ ...base, decisions: { ...decisions, sent_answers: earlier } }).sentAnswers, earlier);
  const sent = choicesView({ ...base, decisions: { ...decisions, sent_answers: earlier }, review: { ...draft, status: 'submitted' } });
  assert.deepEqual(sent.answers.map(a => [a.decision_id, a.answer]), [['rollout', 'pilot'], ['budget', 'Cap it.']]);
  assert.deepEqual(sent.sentAnswers, []);
  assert.equal(choicesView({ ...base, review: null }).state, 'open');
  assert.equal(choicesView({ ...base, showingEarlier: true }).state, 'blocked');
  assert.equal(choicesView({ ...base, review: { ...draft, status: 'submitted' } }).state, 'sent');
  // A draft on an earlier revision cannot answer the latest version's decisions, and its own answers are not shown here.
  const stale = choicesView({ ...base, review: { ...draft, revision_id: 'rev-0' } });
  assert.deepEqual([stale.state, stale.answers], ['blocked', []]);
  assert.match(stale.note, /Your open review is on an earlier version/);
  // A finished round on an earlier revision leaves the latest version open to a new round.
  assert.equal(choicesView({ ...base, review: { ...draft, status: 'submitted', revision_id: 'rev-0' } }).state, 'open');
  assert.equal(choicesView({ ...base, review: { ...draft, status: 'superseded' } }).state, 'open');
  assert.equal(choicesView({ ...base, decisions: { ...decisions, items: [ITEMS[0]], answerable: false } }).note, 'The decision listed with an earlier version does not apply to this one; this version has none to answer.');
});

test('unsendableDraftAnswers: an earlier version, a withdrawn or removed decision, and a changed definition the server reports', () => {
  const decisions = { revision_id: 'rev-1', answerable: true, items: ITEMS };
  const answers = [{ decision_id: 'rollout', answer: 'pilot' }, { decision_id: 'wording', answer: 'keep' }];
  const draft = { status: 'draft', revision_id: 'rev-1', decision_answers: answers };
  assert.deepEqual(unsendableDraftAnswers(draft, decisions, 'rev-1'), []);
  assert.deepEqual(unsendableDraftAnswers({ ...draft, status: 'submitted' }, null, 'rev-1'), [], 'a finished round is frozen, not stale');
  assert.deepEqual(unsendableDraftAnswers(draft, decisions, 'rev-2').map(s => s.reason), ['revision_changed', 'revision_changed']);
  assert.deepEqual(unsendableDraftAnswers(draft, null, 'rev-1').map(s => s.reason), ['decisions_unavailable', 'decisions_unavailable']);
  assert.deepEqual(unsendableDraftAnswers(draft, { ...decisions, items: [ITEMS[0]] }, 'rev-1'), [{ decision_id: 'wording', answer: 'keep', reason: 'decision_removed' }]);
  // The server's report counts only while the same answer is still saved: a different answer replaces the stale one.
  const reported = [{ decision_id: 'rollout', answer: 'pilot', reason: 'definition_changed' }];
  assert.deepEqual(unsendableDraftAnswers({ ...draft, stale_answers: reported }, decisions, 'rev-1'), reported);
  assert.deepEqual(unsendableDraftAnswers({ ...draft, stale_answers: [{ ...reported[0], answer: 'hold' }] }, decisions, 'rev-1'), []);
});
