const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const crypto = require('crypto');

const brief = { purpose: 'Reduce waste and make tools accessible', outcome: 'Neighbors can coordinate shared tools', beneficiary: 'Our neighborhood', scope: 'Tool lending pilot', success_criteria: ['A neighbor completes a loan'], decision_owner: 'Robert' };
const need = (id = 'owner', method = 'human') => ({ id, kind: 'information', description: 'Choose the pilot owner', knowledge: { question: 'Who owns the pilot?', purpose: 'Identify authority', satisfaction_test: 'Owner explicitly confirms', resolution: { method, owner: 'Robert', next_action: 'Ask Robert' } } });

describe('durable record-only project intake', () => {
  let dir, db, raw, server, base;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-intake-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.resetModules(); db = require('../../db');
    raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    const app = express(); app.use(express.json());
    app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: dir, getProjectById: (_, id) => db.getProject(id), getAllProjects: () => db.getProjects(), scanProjects: async () => [], contextSync: {} }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/projects`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); raw.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.NEXUS_DB_PATH; });
  const request = async (suffix, body, method = 'POST') => { const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }; };
  const create = (overrides = {}) => request('/intake', { operation_id: crypto.randomUUID(), name: crypto.randomUUID(), problem: 'Help neighbors share tools', source_ref: 'chat:original', ...overrides });
  const op = (snapshot, action, rest = {}) => request(`/${snapshot.project.id}/intake/operations`, { operation_id: crypto.randomUUID(), expected_revision: snapshot.intake.revision, action, ...rest });
  const prepared = async (needs = [need()]) => { const created = await create(); expect(created.status).toBe(201); const result = await op(created.body, 'prepare', { brief, needs }); expect(result.status).toBe(200); return result.body; };

  test('creates one durable project without filesystem mutation and replays the original response', async () => {
    const operation_id = crypto.randomUUID(), name = crypto.randomUUID();
    const before = fs.readdirSync(dir);
    const first = await create({ operation_id, name });
    expect(first.status).toBe(201);
    expect(first.body.project).toMatchObject({ path: '', phase: 'intake', status: 'active' });
    expect(first.body.intake).toMatchObject({ revision: 0, state: 'preparing', workspace: { state: 'unassigned' }, original: { problem: 'Help neighbors share tools', source_ref: 'chat:original' } });
    expect(fs.readdirSync(dir)).toEqual(before);
    expect((await create({ operation_id, name })).body).toEqual(first.body);
    expect((await create({ operation_id, name, problem: 'Different request' })).status).toBe(409);
    expect(raw.prepare('SELECT count(*) AS n FROM projects WHERE name=?').get(name).n).toBe(1);
    expect((await request(`/${first.body.project.id}/intake`, null, 'GET')).body).toEqual(first.body);
  });

  test('attaches the exact existing non-Git folder and retains unavailable paths without scaffolding', async () => {
    const folder = path.join(dir, 'existing'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'reference.txt'), 'keep');
    const created = await create({ existing_path: folder });
    expect(created.status).toBe(201);
    expect(created.body.project.path).toBe(folder);
    expect(created.body.intake.workspace).toMatchObject({ state: 'attached', path: folder, canonical_path: fs.realpathSync(folder) });
    expect(fs.readdirSync(folder)).toEqual(['reference.txt']);
    expect((await create({ existing_path: folder })).status).toBe(409);
    const missing = path.join(dir, 'not-mounted', 'idea');
    const absent = await create({ existing_path: missing });
    expect(absent.status).toBe(201);
    expect(absent.body.intake.workspace).toMatchObject({ state: 'unavailable', path: missing });
    expect(fs.existsSync(missing)).toBe(false);
    expect((await create({ existing_path: 'relative' })).status).toBe(400);
  });

  test('never merges by name and exact project adoption preserves unrelated data', async () => {
    const id = crypto.randomUUID(), name = crypto.randomUUID();
    raw.prepare('INSERT INTO projects(id,name,path,description,needs) VALUES (?,?,?,?,?)').run(id, name, '', 'Preserve me', JSON.stringify([{ id: 'legacy', kind: 'decision', description: 'Keep me', status: 'open', created_at: 'old' }]));
    expect((await create({ name })).status).toBe(409);
    const adopted = await create({ project_id: id, name });
    expect(adopted.status).toBe(201);
    expect(adopted.body.project).toMatchObject({ id, description: 'Preserve me' });
    expect(adopted.body.project.needs[0].id).toBe('legacy');
    expect((await create({ project_id: id, name, problem: 'Another' })).status).toBe(409);
  });

  test('persists setup-only questions and resumes exactly with CAS and operation replay', async () => {
    const p = await prepared();
    const deferred = await op(p, 'defer', { pending_need_id: 'owner' });
    expect(deferred.body.intake.state).toBe('deferred');
    const snapshot = (await request(`/${p.project.id}/intake`, null, 'GET')).body;
    expect(snapshot.intake.pending_need_id).toBe('owner');
    expect(snapshot.project.needs).toHaveLength(1);
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(p.project.id).n).toBe(0);
    const input = { operation_id: crypto.randomUUID(), expected_revision: snapshot.intake.revision, action: 'start' };
    const results = await Promise.all([request(`/${p.project.id}/intake/operations`, input), request(`/${p.project.id}/intake/operations`, input)]);
    expect(results.map(r => r.status)).toEqual([200, 200]); expect(results[0].body).toEqual(results[1].body);
    expect((await op(snapshot, 'start')).status).toBe(409);
    expect((await request(`/${p.project.id}/intake/operations`, { ...input, action: 'defer' })).status).toBe(409);
  });

  test('saves actual answers, evidence and correction history without falsely verifying empirical claims', async () => {
    const p = (await op(await prepared([need(), need('fact', 'research')]), 'start')).body;
    const answered = await op(p, 'answer', { need_id: 'owner', expected_knowledge_revision: 1, answer: 'Robert', source_ref: 'chat:answer', verification: { rationale: 'The decision owner explicitly chose', evidence_refs: ['chat:answer'] } });
    expect(answered.status).toBe(200);
    expect(answered.body.project.needs[0]).toMatchObject({ status: 'met', knowledge: { answer: 'Robert', evidence: [{ ref: 'chat:answer' }] } });
    const corrected = await op(answered.body, 'answer', { need_id: 'owner', expected_knowledge_revision: 2, answer: 'Pat', source_ref: 'chat:correction' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.project.needs[0].status).toBe('open');
    expect(corrected.body.project.needs[0].knowledge.history.some(h => h.answer === 'Robert')).toBe(true);
    const invalid = await op(corrected.body, 'answer', { need_id: 'fact', expected_knowledge_revision: 1, answer: 'It will work', source_ref: 'chat:assertion', verification: { rationale: 'Robert said so', evidence_refs: ['chat:assertion'] } });
    expect(invalid.status).toBe(400);
    const saved = (await request(`/${p.project.id}/intake`, null, 'GET')).body;
    expect(saved.intake.revision).toBe(corrected.body.intake.revision);
    expect(saved.project.needs[1].knowledge.answer).toBeUndefined();
  });

  test('binds review and acceptance to current content and atomically adopts criteria without dispatch', async () => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:1', brief_revision: p.intake.brief_revision })).body;
    const reviewed = await op(p, 'record_review', { session_id: 'council:1', brief_revision: p.intake.brief_revision, source_ref: 'council:result', findings: [] });
    expect(reviewed.status).toBe(200); expect(reviewed.body.intake.state).toBe('ready_for_decision');
    const stale = await op(reviewed.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan the pilot', brief_revision: 0 });
    expect(stale.status).toBe(409);
    const accepted = await op(reviewed.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan the pilot', brief_revision: reviewed.body.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.project).toMatchObject({ phase: 'planning', end_state: brief.outcome, path: '' });
    expect(accepted.body.project.end_state_criteria[0]).toMatchObject({ kind: 'manual', description: brief.success_criteria[0] });
    expect(accepted.body.project.needs).toHaveLength(1);
    expect(accepted.body.intake.state).toBe('handed_off');
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(p.project.id).n).toBe(0);
    expect((await op(accepted.body, 'revise', { brief: { outcome: 'Changed' } })).status).toBe(409);
  });

  test('material revisions invalidate review, and failed or stale callbacks cannot claim success', async () => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:2', brief_revision: p.intake.brief_revision })).body;
    const revised = await op(p, 'revise', { brief: { scope: 'A smaller pilot' } });
    expect(revised.status).toBe(200);
    expect(revised.body.intake.state).toBe('interviewing');
    expect((await op(revised.body, 'record_review', { session_id: 'council:2', brief_revision: p.intake.brief_revision, source_ref: 'council:old', findings: [] })).status).toBe(409);
    expect((await op(revised.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: revised.body.intake.brief_revision })).status).toBe(409);
  });

  test('rejects arbitrary mutations and workspace operations cannot fall back to cwd', async () => {
    const p = (await create()).body;
    expect((await op(p, 'prepare', { brief, phase: 'planning' })).status).toBe(400);
    for (const [route, method] of [['status', 'GET'], ['readme', 'GET'], ['commits', 'GET'], ['diff', 'GET'], ['git/init', 'POST'], ['context/sync', 'POST'], ['generate-commit-message', 'POST']]) {
      const result = await request(`/${p.project.id}/${route}`, method === 'POST' ? {} : null, method);
      expect(result.status).toBe(409); expect(result.body.code).toBe('WORKSPACE_UNAVAILABLE');
    }
  });
  test('queued work cannot be admitted, forced into execution, or newly filed during intake', async () => {
    const id = crypto.randomUUID(), name = crypto.randomUUID();
    raw.prepare('INSERT INTO projects(id,name,path,status) VALUES (?,?,?,?)').run(id, name, dir, 'active');
    const task = await db.createTask({ project_id: id, name: 'Existing queued delivery', status: 'todo' });
    expect(task.id).toBeTruthy();
    const p = (await create({ project_id: id, name, existing_path: dir })).body;
    await expect(db.getWorkAdmission(task.id)).rejects.toMatchObject({ status: 409, code: 'PROJECT_INTAKE' });
    await expect(db.updateTask(task.id, { status: 'in_progress' }, task.version, { origin: { kind: 'operator' } })).rejects.toMatchObject({ status: 409, code: 'PROJECT_INTAKE' });
    await expect(db.createTask({ project_id: id, name: 'Autonomous research', status: 'idea' })).rejects.toMatchObject({ status: 409, code: 'PROJECT_INTAKE' });
    expect((await db.getBoardState(id))[0]).toMatchObject({ phase: 'intake', intake: p.intake });
  });

  test('normal need edits invalidate reviewed intake without changing other questions', async () => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:external', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:external', brief_revision: p.intake.brief_revision, source_ref: 'council:result', findings: [] })).body;
    db.updateProjectNeed(p.project.id, 'owner', { expected_knowledge_revision: 1, knowledge: { answer: 'Corrected outside intake' } });
    const saved = (await request(`/${p.project.id}/intake`, null, 'GET')).body;
    expect(saved.intake.state).toBe('interviewing');
    expect(saved.intake.brief_revision).toBe(p.intake.brief_revision + 1);
    expect((await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision })).status).toBe(409);
    await expect(db.updateProject(p.project.id, { end_state: 'Bypass review' })).rejects.toMatchObject({ status: 409 });
  });

  test('preserves large legacy need registries when adding an intake question', async () => {
    const id = crypto.randomUUID(), name = crypto.randomUUID();
    const oldNeeds = Array.from({ length: 205 }, (_, index) => ({ id: `old-${index}`, kind: 'decision', description: `Preserve ${index}`, status: 'open', created_at: 'old' }));
    raw.prepare('INSERT INTO projects(id,name,path,needs) VALUES (?,?,?,?)').run(id, name, '', JSON.stringify(oldNeeds));
    const p = (await create({ project_id: id, name })).body;
    const result = await op(p, 'prepare', { brief, needs: [need()] });
    expect(result.status).toBe(200);
    expect(result.body.project.needs.slice(0, 205)).toEqual(oldNeeds);
    expect(result.body.project.needs).toHaveLength(206);
  });

  test('failed and partial council results stay visible and cannot authorize acceptance', async () => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:partial', brief_revision: p.intake.brief_revision })).body;
    const result = await op(p, 'record_review', { session_id: 'council:partial', brief_revision: p.intake.brief_revision, source_ref: 'council:partial-result', findings: [], status: 'partial' });
    expect(result.body.intake.review.status).toBe('partial');
    expect((await op(result.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision })).status).toBe(409);
  });

  test('reopens from another database connection and preserves immutable operation results', async () => {
    const p = await prepared();
    const deferred = (await op(p, 'defer')).body;
    const connection = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    try {
      const store = require('../../db/project-intake').createProjectIntakeStore(connection, { deserialize: row => row && { ...row, intake: JSON.parse(row.intake), needs: JSON.parse(row.needs) } });
      expect(store.get(p.project.id).intake).toEqual(deferred.intake);
    } finally { connection.close(); }
  });

  test('revised question definitions preserve omitted evidence, tags and unrelated answers', async () => {
    let p = await prepared([{ ...need(), knowledge: { ...need().knowledge, tags: ['authority'], answer: 'Source says Robert', evidence: [{ ref: 'file:brief' }] } }]);
    const result = await op(p, 'revise', { needs: [{ ...need(), expected_knowledge_revision: 1, knowledge: { question: 'Who is accountable?', purpose: 'Confirm authority', satisfaction_test: 'Owner explicitly confirms', resolution: { method: 'human', owner: 'Robert', next_action: 'Ask' } } }] });
    expect(result.status).toBe(200);
    expect(result.body.project.needs[0].knowledge).toMatchObject({ answer: 'Source says Robert', tags: ['authority'], evidence: [{ ref: 'file:brief' }] });
  });

  test('attaches an existing folder to the same record through guarded intake operations', async () => {
    const p = (await create()).body;
    const folder = path.join(dir, 'attached-later'); fs.mkdirSync(folder);
    const attached = await op(p, 'attach_workspace', { existing_path: folder });
    expect(attached.status).toBe(200);
    expect(attached.body.project).toMatchObject({ id: p.project.id, path: folder });
    expect(attached.body.intake.workspace).toMatchObject({ state: 'attached', path: folder });
    expect(fs.readdirSync(folder)).toEqual([]);
    const git = await request(`/${p.project.id}/git/init`, {});
    expect(git.status).toBe(409); expect(git.body.code).toBe('PROJECT_INTAKE');
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  test('rolls back every need and intake field when receipt persistence fails', async () => {
    const p = (await op(await prepared(), 'start')).body;
    const before = raw.prepare('SELECT * FROM projects WHERE id=?').get(p.project.id);
    raw.exec("CREATE TRIGGER reject_intake_receipt BEFORE INSERT ON project_intake_operations WHEN NEW.operation_id = 'fail-save' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    try {
      const result = await op(p, 'answer', { operation_id: 'fail-save', need_id: 'owner', answer: 'Robert', source_ref: 'chat:answer', expected_knowledge_revision: 1 });
      expect(result.status).toBe(500);
      expect(raw.prepare('SELECT * FROM projects WHERE id=?').get(p.project.id)).toEqual(before);
      expect(raw.prepare('SELECT * FROM project_intake_operations WHERE operation_id=?').get('fail-save')).toBeUndefined();
    } finally { raw.exec('DROP TRIGGER reject_intake_receipt'); }
  });

  test('competing operations have one winner and the losing answer remains unapplied', async () => {
    const p = (await op(await prepared(), 'start')).body;
    const results = await Promise.all(['Robert', 'Pat'].map(answer => op(p, 'answer', { need_id: 'owner', expected_knowledge_revision: 1, answer, source_ref: `chat:${answer}` })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = results.find(r => r.status === 200).body;
    const saved = (await request(`/${p.project.id}/intake`, null, 'GET')).body;
    expect(saved).toEqual(winner);
    expect(saved.project.needs[0].knowledge.history).toHaveLength(1);
  });

  test('adopts authoritative existing information needs and guards later revisions', async () => {
    const id = crypto.randomUUID(), name = crypto.randomUUID();
    await db.upsertProject({ id, name, path: '' });
    const saved = db.updateProjectNeed(id, null, need('original'));
    const needId = saved.need.id;
    const answered = db.updateProjectNeed(id, needId, { expected_knowledge_revision: 1, knowledge: { answer: 'Robert', evidence: [{ ref: 'chat:earlier' }] } });
    const verified = db.updateProjectNeed(id, needId, { expected_knowledge_revision: 2, status: 'met', knowledge: { verification: { rationale: 'Explicit choice', evidence_refs: ['chat:earlier'] } } });
    const p = (await create({ project_id: id, name })).body;
    expect(p.intake.need_ids).toContain(needId);
    expect(p.project.needs).toEqual(verified.needs);
    const preparedResult = await op(p, 'prepare', { brief });
    const revisedDefinition = { ...need(needId), description: 'Confirm accountable owner', expected_knowledge_revision: 2, knowledge: { ...need().knowledge, question: 'Who is accountable for the pilot?' } };
    const result = await op(preparedResult.body, 'revise', { needs: [revisedDefinition] });
    expect(result.status).toBe(200);
    expect(result.body.project.needs).toHaveLength(1);
    expect(result.body.project.needs[0].knowledge).toMatchObject({ answer: 'Robert', evidence: [{ ref: 'chat:earlier' }], revision: 3 });
    expect(result.body.project.needs[0].knowledge.history.some(h => h.verification)).toBe(true);
    const stale = await op(result.body, 'revise', { needs: [{ ...revisedDefinition, description: 'Stale overwrite' }] });
    expect(stale.status).toBe(409);
  });

  test.each(['', '/scaffold'])('legacy creation route %s rejects intake name before any filesystem mutation', async route => {
    const p = (await create()).body;
    const folder = path.join(dir, p.project.name);
    expect(fs.existsSync(folder)).toBe(false);
    const result = await request(route, { name: p.project.name });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('PROJECT_INTAKE');
    expect(fs.existsSync(folder)).toBe(false);
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(p);
  });

  test('acceptance requires explicit purpose and a resolution plan for nonblocking open research', async () => {
    const research = need('research', 'research');
    research.knowledge.resolution = { method: 'research' };
    let p = await prepared([research]);
    p = (await op(p, 'revise', { brief: { purpose: '' } })).body;
    p = (await op(p, 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:readiness', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:readiness', brief_revision: p.intake.brief_revision, source_ref: 'council:readiness-result', findings: [] })).body;
    const incomplete = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision });
    expect(incomplete.status).toBe(400); expect(incomplete.body.code).toBe('INTAKE_BRIEF_INCOMPLETE');
    p = (await op(p, 'revise', { brief: { purpose: brief.purpose } })).body;
    p = (await op(p, 'request_review', { session_id: 'council:planned', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:planned', brief_revision: p.intake.brief_revision, source_ref: 'council:planned-result', findings: [] })).body;
    const unplanned = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision });
    expect(unplanned.status).toBe(400); expect(unplanned.body.code).toBe('INTAKE_NEED_UNPLANNED');
  });

  test('preparation councils persist provenance and findings without satisfying final review', async () => {
    const p = (await create()).body;
    const requested = await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:explicit-council', session_id: 'council:prepare', brief_revision: p.intake.brief_revision });
    expect(requested.status).toBe(200);
    expect(requested.body.intake.review).toMatchObject({ mode: 'preparation', source_ref: 'chat:explicit-council', resume_state: 'preparing' });
    const result = await op(requested.body, 'record_review', { session_id: 'council:prepare', brief_revision: p.intake.brief_revision, source_ref: 'council:preparation-result', findings: [], brief, needs: [need()] });
    expect(result.status).toBe(200);
    expect(result.body.intake.state).toBe('preparing');
    expect(result.body.intake.review_history.at(-1)).toMatchObject({ mode: 'preparation', status: 'completed', source_ref: 'council:preparation-result' });
    expect(result.body.intake.brief).toEqual(brief);
    expect(result.body.intake.brief_revision).toBe(1);
    expect((await op(result.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: 1 })).status).toBe(409);
    const ready = await op(result.body, 'prepare', {});
    expect(ready.status).toBe(200); expect(ready.body.intake.state).toBe('awaiting_choice');
  });

  test('preparation needs an explicit source and restores deferred choice without auto-resuming', async () => {
    let p = await prepared();
    expect((await op(p, 'request_review', { mode: 'preparation', session_id: 'council:unrequested', brief_revision: p.intake.brief_revision })).status).toBe(400);
    p = (await op(p, 'defer')).body;
    p = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:explicit-council', session_id: 'council:deferred-prep', brief_revision: p.intake.brief_revision })).body;
    const result = await op(p, 'record_review', { session_id: 'council:deferred-prep', brief_revision: p.intake.brief_revision, source_ref: 'council:deferred-result', findings: [] });
    expect(result.status).toBe(200); expect(result.body.intake.state).toBe('deferred');
    expect(result.body.intake.review).toBeNull();
    expect(result.body.intake.review_history.at(-1).mode).toBe('preparation');
  });

  test('material changes during a deferred preparation council do not resume the interview', async () => {
    let p = (await op(await prepared(), 'defer')).body;
    p = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:explicit', session_id: 'council:waiting', brief_revision: p.intake.brief_revision })).body;
    const result = await op(p, 'revise', { brief: { scope: 'Smaller pilot' } });
    expect(result.status).toBe(200); expect(result.body.intake.state).toBe('deferred');
    expect(result.body.intake.review).toBeNull();
    expect((await op(result.body, 'record_review', { session_id: 'council:waiting', brief_revision: p.intake.brief_revision, source_ref: 'council:stale', findings: [] })).status).toBe(409);
  });

  test('post-interview review cannot adopt a changed brief from its callback', async () => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:read-only', brief_revision: p.intake.brief_revision })).body;
    const result = await op(p, 'record_review', { session_id: 'council:read-only', brief_revision: p.intake.brief_revision, source_ref: 'council:result', findings: [], brief: { scope: 'Unreviewed scope' } });
    expect(result.status).toBe(400);
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(p);
  });

  test('preparation after a completed review cannot revive the old review or acceptance', async () => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:old-review', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:old-review', brief_revision: p.intake.brief_revision, source_ref: 'council:old-result', findings: [] })).body;
    p = (await op(p, 'start')).body;
    p = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:reconsider', session_id: 'council:reconsider', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:reconsider', brief_revision: p.intake.brief_revision, source_ref: 'council:prep-result', findings: [], brief: { scope: 'Reconsidered scope' } })).body;
    expect(p.intake.state).toBe('interviewing'); expect(p.intake.review).toBeNull();
    expect(p.intake.review_history.map(r => r.mode)).toEqual(['review', 'preparation']);
    expect(p.intake.review_history[1].request_source_ref).toBe('chat:reconsider');
    expect((await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision })).status).toBe(409);
  });

  test('partial preparation is visible and retryable without applying an incomplete brief', async () => {
    let p = (await create()).body;
    p = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:explicit', session_id: 'council:failed-prep', brief_revision: 0 })).body;
    const partial = await op(p, 'record_review', { session_id: 'council:failed-prep', brief_revision: 0, source_ref: 'council:partial', findings: [], status: 'partial', brief });
    expect(partial.status).toBe(400);
    p = (await op(p, 'record_review', { session_id: 'council:failed-prep', brief_revision: 0, source_ref: 'council:partial', findings: [], status: 'partial' })).body;
    expect(p.intake.review.status).toBe('partial');
    p = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:retry', session_id: 'council:retry-prep', brief_revision: 0 })).body;
    expect(p.intake.review.resume_state).toBe('preparing');
    p = (await op(p, 'record_review', { session_id: 'council:retry-prep', brief_revision: 0, source_ref: 'council:complete', findings: [] })).body;
    expect(p.intake.state).toBe('preparing');
    expect(p.intake.review_history.map(r => r.status)).toEqual(['partial', 'completed']);
  });

  test('preparation cannot offer a conversation until understanding and registry are saved', async () => {
    const p = (await create()).body;
    for (const input of [{}, { brief }, { needs: [need()] }]) {
      const result = await op(p, 'prepare', input);
      expect(result.status).toBe(400); expect(result.body.code).toBe('INTAKE_PREPARATION_INCOMPLETE');
      expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(p);
    }
    const understood = await op(p, 'prepare', { brief: { purpose: 'Make tools available to neighbors' }, needs: [need()] });
    expect(understood.status).toBe(200); expect(understood.body.intake.state).toBe('awaiting_choice');
  });

});
