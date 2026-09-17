const { prepareProjectPatch } = require('../../db/project-data');
const { applyCheckpointTransition } = require('../../db/project-checkpoints');
const T = '2026-09-15T10:00:00.000Z';
const NOW = new Date().toISOString();
const criterion = { id: 'm', kind: 'manual', description: 'Operator accepts the measured outcome', enabled: true };
function project(c = criterion) {
  return { id: 'p', updated_at: T, end_state: 'Long term', needs: [], checkpoints: { revision: T, archived: [], items: [{ id: 'a', title: 'First', goal: 'First goal', criteria: [c], need_ids: [], created_at: T, definition_revision: T, status: 'pending', history: [] }], sequence_completed_at: null } };
}
function submit(p, result = {}) {
  return applyCheckpointTransition(p, { checkpoint_id: 'a', definition_revision: T, expected_checkpoints_revision: p.checkpoints.revision, assessment: { evaluated_at: NOW, results: [{ id: 'm', status: 'pass', pass: true, checked_at: NOW, ...result }], knowledge: { required: 0, satisfied: 0, unresolved: 0 } } }, NOW);
}
test('a claimed pass without actual manual acceptance cannot advance', () => {
  expect(submit(project()).transition.outcome).toBe('recorded');
});
test('old result timestamps cannot be laundered through a fresh assessment envelope', () => {
  const p = project({ ...criterion, kind: 'command', command: 'npm test' });
  expect(submit(p, { checked_at: '2020-01-01T00:00:00Z' }).transition.outcome).toBe('recorded');
});
test('metric evidence below its adopted target cannot be asserted as pass', () => {
  const p = project({ ...criterion, kind: 'metric', metric: { target: 10, operator: 'gte' }, observation: { status: 'pass', observed_at: NOW, evidence_ref: 'measured', value: 2 } });
  expect(submit(p).transition.outcome).toBe('recorded');
});
test('checkpoint definition edits require the revision from the read snapshot', () => {
  expect(() => prepareProjectPatch(project(), { checkpoints: [{ id: 'a', goal: 'Changed' }] })).toThrow(/expected_checkpoints_revision/);
});
test('criteria changes clear copied acceptance and retain the exact historical definition', () => {
  const p = project({ ...criterion, observation: { status: 'pass', observed_at: T, evidence_ref: 'old acceptance' } });
  const patch = prepareProjectPatch(p, { checkpoints: [{ id: 'a', criteria: [{ ...p.checkpoints.items[0].criteria[0], description: 'Different test' }] }], expected_checkpoints_revision: T });
  expect(patch.checkpoints.items[0].criteria[0].observation).toBeUndefined();
  expect(patch.checkpoints.items[0].history[0].definition.criteria[0].description).toBe(criterion.description);
});
test('knowledge links may name a checkpoint criterion', () => {
  const p = project();
  const patch = prepareProjectPatch(p, { needs: [{ id: 'n', kind: 'information', description: 'Question', status: 'open', created_at: T, knowledge: { question: 'Which?', satisfaction_test: 'Measured answer', criterion_ids: ['m'], blocking: true } }] }, { needMutation: {} });
  expect(patch.needs[0].knowledge.criterion_ids).toEqual(['m']);
});
test('adding a checkpoint invalidates an earlier final-goal success', () => {
  const p = { ...project(), checkpoints: null, end_state_assessment: { achieved: true } };
  const patch = prepareProjectPatch(p, { checkpoints: [{ title: 'First', criteria: [] }], expected_checkpoints_revision: null });
  expect(patch.end_state_assessment).toBeNull();
});
test('long-term edits with checkpoints require a project concurrency token', () => {
  expect(() => prepareProjectPatch(project(), { end_state: 'Changed destination' })).toThrow(/expected_updated_at/);
});
test('editing only a future need retains the current checkpoint assessment', () => {
  const p = project();
  p.checkpoints.items[0].assessment = { marker: 'current evidence' };
  p.needs = [{ id: 'future', kind: 'information', description: 'Later', status: 'open', created_at: T, knowledge: { question: 'Later?', satisfaction_test: 'Answer', criterion_ids: [], blocking: true, tags: [], task_ids: [], research_status: 'open', evidence: [] } }];
  p.checkpoints.items.push({ ...p.checkpoints.items[0], id: 'b', criteria: [], need_ids: ['future'], assessment: null });
  const patch = prepareProjectPatch(p, { needs: [{ ...p.needs[0], description: 'Later clarified' }] }, { needMutation: {} });
  expect((patch.checkpoints || p.checkpoints).items[0].assessment).toEqual({ marker: 'current evidence' });
});
test('a subsequent evidence patch cannot reuse old acceptance after a definition change', () => {
  const p = project({ ...criterion, observation: { status: 'pass', observed_at: '2026-09-01T00:00:00Z', evidence_ref: 'old acceptance' } });
  p.checkpoints.items[0].history = [{ kind: 'definition_changed', at: T, definition_revision: '2026-09-01T00:00:00Z' }];
  expect(submit(p).transition.outcome).toBe('recorded');
});
test('a caller cannot declare final achievement while checkpoints remain pending', () => {
  const p = project();
  const patch = prepareProjectPatch(p, { expected_updated_at: T, end_state_assessment: { evaluated_at: NOW, results: [], knowledge: { required: 0, satisfied: 0, unresolved: 0 }, achieved: true } });
  expect(patch.end_state_assessment.achieved).toBe(false);
  expect(patch.end_state_assessment.checkpoints.sequence_complete).toBe(false);
});
