const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { randomUUID, createHash } = require('crypto');
let db, member, server, base, databasePath;
const hash = text => createHash('sha256').update(text).digest('hex');
async function api(method, url, body) {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    let json;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
}
async function source(responseText = 'I know Rust.', projectId = null) {
    const captureId = randomUUID();
    const snapshot = { consultationId: randomUUID(), memberId: member.id, projectId, responseText,
        responseOrigin: 'member_reply', status: 'answered', question: 'What should I know?' };
    const text = JSON.stringify(snapshot);
    const event = await db.appendMemberMemory(member.id, { project_id: projectId, kind: 'observation', evidence: 'self_reported',
        source: 'consultation', text: `Consultation ${snapshot.consultationId}, answered, source part 1/1\n${text}`,
        source_ref: `consultation:${snapshot.consultationId}:revision:${captureId}:part:1/1`, occurred_at: '2026-09-08T10:00:00.000Z' });
    return { capture_id: captureId, source_hash: hash(text), source_event_ids: [event.id], extractor_version: 'member-profile-v1',
        candidates: [{ category: 'expertise', quote: responseText }] };
}
const url = () => `/api/members/${member.id}/profile-proposals`;
beforeEach(async () => {
    databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-profile-route-')), 'nexus.db');
    process.env.NEXUS_DB_PATH = databasePath;
    jest.resetModules(); db = require('../../db'); member = await db.createContact({ name: 'Proposal Member' });
    const app = express(); app.use(express.json({ strict: false }));
    const router = require('../routes/contacts')({ db });
    app.use('/api/members', router); app.use('/api/contacts', router);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    delete process.env.NEXUS_DB_PATH; jest.resetModules();
});

test('canonical and legacy routes submit, paginate, and review using the real database facade', async () => {
    const input = await source();
    const submitted = await api('POST', url(), input);
    expect(submitted.status).toBe(201);
    expect(submitted.json).toMatchObject({ member_id: member.id, project_id: null, capture_id: input.capture_id,
        proposals: [{ quote: 'I know Rust.', status: 'pending' }] });
    const page = await api('GET', `/api/contacts/${member.id}/profile-proposals?limit=1&_cb=123`);
    expect(page.status).toBe(200); expect(page.json.total).toBe(1); expect(page.json.memory_version).toBeGreaterThan(0);
    const review = await api('POST', `${url()}/${submitted.json.proposals[0].id}/review`, {
        decision: 'accept', expected_memory_version: page.json.memory_version,
    });
    expect(review.status).toBe(200); expect(review.json.proposal.status).toBe('applied');
    expect((await api('GET', `${url()}?status=applied`)).json.total).toBe(1);
    expect((await db.getMemberMemory(member.id)).current_facts[0]).toMatchObject({ text: 'I know Rust.', evidence: 'self_reported' });
});

test('strict query validation rejects arrays, unknown syntax, duplicate fields and invalid limits', async () => {
    for (const query of ['scope=all', 'project_id=', 'project_id=%20', 'project_id=a&project_id=b', 'project_id[]=a',
        'project_id[x]=a', 'status=all', 'status=pending&status=applied', 'status[]=', '_cb=1&_cb=2',
        'before_created_seq=0', 'before_created_seq=-1', 'before_created_seq=1.5', 'before_created_seq=01',
        'limit=0', 'limit=51', 'limit=', 'limit=1x', 'limit=2.5', 'limit=9007199254740992', 'limit=1&limit=2']) {
        expect(await api('GET', `${url()}?${query}`)).toEqual({ status: 400, json: { error: expect.any(String) } });
    }
    expect((await api('GET', url())).status).toBe(200);
    expect((await api('GET', `${url()}?limit=50&before_created_seq=1`)).status).toBe(200);
});

test('strict submission rejects malformed identifiers, candidate schema and unknown fields', async () => {
    const input = await source();
    const invalid = [null, [], {}, { ...input, member_id: member.id }, { ...input, project_id: null },
        { ...input, capture_id: 'fake' }, { ...input, source_hash: 'a'.repeat(63) },
        { ...input, source_hash: 'A'.repeat(64) }, { ...input, source_event_ids: [] },
        { ...input, source_event_ids: Array.from({ length: 33 }, () => randomUUID()) },
        { ...input, source_event_ids: [randomUUID(), 'not-uuid'] },
        { ...input, extractor_version: 'member-profile-v2' }, { ...input, candidates: null },
        { ...input, candidates: Array.from({ length: 9 }, () => input.candidates[0]) },
        ...[{ category: 'identity', quote: 'I know Rust.' }, { category: 'expertise', quote: '' },
            { category: 'expertise', quote: '  ' }, { category: 'expertise', quote: 1 },
            { category: 'expertise', quote: 'x'.repeat(2001) }, { category: 'expertise', quote: 'I know Rust.', auto_apply: true }]
            .map(candidate => ({ ...input, candidates: [candidate] }))];
    for (const body of invalid) expect(await api('POST', url(), body)).toEqual({ status: 400, json: { error: expect.any(String) } });
    expect((await api('GET', url())).json.total).toBe(0);
});

test('strict reviews and stale acceptance return validation and conflict errors', async () => {
    const input = await source(); const submitted = await api('POST', url(), input);
    expect(submitted.status).toBe(201);
    const reviewUrl = `${url()}/${submitted.json.proposals[0].id}/review`;
    for (const body of [null, [], {}, { decision: 'reject', expected_memory_version: 0 }, { decision: 'accept' },
        { decision: 'accept', expected_memory_version: '1' }, { decision: 'accept', expected_memory_version: -1 },
        { decision: 'accept', expected_memory_version: 0.5 }, { decision: 'accept', expected_memory_version: 9007199254740992 },
        { decision: 'accept', expected_memory_version: 0, text: 'changed' }]) {
        expect(await api('POST', reviewUrl, body)).toEqual({ status: 400, json: { error: expect.any(String) } });
    }
    expect((await api('POST', reviewUrl, { decision: 'accept', expected_memory_version: 0 })).status).toBe(409);
    expect((await api('POST', reviewUrl, { decision: 'dismiss', expected_memory_version: 0 })).status).toBe(200);
    expect((await api('POST', reviewUrl, { decision: 'accept', expected_memory_version: 0 })).status).toBe(409);
    expect((await api('POST', `${url()}/not-uuid/review`, { decision: 'dismiss', expected_memory_version: 0 })).status).toBe(400);
    expect((await api('POST', `${url()}/${randomUUID()}/review`, { decision: 'dismiss', expected_memory_version: 0 })).status).toBe(404);
});

test('project queues stay exact after unlink, while new reviews and batches require the link', async () => {
    const project = await db.upsertProject({ name: 'Profile Scope', path: '/tmp/profile-scope', type: 'app' });
    await db.linkContactToProject(project.id, member.id, {});
    const input = await source('I know Rust.', project.id);
    const next = await source('I know SQL.', project.id);
    const submitted = await api('POST', url(), input);
    expect(submitted.status).toBe(201);
    expect((await api('GET', url())).json.total).toBe(0);
    await db.unlinkContactFromProject(project.id, member.id);
    const page = await api('GET', `${url()}?project_id=${project.id}`);
    expect(page.status).toBe(200); expect(page.json.total).toBe(1);
    expect((await api('POST', url(), next)).status).toBe(409);
    expect((await api('POST', `${url()}/${submitted.json.proposals[0].id}/review`, { decision: 'accept', expected_memory_version: page.json.memory_version })).status).toBe(409);
    const missing = `/api/members/${randomUUID()}/profile-proposals`;
    expect((await api('GET', missing)).status).toBe(404);
    expect((await api('POST', missing, input)).status).toBe(404);
});
