/**
 * POST /api/calendar/follow-ups: a prepared follow-up gets a calendar slot
 * right after today's last planned task, once, as an event Praxis's own
 * follow-up tooling recognises. Stub db: the route's reads and the one write
 * are the whole contract.
 */
const express = require('express');
const http = require('http');
const createCalendarRouter = require('../routes/calendar');
const followUps = require('../services/followup-schedule');

// A fixed "now": Friday 2026-10-17 10:47 EDT.
const NOW = new Date('2026-10-17T14:47:00.000Z');
const TASK = { id: 'a561fe53-0e88-4401-a0cb-57f7b0bbadb4', name: 'HWC09 Redesign Health Wealth Capital', status: 'in_progress', project_id: 'hwc' };
const PROJECT = { id: 'hwc', name: 'Joey Lautrup Health Tracking App', path: '/Volumes/Projects/Joey Lautrup Health Tracking App' };

const event = (partial) => ({
    id: 'evt', title: '[Slot 1] Planned', task_id: 'other', status: 'completed', event_type: 'praxis_task',
    start_time: '2026-10-17T13:00:00.000Z', end_time: '2026-10-17T14:00:00.000Z', ...partial,
});

function fakeDb({ task = TASK, project = PROJECT, events = [] } = {}) {
    const created = [];
    return {
        created,
        getTask: async (id) => (task && id === task.id ? task : null),
        getProject: async (id) => (project && id === project.id ? project : null),
        getCalendarEvents: async (_start, _end, filters) => events.filter(e => !filters?.eventType || e.event_type === filters.eventType),
        createCalendarEvent: async (row) => { created.push(row); return { ...row, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }; },
    };
}

async function withServer(db, run) {
    const app = express(); app.use(express.json());
    app.use('/api/calendar', createCalendarRouter({ db, now: () => NOW }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const post = (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/calendar/follow-ups`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    try { await run(post); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

describe('planFollowUpSlot', () => {
    test('lands right after the latest planned task of the day, by end time', () => {
        const slot = followUps.planFollowUpSlot([
            event({ id: 'early', start_time: '2026-10-17T13:00:00.000Z', end_time: '2026-10-17T14:00:00.000Z' }),
            event({ id: 'late', title: '[Slot 6] Later', status: 'scheduled', start_time: '2026-10-17T20:00:00.000Z', end_time: '2026-10-17T20:45:00.000Z' }),
            event({ id: 'system', title: 'Knowledge summaries', task_id: null, event_type: 'local_llm:knowledge', start_time: '2026-10-18T07:00:00.000Z' }),
            event({ id: 'tomorrow', title: 'Unrelated tomorrow', status: 'scheduled', start_time: '2026-10-18T14:00:00.000Z', end_time: '2026-10-18T15:00:00.000Z' }),
        ], NOW);
        expect(slot.start).toBe('2026-10-17T20:45:00.000Z');
        expect(slot.end).toBe('2026-10-17T21:15:00.000Z');
        expect(slot.anchor).toMatchObject({ id: 'late', title: '[Slot 6] Later' });
    });
    test('a plan that spilled past midnight keeps its [Slot N] tail; skipped slots do not anchor', () => {
        const slot = followUps.planFollowUpSlot([
            event({ id: 'spill', title: '[Slot 7] Spilled', status: 'scheduled', start_time: '2026-10-18T05:30:00.000Z', end_time: '2026-10-18T06:00:00.000Z' }),
            event({ id: 'skipped', title: '[Slot 8] Skipped', status: 'skipped', start_time: '2026-10-18T07:00:00.000Z', end_time: '2026-10-18T08:00:00.000Z' }),
        ], NOW);
        expect(slot.start).toBe('2026-10-18T06:00:00.000Z');
        expect(slot.anchor.id).toBe('spill');
    });
    test('never schedules in the past: a finished plan yields a slot a couple of minutes from now, and an empty day the same', () => {
        const done = followUps.planFollowUpSlot([event({ id: 'done', end_time: '2026-10-17T08:20:00.000Z', start_time: '2026-10-17T08:00:00.000Z' })], NOW);
        expect(done.start).toBe(new Date(NOW.getTime() + followUps.LEAD_MS).toISOString());
        expect(done.anchor.id).toBe('done');
        const empty = followUps.planFollowUpSlot([], NOW);
        expect(empty.start).toBe(done.start);
        expect(empty.anchor).toBeNull();
    });
    test('a planned task without an end_time is assumed to run an hour', () => {
        const slot = followUps.planFollowUpSlot([event({ id: 'open', status: 'in_progress', start_time: '2026-10-17T14:30:00.000Z', end_time: null })], NOW);
        expect(slot.start).toBe('2026-10-17T15:30:00.000Z');
    });
});

describe('POST /api/calendar/follow-ups', () => {
    test('creates one scheduled praxis_task event after the last planned task, in the shape Praxis recognises as a follow-up', async () => {
        const db = fakeDb({ events: [event({ id: 'last', title: '[Slot 3] Last planned', status: 'scheduled', start_time: '2026-10-17T18:00:00.000Z', end_time: '2026-10-17T19:00:00.000Z' })] });
        await withServer(db, async (post) => {
            const response = await post({ taskId: TASK.id });
            expect(response.status).toBe(201);
            const body = await response.json();
            expect(body.after).toMatchObject({ id: 'last', title: '[Slot 3] Last planned' });
            expect(body.event).toMatchObject({
                task_id: TASK.id, project_id: 'hwc', event_type: 'praxis_task', status: 'scheduled',
                title: `Follow-up: ${TASK.name}`, start_time: '2026-10-17T19:00:00.000Z', end_time: '2026-10-17T19:30:00.000Z',
            });
            expect(body.event.id).toMatch(/^followup-[0-9a-f]{32}$/);
            expect(body.event.description).toContain(`Workspace: ${PROJECT.path}\n`);
            expect(body.event.description).toContain(followUps.FOLLOW_UP_MARKER);
            expect(body.event.description).toContain(`Nexus Task: ${TASK.id}`);
            expect(db.created).toHaveLength(1);
        });
    });
    test('a task that already has a pending event is not scheduled twice', async () => {
        const pending = event({ id: 'pending', task_id: TASK.id, status: 'scheduled', title: 'Follow-up: HWC09', start_time: '2026-10-17T19:00:00.000Z' });
        const db = fakeDb({ events: [pending] });
        await withServer(db, async (post) => {
            const response = await post({ taskId: TASK.id });
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.event.id).toBe('pending');
            expect(db.created).toHaveLength(0);
        });
    });
    test('closed tasks, unknown tasks, missing workspaces and malformed bodies write nothing', async () => {
        const closed = fakeDb({ task: { ...TASK, status: 'completed' } });
        await withServer(closed, async (post) => { expect((await post({ taskId: TASK.id })).status).toBe(409); });
        const unknown = fakeDb({ task: null });
        await withServer(unknown, async (post) => { expect((await post({ taskId: TASK.id })).status).toBe(404); });
        const noPath = fakeDb({ project: { ...PROJECT, path: null } });
        await withServer(noPath, async (post) => { expect((await post({ taskId: TASK.id })).status).toBe(422); });
        const malformed = fakeDb();
        await withServer(malformed, async (post) => {
            expect((await post({ taskId: TASK.id, start_time: '2026-10-17T00:00:00Z' })).status).toBe(400);
            expect((await post({ taskId: '../x' })).status).toBe(400);
            expect((await post({ taskId: TASK.id }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
        });
        for (const db of [closed, unknown, noPath, malformed]) expect(db.created).toHaveLength(0);
    });
    test('a calendar write that does not come back scheduled is reported, not acknowledged', async () => {
        const db = fakeDb(); db.createCalendarEvent = async () => null;
        await withServer(db, async (post) => {
            const response = await post({ taskId: TASK.id });
            expect(response.status).toBe(500);
            expect((await response.json()).error).toMatch(/did not confirm/);
        });
    });
});
