const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const criterion = { id: 'c1', kind: 'manual', description: 'Release approved', enabled: true, created_at: '2026-09-07T12:00:00Z' };
const knowledge = () => ({ question: 'Which rollout strategy meets the budget?', purpose: 'Choose a safe rollout', resolution: { method: 'experiment', next_action: 'Measure a trial' }, tags: ['#Safe Rollouts', 'safe-rollouts'], satisfaction_test: 'A measured trial supports the answer.', criterion_ids: ['c1'], task_ids: ['t1'], blocking: true, evidence: [] });

describe('project knowledge API and database invariants', () => {
  let db, raw, dir, server, url, oldDbPath;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-project-knowledge-'));
    oldDbPath = process.env.NEXUS_DB_PATH;
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.resetModules();
    db = require('../../db');
    raw = new Database(process.env.NEXUS_DB_PATH);
    raw.exec("ALTER TABLE projects ADD COLUMN status TEXT DEFAULT 'active'");
    const app = express();
    app.use(express.json());
    app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: dir, getProjectById: (_, id) => db.getProject(id), getAllProjects: () => db.getProjects(), scanProjects: jest.fn(), callAI: jest.fn(), contextSync: {} }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/api/projects/11111111-1111-4111-8111-111111111111`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    raw.close();
    if (oldDbPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = oldDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    raw.prepare('DELETE FROM projects').run();
    await db.upsertProject({ id: '11111111-1111-4111-8111-111111111111', name: 'Project', path: '/tmp/project', end_state: 'Reliable releases', end_state_criteria: [criterion] });
  });
  async function req(suffix, body, method = 'PATCH') {
    const response = await fetch(url + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function addNeed(extra = {}) {
    const result = await req('/needs', { kind: 'information', description: 'Rollout knowledge', source: 'operator', knowledge: knowledge(), ...extra }, 'POST');
    expect(result.status).toBe(201);
    return result.body.need;
  }
  async function satisfy(need) {
    const saved = await req(`/needs/${need.id}`, { expected_knowledge_revision: need.knowledge.revision, knowledge: { answer: 'Use a canary.', evidence: [{ ref: 'vault:trial', summary: 'Budget met.', checked_at: '2026-09-07T12:00:00Z' }] }, source: 'executor' });
    expect(saved.status).toBe(200);
    const result = await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: saved.body.need.knowledge.revision, knowledge: { verification: { rationale: 'The measured trial meets the budget.', evidence_refs: ['vault:trial'] } }, source: 'executor' });
    expect(result.status).toBe(200);
    return result.body.need;
  }

  test('marking verified research stale reopens its need while retaining answer and evidence', async () => {
    const verified = await satisfy(await addNeed());
    const stale = await req(`/needs/${verified.id}`, { knowledge: { research_status: 'stale' } });
    expect(stale.status).toBe(200);
    expect(stale.body.need.status).toBe('open');
    expect(stale.body.need.knowledge.research_status).toBe('stale');
    expect(stale.body.need.knowledge.answer).toBe(verified.knowledge.answer);
    expect(stale.body.need.knowledge.evidence).toEqual(verified.knowledge.evidence);
  });

  test('explicit observation clearing removes previous evidence without revising the definition', async () => {
    const observation = { status: 'pass', observed_at: '2026-09-07T12:00:00Z', evidence_ref: 'approval' };
    const observed = await req('', { end_state_criteria: [{ ...criterion, observation }] });
    expect(observed.status).toBe(200);
    const cleared = await req('', { end_state_criteria: [{ ...criterion, observation: null }] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.end_state_criteria[0]).not.toHaveProperty('observation');
    expect(cleared.body.end_state_updated_at).toBe(observed.body.end_state_updated_at);
    const current = await db.getProject('11111111-1111-4111-8111-111111111111');
    expect(current.end_state_criteria[0]).not.toHaveProperty('observation');
  });

  test('changing manual acceptance to a metric can explicitly discard incompatible prior evidence', async () => {
    await req('', { end_state_criteria: [{ ...criterion, observation: { status: 'pass', observed_at: '2026-09-07T12:00:00Z', evidence_ref: 'approval' } }] });
    const result = await req('', { end_state_criteria: [{ ...criterion, kind: 'metric', metric: { target: 90, operator: 'gte' }, observation: null }] });
    expect(result.status).toBe(200);
    expect(result.body.end_state_criteria[0].kind).toBe('metric');
    expect(result.body.end_state_criteria[0]).not.toHaveProperty('observation');
  });

  test('persists endpoint merge, metrics, assessment, revision snapshots and source', async () => {
    const metric = { id: 'm1', kind: 'metric', description: 'Availability', metric: { baseline: 95, target: 99, operator: 'gte', window_days: 7, min_samples: 5 }, observation: { status: 'pass', observed_at: '2026-09-07T12:00:00Z', evidence_ref: 'report', value: 99.5, sample_size: 10 } };
    const result = await req('', { endpoint: { scope: 'Canaries', beneficiary: 'Operators', completion_policy: 'maintain' }, end_state_criteria: [criterion, metric], end_state_source: 'operator', end_state_reason: 'Add measured readiness' });
    expect(result.status).toBe(200);
    expect(result.body.endpoint.scope).toBe('Canaries');
    expect(result.body.end_state_criteria[1].metric).toEqual(metric.metric);
    const revision = result.body.end_state_history.at(-1);
    expect(revision).toEqual(expect.objectContaining({ endpoint: result.body.endpoint, end_state_criteria: result.body.end_state_criteria, source: 'operator', reason: 'Add measured readiness' }));
    const assessment = { evaluated_at: '2026-09-07T12:00:00Z', endpoint_revision: revision.at, results: [{ id: 'c1', pass: false, status: 'unknown', checked_at: '2026-09-07T12:00:00Z' }], knowledge: { required: 1, satisfied: 0, unresolved: 1 }, achieved: false };
    expect((await req('', { end_state_assessment: assessment, expected_end_state_updated_at: revision.at, expected_updated_at: result.body.updated_at })).status).toBe(200);
    const proposed = await req('', { endpoint: { proposed_next: 'Expand later' } });
    expect(proposed.body.endpoint).toEqual({ ...result.body.endpoint, proposed_next: 'Expand later' });
    expect(proposed.body.end_state_updated_at).toBe(revision.at);
    expect(proposed.body.end_state_assessment).toEqual(assessment);
    const stored = JSON.parse(raw.prepare('SELECT endpoint FROM projects WHERE id = ?').get('11111111-1111-4111-8111-111111111111').endpoint);
    expect(stored).toEqual(proposed.body.endpoint);
    const board = await db.getBoardState();
    expect(board.find(p => p.id === '11111111-1111-4111-8111-111111111111')).toEqual(expect.objectContaining({ endpoint: stored, end_state_assessment: assessment }));
  });

  test('persists full questions and normalized tags without truncating', async () => {
    const fullQuestion = 'Why? '.repeat(200);
    const need = await addNeed({ knowledge: { ...knowledge(), question: fullQuestion } });
    expect(need.knowledge.question).toBe(fullQuestion);
    expect(need.knowledge.tags).toEqual(['safe-rollouts']);
    expect(need.knowledge.endpoint_revision).toBe((await db.getProject('11111111-1111-4111-8111-111111111111')).end_state_updated_at);
    expect((await db.getProject('11111111-1111-4111-8111-111111111111')).needs[0]).toEqual(need);
  });

  test('rejects satisfaction without answer and evidence without changing the project', async () => {
    const need = await addNeed();
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    const result = await req(`/needs/${need.id}`, { status: 'met', knowledge: { answer: 'A guess.' } });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/answer.*evidence|evidence.*answer/i);
    expect(await db.getProject('11111111-1111-4111-8111-111111111111')).toEqual(before);
  });

  test('a knowledge challenge invalidates verification requests prepared before it', async () => {
    const need = await satisfy(await addNeed());
    const challenge = await req(`/needs/${need.id}`, {record_application:{id:'race',task_id:'t',status:'insufficient',notes:'New environment contradicts answer',challenges_knowledge:true}});
    expect(challenge.body.need.knowledge.revision).toBe(need.knowledge.revision+1);
    expect(challenge.body.need.knowledge.history.at(-1).verification).toEqual(need.knowledge.verification);
    const stale = await req(`/needs/${need.id}`, {status:'met',expected_knowledge_revision:need.knowledge.revision,knowledge:{verification:need.knowledge.verification}});
    expect(stale.status).toBe(409);
    const retry=await req(`/needs/${need.id}`,{expected_knowledge_revision:need.knowledge.revision,record_application:{id:'race',task_id:'t',status:'insufficient',notes:'New environment contradicts answer',challenges_knowledge:true}});
    expect(retry.status).toBe(200);
    expect(retry.body.need.knowledge.applications).toHaveLength(1);
    expect(retry.body.need.knowledge.revision).toBe(challenge.body.need.knowledge.revision);
  });
  test('new legacy-shaped applications require a task and explanation', async () => {
    const need=await satisfy(await addNeed());
    expect((await req(`/needs/${need.id}`,{knowledge:{application:{status:'outdated'}}})).status).toBe(400);
  });
  test('replacement evidence requires a revision, atomic appends do not', async () => {
    const need=await addNeed();
    expect((await req(`/needs/${need.id}`,{append_evidence:[{ref:'new-reply'}]})).status).toBe(200);
    expect((await req(`/needs/${need.id}`,{knowledge:{evidence:[]}})).status).toBe(428);
    expect((await req(`/needs/${need.id}`,{expected_knowledge_revision:need.knowledge.revision,knowledge:{evidence:[]}})).status).toBe(409);
  });

  test('explicit satisfaction stamps verification and unrelated edits preserve it', async () => {
    const need = await satisfy(await addNeed());
    expect(need.knowledge.verified_at).toBeTruthy();
    expect(need.knowledge.verified_by).toBe('executor');
    expect(need.resolved_at).toBe(need.knowledge.verified_at);
    const edit = await req(`/needs/${need.id}`, { notes: 'Used in planning', knowledge: { tags: ['release'] } });
    expect(edit.body.need.knowledge.verified_at).toBe(need.knowledge.verified_at);
    expect(edit.body.need.status).toBe('met');
    expect(edit.body.need.source).toBe('operator');
    const project = await db.getProject('11111111-1111-4111-8111-111111111111');
    const saved = await req('', { description: 'Unrelated project edit', needs: project.needs, expected_updated_at: project.updated_at });
    expect(saved.status).toBe(200);
    expect(saved.body.needs).toEqual(project.needs);
  });

  test.each([
    ['question', { question: 'Which strategy handles a regional outage?' }],
    ['satisfaction test', { satisfaction_test: 'Measured regional outage trial' }],
    ['criterion scope', { criterion_ids: [] }],
    ['insufficient application', { application: { status: 'insufficient', task_id: 't1', notes: 'Trial did not generalize.' } }],
    ['outdated application', { application: { status: 'outdated', task_id: 't1', notes: 'Platform changed.' } }],
  ])('%s change reopens stale while keeping historical evidence', async (_, patch) => {
    const need = await satisfy(await addNeed());
    const edit = await req(`/needs/${need.id}`, { expected_knowledge_revision: need.knowledge.revision, knowledge: patch });
    expect(edit.status).toBe(200);
    expect(edit.body.need.status).toBe('open');
    expect(edit.body.need.resolved_at).toBeUndefined();
    expect(edit.body.need.knowledge).toEqual(expect.objectContaining({ research_status: 'stale', answer: need.knowledge.answer, evidence: need.knowledge.evidence, verified_at: need.knowledge.verified_at }));
    expect(edit.body.need.knowledge.review_reason).toBeTruthy();
  });

  test('endpoint changes invalidate assessments and reopen only linked structured needs', async () => {
    const linked = await satisfy(await addNeed());
    const unlinked = await satisfy(await addNeed({ knowledge: { ...knowledge(), criterion_ids: [] } }));
    const legacy = { id: 'old', kind: 'information', description: 'Old information need', status: 'met', created_at: '2020' };
    const stored = await db.getProject('11111111-1111-4111-8111-111111111111');
    raw.prepare('UPDATE projects SET needs = ? WHERE id = ?').run(JSON.stringify([...stored.needs, legacy]), stored.id);
    const revision = (await db.getProject('11111111-1111-4111-8111-111111111111')).end_state_updated_at;
    await req('', { expected_updated_at: (await db.getProject('11111111-1111-4111-8111-111111111111')).updated_at, end_state_assessment: { evaluated_at: '2026-09-07T12:00:00Z', endpoint_revision: revision, results: [], knowledge: { required: 1, satisfied: 1, unresolved: 0 } } });
    const edit = await req('', { end_state_criteria: [{ ...criterion, description: 'Approve multi-region release' }], end_state_source: 'operator' });
    expect(edit.status).toBe(200);
    expect(edit.body.end_state_assessment).toBeNull();
    expect(edit.body.end_state_updated_at).not.toBe(revision);
    expect(edit.body.needs.find(n => n.id === linked.id)).toEqual(expect.objectContaining({ status: 'open', knowledge: expect.objectContaining({ research_status: 'stale', evidence: linked.knowledge.evidence, endpoint_revision: edit.body.end_state_updated_at }) }));
    expect(edit.body.needs.find(n => n.id === unlinked.id).status).toBe('met');
    expect(edit.body.needs.find(n => n.id === legacy.id).status).toBe('met');
    const staleAssessment = await req('', { expected_updated_at: (await db.getProject('11111111-1111-4111-8111-111111111111')).updated_at, end_state_assessment: { evaluated_at: '2026-09-07T12:00:00Z', endpoint_revision: revision, results: [], knowledge: { required: 0, satisfied: 0, unresolved: 0 } }, expected_end_state_updated_at: revision });
    expect(staleAssessment.status).toBe(409);
  });

  test('rejects mismatched criterion links and malformed payloads atomically', async () => {
    const need = await addNeed();
    for (const patch of [{ knowledge: { criterion_ids: ['another-project'] } }, { knowledge: { question: ' ' } }, { knowledge: { evidence: [{ ref: 'x', checked_at: 'yesterday' }] } }, { knowledge: null }, { kind: 'credential' }]) {
      const before = await db.getProject('11111111-1111-4111-8111-111111111111');
      expect((await req(`/needs/${need.id}`, {...patch,expected_knowledge_revision:need.knowledge.revision})).status).toBe(400);
      expect(await db.getProject('11111111-1111-4111-8111-111111111111')).toEqual(before);
    }
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    expect((await req('', { endpoint: { scope: 'Changed' }, end_state_criteria: [{ id: 'm', kind: 'metric', description: 'Invalid' }] })).status).toBe(400);
    expect(await db.getProject('11111111-1111-4111-8111-111111111111')).toEqual(before);
  });

  test('whole-card saves cannot overwrite a concurrent per-need update or erase knowledge', async () => {
    const need = await addNeed();
    const old = await db.getProject('11111111-1111-4111-8111-111111111111');
    expect((await req(`/needs/${need.id}`, { notes: 'Latest operator note' })).status).toBe(200);
    expect((await req('', { needs: old.needs, expected_updated_at: old.updated_at })).status).toBe(409);
    expect((await req('', { needs: old.needs })).status).toBe(428);
    const current = await db.getProject('11111111-1111-4111-8111-111111111111');
    const reduced = current.needs.map(({ knowledge: ignored, ...rest }) => rest);
    const result = await req('', { needs: reduced, expected_updated_at: current.updated_at });
    expect(result.status).toBe(200);
    expect(result.body.needs[0].knowledge).toEqual(current.needs[0].knowledge);
    expect(result.body.needs[0].notes).toBe('Latest operator note');
  });

  test('simultaneous need additions and independent per-need patches preserve both records', async () => {
    const [first, second] = await Promise.all([addNeed(), addNeed({ description: 'Second need' })]);
    expect((await db.getProject('11111111-1111-4111-8111-111111111111')).needs).toHaveLength(2);
    const results = await Promise.all([req(`/needs/${first.id}`, { notes: 'First update' }), req(`/needs/${second.id}`, { notes: 'Second update' })]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const stored = await db.getProject('11111111-1111-4111-8111-111111111111');
    expect(stored.needs.map(n => n.notes).sort()).toEqual(['First update', 'Second update']);
  });

  test('first proposed-next write leaves the current definition revision and satisfied needs unchanged', async () => {
    const need = await satisfy(await addNeed());
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    const result = await req('', { endpoint: { proposed_next: 'Consider wider rollout later' } });
    expect(result.status).toBe(200);
    expect(result.body.end_state_updated_at).toBe(before.end_state_updated_at);
    expect(result.body.needs[0]).toEqual(need);
  });

  test('observation-only updates invalidate assessment without reopening linked knowledge', async () => {
    const need = await satisfy(await addNeed());
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    await req('', { expected_updated_at: (await db.getProject('11111111-1111-4111-8111-111111111111')).updated_at, end_state_assessment: { evaluated_at: '2026-09-07T12:00:00Z', endpoint_revision: before.end_state_updated_at, results: [], knowledge: { required: 1, satisfied: 1, unresolved: 0 } } });
    const result = await req('', { end_state_criteria: [{ ...criterion, observation: { status: 'pass', observed_at: '2026-09-07T12:00:00Z', evidence_ref: 'review' } }] });
    expect(result.status).toBe(200);
    expect(result.body.end_state_updated_at).toBe(before.end_state_updated_at);
    expect(result.body.end_state_assessment).toBeNull();
    expect(result.body.needs[0]).toEqual(need);
  });

  test('new legacy-shaped need in whole-card save cannot clear a structured question or bypass proof', async () => {
    const need = await addNeed();
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    const { knowledge: ignored, ...legacyShape } = need;
    const result = await req('', { needs: [{ ...legacyShape, status: 'met' }], expected_updated_at: before.updated_at });
    expect(result.status).toBe(400);
    expect(await db.getProject('11111111-1111-4111-8111-111111111111')).toEqual(before);
  });

  test('legacy met records and long notes remain byte-for-byte intact when another need is added', async () => {
    const legacy = { id: 'old', kind: 'information', description: 'Legacy description', status: 'met', created_at: '2020', resolved_at: '2021', notes: 'Old notes '.repeat(100), custom_history: ['untouched'] };
    raw.prepare('UPDATE projects SET needs = ? WHERE id = ?').run(JSON.stringify([legacy]), '11111111-1111-4111-8111-111111111111');
    await addNeed();
    expect((await db.getProject('11111111-1111-4111-8111-111111111111')).needs[0]).toEqual(legacy);
  });

  test('revisions do not prevent reviewing a stale need whose old criterion was removed', async () => {
    const need = await satisfy(await addNeed());
    expect((await req('', { end_state_criteria: [] })).status).toBe(200);
    const review = await req(`/needs/${need.id}`, { notes: 'Retain the prior link for audit; scope is under review.' });
    expect(review.status).toBe(200);
    expect(review.body.need.knowledge.evidence).toEqual(need.knowledge.evidence);
    expect((await req(`/needs/${need.id}`, { status: 'met' })).status).toBeGreaterThanOrEqual(400);
  });

  test('assessment writes require a card guard and reject stale evidence snapshots', async () => {
    const need = await satisfy(await addNeed());
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    const assessment = { evaluated_at: new Date().toISOString(), endpoint_revision: before.end_state_updated_at, results: [], knowledge: { required: 1, satisfied: 1, unresolved: 0 }, achieved: true };
    expect((await req('', { end_state_assessment: assessment })).status).toBe(428);
    expect((await req('', { end_state_assessment: assessment, expected_updated_at: before.updated_at })).status).toBe(200);
    const snapshot = await db.getProject('11111111-1111-4111-8111-111111111111');
    await req(`/needs/${need.id}`, { knowledge: { application: { status: 'outdated', task_id:'t1', notes:'New platform evidence' } } });
    expect((await req('', { end_state_assessment: assessment, expected_updated_at: snapshot.updated_at, expected_end_state_updated_at: snapshot.end_state_updated_at })).status).toBe(409);
    expect((await db.getProject('11111111-1111-4111-8111-111111111111')).end_state_assessment).toBeNull();
  });

  test('need routes retain project-name addressing compatibility', async () => {
    const nameUrl = url.replace('11111111-1111-4111-8111-111111111111', 'Project');
    const added = await fetch(`${nameUrl}/needs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'information', description: 'By name', knowledge: knowledge() }) });
    expect(added.status).toBe(201);
    const { need } = await added.json();
    const changed = await fetch(`${nameUrl}/needs/${need.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'Still resolves' }) });
    expect(changed.status).toBe(200);
    expect((await changed.json()).need.notes).toBe('Still resolves');
  });

  test('explicit re-verification clears stale research state while preserving evidence history', async () => {
    const need = await satisfy(await addNeed());
    const reopened = await req(`/needs/${need.id}`, { status: 'open' });
    expect(reopened.body.need.knowledge.research_status).toBe('stale');
    const verified = await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: reopened.body.need.knowledge.revision, knowledge: { verification: { rationale: 'Rechecked the original trial against current scope.', evidence_refs: ['vault:trial'] } }, source: 'reviewer' });
    expect(verified.status).toBe(200);
    expect(verified.body.need.knowledge.research_status).toBe('evidence_ready');
    expect(verified.body.need.knowledge.verified_at).not.toBe(need.knowledge.verified_at);
    expect(verified.body.need.knowledge.verified_by).toBe('reviewer');
    expect(verified.body.need.knowledge.evidence).toEqual(need.knowledge.evidence);
    expect(verified.body.need.knowledge.review_reason).toBeUndefined();
  });

  test('database callers enforce evidence and snapshot revisions on upsert', async () => {
    const need = await addNeed();
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    await expect(db.updateProject('11111111-1111-4111-8111-111111111111', { needs: [{ ...need, status: 'met' }], expected_updated_at: before.updated_at })).rejects.toMatchObject({ status: 400 });
    expect(await db.getProject('11111111-1111-4111-8111-111111111111')).toEqual(before);
    const updated = await db.upsertProject({ id: '11111111-1111-4111-8111-111111111111', name: 'Project', path: '/tmp/project', endpoint: { scope: 'Expanded' } });
    expect(updated.end_state_history.at(-1).endpoint.scope).toBe('Expanded');
  });

  test('new information needs require an explicit purpose and resolution while legacy edits remain supported', async () => {
    for (const k of [undefined, { ...knowledge(), purpose: undefined }, { ...knowledge(), resolution: undefined }]) {
      expect((await req('/needs', { kind: 'information', description: 'Missing structure', knowledge: k }, 'POST')).status).toBe(400);
    }
    const legacy = { id: 'old', kind: 'information', description: 'Old fact', status: 'met', created_at: '2020' };
    raw.prepare('UPDATE projects SET needs = ? WHERE id = ?').run(JSON.stringify([legacy]), '11111111-1111-4111-8111-111111111111');
    const edited = await req('/needs/old', { notes: 'Reviewed legacy record' });
    expect(edited.status).toBe(200);
    expect(edited.body.need).toMatchObject({ ...legacy, notes: 'Reviewed legacy record' });
    expect(edited.body.need.knowledge).toBeUndefined();
  });

  test('verification requires a fresh guard, explicit rationale and evidence selected from this answer', async () => {
    const need = await satisfy(await addNeed());
    const reopened = (await req(`/needs/${need.id}`, { status: 'open' })).body.need;
    for (const patch of [
      { status: 'met' },
      { status: 'met', expected_knowledge_revision: reopened.knowledge.revision },
      { status: 'met', expected_knowledge_revision: reopened.knowledge.revision, knowledge: { verification: { rationale: ' ', evidence_refs: ['vault:trial'] } } },
      { status: 'met', expected_knowledge_revision: reopened.knowledge.revision, knowledge: { verification: { rationale: 'Claim', evidence_refs: ['vault:unrelated'] } } },
    ]) expect((await req(`/needs/${need.id}`, {...patch,expected_knowledge_revision:need.knowledge.revision})).status).toBeGreaterThanOrEqual(400);
    const stale = await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: reopened.knowledge.revision - 1, knowledge: { verification: { rationale: 'Reviewed', evidence_refs: ['vault:trial'] } } });
    expect(stale.status).toBe(409);
    const result = await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: reopened.knowledge.revision, knowledge: { verification: { rationale: 'The trial remains relevant to the scoped question.', evidence_refs: ['vault:trial'] } }, source: 'reviewer' });
    expect(result.status).toBe(200);
    expect(result.body.need.knowledge.verification).toMatchObject({ revision: reopened.knowledge.revision, by: 'reviewer', evidence_refs: ['vault:trial'] });
  });

  test('changed answers must be saved before verification and preserve immutable prior revisions', async () => {
    const need = await satisfy(await addNeed());
    const before = await db.getProject('11111111-1111-4111-8111-111111111111');
    const combined = await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: need.knowledge.revision, knowledge: { answer: 'Use blue-green.', verification: { rationale: 'Changed answer', evidence_refs: ['vault:trial'] } } });
    expect(combined.status).toBe(400);
    expect(await db.getProject(before.id)).toEqual(before);
    const edited = await req(`/needs/${need.id}`, { expected_knowledge_revision: need.knowledge.revision, knowledge: { answer: 'Use blue-green.', revision: 900, history: [], verified_at: 'forged', verification: { rationale: 'forged', evidence_refs: ['vault:trial'], revision: 900 } } });
    expect(edited.status).toBe(200);
    expect(edited.body.need.status).toBe('open');
    expect(edited.body.need.knowledge.revision).toBe(need.knowledge.revision + 1);
    expect(edited.body.need.knowledge.history.at(-1)).toMatchObject({ revision: need.knowledge.revision, question: need.knowledge.question, answer: need.knowledge.answer, evidence: need.knowledge.evidence, verification: need.knowledge.verification });
    const again = await req(`/needs/${need.id}`, { knowledge: { history: [], revision: 1000 }, notes: 'Keep history' });
    expect(again.body.need.knowledge.history).toEqual(edited.body.need.knowledge.history);
    expect(again.body.need.knowledge.verified_at).toBe(need.knowledge.verified_at);
  });

  test('concurrent evidence appends retain both refs and repeated refs are idempotent', async () => {
    const need = await addNeed();
    const results = await Promise.all(['vault:a', 'vault:b'].map(ref => req(`/needs/${need.id}`, { append_evidence: [{ ref }] })));
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const current = (await db.getProject('11111111-1111-4111-8111-111111111111')).needs[0];
    expect(current.knowledge.evidence.map(e => e.ref).sort()).toEqual(['vault:a', 'vault:b']);
    expect(current.knowledge.revision).toBe(need.knowledge.revision + 2);
    expect(current.status).toBe('open');
    const replay = await req(`/needs/${need.id}`, { append_evidence: [{ ref: 'vault:a' }] });
    expect(replay.body.need.knowledge.revision).toBe(current.knowledge.revision);
    expect(replay.body.need.knowledge.evidence).toEqual(current.knowledge.evidence);
  });

  test('application history records multiple tasks, replays idempotently and rejects changed IDs', async () => {
    const need = await satisfy(await addNeed());
    const record = { id: 'app-a', task_id: 'task-a', status: 'applied', answer_revision: need.knowledge.revision, evidence_ref: 'task:result-a', notes: 'The canary was used for this release.' };
    const first = await req(`/needs/${need.id}`, { record_application: record });
    expect(first.status).toBe(200);
    const second = await req(`/needs/${need.id}`, { record_application: { ...record, id: 'app-b', task_id: 'task-b', status: 'validated' } });
    expect(second.body.need.knowledge.applications).toHaveLength(2);
    expect(second.body.need.knowledge.applications[0]).toMatchObject(record);
    expect((await req(`/needs/${need.id}`, { record_application: record })).body.need.knowledge.applications).toEqual(second.body.need.knowledge.applications);
    expect((await req(`/needs/${need.id}`, { record_application: { ...record, notes: 'Changed result' } })).status).toBe(409);
    for (const bad of [{ ...record, id: 'bad', notes: '' }, { ...record, id: 'bad', task_id: '' }, { ...record, id: 'bad', evidence_ref: undefined }, { ...record, id: 'bad', answer_revision: need.knowledge.revision - 1 }]) expect((await req(`/needs/${need.id}`, { record_application: bad })).status).toBeGreaterThanOrEqual(400);
    expect((await req(`/needs/${need.id}`, { record_application: { id: 'not-relevant', status: 'not_relevant', task_id: 'other', notes: 'This task does not use rollout strategy.' } })).body.need.status).toBe('met');
    expect((await req(`/needs/${need.id}`, { record_application: { id: 'task-failed', status: 'insufficient', task_id: 'failed', notes: 'Task failed due to unavailable credentials.', challenges_knowledge: false } })).body.need.status).toBe('met');
    const challenge = await req(`/needs/${need.id}`, { record_application: { id: 'challenged', status: 'outdated', task_id: 'new-release', notes: 'The target platform has changed.', challenges_knowledge: true } });
    expect(challenge.body.need.status).toBe('open');
    expect(challenge.body.need.knowledge.applications).toHaveLength(5);
    expect(challenge.body.need.knowledge.verification).toEqual(need.knowledge.verification);
    expect((await req(`/needs/${need.id}`, { record_application: { ...record, id: 'after-stale' } })).status).toBeGreaterThanOrEqual(400);
  });

  test('whole-card writers cannot bypass verification guards or overwrite application history', async () => {
    const need = await satisfy(await addNeed());
    const reopened = (await req(`/needs/${need.id}`, { status: 'open' })).body.need;
    let current = await db.getProject('11111111-1111-4111-8111-111111111111');
    expect((await req('', { needs: [{ ...reopened, status: 'met' }], expected_updated_at: current.updated_at })).status).toBeGreaterThanOrEqual(400);
    const record = { id: 'ready-a', status: 'ready', task_id: 'task-a', notes: 'Ready for verification.' };
    const app = await req(`/needs/${need.id}`, { record_application: record });
    current = await db.getProject(current.id);
    const result = await req('', { needs: [{ ...app.body.need, knowledge: { ...app.body.need.knowledge, applications: [] } }], expected_updated_at: current.updated_at });
    expect(result.status).toBe(200);
    expect(result.body.needs[0].knowledge.applications).toEqual(app.body.need.knowledge.applications);
  });


  test('legacy migration requires explicit structure and mixed evidence replacement/append is rejected', async () => {
    const legacy = { id: 'old', kind: 'information', description: 'Old fact', status: 'open', created_at: '2020' };
    raw.prepare('UPDATE projects SET needs = ? WHERE id = ?').run(JSON.stringify([legacy]), '11111111-1111-4111-8111-111111111111');
    expect((await req('/needs/old', { knowledge: { question: 'A question?', satisfaction_test: 'A documented answer.' } })).status).toBe(400);
    const migrated = await req('/needs/old', { knowledge: knowledge() });
    expect(migrated.status).toBe(200);
    expect((await req('/needs/old', { knowledge: { evidence: [] }, append_evidence: [{ ref: 'vault:new' }] })).status).toBe(400);
  });

  test('scope invalidation fences an in-flight verification and retains its old answer revision', async () => {
    const need = await satisfy(await addNeed());
    const changed = await req('', { end_state_criteria: [{ ...criterion, description: 'A new scope' }] });
    expect(changed.status).toBe(200);
    const current = changed.body.needs[0];
    expect(current.knowledge.revision).toBe(need.knowledge.revision + 1);
    expect(current.knowledge.history.at(-1)).toMatchObject({ revision: need.knowledge.revision, answer: need.knowledge.answer, verification: need.knowledge.verification });
    expect((await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: need.knowledge.revision, knowledge: { verification: { rationale: 'Review started before scope changed.', evidence_refs: ['vault:trial'] } } })).status).toBe(409);
  });

  test('malformed operation payloads fail atomically and forged verification stamps are ignored', async () => {
    const need = await addNeed();
    for (const patch of [{ expected_knowledge_revision: null }, { expected_knowledge_revision: '1' }, { append_evidence: {} }, { append_evidence: [{ ref: '' }] }, { record_application: {} }]) {
      const before = await db.getProject('11111111-1111-4111-8111-111111111111');
      expect((await req(`/needs/${need.id}`, patch)).status).toBe(400);
      expect(await db.getProject(before.id)).toEqual(before);
    }
    const forged = await req(`/needs/${need.id}`, { knowledge: { verified_at: '2026-10-17T12:00:00Z', verified_by: 'forged', revision: 100, history: [], applications: [{ id: 'fake', status: 'validated' }], verification: { rationale: 'forged', evidence_refs: ['vault:fake'] } } });
    expect(forged.status).toBe(200);
    expect(forged.body.need.knowledge.revision).toBe(need.knowledge.revision);
    expect(forged.body.need.knowledge.verification).toBeUndefined();
    expect(forged.body.need.knowledge.verified_at).toBeUndefined();
    expect(forged.body.need.knowledge.applications).toBeUndefined();
  });


  test('answer replacement requires its read revision and rejects stale writers atomically', async () => {
    const need = await addNeed();
    expect((await req(`/needs/${need.id}`, { knowledge: { answer: 'Unguarded guess' } })).status).toBe(428);
    const saved = await req(`/needs/${need.id}`, { expected_knowledge_revision: need.knowledge.revision, knowledge: { answer: 'Use a canary.' } });
    expect(saved.status).toBe(200);
    expect((await req(`/needs/${need.id}`, { expected_knowledge_revision: need.knowledge.revision, knowledge: { answer: 'An old conflicting answer.' } })).status).toBe(409);
    const current = await db.getProject('11111111-1111-4111-8111-111111111111');
    expect((await req('', { needs: [{ ...saved.body.need, knowledge: { ...saved.body.need.knowledge, answer: 'Whole-card replacement' } }], expected_updated_at: current.updated_at })).status).toBe(428);
    expect(await db.getProject(current.id)).toEqual(current);
  });
  test('malformed whole-card needs reject as client errors', async () => {
    const current = await db.getProject('11111111-1111-4111-8111-111111111111');
    expect((await req('', { needs: [null], expected_updated_at: current.updated_at })).status).toBe(400);
  });

});
