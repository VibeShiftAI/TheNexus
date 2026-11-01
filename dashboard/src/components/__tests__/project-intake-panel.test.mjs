import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectIntakePanel } from '../project-intake/panel.tsx';

const project = {
  id: 'project/a', name: 'Garden', phase: 'intake', path: '', type: 'project',
  needs: [{ id: 'audience', kind: 'information', description: 'Who is this for?', status: 'open',
    knowledge: { question: 'Who is this for?', revision: 1, resolution: { method: 'operator', owner: 'Robert', next_action: 'Discuss intended users' } } }],
  intake: { revision: 3, brief_revision: 1, state: 'deferred', original: { problem: 'Make a garden planner', source_ref: 'chat:idea', at: '2026-11-01T00:00:00Z' },
    brief: { purpose: 'Plan seasonal planting', assumptions: ['Small gardens first'] },
    sources: [{ ref: '/missing/notes.md', type: 'file', availability: 'unavailable', processing_result: 'File could not be read' }],
    need_ids: ['audience'], pending_need_id: 'audience', workspace: { state: 'unassigned' }, review: null, review_history: [], brief_history: [], acceptance: null, operations: [] }
};
async function mount(value, onDiscuss = () => {}) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ProjectIntakePanel, { project: value, onDiscuss })));
  return { container, close() { act(() => root.unmount()); container.remove(); } };
}
test('deferred intake shows saved question, source issue, and workspace without invented progress', async () => {
  const ui = await mount(project);
  try {
    assert.match(ui.container.textContent, /Waiting for you/);
    assert.match(ui.container.textContent, /Who is this for\?/);
    assert.match(ui.container.textContent, /File could not be read/);
    assert.match(ui.container.textContent, /No folder assigned/);
    assert.match(ui.container.textContent, /Plan seasonal planting/);
    assert.doesNotMatch(ui.container.textContent, /\d+%/);
  } finally { ui.close(); }
});
test('resume and corrections include exact project identity and ask to read saved state', async () => {
  const calls = []; const ui = await mount(project, text => calls.push(text));
  try {
    for (const label of ['Resume intake', 'Correct an answer', 'Add a source']) {
      await act(async () => [...ui.container.querySelectorAll('button')].find(b => b.textContent === label).click());
    }
    assert.equal(calls.length, 3);
    assert.ok(calls.every(text => text.includes('project/a') && /read.*saved/i.test(text)));
    assert.match(calls[0], /pending question/i);
  } finally { ui.close(); }
});
test('shows saved answer evidence and council findings without treating failure as completion', async () => {
  const value = structuredClone(project);
  Object.assign(value.needs[0].knowledge, { answer: 'Community gardeners', evidence: [{ ref: 'chat:answer', summary: 'Robert identified the first users' }] });
  value.intake.state = 'council_review';
  value.intake.review = { session_id: 's', brief_revision: 1, status: 'failed', findings: [{ summary: 'Clarify scope', disposition: 'ask_robert' }] };
  const ui = await mount(value);
  try {
    assert.match(ui.container.textContent, /Community gardeners/);
    assert.match(ui.container.textContent, /chat:answer/);
    assert.match(ui.container.textContent, /failed/i);
    assert.match(ui.container.textContent, /Clarify scope/);
    assert.doesNotMatch(ui.container.textContent, /Ready for your decision/);
  } finally { ui.close(); }
});
test('non-web source references are text, never executable links', async () => {
  const value = structuredClone(project);
  value.intake.sources.push({ ref: 'javascript:alert(1)', type: 'url', availability: 'unprocessed' });
  const ui = await mount(value);
  try { assert.equal(ui.container.querySelector('a[href^="javascript:"]'), null); }
  finally { ui.close(); }
});
