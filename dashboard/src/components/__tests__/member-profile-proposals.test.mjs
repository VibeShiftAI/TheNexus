import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemberProfileProposals } from '../member-profile-proposals.tsx';
const member = '00000000-0000-4000-8000-000000000001', proposalId = '00000000-0000-4000-8000-000000000002';
const sourceId = '00000000-0000-4000-8000-000000000003', captureId = '00000000-0000-4000-8000-000000000004';
const proposal = { id: proposalId, created_seq: 1, capture_id: captureId, category: 'expertise', quote: 'I have worked on access testing.',
  fact_key: 'profile.expertise.fixture', source_event_ids: [sourceId], source_response: 'I have worked on access testing. This is a self-report.',
  source_question: 'What have you worked on?', source_origin: 'member_reply', source_occurred_at: '2026-09-08T12:00:00.000Z',
  status: 'pending', reason: 'needs_review', created_at: '2026-09-08T12:00:01.000Z' };
const page = (extra = {}) => ({ member_id: member, project_id: 'fixture-project', memory_version: 7, proposals: [proposal], total: 1, next_before_created_seq: null, ...extra });
const json = (body, status = 200) => Response.json(body, { status });
async function mount(fetcher, props = {}) {
  const original = globalThis.fetch; globalThis.fetch = fetcher; const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  let updates = 0;
  await act(async () => root.render(React.createElement(MemberProfileProposals, { memberId: member, projectId: 'fixture-project', onRefreshMemory: async () => { updates++; }, ...props })));
  return { node, updates: () => updates, dispose: async () => { await act(async () => root.unmount()); node.remove(); globalThis.fetch = original; } };
}
const button = (node, text) => [...node.querySelectorAll('button')].find(b => b.textContent === text);
test('shows full evidence and claim status; acceptance uses the reviewed memory version and refreshes memory', async () => {
  const writes = []; let accepted = false;
  const h = await mount(async (url, opts = {}) => {
    if (opts.method === 'POST') { writes.push({ url, body: JSON.parse(opts.body) }); accepted = true; return json({ proposal: { ...proposal, status: 'applied', event_id: sourceId, reviewed_at: proposal.created_at } }); }
    return json(page(accepted ? { proposals: [], total: 0, memory_version: 8 } : {}));
  });
  try {
    assert.match(h.node.textContent, /Expertise claim/); assert.match(h.node.textContent, /This is a self-report/); assert.match(h.node.textContent, new RegExp(sourceId));
    await act(async () => button(h.node, 'Accept').click());
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, { decision: 'accept', expected_memory_version: 7 });
    assert.match(new URL(writes[0].url, 'http://localhost').pathname, new RegExp(`${proposalId}/review$`)); assert.equal(h.updates(), 2);
    assert.match(h.node.textContent, /No proposed updates/);
  } finally { await h.dispose(); }
});
test('stale acceptance keeps evidence visible and prevents another acceptance until explicit refresh', async () => {
  let posts = 0;
  const h = await mount(async (_url, opts = {}) => opts.method === 'POST' ? (posts++, json({ error: 'Memory changed since review' }, 409)) : json(page()));
  try {
    await act(async () => button(h.node, 'Accept').click());
    assert.match(h.node.textContent, /Memory changed/); assert.match(h.node.textContent, /I have worked/); assert.equal(button(h.node, 'Accept').disabled, true);
    await act(async () => button(h.node, 'Refresh proposals').click()); assert.equal(button(h.node, 'Accept').disabled, false); assert.equal(posts, 1);
  } finally { await h.dispose(); }
});
test('rejects foreign scope and invalid proposal responses before displaying their text', async () => {
  const h = await mount(async () => json(page({ project_id: 'foreign-project' })));
  try { assert.match(h.node.textContent, /scope/i); assert.doesNotMatch(h.node.textContent, /I have worked/); } finally { await h.dispose(); }
  const bad = await mount(async () => json(page({ proposals: [{ ...proposal, source_event_ids: [] }] })));
  try { assert.match(bad.node.textContent, /invalid response/i); assert.doesNotMatch(bad.node.textContent, /I have worked/); } finally { await bad.dispose(); }
});
test('dismissal does not claim a fact was added; evidence text stays escaped', async () => {
  const h = await mount(async (_url, opts = {}) => opts.method === 'POST' ? json({ proposal: { ...proposal, status: 'dismissed' } }) : json(page({ proposals: [{ ...proposal, source_response: '<script>danger()</script>' }] })));
  try {
    assert.equal(h.node.querySelector('script'), null);
    await act(async () => button(h.node, 'Dismiss').click()); assert.match(h.node.textContent, /Dismissed/);
  } finally { await h.dispose(); }
});
test('loading another page cannot silently authorize old proposals against changed memory', async () => {
  const h = await mount(async url => json(String(url).includes('before_created_seq') ? page({ memory_version: 8, proposals: [], total: 2 }) : page({ next_before_created_seq: 1, total: 2 })));
  try {
    await act(async () => button(h.node, 'Load older proposals').click());
    assert.match(h.node.textContent, /Memory changed/); assert.equal(button(h.node, 'Accept').disabled, true);
  } finally { await h.dispose(); }
});
test('refreshing stale proposals does not unlock review when current facts cannot be refreshed', async () => {
  let refreshes = 0;
  const h = await mount(async (_url, opts = {}) => opts.method === 'POST' ? json({ error: 'Memory changed' }, 409) : json(page()), {
    onRefreshMemory: async () => ++refreshes === 1,
  });
  try {
    await act(async () => button(h.node, 'Accept').click());
    await act(async () => button(h.node, 'Refresh proposals').click());
    assert.match(h.node.textContent, /Could not refresh current memory/); assert.equal(button(h.node, 'Accept'), undefined);
  } finally { await h.dispose(); }
});
