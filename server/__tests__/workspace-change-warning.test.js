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

test('workspace moves during execution continue with a durable warning and original provenance', async () => {
 const before = await task();
 const res = await api('POST', `/${before.id}/workspace-delta`, {workspace: SIBLING, workspace_roots: [HOME, SIBLING], history: history(SIBLING, 'move'), expected_version: before.version});
 expect(res.status).toBe(200);
 const after = await db.getTask(before.id);
 expect(receipt(after).decision).toBe('new_work');
 expect(receipt(after).contract_hold).toBeUndefined();
 expect(lastChange(after)).toMatchObject({warning: 'workspace_change', outcome: 'recorded', origin: {kind:'unverified'}});
 expect(receipt(after).contract.version).toBeGreaterThan(receipt(before).contract.version);
});
test('workspace additions are warnings, but mixed prompt changes remain held', async () => {
 const before = await task();
 const res = await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(SIBLING), expected_version:before.version});
 expect(res.status).toBe(200);
 expect(receipt(await db.getTask(before.id)).decision).toBe('new_work');
 const fresh = await task();
 await api('PATCH', `/${fresh.id}`, {antigravity_payload:{...fresh.antigravity_payload, workspace:SIBLING, prompt:'Different scope'}});
 expect(receipt(await db.getTask(fresh.id)).contract_hold).toBeDefined();
});
test('inspection converts an existing workspace-only hold once, preserving the saved answer', async () => {
 const before = await task('in_progress', {operator_rulings:['Q: Connect phone\nA: done']});
 await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(SIBLING), expected_version:before.version});
 const changed = await db.getTask(before.id);
 const old = {...receipt(changed), decision:'needs_evidence', hold_kind:'contract_drift', contract:receipt(before).contract,
 contract_hold:{since:'2026-10-21T00:27:15.368Z',change_ids:[lastChange(changed).id],drifted_fields:['payload.workspace_roots'],authorized_values:{},prior:receipt(before)},
 contract_changes:receipt(changed).contract_changes.map(({warning,...entry})=>({...entry,outcome:'held'}))};
 raw.prepare('UPDATE work_admissions SET document=? WHERE task_id=?').run(JSON.stringify(old),before.id);
 const res=await api('GET', `/${before.id}/work-admission`);
 expect(res.status).toBe(200);
 expect(receipt(res.data).decision).toBe('new_work');
 expect(receipt(res.data).contract_hold).toBeUndefined();
 expect(lastChange(res.data).warning).toBe('workspace_change');
 expect(res.data.antigravity_payload.operator_rulings).toEqual(before.antigravity_payload.operator_rulings);
 const again=await api('GET', `/${before.id}/work-admission`);
 expect(receipt(again.data).contract).toEqual(receipt(res.data).contract);
});
test('warnings are saved in Recent Activity immediately and only once', async () => {
 const before=await task();
 await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(SIBLING),expected_version:before.version});
 const events=()=>raw.prepare("SELECT * FROM ag_events WHERE task_id=? AND event_type='task_workspace_changed'").all(before.id);
 expect(events()).toHaveLength(1);
 expect(events()[0]).toMatchObject({severity:'warning',requires_action:0});
 await api('GET', `/${before.id}/work-admission`);
 expect(events()).toHaveLength(1);
});
test('workspace warning preserves a previously reviewed concern when evidence is unchanged', async () => {
 const before=await task();
 const prior={...receipt(before),concerns:[{key:'reviewed',reason:'already checked'}],resolved_at:'2026-10-21T12:00:00Z',decision:'new_work',reason:'Reviewed and approved'};
 raw.prepare('UPDATE work_admissions SET document=? WHERE task_id=?').run(JSON.stringify(prior),before.id);
 await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(SIBLING),expected_version:before.version});
 const after=await db.getTask(before.id);
 expect(receipt(after).decision).toBe('new_work');
 expect(receipt(after).resolved_at).toBe(prior.resolved_at);
});
test('migration resolves the full held history when a mixed edit was partially restored', async () => {
 const before=await task();
 await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(SIBLING),expected_version:before.version});
 const changed=await db.getTask(before.id);
 const entry=lastChange(changed);
 const old={...receipt(changed),decision:'needs_evidence',hold_kind:'contract_drift',contract:receipt(before).contract,
 contract_hold:{since:entry.recorded_at,change_ids:[entry.id],drifted_fields:['payload.workspace_roots'],authorized_values:{},prior:receipt(before)},
 contract_changes:[{...entry,warning:undefined,outcome:'held',fields:[...entry.fields,{field:'payload.prompt',before:'original',after:'temporary'}]},
 {...entry,id:'restore-prompt',warning:undefined,outcome:'recorded',fields:[{field:'payload.prompt',before:'temporary',after:'original'}]}]};
 raw.prepare('UPDATE work_admissions SET document=? WHERE task_id=?').run(JSON.stringify(old),before.id);
 // Old activity would not yet exist for this legacy receipt.
 raw.prepare('DELETE FROM ag_event_receipts WHERE idempotency_key=?').run(`workspace-change:${before.id}:${entry.id}`);
 const res=await api('GET', `/${before.id}/work-admission`);
 expect(res.status).toBe(200);
 expect(receipt(res.data).contract_hold).toBeUndefined();
 expect(receipt(res.data).contract_changes.every(change=>change.resolution?.decision==='workspace_warning_policy')).toBe(true);
});

test('a workspace write resolves legacy mixed history before any admission read', async () => {
 const before=await task();
 await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(SIBLING),expected_version:before.version});
 const changed=await db.getTask(before.id);
 const entry=lastChange(changed);
 const old={...receipt(changed),decision:'needs_evidence',hold_kind:'contract_drift',contract:receipt(before).contract,
 contract_hold:{since:entry.recorded_at,change_ids:[entry.id],drifted_fields:['payload.workspace_roots'],authorized_values:{},prior:receipt(before)},
 contract_changes:[{...entry,warning:undefined,outcome:'held',fields:[...entry.fields,{field:'payload.prompt',before:'original',after:'temporary'}]},
 {...entry,id:'restore-prompt',warning:undefined,outcome:'recorded',fields:[{field:'payload.prompt',before:'temporary',after:'original'}]}]};
 raw.prepare('UPDATE work_admissions SET document=? WHERE task_id=?').run(JSON.stringify(old),before.id);
 // Old activity would not yet exist for this legacy receipt.
 raw.prepare('DELETE FROM ag_event_receipts WHERE idempotency_key=?').run(`workspace-change:${before.id}:${entry.id}`);
 const res=await api('POST', `/${before.id}/workspace-delta`, {...unsanctioned(THIRD),expected_version:changed.version});
 expect(res.status).toBe(200);
 expect(receipt(await db.getTask(before.id)).contract_hold).toBeUndefined();
 expect(receipt(await db.getTask(before.id)).contract_changes.every(change=>change.resolution?.decision==='workspace_warning_policy')).toBe(true);
});
