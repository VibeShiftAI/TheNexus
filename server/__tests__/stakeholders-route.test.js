/**
 * Stakeholder governance — PDM link flag, request queue, the decision
 * endpoint, per-project comms settings / report template columns, and
 * stakeholder meeting series on the calendar (2026-08-22).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');

function loadFreshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stakeholders-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'nexus.db');
    jest.resetModules();
    return require('../../db');
}

async function withServer(mount, handler) {
    const app = express();
    app.use(express.json());
    mount(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await handler(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function api(base, method, url, body) {
    const res = await fetch(`${base}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
}

describe('stakeholder governance', () => {
    afterEach(() => {
        delete process.env.NEXUS_DB_PATH;
        jest.resetModules();
    });

    test('migrations add the PDM flag, project comms columns, and calendar series columns', async () => {
        const db = loadFreshDb();
        const Database = require('better-sqlite3');
        const raw = new Database(process.env.NEXUS_DB_PATH, { readonly: true });
        const cols = (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
        expect(cols('project_contacts')).toContain('decision_maker');
        expect(cols('projects')).toEqual(expect.arrayContaining(['comms_settings', 'report_template']));
        expect(cols('calendar_events')).toEqual(expect.arrayContaining(['series_id', 'recurrence', 'attendees']));
        raw.close();
        expect(typeof db.listStakeholderRequests).toBe('function');
    });

    test('PDM flag: link, partial PATCH, stakeholders route, PDM-first ordering', async () => {
        const db = loadFreshDb();
        const project = await db.upsertProject({ name: 'Meeple Test', path: '/tmp/meeple-test', type: 'app' });
        const tester = await db.createContact({ name: 'Dean', email: 'dean@example.com' });
        const pdm = await db.createContact({ name: 'Sis', email: 'sis@example.com' });
        await db.linkContactToProject(project.id, tester.id, { role: 'Tester' });
        await db.linkContactToProject(project.id, pdm.id, { role: 'Client' });

        const createContactsRouter = require('../routes/contacts');
        const createStakeholderRouters = require('../routes/stakeholders');
        await withServer((app) => {
            app.use('/api/contacts', createContactsRouter({ db }));
            const routers = createStakeholderRouters({ db });
            app.use('/api/projects', routers.projects);
            app.use('/api/tasks', routers.tasks);
        }, async (base) => {
            // Flip the PDM flag without touching role/notes.
            const patch = await api(base, 'PATCH', `/api/contacts/${pdm.id}/projects/${project.id}`, { decision_maker: true });
            expect(patch.status).toBe(200);
            const linked = await db.listProjectContacts(project.id);
            const sis = linked.find((c) => c.id === pdm.id);
            expect(sis.decision_maker).toBe(true);
            expect(sis.role).toBe('Client'); // untouched by the partial PATCH
            expect(linked[0].id).toBe(pdm.id); // PDMs sort first

            const sh = await api(base, 'GET', `/api/projects/${project.id}/stakeholders`);
            expect(sh.status).toBe(200);
            expect(sh.json.decision_makers.map((m) => m.name)).toEqual(['Sis']);
            expect(sh.json.members).toHaveLength(2);

            // Re-observing (feedback pipeline) never clears the flag.
            await db.linkContactToProject(project.id, pdm.id, { role: 'Tester' });
            expect((await db.listProjectDecisionMakers(project.id)).map((m) => m.name)).toEqual(['Sis']);

            // Clearing works through the same PATCH.
            await api(base, 'PATCH', `/api/contacts/${pdm.id}/projects/${project.id}`, { decision_maker: false });
            expect(await db.listProjectDecisionMakers(project.id)).toEqual([]);
        });
    });

    test('request queue + decision endpoint transitions', async () => {
        const db = loadFreshDb();
        const project = await db.upsertProject({ name: 'Gate Test', path: '/tmp/gate-test', type: 'app' });
        const pdm = await db.createContact({ name: 'Sis', email: 'sis@example.com' });
        await db.linkContactToProject(project.id, pdm.id, { role: 'Client', decision_maker: true });
        const gate = (extra = {}) => ({
            status: 'pending',
            requested_by: { email: 'dean@example.com' },
            requested_at: '2026-08-22T12:00:00.000Z',
            feedback_tag: 'PX-MM-9',
            ...extra,
        });
        const [a, b, plain] = await db.batchCreateTasks([
            { project_id: project.id, name: 'Bigger dice', status: 'blocked', source: 'feedback', metadata: { stakeholder_gate: gate(), status_message: 'Awaiting Primary Decision Maker approval' } },
            { project_id: project.id, name: 'Bigger dice please', status: 'blocked', source: 'feedback', metadata: { stakeholder_gate: gate({ feedback_tag: 'PX-MM-10' }) } },
            { project_id: project.id, name: 'Unrelated task', status: 'todo', description: 'mentions stakeholder_gate in prose only' },
        ]);
        expect(a.status).toBe('blocked');

        const createStakeholderRouters = require('../routes/stakeholders');
        await withServer((app) => {
            const routers = createStakeholderRouters({ db });
            app.use('/api/projects', routers.projects);
            app.use('/api/tasks', routers.tasks);
        }, async (base) => {
            const pending = await api(base, 'GET', `/api/projects/${project.id}/requests`);
            expect(pending.status).toBe(200);
            expect(pending.json.requests.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
            expect(pending.json.requests[0].gate.status).toBe('pending');
            expect(pending.json.requests.find((r) => r.id === plain.id)).toBeUndefined();

            // Validation.
            expect((await api(base, 'POST', `/api/tasks/${a.id}/stakeholder-decision`, { decision: 'nope' })).status).toBe(400);
            expect((await api(base, 'POST', `/api/tasks/${a.id}/stakeholder-decision`, { decision: 'duplicate' })).status).toBe(400);
            expect((await api(base, 'POST', `/api/tasks/${plain.id}/stakeholder-decision`, { decision: 'approve' })).status).toBe(409);
            expect((await api(base, 'POST', `/api/tasks/does-not-exist/stakeholder-decision`, { decision: 'approve' })).status).toBe(404);

            // Approve → idea, gate approved, history + decided_by, member log note.
            const approved = await api(base, 'POST', `/api/tasks/${a.id}/stakeholder-decision`, {
                decision: 'approve', note: 'Yes please', decided_by: { member_id: pdm.id, name: 'Sis', via: 'report' },
            });
            expect(approved.status).toBe(200);
            expect(approved.json.task.status).toBe('idea');
            expect(approved.json.gate.status).toBe('approved');
            expect(approved.json.gate.decided_by).toEqual({ member_id: pdm.id, name: 'Sis', via: 'report' });
            expect(approved.json.gate.history).toHaveLength(1);
            expect(approved.json.task.metadata.status_message).toMatch(/Approved/);
            const member = await db.getContact(pdm.id);
            expect(member.interaction_log.some((e) => /approved request "Bigger dice"/.test(e.note))).toBe(true);

            // Duplicate → cancelled with duplicate_of.
            const dup = await api(base, 'POST', `/api/tasks/${b.id}/stakeholder-decision`, {
                decision: 'duplicate', duplicate_of: a.id, decided_by: { name: 'Robert (operator)', via: 'operator' },
            });
            expect(dup.status).toBe(200);
            expect(dup.json.task.status).toBe('cancelled');
            expect(dup.json.gate.duplicate_of).toBe(a.id);

            // Queue is now empty for pending; "all" still lists both.
            expect((await api(base, 'GET', `/api/projects/${project.id}/requests`)).json.requests).toHaveLength(0);
            expect((await api(base, 'GET', `/api/projects/${project.id}/requests?status=all`)).json.requests).toHaveLength(2);

            // Defer keeps it blocked; reject cancels.
            const [c] = await db.batchCreateTasks([
                { project_id: project.id, name: 'Neon theme', status: 'blocked', source: 'feedback', metadata: { stakeholder_gate: gate() } },
            ]);
            const deferred = await api(base, 'POST', `/api/tasks/${c.id}/stakeholder-decision`, { decision: 'defer', note: 'Make it less bright' });
            expect(deferred.json.task.status).toBe('blocked');
            expect(deferred.json.gate.status).toBe('deferred');
            const rejected = await api(base, 'POST', `/api/tasks/${c.id}/stakeholder-decision`, { decision: 'reject' });
            expect(rejected.json.task.status).toBe('cancelled');
            expect(rejected.json.gate.history).toHaveLength(2);
        });
    });

    test('projects PATCH accepts comms_settings / report_template as JSON objects', async () => {
        const db = loadFreshDb();
        const project = await db.upsertProject({ name: 'Comms Test', path: '/tmp/comms-test', type: 'app' });
        const updated = await db.updateProject(project.id, {
            comms_settings: { send_mode: 'auto', quiet_minutes: 45 },
            report_template: { version: 1, brand: { name: 'Comms Test', accent: '#ff0000' } },
        });
        expect(updated.comms_settings).toEqual({ send_mode: 'auto', quiet_minutes: 45 });
        expect(updated.report_template.brand.accent).toBe('#ff0000');
        const fetched = await db.getProject(project.id);
        expect(fetched.comms_settings.quiet_minutes).toBe(45);
    });

    test('calendar: stakeholder meeting series materialize, filter, and delete', async () => {
        const db = loadFreshDb();
        const project = await db.upsertProject({ name: 'Meeting Test', path: '/tmp/meeting-test', type: 'app' });
        const createCalendarRouter = require('../routes/calendar');
        await withServer((app) => {
            app.use('/api/calendar', createCalendarRouter({ db }));
        }, async (base) => {
            const bad = await api(base, 'POST', '/api/calendar/series', { title: 'x' });
            expect(bad.status).toBe(400);
            const weekly = await api(base, 'POST', '/api/calendar/series', {
                title: 'Meeple review', start_time: '2026-09-01T18:00:00.000Z', duration_minutes: 30,
                recurrence: 'weekly', count: 4, project_id: project.id, attendees: ['m1', 'm2'],
            });
            expect(weekly.status).toBe(201);
            expect(weekly.json.events).toHaveLength(4);
            expect(weekly.json.events[1].start_time).toBe('2026-09-08T18:00:00.000Z');
            expect(weekly.json.events[0].end_time).toBe('2026-09-01T18:30:00.000Z');
            expect(weekly.json.events[0].event_type).toBe('stakeholder_meeting');
            expect(weekly.json.events[0].attendees).toEqual(['m1', 'm2']);
            expect(weekly.json.events.every((e) => e.series_id === weekly.json.series_id)).toBe(true);

            const oneOff = await api(base, 'POST', '/api/calendar/series', {
                title: 'Kickoff', start_time: '2026-09-03T15:00:00.000Z', project_id: project.id,
            });
            expect(oneOff.json.events).toHaveLength(1);
            expect(oneOff.json.events[0].recurrence).toBeNull();

            const monthly = await api(base, 'POST', '/api/calendar/series', {
                title: 'Monthly', start_time: '2026-01-31T15:00:00.000Z', recurrence: 'monthly', count: 3, project_id: project.id,
            });
            expect(monthly.json.events.map((e) => e.start_time.slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);

            const filtered = await api(base, 'GET', `/api/calendar?start=2026-09-01T00:00:00.000Z&end=2026-09-30T00:00:00.000Z&project_id=${project.id}&event_type=stakeholder_meeting`);
            expect(filtered.json).toHaveLength(5);

            const del = await api(base, 'DELETE', `/api/calendar/series/${weekly.json.series_id}?from=2026-09-09T00:00:00.000Z`);
            expect(del.json.deleted).toBe(2);
            const remaining = await api(base, 'GET', `/api/calendar?series_id=${weekly.json.series_id}`);
            expect(remaining.json).toHaveLength(2);
        });
    });
});
