import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { PraxisMailbox } from '../praxis-mailbox.tsx';

const summary = (id, status = 'received') => ({ id, subject: `Message ${id}`, from: 'neighbor@example.com', to: ['praxis@vibeshiftai.com'], date: '2026-09-07T12:00:00Z', status });
const page = (folder, items, nextCursor = null) => ({ account: 'praxis@vibeshiftai.com', folder, items, nextCursor, updatedAt: '2026-09-07T12:00:00Z' });
const detail = (id) => ({ ...summary(id), body: `Full body ${id}\n<img src="https://tracker.example/pixel">`, cc: [], replyTo: [], attachments: [{ filename: 'notes.pdf', contentType: 'application/pdf', size: 1234 }] });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
function button(container, label) { return [...container.querySelectorAll('button')].find(b => b.textContent.trim() === label); }
async function click(node) { assert.ok(node); await act(async () => node.click()); await settle(); }
function setup(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url), 'http://localhost');
    calls.push({ path: parsed.pathname, method: options.method ?? 'GET', query: parsed.searchParams });
    return handler(parsed, options);
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(PraxisMailbox)));
  return { container, calls, cleanup() { act(() => root.unmount()); container.remove(); globalThis.fetch = original; } };
}

test('opens complete mail as plain text and performs only reads', async () => {
  const t = setup(url => response(url.pathname.endsWith('/mailbox') ? page('inbox', [summary('one')]) : detail('one')));
  try {
    await settle();
    assert.match(t.container.textContent, /praxis@vibeshiftai.com/);
    await click(t.container.querySelector('[data-message-id="one"]'));
    assert.match(t.container.textContent, /Full body one/);
    assert.match(t.container.textContent, /notes.pdf/);
    assert.match(t.container.textContent, /<img src=/);
    assert.ok(!t.container.querySelector('img'));
    assert.ok(t.calls.every(c => c.method === 'GET'));
  } finally { t.cleanup(); }
});

test('Outbox separates pending approval from actual sent mail', async () => {
  const draft = { ...summary('draft', 'pending'), approvalId: 'hitl-humanquery-draft', approvalState: 'pending' };
  const t = setup(url => {
    if (!url.pathname.endsWith('/mailbox')) return response({ ...detail('draft'), ...draft });
    const folder = url.searchParams.get('folder');
    return response(page(folder, folder === 'pending' ? [draft] : folder === 'sent' ? [summary('delivered', 'sent')] : []));
  });
  try {
    await settle();
    await click(button(t.container, 'Outbox'));
    await click(t.container.querySelector('[data-message-id="draft"]'));
    assert.match(t.container.textContent, /Awaiting approval/);
    assert.equal(t.container.querySelector('a[href="/inbox#hitl-humanquery-draft"]').textContent, 'Review approval');
    await click(button(t.container, 'Sent'));
    assert.ok(t.container.querySelector('[data-message-id="delivered"]'));
    assert.ok(!t.container.querySelector('a[href*="humanquery"]'));
    assert.ok(t.calls.some(c => c.query.get('folder') === 'sent'));
  } finally { t.cleanup(); }
});

test('mailbox failure is explicit and retry recovers, without claiming an empty inbox', async () => {
  let failing = true;
  const t = setup(() => failing ? response({ error: 'Praxis mailbox is unavailable.' }, 503) : response(page('inbox', [])));
  try {
    await settle();
    assert.match(t.container.querySelector('[role="alert"]').textContent, /unavailable/);
    assert.doesNotMatch(t.container.textContent, /No messages/);
    failing = false;
    await click(button(t.container, 'Retry'));
    assert.ok(!t.container.querySelector('[role="alert"]'), 'error should clear after recovery');
    assert.match(t.container.textContent, /No messages/);
  } finally { t.cleanup(); }
});

test('a delayed message cannot replace the current selection or leak into another folder', async () => {
  let finishOld;
  const t = setup(url => {
    if (url.pathname.endsWith('/mailbox')) return response(page(url.searchParams.get('folder'), [summary('old'), summary('new')]));
    if (url.pathname.endsWith('/old')) return new Promise(resolve => { finishOld = () => resolve(response(detail('old'))); });
    return response(detail('new'));
  });
  try {
    await settle();
    await click(t.container.querySelector('[data-message-id="old"]'));
    await click(t.container.querySelector('[data-message-id="new"]'));
    assert.match(t.container.textContent, /Full body new/);
    await act(async () => finishOld());
    assert.doesNotMatch(t.container.textContent, /Full body old/);
    await click(button(t.container, 'Outbox'));
    assert.doesNotMatch(t.container.textContent, /Full body new/);
  } finally { t.cleanup(); }
});

test('load more preserves existing mail, and refresh replaces the page', async () => {
  const t = setup(url => response(url.searchParams.has('cursor') ? page('inbox', [summary('two')]) : page('inbox', [summary('one')], 'older')));
  try {
    await settle();
    await click(button(t.container, 'Load more'));
    assert.equal(t.container.querySelectorAll('[data-message-id]').length, 2);
    assert.ok(t.calls.some(c => c.query.get('cursor') === 'older'));
    await click(button(t.container, 'Refresh'));
    assert.equal(t.container.querySelectorAll('[data-message-id]').length, 1);
  } finally { t.cleanup(); }
});

test('Retry discards an expired pagination cursor and loads a fresh first page', async () => {
  const t = setup(url => response(url.searchParams.has('cursor')
    ? { error: 'stale_mailbox_id', message: 'This mailbox has changed. Refresh its message list.' }
    : page('inbox', [summary('one')], 'old-mailbox'), url.searchParams.has('cursor') ? 409 : 200));
  try {
    await settle();
    await click(button(t.container, 'Load more'));
    assert.match(t.container.querySelector('[role="alert"]').textContent, /mailbox has changed/);
    await click(button(t.container, 'Retry'));
    assert.ok(!t.container.querySelector('[role="alert"]'), 'error should clear after recovery');
    assert.equal(t.calls.at(-1).query.has('cursor'), false);
  } finally { t.cleanup(); }
});

test('combined Inbox filters email and feedback and opens the complete feedback conversation', async () => {
  const feedback = { ...summary('feedback-PX-MM-1'), source: 'feedback', tag: 'PX-MM-1', project: 'Meeple Magnate', subject: 'Make cards easier to read' };
  const thread = {
    tag: 'PX-MM-1', project: 'Meeple Magnate', status: 'awaiting_user', taskIds: ['task-123'], hasMore: false,
    entries: [
      { id: 'request', direction: 'in', kind: 'feedback', date: feedback.date, from: 'neighbor@example.com', to: [], body: 'Original full request\n<script>alert(1)</script>', attachments: [] },
      { id: 'reply', direction: 'out', kind: 'email', date: feedback.date, from: 'praxis@vibeshiftai.com', to: ['neighbor@example.com'], body: 'Praxis full response with details', status: 'sent', attachments: [] },
      { id: 'answers', direction: 'in', kind: 'answers', date: feedback.date, from: 'neighbor@example.com', to: [], body: 'Which cards?\nAnswer: All cards', attachments: [] },
      { id: 'draft', direction: 'out', kind: 'email', date: feedback.date, from: 'praxis@vibeshiftai.com', to: ['neighbor@example.com'], body: 'Draft follow-up', status: 'draft', approvalId: 'hitl-humanquery-followup', approvalState: 'pending', attachments: [] },
    ],
  };
  const t = setup(url => {
    if (!url.pathname.endsWith('/mailbox')) return response({ ...detail(feedback.id), ...feedback, thread });
    const folder = url.searchParams.get('folder');
    return response(page(folder, folder === 'all' ? [summary('one'), feedback] : folder === 'feedback' ? [feedback] : [summary('one')]));
  });
  try {
    await settle();
    assert.equal(t.calls[0].query.get('folder'), 'all');
    assert.equal(t.container.querySelectorAll('[data-message-id]').length, 2);
    await click(t.container.querySelector('[data-message-id="feedback-PX-MM-1"]'));
    const conversation = t.container.querySelector('[aria-label="Feedback conversation"]');
    assert.ok(conversation, 'feedback has a complete thread view');
    assert.match(conversation.textContent, /Original full request/);
    assert.match(conversation.textContent, /Praxis full response with details/);
    assert.match(conversation.textContent, /Which cards\?/);
    assert.match(conversation.textContent, /Answer: All cards/);
    assert.match(conversation.textContent, /Awaiting approval/);
    assert.ok(!conversation.querySelector('script'));
    assert.ok(conversation.querySelector('a[href="/task/task-123"]'));
    assert.ok(conversation.querySelector('a[href="/inbox#hitl-humanquery-followup"]'));
    await click(button(t.container, 'Email'));
    assert.equal(t.container.querySelectorAll('[data-message-id]').length, 1);
    assert.ok(!t.container.querySelector('[aria-label="Feedback conversation"]'));
    await click(button(t.container, 'Feedback'));
    assert.ok(t.container.querySelector('[data-message-id="feedback-PX-MM-1"]'));
    assert.equal(button(t.container, 'Inbox').getAttribute('aria-pressed'), 'true');
    assert.ok(t.calls.every(c => c.method === 'GET'));
  } finally { t.cleanup(); }
});
