import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertAction, SafeAlertMarkdown } from '../alert-action.tsx';
import { HitlCard, HitlRequestCard } from '../hitl-card.tsx';
import { EventRow } from '../activity-feed.tsx';

test('alert copy links safely without active HTML and shows full multiline question', () => {
  const html = renderToStaticMarkup(React.createElement(SafeAlertMarkdown, { children: 'First step.\n\n[Open task](/task/test#contract-hold) [unsafe](javascript:alert(1)) <script>alert(1)</script>' }));
  assert.match(html, /href="\/task\/test#contract-hold"/);
  assert.doesNotMatch(html, /href="javascript:|<script>/);
});
test('resolved activity card has saved answer and a history target without needs-you label', () => {
  const html = renderToStaticMarkup(React.createElement(AlertAction, { action: { state: 'resolved', label: 'Answered', owner: 'Robert', instruction: 'This request has been answered.', answer: 'Approved\n\nStaging only.', href: '/inbox#q1', linkLabel: 'View saved answer' } }));
  assert.match(html, /Approved/); assert.match(html, /Staging only/);
  assert.match(html, /href="\/inbox#q1"/); assert.doesNotMatch(html, /needs you/);
});
test('shared HITL card explains ack-only semantics and makes question links clickable', () => {
  const html = renderToStaticMarkup(React.createElement(HitlRequestCard, { request: { id: 'red1', reason: 'explicit_request', requestedAt: '2026-10-06T00:00:00Z', question: 'Review [service status](/system-monitor).', options: ['acknowledged'], metadata: { kind: 'red-alert' } }, resolving: false, onResolve: async () => {} }));
  assert.match(html, /does not (repair|fix)/);
  assert.match(html, /href="\/system-monitor"/);
});
test('real activity row removes the historical needs-you badge when the request was answered', () => {
  const event = { id: 1, event_type: 'day_schedule_approval_requested', severity: 'info', title: 'Morning Approval Needed', source: 'praxis', created_at: '2026-10-05T00:00:00Z', requires_action: 1, task_id: null, metadata: { hitlId: 'old-plan' } };
  const html = renderToStaticMarkup(React.createElement(EventRow, { event, onOpenTask: () => {}, evidence: { hitls: { 'old-plan': { id: 'old-plan', question: 'Approve this plan?', resolution: { choice: 'approve', freeText: 'Run the first two slots.' } } }, tasks: {} } }));
  assert.match(html, /Request closed/); assert.match(html, /Run the first two slots/);
  assert.doesNotMatch(html, /needs you|Your input is needed/);
});

test('expired rich requests show history without approval controls', () => {
  const html = renderToStaticMarkup(React.createElement(HitlCard, { request: { id: 'expired-plan', reason: 'explicit_request', requestedAt: '2000-01-01T00:00:00Z', ttlSeconds: 60, question: 'Approve this schedule?', options: ['approve'], metadata: { kind: 'day-schedule' } }, resolving: false, onResolve: async () => {} }));
  assert.match(html, /Request expired/);
  assert.doesNotMatch(html, /<button|<textarea/);
});
