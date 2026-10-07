const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');
const { createHash } = require('crypto');
const runtimeKey = 'synthetic-canonical-runtime-key-123456';
let db, raw, server, base, dir;
const originalEnv = { ...process.env };
const receipt = task => task.metadata.work_admission;
async function api(method, suffix, body, headers = {}) {
    const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
    return { status: response.status, data };
}
const runtime = { authorization: `Bearer ${runtimeKey}` };
async function task(source = null) {
    return db.createTask({ project_id: 'canonical', name: 'Synthetic canonical delta task', status: 'in_progress', source,
        antigravity_payload: { prompt: 'Keep this canonical instruction.\nVerbatim second line.', commands: ['echo synthetic-only'],
            workspace: '/tmp/canonical-a', acceptance_criteria: ['Preserve canonical state.'], custom: { keep: true } } });
}
beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-canonical-deltas-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    jest.resetModules(); db = require('../../db'); raw = new Database(process.env.NEXUS_DB_PATH);
    const app = express(); app.use(express.json());
    app.use('/api/tasks', require('../routes/tasks')({ db, PROJECT_ROOT: dir, getProjectById: async (_root, id) => db.getProject(id) }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/tasks`;
});
beforeEach(() => {
    raw.exec('DELETE FROM tasks; DELETE FROM projects;');
    raw.prepare("INSERT INTO projects (id,name,path) VALUES ('canonical','Canonical','/tmp/canonical-a')").run();
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close();
    for (const key of ['NEXUS_DB_PATH', 'NEXUS_STAKEHOLDER_RUNTIME_KEY']) {
        if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
});
test.each([null, 'external-feed', 'user'])('answer append preserves raw canonical contract and source %s; response remains guarded', async source => {
    const before = await task(source);
    const read = (await api('GET', `/${before.id}`)).data;
    if (source !== 'user') expect(read.antigravity_payload.prompt).not.toBe(before.antigravity_payload.prompt);
    const input = { ruling: 'Yes, use the existing account.', source: 'answered from the inbox', provenance: { kind: 'inbox_answer', id: 'synthetic-card', instructed_at: '2026-10-06T12:00:00Z' } };
    const answer = await api('POST', `/${before.id}/operator-rulings`, input, runtime);
    expect(answer.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.source).toBe(source);
    expect(after.antigravity_payload).toMatchObject(before.antigravity_payload);
    expect(after.antigravity_payload.commands_withheld).toBeUndefined();
    expect(receipt(after).contract.hash).toBe(receipt(before).contract.hash);
    expect(receipt(after).decision).toBe(receipt(before).decision);
    expect(receipt(after).operator_answers).toEqual([expect.objectContaining({ origin: 'runtime', index: 0 })]);
    if (source !== 'user') { expect(answer.data.task.antigravity_payload.commands).toBeUndefined(); expect(answer.data.task.antigravity_payload.prompt).toBe(read.antigravity_payload.prompt); }
    const duplicate = await api('POST', `/${before.id}/operator-rulings`, input, runtime);
    expect(duplicate.status).toBe(200);
    expect(duplicate.data.task.version).toBe(after.version);
    expect((await db.getTask(before.id)).antigravity_payload.operator_rulings).toHaveLength(1);
});
test('unverified provenance stays unverified, while distinct source answers and clipped tails survive', async () => {
    const before = await task(); const endpoint = `/${before.id}/operator-rulings`;
    const head = 'x'.repeat(1300);
    for (const input of [{ ruling: head + 'A', source: 'external respondent', source_scoped: true },
        { ruling: head + 'B', source: 'external respondent', source_scoped: true },
        { ruling: head + 'A', provenance: { kind: 'inbox_answer', id: 'card' } }]) {
        expect((await api('POST', endpoint, input)).status).toBe(200);
    }
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.operator_rulings).toHaveLength(3);
    expect(receipt(after).operator_answers.every(answer => answer.origin === 'unverified')).toBe(true);
});
test('interleaved stale readers cannot erase answers or an independently authorized scope edit', async () => {
    const before = await task();
    const answer = text => api('POST', `/${before.id}/operator-rulings`, { ruling: text }, runtime);
    const one = await answer('First answer'); expect(one.status).toBe(200);
    const edit = await api('PATCH', `/${before.id}`, { description: 'The exact new scope Robert requested.', contract_change: {
        origin: 'operator_relayed', fields: ['description'], decision_ref: { kind: 'chat_instruction', id: 'synthetic-chat', instruction: 'The exact new scope Robert requested.' } } }, runtime);
    expect(edit.status).toBe(200);
    const two = await answer('Second answer'); expect(two.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.description).toBe('The exact new scope Robert requested.');
    expect(after.antigravity_payload.operator_rulings).toEqual(['First answer', 'Second answer']);
    expect(after.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
    expect(receipt(after).contract_hold).toBeUndefined();
});
test('workspace delta merges current roots/history and preserves unrelated fields; unauthorized drift remains held', async () => {
    const before = await task();
    await api('POST', `/${before.id}/operator-rulings`, { ruling: 'Keep this answer' }, runtime);
    const moved = await api('POST', `/${before.id}/workspace-delta`, { workspace: '/tmp/canonical-b', workspace_roots: ['/tmp/canonical-a', '/tmp/canonical-b'],
        history: { from: '/tmp/canonical-a', to: '/tmp/canonical-b', action: 'move', at: '2026-10-06T12:00:00Z' } });
    expect(moved.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload).toMatchObject({ ...before.antigravity_payload, workspace: '/tmp/canonical-b', operator_rulings: ['Keep this answer'] });
    expect(after.source).toBeNull();
    expect(receipt(after).hold_kind).toBe('contract_drift');
    expect(receipt(after).contract_hold.drifted_fields).toEqual(expect.arrayContaining(['payload.workspace', 'payload.workspace_roots']));
    expect(receipt(after).contract_hold.drifted_fields).not.toContain('payload.prompt');
});
test('delta CAS, leases and unknown-field validation refuse without changing a row', async () => {
    const before = await task();
    for (const [suffix, body, expected] of [
        ['operator-rulings', { ruling: 'stale', expected_version: before.version + 1 }, 409],
        ['operator-rulings', { ruling: 'smuggled', antigravity_payload: { prompt: 'replace' } }, 400],
        ['workspace-delta', { workspace: '/tmp/b', prompt: 'replace' }, 400],
    ]) expect((await api('POST', `/${before.id}/${suffix}`, body)).status).toBe(expected);
    const acquired = db.writeLeases.acquire({ scope: 'board' }, { owner: 'synthetic blocker' });
    try { expect((await api('POST', `/${before.id}/operator-rulings`, { ruling: 'blocked' })).status).toBe(409); }
    finally { db.writeLeases.release(acquired.token); }
    expect((await db.getTask(before.id)).version).toBe(before.version);
});
test('ledger-only PATCH merges into raw payload under CAS without persisting dispatch framing', async () => {
    const before = await task();
    const result = await api('PATCH', `/${before.id}`, { expected_version: before.version, name: 'Renamed synthetic task', payload_ledger: {
        binding_constraints: [{ id: 'BC-SCOPE', generated: true, must: 'Renamed scope' }], binding_constraints_text: 'Generated scope' } });
    expect(result.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload).toMatchObject({ ...before.antigravity_payload, binding_constraints_text: 'Generated scope' });
    expect(after.source).toBeNull();
});

test('criteria additions preserve the current authored criteria and raw prompt while retaining drift enforcement', async () => {
    const before = await task();
    const result = await api('PATCH', `/${before.id}`, { acceptance_criteria_append: ['A generated check passes.'], expected_version: before.version });
    expect(result.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.acceptance_criteria).toEqual(['Preserve canonical state.', 'A generated check passes.']);
    expect(after.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
    expect(after.antigravity_payload.commands).toEqual(before.antigravity_payload.commands);
    expect(receipt(after).contract_hold.drifted_fields).toEqual(['payload.acceptance_criteria']);
});
test('a vouched exact scope delta is authorized once and cannot authorize an unrelated prompt edit', async () => {
    const before = await task();
    const ruling = 'Add the specified check.';
    await api('POST', `/${before.id}/operator-rulings`, { ruling }, runtime);
    const current = await db.getTask(before.id);
    const claim = { origin: 'operator_relayed', fields: ['payload.acceptance_criteria'], decision_ref: {
        kind: 'operator_ruling', index: 0, sha256: createHash('sha256').update(ruling).digest('hex') } };
    const input = { payload_delta: { acceptance_criteria: ['The specified check passes.'] }, expected_version: current.version, contract_change: claim };
    expect((await api('PATCH', `/${before.id}`, input, runtime)).status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.acceptance_criteria).toEqual(['The specified check passes.']);
    expect(after.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
    expect(after.antigravity_payload.commands).toEqual(before.antigravity_payload.commands);
    expect(receipt(after).contract_hold).toBeUndefined();
    expect(receipt(after).contract_changes.at(-1).outcome).toBe('authorized');
    const changed = await api('PATCH', `/${before.id}`, { ...input, expected_version: after.version, payload_delta: { prompt: 'Unrelated scope' } }, runtime);
    expect(changed.status).toBe(409); expect(changed.data.code).toBe('contract_change_mixed');
    expect((await db.getTask(before.id)).antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
});
test('source-scoped identical words from distinct inbox decisions remain distinct; same decision retry is idempotent', async () => {
    const before = await task();
    const endpoint = `/${before.id}/operator-rulings`;
    for (const id of ['decision-one', 'decision-two', 'decision-one']) {
        expect((await api('POST', endpoint, { ruling: 'Proceed', source_scoped: true, provenance: { kind: 'inbox_answer', id } }, runtime)).status).toBe(200);
    }
    expect((await db.getTask(before.id)).antigravity_payload.operator_rulings).toHaveLength(2);
});
test('concurrent answers and workspace edits survive lease contention with exact delta retries', async () => {
    const before = await task();
    const jobs = [
        ['operator-rulings', { ruling: 'Concurrent first' }], ['operator-rulings', { ruling: 'Concurrent second' }],
        ['workspace-delta', { workspace: '/tmp/concurrent', workspace_roots: ['/tmp/concurrent'], history: { from: '/tmp/canonical-a', to: '/tmp/concurrent', action: 'move', at: '2026-10-06T12:00:00Z' } }],
    ];
    const outcomes = await Promise.all(jobs.map(([suffix, body]) => api('POST', `/${before.id}/${suffix}`, body, runtime)));
    for (let i = 0; i < outcomes.length; i++) {
        if (outcomes[i].status === 409) {
            expect(outcomes[i].data.code).toMatch(/^write_lease/);
            expect((await api('POST', `/${before.id}/${jobs[i][0]}`, jobs[i][1], runtime)).status).toBe(200);
        } else expect(outcomes[i].status).toBe(200);
    }
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.operator_rulings).toEqual(expect.arrayContaining(['Concurrent first', 'Concurrent second']));
    expect(after.antigravity_payload.workspace).toBe('/tmp/concurrent');
    expect(after.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
});
test('payload delta preserves explicit deletion and rejects replacement or unknown-field mixing', async () => {
    const before = await task();
    const removed = await api('PATCH', `/${before.id}`, { expected_version: before.version, payload_delta: { commands: null } });
    expect(removed.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.commands).toBeUndefined();
    expect(after.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
    for (const input of [{ payload_delta: { custom: 'arbitrary' } }, { payload_delta: { prompt: 'x' }, antigravity_payload: before.antigravity_payload }]) {
        expect((await api('PATCH', `/${before.id}`, { ...input, expected_version: after.version })).status).toBe(400);
    }
});
test('relayed hidden-command deletion uses the canonical diff and a requested raw-equal prompt is a no-op', async () => {
    const before = await task();
    const projected = (await api('GET', `/${before.id}`)).data;
    expect(projected.antigravity_payload.commands).toBeUndefined();
    expect(projected.antigravity_payload.prompt).not.toBe(before.antigravity_payload.prompt);
    const claim = { origin: 'operator_relayed', fields: ['payload.commands', 'payload.prompt'],
        decision_ref: { kind: 'chat_instruction', id: 'remove-commands', instruction: 'Remove commands and retain the original prompt.' } };
    const body = { expected_version: before.version, payload_delta: { commands: null, prompt: before.antigravity_payload.prompt }, contract_change: claim };
    expect((await api('PATCH', `/${before.id}`, body)).status).toBe(403);
    expect((await api('PATCH', `/${before.id}`, body, runtime)).status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.commands).toBeUndefined();
    expect(after.antigravity_payload.prompt).toBe(before.antigravity_payload.prompt);
    expect(receipt(after).contract_hold).toBeUndefined();
    expect(receipt(after).contract_changes.at(-1).fields.map(field => field.field)).toEqual(['payload.commands']);
    const unchanged = { expected_version: after.version, payload_delta: { prompt: before.antigravity_payload.prompt },
        contract_change: { ...claim, fields: ['payload.prompt'] } };
    expect((await api('PATCH', `/${before.id}`, unchanged, runtime)).status).toBe(200);
    const noOp = await db.getTask(before.id);
    expect(receipt(noOp).contract.hash).toBe(receipt(after).contract.hash);
    expect(receipt(noOp).contract_changes).toEqual(receipt(after).contract_changes);
    expect(noOp.source).toBeNull();
    expect((await api('PATCH', `/${before.id}`, { ...unchanged, expected_version: noOp.version,
        contract_change: { ...claim, decision_ref: { kind: 'operator_ruling', index: 99, sha256: '0'.repeat(64) } } }, runtime)).data.code).toBe('decision_ref_mismatch');
});
test('operational repair/evidence deltas preserve canonical contract and source, including null removal', async () => {
    const before = await task();
    const added = await api('PATCH', `/${before.id}`, { expected_version: before.version,
        payload_delta: { repair_context: { findings: 'Synthetic findings' }, improvement_issue: { key: 'synthetic' } } });
    expect(added.status).toBe(200);
    const current = await db.getTask(before.id);
    expect(current.antigravity_payload).toMatchObject(before.antigravity_payload);
    expect(receipt(current).contract.hash).toBe(receipt(before).contract.hash);
    expect(receipt(current).contract_hold).toBeUndefined();
    const cleared = await api('PATCH', `/${before.id}`, { expected_version: current.version, payload_delta: { repair_context: null } });
    expect(cleared.status).toBe(200);
    const after = await db.getTask(before.id);
    expect(after.antigravity_payload.repair_context).toBeUndefined();
    expect(after.antigravity_payload.improvement_issue).toEqual({ key: 'synthetic' });
    expect(after.source).toBeNull();
    expect(after.antigravity_payload.commands).toEqual(before.antigravity_payload.commands);
});
