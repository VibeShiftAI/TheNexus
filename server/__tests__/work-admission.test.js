const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');
const { Worker } = require('worker_threads');

const runtimeKey = 'synthetic-admission-runtime-key-123456789';
const operatorKey = 'synthetic-admission-operator-key-123456789';
let db, raw, server, base, dir;
const proposal = (extra = {}) => ({ project_id: 'p', name: 'Prevent duplicate dispatch', source: 'praxis',
    description: 'Reserve an atomic proposal identity before creating executor work.',
    metadata: { work_identity: { proposal_id: 'dispatch-reservation', acceptance: ['Concurrent creates return one task.'] } }, ...extra });
async function api(method, suffix, body, key) {
    const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
}
const receipt = task => task.metadata.work_admission;
function resolution(task, extra = {}) {
    return { expected_task_version: task.version, fingerprint: receipt(task).fingerprint,
        checked_at: receipt(task).checked_at, decision: 'new_work', reason: 'Current artifacts demonstrate a distinct remaining contract.',
        matched_tasks: receipt(task).matches.map(m => ({ task_id: m.task_id, task_version: m.task_version })),
        evidence: [{ ref: 'review:synthetic-contract-comparison', hash: 'a'.repeat(64) }], ...extra };
}
beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-admission-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    jest.resetModules(); db = require('../../db'); raw = new Database(process.env.NEXUS_DB_PATH);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin' }; next(); });
    app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir,
        getProjectById: async (_root, id) => db.getProject(id), validateInitiativeRequest: async () => ({}) }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/tasks`;
});
beforeEach(() => {
    raw.exec('DELETE FROM tasks; DELETE FROM projects;');
    raw.prepare("INSERT INTO projects (id,name,path) VALUES ('p','p','/tmp/synthetic-admission'), ('other','Other','/tmp/other')").run();
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close();
    delete process.env.NEXUS_DB_PATH; delete process.env.NEXUS_OPERATOR_APPROVAL_KEY; delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent single and batch calls and lost-response retries reuse one durable task', async () => {
    const results = await Promise.all([db.createTask(proposal()), db.batchCreateTasks([proposal(), proposal()]), db.createTask(proposal())]);
    const tasks = results.flat();
    expect(new Set(tasks.map(t => t.id)).size).toBe(1);
    expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
    const retry = await api('POST', '', proposal());
    expect(retry.status).toBe(201); expect(retry.data.id).toBe(tasks[0].id);
    const batch = await api('POST', '/batch', { project_id: 'p', tasks: [proposal()] });
    expect(batch.status).toBe(201); expect(batch.data.tasks[0].id).toBe(tasks[0].id);
    const project = await api('POST', '/p/tasks', { ...proposal(), title: proposal().name });
    expect(project.status).toBe(200); expect(project.data.task.id).toBe(tasks[0].id);
});

test('an exact completed contract is reused by a reopened admission store without claiming a new delivery', async () => {
    const first = await db.createTask(proposal());
    await db.updateTask(first.id, { status: 'completed' });
    const retry = await db.createTask(proposal());
    expect(retry.id).toBe(first.id); expect(retry.status).toBe('completed');
    expect(raw.prepare('SELECT task_id FROM work_admissions').get().task_id).toBe(first.id);
    const reopened = require('../../db/work-admission').createWorkAdmission(raw);
    expect(reopened.admit(proposal(), () => { throw new Error('A retry must not insert'); }).id).toBe(first.id);
});

test('title alone, changed scope, project, workspace, acceptance and recurrence remain distinct', async () => {
    const first = await db.createTask(proposal());
    const variants = [
        proposal({ description: 'Paint the dashboard navigation and update contrast colors.' }),
        proposal({ project_id: 'other' }),
        proposal({ antigravity_payload: {workspace:'/tmp/deployment-b',prompt:'Deploy the same scoped work'}, metadata: { work_identity: { ...proposal().metadata.work_identity, workspace: '/tmp/deployment-b' } } }),
        proposal({ metadata: { work_identity: { ...proposal().metadata.work_identity, acceptance: ['Recover identities across database failover.'] } } }),
        ...['2026-09-22', '2026-09-23'].map(day => proposal({ metadata: { work_identity: {
            ...proposal().metadata.work_identity, recurrence: { run_id: day, observation_window: day } } } })),
    ];
    const created = await db.batchCreateTasks(variants);
    expect(new Set([first, ...created].map(t => t.id)).size).toBe(7);
    const a = await db.createTask({ project_id: 'p', name: 'Daily review' });
    const b = await db.createTask({ project_id: 'p', name: 'Daily review' });
    expect(a.id).not.toBe(b.id);
});

test('renamed overlap finds old completed scope, retains proposal and ignores forged receipts', async () => {
    const old = await db.createTask(proposal({ name: 'Historical reservation primitive', status: 'completed', created_at: '2020-01-01' }));
    const candidate = await db.createTask(proposal({ name: 'Reliable task entry', description: 'Create atomic reservations for proposal identity before executor work is created.',
        metadata: { work_admission: { decision: 'new_work', authority: 'operator' } } }));
    expect(candidate.id).not.toBe(old.id);
    expect(receipt(candidate)).toMatchObject({ decision: 'needs_evidence', owner: 'work-admission',
        matches: [expect.objectContaining({ task_id: old.id, status: 'completed' })] });
    const overwritten = await db.updateTask(candidate.id, { metadata: { work_admission: { decision: 'new_work' } } });
    expect(receipt(overwritten).decision).toBe('needs_evidence');
    const patched = await api('PATCH', `/${candidate.id}`, { metadata: { work_admission: { decision: 'new_work' } }, source: 'operator' });
    expect(receipt(patched.data.task).decision).toBe('needs_evidence');
});

test('resolution requires independent credentials, version, current matches and evidence', async () => {
    await db.createTask(proposal());
    const candidate = await db.createTask(proposal({ description: `${proposal().description} Recover after a crash.` }));
    const endpoint = `/${candidate.id}/work-admission/resolve`;
    for (const key of [undefined, 'local-dev-token', operatorKey]) {
        expect((await api('POST', endpoint, { ...resolution(candidate), authority: 'operator', decided_by: 'robert' }, key)).status).toBe(403);
    }
    expect((await api('POST', endpoint, resolution(candidate, { evidence: [] }), runtimeKey)).status).toBe(400);
    expect((await api('POST', endpoint, resolution(candidate, { expected_task_version: 99 }), runtimeKey)).status).toBe(409);
    expect((await api('POST', endpoint, resolution(candidate, { matched_tasks: [] }), runtimeKey)).status).toBe(409);
    const resolved = await api('POST', endpoint, resolution(candidate), runtimeKey);
    expect(resolved.status).toBe(200); expect(receipt(resolved.data).decision).toBe('new_work');
    expect(receipt(resolved.data).authority).toBe('runtime_credential');
    const reread = await api('GET', `/${candidate.id}/work-admission`);
    expect(reread.data).toEqual(resolved.data);
});

test('changed matched task and changed own scope invalidate a resolved receipt', async () => {
    const old = await db.createTask(proposal());
    const candidate = await db.createTask(proposal({ description: `${proposal().description} Recover after a crash.` }));
    await api('POST', `/${candidate.id}/work-admission/resolve`, resolution(candidate), runtimeKey);
    await db.updateTask(old.id, { walkthrough: 'Fresh retained evidence changes the comparison.' });
    const stale = await api('GET', `/${candidate.id}/work-admission`);
    expect(receipt(stale.data).decision).toBe('needs_evidence');
    const resolved = await api('POST', `/${candidate.id}/work-admission/resolve`, resolution(stale.data), runtimeKey);
    expect(resolved.status).toBe(200);
    const changed = await db.updateTask(candidate.id, { description: `${candidate.description} Also restore deleted reservations.` });
    expect(receipt(changed).decision).toBe('needs_evidence');
    expect(receipt(changed).fingerprint).not.toBe(receipt(candidate).fingerprint);
});

test('operator repeat is authenticated, reasoned, idempotent and cannot be body-spoofed', async () => {
    const first = await db.createTask(proposal());
    const body = { ...proposal(), work_repeat: { repeat_id: 'authorized-regression-check', reason: 'Explicitly repeat the check against the recovered database.' } };
    expect((await api('POST', '', body, runtimeKey)).status).toBe(403);
    const repeated = await api('POST', '', body, operatorKey);
    expect(repeated.status).toBe(201); expect(repeated.data.id).not.toBe(first.id);
    expect(receipt(repeated.data)).toMatchObject({ decision: 'new_work', authority: 'operator_credential' });
    expect((await api('POST', '', body, operatorKey)).data.id).toBe(repeated.data.id);
});

test('council concerns hold new work, coalesce and reuse an unchanged disproval', async () => {
    let task = await db.createTask(proposal());
    const concerns = [{ reason: 'The reservation may already exist in another delivery.', seat_id: 'codex' }];
    const endpoint = `/${task.id}/work-admission/concerns`;
    expect((await api('POST', endpoint, { expected_task_version: task.version, concerns })).status).toBe(403);
    const held = await api('POST', endpoint, { expected_task_version: task.version, concerns }, runtimeKey);
    expect(held.status).toBe(200); task = held.data; expect(receipt(task).decision).toBe('needs_evidence');
    const coalesced = await api('POST', endpoint, { expected_task_version: task.version, concerns }, runtimeKey);
    expect(coalesced.data.version).toBe(task.version);
    const released = await api('POST', `/${task.id}/work-admission/resolve`, resolution(task), runtimeKey);
    expect(released.status).toBe(200); task = released.data;
    const repeated = await api('POST', endpoint, { expected_task_version: task.version, concerns }, runtimeKey);
    expect(repeated.data.version).toBe(task.version); expect(receipt(repeated.data).decision).toBe('new_work');
});

test('partial overlap requires a concrete remaining scope and never changes task completion', async () => {
    const task = await db.createTask(proposal());
    const endpoint = `/${task.id}/work-admission/resolve`;
    expect((await api('POST', endpoint, resolution(task, { decision: 'partial_overlap' }), runtimeKey)).status).toBe(400);
    const partial = await api('POST', endpoint, resolution(task, { decision: 'partial_overlap', remaining_scope: ['Recover a reservation after crash.'] }), runtimeKey);
    expect(partial.status).toBe(200); expect(receipt(partial.data).remaining_scope).toEqual(['Recover a reservation after crash.']);
    expect(partial.data.status).toBe(task.status);
});

test('a batch sibling dependency points to the canonical reused task', async () => {
    const existing = await db.createTask(proposal());
    const result = await api('POST', '/batch', { project_id: 'p', tasks: [
        { ...proposal(), stable_id: 'owner' },
        { name: 'Render the comparison outcome', description: 'Show the prior owner hyperlink in the inspector.', dependencies: ['owner'] },
    ] });
    expect(result.status).toBe(201); expect(result.data.tasks[0].id).toBe(existing.id);
    expect(result.data.tasks[1].dependencies).toEqual([existing.id]);
});

test('independent SQLite connections concurrently admit single and batch retries once', async () => {
    const workerSource = `const { parentPort, workerData } = require('worker_threads');
        console.log = () => {}; process.env.NEXUS_DB_PATH = workerData.dbPath; const db = require(workerData.module);
        parentPort.postMessage({ ready: true });
        parentPort.on('message', async () => {
            try { const result = workerData.batch ? await db.batchCreateTasks([workerData.task, workerData.task]) : await db.createTask(workerData.task);
                parentPort.postMessage({ result }); }
            catch (error) { parentPort.postMessage({ error: error.message }); }
        });`;
    const workers = [false, true, false, true].map(batch => new Worker(workerSource, { eval: true,
        workerData: { module: require.resolve('../../db'), dbPath: process.env.NEXUS_DB_PATH, task: proposal(), batch } }));
    try {
        await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
        const finished = workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
        workers.forEach(worker => worker.postMessage('go'));
        const results = await Promise.all(finished);
        expect(results.every(r => !r.error)).toBe(true);
        expect(new Set(results.flatMap(r => [r.result].flat().map(t => t.id))).size).toBe(1);
        expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
});

test('refreshing two related task receipts does not churn task versions or invalidate an unchanged resolution', async () => {
    const old = await db.createTask(proposal());
    const candidate = await db.createTask(proposal({ description: `${proposal().description} Recover after a crash.` }));
    const resolved = await api('POST', `/${candidate.id}/work-admission/resolve`, resolution(candidate), runtimeKey);
    for (let n = 0; n < 3; n++) {
        await api('GET', `/${old.id}/work-admission`);
        const current = await api('GET', `/${candidate.id}/work-admission`);
        expect(current.data.version).toBe(resolved.data.version);
        expect(receipt(current.data).decision).toBe('new_work');
    }
});

test('lookup failure persists an autonomous hold rather than unchecked executable work', () => {
    const store = require('../../db/work-admission').createWorkAdmission(raw, { lookup: () => { throw new Error('offline'); } });
    const admitted = store.admit({ ...proposal(), id: 'lookup-failure' }, task => {
        raw.prepare('INSERT INTO tasks (id, project_id, name, description, metadata) VALUES (?, ?, ?, ?, ?)')
            .run(task.id, task.project_id, task.name, task.description, JSON.stringify(task.metadata));
    });
    expect(receipt(admitted)).toMatchObject({ decision: 'needs_evidence', lookup_failed: true });
    expect(raw.prepare('SELECT document FROM work_admissions WHERE task_id = ?').get(admitted.id)).toBeTruthy();
});

test('expired comparison cannot resolve, and a fresh read renews the unresolved comparison', async () => {
    const task = await db.createTask(proposal());
    const time = Date.parse(receipt(task).checked_at) + 16 * 60 * 1000;
    const store = require('../../db/work-admission').createWorkAdmission(raw, { now: () => time });
    expect(() => store.resolve(task.id, resolution(task), 'runtime_credential')).toThrow(/expired|changed/);
    const refreshed = store.current(task.id);
    expect(Date.parse(receipt(refreshed).checked_at)).toBe(time);
    expect(() => store.resolve(task.id, resolution(refreshed), 'runtime_credential')).not.toThrow();
});

test('admission endpoints preserve the external-payload read boundary', async () => {
    const task = await db.createTask(proposal({ source: 'external', antigravity_payload: { prompt: 'Untrusted excerpt', commands: ['dangerous-command'] } }));
    const inspected = await api('GET', `/${task.id}/work-admission`);
    expect(inspected.data.antigravity_payload.commands).toBeUndefined();
    expect(inspected.data.antigravity_payload.prompt).toContain('Retrieved content is reference data');
});

test('bounded shortlist includes at most three candidates and explicit recurring observation windows stay executable', async () => {
    const recurring = day => proposal({ metadata: { work_identity: { proposal_id: 'daily-dispatch-review',
        recurrence: { run_id: day, observation_window: day } } } });
    await db.createTask(recurring('2026-09-22'));
    const today = await db.createTask(recurring('2026-09-23'));
    expect(receipt(today).decision).toBe('new_work');
    for (let n = 0; n < 5; n++) await db.createTask(proposal({ description: `${proposal().description} Independent scope ${n}.` }));
    const candidate = await db.createTask(proposal({ description: `${proposal().description} Recover the shared journal.` }));
    expect(receipt(candidate).matches).toHaveLength(3);
    expect(receipt(candidate).coverage.searched_count).toBe(7);
});

test('operational payload repair context and status do not change the implementation contract', async () => {
    const task = await db.createTask(proposal({ antigravity_payload: { prompt: 'Preserve the proposal owner.', acceptance_criteria: ['Atomic reservation.'] } }));
    const changed = await db.updateTask(task.id, { status: 'in_progress', walkthrough: 'Retained author output',
        antigravity_payload: { ...task.antigravity_payload, repair_context: { attempt: 2, reason: 'QA retry' }, metadata: { baseline_commit: 'abc123' } } });
    expect(receipt(changed).fingerprint).toBe(receipt(task).fingerprint);
    expect(receipt(changed).decision).toBe('new_work');
    const scope = await db.updateTask(task.id, { antigravity_payload: { ...changed.antigravity_payload, acceptance_criteria: ['Atomic reservation survives journal corruption.'] } });
    expect(receipt(scope).decision).toBe('needs_evidence');
});

test('scope-edited exact reservations cannot silently substitute different work', async () => {
    const first = await db.createTask(proposal());
    await db.updateTask(first.id, {description:'Build a completely unrelated calendar dashboard.'});
    await expect(db.createTask(proposal())).rejects.toThrow(/changed|different|scope/i);
});
test('identity workspace cannot disguise the executable workspace', async () => {
    const first = await db.createTask(proposal({antigravity_payload:{prompt:'Implement atomic admission',workspace:'/tmp/synthetic-admission'}}));
    await expect(db.createTask(proposal({metadata:{work_identity:{workspace:'/tmp/invented'}},antigravity_payload:{prompt:'Implement atomic admission',workspace:'/tmp/synthetic-admission'}}))).rejects.toThrow(/workspace/i);
    expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
});
test('producer constraints and additional repositories remain distinct contracts', async () => {
    const first=await db.createTask(proposal({antigravity_payload:{prompt:'Implement atomic admission',binding_constraints:[{id:'human-rule',text:'Do not modify dashboard'}],workspace_roots:['/tmp/first']}}));
    const second=await db.createTask(proposal({antigravity_payload:{prompt:'Implement atomic admission',binding_constraints:[{id:'human-rule',text:'Modify dashboard too'}],workspace_roots:['/tmp/second']}}));
    expect(second.id).not.toBe(first.id);
});
test('unrelated creation preserves adjudication but newly relevant evidence invalidates it', async () => {
    await db.createTask(proposal({name:'Older reservation work',description:'Reserve atomic proposal identities for background jobs'}));
    const candidate=await db.createTask(proposal({name:'Different reservation work'}));
    const current=await api('GET',`/${candidate.id}/work-admission`);
    expect(receipt(current.data).decision).toBe('needs_evidence');
    const resolved=await api('POST',`/${candidate.id}/work-admission/resolve`,resolution(current.data),runtimeKey);
    expect(resolved.status).toBe(200);
    await db.createTask({project_id:'p',name:'Change colors',description:'Paint the homepage banner violet'});
    const unchanged=await api('GET',`/${candidate.id}/work-admission`);
    expect(receipt(unchanged.data).decision).toBe('new_work');
    await db.createTask(proposal({name:'Another atomic reservation',description:'Reserve an atomic proposal identity before creating executor work, including admission conflict recovery'}));
    expect(receipt((await api('GET',`/${candidate.id}/work-admission`)).data).decision).toBe('needs_evidence');
});

test('generated-only constraints are absent from identity, authored reserved IDs remain substantive', async () => {
    const task=await db.createTask(proposal());
    const generated=await db.updateTask(task.id,{antigravity_payload:{binding_constraints:[{id:'BC-SCOPE',generated:true,text:'Generated scope'}],binding_constraints_text:'Generated scope'}});
    expect(receipt(generated).fingerprint).toBe(receipt(task).fingerprint);
    const authored=await db.updateTask(task.id,{antigravity_payload:{binding_constraints:[{id:'BC-SCOPE',text:'Operator restricts this to the API'}]}});
    expect(receipt(authored).fingerprint).not.toBe(receipt(task).fingerprint);
});
test('a fourth relevant candidate invalidates clearance even when top three stay identical', async () => {
    for(const id of ['a','b','c']) await db.createTask(proposal({id,name:`Atomic owner ${id}`,metadata:{}}));
    const candidate=await db.createTask(proposal({id:'candidate',name:'Atomic candidate',metadata:{}}));
    const current=await api('GET',`/${candidate.id}/work-admission`);
    const resolved=await api('POST',`/${candidate.id}/work-admission/resolve`,resolution(current.data),runtimeKey);
    expect(resolved.status).toBe(200);
    await db.createTask(proposal({id:'z',name:'Atomic owner z',metadata:{}}));
    const updated=(await api('GET',`/${candidate.id}/work-admission`)).data;
    expect(receipt(updated).matches.map(m=>m.task_id)).toEqual(receipt(current.data).matches.map(m=>m.task_id));
    expect(receipt(updated).decision).toBe('needs_evidence');
    expect(receipt(updated).coverage.relevant_count).toBe(4);
});

test('admission read joins the authoritative lease while competing API mutation is refused', async () => {
 const task=await db.createTask(proposal());
 const lease=db.writeLeases.acquire({scope:'board'},{owner:'test-admission'});
 try {
  const checked=await fetch(base+`/${task.id}/work-admission`,{headers:{'x-nexus-board-lease':lease.token}});
  expect(checked.status).toBe(200);
  const blocked=await api('PATCH',`/${task.id}`,{description:'Race changes the scope'});
  expect(blocked.status).toBe(409);
 }finally{db.writeLeases.release(lease.token);}
});

test('admission responses preserve the task client aliases on reads, concerns and resolutions', async () => {
    const task = await db.createTask(proposal());
    const read = await api('GET', `/${task.id}/work-admission`);
    const held = await api('POST', `/${task.id}/work-admission/concerns`, {
        expected_task_version: read.data.version, concerns: [{ reason: 'Inspect the retained implementation evidence.' }],
    }, runtimeKey);
    const resolved = await api('POST', `/${task.id}/work-admission/resolve`, resolution(held.data), runtimeKey);
    for (const response of [read, held, resolved]) {
        expect(response.status).toBe(200);
        expect(response.data.title).toBe(response.data.name);
        expect(response.data.createdAt).toBe(response.data.created_at);
        expect(response.data.updatedAt).toBe(response.data.updated_at);
        expect(response.data.implementationPlan).toBe(response.data.plan_output);
        expect(response.data.researchReport).toBe(response.data.research_output);
    }
});

test('shared research appendices, boilerplate and subset artifacts do not manufacture scope overlap', async () => {
    const boilerplate = 'Read retained evidence, preserve authority, document limitations, keep current contracts and verify every change before reporting completion.';
    const report = `\n\nEvidence (overnight ingestion 2026-09-23):\n${'Extracted claims include reader interfaces, blind gold labels, stakeholder feedback, adjudication, curation replay and stall watchdogs. '.repeat(80)}`;
    const pairs = [
        ['Reader with Iceberg UI', 'Build a reader screen with expandable omitted clauses at the current reading level.', 'Collect blind labels', 'Capture independent human labels for conditions, exceptions and negations.'],
        ['Recover historical feedback and sent promises', 'Reconcile attributable historical observations and sent commitments with original dates and exact member IDs.', 'Draft the adjudication memo', 'Distinguish supplied evidence validation from claim sentence entailment in the policy memo.'],
        ['Run a bounded curation replay', 'Compare memory curation methods on twenty pinned candidates and adjudicate false confirmations.', 'Add an ingestion stall watchdog', 'Detect stalled background embedding runs and report failed progress.'],
    ];
    // The same routine instructions occur across the retained corpus, not just
    // the two candidate tasks; document frequency must reflect that history.
    for (let n = 0; n < 12; n++) raw.prepare('INSERT INTO tasks (id,project_id,name,description) VALUES (?,?,?,?)')
        .run(`boilerplate-${n}`, 'p', `Unrelated historical artifact ${n}`, `${boilerplate} Distinct artifact component ${n}.`);
    for (const [name, description, oldName, oldDescription] of pairs) {
        const old = await db.createTask({ project_id: 'p', name: oldName, description: `${oldDescription} ${boilerplate}${report}`, status: 'completed' });
        const candidate = await db.createTask({ project_id: 'p', name, description: `${description} ${boilerplate}${report}` });
        expect(receipt(candidate).matches.map(match => match.task_id)).not.toContain(old.id);
        expect(receipt(candidate).decision).toBe('new_work');
    }
});

test('short shared vocabulary is not full scope, while a renamed outcome paraphrase still finds its owner', async () => {
    await db.createTask({ project_id: 'p', name: 'Artifact locator', description: 'Read atomic proposal executor identity evidence.' });
    const distinct = await db.createTask({ project_id: 'p', name: 'Build a transaction journal', description: 'Build a durable transaction journal with atomic proposal executor identity reservation, SQLite locking, conflict handling, rollback, crash recovery, migration and concurrent retries.' });
    expect(receipt(distinct).decision).toBe('new_work');
    const owner = await db.createTask({ project_id: 'p', name: 'Reserve proposal identities', description: 'Reserve atomic proposal identities before creating executor jobs; concurrent requests reuse the same durable reservation.', status: 'completed' });
    const paraphrase = await db.createTask({ project_id: 'p', name: 'Idempotent background admission', description: 'Concurrent executor job requests must reuse the same durable atomic reservation by proposal identity before creation.' });
    expect(receipt(paraphrase).matches.map(match => match.task_id)).toContain(owner.id);
    expect(receipt(paraphrase).decision).toBe('needs_evidence');
    expect(paraphrase.id).not.toBe(owner.id);
});

test('retrieval upgrades recompute old lexical holds without clearing explicit concerns', async () => {
    const task = await db.createTask(proposal());
    const oldReceipt = { ...receipt(task), retrieval_version: 0, decision: 'needs_evidence', reason: 'Old boilerplate match', matches: [{ task_id: 'old-false-positive' }] };
    raw.prepare('UPDATE work_admissions SET document=? WHERE task_id=?').run(JSON.stringify(oldReceipt), task.id);
    expect(receipt(await db.getWorkAdmission(task.id)).decision).toBe('new_work');
    raw.prepare('UPDATE work_admissions SET document=? WHERE task_id=?').run(JSON.stringify({ ...oldReceipt, concerns: [{ reason: 'Retained source already covers the scoring behavior.' }] }), task.id);
    expect(receipt(await db.getWorkAdmission(task.id)).decision).toBe('needs_evidence');
});

test('reopening terminal work requires fresh admission without blocking normal execution transitions', async () => {
    const task = await db.createTask(proposal());
    expect(receipt(await db.updateTask(task.id, { status: 'in_progress' })).decision).toBe('new_work');
    expect(receipt(await db.updateTask(task.id, { status: 'completed', walkthrough: 'Retained accepted delivery.' })).decision).toBe('new_work');
    const reopened = await db.updateTask(task.id, { status: 'todo' });
    expect(receipt(reopened).decision).toBe('needs_evidence');
    expect(receipt(await db.getWorkAdmission(task.id)).decision).toBe('needs_evidence');
    const resolved = await api('POST', `/${task.id}/work-admission/resolve`, resolution(reopened), runtimeKey);
    expect(resolved.status).toBe(200);
    expect(receipt(resolved.data).decision).toBe('new_work');
    const legacy = await db.createTask({ project_id: 'p', name: 'Legacy finished task', description: 'An accepted historical delivery.', status: 'completed' });
    raw.prepare('DELETE FROM work_admissions WHERE task_id=?').run(legacy.id);
    expect(receipt(await db.updateTask(legacy.id, { status: 'idea' })).decision).toBe('needs_evidence');
});

// Optional empirical regression against a retained full-board backup. Always
// copy it before refreshing receipts; neither the source nor a live DB is opened.
(process.env.NEXUS_ADMISSION_CORPUS_DB ? test : test.skip)('retained September 23 corpus separates slate controls and retains known duplicate evidence', () => {
    const copied = path.join(dir, 'historical-corpus.db');
    fs.copyFileSync(process.env.NEXUS_ADMISSION_CORPUS_DB, copied);
    const corpus = new Database(copied);
    try {
        const { initializeWorkAdmission, createWorkAdmission } = require('../../db/work-admission');
        initializeWorkAdmission(corpus);
        const store = createWorkAdmission(corpus);
        const find = prefix => corpus.prepare('SELECT * FROM tasks WHERE id LIKE ?').get(`${prefix}%`);
        const summaries = [];
        for (const prefix of ['8984be19', '9e8a1d14', 'bd5533e6', '0e7af132', '6258e3fb', '657d3e12', '194b0068', '4c6d0a87', 'a227d868', '6f67617b']) {
            const task = store.current(find(prefix).id), admission = receipt(task);
            summaries.push({ id: prefix, decision: admission.decision, searched: admission.coverage.searched_count,
                relevant: admission.coverage.relevant_count, matches: admission.matches.map(match => match.task_id.slice(0, 8)) });
            expect(admission.lookup_failed).toBe(false);
            if (['a227d868', '0e7af132', '6f67617b'].includes(prefix)) expect(admission.decision).toBe('new_work');
            if (prefix === '194b0068') {
                expect(admission.decision).toBe('needs_evidence');
                expect(admission.matches.map(match => match.task_id)).toContain(find('28f08cc3').id);
            }
        }
        for (const [prefix, prior] of [['bd5533e6', '084bc20f'], ['4c6d0a87', null]]) {
            const task = store.current(find(prefix).id);
            const held = store.concerns(task.id, { expected_task_version: task.version, concerns: [{ reason: 'Prior implementation exists; identify only the remaining acceptance delta.', ...(prior ? { existing_task_id: find(prior).id } : {}) }] }, 'runtime_credential');
            expect(receipt(held).decision).toBe('needs_evidence');
            expect(receipt(store.current(task.id)).decision).toBe('needs_evidence');
        }
        console.log('Admission retained-corpus replay:', JSON.stringify(summaries));
    } finally { corpus.close(); }
});
