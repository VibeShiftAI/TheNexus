const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const Database = require('better-sqlite3');

let dir, raw, db, server, base, io;
const oldDbPath = process.env.NEXUS_DB_PATH;
const event = (extra = {}) => ({ event_type: 'task_qa_passed', title: 'Synthetic task verified',
    task_id: 'synthetic-task', source: 'praxis:qa', message: 'Verified, with the saved evidence.',
    metadata: { completionId: 'synthetic-completion', a: 1 }, idempotency_key: 'completion:synthetic', ...extra });
async function post(body) {
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
}
beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-event-receipts-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'test.db');
    jest.resetModules(); db = require('../../db'); raw = new Database(process.env.NEXUS_DB_PATH);
    raw.exec(`CREATE TABLE IF NOT EXISTS ag_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL, severity TEXT DEFAULT 'info', title TEXT NOT NULL, message TEXT,
      task_id TEXT, source TEXT, metadata TEXT DEFAULT '{}', requires_action INTEGER DEFAULT 0,
      action_taken INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    io = { emit: jest.fn() };
    const app = express(); app.use(express.json()); app.use('/api/ag', require('../routes/activity-events')({ db, io }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/ag/events`;
});
beforeEach(() => {
    raw.exec('DELETE FROM ag_events');
    if (raw.prepare("SELECT name FROM sqlite_master WHERE name='ag_event_receipts'").get()) raw.exec('DELETE FROM ag_event_receipts');
    io.emit.mockClear();
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve)); raw.close();
    if (oldDbPath === undefined) delete process.env.NEXUS_DB_PATH; else process.env.NEXUS_DB_PATH = oldDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
});
test('lost acknowledgment replay returns the same receipt without a second event or broadcast', async () => {
    const first = await post(event()); const retry = await post(event());
    expect(first.status).toBe(201); expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ success: true, id: first.data.id, duplicate: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ag_events').get().n).toBe(1);
    expect(io.emit).toHaveBeenCalledTimes(1);
});
test('metadata property order does not change the event identity', async () => {
    const first = await post(event());
    const retry = await post(event({ metadata: { a: 1, completionId: 'synthetic-completion' } }));
    expect(retry.status).toBe(200); expect(retry.data.id).toBe(first.data.id);
});
test('a conflicting payload cannot overwrite or be acknowledged under the old key', async () => {
    await post(event()); const conflict = await post(event({ message: 'A different outcome' }));
    expect(conflict.status).toBe(409);
    expect(raw.prepare('SELECT message FROM ag_events').get().message).toBe(event().message);
    expect(io.emit).toHaveBeenCalledTimes(1);
});
test('a receipt survives feed retention and does not recreate or rebroadcast the event', async () => {
    const first = await post(event()); raw.exec('DELETE FROM ag_events');
    const retry = await post(event());
    expect(retry).toMatchObject({ status: 200, data: { id: first.data.id, duplicate: true } });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ag_events').get().n).toBe(0);
    expect(io.emit).toHaveBeenCalledTimes(1);
});
test('concurrent retries create one row', async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => post(event())));
    expect(new Set(replies.map(x => x.data.id)).size).toBe(1);
    expect(replies.filter(x => x.status === 201)).toHaveLength(1);
    expect(io.emit).toHaveBeenCalledTimes(1);
});
test('invalid explicit keys fail; unkeyed existing publishers remain independent', async () => {
    for (const key of ['', ' ', 23, 'x'.repeat(201)]) expect((await post(event({ idempotency_key: key }))).status).toBe(400);
    const unkeyed = event(); delete unkeyed.idempotency_key;
    expect((await post(unkeyed)).status).toBe(201); expect((await post(unkeyed)).status).toBe(201);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ag_events').get().n).toBe(2);
});
test('receipt failure rolls back the event so the retry can complete once', async () => {
    raw.exec(`CREATE TRIGGER receipt_failure BEFORE INSERT ON ag_event_receipts BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
    try {
        expect((await post(event())).status).toBe(500);
        expect(raw.prepare('SELECT COUNT(*) AS n FROM ag_events').get().n).toBe(0);
    } finally { raw.exec('DROP TRIGGER receipt_failure'); }
    expect((await post(event())).status).toBe(201); expect(io.emit).toHaveBeenCalledTimes(1);
});
