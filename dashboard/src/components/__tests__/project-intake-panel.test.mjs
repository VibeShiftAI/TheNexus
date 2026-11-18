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
    assert.match(ui.container.textContent, /requested tasks and research can continue/i);
    assert.doesNotMatch(ui.container.textContent, /\d+%/);
  } finally { ui.close(); }
});
test('intake questions show the saved audience and open a correction for the selected question', async () => {
  const value = structuredClone(project);
  value.needs[0].knowledge.client_facing = false;
  const drafts = [];
  const ui = await mount(value, text => drafts.push(text));
  try {
    assert.match(ui.container.textContent, /Internal/);
    const change = [...ui.container.querySelectorAll('button')].find(b => b.textContent === 'Change audience');
    assert.ok(change);
    await act(async () => change.click());
    assert.match(drafts[0], /audience/);
    assert.ok(drafts[0].includes(JSON.stringify(value.needs[0].id)));
    assert.ok(drafts[0].includes(JSON.stringify(value.id)));
  } finally { ui.close(); }
});

test('planning acceptance shows unfinished readiness and actual council disposition', async () => {
  const value = structuredClone(project);
  value.phase = 'planning'; value.intake.state = 'handed_off';
  value.intake.acceptance = { brief_revision: 1, source_ref: 'chat:proceed', next_step: 'Start planning the pilot', at: '2026-11-01T00:00:00Z', review_disposition: 'not_requested', readiness_gaps: ['Success criteria remain undefined'], decision_note: 'Start now to meet the deadline' };
  value.intake.workspace = { state: 'attached', path: '/new/location', canonical_path: '/new/location' };
  value.intake.workspace_history = [{ previous: { state: 'attached', path: '/old/location', canonical_path: '/old/location' }, next: value.intake.workspace, operation_id: 'move-1', at: '2026-11-01T00:00:00Z', source_ref: 'chat:moved' }];
  const ui = await mount(value);
  try {
    assert.match(ui.container.textContent, /Success criteria remain undefined/);
    assert.match(ui.container.textContent, /Council review: not requested/i);
    assert.match(ui.container.textContent, /Start now to meet the deadline/);
    assert.match(ui.container.textContent, /\/old\/location/);
    assert.doesNotMatch(ui.container.textContent, /Council review: completed/i);
  } finally { ui.close(); }
});
test('a newer brief labels acceptance as historical and keeps the adopted version readable', async () => {
  const value = structuredClone(project);
  value.phase = 'planning'; value.intake.state = 'handed_off'; value.intake.brief_revision = 2;
  value.intake.brief.outcome = 'Updated planning idea';
  value.intake.acceptance = { brief_revision: 1, source_ref: 'chat:proceed', next_step: 'Plan the garden', at: '2026-11-01T00:00:00Z' };
  value.intake.brief_history = [{ brief_revision: 1, brief: { outcome: 'Originally adopted garden plan' }, sources: [], need_revisions: {}, at: '2026-11-01T01:00:00Z' }];
  const ui = await mount(value);
  try {
    assert.match(ui.container.textContent, /Current brief version 2 is newer than accepted version 1/);
    assert.match(ui.container.textContent, /Acceptance remains historical; these changes do not automatically change the adopted goal/);
    assert.match(ui.container.textContent, /Originally adopted garden plan/);
    assert.match(ui.container.textContent, /Updated planning idea/);
  } finally { ui.close(); }
});
const accepted = backlog => {
  const value = structuredClone(project);
  value.phase = 'planning'; value.intake.state = 'handed_off';
  value.intake.acceptance = { brief_revision: 1, source_ref: 'chat:proceed', next_step: 'Plan the garden', at: '2026-11-01T00:00:00Z', ...(backlog === undefined ? {} : { backlog }) };
  return value;
};
const slot = (number, name) => ({ slot: number, name, description: `What: ${name}.`, antigravity_payload: { prompt: name } });
const receipt = rest => ({ status: 'generated', task_ids: [], proposals: [], remaining: [], brief_revision: 1, operation_id: 'op-backlog', at: '2026-11-01T00:05:00.000Z', replayed: false, ...rest });
/** The backlog state beside the intake state, as plain values (an element in a failing assert exhausts memory). */
const backlogLabel = ui => {
  const labels = [...ui.container.querySelectorAll('[data-intake-backlog]')];
  return { count: labels.length, text: labels[0]?.textContent ?? null, state: labels[0]?.getAttribute('data-intake-backlog') ?? null, classes: labels[0]?.className ?? '' };
};
for (const [name, backlog] of [['an acceptance recorded before receipts existed', undefined], ['an acceptance whose receipt is null', null]]) {
  test(`${name} shows the backlog as not recorded, in the warning colour`, async () => {
    const ui = await mount(accepted(backlog));
    try {
      const label = backlogLabel(ui);
      assert.deepEqual({ count: label.count, text: label.text, state: label.state }, { count: 1, text: 'backlog: not recorded', state: 'not-recorded' });
      assert.match(label.classes, /\btext-amber-300\b/);
      assert.match(ui.container.textContent, /Accepted for planning · backlog: not recorded/);
      assert.match(ui.container.textContent, /Initial backlog not recorded: no tasks have been filed or named for this acceptance, and no deferral is recorded\./);
    } finally { ui.close(); }
  });
}
for (const [status, ids, expected] of [['generated', ['t1', 't2', 't3'], 'backlog: 3 tasks'], ['existing', ['t1', 't2'], 'backlog: 2 tasks'], ['generated', ['t1'], 'backlog: 1 task']]) {
  test(`a receipt of status ${status} naming ${ids.length} shows "${expected}" without the warning colour`, async () => {
    const ui = await mount(accepted(receipt({ status, task_ids: ids, proposals: status === 'generated' ? ids.map((id, i) => ({ ...slot(i + 1, `Stage ${i + 1}`), task_id: id })) : [] })));
    try {
      const label = backlogLabel(ui);
      assert.deepEqual({ count: label.count, text: label.text, state: label.state }, { count: 1, text: expected, state: 'recorded' });
      assert.doesNotMatch(label.classes, /amber/);
      assert.match(ui.container.textContent, new RegExp(`Initial ${expected}, recorded against brief version 1\\.`));
      assert.doesNotMatch(ui.container.textContent, /not recorded|Planned and not filed yet/);
    } finally { ui.close(); }
  });
}
test('a partial receipt shows filed of planned and names every slot still to file', async () => {
  const remaining = [slot(3, 'Wire the planting calendar'), slot(4, 'Publish the seasonal guide')];
  const ui = await mount(accepted(receipt({ status: 'partial', task_ids: ['t1', 't2'], proposals: [{ ...slot(1, 'Model the beds'), task_id: 't1' }, { ...slot(2, 'Import the seed list'), task_id: 't2' }], remaining })));
  try {
    const label = backlogLabel(ui);
    assert.deepEqual({ count: label.count, text: label.text, state: label.state }, { count: 1, text: 'backlog: partial, 2 of 4', state: 'recorded' });
    assert.match(ui.container.textContent, /Planned and not filed yet:Slot 3: Wire the planting calendarSlot 4: Publish the seasonal guide/);
    assert.doesNotMatch(ui.container.textContent, /not recorded/);
  } finally { ui.close(); }
});
test('a deferred receipt shows its whole reason, its reference and any work recorded before it', async () => {
  const reason = `Robert asked to hold the backlog until the legal review of the seed catalogue licence is finished. ${'The supplier terms need a second reading before any task depends on them. '.repeat(6)}End of reason.`;
  const ui = await mount(accepted(receipt({ status: 'deferred', reason, source_ref: 'javascript:alert(1)', task_ids: ['t1', 't2'], remaining: [slot(3, 'Wire the planting calendar')] })));
  try {
    const label = backlogLabel(ui);
    assert.equal(label.text, `backlog: deferred (${reason})`);
    assert.equal(label.state, 'recorded');
    assert.ok(reason.length > 500 && ui.container.textContent.includes(`Initial backlog: deferred (${reason}), recorded against brief version 1.`));
    assert.match(ui.container.textContent, /Deferral reference: javascript:alert\(1\)/);
    assert.equal(ui.container.querySelectorAll('a[href^="javascript:"]').length, 0);
    assert.match(ui.container.textContent, /Recorded before the deferral: 2 tasks\./);
    assert.match(ui.container.textContent, /Slot 3: Wire the planting calendar/);
  } finally { ui.close(); }
});
test('no backlog state is shown before intake is handed off', async () => {
  const ui = await mount(project);
  try {
    assert.equal(backlogLabel(ui).count, 0);
    assert.doesNotMatch(ui.container.textContent, /backlog/i);
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
