import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HitlRequestCard } from '../hitl-card.tsx';
import { DeliverableRow } from '../document-review/deliverable-row.tsx';
import { briefFromMetadata, briefQuestions } from '../../lib/human-brief.ts';
import { HumanBriefBlock } from '../human-brief.tsx';

test('a collapsed update keeps the situation visible and omits empty decision rows', () => {
  const html = renderToStaticMarkup(React.createElement(HumanBriefBlock, { brief: { kind: 'update', project: 'Praxis', situation: 'The review passed.', problem: '', ask: '' }, collapsible: true }));
  assert.match(html, /data-brief-field="situation"/);
  assert.doesNotMatch(html, /max-lg:hidden[^>]*data-brief-field="situation"/);
  assert.doesNotMatch(html, /The problem|What I need from you/);
});

const brief = {
  project: 'TheCortex',
  situation: 'The retrieval evaluation now covers every required case type, but the only complete run was set up after earlier results were seen.',
  problem: 'The evaluation protocol redefined what counts as a conflicting case without your decision.',
  ask: 'Answer the two questions below.',
  recommendation: 'Keep the redefinition with its stated limit.',
};
const body = 'Correction first: on card ask-robert-30b0ff7e you asked "what do you recommend?" and chose no option. The holdout work then picked option (c) itself.';
const request = {
  id: 'ask-robert-1', taskId: 'eb297519', reason: 'explicit_request', requestedAt: '2026-10-21T21:18:44.829Z',
  question: `**Project:** TheCortex\n\n1. Option (c)?\n\n2. Count the run?`,
  metadata: { kind: 'ask-robert', brief, body, taskTitle: 'Query-expansion holdout follow-up', projectName: 'TheCortex',
    questions: [{ id: 'q1', prompt: 'Option (c)?', kind: 'choice', options: ['ratify', 'reject'] }, { id: 'q2', prompt: 'Count the run?', kind: 'text' }] },
};

test('an inbox card with a brief leads with it, lists the questions, folds the full message, and shows no owner box', () => {
  const html = renderToStaticMarkup(React.createElement(HitlRequestCard, { request, resolving: false, onResolve: async () => {} }));
  const briefAt = html.indexOf('data-human-brief');
  const questionsAt = html.indexOf('data-brief-questions');
  const detailsAt = html.indexOf('data-brief-details="message"');
  assert.ok(briefAt > 0 && questionsAt > briefAt && detailsAt > questionsAt, 'brief, then questions, then folded message');
  assert.match(html, /Project<\/dt><dd[^>]*>TheCortex/);
  assert.match(html, /What I need from you<\/dt><dd[^>]*>Answer the two questions below\./);
  assert.match(html, /My recommendation/);
  assert.match(html, /Option \(c\)\? \(ratify \/ reject\)/);
  assert.match(html, /Correction first/);
  assert.doesNotMatch(html, /Owner:|Your input is needed|Type your answer to the question and select Send Answer/);
  // The text twin is not rendered a second time above the structured brief.
  assert.equal((html.match(/TheCortex/g) ?? []).length, 2, 'project chip and brief row only');
});

test('a card without a brief renders as before, minus the owner box', () => {
  const plain = { id: 'q-plain', reason: 'explicit_request', requestedAt: '2026-10-21T21:18:44.829Z', question: 'Approve the plan?', options: ['approve'] };
  const html = renderToStaticMarkup(React.createElement(HitlRequestCard, { request: plain, resolving: false, onResolve: async () => {} }));
  assert.match(html, /Approve the plan\?/);
  assert.doesNotMatch(html, /data-human-brief|Owner:|Your input is needed/);
  assert.match(html, /<button[^>]*>approve<\/button>/);
});

test('a malformed brief is ignored rather than rendered half-empty', () => {
  assert.equal(briefFromMetadata({ brief: { project: 'X', situation: 'Y.' } }), undefined);
  assert.equal(briefFromMetadata({ brief: 'not an object' }), undefined);
  assert.deepEqual(briefFromMetadata({ brief: { ...brief, options: ['a', 1, 'b'] } })?.options, ['a', 'b']);
  assert.deepEqual(briefQuestions({ questions: [{ prompt: 'A?' }, { nope: true }, { prompt: 'B?', options: ['x'] }] }), ['A?', 'B? (x)']);
});

test('a deliverable row describes the document by its brief when one is registered', () => {
  const entry = {
    id: 'doc1', title: 'Launch plan', path: '/tmp/launch-plan.md', root_project_id: null, project_id: 'p1', task_id: null, kind: 'plan',
    metadata: { brief: { ...brief, project: 'VibeShift AI', problem: 'The plan cannot start until you have read it.', ask: 'Approve it or request changes.' } },
    current_revision_id: 'r1', registered_by: null, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
    purpose: 'Review the launch plan', requires_review: true, intended_action: 'implement', current_revision: null, review_url: '/documents/doc1', review_state: null,
  };
  const html = renderToStaticMarkup(React.createElement(DeliverableRow, { entry }));
  assert.match(html, /The plan cannot start until you have read it\. Approve it or request changes\./);
  const plain = renderToStaticMarkup(React.createElement(DeliverableRow, { entry: { ...entry, metadata: {} } }));
  assert.match(plain, /Review the launch plan/);
  const update = renderToStaticMarkup(React.createElement(DeliverableRow, { entry: { ...entry, metadata: { brief: { kind: 'update', project: 'Praxis', situation: 'The launch plan now includes the delivery dates.', problem: '', ask: '' } } } }));
  assert.match(update, /The launch plan now includes the delivery dates/);
});
