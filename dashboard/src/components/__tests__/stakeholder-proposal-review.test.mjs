import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectRequests } from '../project-requests.tsx';
const proposal = { task_id: 'synthetic-task', project_id: 'synthetic-project', kind: 'invitation', member_id: 'synthetic-member',
  member: { name: 'Synthetic Member', email: 'test@example.invalid' }, revision: 2, content_hash: 'synthetic-hash', state: 'proposed',
  content: { message: 'Exact invitation wording', role: 'Reviewer' }, project_snapshot: { description: 'Approved scope' },
  decisions: [], events: [], revisions: [], history: [] };
const policy = { independent: ['recommend_members', 'prepare_personalized_updates', 'track_commitments', 'draft_followups', 'file_enhancement_tickets'],
  requires_robert: ['invitation', 'scope_change', 'synthetic_future_action'], boundaries: ['Drafting is not sending authority.'] };
async function mount(state = 'proposed') {
  const original = globalThis.fetch; const writes = []; let current = state;
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') { writes.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); current = 'approved'; return Response.json({ success: true }); }
    return Response.json(String(url).includes('stakeholder-policy') ? { policy, project_policy: null } : {
      policy, requests: [{ id: 'synthetic-task', name: 'Synthetic invitation', created_at: new Date().toISOString(),
        gate: { status: 'pending' }, proposal: { ...proposal, state: current } }] });
  };
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  await act(async () => root.render(React.createElement(ProjectRequests, { projectId: 'synthetic-project' })));
  return { node, writes, dispose: async () => { await act(async () => root.unmount()); node.remove(); globalThis.fetch = original; } };
}
test('policy and exact revision review require operator credential and send bound decision', async () => {
  const h = await mount();
  try {
    assert.match(h.node.textContent, /General stakeholder policy/);
    assert.match(h.node.textContent, /Robert approval required: invitation, scope change, synthetic future action/);
    assert.match(h.node.textContent, /Exact invitation wording/);
    assert.match(h.node.textContent, /synthetic-hash/);
    const approve = [...h.node.querySelectorAll('button')].find(b => b.textContent === 'Robert: approve revision');
    assert.ok(approve); assert.equal(approve.disabled, true);
    const input = h.node.querySelector('input[type="password"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'synthetic-operator-key');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => approve.click());
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].headers.Authorization, 'Bearer synthetic-operator-key');
    assert.deepEqual(h.writes[0].body, { decision: 'approve', revision: 2, content_hash: 'synthetic-hash' });
    assert.match(h.node.textContent, /Approved — not issued or applied/);
    assert.equal(localStorage.length, 0);
  } finally { await h.dispose(); }
});
for (const [state, label] of [['proposed', 'Proposed — awaiting Robert'], ['approved', 'Approved — not issued or applied'], ['issued', 'Invitation issued — acceptance unknown'], ['accepted', 'Participation accepted'], ['applied', 'Scope application recorded']]) {
  test(`dashboard distinguishes ${state}`, async () => { const h = await mount(state); try { assert.ok(h.node.textContent.includes(label)); } finally { await h.dispose(); } });
}
