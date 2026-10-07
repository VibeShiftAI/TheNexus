import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentReviewPage } from '../document-review/document-review.tsx';
import { OutgoingCard } from '../document-review/outgoing-card.tsx';

const revision = { id: 'rev-send', document_id: 'doc-send', content_hash: 'a'.repeat(64), byte_length: 10, line_count: 1, captured_at: '2026-10-05T00:00:00Z' };
const outgoing = {
  document_id: 'doc-send', revision_id: revision.id, content_hash: revision.content_hash,
  envelope_hash: 'b'.repeat(64), delivery_id: 'delivery-1', status: 'draft', grant: null,
  envelope: { to: 'member@example.test', cc: ['operator@example.test'], subject: 'Exact subject', text: 'Exact first line.\n\nSecond <literal> line.', attachments: [] },
  provenance: { member_id: 'member-1', project_id: 'project-1', task_id: 'task-1', source_refs: ['synthetic:source-1'] },
};
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const button = (node, label) => [...node.querySelectorAll('button')].find(b => b.textContent.trim() === label);
async function click(node) { assert.ok(node, 'expected button'); await act(async () => node.click()); }
async function mount(options = {}) {
  const calls = [];
  let current = structuredClone({ ...outgoing, ...options.outgoing });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url), 'http://localhost').pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ pathname, method: init.method ?? 'GET', body, headers: init.headers, credentials: init.credentials });
    if (pathname === '/api/documents/doc-send/outgoing/decision') {
      if (options.deny) return response(options.deny, options.deny.status);
      current = { ...current, status: body.decision === 'cancel' ? 'cancelled' : 'approved' };
      return response({ outgoing: current });
    }
    if (pathname === '/api/documents/doc-send') return response({
      document: { id: 'doc-send', title: 'Message for review', path: '/synthetic/message.md', metadata: {}, requires_review: true, intended_action: 'send', current_revision_id: revision.id },
      revision, content: '# Editorial draft', file_state: options.fileState ?? 'ok', file_error: null,
      source: { task: null, project: null }, review: null, review_status: 'needs_review', current_decision: null,
      outgoing: current, links: { review_url: '/documents/doc-send', raw_url: '/api/documents/doc-send/raw' },
    });
    throw new Error(`Unmocked API call: ${pathname}`);
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(DocumentReviewPage, { documentId: 'doc-send' })));
  return { container, calls, async cleanup() { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; } };
}

test('the reviewer shows the exact envelope and sends only an explicit snapshot-bound approval', async () => {
  const t = await mount();
  try {
    const card = t.container.querySelector('[data-outgoing-card]');
    assert.ok(card);
    for (const expected of ['member@example.test', 'operator@example.test', 'Exact subject', 'Attachments: none', 'synthetic:source-1']) assert.ok(card.textContent.includes(expected));
    assert.equal(card.querySelector('[data-outgoing-body]').textContent, outgoing.envelope.text);
    assert.match(t.container.querySelector('[data-decision-card]').textContent, /Sending requires a separate/);
    assert.equal(t.calls.filter(c => c.method === 'POST').length, 0);
    await click(button(card, 'Approve and send'));
    const calls = t.calls.filter(c => c.method === 'POST');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/api/documents/doc-send/outgoing/decision');
    assert.deepEqual(calls[0].body, { decision: 'approve_send', revision_id: revision.id, envelope_hash: outgoing.envelope_hash });
    assert.equal(calls[0].credentials, 'include');
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(t.container.querySelector('[data-outgoing-card]').getAttribute('data-outgoing-card'), 'approved');
    assert.equal(button(t.container, 'Approve and send'), undefined);
  } finally { await t.cleanup(); }
});

test('Cancel send records permanent cancellation and removes send controls', async () => {
  const t = await mount();
  try {
    await click(button(t.container.querySelector('[data-outgoing-card]'), 'Cancel send'));
    assert.equal(t.calls.find(c => c.method === 'POST').body.decision, 'cancel');
    assert.match(t.container.querySelector('[data-outgoing-card]').textContent, /Cancelled permanently/);
    assert.equal(button(t.container, 'Approve and send'), undefined);
  } finally { await t.cleanup(); }
});

for (const [name, deny, expected] of [
  ['operator refusal', { status: 403, code: 'operator_required', error: 'Operator sign-in required' }, /Operator sign-in required/],
  ['stale snapshot', { status: 409, code: 'outgoing_conflict', error: 'Outgoing message changed' }, /changed.*review/i],
  ['server failure', { status: 503, error: 'Operator verification unavailable' }, /verification unavailable/i],
]) test(`send control displays ${name} without another action`, async () => {
  const t = await mount({ deny });
  try {
    await click(button(t.container, 'Approve and send'));
    assert.match(t.container.querySelector('[data-outgoing-notice]').textContent, expected);
    assert.equal(t.calls.filter(c => c.method === 'POST').length, 1);
  } finally { await t.cleanup(); }
});

for (const status of ['delivering', 'sent', 'uncertain', 'cancelled']) test(`${status} cannot be approved or cancelled again`, async () => {
  const t = await mount({ outgoing: { status } });
  try {
    assert.ok(t.container.querySelector('[data-outgoing-card]'));
    assert.equal(button(t.container, 'Approve and send'), undefined);
    assert.equal(button(t.container, 'Cancel send'), undefined);
    assert.equal(t.calls.filter(c => c.method === 'POST').length, 0);
  } finally { await t.cleanup(); }
});

for (const options of [
  { fileState: 'not_found' }, { outgoing: { invalidated_at: '2026-10-05T00:01:00Z' } },
  { outgoing: { revision_id: 'older-revision' } }, { outgoing: { envelope: { ...outgoing.envelope, cc: [] } } },
]) test(`unavailable, stale, or missing-copy draft is held: ${JSON.stringify(options)}`, async () => {
  const t = await mount(options);
  try {
    assert.ok(button(t.container, 'Approve and send').disabled);
    assert.ok(t.container.querySelector('[data-outgoing-blocked]'));
    assert.equal(t.calls.filter(c => c.method === 'POST').length, 0);
  } finally { await t.cleanup(); }
});


test('pending delivery polls read-only status and stops once sent', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  let refreshes = 0;
  const data = { document: { id: 'doc-send' }, revision, file_state: 'ok', outgoing: { ...outgoing, status: 'approved' } };
  const onRefresh = async () => {
    refreshes += 1;
    await act(async () => root.render(createElement(OutgoingCard, { data: { ...data, outgoing: { ...data.outgoing, status: 'sent' } }, viewingCurrent: true, onRefresh, pollMs: 10 })));
  };
  try {
    await act(async () => root.render(createElement(OutgoingCard, { data, viewingCurrent: true, onRefresh, pollMs: 10 })));
    for (let attempt = 0; attempt < 20 && refreshes === 0; attempt += 1) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    assert.equal(refreshes, 1);
    assert.equal(container.querySelector('[data-outgoing-card]').getAttribute('data-outgoing-card'), 'sent');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(refreshes, 1);
  } finally { await act(async () => root.unmount()); }
});
