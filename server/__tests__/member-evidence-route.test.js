/** GET /api/members/:id/evidence over the real db facade: explicit scope, labelled sources, no private leakage. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { randomUUID } = require('crypto');
let db, member, project, base, server;

async function api(url) {
    const response = await fetch(base + url);
    let json;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
}
const channelFact = (text, extra = {}) => ({ kind: 'fact', fact_key: 'profile.preference.contact_channel', text, evidence: 'self_reported', source: 'consultation', ...extra });

beforeEach(async () => {
    process.env.NEXUS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-evidence-route-')), 'nexus.db');
    jest.resetModules();
    db = require('../../db');
    member = await db.createContact({ name: 'Evidence Member', email: 'evidence-private@example.com', phone: '555-0199', notes: 'PRIVATE NOTES',
        preferences: { channel: 'email', tone: 'brief' }, expertise: ['pricing'] });
    project = await db.upsertProject({ name: 'Evidence Project', path: '/tmp/evidence-project', type: 'app' });
    expect(await db.linkContactToProject(project.id, member.id, { role: 'Tester' })).toBe(true);
    const createContactsRouter = require('../routes/contacts');
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/members', createContactsRouter({ db }));
    app.use('/api/contacts', createContactsRouter({ db }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    delete process.env.NEXUS_DB_PATH;
    jest.resetModules();
});

test('explicit scope lookups return labelled sources with full identifiers on both mounts', async () => {
    const general = await db.appendMemberMemory(member.id, channelFact('I prefer email.', { source_ref: 'consultation:1' }));
    const scoped = await db.appendMemberMemory(member.id, channelFact('Phone for this project.', { project_id: project.id, evidence: 'operator_confirmed', source: 'operator' }));
    const response = await api(`/api/members/${member.id}/evidence?scope=project&project_id=${encodeURIComponent(project.id)}&question=contact_channel&_cb=1725729000000`);
    expect(response.status).toBe(200);
    expect(response.json.sources.completion_claims).toMatchObject({ status: 'not_requested', records: [] });
    expect(response.json).toMatchObject({ member_id: member.id, scope: 'project', project_id: project.id, question: { type: 'contact_channel', fact_key: null },
        identity: { member_id: member.id, name: 'Evidence Member', seat_id: 'human:evidence-member', ambiguous: false, same_name_member_ids: [] },
        project_link: { project_id: project.id, status: 'linked', role: 'Tester', decision_maker: false } });
    expect(response.json.sources.project_assertions.records).toEqual([expect.objectContaining({ id: scoped.id, seq: scoped.seq, member_id: member.id, project_id: project.id,
        source_class: 'project_assertion', evidence: 'operator_confirmed', evidence_label: 'Operator confirmed', source: 'operator', recorded_at: scoped.recorded_at })]);
    expect(response.json.sources.general_assertions.records).toEqual([expect.objectContaining({ id: general.id, project_id: null, source_ref: 'consultation:1', source_class: 'general_assertion' })]);
    expect(response.json.sources.directory_settings.records).toEqual([expect.objectContaining({ field: 'preferences.channel', value: 'email', is_project_statement: false,
        ref: `/api/members/${member.id}#preferences.channel` })]);
    expect(response.json.directory_updated_at).toBe((await db.getContact(member.id)).updated_at);

    const alias = await api(`/api/contacts/${member.id}/evidence?scope=general&question=contact_channel`);
    expect(alias.status).toBe(200);
    expect(alias.json).toMatchObject({ scope: 'general', project_id: null, project_link: null });
    expect(alias.json.sources.project_assertions).toMatchObject({ status: 'not_requested', records: [] });
    expect(alias.json.sources.general_assertions.records.map(record => record.id)).toEqual([general.id]);
    expect(JSON.stringify(alias.json)).not.toContain(scoped.id);
});

test('missing project evidence is explicit while the directory default stays separately labelled', async () => {
    const response = await api(`/api/members/${member.id}/evidence?scope=project&project_id=${encodeURIComponent(project.id)}&question=contact_channel`);
    expect(response.status).toBe(200);
    expect(response.json.sources.project_assertions).toMatchObject({ status: 'missing', total: 0, records: [], is_project_statement: true,
        note: expect.stringMatching(/No project-specific assertion is recorded/) });
    expect(response.json.sources.general_assertions).toMatchObject({ status: 'missing', records: [] });
    expect(response.json.sources.directory_settings).toMatchObject({ status: 'present', applies_to: 'all_projects', is_project_statement: false });
    expect(response.json.sources.directory_settings.records[0]).toMatchObject({ field: 'preferences.channel', value: 'email' });
});

test('private contact details, notes and observations never enter the lookup', async () => {
    await db.appendContactLog(member.id, { note: 'RAW INTERACTION NOTE', source: 'praxis' });
    await db.appendMemberMemory(member.id, { project_id: project.id, kind: 'observation', text: 'PROJECT OBSERVATION', evidence: 'observed', source: 'praxis' });
    const response = await api(`/api/members/${member.id}/evidence?scope=project&project_id=${encodeURIComponent(project.id)}`);
    expect(response.status).toBe(200);
    const json = JSON.stringify(response.json);
    for (const secret of ['evidence-private@example.com', '555-0199', 'PRIVATE NOTES', 'RAW INTERACTION NOTE', 'PROJECT OBSERVATION']) expect(json).not.toContain(secret);
    expect(response.json.coverage).toMatchObject({ observations_included: false, contact_details_included: false, other_projects_included: false });
});

test('query validation distinguishes unknown members, unknown projects and malformed requests', async () => {
    for (const query of ['', 'scope=all', 'scope=project', 'scope=project&project_id=', `scope=general&project_id=${project.id}`, 'scope=general&question=nope',
        'scope=general&question=role', 'scope=general&limit=0', 'scope=general&limit=201', 'scope=general&limit=1x', 'scope=general&scope=project',
        'scope=general&extra=1', 'scope=general&fact_key[]=x', `scope=general&fact_key=${'x'.repeat(201)}`]) {
        const response = await api(`/api/members/${member.id}/evidence?${query}`);
        expect(response).toEqual({ status: 400, json: { error: expect.any(String) } });
    }
    expect((await api(`/api/members/${randomUUID()}/evidence?scope=general`)).status).toBe(404);
    expect((await api(`/api/members/${encodeURIComponent('Evidence Member')}/evidence?scope=general`)).status).toBe(400);
    expect((await api(`/api/members/${member.id}/evidence?scope=project&project_id=${randomUUID()}`)).status).toBe(404);
    const defaults = await api(`/api/members/${member.id}/evidence?scope=general&fact_key=&question=`);
    expect(defaults.status).toBe(200);
    expect(defaults.json.question).toEqual({ type: 'all', fact_key: null });
});

test('partial pages and corrected history stay distinguishable through the route', async () => {
    const first = await db.appendMemberMemory(member.id, { kind: 'fact', fact_key: 'profile.goal.a', text: 'Goal A', evidence: 'self_reported', source: 'consultation' });
    const corrected = await db.appendMemberMemory(member.id, { kind: 'fact', fact_key: 'profile.goal.a', text: 'Goal A (revised)', evidence: 'operator_confirmed', source: 'operator', supersedes_id: first.id });
    await db.appendMemberMemory(member.id, { kind: 'fact', fact_key: 'profile.goal.b', text: 'Goal B', evidence: 'self_reported', source: 'consultation' });
    const partial = await api(`/api/members/${member.id}/evidence?scope=general&question=goal&limit=1`);
    expect(partial.status).toBe(200);
    expect(partial.json.sources.general_assertions).toMatchObject({ status: 'partial', total: 2, truncated: true });
    expect(partial.json.sources.general_assertions.records).toHaveLength(1);
    expect(partial.json.context.history.corrected.records).toEqual([expect.objectContaining({ id: first.id, history_status: 'corrected', corrected_by: corrected.id })]);
    expect(partial.json.coverage.limit).toBe(1);
});
