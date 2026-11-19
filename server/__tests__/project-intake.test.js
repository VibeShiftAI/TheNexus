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
    app.use((req, _res, next) => { req.user = { id: 'local_user', is_service: false }; next(); });
    app.use('/api/projects', require('../routes/projects')({ db, PROJECT_ROOT: dir, getProjectById: require('../utils/project-manager').getProjectById, getAllProjects: () => db.getProjects(), scanProjects: async () => [], contextSync: { pullAndSyncFromGit: async (_id, folder) => { if (folder?.startsWith(fs.realpathSync(dir))) fs.writeFileSync(path.join(folder, 'requested-context-write'), 'requested sync'); return { success: true }; } } }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/projects`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); raw.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.NEXUS_DB_PATH; });
  const request = async (suffix, body, method = 'POST') => { const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }; };
  const create = (overrides = {}) => request('/intake', { operation_id: crypto.randomUUID(), name: crypto.randomUUID(), problem: 'Help neighbors share tools', source_ref: 'chat:original', ...overrides });
  const op = (snapshot, action, rest = {}) => request(`/${snapshot.project.id}/intake/operations`, { operation_id: crypto.randomUUID(), expected_revision: snapshot.intake.revision, action, ...rest });
  const prepared = async (needs = [need()]) => { const created = await create(); expect(created.status).toBe(201); const result = await op(created.body, 'prepare', { brief, needs }); expect(result.status).toBe(200); return result.body; };
  test('only Robert may set an active intake target; ordinary intake operations preserve it without a plan', async () => {
    const originalKey = process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    const operatorKey = 'fixture-operator-key-for-intake-targets';
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    try {
      const snapshot = await prepared();
      const path = '/' + snapshot.project.id + '/intake';
      const set = async (input, authorized = true) => fetch(base + path + '/target', {
        method: 'PUT', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer ' + operatorKey } : {}) },
        body: JSON.stringify(input),
      });
      const body = { target: 'After permit approval', expected_target: null, expected_revision: snapshot.intake.revision };
      expect((await set(body, false)).status).toBe(403);
      expect((await set({ ...body, expected_target: undefined })).status).toBe(428);
      expect((await set({ ...body, target: '  ' })).status).toBe(400);
      expect((await set(body)).status).toBe(200);
      const saved = (await request(path, undefined, 'GET')).body;
      expect(saved.intake).toEqual({ ...snapshot.intake, target: body.target });
      expect(saved.project.checkpoints).toEqual(snapshot.project.checkpoints);
      expect((await set({ ...body, target: 'Another window' })).status).toBe(409);
      expect((await op(saved, 'start', { target: 'Invented' })).status).toBe(400);
      expect((await request('/' + snapshot.project.id, { intake: { ...saved.intake, target: 'Invented' } }, 'PATCH')).status).toBe(400);
      await expect(db.upsertProject({ name: crypto.randomUUID(), path: '', intake: saved.intake })).rejects.toMatchObject({ code: 'INTAKE_STATE_GUARD' });
      const started = await op(saved, 'start');
      expect(started.body.intake.target).toBe(body.target);
      expect((await set({ ...body, expected_target: body.target, target: null })).status).toBe(409);
      const current = { ...body, expected_revision: started.body.intake.revision };
      expect((await set({ ...current, expected_target: body.target, target: null })).status).toBe(200);
      expect((await request(path, undefined, 'GET')).body.intake.target).toBeUndefined();
      expect((await set(current)).status).toBe(200);
      const accepted = await op(started.body, 'accept', { source_ref: 'chat:approved', next_step: 'Prepare the pilot', brief_revision: started.body.intake.brief_revision });
      expect(accepted.status).toBe(200);
      expect((await set({ ...body, expected_target: body.target, expected_revision: accepted.body.intake.revision })).status).toBe(409);
      expect(accepted.body.project.checkpoints).toEqual(snapshot.project.checkpoints);
      const projectPath = '/' + snapshot.project.id;
      const plan = await request(projectPath, { checkpoints: [{ id: 'intake', title: 'Open the pilot' }], expected_checkpoints_revision: null }, 'PATCH');
      expect(plan.status).toBe(200);
      const board = await fetch(base + projectPath + '/checkpoints/intake/target', {
        method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + operatorKey },
        body: JSON.stringify({ target: 'December', expected_target: null, expected_checkpoints_revision: plan.body.checkpoints.revision }),
      });
      expect(board.status).toBe(200);
      const project = await board.json();
      expect(project.checkpoints.items[0].target).toBe('December');
      expect(project.intake.target).toBe(body.target);
    } finally {
      if (originalKey === undefined) delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
      else process.env.NEXUS_OPERATOR_APPROVAL_KEY = originalKey;
    }
  });
  test('intake preparation and guarded revisions classify the respondent and retain explicit corrections', async () => {
    const question = need();
    let snapshot = await prepared([question]);
    expect(snapshot.project.needs[0].knowledge.client_facing).toBe(false);
    const edit = async patch => {
      const previous = snapshot.project.needs[0];
      const result = await op(snapshot, 'revise', { needs: [{ ...question, expected_knowledge_revision: previous.knowledge.revision,
        knowledge: { ...question.knowledge, resolution: previous.knowledge.resolution, ...patch } }] });
      expect(result.status).toBe(200);
      snapshot = result.body;
      return snapshot.project.needs[0].knowledge;
    };
    expect((await edit({ resolution: { method: 'human', owner: 'Customer' } })).client_facing).toBe(true);
    expect((await edit({ client_facing: false })).client_facing).toBe(false);
    const retained = await edit({ purpose: 'Updated purpose' });
    expect(retained.client_facing).toBe(false);
    expect(retained.history.map(h => h.audience_changed_to)).toEqual([true, false]);
  });

  const preHandoffStates = ['preparing', 'awaiting_choice', 'deferred', 'interviewing', 'council_review', 'ready_for_decision'];
  const atState = async state => {
    if (state === 'preparing') return (await op((await create()).body, 'revise', { brief, needs: [need()] })).body;
    let p = await prepared();
    if (state === 'deferred' || state === 'interviewing') return (await op(p, state === 'deferred' ? 'defer' : 'start')).body;
    if (['council_review', 'ready_for_decision'].includes(state)) {
      p = (await op(p, 'request_review', { session_id: 'council:original', brief_revision: p.intake.brief_revision })).body;
      if (state === 'ready_for_decision') p = (await op(p, 'record_review', { session_id: 'council:original', brief_revision: p.intake.brief_revision, source_ref: 'council:result', findings: [] })).body;
    }
    expect(p.intake.state).toBe(state);
    return p;
  };

  test.each(preHandoffStates)('conversation choices work from %s without changing council identity', async state => {
    const p = await atState(state);
    const started = await op(p, 'start');
    expect(started.status).toBe(200);
    expect(started.body.intake).toMatchObject({ state: 'interviewing', review: p.intake.review, brief_revision: p.intake.brief_revision });
    const deferred = await op(started.body, 'defer');
    expect(deferred.status).toBe(200);
    expect(deferred.body.intake).toMatchObject({ state: 'deferred', review: p.intake.review, brief_revision: p.intake.brief_revision });
    expect(deferred.body.intake.review_history).toEqual(p.intake.review_history);
  });

  test.each(preHandoffStates.flatMap(state => ['review', 'preparation'].map(mode => [state, mode])))('explicit council from %s accepts %s mode and preserves prior results honestly', async (state, mode) => {
    const p = await atState(state);
    const result = await op(p, 'request_review', { mode, source_ref: 'chat:requested', session_id: 'council:new', brief_revision: p.intake.brief_revision });
    expect(result.status).toBe(200);
    expect(result.body.intake.review).toMatchObject({ status: 'pending', session_id: 'council:new', mode, request_source_ref: 'chat:requested', resume_state: state === 'council_review' ? 'awaiting_choice' : state });
    if (p.intake.review) {
      expect(result.body.intake.review_history.at(-1)).toEqual(p.intake.review);
      expect((await op(result.body, 'record_review', { session_id: p.intake.review.session_id, brief_revision: p.intake.brief_revision, source_ref: 'council:late', findings: [] })).body.code).toBe('INTAKE_REVIEW_STALE');
    }
  });

  test.each(['review', 'preparation'].flatMap(mode => ['start', 'defer'].map(choice => [mode, choice])))('%s council completion respects a later %s choice', async (mode, choice) => {
    let p = await prepared();
    p = (await op(p, 'request_review', { mode, source_ref: 'chat:requested', session_id: 'council:choice', brief_revision: p.intake.brief_revision })).body;
    const pending = p.intake.review;
    const chosen = await op(p, choice);
    expect(chosen.status).toBe(200);
    p = chosen.body;
    expect(p.intake.review).toEqual(pending);
    const callback = { session_id: pending.session_id, brief_revision: pending.brief_revision, source_ref: 'council:complete', findings: [], ...(mode === 'preparation' ? { brief: { scope: 'Smaller pilot' } } : {}) };
    const result = await op(p, 'record_review', callback);
    expect(result.status).toBe(200);
    expect(result.body.intake.state).toBe(choice === 'start' ? 'interviewing' : 'deferred');
    const review = mode === 'preparation' ? result.body.intake.review_history.at(-1) : result.body.intake.review;
    expect(review).toMatchObject({ status: 'completed', request_source_ref: 'chat:requested', source_ref: 'council:complete' });
    expect((await op(result.body, 'record_review', callback)).body.code).toBe('INTAKE_REVIEW_STALE');
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(result.body);
  });

  test('new council requests cannot reuse a session identity that could admit an old callback', async () => {
    let p = await atState('council_review');
    const oldSession = p.intake.review.session_id;
    const replacement = { source_ref: 'chat:replace', session_id: oldSession, brief_revision: p.intake.brief_revision };
    expect((await op(p, 'request_review', replacement)).status).toBe(409);
    p = (await op(p, 'request_review', { ...replacement, session_id: 'council:new' })).body;
    expect((await op(p, 'request_review', replacement)).status).toBe(409);
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(p);
  });

  test.each([null, 'start', 'defer'])('automatic review cannot replace an explicit pending council after %s', async choice => {
    let p = await prepared();
    p = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:requested', session_id: 'council:explicit', brief_revision: p.intake.brief_revision })).body;
    if (choice) p = (await op(p, choice)).body;
    const result = await op(p, 'request_review', { session_id: 'council:automatic', brief_revision: p.intake.brief_revision });
    expect(result.status).toBe(409);
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(p);
  });

  test.each(['record_review', 'revise', 'answer'])('explicit normal council while deferred does not resume the interview on %s', async action => {
    let p = await atState('deferred');
    p = (await op(p, 'request_review', { source_ref: 'chat:requested', session_id: 'council:deferred', brief_revision: p.intake.brief_revision })).body;
    const input = action === 'record_review' ? { session_id: 'council:deferred', brief_revision: p.intake.brief_revision, source_ref: 'council:result', findings: [] }
      : action === 'revise' ? { brief: { scope: 'Smaller pilot' } }
        : { need_id: 'owner', expected_knowledge_revision: 1, answer: 'Pat', source_ref: 'chat:volunteered' };
    const result = await op(p, action, input);
    expect(result.status).toBe(200);
    expect(result.body.intake.state).toBe('deferred');
    if (action === 'record_review') expect(result.body.intake.review.status).toBe('completed');
  });

  test.each(preHandoffStates)('a supplied answer is saved while %s without resuming a deferred conversation', async state => {
    const p = await atState(state);
    const result = await op(p, 'answer', { need_id: 'owner', expected_knowledge_revision: 1, answer: 'Pat', source_ref: 'chat:volunteered' });
    expect(result.status).toBe(200);
    expect(result.body.project.needs[0].knowledge).toMatchObject({ answer: 'Pat', evidence: [{ ref: 'chat:volunteered' }] });
    expect(result.body.intake.state).toBe(['council_review', 'ready_for_decision'].includes(state) ? 'interviewing' : state);
    expect(result.body.intake.brief_revision).toBe(p.intake.brief_revision + 1);
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(p.project.id).n).toBe(0);
  });

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

  const verifiedSource = async () => {
    const source = { ref: 'file:costs', type: 'file', availability: 'available', revision: 'v1', summary: 'Costs $100', processing_result: 'Read successfully' };
    let p = (await create({ sources: [source] })).body;
    p = (await op(p, 'prepare', { brief, needs: [need('cost', 'research'), need('unrelated')] })).body;
    p = (await op(p, 'start')).body;
    const answered = await op(p, 'answer', { need_id: 'cost', expected_knowledge_revision: 1, answer: '$100', source_ref: 'chat:cost', evidence: [{ ref: source.ref }], verification: { rationale: 'The cost table provides the price', evidence_refs: [source.ref] } });
    expect(answered.status).toBe(200);
    p = answered.body;
    p = (await op(p, 'request_review', { session_id: 'council:cost', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:cost', brief_revision: p.intake.brief_revision, source_ref: 'council:cost-result', findings: [] })).body;
    expect(p.project.needs[0].status).toBe('met');
    return { p, source };
  };

  test.each([
    ['revision', { revision: 'v2' }], ['availability', { availability: 'conflicting' }],
    ['content', { summary: 'Costs $500' }], ['processing result', { processing_result: 'Table could not be parsed' }],
  ])('source-only %s correction reopens only linked knowledge with durable history and CAS', async (_label, change) => {
    const { p, source } = await verifiedSource();
    const previous = p.project.needs[0];
    const input = { operation_id: crypto.randomUUID(), expected_revision: p.intake.revision, action: 'revise', sources: [{ ...source, ...change }] };
    const result = await request(`/${p.project.id}/intake/operations`, input);
    expect(result.status).toBe(200);
    const reopened = result.body.project.needs[0];
    expect(reopened).toMatchObject({ status: 'open', knowledge: { answer: '$100', revision: previous.knowledge.revision + 1, research_status: 'stale' } });
    expect(reopened.resolved_at).toBeUndefined();
    expect(reopened.knowledge.history.at(-1)).toMatchObject({ revision: previous.knowledge.revision, answer: '$100', verification: previous.knowledge.verification, evidence: previous.knowledge.evidence });
    expect(reopened.knowledge.verification.revision).not.toBe(reopened.knowledge.revision);
    expect(result.body.project.needs[1]).toEqual(p.project.needs[1]);
    expect(result.body.intake).toMatchObject({ state: 'interviewing', brief_revision: p.intake.brief_revision + 1, review: null });
    expect(result.body.intake.brief_history.at(-1).sources).toEqual([source]);
    expect((await request(`/${p.project.id}/intake/operations`, input)).body).toEqual(result.body);
    expect((await op(p, 'revise', { sources: [source] })).status).toBe(409);
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(result.body);
  });

  test('new unrelated sources do not reopen verified knowledge', async () => {
    const { p } = await verifiedSource();
    const result = await op(p, 'revise', { sources: [{ ref: 'file:unrelated', type: 'file', availability: 'conflicting', summary: 'Unrelated uncertainty' }] });
    expect(result.status).toBe(200);
    expect(result.body.project.needs).toEqual(p.project.needs);
    expect(result.body.intake.brief_revision).toBe(p.intake.brief_revision + 1);
  });

  test.each([{}, { retrieved_at: '2026-11-01T12:00:00.000Z' }])('identical source content or retrieval refresh %j preserves verification and current review', async metadata => {
    const { p, source } = await verifiedSource();
    const result = await op(p, 'revise', { sources: [{ ...source, ...metadata }] });
    expect(result.status).toBe(200);
    expect(result.body.project.needs).toEqual(p.project.needs);
    expect(result.body.intake.sources).toEqual([{ ...source, ...metadata }]);
    expect(result.body.intake.brief_revision).toBe(p.intake.brief_revision);
    expect(result.body.intake.review).toEqual(p.intake.review);
    expect(result.body.intake.state).toBe('ready_for_decision');
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
    expect((await op(accepted.body, 'start')).body.code).toBe('INTAKE_HANDED_OFF');
  });

  test('post-handoff answers and material revisions retain the accepted snapshot and immutable receipt', async () => {
    const { p, source } = await verifiedSource();
    const input = { operation_id: crypto.randomUUID(), expected_revision: p.intake.revision, action: 'accept', source_ref: 'chat:proceed', next_step: 'Plan', brief_revision: p.intake.brief_revision };
    const accepted = await request(`/${p.project.id}/intake/operations`, input);
    expect(accepted.status).toBe(200);
    const receipt = accepted.body.intake.acceptance;
    const answer = await op(accepted.body, 'answer', { need_id: 'unrelated', expected_knowledge_revision: 1, answer: 'Pat', source_ref: 'chat:later-answer' });
    expect(answer.status).toBe(200);
    expect(answer.body.intake).toMatchObject({ state: 'handed_off', acceptance: receipt, brief_revision: receipt.brief_revision + 1 });
    expect(answer.body.intake.brief_history.find(h => h.brief_revision === receipt.brief_revision)).toMatchObject({ brief: p.intake.brief, sources: p.intake.sources, need_revisions: { cost: p.project.needs[0].knowledge.revision, unrelated: 1 } });
    const revised = await op(answer.body, 'revise', { brief: { outcome: 'New planning goal' }, sources: [{ ...source, revision: 'v2', summary: 'Costs $500' }], needs: [need('later')] });
    expect(revised.status).toBe(200);
    expect(revised.body.project).toMatchObject({ phase: 'planning', end_state: accepted.body.project.end_state });
    expect(revised.body.intake).toMatchObject({ state: 'handed_off', acceptance: receipt, brief: { outcome: 'New planning goal' }, brief_revision: receipt.brief_revision + 2, review: null });
    expect(revised.body.project.needs[0]).toMatchObject({ status: 'open', knowledge: { answer: '$100', research_status: 'stale' } });
    expect(revised.body.project.needs[0].knowledge.history.at(-1).verification).toEqual(p.project.needs[0].knowledge.verification);
    expect(revised.body.intake.need_ids).toContain('later');
    expect((await request(`/${p.project.id}/intake/operations`, input)).body).toEqual(accepted.body);
    expect((await op(answer.body, 'revise', { brief: { scope: 'Stale write' } })).body.code).toBe('INTAKE_REVISION_STALE');
    for (const action of ['start', 'defer', 'prepare']) expect((await op(revised.body, action)).body).toMatchObject({ code: 'INTAKE_HANDED_OFF', error: expect.stringMatching(/answer.*revise/i) });
    expect((await op(revised.body, 'record_review', { session_id: 'council:cost', brief_revision: revised.body.intake.brief_revision, source_ref: 'council:late', findings: [] })).body.code).toBe('INTAKE_HANDED_OFF');
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(revised.body);
  });

  test('canonical knowledge corrections after handoff version intake without changing acceptance', async () => {
    const p = await prepared();
    const accepted = (await op(p, 'accept', { source_ref: 'chat:proceed', next_step: 'Plan', brief_revision: p.intake.brief_revision })).body;
    const corrected = await db.updateProjectNeed(p.project.id, 'owner', { expected_knowledge_revision: 1, knowledge: { answer: 'Pat' } });
    expect(corrected.intake).toMatchObject({ revision: accepted.intake.revision + 1, brief_revision: accepted.intake.brief_revision + 1, state: 'handed_off', acceptance: accepted.intake.acceptance });
    expect(corrected.phase).toBe('planning');
    expect(corrected.intake.brief_history.at(-1)).toMatchObject({ brief_revision: accepted.intake.brief_revision, brief: accepted.intake.brief, need_revisions: { owner: 1 } });
    expect((await op(accepted, 'answer', { need_id: 'owner', expected_knowledge_revision: 1, answer: 'Stale', source_ref: 'chat:stale' })).body.code).toBe('INTAKE_REVISION_STALE');
  });

  test.each([false, true])('new canonical information needs can be answered through intake after handoff=%s', async handedOff => {
    let p = await prepared();
    if (handedOff) p = (await op(p, 'accept', { source_ref: 'chat:proceed', next_step: 'Plan', brief_revision: p.intake.brief_revision })).body;
    // An untouched legacy need outside the intake registry is not silently adopted.
    const legacy = { ...need('legacy'), status: 'open', knowledge: { ...need('legacy').knowledge, revision: 1 } };
    raw.prepare('UPDATE projects SET needs=? WHERE id=?').run(JSON.stringify([...p.project.needs, legacy]), p.project.id);
    const { id, ...definition } = need('new');
    const added = await request(`/${p.project.id}/needs`, { ...definition, source: 'operator' });
    expect(added.status).toBe(201);
    const registered = (await request(`/${p.project.id}/intake`, null, 'GET')).body;
    expect(registered.intake.need_ids).toEqual(['owner', added.body.need.id]);
    expect(registered.intake.acceptance).toEqual(p.intake.acceptance);
    expect(registered.intake.brief_history.at(-1).need_revisions).toEqual({ owner: 1 });
    const answered = await op(registered, 'answer', { need_id: added.body.need.id, expected_knowledge_revision: 1, answer: 'Pat', source_ref: 'chat:answer' });
    expect(answered.status).toBe(200);
    expect(answered.body.project.needs.find(n => n.id === added.body.need.id).knowledge.answer).toBe('Pat');
    expect(answered.body.intake.state).toBe(handedOff ? 'handed_off' : 'awaiting_choice');
    expect(answered.body.intake.acceptance).toEqual(p.intake.acceptance);
    expect((await op(answered.body, 'answer', { need_id: 'missing', expected_knowledge_revision: 1, answer: 'No', source_ref: 'chat:invalid' })).body.code).toBe('INTAKE_NEED_NOT_FOUND');
  });

  test('explicit canonical goal edits sync only supplied changed brief fields before handoff', async () => {
    let p = await atState('ready_for_decision');
    // Distinct canonical and brief values make accidental copying of omitted fields observable.
    raw.prepare('UPDATE projects SET endpoint=? WHERE id=?').run(JSON.stringify({ beneficiary: 'Earlier audience', exclusions: 'Earlier exclusions' }), p.project.id);
    const changes = { end_state: 'A smaller lending pilot', endpoint: { scope: 'One street', exclusions: 'No purchases' }, end_state_criteria: [{ id: 'new', kind: 'manual', description: 'Three completed loans' }], end_state_source: 'chat:goal-edit', end_state_reason: 'Narrow the pilot', expected_updated_at: p.project.updated_at };
    const edited = await request(`/${p.project.id}`, changes, 'PATCH');
    expect(edited.status).toBe(200);
    p = (await request(`/${p.project.id}/intake`, null, 'GET')).body;
    expect(p.project.end_state_history.at(-1)).toMatchObject({ end_state: changes.end_state, source: 'chat:goal-edit', reason: 'Narrow the pilot' });
    expect(p.intake.brief).toEqual({ ...brief, outcome: changes.end_state, scope: 'One street', exclusions: 'No purchases', success_criteria: ['Three completed loans'] });
    expect(p.intake).toMatchObject({ revision: 4, brief_revision: 2, state: 'interviewing', review: null, acceptance: null });
    expect(p.project.phase).toBe('intake');
    expect(p.intake.brief_history.at(-1).brief).toEqual(brief);
    expect(p.intake.review_history.at(-1).status).toBe('completed');
    expect((await request(`/${p.project.id}`, changes, 'PATCH')).status).toBe(409);
    const noOp = await db.updateProject(p.project.id, { ...changes, expected_updated_at: p.project.updated_at });
    expect(noOp.intake).toEqual(p.intake);
    const cleared = await db.updateProject(p.project.id, { expected_updated_at: noOp.updated_at, end_state: '', endpoint: { beneficiary: 'New audience', scope: '', exclusions: '' }, end_state_criteria: [] });
    expect(cleared.intake.brief).toMatchObject({ outcome: '', beneficiary: 'New audience', scope: '', exclusions: '', success_criteria: [] });
    expect(cleared.intake.brief.purpose).toBe(brief.purpose);
    expect(cleared.intake.brief_revision).toBe(p.intake.brief_revision + 1);
  });

  test('canonical goal edits after handoff leave historical intake adoption unchanged', async () => {
    const p = await prepared();
    const accepted = (await op(p, 'accept', { source_ref: 'chat:proceed', next_step: 'Plan', brief_revision: p.intake.brief_revision })).body;
    const edited = await db.updateProject(p.project.id, { end_state: 'New canonical planning goal', endpoint: { beneficiary: 'New audience' }, expected_updated_at: accepted.project.updated_at });
    expect(edited.intake).toEqual(accepted.intake);
    expect(edited.phase).toBe('planning');
    expect(edited.end_state).toBe('New canonical planning goal');
  });

  test('material revisions invalidate review, and failed or stale callbacks cannot claim success', async () => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:2', brief_revision: p.intake.brief_revision })).body;
    const revised = await op(p, 'revise', { brief: { scope: 'A smaller pilot' } });
    expect(revised.status).toBe(200);
    expect(revised.body.intake.state).toBe('interviewing');
    expect((await op(revised.body, 'record_review', { session_id: 'council:2', brief_revision: p.intake.brief_revision, source_ref: 'council:old', findings: [] })).status).toBe(409);
    const accepted = await op(revised.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: revised.body.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance.review_disposition).toBe('stale');
  });

  test('rejects arbitrary mutations and workspace operations cannot fall back to cwd', async () => {
    const p = (await create()).body;
    expect((await op(p, 'prepare', { brief, phase: 'planning' })).status).toBe(400);
    for (const [route, method] of [['status', 'GET'], ['readme', 'GET'], ['commits', 'GET'], ['diff', 'GET'], ['git/init', 'POST'], ['context/sync', 'POST'], ['generate-commit-message', 'POST']]) {
      const result = await request(`/${p.project.id}/${route}`, method === 'POST' ? {} : null, method);
      expect(result.status).toBe(409); expect(result.body.code).toBe('WORKSPACE_UNAVAILABLE');
    }
  });
  test.each(['scheduled', 'in_progress'])('existing work admits and promotes to %s and definition or research tasks can be filed during intake', async status => {
    const id = crypto.randomUUID(), name = crypto.randomUUID();
    const folder = path.join(dir, crypto.randomUUID()); fs.mkdirSync(folder);
    raw.prepare('INSERT INTO projects(id,name,path,status) VALUES (?,?,?,?)').run(id, name, folder, 'active');
    const task = await db.createTask({ project_id: id, name: 'Existing queued delivery', status: 'todo' });
    expect(task.id).toBeTruthy();
    const created = await create({ project_id: id, name, existing_path: folder });
    expect(created.status).toBe(201);
    const p = created.body;
    expect((await db.getWorkAdmission(task.id)).id).toBe(task.id);
    expect((await db.updateTask(task.id, { status }, task.version, { origin: { kind: 'operator', authority: 'operator_credential' } })).status).toBe(status);
    for (const name of ['Define the project boundaries', 'Research market evidence']) {
      expect((await db.createTask({ project_id: id, name, status: 'idea' })).id).toBeTruthy();
    }
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
    const edited = await db.updateProject(p.project.id, { end_state: 'Explicit new goal', expected_updated_at: saved.project.updated_at });
    expect(edited.intake.brief.outcome).toBe('Explicit new goal');
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

  test.each(['failed', 'partial'])('%s council results remain honest when the operator accepts', async status => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:partial', brief_revision: p.intake.brief_revision })).body;
    const result = await op(p, 'record_review', { session_id: 'council:partial', brief_revision: p.intake.brief_revision, source_ref: 'council:partial-result', findings: [], status });
    expect(result.body.intake.review.status).toBe(status);
    const accepted = await op(result.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance.review_disposition).toBe(status);
    expect(accepted.body.intake.review).toEqual(result.body.intake.review);
  });

  describe('partial councils with at least one substantive seat (Robert, 2026-11-17)', () => {
    const twoOfThree = { substantive_seats: 2, total_seats: 3 };
    const budget = need('budget');
    const read = async id => (await request(`/${id}/intake`, null, 'GET')).body;
    const preparationResult = async extra => {
      const p = (await create()).body;
      const requested = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:explicit-council', session_id: 'council:prep', brief_revision: p.intake.brief_revision })).body;
      return op(requested, 'record_review', { session_id: 'council:prep', brief_revision: p.intake.brief_revision, source_ref: 'council:prep-result', findings: [], brief, sources: [{ ref: 'file:split-questions', type: 'file', availability: 'available' }], needs: [need(), budget], ...extra });
    };
    const reviewResult = async (extra, findings = []) => {
      let p = (await op(await prepared(), 'start')).body;
      p = (await op(p, 'request_review', { session_id: 'council:review', brief_revision: p.intake.brief_revision })).body;
      return { pending: p, result: await op(p, 'record_review', { session_id: 'council:review', brief_revision: p.intake.brief_revision, source_ref: 'council:review-result', findings, ...extra }) };
    };
    const comparable = body => ({ state: body.intake.state, brief: body.intake.brief, sources: body.intake.sources.map(({ retrieved_at, ...s }) => s), brief_revision: body.intake.brief_revision, revision: body.intake.revision,
      need_ids: body.intake.need_ids, pending_need_id: body.intake.pending_need_id, review: body.intake.review && { ...body.intake.review, status: undefined, participation: undefined, completed_at: undefined, requested_at: undefined },
      needs: body.project.needs.map(n => ({ id: n.id, status: n.status, question: n.knowledge?.question })) });

    test('a preparation partial applies brief, sources and needs and advances state exactly as a completed one', async () => {
      const completed = await preparationResult({});
      const partial = await preparationResult({ status: 'partial', participation: twoOfThree });
      expect(completed.status).toBe(200); expect(partial.status).toBe(200);
      expect(partial.body.intake.state).toBe('preparing');
      expect(partial.body.intake.brief).toEqual(brief);
      expect(partial.body.project.needs.map(n => n.id)).toEqual(['owner', 'budget']);
      expect(partial.body.intake.review).toBeNull();
      expect(comparable(partial.body)).toEqual(comparable(completed.body));
      expect(partial.body.intake.review_history.at(-1)).toMatchObject({ mode: 'preparation', status: 'partial', participation: twoOfThree, source_ref: 'council:prep-result' });
      expect(completed.body.intake.review_history.at(-1).participation).toBeUndefined();
    });

    test('a post-interview partial applies follow-up needs and settles like a completed review, keeping partial and 2/3 in history', async () => {
      const completed = (await reviewResult({ needs: [budget] })).result;
      const partial = (await reviewResult({ needs: [budget], status: 'partial', participation: twoOfThree })).result;
      expect(partial.status).toBe(200);
      expect(partial.body.intake.state).toBe('interviewing');
      expect(partial.body.project.needs.map(n => n.id)).toEqual(['owner', 'budget']);
      expect(comparable(partial.body)).toEqual(comparable(completed.body));
      // The new need is material, so the reviewed revision moves to history.
      expect(partial.body.intake.review).toBeNull();
      expect(partial.body.intake.review_history.at(-1)).toMatchObject({ mode: 'review', status: 'partial', participation: twoOfThree, source_ref: 'council:review-result' });
      expect((await read(partial.body.project.id)).intake.review_history.at(-1)).toMatchObject({ status: 'partial', participation: twoOfThree });
    });

    test('a post-interview partial without changes leaves panel review and stays partial when accepted', async () => {
      const completed = (await reviewResult({})).result;
      const { pending, result } = await reviewResult({ status: 'partial', participation: { substantive_seats: 1, total_seats: 3 } });
      expect(pending.intake.state).toBe('council_review');
      expect(result.status).toBe(200);
      expect(result.body.intake.state).toBe('ready_for_decision');
      expect(comparable(result.body)).toEqual(comparable(completed.body));
      expect(result.body.intake.review).toMatchObject({ status: 'partial', participation: { substantive_seats: 1, total_seats: 3 } });
      const accepted = await op(result.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: result.body.intake.brief_revision });
      expect(accepted.status).toBe(200);
      expect(accepted.body.intake.acceptance.review_disposition).toBe('partial');
      expect(accepted.body.intake.review).toMatchObject({ status: 'partial', participation: { substantive_seats: 1, total_seats: 3 } });
    });

    test.each([
      ['failed', { status: 'failed' }],
      ['failed with seats', { status: 'failed', participation: twoOfThree }],
      ['partial with zero seats', { status: 'partial', participation: { substantive_seats: 0, total_seats: 3 } }],
      ['partial with no participation', { status: 'partial' }],
    ])('%s is still refused when it carries changes', async (_label, extra) => {
      const prep = await preparationResult(extra);
      expect(prep.status).toBe(400);
      expect(prep.body.code).toBe('INVALID_INTAKE');
      expect(prep.body.error || prep.body.message).toMatch(/cannot apply preparation changes/);
      const { pending, result } = await reviewResult({ ...extra, needs: [budget] });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('INVALID_INTAKE');
      const unchanged = await read(pending.project.id);
      expect(unchanged.intake).toEqual(pending.intake);
      expect(unchanged.project.needs.map(n => n.id)).toEqual(['owner']);
    });

    test.each([
      ['failed', { status: 'failed' }],
      ['partial with zero seats', { status: 'partial', participation: { substantive_seats: 0, total_seats: 3 } }],
      ['partial with no participation', { status: 'partial' }],
    ])('%s without changes is saved but keeps the council in review', async (_label, extra) => {
      const { result } = await reviewResult(extra);
      expect(result.status).toBe(200);
      expect(result.body.intake.state).toBe('council_review');
      expect(result.body.intake.review.status).toBe(extra.status);
      expect(result.body.intake.review.participation).toEqual(extra.participation);
    });

    test.each([
      ['more seats than summoned', { status: 'partial', participation: { substantive_seats: 4, total_seats: 3 } }],
      ['no seats summoned', { status: 'partial', participation: { substantive_seats: 1, total_seats: 0 } }],
      ['a text figure', { status: 'partial', participation: '2/3' }],
      ['a completed result missing seats', { status: 'completed', participation: twoOfThree }],
    ])('participation with %s is refused', async (_label, extra) => {
      const { result } = await reviewResult({ ...extra, needs: [budget] });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('INVALID_INTAKE');
    });
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
    expect(git.status).toBe(200);
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(true);
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(attached.body);
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

  test.each(['partial', 'unknown'])('acceptance records missing purpose and %s resolution plans without rewriting needs', async plan => {
    const research = need('research', 'research');
    research.knowledge.resolution = { method: 'research' };
    let p;
    if (plan === 'unknown') {
      delete research.knowledge.resolution;
      const id = crypto.randomUUID(), name = crypto.randomUUID();
      raw.prepare('INSERT INTO projects(id,name,path,needs) VALUES (?,?,?,?)').run(id, name, '', JSON.stringify([{ ...research, status: 'open', created_at: 'old' }]));
      const adopted = (await create({ project_id: id, name })).body;
      const result = await op(adopted, 'prepare', { brief });
      expect(result.status).toBe(200);
      p = result.body;
    } else p = await prepared([research]);
    p = (await op(p, 'revise', { brief: { purpose: '' } })).body;
    p = (await op(p, 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:readiness', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:readiness', brief_revision: p.intake.brief_revision, source_ref: 'council:readiness-result', findings: [] })).body;
    const accepted = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision, decision_note: 'We need to proceed today.' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance).toMatchObject({ review_disposition: 'completed', decision_note: 'We need to proceed today.' });
    expect(accepted.body.intake.acceptance.readiness_gaps).toEqual(expect.arrayContaining([expect.stringContaining('purpose'), expect.stringContaining('research')]));
    expect(accepted.body.project.needs).toEqual(p.project.needs);
    expect(accepted.body.intake.brief_history).toEqual(p.intake.brief_history);
  });

  test('acceptance keeps unresolved current review findings visible as readiness gaps', async () => {
    let p = await prepared();
    p = (await op(p, 'request_review', { session_id: 'council:questions', brief_revision: p.intake.brief_revision })).body;
    const findings = [{ summary: 'Confirm the pilot deadline', disposition: 'ask_robert' }, { summary: 'Clarify accessible tool storage', disposition: 'revise_proposal' }];
    p = (await op(p, 'record_review', { session_id: 'council:questions', source_ref: 'council:questions-result', findings, brief_revision: p.intake.brief_revision })).body;
    const accepted = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance.review_disposition).toBe('completed');
    expect(accepted.body.intake.acceptance.readiness_gaps).toEqual(expect.arrayContaining(findings.map(f => expect.stringContaining(f.summary))));
    expect(accepted.body.intake.review.findings).toEqual(findings);
  });

  test.each(['preparing', 'awaiting_choice', 'deferred', 'interviewing'])('operator can accept from %s without a completed council', async state => {
    let p = state === 'preparing' ? (await create()).body : await prepared();
    if (state === 'deferred') p = (await op(p, 'defer')).body;
    if (state === 'interviewing') p = (await op(p, 'start')).body;
    const before = fs.readdirSync(dir);
    const accepted = await op(p, 'accept', { source_ref: 'chat:proceed-now', next_step: 'Plan next actions', brief_revision: p.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.project.phase).toBe('planning');
    expect(accepted.body.intake).toMatchObject({ state: 'handed_off', acceptance: { review_disposition: 'not_requested' } });
    expect(accepted.body.intake.acceptance.readiness_gaps).toEqual(expect.arrayContaining([expect.stringContaining('review')]));
    expect(accepted.body.project.needs).toEqual(p.project.needs);
    expect(accepted.body.intake.review).toBeNull();
    expect(fs.readdirSync(dir)).toEqual(before);
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(p.project.id).n).toBe(0);
    if (state === 'preparing') {
      expect(accepted.body.project.end_state).toEqual(p.project.end_state);
      expect(accepted.body.project.end_state_criteria).toEqual(p.project.end_state_criteria);
      expect(accepted.body.project.endpoint).toEqual({ proposed_next: 'Plan next actions', completion_policy: 'propose_next' });
    }
  });

  test.each(['preparation', 'review'])('accepting while %s council is pending archives it and fences its later callback', async mode => {
    let p = mode === 'preparation' ? (await create()).body : await prepared();
    p = (await op(p, 'request_review', { mode, source_ref: 'chat:review', session_id: `council:pending-${mode}`, brief_revision: p.intake.brief_revision })).body;
    const accepted = await op(p, 'accept', { source_ref: 'chat:move-now', next_step: 'Start planning', brief_revision: p.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance.review_disposition).toBe('pending');
    expect(accepted.body.intake.review).toBeNull();
    expect(accepted.body.intake.review_history.at(-1)).toEqual(p.intake.review);
    expect((await op(accepted.body, 'record_review', { session_id: p.intake.review.session_id, source_ref: 'council:late', findings: [], brief_revision: p.intake.brief_revision })).status).toBe(409);
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(accepted.body);
  });

  test('incomplete acceptance preserves an existing endpoint instead of inventing missing fields', async () => {
    const id = crypto.randomUUID(), name = crypto.randomUUID();
    await db.upsertProject({ id, name, path: '', end_state: 'Existing outcome', endpoint: { beneficiary: 'Existing audience', scope: 'Existing scope', exclusions: 'Existing exclusions' }, end_state_criteria: [{ id: 'existing', kind: 'manual', description: 'Existing criterion' }] });
    let p = (await create({ project_id: id, name })).body;
    p = (await op(p, 'revise', { brief: { scope: 'New scope' } })).body;
    const accepted = await op(p, 'accept', { source_ref: 'chat:scope-only', next_step: 'Plan scope', brief_revision: p.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.project.end_state).toBe('Existing outcome');
    expect(accepted.body.project.end_state_criteria).toEqual(p.project.end_state_criteria);
    expect(accepted.body.project.endpoint).toMatchObject({ beneficiary: 'Existing audience', scope: 'New scope', exclusions: 'Existing exclusions', proposed_next: 'Plan scope' });
  });

  test('acceptance still requires the current brief revision and nonblank source and next step', async () => {
    const p = await prepared();
    for (const input of [{ brief_revision: 0 }, { source_ref: '' }, { next_step: ' ' }]) {
      const result = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision, ...input });
      expect(result.status).toBe(input.brief_revision === 0 ? 409 : 400);
      expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(p);
    }
  });

  test('older records without optional acceptance details or workspace history remain readable', async () => {
    const p = (await create()).body;
    const legacy = { ...p.intake, state: 'handed_off', acceptance: { brief_revision: 0, source_ref: 'chat:original-accept', next_step: 'Plan', at: p.project.updated_at } };
    delete legacy.workspace_history;
    raw.prepare('UPDATE projects SET phase=?, intake=? WHERE id=?').run('planning', JSON.stringify(legacy), p.project.id);
    const result = await request(`/${p.project.id}/intake`, null, 'GET');
    expect(result.status).toBe(200);
    expect(result.body.intake).toEqual(legacy);
    expect(require('@praxis/contract').ProjectIntakeSchema.safeParse(legacy).success).toBe(true);
  });

  // The step after accept (docs/project-intake.md, "The initial backlog receipt"). S-numbers are the
  // scenarios of Praxis docs/investigations/intake-task-generation-gap-2026-11-04.md, section 6.
  describe('the initial backlog receipt (record_backlog)', () => {
    // Intake stamps run one millisecond ahead of each other, so wait before filing a task that has to count as later.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    const accept = async (p, rest = {}) => {
      const result = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan the pilot', brief_revision: p.intake.brief_revision, ...rest });
      expect(result.status).toBe(200);
      await settle();
      return result.body;
    };
    const handedOff = async () => accept(await prepared());
    const body = (slot, rest = {}) => ({ slot, name: `Stage ${slot}: pilot step ${slot}`, description: `What: deliver step ${slot} of the pilot. Why: the accepted next step needs it.`,
      antigravity_payload: { prompt: `Deliver step ${slot} of the pilot`, acceptance_criteria: [`Step ${slot} is demonstrated`] }, ...rest });
    const plan = (note = '') => [body(1), body(2, { dependencies: [1] }), body(3, { dependencies: [2] })].map(proposal => ({ ...proposal, description: proposal.description + note }));
    const record = (snapshot, rest) => op(snapshot, 'record_backlog', rest);
    const rows = id => raw.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY rowid').all(id);
    const read = async id => (await request(`/${id}/intake`, null, 'GET')).body;
    const file = async (projectId, names, extra = {}) => (await db.batchCreateTasks(names.map(name => ({ project_id: projectId, name, status: 'idea', source: 'praxis-chat',
      description: `Filed with a plain batch create: ${name}`, ...extra })))).map(task => task.id);
    const derived = (snapshot, slot) => `intake-backlog:${snapshot.project.id}:${snapshot.intake.acceptance.at}:${slot}`;
    const identity = row => JSON.parse(row.metadata).work_identity?.proposal_id;
    const count = table => raw.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const elsewhere = () => ({ folders: fs.readdirSync(dir), scheduled: count('scheduled_tasks'), runs: count('runs'), calendar: count('calendar_events'), documents: count('review_documents') });
    /** Everything a receipt may not change: the project, the brief, the review and the acceptance decision. */
    const decision = snapshot => {
      const { updated_at, intake, ...project } = snapshot.project;
      const { revision, operations, acceptance, ...record } = intake;
      const { backlog, backlog_history, ...accepted } = acceptance;
      return { project, record, accepted };
    };
    /** A refused call wrote nothing: same intake revision, same receipt, same number of tasks. */
    const untouched = async (snapshot, tasks) => {
      expect(await read(snapshot.project.id)).toEqual(snapshot);
      expect(rows(snapshot.project.id)).toHaveLength(tasks);
    };

    test('S1: accept reports no receipt, and one generated call files the proposals and records their ids', async () => {
      const accepted = await handedOff(), id = accepted.project.id;
      expect(accepted).toMatchObject({ open_task_count: 0, backlog: null });
      expect(await read(id)).toEqual(accepted);
      const before = elsewhere();
      const proposals = [body(1, { metadata: { checkpoint_id: 'checkpoint-1', work_identity: { proposal_id: 'chosen-by-the-caller' } } }), body(2, { dependencies: [1] }), body(3, { dependencies: [1, 2] })];
      const result = await record(accepted, { status: 'generated', proposals });
      expect(result.status).toBe(200);
      const receipt = result.body.backlog, stored = rows(id);
      expect(stored).toHaveLength(3);
      expect(receipt).toEqual({ status: 'generated', task_ids: stored.map(row => row.id), remaining: [], brief_revision: accepted.intake.brief_revision,
        proposals: proposals.map((proposal, index) => ({ ...proposal, task_id: stored[index].id })), operation_id: expect.any(String), at: result.body.project.updated_at, replayed: false });
      stored.forEach((row, index) => {
        expect(row).toMatchObject({ name: proposals[index].name, description: proposals[index].description, status: 'idea', source: 'nexus-api', created_at: receipt.at });
        expect(identity(row)).toBe(derived(accepted, index + 1));
        expect(JSON.parse(row.antigravity_payload)).toEqual(proposals[index].antigravity_payload);
      });
      expect(JSON.parse(stored[0].metadata).checkpoint_id).toBe('checkpoint-1');
      expect(stored.map(row => JSON.parse(row.dependencies || '[]'))).toEqual([[], [stored[0].id], [stored[0].id, stored[1].id]]);
      // The response, the stored intake and a later read agree, and only the tasks and the receipt are new.
      expect(result.body).toMatchObject({ open_task_count: 3, intake: { state: 'handed_off', revision: accepted.intake.revision + 1, acceptance: { backlog: receipt } } });
      expect(result.body.intake.operations.at(-1)).toMatchObject({ operation_id: receipt.operation_id, action: 'record_backlog' });
      expect(await read(id)).toEqual(result.body);
      expect(decision(result.body)).toEqual(decision(accepted));
      expect(result.body.project).toMatchObject({ phase: 'planning', path: '' });
      expect(elsewhere()).toEqual(before);
    });

    test('S3 (a, c): a replayed envelope returns the stored receipt, and the same operation_id with recomposed proposals is refused', async () => {
      const accepted = await handedOff(), id = accepted.project.id;
      const envelope = { operation_id: crypto.randomUUID(), expected_revision: accepted.intake.revision, action: 'record_backlog', status: 'generated', proposals: plan() };
      const first = await request(`/${id}/intake/operations`, envelope);
      expect(first.status).toBe(200);
      const ids = first.body.backlog.task_ids;
      expect(rows(id).map(row => row.id)).toEqual(ids);
      expect(ids).toHaveLength(3);
      // (a) The response was lost and the caller sends the retained envelope again.
      const replayed = await request(`/${id}/intake/operations`, envelope);
      expect(replayed.status).toBe(200);
      const expected = structuredClone(first.body);
      for (const receipt of [expected.backlog, expected.intake.acceptance.backlog, expected.project.intake.acceptance.backlog]) receipt.replayed = true;
      expect(replayed.body).toEqual(expected);
      expect(replayed.body.backlog).toMatchObject({ task_ids: ids, replayed: true });
      expect(rows(id).map(row => row.id)).toEqual(ids);
      // Only the response to the retry says replayed; the record does not.
      expect(await read(id)).toEqual(first.body);
      // (c) The same operation_id with a recomposed plan is a different payload under that id.
      const recomposed = await request(`/${id}/intake/operations`, { ...envelope, proposals: plan(' Recomposed for the retry.') });
      expect(recomposed.status).toBe(409);
      expect(recomposed.body.code).toBe('INTAKE_OPERATION_COLLISION');
      await untouched(first.body, 3);
    });

    test('S3 (b): of two workers that read the same revision one files the backlog, and the other creates nothing and is handed the ids', async () => {
      const accepted = await handedOff(), id = accepted.project.id;
      const results = await Promise.all(['worker one', 'worker two'].map(worker => record(accepted, { status: 'generated', proposals: plan(` Planned by ${worker}.`) })));
      expect(results.map(result => result.status).sort()).toEqual([200, 409]);
      const won = results.find(result => result.status === 200), lost = results.find(result => result.status === 409);
      expect(lost.body.code).toBe('INTAKE_REVISION_STALE');
      expect(won.body.intake.revision).toBe(accepted.intake.revision + 1);
      const ids = won.body.backlog.task_ids;
      expect(rows(id).map(row => row.id)).toEqual(ids);
      // The second worker reads again and finds the ids to report.
      const reread = await read(id);
      expect(reread.backlog.task_ids).toEqual(ids);
      // A fresh call that does not name the receipt is stopped before any task, and is handed the receipt.
      const again = await record(reread, { status: 'generated', proposals: plan(' Planned again.') });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'INTAKE_BACKLOG_EXISTS', backlog: reread.backlog });
      expect(again.body.error).toContain(reread.backlog.operation_id);
      // Naming some other operation does not replace it either, and a receipt that does not exist cannot be superseded.
      expect((await record(reread, { status: 'generated', proposals: plan(' Third.'), supersedes: crypto.randomUUID() })).body).toMatchObject({ code: 'INTAKE_BACKLOG_EXISTS', backlog: reread.backlog });
      await untouched(reread, 3);
      const other = await handedOff();
      expect((await record(other, { status: 'generated', proposals: plan(), supersedes: reread.backlog.operation_id })).body.code).toBe('INTAKE_BACKLOG_SUPERSEDES_UNKNOWN');
      await untouched(other, 0);
    });

    test.each([
      ['a1', 'slot 2 has an empty name', proposals => { proposals[1].name = ''; }, 2, /^proposals slot 2: name: /],
      ['a2', 'slot 3 depends on slot 4, which is not in the call', proposals => { proposals[2].dependencies = [4]; }, 3, /^proposals slot 3: it depends on slot 4/],
      ['extra', 'slots 1 and 2 depend on each other', proposals => { proposals[0].dependencies = [2]; }, 1, /^proposals slot 1: its dependencies lead back to its own slot/],
      ['extra', 'two proposals claim slot 2', proposals => { proposals[2].slot = 2; proposals[2].dependencies = [1]; }, 2, /^proposals slot 2: the slot appears more than once/],
      ['extra', 'slot 2 depends on a task the receipt does not name', proposals => { proposals[1].dependencies = ['00000000-0000-4000-8000-000000000000']; }, 2, /^proposals slot 2: it depends on task 00000000/],
      ['extra', 'slot 3 carries knowledge metadata that is not valid', proposals => { proposals[2].metadata = { knowledge_need_ids: 'owner' }; }, 3, /^proposals slot 3: /],
    ])('S4 (%s): %s, so the call is refused by slot with nothing written, and the corrected retry files all three', async (_case, _what, spoil, slot, message) => {
      const accepted = await handedOff(), id = accepted.project.id;
      const proposals = plan(); spoil(proposals);
      const refused = await record(accepted, { status: 'generated', proposals });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'INTAKE_BACKLOG_PROPOSAL_INVALID', list: 'proposals', slot, error: expect.stringMatching(message) });
      await untouched(accepted, 0);
      const retried = await record(accepted, { status: 'generated', proposals: plan() });
      expect(retried.status).toBe(200);
      expect(retried.body.backlog.task_ids).toEqual(rows(id).map(row => row.id));
      expect(rows(id)).toHaveLength(3);
    });

    test('S4 (a3): a create that fails on the third proposal rolls back the first two, reports the failure, and the retry files all three', async () => {
      const accepted = await handedOff(), id = accepted.project.id;
      const proposals = plan(), forced = `Stage 3: forced to fail ${crypto.randomUUID()}`;
      proposals[2].name = forced;
      raw.prepare(`CREATE TRIGGER forced_backlog_failure BEFORE INSERT ON tasks WHEN NEW.name = '${forced}' BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`).run();
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
      let failed, logged;
      try { failed = await record(accepted, { status: 'generated', proposals }); }
      finally {
        raw.prepare('DROP TRIGGER forced_backlog_failure').run();
        logged = errors.mock.calls.map(call => call.join(' ')).join('\n');
        errors.mockRestore();
      }
      // The board logged the insert it could not make, and the batch came back empty.
      expect(logged).toMatch(/Error creating task: forced insert failure[\s\S]*Error batch-creating tasks/);
      // The failure reaches the caller as an error, not as a success with an empty receipt.
      expect(failed.status).toBe(422);
      expect(failed.body).toMatchObject({ code: 'INTAKE_BACKLOG_CREATE_FAILED', error: expect.stringMatching(/the board created 0 of 3 tasks\. Nothing was written/) });
      expect(failed.body.backlog).toBeUndefined();
      await untouched(accepted, 0);
      expect(raw.prepare('SELECT count(*) AS n FROM work_admissions WHERE task_id NOT IN (SELECT id FROM tasks)').get().n).toBe(0);
      // The same proposals under a new operation_id start from the same state.
      const retried = await record(accepted, { status: 'generated', proposals });
      expect(retried.status).toBe(200);
      expect(retried.body.backlog).toMatchObject({ status: 'generated', task_ids: rows(id).map(row => row.id) });
      expect(rows(id).map(row => row.name)).toEqual(proposals.map(proposal => proposal.name));
    });

    test('S4 (c): two filed tasks and an unfiled slot make a partial receipt, and only a call that keeps all of it may replace it', async () => {
      const accepted = await handedOff(), id = accepted.project.id;
      const [t1, t2] = await file(id, ['Slot 1, filed with a plain batch', 'Slot 2, filed with a plain batch']);
      const slot3 = body(3, { dependencies: [t2], metadata: { checkpoint_id: 'checkpoint-1' } });
      const written = await record(await read(id), { status: 'generated', task_ids: [t1, t2], remaining: [slot3] });
      expect(written.status).toBe(200);
      const partial = written.body.backlog;
      expect(partial).toMatchObject({ status: 'partial', task_ids: [t1, t2], proposals: [], remaining: [slot3], replayed: false });
      expect(partial.supersedes).toBeUndefined();
      expect(written.body.intake.acceptance.backlog_history).toBeUndefined();
      expect(written.body.open_task_count).toBe(2);
      // An unrelated task lands on the board afterwards (S12).
      const [t4] = await file(id, ['Unrelated work filed later']);
      const current = await read(id);
      const supersede = rest => record(current, { status: 'generated', supersedes: partial.operation_id, ...rest });
      const dropped = async (rest, ids, slots) => {
        const refused = await supersede(rest);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'INTAKE_BACKLOG_PARTIAL_DROPPED', dropped_task_ids: ids, dropped_slots: slots, backlog: partial });
        for (const named of [...ids, ...slots.map(slot => `Slot ${slot}`)]) expect(refused.body.error).toContain(named);
        await untouched(current, 3);
      };
      await dropped({ task_ids: [t4] }, [t1, t2], [3]);                                    // S12 (c): names t1, t2 and slot 3
      await dropped({ proposals: [slot3] }, [t1, t2], []);                                 // files slot 3 but omits the prior ids
      await dropped({ task_ids: [t1, t2] }, [], [3]);                                      // keeps the ids but drops slot 3
      await dropped({ task_ids: [t1, t2], remaining: [{ ...slot3, name: 'Slot 3, reworded' }] }, [], [3]);
      await dropped({ task_ids: [t1, t2, t4], covers: [{ slot: 3, task_id: t4 }] }, [], [3]); // t4 was not filed for slot 3
      // Recording the unrelated task keeps the slot: still partial, slot 3 body unchanged.
      const recorded = await supersede({ task_ids: [t1, t2, t4], remaining: [slot3] });
      expect(recorded.status).toBe(200);
      expect(recorded.body.backlog).toMatchObject({ status: 'partial', task_ids: [t1, t2, t4], remaining: [slot3], supersedes: partial.operation_id });
      expect(rows(id)).toHaveLength(3);
      // Filing slot 3 from the stored body closes the receipt.
      const closed = await record(recorded.body, { status: 'generated', supersedes: recorded.body.backlog.operation_id, task_ids: [t1, t2, t4], proposals: recorded.body.backlog.remaining });
      expect(closed.status).toBe(200);
      const filed = rows(id).at(-1);
      expect(rows(id)).toHaveLength(4);
      expect(closed.body.backlog).toMatchObject({ status: 'generated', task_ids: [t1, t2, t4, filed.id], remaining: [], proposals: [{ ...slot3, task_id: filed.id }], supersedes: recorded.body.backlog.operation_id });
      expect(closed.body.intake.acceptance.backlog_history.map(receipt => receipt.status)).toEqual(['partial', 'partial']);
      expect(closed.body.intake.acceptance.backlog_history).toEqual([partial, recorded.body.backlog]);
      expect(identity(filed)).toBe(derived(accepted, 3));
      expect(JSON.parse(filed.dependencies)).toEqual([t2]);
      expect(JSON.parse(filed.metadata).checkpoint_id).toBe('checkpoint-1');
      expect(closed.body.open_task_count).toBe(4);
      expect(decision(closed.body)).toEqual(decision(accepted));
    });

    test('a slot filed outside the operation is accounted for with covers, by the identity Nexus derives for it', async () => {
      const accepted = await handedOff(), id = accepted.project.id;
      const [t1] = await file(id, ['Slot 1, filed with a plain batch']);
      const slot2 = body(2, { dependencies: [1] });
      // A remaining slot may depend on a slot no task was filed for through the receipt; it cannot be filed until that is settled.
      expect((await record(await read(id), { status: 'generated', task_ids: [t1], remaining: [slot2] })).body).toMatchObject({ code: 'INTAKE_BACKLOG_PROPOSAL_INVALID', list: 'remaining', slot: 2 });
      const held = body(2, { dependencies: [t1] });
      const partial = (await record(await read(id), { status: 'generated', task_ids: [t1], remaining: [held] })).body;
      expect(partial.backlog.status).toBe('partial');
      const [covering] = await file(id, ['Slot 2, filed with a plain batch under its derived identity'], { metadata: { work_identity: { proposal_id: derived(accepted, 2) } } });
      const [stray] = await file(id, ['Filed with some other identity'], { metadata: { work_identity: { proposal_id: 'some-other-plan:2' } } });
      const current = await read(id);
      const cover = task_id => record(current, { status: 'generated', supersedes: partial.backlog.operation_id, task_ids: [t1, stray], covers: [{ slot: 2, task_id }] });
      expect((await cover(stray)).body).toMatchObject({ code: 'INTAKE_BACKLOG_PARTIAL_DROPPED', dropped_slots: [2] });
      expect((await record(current, { status: 'generated', supersedes: partial.backlog.operation_id, task_ids: [t1], covers: [{ slot: 5, task_id: covering }], remaining: [held] })).body)
        .toMatchObject({ code: 'INTAKE_BACKLOG_PROPOSAL_INVALID', list: 'covers', slot: 5 });
      await untouched(current, 3);
      const closed = await cover(covering);
      expect(closed.status).toBe(200);
      expect(closed.body.backlog).toMatchObject({ status: 'generated', task_ids: [t1, stray, covering], remaining: [], proposals: [{ ...held, task_id: covering }] });
      expect(rows(id)).toHaveLength(3);
    });

    test('S5: the receipt keeps the brief revision it was planned against when the scope moves, and a stale brief revision is refused', async () => {
      const accepted = await handedOff(), id = accepted.project.id, at = accepted.intake.brief_revision;
      expect(at).toBeGreaterThan(0);
      // Older than the accepted brief, so nothing is filed.
      const older = await record(accepted, { status: 'generated', proposals: plan(), brief_revision: at - 1 });
      expect(older.status).toBe(409);
      expect(older.body).toMatchObject({ code: 'INTAKE_BACKLOG_BRIEF_STALE', brief_revision: at, accepted_brief_revision: at, error: expect.stringContaining('older than the accepted brief') });
      await untouched(accepted, 0);
      const written = await record(accepted, { status: 'generated', proposals: plan(), brief_revision: at });
      expect(written.status).toBe(200);
      const receipt = written.body.backlog;
      expect(receipt.brief_revision).toBe(at);
      const tasks = rows(id);
      // Robert moves the scope after the handoff.
      const revised = await op(written.body, 'revise', { brief: { scope: 'Tool lending pilot, two streets only' } });
      expect(revised.status).toBe(200);
      expect(revised.body.intake).toMatchObject({ state: 'handed_off', brief_revision: at + 1, brief: { scope: 'Tool lending pilot, two streets only' } });
      // The acceptance and the receipt stay as they were written, beside the current brief, and no task was touched.
      expect(revised.body.intake.acceptance).toEqual(written.body.intake.acceptance);
      expect(revised.body.backlog).toEqual(receipt);
      expect(revised.body.open_task_count).toBe(3);
      expect(await read(id)).toEqual(revised.body);
      expect(rows(id)).toEqual(tasks);
      // A plan made against the brief that was current before the revision is refused; the current one is stamped.
      const stale = await record(revised.body, { status: 'generated', supersedes: receipt.operation_id, task_ids: receipt.task_ids, proposals: [body(4)], brief_revision: at });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'INTAKE_BACKLOG_BRIEF_STALE', brief_revision: at + 1, accepted_brief_revision: at });
      await untouched(revised.body, 3);
      const extended = await record(revised.body, { status: 'generated', supersedes: receipt.operation_id, task_ids: receipt.task_ids, proposals: [body(4, { dependencies: [3] })] });
      expect(extended.status).toBe(200);
      expect(extended.body.backlog.brief_revision).toBe(at + 1);
      expect(extended.body.intake.acceptance.backlog_history).toEqual([receipt]);
      expect(JSON.parse(rows(id).at(-1).dependencies)).toEqual([receipt.task_ids[2]]);
    });

    test('S6: a deferral needs a reason and a reference, is recorded without a task, and a later generated receipt replaces it', async () => {
      const accepted = await handedOff(), id = accepted.project.id;
      const reason = 'Robert asked to hold tasks until he sends Chapter 1', source_ref = 'nexus://conversation/3abe0db4/message/c0b3b863';
      for (const bare of [{}, { reason }, { source_ref }, { reason, source_ref: 'hold:' }, { reason, source_ref: 'hold: ' }, { reason, source_ref: 'hold:legal-review' }]) {
        const refused = await record(accepted, { status: 'deferred', ...bare });
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('INTAKE_BACKLOG_REASON_REQUIRED');
      }
      // A deferral files nothing and names no new work.
      expect((await record(accepted, { status: 'deferred', reason, source_ref, proposals: plan() })).body.code).toBe('INVALID_INTAKE');
      const [stray] = await file(id, ['Filed before the deferral']);
      const before = await read(id);
      expect((await record(before, { status: 'deferred', reason, source_ref, task_ids: [stray] })).body.code).toBe('INVALID_INTAKE');
      await untouched(before, 1);
      const deferred = await record(before, { status: 'deferred', reason, source_ref });
      expect(deferred.status).toBe(200);
      expect(deferred.body.backlog).toMatchObject({ status: 'deferred', task_ids: [], proposals: [], remaining: [], reason, source_ref, brief_revision: accepted.intake.brief_revision, replayed: false });
      expect(rows(id)).toHaveLength(1);
      expect(decision(deferred.body)).toEqual(decision(accepted));
      // The deferral is a receipt: it is not overwritten by a call that has not read it.
      expect((await record(deferred.body, { status: 'generated', task_ids: [stray], proposals: plan() })).body).toMatchObject({ code: 'INTAKE_BACKLOG_EXISTS', backlog: deferred.body.backlog });
      // When the hold lifts, a generated receipt that names it takes its place.
      const lifted = await record(deferred.body, { status: 'generated', supersedes: deferred.body.backlog.operation_id, task_ids: [stray], proposals: plan() });
      expect(lifted.status).toBe(200);
      expect(lifted.body.backlog).toMatchObject({ status: 'generated', supersedes: deferred.body.backlog.operation_id });
      expect(lifted.body.backlog.task_ids).toEqual(rows(id).map(row => row.id));
      expect(lifted.body.backlog.reason).toBeUndefined();
      expect(lifted.body.intake.acceptance.backlog_history).toEqual([deferred.body.backlog]);
      // Robert can also put the recorded work on hold: the deferral carries it and adds nothing.
      const held = { status: 'deferred', supersedes: lifted.body.backlog.operation_id, reason: 'Paused under the legal-review hold', source_ref: 'hold:legal-review' };
      expect((await record(lifted.body, held)).body).toMatchObject({ code: 'INTAKE_BACKLOG_PARTIAL_DROPPED', dropped_task_ids: lifted.body.backlog.task_ids });
      const paused = await record(lifted.body, { ...held, task_ids: lifted.body.backlog.task_ids });
      expect(paused.status).toBe(200);
      expect(paused.body.backlog).toMatchObject({ status: 'deferred', task_ids: lifted.body.backlog.task_ids, source_ref: 'hold:legal-review', proposals: lifted.body.backlog.proposals });
      expect(rows(id)).toHaveLength(4);
    });

    test.each(['stale', 'partial'])('S8: acceptance with a %s review still succeeds, and the receipt asks for no council and no second approval', async disposition => {
      let p = await prepared();
      p = (await op(p, 'request_review', { session_id: `council:${disposition}`, brief_revision: p.intake.brief_revision })).body;
      p = (await op(p, 'record_review', { session_id: `council:${disposition}`, brief_revision: p.intake.brief_revision, source_ref: 'council:result',
        findings: [{ summary: 'Confirm the pilot deadline', disposition: 'ask_robert' }], ...(disposition === 'partial' ? { status: 'partial' } : {}) })).body;
      if (disposition === 'stale') p = (await op(p, 'revise', { brief: { scope: 'Smaller pilot' } })).body;
      const accepted = await accept(p, { source_ref: 'chat:proceed-anyway', decision_note: 'Proceed without waiting for the council.' });
      expect(accepted.intake.acceptance).toMatchObject({ review_disposition: disposition, decision_note: 'Proceed without waiting for the council.' });
      expect(accepted.intake.acceptance.readiness_gaps).toEqual(expect.arrayContaining([expect.stringContaining(`(${disposition})`)]));
      // The receipt is still owed, and writing it takes the plan and nothing else.
      expect(accepted).toMatchObject({ open_task_count: 0, backlog: null });
      const result = await record(accepted, { status: 'generated', proposals: [body(1)] });
      expect(result.status).toBe(200);
      expect(result.body.backlog).toMatchObject({ status: 'generated', task_ids: rows(accepted.project.id).map(row => row.id) });
      expect(decision(result.body)).toEqual(decision(accepted));
    });

    test.each(preHandoffStates)('record_backlog is refused while the intake is %s', async state => {
      const p = await atState(state);
      const refused = await record(p, { status: 'generated', proposals: plan() });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'INTAKE_STATE_CONFLICT', error: `record_backlog is unavailable while intake is ${state}` });
      await untouched(p, 0);
    });

    test('existing records open tasks that are already on the board and creates none; every named task has to be live on this project', async () => {
      const p = await prepared(), id = p.project.id;
      const [before1, before2] = await file(id, ['Define the pilot boundaries', 'Research lending rules']);
      const accepted = await accept(p);
      expect(accepted).toMatchObject({ open_task_count: 2, backlog: null });
      const elsewhereProject = await handedOff();
      const [foreign] = await file(elsewhereProject.project.id, ['A task on another project']);
      const withdrawn = await file(id, ['Archived work', 'Cancelled work', 'Failed work', 'Completed work']);
      ['archived', 'cancelled', 'failed', 'completed'].forEach((status, index) => raw.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, withdrawn[index]));
      const current = await read(id);
      // Withdrawn and finished tasks are not open work.
      expect(current.open_task_count).toBe(2);
      const unknown = crypto.randomUUID();
      const refused = await record(current, { status: 'existing', task_ids: [before1, unknown, foreign, ...withdrawn] });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'INTAKE_BACKLOG_TASK_UNKNOWN', task_ids: [unknown, foreign, ...withdrawn] });
      expect(refused.body.problems.map(entry => entry.problem)).toEqual(['not a task on this project', 'not a task on this project',
        'the task is archived, so it is not backlog', 'the task is cancelled, so it is not backlog', 'the task is failed, so it is not backlog', 'the task is completed, so it is not open work for the next step']);
      for (const shape of [{ task_ids: [] }, {}, { task_ids: [before1], proposals: plan() }, { task_ids: [before1], remaining: [body(2)] }, { task_ids: [before1], covers: [{ slot: 1, task_id: before2 }] }]) {
        const invalid = await record(current, { status: 'existing', ...shape });
        expect(invalid.status).toBe(400);
        expect(invalid.body.code).toBe('INVALID_INTAKE');
      }
      // A generated receipt cannot name them either, except finished work, which did deliver.
      expect((await record(current, { status: 'generated', task_ids: [before1, withdrawn[1], withdrawn[2]] })).body).toMatchObject({ code: 'INTAKE_BACKLOG_TASK_UNKNOWN', task_ids: [withdrawn[1], withdrawn[2]] });
      expect((await record(current, { status: 'generated' })).body.code).toBe('INVALID_INTAKE');
      await untouched(current, 6);
      const result = await record(current, { status: 'existing', task_ids: [before1, before2, before1] });
      expect(result.status).toBe(200);
      expect(result.body.backlog).toMatchObject({ status: 'existing', task_ids: [before1, before2], proposals: [], remaining: [] });
      expect(rows(id)).toHaveLength(6);
      expect(result.body.open_task_count).toBe(2);
    });

    test('tasks filed since acceptance that no receipt names stop a second backlog; older tasks never do', async () => {
      const p = await prepared(), id = p.project.id;
      const [older] = await file(id, ['Filed before acceptance']);
      await settle(); // "at or after acceptance" is to the millisecond, so this one has to be clearly earlier
      const accepted = await accept(p);
      const filed = await file(id, ['Filed after acceptance 1', 'Filed after acceptance 2', 'Filed after acceptance 3']);
      const [cancelled] = await file(id, ['Filed after acceptance, then cancelled']);
      raw.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(cancelled);
      const current = await read(id);
      const refused = await record(current, { status: 'generated', proposals: plan() });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'INTAKE_BACKLOG_UNRECORDED_TASKS', task_ids: filed });
      await untouched(current, 5);
      // Naming only some of them is not enough to file more beside the rest.
      expect((await record(current, { status: 'generated', task_ids: filed.slice(0, 2), proposals: plan() })).body).toMatchObject({ code: 'INTAKE_BACKLOG_UNRECORDED_TASKS', task_ids: [filed[2]] });
      // Recording them creates nothing.
      const recorded = await record(current, { status: 'generated', task_ids: filed });
      expect(recorded.status).toBe(200);
      expect(recorded.body.backlog).toMatchObject({ status: 'generated', task_ids: filed, proposals: [] });
      expect(rows(id)).toHaveLength(5);
      // The task that predates acceptance and the cancelled one block nothing: more work can be filed beside the recorded ids.
      const more = await record(recorded.body, { status: 'generated', supersedes: recorded.body.backlog.operation_id, task_ids: filed, proposals: [body(1, { dependencies: [filed[0]] })] });
      expect(more.status).toBe(200);
      expect(more.body.backlog.task_ids).toEqual([...filed, rows(id).at(-1).id]);
      expect(more.body.backlog.task_ids).not.toContain(older);
      expect(accepted.open_task_count).toBe(1);
      expect(more.body.open_task_count).toBe(5);
    });

    test('created tasks carry the caller\'s source claim, capped below operator authorship', async () => {
      const claimed = await handedOff(), capped = await handedOff();
      expect((await record(claimed, { status: 'generated', proposals: [body(1)], source: 'goal-regression' })).status).toBe(200);
      const warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
      let cappedResult, warned;
      try { cappedResult = await record(capped, { status: 'generated', proposals: [body(1)], source: 'operator:chat' }); }
      finally { warned = warnings.mock.calls.map(call => call.join(' ')).join('\n'); warnings.mockRestore(); }
      expect(cappedResult.status).toBe(200);
      expect(warned).toContain('Refused operator-authorship claim "operator:chat"');
      expect(rows(claimed.project.id).map(row => row.source)).toEqual(['goal-regression']);
      expect(rows(capped.project.id).map(row => row.source)).toEqual(['nexus-api']);
    });

    test('the shared contract types the receipt and the operation, and partial is never an input', () => {
      const { ProjectIntakeOperationSchema, IntakeBacklogReceiptSchema, IntakeHandoffSummarySchema } = require('@praxis/contract');
      const envelope = { operation_id: 'op-1', expected_revision: 3, action: 'record_backlog' };
      expect(ProjectIntakeOperationSchema.safeParse({ ...envelope, status: 'generated', proposals: plan() }).success).toBe(true);
      expect(ProjectIntakeOperationSchema.safeParse({ ...envelope, status: 'partial', proposals: plan() }).success).toBe(false);
      expect(ProjectIntakeOperationSchema.safeParse({ ...envelope, status: 'generated', proposals: plan(), dispatch: true }).success).toBe(false);
      expect(Object.keys(IntakeBacklogReceiptSchema.shape).sort()).toEqual(['at', 'brief_revision', 'operation_id', 'proposals', 'reason', 'remaining', 'replayed', 'source_ref', 'status', 'supersedes', 'task_ids']);
      expect(Object.keys(IntakeHandoffSummarySchema.shape).sort()).toEqual(['backlog', 'open_task_count']);
    });
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
    const accepted = await op(result.body, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: 1 });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance.review_disposition).toBe('preparation_only');
    expect(accepted.body.intake.review_history).toEqual(result.body.intake.review_history);
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
    const accepted = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance.review_disposition).toBe('stale');
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

  test.each(['status/', 'STATUS', 'readme/', 'README', 'commits/', 'COMMITS', 'diff/', 'DIFF'])('Express-equivalent read path %s cannot use an absent workspace', async route => {
    const p = (await create()).body;
    const result = await request(`/${p.project.id}/${route}`, null, 'GET');
    expect(result.status).toBe(409); expect(result.body.code).toBe('WORKSPACE_UNAVAILABLE');
  });

  test.each(['git/init/', 'GIT/INIT', 'Git/Init/', 'context/sync/', 'CONTEXT/SYNC', 'Context/Sync/'])('Express-equivalent write path %s can perform requested work in an attached intake folder', async route => {
    const folder = path.join(dir, crypto.randomUUID()); fs.mkdirSync(folder);
    const p = (await create({ existing_path: folder })).body;
    const result = await request(`/${p.project.id}/${route}`, {});
    expect(result.status).toBe(200);
    expect(fs.existsSync(path.join(folder, route.toLowerCase().startsWith('git/') ? '.git' : 'requested-context-write'))).toBe(true);
  });

  test('workspace identity stays protected until an explicit rebind adopts a retargeted symlink', async () => {
    const a = path.join(dir, crypto.randomUUID()), b = path.join(dir, crypto.randomUUID()), alias = path.join(dir, crypto.randomUUID());
    fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, 'dir');
    const p = (await create({ existing_path: alias })).body;
    fs.unlinkSync(alias); fs.symlinkSync(b, alias, 'dir');
    expect((await request(`/${p.project.id}/readme`, null, 'GET')).status).toBe(409);
    expect((await request(`/${p.project.id}/git/init`, {})).status).toBe(409);
    expect(fs.readdirSync(a)).toEqual([]); expect(fs.readdirSync(b)).toEqual([]);
    const rebound = await op(p, 'attach_workspace', { existing_path: alias, source_ref: 'chat:moved-folder' });
    expect(rebound.status).toBe(200);
    expect(rebound.body.intake.workspace.canonical_path).toBe(fs.realpathSync(b));
    expect(rebound.body.intake.workspace_history.at(-1)).toMatchObject({ previous: p.intake.workspace, next: rebound.body.intake.workspace, source_ref: 'chat:moved-folder' });
    expect(fs.readdirSync(a)).toEqual([]); expect(fs.readdirSync(b)).toEqual([]);
  });

  test.each([false, true])('explicit workspace rebinding after handoff=%s records history and preserves missing targets', async handedOff => {
    const a = path.join(dir, crypto.randomUUID()), b = path.join(dir, crypto.randomUUID());
    fs.mkdirSync(a); fs.mkdirSync(b); fs.writeFileSync(path.join(a, 'source.txt'), 'keep');
    let p = (await create({ existing_path: a })).body;
    if (handedOff) {
      const accepted = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision });
      expect(accepted.status).toBe(200);
      p = accepted.body;
    }
    await expect(db.updateProject(p.project.id, { path: b })).rejects.toMatchObject({ code: 'INTAKE_WORKSPACE_GUARD' });
    const operation_id = crypto.randomUUID();
    const rebound = await op(p, 'attach_workspace', { existing_path: b, operation_id });
    expect(rebound.status).toBe(200);
    expect(rebound.body.project).toMatchObject({ id: p.project.id, path: b, phase: p.project.phase });
    expect(rebound.body.intake.workspace_history).toEqual([{ previous: p.intake.workspace, next: rebound.body.intake.workspace, operation_id, at: rebound.body.project.updated_at }]);
    expect(fs.readdirSync(a)).toEqual(['source.txt']); expect(fs.readdirSync(b)).toEqual([]);
    expect((await op(p, 'attach_workspace', { existing_path: b, operation_id })).body).toEqual(rebound.body);
    expect((await op(p, 'attach_workspace', { existing_path: a })).status).toBe(409);
    const missing = path.join(dir, crypto.randomUUID());
    const absent = await op(rebound.body, 'attach_workspace', { existing_path: missing });
    expect(absent.status).toBe(200);
    expect(absent.body.intake.workspace).toEqual({ state: 'unavailable', path: missing });
    expect(absent.body.intake.workspace_history).toHaveLength(2);
    expect(fs.existsSync(missing)).toBe(false);
    expect((await request(`/${p.project.id}/git/init`, {})).body.code).toBe('WORKSPACE_UNAVAILABLE');
  });

  test('handoff records missing need plans after endpoint adoption reopens verified knowledge', async () => {
    const id = crypto.randomUUID(), name = crypto.randomUUID();
    await db.upsertProject({ id, name, path: '', end_state: 'Old outcome', end_state_criteria: [{ id: 'old-criterion', kind: 'manual', description: 'Old proof' }] });
    const saved = db.updateProjectNeed(id, null, { ...need('old', 'research'), knowledge: { ...need('old', 'research').knowledge, blocking: true, criterion_ids: ['old-criterion'], resolution: { method: 'research' } } });
    const needId = saved.need.id;
    db.updateProjectNeed(id, needId, { expected_knowledge_revision: 1, knowledge: { answer: 'Prior finding', evidence: [{ ref: 'file:prior-proof' }] } });
    db.updateProjectNeed(id, needId, { expected_knowledge_revision: 2, status: 'met', knowledge: { verification: { rationale: 'Prior proof satisfied old criterion', evidence_refs: ['file:prior-proof'] } } });
    let p = (await create({ project_id: id, name })).body;
    p = (await op(p, 'prepare', { brief })).body;
    p = (await op(p, 'start')).body;
    p = (await op(p, 'request_review', { session_id: 'council:adopt', brief_revision: p.intake.brief_revision })).body;
    p = (await op(p, 'record_review', { session_id: 'council:adopt', brief_revision: p.intake.brief_revision, source_ref: 'council:adopted-result', findings: [] })).body;
    const result = await op(p, 'accept', { source_ref: 'chat:accept', next_step: 'Plan', brief_revision: p.intake.brief_revision });
    expect(result.status).toBe(200);
    expect(result.body.intake.acceptance.readiness_gaps).toEqual(expect.arrayContaining([expect.stringContaining(needId)]));
    expect(result.body.project.needs[0]).toMatchObject({ status: 'open', knowledge: { answer: 'Prior finding', resolution: { method: 'research' } } });
    expect(result.body.project.needs[0].knowledge.history.at(-1).verification).toBeDefined();
    expect((await request(`/${id}/intake`, null, 'GET')).body).toEqual(result.body);
  });

  test('a mistyped intake project id never triggers project-manager filesystem healing', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', typo = 'baaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name = crypto.randomUUID();
    const folder = path.join(dir, crypto.randomUUID()); fs.mkdirSync(folder);
    const original = JSON.stringify({ id: 'original-folder-id', name: 'Existing folder' });
    fs.writeFileSync(path.join(folder, 'project.json'), original);
    raw.prepare('INSERT INTO projects(id,name,path) VALUES (?,?,?)').run(id, name, folder);
    expect((await create({ project_id: id, name })).status).toBe(201);
    const result = await request(`/${typo}/git/init`, {});
    expect(fs.readFileSync(path.join(folder, 'project.json'), 'utf8')).toBe(original);
    expect(fs.readdirSync(folder)).toEqual(['project.json']);
    expect(result.status).toBe(404);
  });

  test.each(['unavailable', 'retargeted'])('canonical reservations survive an %s alias for create and attach', async state => {
    const a = path.join(dir, crypto.randomUUID()), b = path.join(dir, crypto.randomUUID()), alias = path.join(dir, crypto.randomUUID());
    fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, 'dir');
    expect((await create({ existing_path: alias })).status).toBe(201);
    fs.unlinkSync(alias); if (state === 'retargeted') fs.symlinkSync(b, alias, 'dir');
    const duplicate = await create({ existing_path: a });
    expect(duplicate.status).toBe(409); expect(duplicate.body.code).toBe('PROJECT_PATH_CONFLICT');
    const sameAlias = await create({ existing_path: alias });
    expect(sameAlias.status).toBe(409);
    const independent = (await create()).body;
    const attached = await op(independent, 'attach_workspace', { existing_path: a });
    expect(attached.status).toBe(409); expect(attached.body.code).toBe('PROJECT_PATH_CONFLICT');
    expect((await request(`/${independent.project.id}/intake`, null, 'GET')).body).toEqual(independent);
  });

  test('legacy create honors an intake canonical reservation held through another folder name', async () => {
    const name = crypto.randomUUID(), target = path.join(dir, name), alias = path.join(dir, crypto.randomUUID());
    fs.mkdirSync(target); fs.symlinkSync(target, alias, 'dir');
    const git = (...args) => require('child_process').execFileSync('git', args, { cwd: target, stdio: 'pipe' });
    git('init'); git('-c', 'user.name=Intake Test', '-c', 'user.email=intake@example.test', 'commit', '--allow-empty', '-m', 'Existing baseline');
    const bound = (await create({ existing_path: alias })).body;
    const result = await request('', { name });
    expect(result.status).toBe(409); expect(result.body.code).toBe('PROJECT_PATH_CONFLICT');
    expect(raw.prepare('SELECT id FROM projects WHERE name=?').get(name)).toBeUndefined();
    expect((await request(`/${bound.project.id}/intake`, null, 'GET')).body).toEqual(bound);
  });

  test('scanner and generic database writers cannot duplicate an intake canonical binding', async () => {
    const folderName = crypto.randomUUID(), folder = path.join(dir, folderName);
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'package.json'), '{}');
    const p = (await create({ name: `Human ${crypto.randomUUID()}`, existing_path: `${folder}/.` })).body;
    expect((await db.getProjectByPath(folder))?.id).toBe(p.project.id);
    await expect(db.upsertProject({ name: crypto.randomUUID(), path: folder })).rejects.toMatchObject({ status: 409, code: 'PROJECT_PATH_CONFLICT' });
    const unrelated = await db.upsertProject({ name: crypto.randomUUID(), path: '' });
    await expect(db.updateProject(unrelated.id, { path: folder })).rejects.toMatchObject({ status: 409, code: 'PROJECT_PATH_CONFLICT' });
    await require('../utils/project-manager').scanProjects(dir);
    expect(raw.prepare('SELECT id FROM projects WHERE name=?').get(folderName)).toBeUndefined();
    expect((await request(`/${p.project.id}/intake`, null, 'GET')).body).toEqual(p);
  });

  // Intake stages 5 to 7: the council proposes the project plan, Robert approves it, and the
  // approved checkpoints are recorded on the project.
  const plan = {
    checkpoints: [
      { title: 'Pilot loan', goal: 'One neighbor borrows and returns a tool.', reached_when: 'A completed loan is on the ledger.', command: 'npm test -- ledger' },
      { title: 'Ten households', goal: 'Ten households lend or borrow each month.', reached_when: 'Robert counts ten active households in the ledger.', proposed_command_criterion: { command: 'node scripts/count-households.js --min 10', description: 'Counts active households', rationale: 'Nothing checks participation yet' } },
    ],
    stages: [{ name: 'Build the ledger', description: 'What: a loan ledger. Why: the pilot needs a record.', goal: 'A ledger that records a loan and its return.', acceptance_criteria: ['Run `npm test -- ledger`. Expected: exit code 0.'] }],
  };
  const reviewedWith = async (rest = {}) => {
    let p = (await op(await prepared(), 'start')).body;
    p = (await op(p, 'request_review', { session_id: `council:${crypto.randomUUID()}`, brief_revision: p.intake.brief_revision })).body;
    return op(p, 'record_review', { session_id: p.intake.review.session_id, brief_revision: p.intake.brief_revision, source_ref: 'council:result', findings: [], ...rest });
  };

  test('a usable review saves the proposed plan; failed, seatless and preparation results cannot', async () => {
    const reviewed = await reviewedWith({ plan });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.intake).toMatchObject({ state: 'ready_for_decision', review: { status: 'completed', plan } });
    const partial = await reviewedWith({ plan, status: 'partial', participation: { substantive_seats: 1, total_seats: 3 } });
    expect(partial.status).toBe(200);
    expect(partial.body.intake.review).toMatchObject({ status: 'partial', plan, participation: { substantive_seats: 1, total_seats: 3 } });
    for (const rest of [{ status: 'failed' }, { status: 'partial' }, { status: 'partial', participation: { substantive_seats: 0, total_seats: 3 } }]) {
      const refused = await reviewedWith({ plan, ...rest });
      expect(refused.status).toBe(400); expect(refused.body.error).toMatch(/cannot propose a project plan/);
    }
    const failed = await reviewedWith({ status: 'failed', findings: [{ summary: 'Council could not complete', disposition: 'revise_proposal' }] });
    expect(failed.status).toBe(200); expect(failed.body.intake.review.plan).toBeUndefined();
    let p = await prepared();
    p = (await op(p, 'request_review', { mode: 'preparation', source_ref: 'chat:prepare', session_id: 'council:prep-plan', brief_revision: p.intake.brief_revision })).body;
    const preparation = await op(p, 'record_review', { session_id: 'council:prep-plan', brief_revision: p.intake.brief_revision, source_ref: 'council:result', findings: [], plan });
    expect(preparation.status).toBe(400); expect(preparation.body.error).toMatch(/Only a review council proposes the project plan/);
  });

  test('acceptance records which plan Robert approved and record_checkpoints records exactly its checkpoints', async () => {
    const reviewed = (await reviewedWith({ plan })).body;
    const accept = (snapshot, rest = {}) => op(snapshot, 'accept', { source_ref: 'chat:approve-plan', next_step: 'Build the ledger', brief_revision: snapshot.intake.brief_revision, ...rest });
    const accepted = await accept(reviewed, { plan });
    expect(accepted.status).toBe(200);
    expect(accepted.body.intake.acceptance.plan).toEqual({ ...plan, basis: 'council', council_session_id: reviewed.intake.review.session_id });
    // Approval alone records no checkpoint and files nothing.
    expect(accepted.body.project.checkpoints ?? null).toBeNull();
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(reviewed.project.id).n).toBe(0);

    const input = { operation_id: crypto.randomUUID(), expected_revision: accepted.body.intake.revision, action: 'record_checkpoints' };
    const recorded = await request(`/${reviewed.project.id}/intake/operations`, input);
    expect(recorded.status).toBe(200);
    const items = recorded.body.project.checkpoints.items;
    expect(items.map(cp => [cp.title, cp.goal, cp.status])).toEqual(plan.checkpoints.map(cp => [cp.title, cp.goal, 'pending']));
    expect(items[0].criteria).toEqual([expect.objectContaining({ kind: 'command', command: 'npm test -- ledger', description: plan.checkpoints[0].reached_when, source: 'chat:approve-plan' })]);
    // No runnable check: Robert judges it, and the proposed command stays a proposal on the plan.
    expect(items[1].criteria).toEqual([expect.objectContaining({ kind: 'manual', description: plan.checkpoints[1].reached_when })]);
    expect(JSON.stringify(items[1])).not.toContain('count-households');
    expect(recorded.body.intake.acceptance.plan.checkpoints_recorded).toMatchObject({ operation_id: input.operation_id, checkpoint_ids: items.map(cp => cp.id) });
    expect(recorded.body.intake.acceptance).toMatchObject({ source_ref: 'chat:approve-plan', plan: { basis: 'council', checkpoints: plan.checkpoints, stages: plan.stages } });
    expect(raw.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(reviewed.project.id).n).toBe(0);
    // An identical retry replays; a second recording is refused and changes nothing.
    expect((await request(`/${reviewed.project.id}/intake/operations`, input)).body).toEqual(recorded.body);
    const again = await op(recorded.body, 'record_checkpoints');
    expect(again.status).toBe(409); expect(again.body.code).toBe('INTAKE_CHECKPOINTS_RECORDED');
    expect((await request(`/${reviewed.project.id}/intake`, null, 'GET')).body.project.checkpoints).toEqual(recorded.body.project.checkpoints);

    // The plan as Robert changed it, and his own plan when no council plan is current.
    const changed = { ...plan, checkpoints: [plan.checkpoints[0]] };
    const second = (await reviewedWith({ plan })).body;
    expect((await accept(second, { plan: changed })).body.intake.acceptance.plan).toEqual({ ...changed, basis: 'council_changed', council_session_id: second.intake.review.session_id });
    const own = (await op(await prepared(), 'start')).body;
    expect((await accept(own, { plan: changed })).body.intake.acceptance.plan).toEqual({ ...changed, basis: 'operator' });
  });

  test('record_checkpoints is refused, and writes nothing, without an approved plan on record', async () => {
    const unchanged = async (snapshot) => {
      const now = (await request(`/${snapshot.project.id}/intake`, null, 'GET')).body;
      expect(now.intake).toEqual(snapshot.intake);
      expect(now.project.checkpoints ?? null).toBeNull();
      expect(raw.prepare('SELECT count(*) AS n FROM project_intake_operations WHERE project_id=?').get(snapshot.project.id).n).toBe(snapshot.intake.operations.length);
    };
    // No approval at all, at the point where the council's plan is waiting for Robert.
    const reviewed = (await reviewedWith({ plan })).body;
    const early = await op(reviewed, 'record_checkpoints');
    expect(early.status).toBe(409); expect(early.body.code).toBe('INTAKE_PLAN_NOT_APPROVED');
    await unchanged(reviewed);
    // Approved, but without a plan: the council's unapproved plan is not recorded either.
    const accepted = (await op(reviewed, 'accept', { source_ref: 'chat:approve', next_step: 'Plan', brief_revision: reviewed.intake.brief_revision })).body;
    expect(accepted.intake.acceptance.plan).toBeUndefined();
    const planless = await op(accepted, 'record_checkpoints');
    expect(planless.status).toBe(409); expect(planless.body.code).toBe('INTAKE_PLAN_NOT_APPROVED');
    await unchanged(accepted);
    // The operation carries no checkpoint content of its own.
    const smuggled = await op(accepted, 'record_checkpoints', { checkpoints: plan.checkpoints });
    expect(smuggled.status).toBe(400);
    await unchanged(accepted);
  });

  test('record_checkpoints never replaces a checkpoint plan the project already has', async () => {
    const reviewed = (await reviewedWith({ plan })).body;
    const accepted = (await op(reviewed, 'accept', { source_ref: 'chat:approve-plan', next_step: 'Build', brief_revision: reviewed.intake.brief_revision, plan })).body;
    const existing = await request(`/${reviewed.project.id}`, { checkpoints: [{ title: 'Robert set this', goal: 'His own checkpoint', criteria: [{ kind: 'manual', description: 'Robert accepts it' }] }], expected_checkpoints_revision: null }, 'PATCH');
    expect(existing.status).toBe(200);
    const current = (await request(`/${reviewed.project.id}/intake`, null, 'GET')).body;
    const refused = await op(current, 'record_checkpoints');
    expect(refused.status).toBe(409); expect(refused.body.code).toBe('INTAKE_CHECKPOINTS_EXIST');
    const after = (await request(`/${reviewed.project.id}/intake`, null, 'GET')).body;
    expect(after.project.checkpoints.items.map(cp => cp.title)).toEqual(['Robert set this']);
    expect(after.intake.acceptance).toEqual(accepted.intake.acceptance);
  });

});
