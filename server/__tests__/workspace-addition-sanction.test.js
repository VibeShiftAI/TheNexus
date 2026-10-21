// A sanctioned cross-repo addition (task a47a00bf, 2026-10-20).
//
// Robert's standing ruling in task b4b27285 lets an executor work in the
// additional repos its task needs, with QA reviewing them. The runtime
// records that addition on the task through POST /workspace-delta. Until this
// change the write arrived unauthenticated and was held as unverified
// contract drift during execution (incident 9cae1b0e: change-626a48cfc73431ce
// held the saved operator answer until Robert decided it). The write now
// carries `sanction: {kind: 'workspace_addition'}` under the runtime
// credential and is recorded as authorized, with the origin still `runtime`.
// The sanction covers exactly the added roots: an unauthenticated write, the
// runtime credential alone, a move, another governed field, a PATCH and drift
// already held on the workspace fields all keep their own authority.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');

const runtimeKey = 'synthetic-sanction-runtime-key-1234567890';
const operatorKey = 'synthetic-sanction-operator-key-1234567890';
let db, raw, server, base, dir;
const originalEnv = { ...process.env };
const receipt = task => task.metadata.work_admission;
const lastChange = task => receipt(task).contract_changes.at(-1);
const runtime = { authorization: `Bearer ${runtimeKey}` };
const operator = { authorization: `Bearer ${operatorKey}` };
const HOME = '/tmp/sanction-home', SIBLING = '/tmp/sanction-sibling', THIRD = '/tmp/sanction-third';

async function api(method, suffix, body, headers = {}) {
    const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
    return { status: response.status, data };
}
let serial = 0;
/** One project per task: admission compares tasks within a project, and these fixtures share their wording. */
async function task(status = 'in_progress', payload = {}) {
    const project = `sanction-${++serial}`;
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(project, project, HOME);
    return db.createTask({ project_id: project, name: `Fix the shared display contract (${serial})`, status,
        description: 'Fix the display contract across the shared repos.',
        antigravity_payload: { prompt: 'Keep this canonical instruction.', workspace: HOME, acceptance_criteria: ['Preserve canonical state.'], ...payload } });
}
const history = (root, action = 'add') => ({ from: HOME, to: root, action, at: '2026-10-20T20:43:45.160Z', reason: 'the display contract lives there', by: 'claude-code' });
const addition = (root, extra = {}) => ({ workspace_roots: [HOME, root], history: history(root),
    sanction: { kind: 'workspace_addition', reason: 'the display contract lives there', by: 'claude-code' }, ...extra });
const unsanctioned = (root, extra = {}) => { const { sanction, ...plain } = addition(root, extra); return plain; };

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sanctioned-addition-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    jest.resetModules(); db = require('../../db'); raw = new Database(process.env.NEXUS_DB_PATH);
    const app = express(); app.use(express.json());
    app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir, getProjectById: async (_root, id) => db.getProject(id) }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/tasks`;
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close();
    for (const key of ['NEXUS_DB_PATH', 'NEXUS_STAKEHOLDER_RUNTIME_KEY', 'NEXUS_OPERATOR_APPROVAL_KEY']) {
        if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

test('October 20 reproduction: an unauthenticated addition now continues with a warning', async () => {
    const before = await task();
    expect(receipt(before).decision).toBe('new_work');
    const res = await api('POST', `/${before.id}/workspace-delta`, { ...unsanctioned(SIBLING), expected_version: before.version });
    expect(res.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.workspace_roots).toEqual([HOME, SIBLING]);
    expect(receipt(after).contract_hold).toBeUndefined();
    expect(receipt(after).decision).toBe('new_work');
    expect(lastChange(after)).toMatchObject({ outcome: 'recorded', warning: 'workspace_change', origin: { kind: 'unverified', requester: 'unauthenticated' }, execution: { phase: 'executing' } });
});

test('the runtime credential alone records a warning without claiming operator authority', async () => {
    const before = await task();
    const res = await api('POST', `/${before.id}/workspace-delta`, { ...unsanctioned(SIBLING), expected_version: before.version }, runtime);
    expect(res.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(lastChange(after)).toMatchObject({ outcome: 'recorded', warning: 'workspace_change', origin: { kind: 'runtime', authority: 'runtime_credential' } });
    expect(lastChange(after).origin.sanction).toBeUndefined();
    expect(receipt(after).contract_hold).toBeUndefined();
});

test('a sanctioned addition under the runtime credential is authorized: scope, baseline and admission are preserved', async () => {
    const before = await task();
    const res = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version }, runtime);
    expect(res.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.workspace_roots).toEqual([HOME, SIBLING]);
    expect(after.antigravity_payload.workspace).toBe(HOME);
    expect(after.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
    expect(after.antigravity_payload.acceptance_criteria).toEqual(before.antigravity_payload.acceptance_criteria);
    expect(after.antigravity_payload.workspace_history.at(-1)).toMatchObject({ action: 'add', to: SIBLING, by: 'claude-code', reason: 'the display contract lives there' });
    expect(receipt(after).contract_hold).toBeFalsy();
    expect(receipt(after).decision).toBe('new_work');
    expect(receipt(after).fingerprint).toBeTruthy();
    expect(receipt(after).contract).toMatchObject({ version: receipt(before).contract.version + 1,
        authorized_by: { origin: 'runtime', authority: 'runtime_credential', requester: 'runtime', basis: 'sanctioned_workspace_addition', added_roots: [SIBLING],
            sanction: { kind: 'workspace_addition', by: 'claude-code' } } });
    expect(lastChange(after)).toMatchObject({ outcome: 'authorized', execution: { phase: 'executing' },
        origin: { kind: 'runtime', authority: 'runtime_credential', requester: 'runtime', sanction: { kind: 'workspace_addition', by: 'claude-code' } } });
    expect(lastChange(after).fields.map(field => field.field)).toEqual(['payload.workspace_roots']);
    // The read path agrees: nothing for Robert to decide.
    const read = await api('GET', `/${before.id}/work-admission`);
    expect(read.status).toBe(200);
    expect(receipt(read.data).decision).toBe('new_work');
    expect(receipt(read.data).contract_hold).toBeFalsy();
    // A later root is one more authorized addition; the earlier ones stay.
    const again = await api('POST', `/${before.id}/workspace-delta`, { ...addition(THIRD), expected_version: after.version }, runtime);
    expect(again.status).toBe(200);
    const twice = await db.getTask(before.id);
    expect(twice.antigravity_payload.workspace_roots).toEqual([HOME, SIBLING, THIRD]);
    expect(receipt(twice).contract_hold).toBeFalsy();
    expect(receipt(twice).contract.authorized_by.added_roots).toEqual([THIRD]);
    // Registering a root that is already there changes no governed field and records nothing.
    const same = await api('POST', `/${before.id}/workspace-delta`, { ...addition(THIRD), expected_version: twice.version }, runtime);
    expect(same.status).toBe(200);
    expect(receipt(await db.getTask(before.id)).contract_changes).toHaveLength(2);
});

test('without the runtime credential a sanction writes nothing; the plain governed write stays available', async () => {
    const before = await task();
    const unauthenticated = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version });
    expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.data.code).toBe('contract_change_unverified');
    const wrongKey = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version },
        { authorization: 'Bearer not-the-runtime-key-0123456789abcdef' });
    expect(wrongKey.status).toBe(403);
    expect(wrongKey.data.code).toBe('contract_change_unverified');
    const bridge = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version },
        { ...runtime, 'x-praxis-bridge-token': 'executor-bridge' });
    expect(bridge.status).toBe(403);
    expect(bridge.data.code).toBe('contract_change_unverified');
    const unchanged = await db.getTask(before.id);
    expect(unchanged.version).toBe(before.version);
    expect(unchanged.antigravity_payload.workspace_roots).toBeUndefined();
    expect(receipt(unchanged).contract_changes ?? []).toHaveLength(0);
    // The plain write (what the runtime sends when its credential is unset) is still governed: held during execution.
    const plain = await api('POST', `/${before.id}/workspace-delta`, { ...unsanctioned(SIBLING), expected_version: before.version });
    expect(plain.status).toBe(200);
    expect(receipt(await db.getTask(before.id)).contract_hold).toBeUndefined();
});

test('a sanction never covers a move, a write that changes another field, or a PATCH', async () => {
    const before = await task();
    const move = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), workspace: SIBLING, history: history(SIBLING, 'move'), expected_version: before.version }, runtime);
    expect(move.status).toBe(400);
    expect(move.data.code).toBe('task_delta_invalid');
    const moveWithoutPrimary = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), history: history(SIBLING, 'move'), expected_version: before.version }, runtime);
    expect(moveWithoutPrimary.status).toBe(400);
    // A ledger projection that rewrites authored constraints is not an addition: refused outright, nothing written.
    const mixed = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version,
        payload_ledger: { binding_constraints: [{ id: 'BC-SMUGGLED', must: 'Authored rule riding the addition' }], binding_constraints_text: 'Authored rule riding the addition' } }, runtime);
    expect(mixed.status).toBe(409);
    expect(mixed.data.code).toBe('contract_change_mixed');
    expect(mixed.data.undeclared_fields).toEqual(expect.arrayContaining(['payload.binding_constraints']));
    expect(mixed.data.undeclared_fields).not.toContain('payload.workspace_roots');
    const patch = await api('PATCH', `/${before.id}`, { antigravity_payload: { ...before.antigravity_payload, workspace_roots: [HOME, SIBLING] }, sanction: { kind: 'workspace_addition' } }, runtime);
    expect(patch.status).toBe(400);
    expect(patch.data.code).toBe('contract_change_invalid');
    const claim = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version,
        contract_change: { origin: 'operator_relayed', fields: ['payload.workspace_roots'], decision_ref: { kind: 'chat_instruction', id: 'x', instruction: 'add it' } } }, runtime);
    expect(claim.status).toBe(400);
    expect(claim.data.code).toBe('contract_change_invalid');
    const unchanged = await db.getTask(before.id);
    expect(unchanged.version).toBe(before.version);
    expect(unchanged.antigravity_payload.workspace_roots).toBeUndefined();
    expect(receipt(unchanged).contract_hold).toBeFalsy();
    expect(receipt(unchanged).contract_changes ?? []).toHaveLength(0);
});

test('a sanctioned addition leaves a genuine hold on another field exactly where it was', async () => {
    const before = await task();
    // An unverified prompt rewrite during execution: held, as it should be.
    const drift = await api('PATCH', `/${before.id}`, { antigravity_payload: { ...before.antigravity_payload, prompt: 'Rewritten by the executor.' } });
    expect(drift.status).toBe(200);
    const held = await db.getTask(before.id);
    expect(receipt(held).contract_hold.drifted_fields).toEqual(['payload.prompt']);
    const res = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: held.version }, runtime);
    expect(res.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.workspace_roots).toEqual([HOME, SIBLING]);
    expect(lastChange(after).outcome).toBe('authorized');
    expect(receipt(after).contract_hold).toMatchObject({ drifted_fields: ['payload.prompt'], change_ids: receipt(held).contract_hold.change_ids });
    expect(receipt(after).contract_hold.authorized_values['payload.prompt']).toBe(before.antigravity_payload.prompt);
    expect(receipt(after).decision).toBe('needs_evidence');
    expect(receipt(after).contract.fields['payload.workspace_roots']).toBeTruthy();
    expect(receipt(after).contract.fields['payload.prompt']).toBe(receipt(held).contract.fields['payload.prompt']);
});

test('a sanctioned addition after a warning continues without requiring another decision', async () => {
 const before=await task();
 await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(SIBLING),expected_version:before.version});
 const warned=await db.getTask(before.id);
 const res=await api('POST', `/${before.id}/workspace-delta`, {...addition(THIRD),expected_version:warned.version}, runtime);
 expect(res.status).toBe(200);
 const after=await db.getTask(before.id);
 expect(after.antigravity_payload.workspace_roots).toEqual([HOME,SIBLING,THIRD]);
 expect(lastChange(after).outcome).toBe('authorized');
 expect(receipt(after).contract_hold).toBeUndefined();
 expect(receipt(after).decision).toBe('new_work');
});

test('a stale expected_version is a conflict: nothing written, no hold, no baseline move', async () => {
    const before = await task();
    const res = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version + 7 }, runtime);
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('task_version_conflict');
    const unchanged = await db.getTask(before.id);
    expect(unchanged.version).toBe(before.version);
    expect(unchanged.antigravity_payload.workspace_roots).toBeUndefined();
    expect(receipt(unchanged).contract.version).toBe(receipt(before).contract.version);
    expect(receipt(unchanged).contract_hold).toBeFalsy();
});

test('outside execution a sanctioned addition is authorized too, and the primary workspace never moves with it', async () => {
    const before = await task('todo');
    const res = await api('POST', `/${before.id}/workspace-delta`, { ...addition(SIBLING), expected_version: before.version }, runtime);
    expect(res.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(lastChange(after)).toMatchObject({ outcome: 'authorized', execution: { phase: 'before_execution' } });
    expect(receipt(after).contract.authorized_by.basis).toBe('sanctioned_workspace_addition');
    expect(after.antigravity_payload.workspace).toBe(HOME);
    expect(receipt(after).contract.fields.workspace).toBe(receipt(before).contract.fields.workspace);
});
