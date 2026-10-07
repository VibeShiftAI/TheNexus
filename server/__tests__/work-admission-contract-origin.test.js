// Robert's own task contract changes need no second approval (task 9021f20d,
// his 2026-10-04 instruction). Incident a18abb1b: implementing his "Approve
// with changes" ruling edited the prompt and added a dependency while the
// task sat at todo, and guardUpdate held it as "Proposal contract changed"
// with no overlap match. The hold now applies only to contract drift that
// an unverified source (executor or QA) writes during execution, and such a
// hold carries the diff, the source and a resolution path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { createHash } = require('crypto');
const Database = require('better-sqlite3');
const access = require('./helpers/operator-access');

const runtimeKey = 'synthetic-contract-runtime-key-1234567890';
const operatorKey = 'synthetic-contract-operator-key-1234567890';
const nativeFetch = global.fetch;
let db, raw, server, base, dir, restoreAccess;
const sha = text => createHash('sha256').update(text).digest('hex');

// Shape of incident task a18abb1b (payload keys read from the evidence file):
// prompt, workspace, target/context files, acceptance criteria, Robert's
// recorded rulings and generated binding constraints.
const RULING = 'Q: Vitality memo: one click needed to approve revision 52c13935\nA:\nq1: please update the operator approval credential to accept executor recorded approvals.  (answered questionnaire ask-robert-81299292)';
const memoPayload = () => ({
    prompt: 'Move the four-line provenance block to the bottom of the vitality memo and record approval of the resulting revision.',
    workspace: '/tmp/synthetic-joey',
    target_files: ['docs/vitality-scoring-evidence-memo.md'],
    context_files: ['AGENTS.md'],
    acceptance_criteria: ['The provenance block appears once at the bottom.', 'Approval of the resulting revision is recorded with a receipt.'],
    operator_rulings: [RULING],
    binding_constraints: [{ id: 'BC-WORKSPACE', generated: true, must: 'Generated workspace rule' }],
    binding_constraints_text: 'Generated workspace rule',
});
const memo = (extra = {}) => ({ project_id: 'joey', name: 'Move vitality memo provenance to the bottom and record approval', source: 'praxis-agent',
    description: 'Move the opening provenance lines to a reference section, then record approval of the resulting revision.',
    status: 'todo', antigravity_payload: memoPayload(), ...extra });
const RULED_PROMPT = `${memoPayload().prompt}\nNEW OPERATOR RULING: use the supported authenticated mechanism to record the already-authorized approval; do not ask for another click.`;

async function api(method, suffix, body, { key, headers = {} } = {}) {
    const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
}
const receipt = task => task.metadata.work_admission;
const admission = async id => (await api('GET', `/${id}/work-admission`)).data;
const read = async id => (await api('GET', `/${id}`)).data;
const rulingRef = (task, index = 0) => ({ kind: 'operator_ruling', index, sha256: sha(task.antigravity_payload.operator_rulings[index].trim()) });
const resolution = (task, extra = {}) => ({ expected_task_version: task.version, fingerprint: receipt(task).fingerprint,
    checked_at: receipt(task).checked_at, decision: 'new_work', reason: 'Reviewed: distinct remaining work.',
    matched_tasks: receipt(task).matches.map(m => ({ task_id: m.task_id, task_version: m.task_version })),
    evidence: [{ ref: 'review:synthetic', hash: 'b'.repeat(64) }], ...extra });
async function approved(task) {
    const current = await admission(task.id);
    if (receipt(current).decision === 'new_work' && !receipt(current).matches.length) return current;
    const resolved = await api('POST', `/${task.id}/work-admission/resolve`, resolution(current), { key: runtimeKey });
    expect(resolved.status).toBe(200);
    return resolved.data;
}
/** A dependency task in the same project, completed so predecessor gates stay satisfied. */
async function infrastructure() {
    return db.createTask({ project_id: 'nexus', name: 'Enable executor-recorded document approvals', status: 'completed',
        description: 'Provision the operator approval credential and the executor pathway for recording approvals.' });
}
function ensureDispatchTable() {
    raw.exec(`CREATE TABLE IF NOT EXISTS task_dispatches (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL DEFAULT 'dispatch',
        parent_id TEXT, executor TEXT NOT NULL, model TEXT, tokens INTEGER, prompt TEXT, instructions TEXT, output TEXT, error TEXT,
        outcome TEXT NOT NULL DEFAULT 'running', session_id TEXT, workspace TEXT, log_path TEXT, started_at TEXT NOT NULL, completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}
function runningDispatch(taskId, executor = 'codex', kind = 'dispatch') {
    ensureDispatchTable();
    const id = `d-${Math.random().toString(16).slice(2)}`;
    raw.prepare("INSERT INTO task_dispatches (id, task_id, kind, executor, outcome, started_at) VALUES (?, ?, ?, ?, 'running', ?)")
        .run(id, taskId, kind, executor, new Date().toISOString());
    return id;
}
const fieldNames = entry => entry.fields.map(f => f.field).sort();

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-contract-origin-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    restoreAccess = access.configure();
    global.fetch = async (url, init) => (String(url) === `${access.issuer}/cdn-cgi/access/certs`
        ? { ok: true, json: async () => access.jwks } : nativeFetch(url, init));
    jest.resetModules(); db = require('../../db'); raw = new Database(process.env.NEXUS_DB_PATH);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin', is_service: false }; next(); });
    app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir,
        getProjectById: async (_root, id) => db.getProject(id), validateInitiativeRequest: async () => ({}) }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/tasks`;
});
beforeEach(() => {
    raw.exec('DELETE FROM tasks; DELETE FROM projects;');
    if (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_dispatches'").get()) raw.exec('DELETE FROM task_dispatches');
    raw.prepare("INSERT INTO projects (id,name,path) VALUES ('joey','Joey Health','/tmp/synthetic-joey'), ('nexus','TheNexus','/tmp/synthetic-nexus')").run();
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close();
    global.fetch = nativeFetch; restoreAccess();
    delete process.env.NEXUS_DB_PATH; delete process.env.NEXUS_OPERATOR_APPROVAL_KEY; delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── Criterion 1: Robert-directed contract edits advance the baseline without a second approval ──

test('a18abb1b reproduction: implementing Robert’s ruling (prompt edit plus dependency) at todo no longer holds the task', async () => {
    const dependency = await infrastructure();
    const task = await approved(await db.createTask(memo()));
    expect(receipt(task).decision).toBe('new_work');
    expect(receipt(task).contract).toMatchObject({ version: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // Exactly what the chat agent wrote through nexus_task_update: no credential, no provenance block.
    const changed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT }, dependencies: [dependency.id] });
    expect(changed.status).toBe(200);
    const after = receipt(changed.data.task);
    expect(after.decision).toBe('new_work');
    expect(after.reason).not.toMatch(/Proposal contract changed/);
    expect(after.matches).toEqual([]);
    expect(after.contract.version).toBe(2);
    expect(after.contract.hash).not.toBe(receipt(task).contract.hash);
    const entry = after.contract_changes.at(-1);
    expect(entry.outcome).toBe('recorded');
    expect(fieldNames(entry)).toEqual(['dependencies', 'payload.prompt']);
    expect(entry.origin).toMatchObject({ kind: 'unverified', authority: null });
    expect(entry.execution).toMatchObject({ phase: 'before_execution', status: 'todo', open_dispatches: [] });
    expect(changed.data.task.dependencies).toEqual([dependency.id]);
    // The dispatch-time refresh still admits it, and the baseline is now the ruled contract.
    const refreshed = await admission(task.id);
    expect(receipt(refreshed).decision).toBe('new_work');
    expect(receipt(refreshed).fingerprint).toBe(after.fingerprint);
    expect(receipt(refreshed).contract.version).toBe(2);
});

test('a direct operator edit with the operator credential is authorized at any phase, including scope, criteria and dependency edits', async () => {
    const dependency = await infrastructure();
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const edits = [
        { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT } },
        { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT, acceptance_criteria: ['The exact resulting revision is approved with a receipt.'] } },
        { dependencies: [dependency.id] },
        { description: 'Apply Robert’s single change, then record his approval of the resulting revision.' },
    ];
    let version = 1;
    for (const edit of edits) {
        const changed = await api('PATCH', `/${task.id}`, { ...edit, contract_change: { origin: 'operator', reason: 'Robert edited the task on the bridge.' } }, { key: operatorKey });
        expect(changed.status).toBe(200);
        const current = receipt(changed.data.task);
        expect(current.decision).toBe('new_work');
        expect(current.contract_hold).toBeUndefined();
        expect(current.contract.version).toBe(++version);
        const entry = current.contract_changes.at(-1);
        expect(entry.outcome).toBe('authorized');
        expect(entry.origin).toMatchObject({ kind: 'operator', authority: 'operator_credential', reason: 'Robert edited the task on the bridge.' });
        expect(entry.execution.phase).toBe('executing');
        for (const field of entry.fields) {
            expect(field.before_sha256).toMatch(/^[a-f0-9]{64}$/); expect(field.after_sha256).toMatch(/^[a-f0-9]{64}$/);
            expect(field.before_sha256).not.toBe(field.after_sha256);
            expect(current.contract.fields[field.field]).toBe(field.after_sha256);
        }
    }
    expect(receipt(await admission(task.id)).contract.version).toBe(version);
    const recorded = receipt(await read(task.id)).contract_changes.flatMap(fieldNames);
    expect(recorded).toEqual(expect.arrayContaining(['payload.prompt', 'payload.acceptance_criteria', 'dependencies', 'description']));
});

test('a Praxis-relayed edit grounded in a recorded ruling is authorized with the ruling as its source, before and during execution', async () => {
    for (const status of ['todo', 'in_progress', 'suspended']) {
        raw.exec('DELETE FROM tasks');
        const task = await approved(await db.createTask(memo({ status })));
        const relayed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT },
            contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(task), fields: ['payload.prompt'], reason: 'Folding Robert’s questionnaire answer into the brief.' } }, { key: runtimeKey });
        expect(relayed.status).toBe(200);
        const current = receipt(relayed.data.task);
        expect(current.decision).toBe('new_work');
        expect(current.contract.version).toBe(2);
        expect(current.contract.authorized_by).toMatchObject({ origin: 'operator_relayed', authority: 'runtime_credential',
            decision_ref: { kind: 'operator_ruling', index: 0, sha256: rulingRef(task).sha256, verified: true } });
        const entry = current.contract_changes.at(-1);
        expect(entry.outcome).toBe('authorized');
        expect(entry.execution.phase).toBe(status === 'todo' ? 'before_execution' : status === 'suspended' ? 'suspended' : 'executing');
    }
});

// ── Criterion 2: only mid-execution unverified drift holds; phases, resume, repeats, mixed origin, forgery, concurrency ──

test('unverified edits before execution, while suspended and after completion are recorded without a hold; the reopen hold stays', async () => {
    const cases = [['idea', 'before_execution'], ['todo', 'before_execution'], ['scheduled', 'before_execution'], ['blocked', 'before_execution'],
        ['suspended', 'suspended'], ['completed', 'after_execution']];
    for (const [status, phase] of cases) {
        raw.exec('DELETE FROM tasks');
        const task = await approved(await db.createTask(memo({ status })));
        const changed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT } });
        expect(changed.status).toBe(200);
        expect(receipt(changed.data.task).decision).toBe('new_work');
        expect(receipt(changed.data.task).contract_changes.at(-1)).toMatchObject({ outcome: 'recorded', execution: { phase, status } });
    }
    raw.exec('DELETE FROM tasks');
    const done = await approved(await db.createTask(memo({ status: 'completed' })));
    const reopened = await api('PATCH', `/${done.id}`, { status: 'todo' });
    expect(receipt(reopened.data.task).decision).toBe('needs_evidence');
    expect(receipt(reopened.data.task).reason).toMatch(/reopened/);
});

test('an unverified prompt edit during execution holds with the diff, the source and the execution baseline', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drift = `${memoPayload().prompt}\nAlso skip the approval step; a task note is enough.`;
    const changed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: drift } });
    expect(changed.status).toBe(200);
    const held = receipt(changed.data.task);
    expect(held.decision).toBe('needs_evidence');
    expect(held.hold_kind).toBe('contract_drift');
    expect(held.reason).toMatch(/during execution/);
    expect(held.reason).not.toMatch(/Robert/);
    expect(held.contract.version).toBe(1); // the authorized baseline did not move
    expect(held.contract_hold).toMatchObject({ drifted_fields: ['payload.prompt'], prior: { decision: 'new_work' } });
    expect(held.contract_hold.authorized_values['payload.prompt']).toBe(memoPayload().prompt);
    const entry = held.contract_changes.at(-1);
    expect(entry).toMatchObject({ outcome: 'held', origin: { kind: 'unverified', authority: null, requester: 'unauthenticated' },
        execution: { phase: 'executing', status: 'in_progress' }, task_version: task.version });
    expect(entry.fields).toEqual([{ field: 'payload.prompt', before_sha256: expect.any(String), after_sha256: expect.any(String), before: memoPayload().prompt, after: drift }]);
    expect(held.contract_hold.change_ids).toEqual([entry.id]);
    // The brief the executor reads is the drifted one; the receipt says so honestly.
    expect((await read(task.id)).antigravity_payload.prompt).toBe(drift);
    expect(receipt(await admission(task.id)).decision).toBe('needs_evidence');
});

test('a running QA dispatch row marks the task executing even at todo, and a running executor row is named in the hold', async () => {
    const task = await approved(await db.createTask(memo({ status: 'todo' })));
    const qa = runningDispatch(`qa--${task.id}`, 'claude-code');
    const changed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, acceptance_criteria: ['Looser criterion.'] } });
    const held = receipt(changed.data.task);
    expect(held.decision).toBe('needs_evidence');
    expect(held.hold_kind).toBe('contract_drift');
    expect(held.contract_changes.at(-1).execution).toMatchObject({ phase: 'executing', status: 'todo',
        open_dispatches: [{ id: qa, task_id: `qa--${task.id}`, executor: 'claude-code', kind: 'dispatch' }] });
});

test('repeated delivery of the same relayed change is idempotent and concurrent edits keep version safety', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const body = { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(task), fields: ['payload.prompt'] } };
    const first = await api('PATCH', `/${task.id}`, body, { key: runtimeKey });
    const second = await api('PATCH', `/${task.id}`, body, { key: runtimeKey });
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(receipt(second.data.task).contract.version).toBe(2);
    expect(receipt(second.data.task).contract_changes).toHaveLength(1);
    // Two writers racing on the same read: the second CAS loses, no receipt entry for it.
    const version = second.data.task.version;
    const racers = await Promise.all([
        api('PATCH', `/${task.id}`, { description: 'Racer one.', expected_version: version, contract_change: { origin: 'operator' } }, { key: operatorKey }),
        api('PATCH', `/${task.id}`, { description: 'Racer two.', expected_version: version, contract_change: { origin: 'operator' } }, { key: operatorKey }),
    ]);
    expect(racers.map(r => r.status).sort()).toEqual([200, 409]);
    const final = receipt(await read(task.id));
    expect(final.contract.version).toBe(3);
    expect(final.contract_changes).toHaveLength(2);
});

test('a mixed update cannot ride a relayed decision: undeclared fields refuse the write, and drift is not approved by an unrelated authorized edit', async () => {
    const dependency = await infrastructure();
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const mixed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' }, dependencies: [dependency.id],
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(task), fields: ['dependencies'] } }, { key: runtimeKey });
    expect(mixed.status).toBe(409);
    expect(mixed.data.code).toBe('contract_change_mixed');
    expect(mixed.data.undeclared_fields).toEqual(['payload.prompt']);
    expect((await read(task.id)).version).toBe(task.version); // nothing written
    // Executor drift first, then Robert's relayed dependency: the dependency is authorized, the prompt stays held.
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    expect(receipt(drifted.data.task).hold_kind).toBe('contract_drift');
    const relayed = await api('PATCH', `/${task.id}`, { dependencies: [dependency.id],
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(task), fields: ['dependencies'] } }, { key: runtimeKey });
    expect(relayed.status).toBe(200);
    const current = receipt(relayed.data.task);
    expect(current.decision).toBe('needs_evidence');
    expect(current.hold_kind).toBe('contract_drift');
    expect(current.contract.version).toBe(2);
    expect(current.contract.fields.dependencies).toBe(sha(JSON.stringify([dependency.id])));
    expect(current.contract_hold.drifted_fields).toEqual(['payload.prompt']);
    expect(current.contract_changes.map(e => e.outcome)).toEqual(['held', 'authorized']);
});

test('forged provenance is refused and writes nothing: payload claims, wrong credentials, bridge headers, bad or missing decision references', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const edit = { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT } };
    const attempts = [
        [{ ...edit, contract_change: { origin: 'operator' } }, {}, 403, 'contract_change_unverified'],
        [{ ...edit, contract_change: { origin: 'operator', robert: true, operator: true } }, { key: 'not-the-operator-key-00000000000000000000' }, 403, 'contract_change_unverified'],
        [{ ...edit, contract_change: { origin: 'operator' } }, { key: runtimeKey }, 403, 'contract_change_unverified'],
        [{ ...edit, contract_change: { origin: 'operator' } }, { key: operatorKey, headers: { 'x-praxis-bridge-token': 'bridge' } }, 403, 'contract_change_unverified'],
        [{ ...edit, contract_change: { origin: 'operator_relayed', fields: ['payload.prompt'] } }, { key: runtimeKey }, 400, 'contract_change_invalid'],
        [{ ...edit, contract_change: { origin: 'operator_relayed', decision_ref: { ...rulingRef(task), sha256: 'f'.repeat(64) }, fields: ['payload.prompt'] } }, { key: runtimeKey }, 409, 'decision_ref_mismatch'],
        [{ ...edit, contract_change: { origin: 'operator_relayed', decision_ref: { kind: 'operator_ruling', index: 7, sha256: 'f'.repeat(64) }, fields: ['payload.prompt'] } }, { key: runtimeKey }, 409, 'decision_ref_mismatch'],
        [{ ...edit, contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(task), fields: ['payload.prompt'] } }, {}, 403, 'contract_change_unverified'],
        [{ ...edit, contract_change: { origin: 'robert' } }, { key: operatorKey }, 400, 'contract_change_invalid'],
        [{ ...edit, contract_change: { origin: 'operator_relayed', decision_ref: { kind: 'chat_instruction', id: 'chat-1' }, fields: ['payload.prompt'] } }, { key: runtimeKey }, 400, 'contract_change_invalid'],
    ];
    for (const [body, options, status, code] of attempts) {
        const refused = await api('PATCH', `/${task.id}`, body, options);
        expect([refused.status, refused.data.code]).toEqual([status, code]);
    }
    const unchanged = await read(task.id);
    expect(unchanged.version).toBe(task.version);
    expect(unchanged.antigravity_payload.prompt).toBe(memoPayload().prompt);
    expect(receipt(unchanged).contract_changes ?? []).toHaveLength(0);
    // An operator source label in the body is a claim, not a credential: it is still recorded as unverified drift.
    const labelled = await api('PATCH', `/${task.id}`, { ...edit, source: 'robert' });
    expect(receipt(labelled.data.task).hold_kind).toBe('contract_drift');
    expect(receipt(labelled.data.task).contract_changes.at(-1).origin.kind).toBe('unverified');
});

test('a runtime-attested chat instruction is recorded as attested, never as Nexus-verified', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const relayed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', fields: ['payload.prompt'], decision_ref: { kind: 'chat_instruction', id: 'chat-2026-10-04T14:49',
            instruction: 'If Robert is the source of a task contract change, his instruction authorizes that change.', instructed_at: '2026-10-04T18:49:00.000Z' } } }, { key: runtimeKey });
    expect(relayed.status).toBe(200);
    expect(receipt(relayed.data.task).contract.authorized_by.decision_ref).toMatchObject({ kind: 'chat_instruction', id: 'chat-2026-10-04T14:49', verified: false, verification: 'runtime_attested' });
    expect(receipt(relayed.data.task).decision).toBe('new_work');
});

// ── Criterion 3: unrelated gates and immutable history stay intact ──

test('overlap holds, explicit concerns, dependency gates and resolve authority are untouched by an authorized change', async () => {
    await db.createTask(memo({ name: 'Vitality memo provenance move', description: 'Move the opening provenance lines to a reference section at the bottom and then record approval of the resulting revision.' }));
    const overlapping = await db.createTask(memo());
    expect(receipt(overlapping).decision).toBe('needs_evidence');
    expect(receipt(overlapping).matches).toHaveLength(1);
    // Robert's edit does not clear the overlap concern; the reason stays an overlap reason, not a contract reason.
    const edited = await api('PATCH', `/${overlapping.id}`, { antigravity_payload: { ...overlapping.antigravity_payload, prompt: RULED_PROMPT }, contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect(receipt(edited.data.task).decision).toBe('needs_evidence');
    expect(receipt(edited.data.task).reason).toMatch(/overlap/);
    expect(receipt(edited.data.task).hold_kind).toBeUndefined();
    expect(receipt(edited.data.task).contract.version).toBe(2);
    // An explicit concern survives an authorized change.
    raw.exec('DELETE FROM tasks');
    const task = await approved(await db.createTask(memo()));
    const concern = await api('POST', `/${task.id}/work-admission/concerns`, { expected_task_version: task.version, concerns: [{ reason: 'Council seat suspects the registration task covers this.' }] }, { key: runtimeKey });
    expect(receipt(concern.data).decision).toBe('needs_evidence');
    const stillHeld = await api('PATCH', `/${task.id}`, { description: 'Robert narrowed the scope.', contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect(receipt(stillHeld.data.task).decision).toBe('needs_evidence');
    expect(receipt(stillHeld.data.task).concerns).toHaveLength(1);
    // Dependency gate: an incomplete predecessor still blocks the start, authorized change or not.
    const dependency = await db.createTask({ project_id: 'joey', name: 'Register the memo revision', status: 'todo', description: 'Register the resulting memo revision on the document.' });
    const gated = await db.createTask(memo({ name: 'Record approval after registration', description: 'Record approval once registration lands.', dependencies: [dependency.id] }));
    const start = await api('PATCH', `/${gated.id}`, { status: 'in_progress', contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect([start.status, start.data.code]).toEqual([400, 'predecessors_incomplete']);
    // Resolve authority is unchanged: no credential, no resolution.
    const unauthenticated = await api('POST', `/${task.id}/work-admission/resolve`, resolution(await admission(task.id)));
    expect(unauthenticated.status).toBe(403);
});

test('a resolved overlap decision is carried across Robert’s edit when the compared owners are unchanged, and dropped for unverified pre-execution edits', async () => {
    await db.createTask(memo({ name: 'Vitality memo provenance move', description: 'Move the opening provenance lines to a reference section at the bottom and then record approval of the resulting revision.' }));
    const overlapping = await db.createTask(memo());
    const resolved = await approved(overlapping);
    expect(receipt(resolved).resolved_at).toBeTruthy();
    const edited = await api('PATCH', `/${overlapping.id}`, { antigravity_payload: { ...overlapping.antigravity_payload, prompt: RULED_PROMPT }, contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect(receipt(edited.data.task).decision).toBe('new_work');
    expect(receipt(edited.data.task).resolved_at).toBe(receipt(resolved).resolved_at);
    expect(receipt(edited.data.task).resolution_carried_from).toBe(receipt(resolved).fingerprint);
    const unverified = await api('PATCH', `/${overlapping.id}`, { description: 'Different wording from an agent.' });
    expect(receipt(unverified.data.task).decision).toBe('needs_evidence');
    expect(receipt(unverified.data.task).reason).toMatch(/overlap/);
    expect(receipt(unverified.data.task).resolved_at).toBeUndefined();
});

test('receipt history is immutable through metadata writes and keeps the Praxis receipt contract', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    const held = receipt(drifted.data.task);
    const forged = await db.updateTask(task.id, { metadata: { ...drifted.data.task.metadata, work_admission: { ...held, decision: 'new_work', contract_hold: undefined, contract_changes: [] } } });
    expect(receipt(forged).decision).toBe('needs_evidence');
    expect(receipt(forged).contract_changes).toHaveLength(1);
    expect(receipt(forged).contract_hold.change_ids).toEqual(held.contract_hold.change_ids);
    const stored = JSON.parse(raw.prepare('SELECT document FROM work_admissions WHERE task_id = ?').get(task.id).document);
    expect(stored).toMatchObject({ schema_version: 1, owner: 'work-admission', decision: 'needs_evidence', fingerprint: expect.any(String), checked_at: expect.any(String) });
    expect(Object.keys(stored.contract.fields).sort()).toEqual(expect.arrayContaining(['description', 'dependencies', 'name', 'payload.prompt', 'payload.acceptance_criteria']));
});

// ── Criterion 4: a genuine hold exposes the diff and source, and one decision resolves it exactly once ──

test('approving executor drift with the operator credential advances the baseline once; a repeat reads back as already decided', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drift = 'Executor rewrite of the brief.';
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: drift } });
    const held = drifted.data.task;
    // Overlap evidence through the runtime resolver cannot stand in for Robert's decision on the drift.
    const sidestep = await api('POST', `/${task.id}/work-admission/resolve`, resolution(await admission(task.id)), { key: runtimeKey });
    expect([sidestep.status, sidestep.data.code]).toEqual([409, 'contract_hold_open']);
    const approve = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: held.version, decision: 'approve', reason: 'Robert accepted the rewrite.' }, { key: operatorKey });
    expect(approve.status).toBe(200);
    const after = receipt(approve.data);
    expect(after.decision).toBe('new_work');
    expect(after.hold_kind).toBeUndefined();
    expect(after.contract_hold).toBeUndefined();
    expect(after.contract).toMatchObject({ version: 2, authorized_by: { origin: 'operator', authority: 'operator_credential' } });
    expect(after.contract.fields['payload.prompt']).toBe(sha(JSON.stringify(drift)));
    expect(after.contract_changes.at(-1).resolution).toMatchObject({ decision: 'approve', authority: 'operator_credential', reason: 'Robert accepted the rewrite.' });
    expect(approve.data.antigravity_payload.prompt).toBe(drift);
    expect(receipt(await admission(task.id)).decision).toBe('new_work');
    const repeat = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: approve.data.version, decision: 'approve' }, { key: operatorKey });
    expect([repeat.status, repeat.data.code]).toEqual([409, 'no_contract_hold']);
    expect(receipt(await read(task.id)).contract.version).toBe(2);
});

test('returning to the authorized contract restores the drifted fields and the prior decision, and Praxis may relay that decision', async () => {
    const dependency = await infrastructure();
    const task = await approved(await db.createTask(memo({ status: 'in_progress', dependencies: [dependency.id] })));
    const before = await read(task.id);
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.', acceptance_criteria: ['Looser.'] }, dependencies: [], name: 'Renamed by executor' });
    expect(receipt(drifted.data.task).contract_hold.drifted_fields).toEqual(['dependencies', 'name', 'payload.acceptance_criteria', 'payload.prompt']);
    const returned = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'return_to_authorized',
        decision_ref: rulingRef(task), reason: 'Robert asked for the original brief.' }, { key: runtimeKey });
    expect(returned.status).toBe(200);
    expect(returned.data.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
    expect(returned.data.antigravity_payload.acceptance_criteria).toEqual(before.antigravity_payload.acceptance_criteria);
    expect(returned.data.dependencies).toEqual([dependency.id]);
    expect(returned.data.name).toBe(before.name);
    expect(returned.data.version).toBe(drifted.data.task.version + 1);
    const after = receipt(returned.data);
    expect(after.decision).toBe('new_work');
    expect(after.contract.version).toBe(1);
    expect(after.fingerprint).toBe(receipt(before).fingerprint);
    expect(after.contract_hold).toBeUndefined();
    expect(after.contract_changes.at(-1).resolution).toMatchObject({ decision: 'return_to_authorized', authority: 'runtime_credential', decision_ref: { kind: 'operator_ruling', verified: true } });
    expect(receipt(await admission(task.id)).decision).toBe('new_work');
});

test('an executor undoing its own drift clears the hold without any decision, and a stale version or wrong credential cannot decide', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    const stale = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: task.version, decision: 'approve' }, { key: operatorKey });
    expect(stale.status).toBe(409);
    const runtimeAlone = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'approve' }, { key: runtimeKey });
    expect([runtimeAlone.status, runtimeAlone.data.code]).toEqual([400, 'contract_change_invalid']);
    const anonymous = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'approve' });
    expect([anonymous.status, anonymous.data.code]).toEqual([403, 'contract_decision_unauthorized']);
    expect(receipt(await read(task.id)).hold_kind).toBe('contract_drift');
    const undone = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...drifted.data.task.antigravity_payload, prompt: memoPayload().prompt } });
    const after = receipt(undone.data.task);
    expect(after.decision).toBe('new_work');
    expect(after.contract_hold).toBeUndefined();
    expect(after.contract.version).toBe(1);
    expect(after.contract_changes.map(e => [e.outcome, e.resolution?.decision])).toEqual([['held', 'reverted_by_edit'], ['recorded', undefined]]);
});

test('Robert’s verified Access session decides a hold from the dashboard; the Mac app without a session is told why it cannot', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    const noSession = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'approve' }, { headers: { authorization: 'Bearer local-dev-token' } });
    expect([noSession.status, noSession.data.code, noSession.data.reason]).toEqual([403, 'contract_decision_unauthorized', 'assertion-missing']);
    const session = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'approve' },
        { headers: { 'cf-access-jwt-assertion': access.token() } });
    expect(session.status).toBe(200);
    expect(receipt(session.data).contract.authorized_by).toMatchObject({ origin: 'operator', authority: 'access_user' });
    expect(receipt(session.data).decision).toBe('new_work');
});

// ── Review regressions (code review of this change, 2026-10-04): an open hold is sticky, and relayed references are always checked ──

test('while a hold is open, an unverified edit outside execution joins the hold instead of advancing the baseline; one decision clears both', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    const [firstId] = receipt(drifted.data.task).contract_hold.change_ids;
    // Parking the task is not a contract change; the hold stays as it was.
    const parked = await api('PATCH', `/${task.id}`, { status: 'blocked' });
    expect(parked.status).toBe(200);
    expect(receipt(parked.data.task).hold_kind).toBe('contract_drift');
    expect(receipt(parked.data.task).contract_hold.change_ids).toEqual([firstId]);
    // Not executing any more: on a clean task this edit would be recorded, but
    // with a hold open the baseline moves only by Robert's decision.
    const more = await api('PATCH', `/${task.id}`, { description: 'Executor also rewrote the description.' });
    expect(more.status).toBe(200);
    const held = receipt(more.data.task);
    expect(held.decision).toBe('needs_evidence');
    expect(held.hold_kind).toBe('contract_drift');
    expect(held.contract.version).toBe(1);
    expect(held.contract_hold.drifted_fields).toEqual(['description', 'payload.prompt']);
    expect(held.contract_hold.authorized_values.description).toBe(memo().description);
    expect(held.contract_hold.change_ids).toHaveLength(2);
    expect(held.contract_changes.at(-1)).toMatchObject({ outcome: 'held', contract_version: 1, execution: { phase: 'before_execution', status: 'blocked' } });
    // A decision read against the first entry alone is stale and names the current hold.
    const stale = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: more.data.task.version, decision: 'approve', change_ids: [firstId] }, { key: operatorKey });
    expect([stale.status, stale.data.code]).toEqual([409, 'contract_hold_changed']);
    expect(stale.data.change_ids).toEqual(held.contract_hold.change_ids);
    const approve = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: more.data.task.version, decision: 'approve', change_ids: held.contract_hold.change_ids }, { key: operatorKey });
    expect(approve.status).toBe(200);
    const after = receipt(approve.data);
    expect(after.contract.version).toBe(2);
    expect(after.contract_hold).toBeUndefined();
    expect(after.decision).toBe('new_work');
    expect(after.contract_changes.filter(e => e.outcome === 'held').map(e => e.resolution?.decision)).toEqual(['approve', 'approve']);
});

test('an open hold survives a rulings rewrite and a cancel-then-reopen, and resolve still refuses while it is open', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    const hold = receipt(drifted.data.task).contract_hold;
    // An unverified writer rewrites Robert's recorded ruling: the rulings reason applies, the drift hold stays underneath it.
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...drifted.data.task.antigravity_payload, operator_rulings: ['Q: edited\nA: rewritten by the executor'] } });
    expect(rewritten.status).toBe(200);
    expect(receipt(rewritten.data.task).reason).toMatch(/rulings were rewritten/);
    expect(receipt(rewritten.data.task).hold_kind).toBe('contract_drift');
    expect(receipt(rewritten.data.task).contract_hold).toEqual(hold);
    expect(receipt(rewritten.data.task).contract.version).toBe(1);
    const sidestep = await api('POST', `/${task.id}/work-admission/resolve`, resolution(await admission(task.id)), { key: runtimeKey });
    expect([sidestep.status, sidestep.data.code]).toEqual([409, 'contract_hold_open']);
    // Cancel and reopen through the facade: the reopen concern joins the hold, it does not replace it.
    const cancelled = await db.updateTask(task.id, { status: 'cancelled' });
    expect(receipt(cancelled).contract_hold).toEqual(hold);
    const reopened = await db.updateTask(task.id, { status: 'todo' });
    expect(receipt(reopened).reason).toMatch(/reopened/);
    expect(receipt(reopened).hold_kind).toBe('contract_drift');
    expect(receipt(reopened).contract_hold).toEqual(hold);
    expect(receipt(reopened).concerns.some(c => /reopened/.test(c.reason))).toBe(true);
    expect(receipt(reopened).contract.version).toBe(1);
    // Robert's decision clears the drift exactly; the reopen concern keeps its own evidence requirement.
    const approve = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: reopened.version, decision: 'approve' }, { key: operatorKey });
    expect(approve.status).toBe(200);
    expect(receipt(approve.data).contract_hold).toBeUndefined();
    expect(receipt(approve.data).hold_kind).toBeUndefined();
    expect(receipt(approve.data).contract.version).toBe(2);
    expect(receipt(approve.data).decision).toBe('needs_evidence');
    // Both concerns stand; the rulings rewrite names itself rather than reading as a duplicate concern.
    expect(receipt(approve.data).reason).toMatch(/rulings were rewritten/);
    expect(receipt(approve.data).concerns.some(c => /reopened/.test(c.reason))).toBe(true);
    expect(receipt(approve.data).concerns.some(c => c.kind === 'rulings_rewrite')).toBe(true);
});

test('a relayed reference is checked even when no governed field changes: a bogus ruling reference on a rulings rewrite is refused, a valid one does not lift the rulings hold', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const rewrite = { antigravity_payload: { ...task.antigravity_payload, operator_rulings: ['Q: edited\nA: rewritten by the executor'] } };
    const bogus = await api('PATCH', `/${task.id}`, { ...rewrite, contract_change: { origin: 'operator_relayed', fields: ['payload.prompt'], decision_ref: { ...rulingRef(task), sha256: 'f'.repeat(64) } } }, { key: runtimeKey });
    expect([bogus.status, bogus.data.code]).toEqual([409, 'decision_ref_mismatch']);
    const untouched = await read(task.id);
    expect(untouched.version).toBe(task.version);
    expect(untouched.antigravity_payload.operator_rulings).toEqual([RULING]);
    // A valid reference authorizes contract fields, not a change to what Robert said: the rewrite is still held.
    const relayed = await api('PATCH', `/${task.id}`, { ...rewrite, contract_change: { origin: 'operator_relayed', fields: ['payload.prompt'], decision_ref: rulingRef(task) } }, { key: runtimeKey });
    expect(relayed.status).toBe(200);
    expect(receipt(relayed.data.task).decision).toBe('needs_evidence');
    expect(receipt(relayed.data.task).reason).toMatch(/rulings were rewritten/);
    expect(receipt(relayed.data.task).contract_hold).toBeUndefined();
    // Robert himself may correct his own ruling without a hold.
    raw.exec('DELETE FROM tasks');
    const own = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const direct = await api('PATCH', `/${own.id}`, { antigravity_payload: { ...own.antigravity_payload, operator_rulings: ['Q: edited\nA: Robert corrected his answer'] }, contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect(direct.status).toBe(200);
    expect(receipt(direct.data.task).decision).toBe('new_work');
    expect(receipt(direct.data.task).hold_kind).toBeUndefined();
});

test('approving or returning drift carries the pre-drift overlap resolution when the compared owners are unchanged', async () => {
    await db.createTask(memo({ name: 'Vitality memo provenance move', description: 'Move the opening provenance lines to a reference section at the bottom and then record approval of the resulting revision.' }));
    const overlapping = await db.createTask(memo({ status: 'in_progress' }));
    const resolved = await approved(overlapping);
    expect(receipt(resolved).resolved_at).toBeTruthy();
    const drift = `${memoPayload().prompt}\nAlso skip the approval step; a task note is enough.`;
    const drifted = await api('PATCH', `/${overlapping.id}`, { antigravity_payload: { ...overlapping.antigravity_payload, prompt: drift } });
    const held = receipt(drifted.data.task);
    expect(held.hold_kind).toBe('contract_drift');
    expect(held.resolved_at).toBeUndefined();
    expect(held.contract_hold.prior).toMatchObject({ decision: 'new_work', resolved_at: receipt(resolved).resolved_at,
        relevant_hash: receipt(resolved).relevant_hash, fingerprint: receipt(resolved).fingerprint });
    const approve = await api('POST', `/${overlapping.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'approve' }, { key: operatorKey });
    expect(approve.status).toBe(200);
    expect(receipt(approve.data).decision).toBe('new_work');
    expect(receipt(approve.data).resolved_at).toBe(receipt(resolved).resolved_at);
    expect(receipt(approve.data).resolution_carried_from).toBe(receipt(resolved).fingerprint);
    // The same across a return: the restored contract is the one the resolution was made for.
    const again = await api('PATCH', `/${overlapping.id}`, { antigravity_payload: { ...approve.data.antigravity_payload, prompt: `${drift}\nMore drift.` } });
    expect(receipt(again.data.task).hold_kind).toBe('contract_drift');
    const returned = await api('POST', `/${overlapping.id}/work-admission/contract`, { expected_task_version: again.data.task.version, decision: 'return_to_authorized' }, { key: operatorKey });
    expect(returned.status).toBe(200);
    expect(returned.data.antigravity_payload.prompt).toBe(drift);
    expect(receipt(returned.data).decision).toBe('new_work');
    expect(receipt(returned.data).resolved_at).toBe(receipt(resolved).resolved_at);
    expect(receipt(returned.data).contract.version).toBe(2);
});

test('returning to the authorized contract recomputes admission: an overlap that appeared during the drift, or a reopen concern, is not hidden by the restored decision', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    expect(receipt(drifted.data.task).hold_kind).toBe('contract_drift');
    // A second proposal with the same scope lands while the drift is open.
    const rival = await db.createTask(memo({ name: 'Vitality memo provenance move', description: 'Move the opening provenance lines to a reference section at the bottom and then record approval of the resulting revision.' }));
    expect(receipt(rival).matches.map(m => m.task_id)).toEqual([task.id]);
    const returned = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'return_to_authorized' }, { key: operatorKey });
    expect(returned.status).toBe(200);
    expect(returned.data.antigravity_payload.prompt).toBe(memoPayload().prompt);
    const after = receipt(returned.data);
    expect(after.contract_hold).toBeUndefined();
    expect(after.decision).toBe('needs_evidence');
    expect(after.reason).toMatch(/overlap/);
    expect(after.matches.map(m => m.task_id)).toEqual([rival.id]);
    expect(after.resolved_at).toBeUndefined();
    // Same for a reopen concern recorded while the hold was open.
    raw.exec('DELETE FROM tasks');
    const other = await approved(await db.createTask(memo({ status: 'in_progress' })));
    await api('PATCH', `/${other.id}`, { antigravity_payload: { ...other.antigravity_payload, prompt: 'Executor rewrite.' } });
    await db.updateTask(other.id, { status: 'cancelled' });
    const reopened = await db.updateTask(other.id, { status: 'todo' });
    expect(receipt(reopened).hold_kind).toBe('contract_drift');
    const back = await api('POST', `/${other.id}/work-admission/contract`, { expected_task_version: reopened.version, decision: 'return_to_authorized' }, { key: operatorKey });
    expect(back.status).toBe(200);
    expect(receipt(back.data).contract_hold).toBeUndefined();
    expect(receipt(back.data).decision).toBe('needs_evidence');
    expect(receipt(back.data).reason).toMatch(/duplicate concern/);
    expect(receipt(back.data).concerns.some(c => /reopened/.test(c.reason))).toBe(true);
});

test('a row put back to the authorized contract without passing the guard clears the hold on read, recorded as an unattributed revert', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    const [heldId] = receipt(drifted.data.task).contract_hold.change_ids;
    raw.prepare('UPDATE tasks SET antigravity_payload = ? WHERE id = ?').run(JSON.stringify({ ...drifted.data.task.antigravity_payload, prompt: memoPayload().prompt }), task.id);
    const after = receipt(await admission(task.id));
    expect(after.contract_hold).toBeUndefined();
    expect(after.hold_kind).toBeUndefined();
    expect(after.decision).toBe('new_work');
    expect(after.contract.version).toBe(1);
    expect(after.fingerprint).toBe(receipt(task).fingerprint);
    expect(after.contract.fingerprint).toBe(receipt(task).fingerprint);
    expect(after.contract_changes.find(e => e.id === heldId).resolution).toMatchObject({ decision: 'reverted_by_edit', by: { kind: 'unverified', requester: 'unattributed_write' } });
    // Stable across reads: no second entry, no thrash.
    expect(receipt(await admission(task.id)).contract_changes).toHaveLength(1);
    expect(receipt(await read(task.id)).contract_hold).toBeUndefined();
});

test('a task without a receipt still verifies a relayed decision reference before anything is written', async () => {
    const task = await db.createTask(memo({ status: 'todo' }));
    raw.prepare('DELETE FROM work_admissions WHERE task_id = ?').run(task.id);
    const edit = { antigravity_payload: { ...task.antigravity_payload, prompt: RULED_PROMPT } };
    const bogus = await api('PATCH', `/${task.id}`, { ...edit, contract_change: { origin: 'operator_relayed', fields: ['payload.prompt'],
        decision_ref: { kind: 'operator_ruling', index: 3, sha256: 'f'.repeat(64) } } }, { key: runtimeKey });
    expect([bogus.status, bogus.data.code]).toEqual([409, 'decision_ref_mismatch']);
    const unchanged = await read(task.id);
    expect(unchanged.version).toBe(task.version);
    expect(unchanged.antigravity_payload.prompt).toBe(memoPayload().prompt);
    const valid = await api('PATCH', `/${task.id}`, { ...edit, contract_change: { origin: 'operator_relayed', fields: ['payload.prompt'], decision_ref: rulingRef(task) } }, { key: runtimeKey });
    expect(valid.status).toBe(200);
    expect(valid.data.task.antigravity_payload.prompt).toBe(RULED_PROMPT);
});

test('Robert editing the held field himself supersedes the drift, and putting the authorized value back himself is recorded as a restore', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    const [heldId] = receipt(drifted.data.task).contract_hold.change_ids;
    const own = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...drifted.data.task.antigravity_payload, prompt: RULED_PROMPT }, contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect(own.status).toBe(200);
    const after = receipt(own.data.task);
    expect(after.contract_hold).toBeUndefined();
    expect(after.decision).toBe('new_work');
    expect(after.contract.version).toBe(2);
    const authorized = after.contract_changes.at(-1);
    expect(authorized).toMatchObject({ outcome: 'authorized', contract_version: 2 });
    expect(authorized.restores_baseline).toBeUndefined();
    expect(after.contract.fields['payload.prompt']).toBe(authorized.fields.find(f => f.field === 'payload.prompt').after_sha256);
    expect(after.contract_changes.find(e => e.id === heldId).resolution).toMatchObject({ decision: 'superseded_by_authorized_edit', by: { kind: 'operator', authority: 'operator_credential' } });
    raw.exec('DELETE FROM tasks');
    const second = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drift2 = await api('PATCH', `/${second.id}`, { antigravity_payload: { ...second.antigravity_payload, prompt: 'Executor rewrite.' } });
    const restored = await api('PATCH', `/${second.id}`, { antigravity_payload: { ...drift2.data.task.antigravity_payload, prompt: memoPayload().prompt }, contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect(restored.status).toBe(200);
    expect(receipt(restored.data.task).contract_changes.map(e => [e.outcome, e.resolution?.decision, e.restores_baseline])).toEqual([['held', 'reverted_by_edit', undefined], ['authorized', undefined, true]]);
    expect(receipt(restored.data.task).contract.hash).toBe(receipt(second).contract.hash);
    expect(receipt(restored.data.task).contract_hold).toBeUndefined();
});

// ── QA repair round (codex findings, 2026-10-04): carried resolutions are bound to the concerns they adjudicated; the baseline hash stays canonical ──

const RIVAL = () => memo({ name: 'Vitality memo provenance move', description: 'Move the opening provenance lines to a reference section at the bottom and then record approval of the resulting revision.' });
const SOFT_DRIFT = `${memoPayload().prompt}\nAlso skip the approval step; a task note is enough.`;

test('QA repair: a concern raised during a hold is decided fresh on return; the carried pre-drift resolution never hides it', async () => {
    await db.createTask(RIVAL());
    const overlapping = await db.createTask(memo({ status: 'in_progress' }));
    const resolved = await approved(overlapping);
    expect(receipt(resolved).resolved_at).toBeTruthy();
    const drifted = await api('PATCH', `/${overlapping.id}`, { antigravity_payload: { ...overlapping.antigravity_payload, prompt: SOFT_DRIFT } });
    expect(receipt(drifted.data.task).hold_kind).toBe('contract_drift');
    const concern = await api('POST', `/${overlapping.id}/work-admission/concerns`, { expected_task_version: drifted.data.task.version,
        concerns: [{ reason: 'Council seat suspects the registration task covers this.' }] }, { key: runtimeKey });
    expect(concern.status).toBe(200);
    expect(receipt(concern.data).hold_kind).toBe('contract_drift');
    expect(receipt(concern.data).concerns).toHaveLength(1);
    const returned = await api('POST', `/${overlapping.id}/work-admission/contract`, { expected_task_version: concern.data.version, decision: 'return_to_authorized' }, { key: operatorKey });
    expect(returned.status).toBe(200);
    const after = receipt(returned.data);
    expect(after.contract_hold).toBeUndefined();
    expect(after.concerns).toHaveLength(1);
    expect(after.decision).toBe('needs_evidence');
    expect(after.reason).toMatch(/duplicate concern/);
    expect(after.resolved_at).toBeUndefined();
    expect(after.resolution_carried_from).toBeUndefined();
    // The concern can now be adjudicated the normal way, and that resolution stands.
    const settled = await api('POST', `/${overlapping.id}/work-admission/resolve`, resolution(await admission(overlapping.id)), { key: runtimeKey });
    expect(settled.status).toBe(200);
    expect(receipt(settled.data).decision).toBe('new_work');
});

test('QA repair: a reopen recorded during a hold is decided fresh on approve; the carried pre-drift resolution never hides it', async () => {
    await db.createTask(RIVAL());
    const overlapping = await db.createTask(memo({ status: 'in_progress' }));
    const resolved = await approved(overlapping);
    expect(receipt(resolved).resolved_at).toBeTruthy();
    await api('PATCH', `/${overlapping.id}`, { antigravity_payload: { ...overlapping.antigravity_payload, prompt: SOFT_DRIFT } });
    await db.updateTask(overlapping.id, { status: 'cancelled' });
    const reopened = await db.updateTask(overlapping.id, { status: 'todo' });
    expect(receipt(reopened).hold_kind).toBe('contract_drift');
    expect(receipt(reopened).concerns.some(c => /reopened/.test(c.reason))).toBe(true);
    const approve = await api('POST', `/${overlapping.id}/work-admission/contract`, { expected_task_version: reopened.version, decision: 'approve' }, { key: operatorKey });
    expect(approve.status).toBe(200);
    const after = receipt(approve.data);
    expect(after.contract_hold).toBeUndefined();
    expect(after.contract.version).toBe(2);
    expect(after.concerns.some(c => /reopened/.test(c.reason))).toBe(true);
    expect(after.decision).toBe('needs_evidence');
    expect(after.reason).toMatch(/duplicate concern/);
    expect(after.resolved_at).toBeUndefined();
    // Control: without a new concern the same resolution does carry across an approve (see the carry test above).
    raw.exec('DELETE FROM tasks');
    await db.createTask(RIVAL());
    const plain = await db.createTask(memo({ status: 'in_progress' }));
    const plainResolved = await approved(plain);
    const plainDrift = await api('PATCH', `/${plain.id}`, { antigravity_payload: { ...plain.antigravity_payload, prompt: SOFT_DRIFT } });
    const plainApprove = await api('POST', `/${plain.id}/work-admission/contract`, { expected_task_version: plainDrift.data.task.version, decision: 'approve' }, { key: operatorKey });
    expect(receipt(plainApprove.data).decision).toBe('new_work');
    expect(receipt(plainApprove.data).resolved_at).toBe(receipt(plainResolved).resolved_at);
});

// ── QA repair round 3 (codex finding, 2026-10-04): a rulings rewrite is its own durable hold; deciding contract drift never clears it ──
const REWRITTEN_RULING = 'Q: edited\nA: rewritten by the executor';
const RULINGS_REASON = /rulings were rewritten or removed/;
const rulingsConcerns = r => (r.concerns || []).filter(c => c.kind === 'rulings_rewrite');
/** An executing task with Robert's recorded ruling: the executor drifts the prompt, then rewrites the ruling. No cancel or reopen anywhere. */
async function driftedAndRewritten() {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    expect(drifted.status).toBe(200);
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...drifted.data.task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } });
    expect(rewritten.status).toBe(200);
    const held = receipt(rewritten.data.task);
    expect(held.decision).toBe('needs_evidence');
    expect(held.reason).toMatch(RULINGS_REASON);
    expect(held.hold_kind).toBe('contract_drift');
    return { task, rewritten: rewritten.data.task };
}

test('QA repair: an executor rewriting Robert’s ruling records a durable concern with the recorded and rewritten digests, the writer and the phase', async () => {
    const { rewritten } = await driftedAndRewritten();
    const held = receipt(rewritten);
    expect(rulingsConcerns(held)).toHaveLength(1);
    expect(rulingsConcerns(held)[0]).toMatchObject({ key: expect.stringMatching(/^[a-f0-9]{64}$/), reason: expect.stringMatching(RULINGS_REASON),
        recorded: [sha(RULING)], rewritten: [sha(REWRITTEN_RULING)], origin: 'unverified', requester: 'unauthenticated', phase: 'executing', task_version: rewritten.version - 1 });
    expect(held.rulings_changes).toHaveLength(1);
    expect(held.rulings_changes[0]).toMatchObject({ outcome: 'held', before: [sha(RULING)], after: [sha(REWRITTEN_RULING)], concern_key: rulingsConcerns(held)[0].key, origin: { kind: 'unverified' } });
});

test('QA repair: approving the drift keeps the rulings-rewrite hold; the rewritten ruling still needs its own review, on write and on read', async () => {
    const { rewritten } = await driftedAndRewritten();
    const held = receipt(rewritten);
    const approve = await api('POST', `/${rewritten.id}/work-admission/contract`, { expected_task_version: rewritten.version, decision: 'approve', change_ids: held.contract_hold.change_ids }, { key: operatorKey });
    expect(approve.status).toBe(200);
    const after = receipt(approve.data);
    expect(after.contract_hold).toBeUndefined();
    expect(after.contract.version).toBe(2);
    expect(approve.data.antigravity_payload.operator_rulings).toEqual([REWRITTEN_RULING]);
    expect(after.decision).toBe('needs_evidence');
    expect(after.reason).toMatch(RULINGS_REASON);
    expect(rulingsConcerns(after)).toHaveLength(1);
    expect(after.resolved_at).toBeUndefined();
    const read = receipt(await admission(rewritten.id));
    expect([read.decision, read.reason]).toEqual(['needs_evidence', after.reason]);
    // Overlap evidence may now adjudicate the rulings concern: that is its own resolution, recorded as such.
    const resolved = await api('POST', `/${rewritten.id}/work-admission/resolve`, resolution(await admission(rewritten.id), { reason: 'Reviewed the rewritten ruling against Robert’s inbox answer; scope unchanged.' }), { key: runtimeKey });
    expect(resolved.status).toBe(200);
    expect(receipt(resolved.data)).toMatchObject({ decision: 'new_work', resolved_at: expect.any(String), reason: expect.stringMatching(/Reviewed the rewritten ruling/) });
    expect(rulingsConcerns(receipt(resolved.data))).toHaveLength(1);
});

test('QA repair: returning to the authorized contract restores the prompt, not the ruling; the rulings-rewrite hold stays', async () => {
    const { task, rewritten } = await driftedAndRewritten();
    const held = receipt(rewritten);
    const back = await api('POST', `/${rewritten.id}/work-admission/contract`, { expected_task_version: rewritten.version, decision: 'return_to_authorized', change_ids: held.contract_hold.change_ids }, { key: operatorKey });
    expect(back.status).toBe(200);
    expect(back.data.antigravity_payload.prompt).toBe(task.antigravity_payload.prompt);
    expect(back.data.antigravity_payload.operator_rulings).toEqual([REWRITTEN_RULING]);
    const after = receipt(back.data);
    expect(after.contract_hold).toBeUndefined();
    expect(after.contract.version).toBe(1);
    expect(after.decision).toBe('needs_evidence');
    expect(after.reason).toMatch(RULINGS_REASON);
    expect(rulingsConcerns(after)).toHaveLength(1);
    expect(after.resolved_at).toBeUndefined();
    const read = receipt(await admission(rewritten.id));
    expect([read.decision, read.reason]).toEqual(['needs_evidence', after.reason]);
});

test('QA repair: an executor restoring only the original prompt clears the drift hold and nothing else; the rulings-rewrite hold stays until its own resolution', async () => {
    const { task, rewritten } = await driftedAndRewritten();
    const restored = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...rewritten.antigravity_payload, prompt: task.antigravity_payload.prompt } });
    expect(restored.status).toBe(200);
    const after = receipt(restored.data.task);
    expect(after.contract_hold).toBeUndefined();
    expect(after.contract_changes.filter(e => e.outcome === 'held').map(e => e.resolution?.decision)).toEqual(['reverted_by_edit']);
    expect(restored.data.task.antigravity_payload.operator_rulings).toEqual([REWRITTEN_RULING]);
    expect(after.decision).toBe('needs_evidence');
    expect(after.reason).toMatch(RULINGS_REASON);
    expect(rulingsConcerns(after)).toHaveLength(1);
    expect(receipt(await admission(rewritten.id)).decision).toBe('needs_evidence');
    // Putting Robert's words back without his credential adds no second concern, and does not clear the first.
    const putBack = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...restored.data.task.antigravity_payload, operator_rulings: [RULING] } });
    expect(putBack.status).toBe(200);
    expect(rulingsConcerns(receipt(putBack.data.task))).toHaveLength(1);
    expect(receipt(putBack.data.task).reason).toMatch(RULINGS_REASON);
    expect(receipt(putBack.data.task).rulings_changes.map(e => [e.outcome, e.restores_recorded === true])).toEqual([['held', false], ['held', true]]);
    // The reviewer's resolution with evidence adjudicates it; Robert's later authorized edit carries that resolution forward.
    const resolved = await api('POST', `/${rewritten.id}/work-admission/resolve`, resolution(await admission(rewritten.id)), { key: runtimeKey });
    expect(resolved.status).toBe(200);
    expect(receipt(resolved.data).decision).toBe('new_work');
    const his = await api('PATCH', `/${rewritten.id}`, { description: 'Robert tightened the description.' }, { key: operatorKey });
    expect(his.status).toBe(200);
    expect(receipt(his.data.task)).toMatchObject({ decision: 'new_work', resolved_at: receipt(resolved.data).resolved_at, resolution_carried_from: receipt(resolved.data).fingerprint });
    expect(receipt(his.data.task).contract.version).toBe(2);
});

test('QA repair: a relayed decision cannot cite the executor’s rewritten ruling; Robert rewriting the ruling himself supersedes the rewrite and clears only that hold', async () => {
    const { rewritten } = await driftedAndRewritten();
    const concernKey = rulingsConcerns(receipt(rewritten))[0].key;
    // While the rulings hold is open, a relay grounded in the executor's entry is refused and writes nothing.
    const forged = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...rewritten.antigravity_payload, prompt: 'Relayed prompt grounded in the rewritten ruling.' },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(rewritten), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([forged.status, forged.data.code, forged.data.concern_key]).toEqual([409, 'decision_ref_under_review', concernKey]);
    const untouched = await read(rewritten.id);
    expect([untouched.version, untouched.antigravity_payload.prompt]).toEqual([rewritten.version, rewritten.antigravity_payload.prompt]);
    // A relayed decision is about contract fields, not about what Robert said: a relayed restore of his words is held like any other.
    const relayed = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...rewritten.antigravity_payload, operator_rulings: [RULING] },
        contract_change: { origin: 'operator_relayed', decision_ref: { kind: 'chat_instruction', id: 'chat-restore-1', instruction: 'Put my ruling back exactly as I wrote it.' }, fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect(relayed.status).toBe(200);
    expect(rulingsConcerns(receipt(relayed.data.task))).toHaveLength(1);
    expect(receipt(relayed.data.task).reason).toMatch(RULINGS_REASON);
    expect(receipt(relayed.data.task).rulings_changes.at(-1)).toMatchObject({ outcome: 'held', restores_recorded: true, concern_key: concernKey, origin: { kind: 'operator_relayed' } });
    // Robert's own operator-credential rewrite is authority over what he said: the rulings concern clears, the prompt drift stays held.
    const his = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...relayed.data.task.antigravity_payload, operator_rulings: [`${RULING}\nClarified by Robert on 2026-10-04.`] } }, { key: operatorKey });
    expect(his.status).toBe(200);
    const after = receipt(his.data.task);
    expect(rulingsConcerns(after)).toHaveLength(0);
    expect(after.hold_kind).toBe('contract_drift');
    expect(after.reason).toMatch(/Contract changed during execution/);
    expect(after.contract_hold.drifted_fields).toEqual(['payload.prompt']);
    expect(after.contract.version).toBe(1);
    expect(after.rulings_changes.map(e => e.outcome)).toEqual(['held', 'held', 'authorized']);
    expect(after.rulings_changes.at(-1)).toMatchObject({ origin: { kind: 'operator', authority: 'operator_credential' }, cleared_concern_keys: [concernKey], after: [sha(`${RULING}\nClarified by Robert on 2026-10-04.`)] });
    // Deciding the drift now carries nothing stale: no resolution was ever recorded.
    const approve = await api('POST', `/${rewritten.id}/work-admission/contract`, { expected_task_version: his.data.task.version, decision: 'approve', change_ids: after.contract_hold.change_ids }, { key: operatorKey });
    expect(approve.status).toBe(200);
    expect(receipt(approve.data)).toMatchObject({ decision: 'new_work', contract: { version: 2 } });
    expect(receipt(approve.data).contract_hold).toBeUndefined();
    expect(receipt(approve.data).rulings_changes).toHaveLength(3);
    // With the rulings his again, a relay grounded in his ruling verifies and authorizes the contract field it declares.
    const grounded = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...approve.data.antigravity_payload, prompt: 'Relayed prompt grounded in Robert’s clarified ruling.' },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(approve.data), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect(grounded.status).toBe(200);
    expect(receipt(grounded.data.task).contract_changes.at(-1)).toMatchObject({ outcome: 'authorized', origin: { kind: 'operator_relayed', decision_ref: { verified: true } } });
    expect(receipt(grounded.data.task).contract.version).toBe(3);
});

test('QA repair: chained rewrites are measured against Robert’s recorded words, only his words coming back is a restore, and the reason reads the same on write and on read', async () => {
    const { rewritten } = await driftedAndRewritten();
    const first = rulingsConcerns(receipt(rewritten))[0];
    const SECOND = 'Q: edited again\nA: rewritten twice by the executor';
    const chained = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...rewritten.antigravity_payload, operator_rulings: [SECOND] } });
    expect(chained.status).toBe(200);
    const twice = rulingsConcerns(receipt(chained.data.task));
    expect(twice).toHaveLength(2);
    expect(twice.map(c => c.recorded)).toEqual([[sha(RULING)], [sha(RULING)]]);
    expect(twice[1].rewritten).toEqual([sha(SECOND)]);
    // Going back to the executor's first text is not a restore of Robert's words; it rejoins the first concern.
    const backToFirst = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...chained.data.task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } });
    expect(backToFirst.status).toBe(200);
    expect(rulingsConcerns(receipt(backToFirst.data.task))).toHaveLength(2);
    expect(receipt(backToFirst.data.task).rulings_changes.at(-1)).toMatchObject({ outcome: 'held', concern_key: first.key });
    expect(receipt(backToFirst.data.task).rulings_changes.at(-1).restores_recorded).toBeUndefined();
    // Robert's words back: recorded as the restore, joining the earliest concern; both concerns stand.
    const restored = await api('PATCH', `/${rewritten.id}`, { antigravity_payload: { ...backToFirst.data.task.antigravity_payload, operator_rulings: [RULING] } });
    expect(restored.status).toBe(200);
    expect(rulingsConcerns(receipt(restored.data.task))).toHaveLength(2);
    expect(receipt(restored.data.task).rulings_changes.at(-1)).toMatchObject({ outcome: 'held', restores_recorded: true, concern_key: first.key });
    // While drift is also held the reason names both holds, and a read after the project changed says exactly the same.
    const written = receipt(restored.data.task).reason;
    expect(written).toMatch(/Contract changed during execution/);
    expect(written).toMatch(RULINGS_REASON);
    await db.createTask(memo({ name: 'Unrelated sibling in the same workspace', description: 'Rename the vitality memo headings.' }));
    const read = receipt(await admission(rewritten.id));
    expect(read.decision).toBe('needs_evidence');
    expect(read.reason).toBe(written);
    expect(rulingsConcerns(read)).toHaveLength(2);
    expect(read.hold_kind).toBe('contract_drift');
});

test('QA repair: an executor restoring Robert’s words after the rulings concern was adjudicated keeps that adjudication; a fresh rewrite is decided fresh', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } });
    expect(rewritten.status).toBe(200);
    expect(receipt(rewritten.data.task)).toMatchObject({ decision: 'needs_evidence', reason: expect.stringMatching(RULINGS_REASON) });
    expect(receipt(rewritten.data.task).hold_kind).toBeUndefined();
    const resolved = await api('POST', `/${task.id}/work-admission/resolve`, resolution(await admission(task.id), { reason: 'Reviewed the rewritten ruling; scope unchanged.' }), { key: runtimeKey });
    expect(resolved.status).toBe(200);
    expect(receipt(resolved.data).decision).toBe('new_work');
    const restored = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...resolved.data.antigravity_payload, operator_rulings: [RULING] } });
    expect(restored.status).toBe(200);
    const after = receipt(restored.data.task);
    expect(after).toMatchObject({ decision: 'new_work', resolved_at: receipt(resolved.data).resolved_at, resolution_carried_from: receipt(resolved.data).fingerprint });
    expect(rulingsConcerns(after)).toHaveLength(1);
    expect(after.rulings_changes.map(e => [e.outcome, e.restores_recorded === true])).toEqual([['held', false], ['held', true]]);
    // A fresh rewrite after that is a new concern, decided fresh.
    const again = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...restored.data.task.antigravity_payload, operator_rulings: ['Q: edited\nA: a third executor text'] } });
    expect(again.status).toBe(200);
    expect(receipt(again.data.task).decision).toBe('needs_evidence');
    expect(receipt(again.data.task).resolved_at).toBeUndefined();
    expect(rulingsConcerns(receipt(again.data.task))).toHaveLength(2);
});

test('QA repair: an authorized field addition keeps the baseline hash canonical, so later drift can still be returned', async () => {
    const payload = memoPayload(); delete payload.acceptance_criteria;
    const task = await approved(await db.createTask(memo({ status: 'in_progress', antigravity_payload: payload })));
    expect(receipt(task).contract.fields['payload.acceptance_criteria']).toBeUndefined();
    const criteria = ['The exact resulting revision is approved with a receipt.'];
    const added = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, acceptance_criteria: criteria }, contract_change: { origin: 'operator' } }, { key: operatorKey });
    expect(added.status).toBe(200);
    const baseline = receipt(added.data.task).contract;
    expect(baseline.version).toBe(2);
    expect(baseline.fields['payload.acceptance_criteria']).toMatch(/^[a-f0-9]{64}$/);
    // Stored fields are sorted and the stored hash is the digest of that sorted map, the same reading governedFields produces.
    expect(Object.keys(baseline.fields)).toEqual([...Object.keys(baseline.fields)].sort());
    expect(baseline.hash).toBe(sha(JSON.stringify(Object.fromEntries(Object.keys(baseline.fields).sort().map(k => [k, baseline.fields[k]])))));
    const drifted = await api('PATCH', `/${task.id}`, { description: 'Executor rewrote the description.' });
    expect(receipt(drifted.data.task).contract_hold.drifted_fields).toEqual(['description']);
    const returned = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: drifted.data.task.version, decision: 'return_to_authorized' }, { key: operatorKey });
    expect([returned.status, returned.data.code]).toEqual([200, undefined]);
    expect(returned.data.description).toBe(memo().description);
    expect(returned.data.antigravity_payload.acceptance_criteria).toEqual(criteria);
    expect(receipt(returned.data).contract.version).toBe(2);
    expect(receipt(returned.data).contract_hold).toBeUndefined();
    expect(receipt(returned.data).decision).toBe('new_work');
});

// ── QA repair round 4 (codex findings, 2026-10-04): Robert's authenticated additions and restorations are his decisions, whatever an executor did to the row ──
const NEW_RULING = 'Q: follow-up\nA: also record the approval receipt id in the walkthrough.  (answered by Robert)';
const SECOND_RULING = 'Q: which revision\nA: the latest delivered revision, 52c13935.  (answered inbox)';

test('QA repair: after a rewrite concern is adjudicated, Robert’s authenticated append grounds a relay that advances the baseline; the executor’s text still cannot', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } });
    expect([rewritten.status, receipt(rewritten.data.task).decision]).toEqual([200, 'needs_evidence']);
    const resolved = await api('POST', `/${task.id}/work-admission/resolve`, resolution(await admission(task.id), { reason: 'Reviewed the rewritten ruling; scope unchanged.' }), { key: runtimeKey });
    expect([resolved.status, receipt(resolved.data).decision]).toEqual([200, 'new_work']);
    // Robert appends a new ruling with his credential: an answer, recorded with its origin, no rulings change.
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...resolved.data.antigravity_payload, operator_rulings: [REWRITTEN_RULING, NEW_RULING] } }, { key: operatorKey });
    expect([appended.status, receipt(appended.data.task).decision]).toEqual([200, 'new_work']);
    expect(receipt(appended.data.task).operator_answers.at(-1)).toMatchObject({ index: 1, sha256: sha(NEW_RULING), origin: 'operator', requester: 'operator' });
    expect(receipt(appended.data.task).rulings_changes).toHaveLength(1);
    expect(rulingsConcerns(receipt(appended.data.task))).toHaveLength(1);
    // The runtime relays a prompt edit grounded in that appended ruling: verified, authorized, baseline advanced, adjudication kept.
    const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(appended.data.task, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relay.status, relay.data.code]).toEqual([200, undefined]);
    const after = receipt(relay.data.task);
    expect(after).toMatchObject({ decision: 'new_work', resolved_at: receipt(resolved.data).resolved_at, contract: { version: 2 } });
    expect(after.contract_changes.at(-1)).toMatchObject({ outcome: 'authorized', contract_version: 2,
        origin: { kind: 'operator_relayed', decision_ref: { verified: true, index: 1, sha256: sha(NEW_RULING), recorded_by: 'operator' } } });
    expect(rulingsConcerns(after)).toHaveLength(1);
    expect(relay.data.task.antigravity_payload.prompt).toBe(RULED_PROMPT);
    // The executor's text at index 0 is still not a decision Robert recorded, adjudicated or not.
    const forged = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...relay.data.task.antigravity_payload, prompt: 'Relayed from the executor’s text.' },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(relay.data.task, 0), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([forged.status, forged.data.code, forged.data.concern_key]).toEqual([409, 'decision_ref_under_review', rulingsConcerns(after)[0].key]);
    expect((await read(task.id)).antigravity_payload.prompt).toBe(RULED_PROMPT);
});

test('QA repair: while a rewrite is still under review, Robert’s appended answer is an authenticated addition a relay may cite; the rewrite stays held and an executor’s own append grounds nothing', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } });
    expect(rewritten.status).toBe(200);
    const concernKey = rulingsConcerns(receipt(rewritten.data.task))[0].key;
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...rewritten.data.task.antigravity_payload, operator_rulings: [REWRITTEN_RULING, NEW_RULING] } }, { key: operatorKey });
    expect(appended.status).toBe(200);
    const held = receipt(appended.data.task);
    // His answer decides nothing about the executor's text: the concern stays, and nothing was recorded as a rulings change.
    expect([held.decision, held.reason]).toEqual(['needs_evidence', expect.stringMatching(RULINGS_REASON)]);
    expect(rulingsConcerns(held)).toHaveLength(1);
    expect(held.rulings_changes).toHaveLength(1);
    expect(held.operator_answers.at(-1)).toMatchObject({ index: 1, sha256: sha(NEW_RULING), origin: 'operator' });
    const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(appended.data.task, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relay.status, relay.data.code]).toEqual([200, undefined]);
    const after = receipt(relay.data.task);
    expect(after.contract.version).toBe(2);
    expect(after.contract_changes.at(-1)).toMatchObject({ outcome: 'authorized', origin: { kind: 'operator_relayed', decision_ref: { verified: true, index: 1, recorded_by: 'operator' } } });
    expect([after.decision, after.reason]).toEqual(['needs_evidence', expect.stringMatching(RULINGS_REASON)]);
    expect(rulingsConcerns(after)).toHaveLength(1);
    expect(after.contract_hold).toBeUndefined();
    expect(receipt(await admission(task.id)).reason).toBe(after.reason);
    // An executor appending its own text is recorded as such, and a relay grounded in it is refused while the rewrite is under review.
    const EXECUTOR_APPEND = 'Q: executor note\nA: appended by the executor';
    const executorAppend = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...relay.data.task.antigravity_payload, operator_rulings: [REWRITTEN_RULING, NEW_RULING, EXECUTOR_APPEND] } });
    expect(executorAppend.status).toBe(200);
    expect(receipt(executorAppend.data.task).operator_answers.at(-1)).toMatchObject({ index: 2, sha256: sha(EXECUTOR_APPEND), origin: 'unverified', requester: 'unauthenticated' });
    const forged = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...executorAppend.data.task.antigravity_payload, prompt: 'Relayed from the executor’s appended text.' },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(executorAppend.data.task, 2), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([forged.status, forged.data.code, forged.data.concern_key]).toEqual([409, 'decision_ref_under_review', concernKey]);
    // The runtime appending Robert's answer, as Praxis does for an inbox or questionnaire reply, is vouched for by its credential, as it always was.
    const RUNTIME_APPEND = 'Q: deadline\nA: ship it before the Friday review.  (inbox answer relayed by Praxis)';
    const runtimeAppend = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...executorAppend.data.task.antigravity_payload, operator_rulings: [REWRITTEN_RULING, NEW_RULING, EXECUTOR_APPEND, RUNTIME_APPEND] } }, { key: runtimeKey });
    expect(runtimeAppend.status).toBe(200);
    expect(receipt(runtimeAppend.data.task).operator_answers.at(-1)).toMatchObject({ index: 3, sha256: sha(RUNTIME_APPEND), origin: 'runtime', requester: 'runtime' });
    const relayedAgain = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...runtimeAppend.data.task.antigravity_payload, prompt: `${RULED_PROMPT}\nShip before the Friday review.` },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(runtimeAppend.data.task, 3), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relayedAgain.status, receipt(relayedAgain.data.task).contract.version]).toEqual([200, 3]);
    expect(receipt(relayedAgain.data.task).contract_changes.at(-1)).toMatchObject({ outcome: 'authorized', origin: { kind: 'operator_relayed', decision_ref: { verified: true, index: 3, recorded_by: 'runtime' } } });
    expect(rulingsConcerns(receipt(relayedAgain.data.task))).toHaveLength(1);
});

test('QA repair: an executor removing every ruling is held; Robert restoring his words with the operator credential clears exactly that concern and records the authorization, on write and on read', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const removed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [] } });
    expect(removed.status).toBe(200);
    const held = receipt(removed.data.task);
    expect([held.decision, held.reason]).toEqual(['needs_evidence', expect.stringMatching(RULINGS_REASON)]);
    expect(held.hold_kind).toBeUndefined();
    expect(rulingsConcerns(held)).toHaveLength(1);
    expect(rulingsConcerns(held)[0]).toMatchObject({ recorded: [sha(RULING)], rewritten: [], origin: 'unverified' });
    expect(receipt(await admission(task.id)).decision).toBe('needs_evidence');
    const restored = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...removed.data.task.antigravity_payload, operator_rulings: [RULING] } }, { key: operatorKey });
    expect(restored.status).toBe(200);
    expect(restored.data.task.antigravity_payload.operator_rulings).toEqual([RULING]);
    const after = receipt(restored.data.task);
    expect(after.decision).toBe('new_work');
    expect(rulingsConcerns(after)).toHaveLength(0);
    expect(after.rulings_changes.map(e => e.outcome)).toEqual(['held', 'authorized']);
    expect(after.rulings_changes.at(-1)).toMatchObject({ restores_recorded: true, cleared_concern_keys: [rulingsConcerns(held)[0].key], before: [], after: [sha(RULING)],
        origin: { kind: 'operator', authority: 'operator_credential', requester: 'operator' } });
    const read = receipt(await admission(task.id));
    expect([read.decision, rulingsConcerns(read).length]).toEqual(['new_work', 0]);
});

test('QA repair: Robert’s restoration clears the rulings concern but not an independent drift hold, also when the executor dropped only his latest ruling', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress', antigravity_payload: { ...memoPayload(), operator_rulings: [RULING, SECOND_RULING] } })));
    const drifted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, prompt: 'Executor rewrite.' } });
    expect(drifted.status).toBe(200);
    const dropped = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...drifted.data.task.antigravity_payload, operator_rulings: [RULING] } });
    expect(dropped.status).toBe(200);
    const held = receipt(dropped.data.task);
    expect(held.reason).toMatch(/Contract changed during execution/);
    expect(held.reason).toMatch(RULINGS_REASON);
    expect(rulingsConcerns(held)[0]).toMatchObject({ recorded: [sha(RULING), sha(SECOND_RULING)], rewritten: [sha(RULING)] });
    const restored = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...dropped.data.task.antigravity_payload, operator_rulings: [RULING, SECOND_RULING] } }, { key: operatorKey });
    expect(restored.status).toBe(200);
    const after = receipt(restored.data.task);
    expect(rulingsConcerns(after)).toHaveLength(0);
    expect(after.rulings_changes.map(e => e.outcome)).toEqual(['held', 'authorized']);
    expect(after.rulings_changes.at(-1)).toMatchObject({ restores_recorded: true, cleared_concern_keys: [rulingsConcerns(held)[0].key] });
    // The prompt drift is a separate matter: still held, now with the drift reason alone, on write and on read.
    expect(after.hold_kind).toBe('contract_drift');
    expect(after.contract_hold.drifted_fields).toEqual(['payload.prompt']);
    expect(after.decision).toBe('needs_evidence');
    expect(after.reason).toMatch(/Contract changed during execution/);
    expect(after.reason).not.toMatch(RULINGS_REASON);
    const read = receipt(await admission(task.id));
    expect([read.decision, read.reason, rulingsConcerns(read).length]).toEqual(['needs_evidence', after.reason, 0]);
    const approve = await api('POST', `/${task.id}/work-admission/contract`, { expected_task_version: restored.data.task.version, decision: 'approve', change_ids: after.contract_hold.change_ids }, { key: operatorKey });
    expect([approve.status, receipt(approve.data).decision, receipt(approve.data).contract.version]).toEqual([200, 'new_work', 2]);
    expect(receipt(approve.data).contract_hold).toBeUndefined();
});

test('QA repair: an answer Robert appended and later replaced himself does not become his again because an executor put it back; restoring his current words clears the concern', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [RULING, NEW_RULING] } }, { key: operatorKey });
    expect(appended.status).toBe(200);
    expect(receipt(appended.data.task).operator_answers.at(-1)).toMatchObject({ index: 1, sha256: sha(NEW_RULING), origin: 'operator' });
    const AMENDED = `${NEW_RULING}\nAmended by Robert: record the receipt id and the revision hash.`;
    const amended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload, operator_rulings: [RULING, AMENDED] } }, { key: operatorKey });
    expect([amended.status, receipt(amended.data.task).decision]).toEqual([200, 'new_work']);
    expect(rulingsConcerns(receipt(amended.data.task))).toHaveLength(0);
    // The executor puts the superseded text back: a rewrite of his current words, held.
    const resurrected = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...amended.data.task.antigravity_payload, operator_rulings: [RULING, NEW_RULING] } });
    expect(resurrected.status).toBe(200);
    const concern = rulingsConcerns(receipt(resurrected.data.task))[0];
    expect(concern).toMatchObject({ recorded: [sha(RULING), sha(AMENDED)], rewritten: [sha(RULING), sha(NEW_RULING)] });
    expect(receipt(resurrected.data.task).decision).toBe('needs_evidence');
    // The stale answer entry for that text predates the review: it vouches for nothing.
    const forged = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...resurrected.data.task.antigravity_payload, prompt: 'Relayed from the resurrected text.' },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(resurrected.data.task, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([forged.status, forged.data.code, forged.data.concern_key]).toEqual([409, 'decision_ref_under_review', concern.key]);
    // Robert restores his current words: cleared as a restoration, and his amended ruling grounds a relay again.
    const restored = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...resurrected.data.task.antigravity_payload, operator_rulings: [RULING, AMENDED] } }, { key: operatorKey });
    expect(restored.status).toBe(200);
    expect(rulingsConcerns(receipt(restored.data.task))).toHaveLength(0);
    expect(receipt(restored.data.task).rulings_changes.map(e => [e.outcome, e.restores_recorded === true])).toEqual([['held', false], ['authorized', true]]);
    const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...restored.data.task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(restored.data.task, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relay.status, receipt(relay.data.task).contract.version, receipt(relay.data.task).decision]).toEqual([200, 2, 'new_work']);
});

test('QA repair: an executor putting Robert’s words back onto the row it emptied is recorded as the restore, appends nothing of its own, and clears nothing', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const removed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [] } });
    expect(removed.status).toBe(200);
    const concernKey = rulingsConcerns(receipt(removed.data.task))[0].key;
    const putBack = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...removed.data.task.antigravity_payload, operator_rulings: [RULING] } });
    expect(putBack.status).toBe(200);
    const after = receipt(putBack.data.task);
    expect([after.decision, after.reason]).toEqual(['needs_evidence', expect.stringMatching(RULINGS_REASON)]);
    expect(rulingsConcerns(after)).toHaveLength(1);
    expect(after.rulings_changes.map(e => [e.outcome, e.restores_recorded === true, e.concern_key])).toEqual([['held', false, concernKey], ['held', true, concernKey]]);
    expect(after.operator_answers).toBeUndefined();
    expect(receipt(await admission(task.id)).decision).toBe('needs_evidence');
    // Evidence adjudicates it; a relay grounded in his recorded words then verifies, with no answer provenance to echo.
    const resolved = await api('POST', `/${task.id}/work-admission/resolve`, resolution(await admission(task.id), { reason: 'Reviewed the removal and restoration; scope unchanged.' }), { key: runtimeKey });
    expect([resolved.status, receipt(resolved.data).decision]).toEqual([200, 'new_work']);
    const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...resolved.data.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(resolved.data, 0), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relay.status, receipt(relay.data.task).decision, receipt(relay.data.task).contract.version]).toEqual([200, 'new_work', 2]);
    expect(receipt(relay.data.task).contract_changes.at(-1).origin.decision_ref.recorded_by).toBeUndefined();
});

test('QA repair: Robert deleting only his own later answer leaves the executor’s text and its concern in place; changing that text himself clears it', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } });
    expect(rewritten.status).toBe(200);
    const concernKey = rulingsConcerns(receipt(rewritten.data.task))[0].key;
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...rewritten.data.task.antigravity_payload, operator_rulings: [REWRITTEN_RULING, NEW_RULING] } }, { key: operatorKey });
    expect(appended.status).toBe(200);
    const deleted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } }, { key: operatorKey });
    expect(deleted.status).toBe(200);
    const still = receipt(deleted.data.task);
    expect([still.decision, rulingsConcerns(still).length, still.rulings_changes.length]).toEqual(['needs_evidence', 1, 1]);
    expect(still.reason).toMatch(RULINGS_REASON);
    expect(receipt(await admission(task.id)).decision).toBe('needs_evidence');
    const his = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...deleted.data.task.antigravity_payload, operator_rulings: [`${RULING}\nClarified by Robert.`] } }, { key: operatorKey });
    expect(his.status).toBe(200);
    expect(rulingsConcerns(receipt(his.data.task))).toHaveLength(0);
    expect(receipt(his.data.task).rulings_changes.map(e => e.outcome)).toEqual(['held', 'authorized']);
    expect(receipt(his.data.task).rulings_changes.at(-1)).toMatchObject({ cleared_concern_keys: [concernKey] });
    expect(receipt(his.data.task).rulings_changes.at(-1).restores_recorded).toBeUndefined();
    expect(receipt(his.data.task).decision).toBe('new_work');
});

test('QA lifecycle: an authenticated amendment during an unrelated rewrite concern supersedes the old answer without approving the rewrite', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    let row = task;
    async function edit(rulings, key) {
        const result = await api('PATCH', `/${task.id}`, { expected_version: row.version,
            antigravity_payload: { ...row.antigravity_payload, operator_rulings: rulings } }, { key });
        expect(result.status).toBe(200);
        row = result.data.task;
    }
    async function relay(prompt) {
        return api('PATCH', `/${task.id}`, { expected_version: row.version,
            antigravity_payload: { ...row.antigravity_payload, prompt },
            contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(row, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    }
    await edit([REWRITTEN_RULING]);
    const originalConcern = rulingsConcerns(receipt(row))[0];
    await edit([REWRITTEN_RULING, NEW_RULING], operatorKey);
    const originalAnswers = receipt(row).operator_answers;
    const amended = `${NEW_RULING}\nAmended by Robert: use the new scope.`;
    await edit([REWRITTEN_RULING, amended], operatorKey);
    const amendmentVersion = row.version;
    const current = await relay('Scope from the current amended instruction');
    expect([current.status, current.data.code]).toEqual([200, undefined]);
    row = current.data.task;
    expect(receipt(row).contract.version).toBe(2);
    expect(receipt(row).contract_hold).toBeUndefined();
    expect(receipt(row).decision).toBe('needs_evidence');
    expect(rulingsConcerns(receipt(row))).toEqual([originalConcern]);
    expect(receipt(row).operator_answers.slice(0, originalAnswers.length)).toEqual(originalAnswers);
    expect(receipt(row).operator_answers.at(-1)).toMatchObject({ index: 1, sha256: sha(amended),
        previous_sha256: sha(NEW_RULING), origin: 'operator', authority: 'operator_credential', task_version: amendmentVersion - 1 });
    expect(receipt(row).contract_changes.at(-1).origin.decision_ref).toMatchObject({ sha256: sha(amended), recorded_by: 'operator' });
    const replay = await relay(row.antigravity_payload.prompt);
    expect([replay.status, receipt(replay.data.task).contract.version]).toEqual([200, 2]);
    row = replay.data.task;
    await edit([REWRITTEN_RULING, NEW_RULING]);
    const beforeRefusal = await read(task.id);
    const stale = await relay('Scope from the superseded instruction');
    expect([stale.status, stale.data.code]).toEqual([409, 'decision_ref_under_review']);
    expect(await read(task.id)).toEqual(beforeRefusal);
    expect(receipt(await admission(task.id)).contract.version).toBe(2);
    // A later authenticated amendment must not clear the older concern about E.
    await edit([REWRITTEN_RULING, `${amended}\nFurther clarified.`], operatorKey);
    expect(rulingsConcerns(receipt(row))).toContainEqual(originalConcern);
    expect(receipt(row).decision).toBe('needs_evidence');
    const clarified = await relay('Scope from the further clarification');
    expect([clarified.status, receipt(clarified.data.task).contract.version]).toEqual([200, 3]);
    expect(rulingsConcerns(receipt(clarified.data.task))).toContainEqual(originalConcern);
});

test('QA lifecycle: an authenticated deletion supersedes an answer even if an executor appends its old text again', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload, operator_rulings: [REWRITTEN_RULING] } });
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...rewritten.data.task.antigravity_payload,
        operator_rulings: [REWRITTEN_RULING, NEW_RULING] } }, { key: operatorKey });
    const deleted = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload,
        operator_rulings: [REWRITTEN_RULING] } }, { key: operatorKey });
    expect(deleted.status).toBe(200);
    expect(receipt(deleted.data.task).operator_answers.at(-1)).toMatchObject({ index: 1, sha256: null,
        previous_sha256: sha(NEW_RULING), origin: 'operator' });
    const restored = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...deleted.data.task.antigravity_payload,
        operator_rulings: [REWRITTEN_RULING, NEW_RULING] } });
    expect(restored.status).toBe(200);
    const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...restored.data.task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(restored.data.task, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relay.status, relay.data.code]).toEqual([409, 'decision_ref_under_review']);
    expect(receipt(await admission(task.id)).contract.version).toBe(1);
});

test('QA lifecycle: resume preserves an amended authorization, while executor drift in the resume write is held', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const suspended = await api('PATCH', `/${task.id}`, { status: 'suspended' });
    expect(suspended.status).toBe(200);
    const amendment = `${RULING}\nRobert: use the amended scope on resume.`;
    const amended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...suspended.data.task.antigravity_payload,
        operator_rulings: [amendment] } }, { key: operatorKey });
    expect(amended.status).toBe(200);
    const body = { antigravity_payload: { ...amended.data.task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(amended.data.task), fields: ['payload.prompt'] } };
    const relayed = await api('PATCH', `/${task.id}`, body, { key: runtimeKey });
    expect([relayed.status, receipt(relayed.data.task).contract.version]).toEqual([200, 2]);
    const resumed = await api('PATCH', `/${task.id}`, { status: 'in_progress' });
    expect([resumed.status, receipt(resumed.data.task).decision]).toEqual([200, 'new_work']);
    const replay = await api('PATCH', `/${task.id}`, body, { key: runtimeKey });
    expect([replay.status, receipt(replay.data.task).contract.version]).toEqual([200, 2]);
    expect(receipt(replay.data.task).operator_answers).toEqual(receipt(amended.data.task).operator_answers);
    expect(receipt(replay.data.task).contract_changes).toHaveLength(1);
    await api('PATCH', `/${task.id}`, { status: 'suspended' });
    const drift = await api('PATCH', `/${task.id}`, { status: 'in_progress',
        antigravity_payload: { ...replay.data.task.antigravity_payload, prompt: 'Executor scope change on resume.' } });
    expect(drift.status).toBe(200);
    expect(receipt(drift.data.task)).toMatchObject({ hold_kind: 'contract_drift', contract: { version: 2 } });
    expect(receipt(drift.data.task).contract_changes.at(-1).execution).toMatchObject({ phase: 'executing', status: 'suspended', next_status: 'in_progress' });
});

test('QA lifecycle: amending an answer already present before the executor rewrite leaves the unrelated concern intact', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload,
        operator_rulings: [RULING, NEW_RULING] } }, { key: operatorKey });
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload,
        operator_rulings: [REWRITTEN_RULING, NEW_RULING] } });
    expect(rewritten.status).toBe(200);
    const amended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...rewritten.data.task.antigravity_payload,
        operator_rulings: [REWRITTEN_RULING, `${NEW_RULING}\nAmended by Robert.`] } }, { key: operatorKey });
    expect(amended.status).toBe(200);
    expect(rulingsConcerns(receipt(amended.data.task))).toEqual(rulingsConcerns(receipt(rewritten.data.task)));
    expect(receipt(amended.data.task).decision).toBe('needs_evidence');
    const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...amended.data.task.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(amended.data.task, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relay.status, receipt(relay.data.task).contract.version, receipt(relay.data.task).decision]).toEqual([200, 2, 'needs_evidence']);
});

test('QA lifecycle: partially correcting a multi-index rewrite preserves the remaining concern until Robert addresses every affected index', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload,
        operator_rulings: [RULING, NEW_RULING] } }, { key: operatorKey });
    const rewritten = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload,
        operator_rulings: [REWRITTEN_RULING, 'Executor second rewrite.'] } });
    expect(rewritten.status).toBe(200);
    const partial = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...rewritten.data.task.antigravity_payload,
        operator_rulings: [`${RULING}\nRobert clarified it.`, 'Executor second rewrite.'] } }, { key: operatorKey });
    expect(partial.status).toBe(200);
    expect(rulingsConcerns(receipt(partial.data.task))).toEqual(rulingsConcerns(receipt(rewritten.data.task)));
    expect(receipt(partial.data.task).decision).toBe('needs_evidence');
    // His first correction remains authorized; he need not edit it again to resolve the rest.
    const finished = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...partial.data.task.antigravity_payload,
        operator_rulings: [`${RULING}\nRobert clarified it.`] } }, { key: operatorKey });
    expect(finished.status).toBe(200);
    expect(rulingsConcerns(receipt(finished.data.task))).toEqual([]);
    expect(receipt(finished.data.task).decision).toBe('new_work');
    expect(receipt(finished.data.task).rulings_changes.at(-1).cleared_concern_keys).toEqual(rulingsConcerns(receipt(rewritten.data.task)).map(c => c.key));
});

async function checkIndependentRulingConcerns(restoreOriginal) {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    let row = task;
    async function edit(rulings, key) {
        const result = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...row.antigravity_payload, operator_rulings: rulings } }, { key });
        expect(result.status).toBe(200);
        row = result.data.task;
    }
    if (!restoreOriginal) await edit([RULING, NEW_RULING, SECOND_RULING], operatorKey);
    await edit(restoreOriginal ? [REWRITTEN_RULING] : [REWRITTEN_RULING, NEW_RULING, SECOND_RULING]);
    if (restoreOriginal) await edit([REWRITTEN_RULING, NEW_RULING, SECOND_RULING], operatorKey);
    const amendment = `${NEW_RULING}\nRobert's current amendment.`;
    await edit([REWRITTEN_RULING, amendment, SECOND_RULING], operatorKey);
    const answers = receipt(row).operator_answers;
    // Ensure a distinct timestamp so a time-based check cannot pass by accident.
    await new Promise(resolve => setTimeout(resolve, 5));
    await edit([REWRITTEN_RULING, amendment, 'Executor unrelated third rewrite.']);
    const laterConcern = rulingsConcerns(receipt(row)).at(-1);
    await edit([restoreOriginal ? RULING : `${RULING}\nRobert's clarification.`, amendment, 'Executor unrelated third rewrite.'], operatorKey);
    expect(rulingsConcerns(receipt(row))).toEqual([laterConcern]);
    expect(receipt(row).decision).toBe('needs_evidence');
    expect(receipt(row).operator_answers.filter(a => a.index === 1)).toEqual(answers.filter(a => a.index === 1));
    const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...row.antigravity_payload, prompt: RULED_PROMPT },
        contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(row, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    expect([relay.status, relay.data.code]).toEqual([200, undefined]);
    expect(receipt(relay.data.task).contract.version).toBe(2);
    expect(rulingsConcerns(receipt(await admission(task.id)))).toEqual([laterConcern]);
}

test('QA lifecycle: clearing an older concern never invalidates an unchanged authenticated amendment', () => checkIndependentRulingConcerns(false));
test('QA lifecycle: restoring the original prefix never authorizes a later unrelated executor rewrite', () => checkIndependentRulingConcerns(true));

test('optional review: refusals distinguish executor text from authenticated amendments and removal tombstones', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    let row = task;
    async function edit(rulings, key) {
        const result = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...row.antigravity_payload, operator_rulings: rulings } }, { key });
        expect(result.status).toBe(200);
        row = result.data.task;
    }
    async function refusal() {
        const result = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...row.antigravity_payload, prompt: RULED_PROMPT },
            contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(row, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
        expect([result.status, result.data.code]).toEqual([409, 'decision_ref_under_review']);
        return result.data.error;
    }
    await edit([RULING, NEW_RULING], operatorKey);
    await edit([RULING, REWRITTEN_RULING]);
    expect(await refusal()).toMatch(/written by an unverified source and is under review/);
    await edit([RULING, `${NEW_RULING}\nAmended by Robert.`], operatorKey);
    await edit([RULING, NEW_RULING]);
    expect(await refusal()).toMatch(/superseded by an authenticated amendment or removal/);
    await edit([RULING], operatorKey);
    // Reordering into the removed slot is not an authenticated append.
    await edit([SECOND_RULING, NEW_RULING]);
    expect(await refusal()).toMatch(/superseded by an authenticated amendment or removal/);
    // An unverified append is the latest audit entry: report that source instead.
    await edit([SECOND_RULING]);
    await edit([SECOND_RULING, NEW_RULING]);
    expect(await refusal()).toMatch(/written by an unverified source and is under review/);
});

test('optional review: a legacy unaudited amendment is refused until an actual authenticated edit records its provenance', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload,
        operator_rulings: [RULING, NEW_RULING] } }, { key: operatorKey });
    expect(appended.status).toBe(200);
    const legacyText = `${NEW_RULING}\nLegacy amendment by Robert.`;
    // Synthetic pre-upgrade state: the append was audited, but the amendment was not.
    const legacyReceipt = receipt(appended.data.task);
    legacyReceipt.operator_answers = legacyReceipt.operator_answers.map(({ task_version, previous_sha256, authority, ...entry }) => entry);
    raw.prepare('UPDATE work_admissions SET document = ? WHERE task_id = ?').run(JSON.stringify(legacyReceipt), task.id);
    raw.prepare('UPDATE tasks SET antigravity_payload = ? WHERE id = ?').run(JSON.stringify({ ...appended.data.task.antigravity_payload,
        operator_rulings: [RULING, legacyText] }), task.id);
    async function relay(row) {
        return api('PATCH', `/${task.id}`, { antigravity_payload: { ...row.antigravity_payload, prompt: RULED_PROMPT },
            contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(row, 1), fields: ['payload.prompt'] } }, { key: runtimeKey });
    }
    const before = await read(task.id);
    const refused = await relay(before);
    expect([refused.status, refused.data.code]).toEqual([409, 'decision_ref_under_review']);
    expect(await read(task.id)).toEqual(before);
    const unchanged = await api('PATCH', `/${task.id}`, { antigravity_payload: before.antigravity_payload }, { key: operatorKey });
    expect(unchanged.status).toBe(200);
    expect(receipt(unchanged.data.task).operator_answers).toEqual(legacyReceipt.operator_answers);
    expect((await relay(unchanged.data.task)).status).toBe(409);
    const edited = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...before.antigravity_payload,
        operator_rulings: [RULING, `${legacyText}\nClarification: include the revision hash.`] } }, { key: operatorKey });
    expect(edited.status).toBe(200);
    const accepted = await relay(edited.data.task);
    expect([accepted.status, receipt(accepted.data.task).contract.version]).toEqual([200, 2]);
    expect(receipt(accepted.data.task).operator_answers.at(-1)).toMatchObject({ origin: 'operator', previous_sha256: sha(legacyText) });
});

test('optional review: executor reordering cannot move answer authority to either index', async () => {
    const task = await approved(await db.createTask(memo({ status: 'in_progress' })));
    const appended = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...task.antigravity_payload,
        operator_rulings: [RULING, NEW_RULING] } }, { key: operatorKey });
    expect(appended.status).toBe(200);
    const reordered = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...appended.data.task.antigravity_payload,
        operator_rulings: [NEW_RULING, REWRITTEN_RULING] } });
    expect(reordered.status).toBe(200);
    const before = await read(task.id);
    for (const index of [0, 1]) {
        const relay = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...before.antigravity_payload, prompt: RULED_PROMPT },
            contract_change: { origin: 'operator_relayed', decision_ref: rulingRef(before, index), fields: ['payload.prompt'] } }, { key: runtimeKey });
        expect([relay.status, relay.data.code]).toEqual([409, 'decision_ref_under_review']);
        expect(relay.data.error).toMatch(/written by an unverified source and is under review/);
        expect(await read(task.id)).toEqual(before);
    }
});
