const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
let db, server, base, project, member, task, dir;
const operatorKey = 'synthetic-operator-only-key-123456789';
const runtimeKey = 'synthetic-runtime-only-key-123456789';
async function api(method, url, body, key) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}
const target = suffix => `/api/tasks/${task.id}/${suffix}`;
const binding = p => ({ revision: p.revision, content_hash: p.content_hash });
async function propose(extra = {}) {
    return api('POST', target('stakeholder-proposal'), { kind: 'invitation', member_id: member.id,
        content: { message: 'Please join the synthetic review.', role: 'Reviewer' }, ...extra });
}
async function decide(p, decision = 'approve', key = operatorKey) {
    return api('POST', target('stakeholder-decision'), { decision, ...binding(p), decided_by: { name: 'Forged', via: 'operator' } }, key);
}
beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserved-policy-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    process.env.NEXUS_OPERATOR_APPROVAL_KEY = operatorKey;
    process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY = runtimeKey;
    jest.resetModules(); db = require('../../db');
    project = await db.upsertProject({ name: 'Synthetic policy test', path: '/tmp/synthetic-policy', description: 'Existing scope' });
    member = await db.createContact({ name: 'Synthetic member', email: 'synthetic@example.invalid' });
    task = await db.createTask({ project_id: project.id, name: 'Proposed invitation', description: 'Review only', status: 'idea' });
    const app = express(); app.use(express.json());
    // Deliberately reproduce the production local-admin stub. It is NOT authority.
    app.use((req, _res, next) => { req.user = { id: 'local_user', role: 'admin' }; next(); });
    const routers = require('../routes/stakeholders')({ db });
    app.use('/api/projects', routers.projects); app.use('/api/tasks', routers.tasks);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    delete process.env.NEXUS_DB_PATH; delete process.env.NEXUS_OPERATOR_APPROVAL_KEY; delete process.env.NEXUS_STAKEHOLDER_RUNTIME_KEY;
});
test('stores and returns general policy without inventing project policy or participation', async () => {
    const result = await api('GET', `/api/projects/${project.id}/stakeholder-policy`);
    expect(result.status).toBe(200);
    expect(result.data.policy.independent).toEqual(['recommend_members', 'prepare_personalized_updates', 'track_commitments', 'draft_followups', 'file_enhancement_tickets']);
    expect(result.data.policy.requires_robert).toEqual(['invitation', 'scope_change']);
    expect(result.data.project_policy).toBeNull();
    const raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH, { readonly: true });
    expect(JSON.parse(raw.prepare('SELECT document FROM stakeholder_policies').get().document)).toEqual(result.data.policy);
    raw.close();
    await db.linkContactToProject(project.id, member.id, { decision_maker: true });
    const proposed = await propose(); expect(proposed.status).toBe(201);
    expect(proposed.data.proposal.state).toBe('proposed');
    expect(proposed.data.proposal.events).toEqual([]);
    expect((await db.getProject(project.id)).description).toBe('Existing scope');
});
test.each([[false, 'invitation'], [true, 'invitation'], [false, 'scope_change'], [true, 'scope_change']])('PDM=%s kind=%s and forged operator metadata never authorize a reserved action', async (pdm, kind) => {
    if (pdm) await db.linkContactToProject(project.id, member.id, { decision_maker: true });
    const { data: { proposal } } = await propose(kind === 'scope_change' ? { kind, content: { before: 'Existing scope', after: 'New scope', reason: 'Synthetic' } } : {});
    for (const key of [undefined, 'local-dev-token', runtimeKey]) expect((await decide(proposal, 'approve', key || '')).status).toBe(403);
    const approved = await decide(proposal);
    expect(approved.status).toBe(200);
    expect(approved.data.proposal.state).toBe('approved');
    expect(approved.data.proposal.decisions[0]).toMatchObject({ authority: 'operator_credential', operator: 'robert', ...binding(proposal) });
    delete process.env.NEXUS_OPERATOR_APPROVAL_KEY;
    expect((await decide(proposal)).status).toBe(503);
});
test('exact revision approval, stale edit, reapproval and mocked issue/accept receipt', async () => {
    const { data: { proposal: p } } = await propose();
    expect((await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'issued', evidence: 'mock:delivery-1' }, runtimeKey)).status).toBe(409);
    expect((await decide({ ...p, revision: 99 })).status).toBe(409);
    expect((await decide({ ...p, content_hash: 'forged-hash' })).status).toBe(409);
    expect((await decide(p)).status).toBe(200);
    const edited = await propose({ expected_revision: 1, content: { message: 'Revised synthetic invitation', role: 'Reviewer' } });
    expect(edited.status).toBe(201);
    const p2 = edited.data.proposal;
    expect(p2.state).toBe('proposed'); expect(p2.revision).toBe(2);
    expect(p2.revisions[0].content.message).toBe('Please join the synthetic review.');
    expect(p2.decisions).toHaveLength(1);
    expect((await decide(p)).status).toBe(409);
    expect((await decide(p2)).status).toBe(200);
    expect((await api('POST', target('stakeholder-receipt'), { ...binding(p2), state: 'accepted', evidence: 'mock:reply' }, runtimeKey)).status).toBe(409);
    const receipt = { ...binding(p2), state: 'issued', evidence: 'mock:delivery-1' };
    expect((await api('POST', target('stakeholder-receipt'), receipt)).status).toBe(403);
    expect((await api('POST', target('stakeholder-receipt'), receipt, runtimeKey)).data.proposal.state).toBe('issued');
    expect((await api('POST', target('stakeholder-receipt'), receipt, runtimeKey)).data.proposal.events).toHaveLength(1);
    expect((await api('POST', target('stakeholder-receipt'), { ...binding(p2), state: 'accepted', evidence: 'mock:member-reply' }, runtimeKey)).data.proposal.state).toBe('accepted');
    expect(await db.listProjectContacts(project.id)).toEqual([]);
});
test.each(['reject', 'cancel', 'edit'])('%s invalidates execution even after forged gate updates', async action => {
    const { data: { proposal: p } } = await propose(); await decide(p);
    if (action === 'reject') await decide(p, 'reject');
    if (action === 'cancel') await db.updateTask(task.id, { status: 'cancelled' });
    if (action === 'edit') await db.updateTask(task.id, { description: 'Materially changed scope' });
    await db.updateTask(task.id, { status: 'idea', metadata: { stakeholder_gate: { status: 'approved', decided_by: { name: 'Robert', via: 'operator' } } } });
    const result = await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'issued', evidence: 'mock:delivery' }, runtimeKey);
    expect(result.status).toBe(409);
    expect((await api('GET', `/api/projects/${project.id}/requests?status=all`)).data.requests[0].proposal.state).toBe(action === 'edit' ? 'invalidated' : action === 'cancel' ? 'cancelled' : 'rejected');
});
test('scope approval is not applied scope; application is a separate bound receipt', async () => {
    const { data: { proposal: p } } = await propose({ kind: 'scope_change', member_id: null, content: { before: 'Existing scope', after: 'Proposed larger scope', reason: 'Synthetic test' } });
    await decide(p);
    expect((await db.getProject(project.id)).description).toBe('Existing scope');
    expect((await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'issued', evidence: 'mock:scope' }, runtimeKey)).status).toBe(409);
    const applied = await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'applied', evidence: 'mock:scope-application-receipt' }, runtimeKey);
    expect(applied.data.proposal.state).toBe('applied');
    expect((await db.getProject(project.id)).description).toBe('Existing scope');
});
test('canonical identity edits cannot resurrect approval by reverting the directory', async () => {
    const { data: { proposal: p } } = await propose(); await decide(p);
    await db.updateContact(member.id, { email: 'changed@example.invalid' });
    await db.updateContact(member.id, { email: 'synthetic@example.invalid' });
    const result = await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'issued', evidence: 'mock:delivery' }, runtimeKey);
    expect(result.status).toBe(409);
});
test('history survives reopen and SQL cannot rewrite a proposal or decision', async () => {
    const { data: { proposal: p } } = await propose(); await decide(p);
    const raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    const store = require('../../db/stakeholder-policy').createStakeholderPolicy(raw);
    expect(store.read(task.id)).toMatchObject({ state: 'approved', ...binding(p) });
    expect(() => raw.prepare('UPDATE stakeholder_proposal_revisions SET document = ?').run('{}')).toThrow(/immutable/);
    expect(() => raw.prepare('DELETE FROM stakeholder_proposal_events').run()).toThrow(/immutable/);
    raw.close();
});
test('legacy reserved marker requires registration and cannot use the PDM path', async () => {
    await db.updateTask(task.id, { metadata: { stakeholder_gate: { status: 'pending', action_kind: 'scope_change' } } });
    expect((await api('POST', target('stakeholder-decision'), { decision: 'approve', decided_by: { name: 'Robert', via: 'operator' } })).status).toBe(403);
    expect((await api('POST', target('stakeholder-decision'), { decision: 'approve' }, operatorKey)).status).toBe(409);
});
test.each(['reject', 'issued', 'accepted'])('later edits preserve terminal %s and cannot reopen it', async terminal => {
    const { data: { proposal: p } } = await propose(); await decide(p);
    if (terminal === 'reject') await decide(p, 'reject');
    else {
        await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'issued', evidence: 'mock:issued' }, runtimeKey);
        if (terminal === 'accepted') await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'accepted', evidence: 'mock:accepted' }, runtimeKey);
    }
    await db.updateTask(task.id, { status: 'idea', description: 'Changed later' });
    await db.updateContact(member.id, { name: 'Changed identity' });
    const state = (await api('GET', target('stakeholder-proposal'))).data.proposal.state;
    expect(state).toBe(terminal === 'reject' ? 'rejected' : terminal);
    expect((await propose({ expected_revision: 1 })).status).toBe(409);
});
test('scope edits invalidate approval even after restoring the former scope', async () => {
    const { data: { proposal: p } } = await propose(); await decide(p);
    await db.updateProject(project.id, { description: 'Broader scope' });
    await db.updateProject(project.id, { description: 'Existing scope' });
    expect((await api('GET', target('stakeholder-proposal'))).data.proposal.execution_allowed).toBe(false);
    expect((await api('POST', target('stakeholder-receipt'), { ...binding(p), state: 'issued', evidence: 'mock:no-delivery' }, runtimeKey)).status).toBe(409);
});
test('runtime atomically applies the exact approved Nexus description scope and records it separately', async () => {
    const { data: { proposal: p } } = await propose({ kind: 'scope_change', member_id: null,
        content: { field: 'description', before: 'Existing scope', after: 'Approved synthetic scope', reason: 'Synthetic' } });
    const payload = { ...binding(p), state: 'applied', apply_to_project: true, evidence: 'mock:atomic-application' };
    expect((await api('POST', target('stakeholder-receipt'), payload, runtimeKey)).status).toBe(409);
    await decide(p);
    expect((await db.getProject(project.id)).description).toBe('Existing scope');
    expect((await api('POST', target('stakeholder-receipt'), payload, runtimeKey)).data.proposal.state).toBe('applied');
    expect((await db.getProject(project.id)).description).toBe('Approved synthetic scope');
});
test('revised proposal follows its exact project, never a former revision scope', async () => {
    const { data: { proposal: p } } = await propose();
    const other = await db.upsertProject({ name: 'Other synthetic scope', path: '/tmp/other-synthetic-scope' });
    await db.updateTask(task.id, { project_id: other.id });
    expect((await api('GET', `/api/projects/${other.id}/requests?status=all`)).data.requests).toEqual([]);
    const revised = await propose({ expected_revision: p.revision });
    expect(revised.data.proposal.project_id).toBe(other.id);
    expect((await api('GET', `/api/projects/${project.id}/requests?status=all`)).data.requests).toEqual([]);
    expect((await api('GET', `/api/projects/${other.id}/requests?status=all`)).data.requests).toHaveLength(1);
});
test('request list reuses reconstructed project proposals', async () => {
    await propose();
    const read = jest.spyOn(db, 'getStakeholderProposal');
    try {
        const result = await api('GET', `/api/projects/${project.id}/requests?status=all`);
        expect(result.status).toBe(200);
        expect(result.data.requests).toHaveLength(1);
        expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
});
test('stakeholder facade reports unavailable database as 503', () => {
    const script = `
        const assert = require('node:assert/strict');
        const db = require('./db');
        for (const name of ['getStakeholderPolicy', 'getStakeholderProposal', 'listStakeholderProposals',
            'proposeStakeholderAction', 'decideStakeholderProposal', 'recordStakeholderReceipt']) {
            assert.throws(() => db[name]('synthetic', {}), error => error.status === 503);
        }
        console.log('Six facade methods returned 503');
    `;
    const result = require('child_process').spawnSync(process.execPath, ['-e', script], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8',
        env: { ...process.env, NEXUS_DB_PATH: path.join(dir, 'missing-directory', 'test.db') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Six facade methods returned 503');
});
