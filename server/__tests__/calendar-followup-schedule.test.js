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

// Every test but the two that exercise the real Praxis client answers with S9.
async function withServer(db, run, routerOptions = { allocateSlotNumber: async () => 9 }) {
    const app = express(); app.use(express.json());
    app.use('/api/calendar', createCalendarRouter({ db, now: () => NOW, ...routerOptions }));
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
    test('a plan event tagged S<number> that spilled past midnight is still this plan', () => {
        const slot = followUps.planFollowUpSlot([
            event({ id: 'spill', title: 'S7 · Spilled', status: 'scheduled', start_time: '2026-10-18T05:30:00.000Z', end_time: '2026-10-18T06:00:00.000Z' }),
        ], NOW);
        expect(slot.start).toBe('2026-10-18T06:00:00.000Z');
        expect(slot.anchor.id).toBe('spill');
    });
    test('a numbered follow-up already on tomorrow does not extend today\'s plan', () => {
        const slot = followUps.planFollowUpSlot([
            event({ id: 'today', status: 'scheduled', start_time: '2026-10-17T18:00:00.000Z', end_time: '2026-10-17T19:00:00.000Z' }),
            event({ id: 'tomorrow-follow-up', title: 'S4 · Follow-up: Later', description: `Workspace: /p${followUps.FOLLOW_UP_MARKER}Nexus Task: x`, status: 'scheduled', start_time: '2026-10-18T14:00:00.000Z', end_time: '2026-10-18T14:30:00.000Z' }),
        ], NOW);
        expect(slot.anchor.id).toBe('today');
    });
    test('a title that merely starts like a tag is unrelated work tomorrow, not this plan', () => {
        const slot = followUps.planFollowUpSlot([
            event({ id: 'today', status: 'scheduled', start_time: '2026-10-17T18:00:00.000Z', end_time: '2026-10-17T19:00:00.000Z' }),
            event({ id: 'bucket', title: 'S3 bucket cleanup', status: 'scheduled', start_time: '2026-10-18T05:30:00.000Z', end_time: '2026-10-18T06:00:00.000Z' }),
        ], NOW);
        expect(slot.anchor.id).toBe('today');
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
                title: `S9 · Follow-up: ${TASK.name}`, start_time: '2026-10-17T19:00:00.000Z', end_time: '2026-10-17T19:30:00.000Z',
            });
            expect(body.event.id).toMatch(/^followup-[0-9a-f]{32}$/);
            expect(body.event.description).toContain(`Workspace: ${PROJECT.path}\n`);
            expect(body.event.description).toContain(followUps.FOLLOW_UP_MARKER);
            expect(body.event.description).toContain(`Nexus Task: ${TASK.id}`);
            expect(db.created).toHaveLength(1);
        });
    });
    test('asks Praxis for the day number at the ledger route and writes it into the title', async () => {
        const seen = [];
        const praxis = express(); praxis.use(express.json());
        praxis.post('/api/schedule/slot-number', (req, res) => { seen.push(req.body); res.json({ slotNumber: 12, day: '2026-10-17', tag: 'S12' }); });
        const upstream = http.createServer(praxis);
        await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const previous = process.env.PRAXIS_URL;
        process.env.PRAXIS_URL = `http://127.0.0.1:${upstream.address().port}`;
        const db = fakeDb();
        try {
            await withServer(db, async (post) => {
                const response = await post({ taskId: TASK.id });
                expect(response.status).toBe(201);
                expect((await response.json()).event.title).toBe(`S12 · Follow-up: ${TASK.name}`);
            }, {});
            expect(seen).toEqual([{ taskId: TASK.id }]);
        } finally {
            if (previous === undefined) delete process.env.PRAXIS_URL; else process.env.PRAXIS_URL = previous;
            upstream.closeAllConnections();
            await new Promise(resolve => upstream.close(resolve));
        }
    });
    test('still schedules the follow-up, bare, when Praxis cannot number it', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const praxis = express();
        praxis.post('/api/schedule/slot-number', (_req, res) => res.status(404).json({ error: 'no such route on this Praxis' }));
        const upstream = http.createServer(praxis);
        await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const previous = process.env.PRAXIS_URL;
        process.env.PRAXIS_URL = `http://127.0.0.1:${upstream.address().port}`;
        const db = fakeDb();
        try {
            await withServer(db, async (post) => {
                const response = await post({ taskId: TASK.id });
                expect(response.status).toBe(201);
                expect((await response.json()).event.title).toBe(`Follow-up: ${TASK.name}`);
            }, {});
            expect(db.created).toHaveLength(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a slot number'));
        } finally {
            warn.mockRestore();
            if (previous === undefined) delete process.env.PRAXIS_URL; else process.env.PRAXIS_URL = previous;
            upstream.closeAllConnections();
            await new Promise(resolve => upstream.close(resolve));
        }
    });
    test('a task refused before it joins draws no number', async () => {
        const allocateSlotNumber = jest.fn(async () => 9);
        for (const db of [fakeDb({ task: { ...TASK, status: 'completed' } }), fakeDb({ task: null }), fakeDb({ project: { ...PROJECT, path: null } })]) {
            await withServer(db, async (post) => { await post({ taskId: TASK.id }); }, { allocateSlotNumber });
        }
        expect(allocateSlotNumber).not.toHaveBeenCalled();
    });
    test('the calendar is read again after the number arrives, so a double click cannot schedule the task twice', async () => {
        const order = [];
        const db = fakeDb();
        const read = db.getCalendarEvents;
        db.getCalendarEvents = async (...args) => { order.push('read'); return read(...args); };
        await withServer(db, async (post) => { await post({ taskId: TASK.id }); }, {
            allocateSlotNumber: async () => { order.push('number'); return 9; },
        });
        expect(order).toEqual(['read', 'number', 'read']);
    });
    test('a row written while the number was on its way still stops a second schedule', async () => {
        const pending = event({ id: 'pending', task_id: TASK.id, status: 'scheduled', title: 'S9 · Follow-up: HWC09', start_time: '2026-10-17T19:00:00.000Z' });
        const events = [];
        const db = fakeDb({ events });
        await withServer(db, async (post) => {
            const response = await post({ taskId: TASK.id });
            expect(response.status).toBe(409);
            expect((await response.json()).event.id).toBe('pending');
            expect(db.created).toHaveLength(0);
        }, { allocateSlotNumber: async () => { events.push(pending); return 9; } });
    });
    test('a task that already has a pending event is not scheduled twice and draws no number', async () => {
        const allocateSlotNumber = jest.fn(async () => 9);
        const pending = event({ id: 'pending', task_id: TASK.id, status: 'scheduled', title: 'Follow-up: HWC09', start_time: '2026-10-17T19:00:00.000Z' });
        const db = fakeDb({ events: [pending] });
        await withServer(db, async (post) => {
            const response = await post({ taskId: TASK.id });
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.event.id).toBe('pending');
            expect(db.created).toHaveLength(0);
        }, { allocateSlotNumber });
        expect(allocateSlotNumber).not.toHaveBeenCalled();
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
