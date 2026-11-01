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

});
