const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { randomUUID } = require('crypto');
const { MemberMemorySnapshotSchema } = require('@praxis/contract');
const observation = { kind: 'observation', text: 'Private memory', evidence: 'observed', source: 'operator' };
let db;
let member;
let base;
let server;

async function api(method, url, body) {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    let json;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
}

beforeEach(async () => {
    process.env.NEXUS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-memory-route-')), 'nexus.db');
    jest.resetModules();
    db = require('../../db');
    member = await db.createContact({ name: 'Memory Member' });
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

test('canonical and alias routes expose the same snapshot and durable event', async () => {
    const created = await api('POST', `/api/members/${member.id}/memory`, observation);
    expect(created.status).toBe(201);
    expect(created.json.event.text).toBe(observation.text);
    const response = await api('GET', `/api/contacts/${member.id}/memory`);
    expect(response.status).toBe(200);
    expect(MemberMemorySnapshotSchema.safeParse(response.json).success).toBe(true);
    expect(response.json.timeline[0].id).toBe(created.json.event.id);
    expect((await api('GET', `/api/members/${member.id}`)).json.interaction_log).toEqual([]);
});

test('read query parsing rejects arrays, malformed integers and unknown scope fields', async () => {
    for (const query of ['limit=101', 'limit=0', 'limit=2.5', 'limit=1x', 'limit=1&limit=2', 'before_seq=0', 'before_seq=-1', 'before_seq[]=1', 'project_id=a&project_id=b', 'project_id[]=a', 'scope=all', 'limit=']) {
        const response = await api('GET', `/api/members/${member.id}/memory?${query}`);
        expect(response).toEqual({ status: 400, json: { error: expect.any(String) } });
    }
    const cached = await api('GET', `/api/members/${member.id}/memory?_cb=1725729000000`);
    expect(cached.status).toBe(200);
    const general = await api('GET', `/api/members/${member.id}/memory?project_id=`);
    expect(general.status).toBe(200);
    expect(general.json.project_id).toBeNull();
});

test('writes reject invalid bodies and return appropriate missing-member and stale-target errors', async () => {
    for (const body of [null, [], {}, { ...observation, text: {} }, { ...observation, evidence: 'legacy' },
        { ...observation, text: 'x'.repeat(20001) }, { ...observation, kind: 'fact' },
        { ...observation, due_at: '2027-01-01T00:00:00Z' }, { ...observation, member_id: member.id }]) {
        expect(await api('POST', `/api/members/${member.id}/memory`, body))
            .toEqual({ status: 400, json: { error: expect.any(String) } });
    }
    const missing = randomUUID();
    expect((await api('POST', `/api/members/${missing}/memory`, observation)).status).toBe(404);
    expect((await api('GET', `/api/members/${missing}/memory`)).status).toBe(404);
    const first = await api('POST', `/api/members/${member.id}/memory`, { ...observation, kind: 'fact', fact_key: 'tone' });
    const retract = { ...observation, kind: 'retraction', target_id: first.json.event.id };
    expect((await api('POST', `/api/members/${member.id}/memory`, retract)).status).toBe(201);
    expect((await api('POST', `/api/members/${member.id}/memory`, retract)).status).toBe(409);
});

test('scope reads never combine general or other project memory', async () => {
    const project = await db.upsertProject({ name: 'Scoped Memory', path: '/tmp/scoped-memory-test', type: 'app' });
    expect((await api('POST', `/api/members/${member.id}/memory`, { ...observation, project_id: project.id })).status).toBe(409);
    await db.linkContactToProject(project.id, member.id, {});
    await api('POST', `/api/members/${member.id}/memory`, { ...observation, project_id: project.id });
    const general = (await api('GET', `/api/members/${member.id}/memory`)).json;
    expect(general.total_events).toBe(1);
    expect(general.timeline[0].source).toBe('member_directory');
    await db.unlinkContactFromProject(project.id, member.id);
    expect((await api('GET', `/api/members/${member.id}/memory?project_id=${project.id}`)).json.total_events).toBe(1);
});

test('legacy log accepts stable provenance/retries, returns validation errors, and remains compatible', async () => {
    const payload = { note: 'External exchange', source: 'feedback', source_ref: 'submission:123', idempotency_key: 'feedback:123' };
    for (let i = 0; i < 2; i++) {
        const response = await api('POST', `/api/members/${member.id}/log`, payload);
        expect(response.status).toBe(200);
        expect(response.json.member.interaction_log).toHaveLength(1);
    }
    const memory = await api('GET', `/api/members/${member.id}/memory`);
    expect(memory.status).toBe(200);
    expect(memory.json.timeline[0].source_ref).toBe('submission:123');
    expect((await api('POST', `/api/members/${member.id}/log`, { note: {} })).status).toBe(400);
    expect((await api('POST', `/api/members/${member.id}/log`, { note: 'x'.repeat(20001) })).status).toBe(400);
    expect((await api('POST', `/api/members/${member.id}/log`, { ...payload, note: 'Changed' })).status).toBe(409);
});
