/**
 * GET /api/member-commitments over the real db facade: explicit scope, canonical
 * ledger statuses, cross-project aggregation, coverage/paging, and a draft link
 * that moves neither delivery nor commitment status.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
let db, member, other, projectA, projectB, base, server, dbDir;

const PAST = '2026-09-10T09:00:00.000Z';
const FUTURE = '2036-09-25T09:00:00.000Z';
const commitment = (text, extra = {}) => ({ kind: 'commitment', text, owner: 'member', evidence: 'self_reported', source: 'stakeholder_meeting', ...extra });

async function api(url) {
    const response = await fetch(base + url);
    let json;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
}

beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-commitments-route-'));
    process.env.NEXUS_DB_PATH = path.join(dbDir, 'nexus.db');
    jest.resetModules();
    db = require('../../db');
    member = await db.createContact({ name: 'Commitment Member', email: 'commitment-member@example.com' });
    other = await db.createContact({ name: 'Second Member', email: 'second-member@example.com' });
    projectA = await db.upsertProject({ name: 'Commitment Project A', path: '/tmp/commitment-project-a', type: 'app' });
    projectB = await db.upsertProject({ name: 'Commitment Project B', path: '/tmp/commitment-project-b', type: 'app' });
    for (const project of [projectA, projectB]) {
        for (const contact of [member, other]) expect(await db.linkContactToProject(project.id, contact.id, { role: 'Tester' })).toBe(true);
    }
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/api/member-commitments', require('../routes/member-commitments')({ db }));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    delete process.env.NEXUS_DB_PATH;
    // The facade exposes no close(); resetModules drops its connection, then the temp
    // database (and its WAL sidecars) goes with the directory instead of accumulating.
    jest.resetModules();
    db = undefined;
    fs.rmSync(dbDir, { recursive: true, force: true });
});

test('the operator aggregate spans projects and carries statuses, owners, sources and unknown deadlines', async () => {
    const overdue = await db.appendMemberMemory(member.id, commitment('I will send the signed NDA.',
        { project_id: projectA.id, due_at: PAST, source_ref: 'meeting:2026-09-08#3' }));
    const vague = await db.appendMemberMemory(member.id, commitment('I will share the logo files soon.', { project_id: projectA.id }));
    const praxisPromise = await db.appendMemberMemory(other.id, commitment('Praxis will circulate the agenda.',
        { project_id: projectB.id, owner: 'praxis', due_at: FUTURE }));
    const closed = await db.appendMemberMemory(other.id, commitment('Praxis will book the venue.', { project_id: projectB.id, owner: 'praxis' }));
    const resolution = await db.appendMemberMemory(other.id, { kind: 'resolution', target_id: closed.id, outcome: 'cancelled',
        project_id: projectB.id, text: 'Meeting moved online.', evidence: 'operator_confirmed', source: 'operator' });

    const response = await api('/api/member-commitments?scope=operator&_cb=1');
    expect(response.status).toBe(200);
    expect(response.json.status).toBe('ok');
    expect(response.json.summary).toMatchObject({ total: 4, by_status: { open: 2, overdue: 1, completed: 0, cancelled: 1 },
        by_owner: { praxis: 2, member: 2 }, deadline_unknown: 2 });
    const entries = Object.fromEntries(response.json.commitments.map(entry => [entry.id, entry]));
    expect(entries[overdue.id]).toMatchObject({ status: 'overdue', owner: 'member', member: { id: member.id, name: 'Commitment Member' },
        project: { id: projectA.id, name: 'Commitment Project A', status: 'active' }, due: { status: 'recorded', due_at: PAST, overdue: true },
        source: { text: 'I will send the signed NDA.', source: 'stakeholder_meeting', source_ref: 'meeting:2026-09-08#3', event_id: overdue.id } });
    expect(entries[vague.id].due).toMatchObject({ status: 'unknown', due_at: null, overdue: false });
    expect(entries[praxisPromise.id]).toMatchObject({ status: 'open', owner: 'praxis', project: { id: projectB.id, name: 'Commitment Project B' } });
    expect(entries[closed.id]).toMatchObject({ status: 'cancelled', resolution: { id: resolution.id, outcome: 'cancelled', text: 'Meeting moved online.' } });
    expect(response.json.coverage).toMatchObject({ scope: 'operator', members_included: 'all', projects_included: 'all_projects_and_general',
        ledger: { status: 'available' }, paging: { complete: true, truncated: false, matched_total: 4 } });

    const scoped = await api(`/api/member-commitments?scope=member&member_id=${member.id}&project_id=${encodeURIComponent(projectA.id)}`);
    expect(scoped.status).toBe(200);
    expect(scoped.json.commitments.map(entry => entry.id).sort()).toEqual([overdue.id, vague.id].sort());
    expect(JSON.stringify(scoped.json)).not.toContain(projectB.id);
});

test('paging reports its cursor, and a filtered page keeps the scope-wide totals', async () => {
    const created = [];
    for (let index = 0; index < 3; index += 1) {
        created.push(await db.appendMemberMemory(member.id, commitment(`Promise ${index}`, { project_id: projectA.id, due_at: index === 1 ? PAST : FUTURE })));
    }
    const first = await api(`/api/member-commitments?scope=member&member_id=${member.id}&limit=2`);
    expect(first.json.commitments.map(entry => entry.id)).toEqual([created[2].id, created[1].id]);
    expect(first.json.coverage.paging).toMatchObject({ limit: 2, returned: 2, matched_total: 3, truncated: true, complete: false });
    const next = await api(`/api/member-commitments?scope=member&member_id=${member.id}&limit=2&before_seq=${first.json.coverage.paging.next_before_seq}`);
    expect(next.json.commitments.map(entry => entry.id)).toEqual([created[0].id]);
    expect(next.json.coverage.paging).toMatchObject({ truncated: false, complete: true, next_before_seq: null });

    const overdueOnly = await api(`/api/member-commitments?scope=member&member_id=${member.id}&status=overdue`);
    expect(overdueOnly.json.commitments.map(entry => entry.id)).toEqual([created[1].id]);
    expect(overdueOnly.json.summary.total).toBe(3);
    expect(overdueOnly.json.coverage).toMatchObject({ status_filter: ['overdue'], paging: { matched_total: 1, complete: true } });
});

test('a prepared draft is linked without touching delivery or commitment status', async () => {
    const promise = await db.appendMemberMemory(member.id, commitment('I will confirm the sponsorship.', { project_id: projectA.id, due_at: PAST }));
    await db.appendMemberMemory(member.id, { kind: 'observation', project_id: projectA.id, text: 'Follow-up draft prepared for approval.',
        source_ref: `commitment:${promise.id} draft:hitl-followup-42`, evidence: 'observed', source: 'praxis.followup' });
    await db.appendMemberMemory(member.id, { kind: 'observation', project_id: projectA.id, text: 'Draft revised.',
        source_ref: `commitment:${promise.id} draft:hitl-followup-42`, evidence: 'observed', source: 'praxis.followup' });

    const response = await api(`/api/member-commitments?scope=member&member_id=${member.id}&project_id=${encodeURIComponent(projectA.id)}`);
    const entry = response.json.commitments.find(item => item.id === promise.id);
    expect(entry.status).toBe('overdue');
    expect(entry.resolution).toBeNull();
    expect(entry.follow_ups.drafts).toMatchObject({ total: 1, status: 'present' });
    expect(entry.follow_ups.drafts.records[0]).toMatchObject({ draft_id: 'hitl-followup-42', prepared_count: 2, status: 'prepared', sent_as: null });
    expect(entry.follow_ups.messages).toMatchObject({ total: 0, status: 'missing' });
    expect(response.json.summary.by_status).toMatchObject({ overdue: 1, completed: 0, cancelled: 0 });
});

test('bad queries are refused and unknown members or projects are 404, never an empty queue', async () => {
    expect((await api('/api/member-commitments')).status).toBe(400);
    expect((await api('/api/member-commitments?scope=everything')).status).toBe(400);
    expect((await api('/api/member-commitments?scope=operator&member_id=' + member.id)).status).toBe(400);
    expect((await api('/api/member-commitments?scope=member&member_id=commitment-member@example.com')).status).toBe(400);
    expect((await api('/api/member-commitments?scope=operator&status=stale')).status).toBe(400);
    expect((await api('/api/member-commitments?scope=operator&limit=0')).status).toBe(400);
    expect((await api('/api/member-commitments?scope=operator&unexpected=1')).status).toBe(400);
    const missingMember = await api('/api/member-commitments?scope=member&member_id=11111111-1111-4111-8111-111111111111');
    expect(missingMember.status).toBe(404);
    expect(missingMember.json).toEqual({ error: 'Member not found' });
    const missingProject = await api('/api/member-commitments?scope=project&project_id=no-such-project');
    expect(missingProject.status).toBe(404);
    expect(missingProject.json).toEqual({ error: 'Project not found' });
});

test('an unreadable ledger answers 503 with status unavailable rather than an empty list', async () => {
    const offline = express();
    offline.use('/api/member-commitments', require('../routes/member-commitments')({
        db: { listMemberCommitments: async () => ({ status: 'unavailable', commitments: [], summary: null,
            coverage: { ledger: { status: 'unavailable', reason: 'The member memory ledger is not initialized on this database.' } } }) },
    }));
    const offlineServer = http.createServer(offline);
    await new Promise(resolve => offlineServer.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${offlineServer.address().port}/api/member-commitments?scope=operator`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'unavailable', summary: null, commitments: [] });
    await new Promise(resolve => offlineServer.close(resolve));
});
