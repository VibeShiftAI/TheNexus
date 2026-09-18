import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemberMemory } from '../member-memory.tsx';

const member = '00000000-0000-4000-8000-000000000001';
process.env.TZ = 'America/New_York';
const project = '00000000-0000-4000-8000-000000000002';
const eventId = '00000000-0000-4000-8000-000000000003';
const base = { id: eventId, seq: 1, member_id: member, project_id: project,
  recorded_at: '2026-09-07T12:00:00.000Z', kind: 'fact', fact_key: 'availability',
  text: 'Prefers Tuesdays', evidence: 'inferred', source: 'operator', source_ref: 'meeting:42', valid_until: '2026-11-01T06:30:00.123Z' };
const snapshot = (scope, events = [base]) => ({ member_id: member, project_id: scope,
  as_of: '2026-09-07T12:00:00.000Z', current_facts: events.filter(e => e.kind === 'fact'),
  conflicts: [], open_commitments: [], timeline: events, total_events: events.length, next_before_seq: null });
const json = data => new Response(JSON.stringify(data), { status: 200 });
async function mount(fetcher) {
  const original = globalThis.fetch; globalThis.fetch = (url, opts) => String(url).includes('/profile-proposals')
    ? Promise.resolve(json({ member_id: member, project_id: new URL(url, 'http://localhost').searchParams.get('project_id'), memory_version: 0, proposals: [], total: 0, next_before_created_seq: null }))
    // The evidence panel is collapsed by default and only fetches once opened; keep it inert here.
    : String(url).includes('/evidence') ? Promise.resolve(new Response(JSON.stringify({ error: 'evidence not stubbed' }), { status: 503 })) : fetcher(url, opts);
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  await act(async () => root.render(React.createElement(MemberMemory, { memberId: member, projectId: project })));
  return { node, dispose: async () => { await act(async () => root.unmount()); node.remove(); globalThis.fetch = original; } };
}
function button(node, text) { return [...node.querySelectorAll('button')].find(b => b.textContent === text); }
function input(node, label, value) {
  const field = node.querySelector(`[aria-label="${label}"]`);
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value);
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('renders evidence without upgrading an inference and corrects an exact scoped event', async () => {
  const writes = [];
  const h = await mount(async (_url, opts = {}) => {
    if (opts.method === 'POST') { const body = JSON.parse(opts.body); writes.push(body); return json({ event: { ...base, ...body, id: '00000000-0000-4000-8000-000000000004', seq: 2 } }); }
    return json(snapshot(project));
  });
  try {
    assert.match(h.node.textContent, /Inferred/); assert.match(h.node.textContent, /meeting:42/);
    await act(async () => button(h.node, 'Correct').click());
    await act(async () => input(h.node, 'Memory text', 'Prefers Wednesdays'));
    await act(async () => h.node.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 1); assert.equal(writes[0].supersedes_id, eventId);
    assert.equal(writes[0].project_id, project); assert.equal(writes[0].text, 'Prefers Wednesdays');
    assert.equal(writes[0].evidence, 'inferred');
    assert.equal(writes[0].valid_until, base.valid_until);
    assert.ok(writes[0].idempotency_key);
  } finally { await h.dispose(); }
});

test('scope switch clears prior data and ignores an older in-flight response', async () => {
  let resolveOld; let requests = 0;
  const h = await mount(async url => {
    requests++;
    if (requests === 1) return new Promise(resolve => { resolveOld = resolve; });
    assert.ok(!new URL(url, 'http://localhost').searchParams.has('project_id'));
    return json(snapshot(null, [{ ...base, project_id: null, text: 'General note' }]));
  });
  try {
    await act(async () => {
      const select = h.node.querySelector('[aria-label="Memory scope"]');
      select.value = 'general'; select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.match(h.node.textContent, /General note/);
    await act(async () => resolveOld(json(snapshot(project))));
    assert.doesNotMatch(h.node.textContent, /Prefers Tuesdays/);
  } finally { await h.dispose(); }
});

test('failed correction preserves form and does not claim it saved', async () => {
  const h = await mount(async (_url, opts = {}) => opts.method === 'POST'
    ? new Response(JSON.stringify({ error: 'This fact was already corrected' }), { status: 409 })
    : json(snapshot(project)));
  try {
    await act(async () => button(h.node, 'Correct').click());
    await act(async () => h.node.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(h.node.textContent, /already corrected/); assert.ok(h.node.querySelector('form'));
  } finally { await h.dispose(); }
});

test('a response from another scope is rejected before any notes are rendered', async () => {
  const h = await mount(async () => json(snapshot('00000000-0000-4000-8000-000000000099')));
  try { assert.match(h.node.textContent, /scope|scope mismatch/i); assert.doesNotMatch(h.node.textContent, /Prefers Tuesdays/); }
  finally { await h.dispose(); }
});

test('malformed responses show a useful error without exposing schema internals', async () => {
  const h = await mount(async () => json({ ...snapshot(project), current_facts: [{ ...base, evidence: 'guaranteed' }] }));
  try { assert.match(h.node.textContent, /invalid response/i); assert.doesNotMatch(h.node.textContent, /invalid_enum_value|Zod|Prefers Tuesdays/); }
  finally { await h.dispose(); }
});

test('retry after an uncertain write reuses the exact payload and idempotency key', async () => {
  const writes = [];
  const h = await mount(async (_url, opts = {}) => {
    if (opts.method !== 'POST') return json(snapshot(project));
    const payload = JSON.parse(opts.body); writes.push(payload);
    if (writes.length === 1) throw new Error('Connection lost after write');
    return json({ event: { ...base, ...payload, id: '00000000-0000-4000-8000-000000000008', seq: 8 } });
  });
  try {
    await act(async () => button(h.node, 'Correct').click());
    await act(async () => h.node.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(h.node.textContent, /Connection lost/);
    await act(async () => h.node.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
    assert.match(h.node.textContent, /Saved to this member/);
  } finally { await h.dispose(); }
});

test('loading older history uses its cursor and preserves already loaded records', async () => {
  const h = await mount(async url => {
    const cursor = new URL(url, 'http://localhost').searchParams.get('before_seq');
    if (cursor) {
      assert.equal(cursor, '3');
      return json({ ...snapshot(project), timeline: [{ ...base, seq: 1, id: '00000000-0000-4000-8000-000000000009', text: 'Older source evidence' }], total_events: 2 });
    }
    return json({ ...snapshot(project), timeline: [{ ...base, seq: 3 }], total_events: 2, next_before_seq: 3 });
  });
  try {
    await act(async () => button(h.node, 'Load older records').click());
    assert.match(h.node.textContent, /Older source evidence/); assert.match(h.node.textContent, /Prefers Tuesdays/);
    assert.equal(button(h.node, 'Load older records'), undefined);
  } finally { await h.dispose(); }
});
