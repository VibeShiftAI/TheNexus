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

test('document outgoing card directs all mail decisions to canonical Drafts', async () => {
  const t = await mount();
  try {
    const card=t.container.querySelector('[data-outgoing-card]');
    assert.ok(card.querySelector('a[href="/mail?draft=doc-send"]'));
    assert.equal(button(card,'Approve and send'),undefined);
    assert.equal(button(card,'Cancel send'),undefined);
    assert.equal(t.calls.filter(c=>c.method==='POST').length,0);
    assert.match(card.textContent,/Exact subject/);
  } finally {await t.cleanup();}
});
