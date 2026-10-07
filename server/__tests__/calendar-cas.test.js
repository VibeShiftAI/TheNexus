const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const createCalendarRouter = require('../routes/calendar');

describe('calendar dispatch projection compare-and-set', () => {
    let directory, db, server, url, previousPath;
    beforeAll(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-calendar-cas-'));
        previousPath = process.env.NEXUS_DB_PATH;
        process.env.NEXUS_DB_PATH = path.join(directory, 'test.db');
        jest.resetModules();
        db = require('../../db');
        const app = express(); app.use(express.json());
        app.use('/api/calendar', createCalendarRouter({ db }));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/api/calendar`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        if (previousPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = previousPath;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const put = (id, body) => fetch(`${url}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    async function seed(id) {
        return db.createCalendarEvent({ id, title: 'Fixture', start_time: '2026-10-07T00:05:00.000Z', end_time: '2026-10-07T00:20:00.000Z', status: 'scheduled', task_id: null });
    }
    const expected = row => ({ status: row.status, start_time: row.start_time, task_id: row.task_id });

    test('completion racing a delayed dispatch projection cannot move backward', async () => {
        const row = await seed('completion-race'); expect(row).toBeTruthy();
        await db.updateCalendarEvent(row.id, { status: 'completed' });
        const response = await put(row.id, { status: 'in_progress', expected: expected(row) });
        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.current.status).toBe('completed');
        expect((await db.getCalendarEvents()).find(e => e.id === row.id).status).toBe('completed');
    });
    test('an unchanged occurrence advances and drops control fields before SQL', async () => {
        const row = await seed('accepted');
        const response = await put(row.id, { status: 'in_progress', expected: expected(row) });
        expect(response.status).toBe(200);
        expect((await response.json()).status).toBe('in_progress');
    });
    test('a rescheduled occurrence is preserved', async () => {
        const row = await seed('moved');
        const moved = '2026-10-08T00:05:00.000Z';
        await db.updateCalendarEvent(row.id, { start_time: moved });
        const response = await put(row.id, { status: 'in_progress', expected: expected(row) });
        expect(response.status).toBe(409);
        expect((await response.json()).current.start_time).toBe(moved);
    });
    test('malformed preconditions fail without mutating the event', async () => {
        const row = await seed('malformed');
        const response = await put(row.id, { status: 'in_progress', expected: { status: 'scheduled' } });
        expect(response.status).toBe(400);
        expect((await db.getCalendarEvents()).find(e => e.id === row.id).status).toBe('scheduled');
    });
});
