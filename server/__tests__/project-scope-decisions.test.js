const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');

const runtimeKey = 'scope-test-runtime-'.padEnd(48, 'r');
const operatorKey = 'scope-test-operator-'.padEnd(48, 'o');
describe('authenticated direct project scope decisions', () => {
  let dir, db, raw, server, base;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-scope-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    jest.resetModules(); db = require('../../db');
    raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    const app = express(); app.use(express.json());
    app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: dir, getProjectById: async (_root, id) => db.getProject(id), getAllProjects: () => db.getProjects() }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/projects`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); raw.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.NEXUS_DB_PATH; delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY; delete process.env.NEXUS_OPERATOR_APPROVAL_KEY; });
  const project = async () => db.upsertProject({ id: crypto.randomUUID(), name: crypto.randomUUID(), path: '', description: 'Original scope', end_state: 'Original end', endpoint: { scope: 'Local pilot', beneficiary: 'Neighbors', exclusions: 'No sales' } });
  const input = (p, updates = { description: 'Changed scope' }) => ({ operation_id: crypto.randomUUID(), expected_updated_at: p.updated_at, decision_ref: { kind: 'chat_instruction', id: 'message:actual-123', instruction: 'Change this project scope and its goal as specified.', source_ref: 'nexus:chat:actual-123' }, updates });
  const request = async (id, body, headers = {}, method = 'POST') => {
    const response = await fetch(`${base}/${id}/scope-decisions`, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${runtimeKey}`, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  test('relays an actual instruction atomically without a task or proposal, recording honest authority', async () => {
    const p = await project(); const body = input(p, { description: 'Broader project', end_state: 'Ship the pilot', endpoint: { scope: 'Two neighborhoods' }, priority: 3 });
    const result = await request(p.id, body);
    if (result.status !== 200) throw new Error(JSON.stringify(result));
    expect(result.body.project).toMatchObject({ id: p.id, ...body.updates, endpoint: { scope: 'Two neighborhoods', beneficiary: 'Neighbors', exclusions: 'No sales' } });
    expect(result.body.receipt).toMatchObject({ project_id: p.id, operation_id: body.operation_id, decision_ref: body.decision_ref, origin: { kind: 'operator_relayed', authority: 'runtime_credential' }, reference_verification: 'runtime_attestation', updates: body.updates, before: { description: 'Original scope' }, after: { description: 'Broader project' } });
    expect(result.body.project.end_state_history.at(-1).end_state).toBe('Ship the pilot');
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(p.id).n).toBe(0);
    const history = await request(p.id, null, {}, 'GET'); expect(history.body.decisions).toEqual([result.body.receipt]);
    expect(() => raw.prepare('UPDATE project_scope_decisions SET receipt=? WHERE operation_id=?').run('{}', body.operation_id)).toThrow(/immutable/i);
  });
  test('clear strings, criteria and checkpoints retain canonical validation and guards', async () => {
    const p = await project();
    const result = await request(p.id, input(p, { description: '', end_state: '', endpoint: { scope: '', exclusions: '' }, end_state_criteria: [{ id: 'c1', kind: 'manual', description: 'Pilot works' }], checkpoints: [{ id: 'cp1', title: 'Pilot', goal: 'Try it' }], expected_checkpoints_revision: null }));
    if (result.status !== 200) throw new Error(JSON.stringify(result));
    expect(result.body.project).toMatchObject({ description: '', end_state: '', endpoint: { scope: '', exclusions: '', beneficiary: 'Neighbors' }, checkpoints: { items: [{ id: 'cp1' }] } });
    const stale = await request(p.id, input(result.body.project, { checkpoints: [], expected_checkpoints_revision: null })); expect(stale.status).toBe(409);
  });
  test('replay never overwrites newer scope and operation collisions fail', async () => {
    const p = await project(), body = input(p); const first = await request(p.id, body); expect(first.status).toBe(200);
    const later = await db.updateProject(p.id, { description: 'Newer change' });
    const replay = await request(p.id, body); expect(replay.status).toBe(200); expect(replay.body.replayed).toBe(true); expect(replay.body.receipt).toEqual(first.body.receipt);
    expect((await db.getProject(p.id)).description).toBe(later.description);
    expect((await request(p.id, { ...body, updates: { description: 'Collision' } })).status).toBe(409);
    const other = await project(); expect((await request(other.id, { ...body, expected_updated_at: other.updated_at })).status).toBe(409);
    expect((await request(p.id, input(p))).status).toBe(409);
  });
  test.each([
    ['unsupported', { updates: { intake: {}, description: 'No' } }],
    ['unrelated', { updates: { needs: [], description: 'No' } }],
    ['invalid status', { updates: { description: 'No', status: 'banana' } }],
    ['missing instruction', { decision_ref: { kind: 'chat_instruction', id: 'x' } }],
    ['forged approval flag', { approved: true }],
    ['unsupported reference', { decision_ref: { kind: 'operator_ruling', id: 'x', instruction: 'Do it' } }],
    ['missing CAS', { expected_updated_at: undefined }],
  ])('rejects %s without mutation', async (_name, change) => {
    const p = await project(); const result = await request(p.id, { ...input(p), ...change }); expect([400, 428]).toContain(result.status); expect(await db.getProject(p.id)).toEqual(p);
  });
  test.each([{ Authorization: '' }, { Authorization: 'Bearer executor-key' }, { 'x-praxis-bridge-token': 'bridge' }, { 'cf-access-client-id': 'executor' }])('rejects unverified/bridge credentials %j', async headers => {
    const p = await project(); expect((await request(p.id, input(p), headers)).status).toBe(403); expect(await db.getProject(p.id)).toEqual(p);
  });
  test('exact project identity only; missing runtime credential is technical failure', async () => {
    const p = await project(); expect((await request(p.name, input(p))).status).toBe(404);
    delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    const result = await request(p.id, input(p)); expect([403, 503]).toContain(result.status);
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    expect(await db.getProject(p.id)).toEqual(p);
  });
  test('receipt insertion failure rolls back scope and history', async () => {
    const p = await project(); raw.exec("CREATE TRIGGER fail_scope_receipt BEFORE INSERT ON project_scope_decisions BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    try { expect((await request(p.id, input(p, { end_state: 'Must roll back' }))).status).toBe(500); expect(await db.getProject(p.id)).toEqual(p); }
    finally { raw.exec('DROP TRIGGER fail_scope_receipt'); }
  });
  test('canonical intake changes mirror the brief before handoff', async () => {
    const p = (await db.createProjectIntake({ operation_id: crypto.randomUUID(), name: crypto.randomUUID(), problem: 'Help neighbors', source_ref: 'chat:original' })).project;
    const result = await request(p.id, input(p, { end_state: 'New outcome', endpoint: { scope: 'New scope', beneficiary: 'Neighbors' } }));
    if (result.status !== 200) throw new Error(JSON.stringify(result)); expect(result.body.project.phase).toBe('intake');
    expect(result.body.project.intake.brief).toMatchObject({ outcome: 'New outcome', scope: 'New scope' });
    expect(result.body.project.intake.brief_revision).toBeGreaterThan(p.intake.brief_revision);
  });
  test('endpoint boundaries invalidate prior proposal authority but suggested next work does not', async () => {
    let p = await project();
    const task = await db.createTask({ project_id: p.id, name: 'Suggested scope', status: 'idea' });
    const proposal = await db.proposeStakeholderAction(task.id, { kind: 'scope_change', content: { field: 'description', before: p.description, after: 'Suggested change', reason: 'Suggestion' } });
    await db.decideStakeholderProposal(task.id, { decision: 'approve', revision: proposal.revision, content_hash: proposal.content_hash }, 'operator_credential');
    let result = await request(p.id, input(p, { endpoint: { proposed_next: 'Maybe a second pilot' } }));
    expect(result.status).toBe(200); expect((await db.getStakeholderProposal(task.id)).state).toBe('approved');
    p = result.body.project;
    result = await request(p.id, input(p, { endpoint: { scope: 'Second pilot' } }));
    expect(result.status).toBe(200); expect((await db.getStakeholderProposal(task.id)).state).toBe('invalidated');
    expect(result.body.receipt.origin.kind).toBe('operator_relayed');
  });
  test('planning edits preserve historical intake acceptance and draft', async () => {
    let s = await db.createProjectIntake({ operation_id: crypto.randomUUID(), name: crypto.randomUUID(), problem: 'Plan the pilot', source_ref: 'chat:original' });
    s = await db.operateProjectIntake(s.project.id, { operation_id: crypto.randomUUID(), action: 'accept', expected_revision: s.intake.revision, brief_revision: s.intake.brief_revision, source_ref: 'chat:proceed', next_step: 'Plan' });
    const result = await request(s.project.id, input(s.project, { end_state: 'Changed after planning', endpoint: { scope: 'Wider' } }));
    expect(result.status).toBe(200); expect(result.body.project.phase).toBe('planning');
    expect(result.body.project.intake.acceptance).toEqual(s.intake.acceptance); expect(result.body.project.intake.brief).toEqual(s.intake.brief);
  });
  test('operator credential records its own honest origin', async () => {
    const p = await project(); const result = await request(p.id, input(p), { Authorization: `Bearer ${operatorKey}` });
    expect(result.status).toBe(200); expect(result.body.receipt.origin).toMatchObject({ kind: 'operator', authority: 'operator_credential' });
  });
  async function knowledgeFixture() {
    let p = await project();
    p = await db.updateProject(p.id, { end_state_criteria: [{ id: 'c1', kind: 'manual', description: 'Pilot works' }] });
    const task = await db.createTask({ project_id: p.id, name: 'Requested pilot research', status: 'planning', description: 'Preserve the task' });
    let n = (await db.updateProjectNeed(p.id, null, { kind: 'information', description: 'Pilot knowledge', source: 'operator', knowledge: { question: 'Can it work?', purpose: 'Inform pilot', satisfaction_test: 'Measured evidence', criterion_ids: ['c1'], task_ids: [task.id], resolution: { method: 'experiment', next_action: 'Try' } } })).need;
    n = (await db.updateProjectNeed(p.id, n.id, { expected_knowledge_revision: n.knowledge.revision, knowledge: { answer: 'Yes', evidence: [{ ref: 'test:result', summary: 'Measured' }] } })).need;
    n = (await db.updateProjectNeed(p.id, n.id, { expected_knowledge_revision: n.knowledge.revision, status: 'met', knowledge: { verification: { rationale: 'Measured', evidence_refs: ['test:result'] } } })).need;
    await db.updateProjectNeed(p.id, n.id, { record_application: { id: crypto.randomUUID(), status: 'applied', task_id: task.id, answer_revision: n.knowledge.revision, evidence_ref: 'task:result', notes: 'Applied to pilot' } });
    const intake = await db.createProjectIntake({ operation_id: crypto.randomUUID(), project_id: p.id, name: p.name, problem: 'Revisit pilot', source_ref: 'chat:adopt' });
    return { p: intake.project, task: await db.getTask(task.id), need: n };
  }
  test('adopted intake refreshes pending knowledge work in the scope transaction', async () => {
    const { p, task, need } = await knowledgeFixture();
    const result = await request(p.id, input(p, { end_state: 'Revised pilot goal' }));
    expect(result.status).toBe(200);
    expect(result.body.project.needs.find(n => n.id === need.id).knowledge.research_status).toBe('stale');
    const refreshed = await db.getTask(task.id); expect(refreshed.version).toBeGreaterThan(task.version); expect(refreshed.description).toContain('Preserve the task');
    expect(refreshed.metadata.knowledge_changes.at(-1).verification_pending).toBe(true);
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(p.id).n).toBe(1);
  });
  test.each(['receipt', 'task'])('%s failure rolls back project, pending task refresh and all receipts', async failAt => {
    const { p, task } = await knowledgeFixture();
    raw.exec(failAt === 'receipt' ? "CREATE TRIGGER scope_rollback BEFORE INSERT ON project_scope_decisions BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END"
      : "CREATE TRIGGER scope_rollback BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'test task failure'); END");
    try {
      const result = await request(p.id, input(p, { end_state: 'Must roll back completely' }));
      expect(result.status).toBeGreaterThanOrEqual(500); expect(await db.getProject(p.id)).toEqual(p); expect(await db.getTask(task.id)).toEqual(task);
      expect((await request(p.id, null, {}, 'GET')).body.decisions).toEqual([]);
    } finally { raw.exec('DROP TRIGGER scope_rollback'); }
  });

  test('accepts every canonical endpoint field and preserves requested legacy stack metadata', async () => {
    const p = await project();
    const endpoint = { scope: 'Pilot', beneficiary: 'Neighbors', exclusions: '', resource_budget: '$100', review_at: '2026-12-01', completion_policy: 'maintain', proposed_next: 'Review results' };
    const canonicalKeys = Object.keys(require('@praxis/contract').EndpointDefinitionSchema.shape).sort();
    expect(Object.keys(endpoint).sort()).toEqual(canonicalKeys);
    const result = await request(p.id, input(p, { endpoint, stack: ['TypeScript', 'SQLite'], tags: ['pilot'] }));
    expect(result.status).toBe(200); expect(result.body.project.endpoint).toEqual(endpoint); expect(result.body.project.stack).toEqual(['TypeScript', 'SQLite']);
  });
  test('project deletion preserves immutable audit history without blocking deletion', async () => {
    const p = await project(), body = input(p); const result = await request(p.id, body); expect(result.status).toBe(200);
    expect(await db.deleteProject(p.id)).toBe(true); expect(await db.getProject(p.id)).toBeNull();
    const history = await request(p.id, null, {}, 'GET'); expect(history.status).toBe(200); expect(history.body.decisions).toEqual([result.body.receipt]);
    expect((await request(p.id, body)).status).toBe(404);
  });

  test('description-only scope edits fence old intake council callbacks, while no-op edits preserve review', async () => {
    let s = await db.createProjectIntake({ operation_id: crypto.randomUUID(), name: crypto.randomUUID(), problem: 'Pilot idea', source_ref: 'chat:original' });
    const session_id = crypto.randomUUID();
    s = await db.operateProjectIntake(s.project.id, { operation_id: crypto.randomUUID(), action: 'request_review', mode: 'review', source_ref: 'chat:review', expected_revision: s.intake.revision, brief_revision: s.intake.brief_revision, session_id });
    const unchanged = await request(s.project.id, input(s.project, { description: s.project.description }));
    expect(unchanged.status).toBe(200); expect(unchanged.body.project.intake).toEqual(s.intake);
    const changed = await request(s.project.id, input(unchanged.body.project, { description: 'A materially different pilot' }));
    expect(changed.status).toBe(200); expect(changed.body.project.intake.brief).toEqual(s.intake.brief);
    expect(changed.body.project.intake.brief_revision).toBe(s.intake.brief_revision + 1);
    expect(changed.body.project.intake.review).toBeNull(); expect(changed.body.project.intake.review_history.at(-1)).toEqual(s.intake.review);
    expect(changed.body.project.phase).toBe('intake');
    await expect(Promise.resolve().then(() => db.operateProjectIntake(s.project.id, { operation_id: crypto.randomUUID(), action: 'record_review', expected_revision: changed.body.project.intake.revision, brief_revision: s.intake.brief_revision, session_id, source_ref: 'council:old', findings: [] }))).rejects.toMatchObject({ code: 'INTAKE_REVIEW_STALE' });
  });

});
