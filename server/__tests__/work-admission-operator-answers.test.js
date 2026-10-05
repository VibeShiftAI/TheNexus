// Robert's answer to an executor question must not, by itself, put approved
// work back on an admission hold (task 444a0be0, incident 7bf1a379 on
// 2026-09-29: the answer PATCH re-held a new_work task as "Proposal contract
// changed" and it needed a manual evidence resolution before dispatch).
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { createHash } = require('crypto');
const Database = require('better-sqlite3');

const runtimeKey = 'synthetic-answer-runtime-key-1234567890';
const operatorKey = 'synthetic-answer-operator-key-1234567890';
let db, raw, server, base, dir;
// Shape of the Groundrules task payload before the answer (keys read from the
// live row: prompt, workspace, acceptance_criteria, binding_constraints, binding_constraints_text).
const groundrulesPayload = () => ({
    prompt: 'Publish the existing Groundrules.club coming-soon page live on its domain.',
    workspace: '/tmp/synthetic-groundrules',
    acceptance_criteria: ['groundrules.club serves the coming-soon page over HTTPS.'],
    binding_constraints: [{ id: 'BC-WORKSPACE', generated: true, text: 'Generated workspace rule' }],
    binding_constraints_text: 'Generated workspace rule',
});
const groundrules = (extra = {}) => ({ project_id: 'g', name: 'Publish the existing Groundrules.club coming-soon page live', source: 'praxis-agent',
    description: 'Deploy the splash page to groundrules.club and verify public HTTPS.', antigravity_payload: groundrulesPayload(), ...extra });
const ANSWER = 'Q: Is groundrules.club already registered in another registrar account? If so, which account? Otherwise, please register it and confirm when ready.\nA: I just purchased it through Cloudflare under vibeshiftai  (answered from the inbox)';
const SECOND = 'Q: Which Cloudflare zone should the page use?\nA: The vibeshiftai account zone for groundrules.club  (answered from the inbox)';

async function api(method, suffix, body, key) {
    const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
}
const receipt = task => task.metadata.work_admission;
const resolution = (task, extra = {}) => ({ expected_task_version: task.version, fingerprint: receipt(task).fingerprint,
    checked_at: receipt(task).checked_at, decision: 'new_work', reason: 'Reviewed: distinct remaining deployment.',
    matched_tasks: receipt(task).matches.map(m => ({ task_id: m.task_id, task_version: m.task_version })),
    evidence: [{ ref: 'review:synthetic', hash: 'b'.repeat(64) }], ...extra });
// Exactly what Praxis recordOperatorRuling sends: the read payload with the
// stamped ruling appended (src/orchestrator/operator-ruling.ts:152-161).
async function recordRuling(taskId, ruling) {
    const task = (await api('GET', `/${taskId}`)).data;
    const payload = { ...task.antigravity_payload };
    const existing = (payload.operator_rulings || []).filter(e => typeof e === 'string' && e.trim()).map(e => e.trim());
    if (existing.includes(ruling)) return task;
    payload.operator_rulings = [...existing, ruling];
    const patched = await api('PATCH', `/${taskId}`, { antigravity_payload: payload });
    expect(patched.status).toBe(200);
    return patched.data.task;
}
const admission = async id => (await api('GET', `/${id}/work-admission`)).data;
async function approved(task) {
    const read = await admission(task.id);
    if (receipt(read).decision === 'new_work' && !receipt(read).matches.length) return read;
    const resolved = await api('POST', `/${task.id}/work-admission/resolve`, resolution(read), runtimeKey);
    expect(resolved.status).toBe(200);
    return resolved.data;
}

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-answer-admission-'));
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
    raw.prepare("INSERT INTO projects (id,name,path) VALUES ('g','Groundrules','/tmp/synthetic-groundrules')").run();
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close();
    delete process.env.NEXUS_DB_PATH; delete process.env.NEXUS_OPERATOR_APPROVAL_KEY; delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
});

test('Groundrules reproduction: an answer-only PATCH keeps approved admission and the answer stays deliverable', async () => {
    const task = await approved(await db.createTask(groundrules()));
    expect(receipt(task).decision).toBe('new_work');
    const answered = await recordRuling(task.id, ANSWER);
    expect(receipt(answered).decision).toBe('new_work');
    expect(receipt(answered).reason).not.toMatch(/Proposal contract changed/);
    expect(receipt(answered).fingerprint).toBe(receipt(task).fingerprint);
    // The dispatch-time refresh Praxis performs (checkWorkAdmission) still admits it.
    const refreshed = await admission(task.id);
    expect(receipt(refreshed).decision).toBe('new_work');
    expect(receipt(refreshed).fingerprint).toBe(receipt(task).fingerprint);
    // Executor brief and QA contract read the ruling from the task payload.
    expect(refreshed.antigravity_payload.operator_rulings).toEqual([ANSWER]);
    expect((await api('GET', `/${task.id}`)).data.antigravity_payload.operator_rulings).toEqual([ANSWER]);
    // Provenance: the receipt records that an answer arrived after the decision.
    expect(receipt(refreshed).operator_answers).toEqual([expect.objectContaining({ index: 0,
        sha256: createHash('sha256').update(ANSWER.trim()).digest('hex'), recorded_at: expect.any(String) })]);
});

test('an evidence-resolved receipt stays resolved after an answer', async () => {
    await db.createTask(groundrules({ name: 'Groundrules splash deployment', description: 'Deploy the splash page to groundrules.club and verify public HTTPS before launch.' }));
    const created = await db.createTask(groundrules());
    expect(receipt(created).decision).toBe('needs_evidence');
    const resolved = await approved(created);
    expect(receipt(resolved).resolved_at).toBeTruthy();
    await recordRuling(created.id, ANSWER);
    const refreshed = await admission(created.id);
    expect(receipt(refreshed).decision).toBe('new_work');
    expect(receipt(refreshed).resolved_at).toBe(receipt(resolved).resolved_at);
});

test('repeated and duplicate answers keep full ordered provenance without a hold', async () => {
    const task = await approved(await db.createTask(groundrules()));
    await recordRuling(task.id, ANSWER);
    await recordRuling(task.id, ANSWER); // a retried resolution writes nothing new
    const resent = await api('PATCH', `/${task.id}`, { antigravity_payload: (await api('GET', `/${task.id}`)).data.antigravity_payload });
    expect(receipt(resent.data.task).operator_answers).toHaveLength(1); // identical payload re-PATCH adds no answer
    await recordRuling(task.id, SECOND);
    const refreshed = await admission(task.id);
    expect(receipt(refreshed).decision).toBe('new_work');
    expect(refreshed.antigravity_payload.operator_rulings).toEqual([ANSWER, SECOND]);
    expect(receipt(refreshed).operator_answers.map(a => a.index)).toEqual([0, 1]);
    // A lost-response create retry still returns the one canonical task.
    const retry = await db.createTask(groundrules());
    expect(retry.id).toBe(task.id);
    expect(raw.prepare('SELECT count(*) AS n FROM tasks').get().n).toBe(1);
});

// Robert's rule (task 9021f20d, 2026-10-04): an unverified scope, acceptance
// or workspace change is held only while the task is executing. Before
// execution it is recorded, with or without an answer, and admission compares
// the edited contract at dispatch. The full matrix lives in
// work-admission-contract-origin.test.js.
test('real scope, acceptance and workspace changes are held during execution, with or without an answer', async () => {
    const edits = [
        payload => ({ antigravity_payload: { ...payload, operator_rulings: [ANSWER], prompt: 'Also launch a paid membership checkout.' } }),
        payload => ({ antigravity_payload: { ...payload, acceptance_criteria: ['Checkout accepts payments.'] } }),
        payload => ({ antigravity_payload: { ...payload, operator_rulings: [ANSWER], workspace: '/tmp/synthetic-other' } }),
        () => ({ description: 'Build the members area instead.' }),
    ];
    for (const edit of edits) {
        raw.exec('DELETE FROM tasks');
        const task = await approved(await db.createTask(groundrules({ status: 'in_progress' })));
        const changed = await api('PATCH', `/${task.id}`, edit(task.antigravity_payload));
        expect(changed.status).toBe(200);
        expect(receipt(changed.data.task).decision).toBe('needs_evidence');
        expect(receipt(changed.data.task).hold_kind).toBe('contract_drift');
        expect(receipt(changed.data.task).contract_hold.drifted_fields.length).toBeGreaterThan(0);
        // The appended answer is still recorded as an answer alongside the hold.
        if (edit(task.antigravity_payload).antigravity_payload?.operator_rulings) expect(receipt(changed.data.task).operator_answers).toHaveLength(1);
    }
    raw.exec('DELETE FROM tasks');
    const pending = await approved(await db.createTask(groundrules()));
    const recorded = await api('PATCH', `/${pending.id}`, { description: 'Build the members area instead.' });
    expect(receipt(recorded.data.task).decision).toBe('new_work');
    expect(receipt(recorded.data.task).contract_changes.at(-1)).toMatchObject({ outcome: 'recorded', execution: { phase: 'before_execution' } });
});

test('rewriting or removing a recorded answer is not an answer and still requires review', async () => {
    for (const rewrite of [[], ['Q: Is the domain registered?\nA: Also add a members area.'], [SECOND, ANSWER]]) {
        raw.exec('DELETE FROM tasks');
        const task = await approved(await db.createTask(groundrules()));
        await recordRuling(task.id, ANSWER);
        await recordRuling(task.id, SECOND);
        const current = (await api('GET', `/${task.id}`)).data;
        const changed = await api('PATCH', `/${task.id}`, { antigravity_payload: { ...current.antigravity_payload, operator_rulings: rewrite } });
        expect(receipt(changed.data.task).decision).toBe('needs_evidence');
        expect(receipt(changed.data.task).reason).toMatch(/operator rulings were rewritten or removed/);
        expect(receipt(changed.data.task).operator_answers).toHaveLength(2);
    }
});

test('an answer never clears a pre-existing hold or duplicate concern', async () => {
    await db.createTask(groundrules({ name: 'Groundrules splash deployment', description: 'Deploy the splash page to groundrules.club and verify public HTTPS before launch.' }));
    const overlapping = await db.createTask(groundrules());
    expect(receipt(overlapping).decision).toBe('needs_evidence');
    await recordRuling(overlapping.id, ANSWER);
    expect(receipt(await admission(overlapping.id)).decision).toBe('needs_evidence');

    raw.exec('DELETE FROM tasks');
    const task = await approved(await db.createTask(groundrules()));
    const concern = await api('POST', `/${task.id}/work-admission/concerns`, { expected_task_version: task.version,
        concerns: [{ reason: 'Council seat suspects the launch task already covers this.' }] }, runtimeKey);
    expect(receipt(concern.data).decision).toBe('needs_evidence');
    await recordRuling(task.id, ANSWER);
    const held = await admission(task.id);
    expect(receipt(held).decision).toBe('needs_evidence');
    expect(receipt(held).concerns).toHaveLength(1);
});

test('an answer on one task does not invalidate a sibling whose clearance compared it', async () => {
    const owner = await db.createTask(groundrules({ name: 'Groundrules splash deployment', description: 'Deploy the splash page to groundrules.club and verify public HTTPS before launch.' }));
    const sibling = await approved(await db.createTask(groundrules()));
    expect(receipt(sibling).matches.map(m => m.task_id)).toContain(owner.id);
    await recordRuling(owner.id, ANSWER);
    const refreshed = await admission(sibling.id);
    expect(receipt(refreshed).decision).toBe('new_work');
    expect(receipt(refreshed).resolved_at).toBe(receipt(sibling).resolved_at);
});

test('a receipt fingerprinted before answers left scope is rebound only when it exactly matches', async () => {
    // Pre-fix fingerprints bound operator_rulings into the payload contract.
    const legacy = (task, rulings) => {
        const contract = require('../../db/work-admission').createWorkAdmission(raw).contract(task);
        const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]))
            : typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : value ?? null;
        return createHash('sha256').update(JSON.stringify(stable({ ...contract, payload: { ...contract.payload, operator_rulings: rulings } }))).digest('hex');
    };
    await db.createTask(groundrules({ name: 'Groundrules splash deployment', description: 'Deploy the splash page to groundrules.club and verify public HTTPS before launch.' }));
    const task = await approved(await db.createTask(groundrules({ antigravity_payload: { ...groundrulesPayload(), operator_rulings: [ANSWER] } })));
    expect(receipt(task).resolved_at).toBeTruthy();
    const stored = JSON.parse(raw.prepare('SELECT document FROM work_admissions WHERE task_id = ?').get(task.id).document);
    const write = fingerprint => raw.prepare('UPDATE work_admissions SET document = ? WHERE task_id = ?').run(JSON.stringify({ ...stored, fingerprint }), task.id);
    write(legacy(task, [ANSWER]));
    const rebound = await admission(task.id);
    expect(receipt(rebound).decision).toBe('new_work');
    expect(receipt(rebound).resolved_at).toBe(stored.resolved_at);
    expect(receipt(rebound).fingerprint).toBe(stored.fingerprint);
    expect(receipt(rebound).legacy_fingerprint).toBe(legacy(task, [ANSWER]));
    // A legacy fingerprint of some other contract is never rebound.
    write(legacy(task, ['Q: other\nA: other']));
    const stale = await admission(task.id);
    expect(receipt(stale).decision).toBe('needs_evidence');
    expect(receipt(stale).legacy_fingerprint).toBeUndefined();
});
