const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('applied knowledge changes route real pending work atomically', () => {
  let db, raw, dir, server, url, oldDbPath;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-knowledge-change-'));
    oldDbPath = process.env.NEXUS_DB_PATH;
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.resetModules();
    db = require('../../db');
    raw = new Database(process.env.NEXUS_DB_PATH);
    // Lifecycle status is now present in the base schema and intake migration.
    raw.exec(`CREATE TABLE task_dispatches (id TEXT PRIMARY KEY, task_id TEXT, kind TEXT DEFAULT 'dispatch', executor TEXT,
      outcome TEXT, started_at TEXT);`);
    const app = express();
    app.use(express.json());
    app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: dir, getProjectById: (_, id) => db.getProject(id),
      getAllProjects: () => db.getProjects(), scanProjects: jest.fn(), callAI: jest.fn(), contextSync: {} }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/api/projects/${PROJECT}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    raw.close();
    if (oldDbPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = oldDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    raw.exec('DELETE FROM task_dispatches; DELETE FROM projects;');
    await db.upsertProject({ id: PROJECT, name: 'Project', path: dir, end_state: 'Reliable release',
      end_state_criteria: [{ id: 'c1', kind: 'manual', description: 'Release approved' }] });
  });
  async function req(suffix, body, method = 'PATCH') {
    const response = await fetch(url + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function applied({ taskStatus = 'completed', taskId = 'original', taskFields = {}, taskIds, applicationStatus = 'applied' } = {}) {
    if (taskStatus) expect(await db.createTask({ id: taskId, project_id: PROJECT, name: 'Deploy canary rollout',
      description: 'Preserve this original brief.', dispatch_instructions: 'Preserve standing instructions.', status: taskStatus,
      metadata: { unrelated: { preserve: true } }, ...taskFields })).toBeTruthy();
    const added = await req('/needs', { kind: 'information', description: 'Rollout strategy', source: 'operator', knowledge: {
      question: 'Which rollout strategy meets the budget?', purpose: 'Choose the release strategy',
      resolution: { method: 'experiment', next_action: 'Measure a trial' }, satisfaction_test: 'A measured trial supports the answer.',
      criterion_ids: ['c1'], task_ids: taskIds || [taskId], evidence: [],
    } }, 'POST');
    expect(added.status).toBe(201);
    let need = added.body.need;
    const saved = await req(`/needs/${need.id}`, { expected_knowledge_revision: need.knowledge.revision,
      knowledge: { answer: 'Use a canary.', evidence: [{ ref: 'vault:trial', summary: 'Budget met.' }] } });
    expect(saved.status).toBe(200);
    need = saved.body.need;
    const verified = await req(`/needs/${need.id}`, { expected_knowledge_revision: need.knowledge.revision, status: 'met',
      knowledge: { verification: { rationale: 'Measured trial meets the budget.', evidence_refs: ['vault:trial'] } } });
    expect(verified.status).toBe(200);
    const result = await req(`/needs/${need.id}`, { record_application: { id: 'applied-original', status: applicationStatus,
      task_id: taskId, answer_revision: need.knowledge.revision, evidence_ref: 'task:original:result', notes: 'Used in the release.' } });
    expect(result.status).toBe(200);
    return result.body.need;
  }
  const tasks = () => raw.prepare('SELECT * FROM tasks ORDER BY id').all();
  const revise = (need, knowledge = { answer: 'Use blue-green deployment.' }) => req(`/needs/${need.id}`, {
    expected_knowledge_revision: need.knowledge.revision, knowledge,
  });
  const receipts = need => (need.knowledge.applications || []).filter(a => a.id.startsWith('knowledge-change:'));

  test('intake corrections preserve knowledge history without routing delivery work', async () => {
    const need = await applied();
    await db.createProjectIntake({ operation_id: 'adopt-intake', project_id: PROJECT, name: 'Project', problem: 'Review our assumptions', source_ref: 'chat:intake' });
    const before = tasks();
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect(result.body.need.knowledge.answer).toBe('Use blue-green deployment.');
    expect(tasks()).toEqual(before);
  });

  test.each(['canonical', 'intake'])('%s corrections during Intake refresh authorized pending work without creating a reconciliation task', async api => {
    const need = await applied({ taskIds: ['original', 'pending'] });
    await db.createTask({ id: 'pending', project_id: PROJECT, name: 'Requested rollout research', status: 'planning', description: 'Keep the requested scope.', metadata: { knowledge_need_ids: [need.id], other: 'Preserved' } });
    const original = await db.getTask('original'), pending = await db.getTask('pending');
    let p = await db.createProjectIntake({ operation_id: 'adopt-intake', project_id: PROJECT, name: 'Project', problem: 'Review our assumptions', source_ref: 'chat:intake' });
    p = await db.operateProjectIntake(PROJECT, { operation_id: 'defer-intake', expected_revision: p.intake.revision, action: 'defer' });
    const result = api === 'canonical' ? await revise(need) : await req('/intake/operations', { operation_id: 'correct-intake', expected_revision: p.intake.revision, action: 'answer', need_id: need.id, expected_knowledge_revision: need.knowledge.revision, answer: 'Use blue-green deployment.', source_ref: 'chat:correction' }, 'POST');
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(2);
    expect(await db.getTask('original')).toEqual(original);
    const refreshed = await db.getTask('pending');
    expect(refreshed.version).toBeGreaterThan(pending.version);
    expect(refreshed.description).toContain('Keep the requested scope.');
    expect(refreshed.dispatch_instructions).toContain('Answer: Use blue-green deployment.');
    expect(refreshed.metadata.other).toBe('Preserved');
    expect(refreshed.metadata.knowledge_changes.at(-1)).toMatchObject({ need_id: need.id, answer: 'Use blue-green deployment.', verification_pending: true });
    expect((await db.getProject(PROJECT)).intake.state).toBe('deferred');
    const current = (await db.getProject(PROJECT)).needs.find(n => n.id === need.id);
    expect(receipts(current)).toEqual([expect.objectContaining({ task_id: 'pending', status: 'ready', notes: expect.stringMatching(/updated/i) })]);
  });

  test('intake receipt failure rolls back refreshed pending work with the answer', async () => {
    const need = await applied({ taskStatus: 'planning' });
    const p = await db.createProjectIntake({ operation_id: 'adopt-intake', project_id: PROJECT, name: 'Project', problem: 'Review our assumptions', source_ref: 'chat:intake' });
    const task = await db.getTask('original');
    raw.exec("CREATE TRIGGER refuse_intake_receipt BEFORE INSERT ON project_intake_operations BEGIN SELECT RAISE(ABORT, 'test receipt refusal'); END;");
    try {
      const result = await req('/intake/operations', { operation_id: 'failed-intake', expected_revision: p.intake.revision, action: 'answer', need_id: need.id, expected_knowledge_revision: need.knowledge.revision, answer: 'Use blue-green deployment.', source_ref: 'chat:correction' }, 'POST');
      expect(result.status).toBe(500);
      expect(await db.getTask('original')).toEqual(task);
      expect((await db.getProjectIntake(PROJECT))).toEqual(p);
    } finally { raw.exec('DROP TRIGGER refuse_intake_receipt'); }
  });

  const sourceLinkedIntake = async () => {
    const need = await applied({ taskIds: ['original', 'pending-a', 'pending-b', 'running'] });
    for (const id of ['pending-a', 'pending-b', 'running']) {
      const name = { 'pending-a': 'Validate trial cost measurements', 'pending-b': 'Evaluate failover options', running: 'Execute release observation' }[id];
      const created = await db.createTask({ id, project_id: PROJECT, name, status: id === 'running' ? 'in_progress' : 'planning',
        description: `Preserve requested scope. ${name}.`, metadata: { knowledge_need_ids: [need.id], other: 'Preserved',
          knowledge_context: { version: 1, lookup_status: 'available', requirements: [{ id: `need:${need.id}`, need_id: need.id, question: need.knowledge.question, tags: [], satisfaction_test: need.knowledge.satisfaction_test,
            reason: 'Previously verified from the original source.', source_refs: ['vault:trial'], verified: true, answer_revision: need.knowledge.revision }] } } });
      expect(created?.id).toBe(id);
    }
    const source = { ref: 'vault:trial', type: 'other', availability: 'available', revision: 'v1', summary: 'Budget met.' };
    let p = await db.createProjectIntake({ operation_id: 'adopt-intake', project_id: PROJECT, name: 'Project', problem: 'Review our assumptions', source_ref: 'chat:intake', sources: [source] });
    p = await db.operateProjectIntake(PROJECT, { operation_id: 'defer-intake', expected_revision: p.intake.revision, action: 'defer' });
    return { need, source, p };
  };
  const sourceRevision = (p, source, revision) => ({ operation_id: `source-${revision}`, expected_revision: p.intake.revision, action: 'revise', sources: [{ ...source, revision }] });

  test('source-only intake revisions refresh pending task freshness without creating work or altering completed and running tasks', async () => {
    let { need, source, p } = await sourceLinkedIntake();
    const original = await db.getTask('original'), running = await db.getTask('running');
    for (const revision of ['v2', 'v3']) {
      const pending = await db.getTask('pending-a');
      const input = sourceRevision(p, source, revision);
      const result = await req('/intake/operations', input, 'POST');
      expect(result.status).toBe(200);
      p = result.body;
      const reopened = p.project.needs.find(n => n.id === need.id);
      expect(reopened).toMatchObject({ status: 'open', knowledge: { answer: need.knowledge.answer, research_status: 'stale', revision: need.knowledge.revision + (revision === 'v2' ? 1 : 2) } });
      expect(reopened.knowledge.evidence).toEqual(need.knowledge.evidence);
      const refreshed = await db.getTask('pending-a');
      expect(refreshed.version).toBeGreaterThan(pending.version);
      expect(refreshed.description).toContain('Preserve requested scope.');
      expect(refreshed.dispatch_instructions).toContain('Required first step: re-verify');
      expect(refreshed.metadata.knowledge_changes.at(-1)).toMatchObject({ need_id: need.id, revision: reopened.knowledge.revision, verification_pending: true });
      expect(refreshed.metadata.knowledge_context.requirements[0]).toMatchObject({ need_id: need.id, reason: expect.stringMatching(/re-verification is required/), source_refs: ['vault:trial'] });
      expect(refreshed.metadata.knowledge_context.requirements[0].verified).toBeUndefined();
      expect(refreshed.metadata.other).toBe('Preserved');
      expect((await db.getTask('pending-b')).metadata.knowledge_changes.at(-1).revision).toBe(reopened.knowledge.revision);
      expect(await db.getTask('original')).toEqual(original);
      expect(await db.getTask('running')).toEqual(running);
      expect(tasks()).toHaveLength(4);
      expect(p.intake.state).toBe('deferred');
      const storedTasks = tasks();
      expect((await req('/intake/operations', input, 'POST')).body).toEqual(p);
      expect(tasks()).toEqual(storedTasks);
    }
    const beforeRefresh = tasks();
    const refreshed = await req('/intake/operations', { ...sourceRevision(p, source, 'v3'), operation_id: 'retrieved-again', sources: [{ ...source, revision: 'v3', retrieved_at: '2026-11-01T14:00:00Z' }] }, 'POST');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.intake.brief_revision).toBe(p.intake.brief_revision);
    expect(tasks()).toEqual(beforeRefresh);
  });

  test('canonical knowledge invalidation during Intake refreshes pending tasks without creating work', async () => {
    const { need } = await sourceLinkedIntake();
    const result = await req(`/needs/${need.id}`, { status: 'open', expected_knowledge_revision: need.knowledge.revision });
    expect(result.status).toBe(200);
    expect((await db.getTask('pending-a')).metadata).toMatchObject({ knowledge_changes: [expect.objectContaining({ need_id: need.id, verification_pending: true })] });
    expect(tasks()).toHaveLength(4);
  });

  test.each(['task update', 'receipt'])('source-only intake invalidation rolls back needs and every pending refresh on %s failure', async failure => {
    const { source, p } = await sourceLinkedIntake();
    const beforeTasks = tasks();
    const trigger = failure === 'task update'
      ? "CREATE TRIGGER refuse_source_refresh BEFORE UPDATE ON tasks WHEN NEW.id = 'pending-b' BEGIN SELECT RAISE(ABORT, 'test task refresh refusal'); END;"
      : "CREATE TRIGGER refuse_source_refresh BEFORE INSERT ON project_intake_operations BEGIN SELECT RAISE(ABORT, 'test receipt refusal'); END;";
    raw.exec(trigger);
    try {
      const result = await req('/intake/operations', sourceRevision(p, source, 'v2'), 'POST');
      expect(result.status).toBeGreaterThanOrEqual(500);
      expect(tasks()).toEqual(beforeTasks);
      expect(await db.getProjectIntake(PROJECT)).toEqual(p);
    } finally { raw.exec('DROP TRIGGER refuse_source_refresh'); }
  });

  test('canonical freshness invalidation outside Intake does not add an automatic routing trigger', async () => {
    const need = await applied({ taskStatus: 'planning' });
    const before = tasks();
    const result = await req(`/needs/${need.id}`, { status: 'open', expected_knowledge_revision: need.knowledge.revision });
    expect(result.status).toBe(200);
    expect(tasks()).toEqual(before);
  });

  test('completed applied task gets one admitted idea follow-up and immutable old work', async () => {
    const need = await applied();
    const original = await db.getTask('original');
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(2);
    const changed = result.body.need;
    expect(changed.status).toBe('open');
    expect(changed.knowledge.task_ids).toHaveLength(1);
    const followup = await db.getTask(changed.knowledge.task_ids[0]);
    expect(followup.id).not.toBe(original.id);
    expect(followup.status).toBe('idea');
    expect(followup.description).toContain('Use blue-green deployment.');
    expect(followup.dispatch_instructions).toMatch(/re-verif/i);
    expect(followup.metadata.knowledge_need_ids).toContain(need.id);
    expect(followup.metadata.knowledge_context.requirements).toContainEqual(expect.objectContaining({
      need_id: need.id, question: changed.knowledge.question, satisfaction_test: changed.knowledge.satisfaction_test,
      source_refs: ['vault:trial'],
    }));
    expect(followup.metadata.knowledge_changes).toContainEqual(expect.objectContaining({
      need_id: need.id, previous_revision: need.knowledge.revision, revision: changed.knowledge.revision,
      answer: 'Use blue-green deployment.', previous_task_ids: ['original'], verification_pending: true,
    }));
    expect(followup.metadata.work_admission).toBeDefined();
    expect(followup.metadata.work_admission.repeat_id).toBeUndefined();
    expect(receipts(changed)).toEqual([expect.objectContaining({ status: 'ready', task_id: followup.id,
      answer_revision: changed.knowledge.revision, notes: expect.stringMatching(/created/i) })]);
    expect(changed.knowledge.applications[0]).toEqual(need.knowledge.applications[0]);
    expect(changed.knowledge.history.at(-1)).toMatchObject({ answer: 'Use a canary.', revision: need.knowledge.revision });
    expect(await db.getTask('original')).toEqual(original);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM task_dispatches').get().count).toBe(0);
  });

  test('a never-run linked task is updated with CAS and keeps unrelated content', async () => {
    const need = await applied({ taskStatus: 'planning', taskFields: { antigravity_payload: { prompt: 'Keep the existing scope.', operator_rulings: ['Existing answer'] } } });
    const original = await db.getTask('original');
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(1);
    const changed = await db.getTask('original');
    expect(changed.version).toBeGreaterThan(original.version);
    expect(changed.description).toContain(original.description);
    expect(changed.dispatch_instructions).toContain(original.dispatch_instructions);
    expect(changed.dispatch_instructions).toContain('Use blue-green deployment.');
    expect(changed.antigravity_payload).toEqual(original.antigravity_payload);
    expect(changed.metadata.unrelated).toEqual(original.metadata.unrelated);
    expect(receipts(result.body.need)[0]).toMatchObject({ task_id: 'original', notes: expect.stringMatching(/updated/i) });
  });

  test('a no-op save is idempotent and a later revision reuses the pending follow-up', async () => {
    const need = await applied();
    const first = (await revise(need)).body.need;
    const pendingId = first.knowledge.task_ids[0];
    const pending = await db.getTask(pendingId);
    const noop = await revise(first);
    expect(noop.status).toBe(200);
    expect(receipts(noop.body.need)).toEqual(receipts(first));
    expect(await db.getTask(pendingId)).toEqual(pending);
    const next = await revise(first, { answer: 'Use staged blue-green deployment.' });
    expect(next.status).toBe(200);
    expect(tasks()).toHaveLength(2);
    expect(next.body.need.knowledge.task_ids).toEqual([pendingId]);
    expect(receipts(next.body.need)).toHaveLength(2);
    expect((await db.getTask(pendingId)).description).toContain('Use staged blue-green deployment.');
    expect((await db.getTask(pendingId)).description).not.toContain('Answer: Use blue-green deployment.');
  });

  test.each(['dispatch', 'output', 'run', 'execution_step', 'langgraph'])('planning task with durable %s history gets new work', async evidence => {
    const need = await applied({ taskStatus: 'planning' });
    if (evidence === 'dispatch') raw.prepare('INSERT INTO task_dispatches (id, task_id, outcome) VALUES (?, ?, ?)').run('run', 'original', 'completed');
    if (evidence === 'output') raw.prepare('UPDATE tasks SET walkthrough = ? WHERE id = ?').run('Previously delivered result', 'original');
    if (evidence === 'run') raw.prepare('INSERT INTO runs (id, task_id, project_id) VALUES (?, ?, ?)').run('run', 'original', PROJECT);
    if (evidence === 'execution_step') raw.prepare('INSERT INTO execution_steps (id, task_id, project_id, status) VALUES (?, ?, ?, ?)').run('step', 'original', PROJECT, 'completed');
    if (evidence === 'langgraph') raw.prepare('UPDATE tasks SET langgraph_started_at = ? WHERE id = ?').run('2026-10-15', 'original');
    const original = await db.getTask('original');
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(2);
    expect(result.body.need.knowledge.task_ids).not.toContain('original');
    expect(await db.getTask('original')).toEqual(original);
  });

  test('a missing historical task still creates an actionable follow-up', async () => {
    const need = await applied({ taskStatus: null });
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(1);
    expect((await db.getTask(result.body.need.knowledge.task_ids[0])).status).toBe('idea');
  });

  test('cross-project task links fail closed and roll back every change', async () => {
    const need = await applied({ taskStatus: null });
    await db.upsertProject({ id: OTHER, name: 'Other', path: path.join(dir, 'other') });
    await db.createTask({ id: 'original', project_id: OTHER, name: 'Other project task', status: 'planning' });
    const before = await db.getProject(PROJECT);
    const original = await db.getTask('original');
    const result = await revise(need);
    expect(result.status).toBe(409);
    expect(await db.getProject(PROJECT)).toEqual(before);
    expect(await db.getTask('original')).toEqual(original);
    expect(tasks()).toHaveLength(1);
  });

  test.each(['insert', 'update', 'admission'])('%s failure rolls back the need, task changes, and receipts', async operation => {
    const need = await applied({ taskStatus: operation === 'update' ? 'planning' : 'completed' });
    const before = await db.getProject(PROJECT);
    const original = await db.getTask('original');
    const admission = raw.prepare('SELECT * FROM work_admissions').all();
    const table = operation === 'admission' ? 'work_admissions' : 'tasks';
    raw.exec(`CREATE TRIGGER refuse_knowledge_work BEFORE ${operation === 'update' ? 'UPDATE' : 'INSERT'} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'test routing refusal'); END;`);
    try {
      const result = await revise(need);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(await db.getProject(PROJECT)).toEqual(before);
      expect(await db.getTask('original')).toEqual(original);
      expect(tasks()).toHaveLength(1);
      expect(raw.prepare('SELECT * FROM work_admissions').all()).toEqual(admission);
    } finally { raw.exec('DROP TRIGGER refuse_knowledge_work'); }
  });

  test('whole-array database writes route changes and retain server receipts against replacement', async () => {
    const need = await applied();
    const before = await db.getProject(PROJECT);
    const changed = await db.updateProject(PROJECT, { expected_updated_at: before.updated_at, needs: [{ ...need,
      expected_knowledge_revision: need.knowledge.revision, knowledge: { ...need.knowledge, answer: 'Use blue-green deployment.' } }] });
    expect(tasks()).toHaveLength(2);
    const receipt = receipts(changed.needs[0])[0];
    expect(receipt).toBeDefined();
    const replaced = await db.updateProject(PROJECT, { expected_updated_at: changed.updated_at, needs: [{ ...changed.needs[0],
      knowledge: { ...changed.needs[0].knowledge, applications: [{ ...receipt, task_id: 'forged' }] } }] });
    expect(receipts(replaced.needs[0])).toEqual([receipt]);
    expect(tasks()).toHaveLength(2);
  });

  test.each(['question', 'satisfaction_test', 'evidence', 'criterion_ids'])('changing %s routes work', async field => {
    const need = await applied();
    const values = { question: 'Which strategy supports rollback?', satisfaction_test: 'A rollback drill passes.',
      evidence: [{ ref: 'vault:revised-trial' }], criterion_ids: [] };
    const result = await revise(need, { [field]: values[field] });
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(2);
    expect(receipts(result.body.need)).toHaveLength(1);
  });

  test('metadata, verification, and application recording do not create work', async () => {
    const need = await applied();
    const original = await db.getTask('original');
    const edited = await req(`/needs/${need.id}`, { description: 'New label', notes: 'New notes',
      knowledge: { resolution: { ...need.knowledge.resolution, owner: 'Robert' }, deferred_reason: 'Next sprint', deferred_until: '2026-10-25T12:00:00Z' } });
    expect(edited.status).toBe(200);
    const verified = await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: need.knowledge.revision,
      knowledge: { verification: { rationale: 'Rechecked the same trial.', evidence_refs: ['vault:trial'] } } });
    expect(verified.status).toBe(200);
    expect(tasks()).toHaveLength(1);
    expect(await db.getTask('original')).toEqual(original);
    expect(receipts(verified.body.need)).toEqual([]);
  });

  test('legacy singular positive applications remain retained and route subsequent changes', async () => {
    const need = await applied();
    const legacy = { ...need, knowledge: { ...need.knowledge } };
    delete legacy.knowledge.applications;
    delete legacy.knowledge.application.id;
    raw.prepare('UPDATE projects SET needs = ? WHERE id = ?').run(JSON.stringify([legacy]), PROJECT);
    const result = await revise(legacy);
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(2);
    expect(result.body.need.knowledge.applications).toContainEqual(expect.objectContaining({ status: 'applied', task_id: 'original' }));
  });

  test('clients cannot forge the reserved routing receipt through commands or legacy projection', async () => {
    const need = await applied();
    const forged = { id: 'knowledge-change:forged', task_id: 'original', status: 'ready', notes: 'Pretend server routed it.' };
    expect((await req(`/needs/${need.id}`, { record_application: forged })).status).toBe(400);
    expect((await req(`/needs/${need.id}`, { knowledge: { application: forged } })).status).toBe(400);
    expect(tasks()).toHaveLength(1);
  });

  test.each(['todo', 'scheduled'])('never-run %s work returns to planning for re-verification', async taskStatus => {
    const need = await applied({ taskStatus, taskFields: { priority: 9 } });
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect(await db.getTask('original')).toMatchObject({ status: 'planning', priority: 9 });
    expect(tasks()).toHaveLength(1);
  });

  test('all previously executed links share one follow-up while pending task links stay actionable', async () => {
    const need = await applied({ taskIds: ['original', 'second-completed', 'pending'] });
    await db.createTask({ id: 'second-completed', project_id: PROJECT, name: 'Historic second delivery', status: 'completed' });
    await db.createTask({ id: 'pending', project_id: PROJECT, name: 'Unexecuted rollout verification', status: 'planning' });
    const historic = await db.getTask('second-completed');
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(4);
    expect(result.body.need.knowledge.task_ids).toHaveLength(2);
    expect(result.body.need.knowledge.task_ids).toContain('pending');
    expect(result.body.need.knowledge.task_ids).not.toContain('second-completed');
    expect(receipts(result.body.need)).toHaveLength(2);
    expect(receipts(result.body.need)[0].notes).toContain('second-completed');
    expect(await db.getTask('second-completed')).toEqual(historic);
  });

  test('a never-run task linked only through its knowledge metadata is also updated', async () => {
    const need = await applied();
    await db.createTask({ id: 'pending', project_id: PROJECT, name: 'Unexecuted rollout verification', status: 'planning',
      metadata: { knowledge_need_ids: [need.id], other: 'Preserved' } });
    const before = await db.getTask('pending');
    const result = await revise(need);
    expect(result.status).toBe(200);
    expect((await db.getTask('pending')).version).toBeGreaterThan(before.version);
    expect((await db.getTask('pending')).metadata.other).toBe('Preserved');
    expect(result.body.need.knowledge.task_ids).toContain('pending');
    expect(tasks()).toHaveLength(3);
  });

  test('an executed follow-up is retained and a later revision creates one new pending task', async () => {
    const need = await applied();
    const first = (await revise(need)).body.need;
    const followupId = first.knowledge.task_ids[0];
    raw.prepare('INSERT INTO task_dispatches (id, task_id, outcome) VALUES (?, ?, ?)').run('followup-run', followupId, 'completed');
    const originalFollowup = await db.getTask(followupId);
    const result = await revise(first, { answer: 'Use staged blue-green deployment.' });
    expect(result.status).toBe(200);
    expect(tasks()).toHaveLength(3);
    expect(result.body.need.knowledge.task_ids).not.toContain(followupId);
    expect(await db.getTask(followupId)).toEqual(originalFollowup);
    expect(receipts(result.body.need)).toHaveLength(2);
  });

  test('follow-up admission failure rolls back an earlier pending task update in the same save', async () => {
    const need = await applied({ taskIds: ['original', 'pending'] });
    await db.createTask({ id: 'pending', project_id: PROJECT, name: 'Unexecuted rollout verification', status: 'planning' });
    const before = await db.getProject(PROJECT);
    const pending = await db.getTask('pending');
    const admission = raw.prepare('SELECT * FROM work_admissions ORDER BY task_id').all();
    raw.exec("CREATE TRIGGER refuse_followup BEFORE INSERT ON work_admissions WHEN NEW.task_id != 'pending' BEGIN SELECT RAISE(ABORT, 'test followup refusal'); END;");
    try {
      expect((await revise(need)).status).toBeGreaterThanOrEqual(400);
      expect(await db.getProject(PROJECT)).toEqual(before);
      expect(await db.getTask('pending')).toEqual(pending);
      expect(tasks()).toHaveLength(2);
      expect(raw.prepare('SELECT * FROM work_admissions ORDER BY task_id').all()).toEqual(admission);
    } finally { raw.exec('DROP TRIGGER refuse_followup'); }
  });

  test.each(['validated', 'successful'])('retained %s applications also route changed knowledge', async applicationStatus => {
    const need = await applied({ applicationStatus });
    const changed = await revise(need);
    expect(changed.status).toBe(200);
    expect(tasks()).toHaveLength(2);
    expect(changed.body.need.knowledge.applications[0].status).toBe(applicationStatus);
  });

  test.each([
    ['dropped', { status: 'dropped' }],
    ['superseded', { knowledge: { superseded_by: ['successor'] } }],
  ])('%s applied knowledge rejects semantic edits atomically but allows metadata edits', async (_state, retirement) => {
    const need = await applied();
    const retired = await req(`/needs/${need.id}`, retirement);
    expect(retired.status).toBe(200);
    const metadata = await req(`/needs/${need.id}`, { notes: 'Keep the historical record.' });
    expect(metadata.status).toBe(200);
    const before = await db.getProject(PROJECT);
    const original = await db.getTask('original');
    const admissions = raw.prepare('SELECT * FROM work_admissions').all();
    for (const knowledge of [{ answer: 'Use blue-green deployment.' }, { question: 'Which strategy supports rollback?' }]) {
      const result = await revise(metadata.body.need, knowledge);
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('Reopen this retired question or revise its successor before changing applied knowledge.');
      expect(await db.getProject(PROJECT)).toEqual(before);
      expect(await db.getTask('original')).toEqual(original);
      expect(tasks()).toHaveLength(1);
      expect(raw.prepare('SELECT * FROM work_admissions').all()).toEqual(admissions);
    }
    await expect(db.updateProject(PROJECT, { expected_updated_at: before.updated_at, needs: [{ ...metadata.body.need,
      expected_knowledge_revision: metadata.body.need.knowledge.revision,
      knowledge: { ...metadata.body.need.knowledge, answer: 'Use blue-green deployment.' } }] })).rejects.toMatchObject({ status: 409 });
    expect(await db.getProject(PROJECT)).toEqual(before);
    expect(tasks()).toHaveLength(1);
  });

  test('a dropped applied question can be reopened, revised, and verified again', async () => {
    const need = await applied();
    expect((await req(`/needs/${need.id}`, { status: 'dropped' })).status).toBe(200);
    const reopened = await req(`/needs/${need.id}`, { status: 'open' });
    expect(reopened.status).toBe(200);
    expect(tasks()).toHaveLength(1);
    const revised = await revise(reopened.body.need);
    expect(revised.status).toBe(200);
    expect(revised.body.need.status).toBe('open');
    expect(tasks()).toHaveLength(2);
    const verified = await req(`/needs/${need.id}`, { status: 'met', expected_knowledge_revision: revised.body.need.knowledge.revision,
      knowledge: { verification: { rationale: 'Rechecked the revised strategy.', evidence_refs: ['vault:trial'] } } });
    expect(verified.status).toBe(200);
    expect(verified.body.need.knowledge.verification.revision).toBe(revised.body.need.knowledge.revision);
  });

  test('explicitly restoring retired applied knowledge and revising it in one guarded patch is supported', async () => {
    const need = await applied();
    const retired = await req(`/needs/${need.id}`, { status: 'dropped', knowledge: { superseded_by: ['successor'] } });
    expect(retired.status).toBe(200);
    const changed = await req(`/needs/${need.id}`, { status: 'open', expected_knowledge_revision: retired.body.need.knowledge.revision,
      knowledge: { superseded_by: [], answer: 'Use blue-green deployment.' } });
    expect(changed.status).toBe(200);
    expect(changed.body.need.status).toBe('open');
    expect(changed.body.need.knowledge.superseded_by).toEqual([]);
    expect(tasks()).toHaveLength(2);
  });
});
