const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregateRoutingEconomics } = require('../services/routing-economics');
const createRouter = require('../routes/routing-economics');
const run = (id, overrides = {}) => ({ id, task_id: 'task-1', executor: 'codex', model: 'gpt-5.6-sol', tokens: 1e6,
    tokens_estimated: 0, outcome: 'success', started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:00:10Z', ...overrides });
const group = (data, model, lane = 'cloud') => data.models.find(g => g.model === model && g.lane === lane);

test('aggregates all attempts, median/worst latency, tokens and completed/failed outcomes with independent coverage', () => {
    const data = aggregateRoutingEconomics([run('1'), run('2', { outcome: 'failure', completed_at: '2026-09-01T00:00:30Z', tokens_estimated: 1 }),
        run('3', { outcome: 'running', completed_at: null, tokens: null })]);
    const g = group(data, 'gpt-5.6-sol');
    expect(g.runCount).toBe(3);
    expect(g.latency).toEqual({ medianMs: 20000, worstMs: 30000, runs: 2 });
    expect(g.tokens).toEqual({ total: 2e6, runs: 2, estimatedRuns: 1 });
    expect(g.cost).toMatchObject({ usd: 5.05, runs: 2, provenance: 'estimated', estimatedRuns: 2, meteredRuns: 0, unknownRuns: 1 });
    expect(g.outcomes).toMatchObject({ completed: 1, failed: 1, runs: 2, completionRate: 0.5, unfinished: 1 });
    expect(g.runs.find(r => r.id === '2').href).toBe('/task/task-1#dispatch-2');
    expect(data.lanes.find(g => g.lane === 'cloud').runCount).toBe(3);
});

test('empty lanes and configured models return no data, never zero dollars or perfect success', () => {
    const data = aggregateRoutingEconomics([], [{ id: 'local-gemma', api_model_id: 'gemma', provider: 'local', is_active: 1 }]);
    expect(data.lanes.map(g => g.lane)).toEqual(['local', 'cloud']);
    for (const g of [...data.lanes, ...data.models]) {
        expect(g).toMatchObject({ state: 'no_data', runCount: 0, cost: { usd: null, provenance: 'unknown' }, outcomes: { completionRate: null } });
        expect(g.latency.medianMs).toBeNull();
        expect(g.tokens.total).toBeNull();
    }
});

test('one local run has zero provider fees labelled local, even when tokens are absent', () => {
    const g = group(aggregateRoutingEconomics([run('local', { executor: 'local', model: 'gemma', tokens: null })]), 'gemma', 'local');
    expect(g.cost).toMatchObject({ usd: 0, provenance: 'local_zero', runs: 1, meteredRuns: 0 });
    expect(g.latency).toEqual({ medianMs: 10000, worstMs: 10000, runs: 1 });
    expect(g.tokens).toMatchObject({ total: null, runs: 0 });
});

test('cloud has explicit estimates, never metered telemetry; unpriced and unattributed runs stay unknown', () => {
    const data = aggregateRoutingEconomics([run('a'), run('b', { model: 'gpt-6-astra' }), run('c', { model: null }),
        run('d', { executor: 'mystery', model: 'unknown' })]);
    expect(group(data, 'gpt-5.6-sol').cost.provenance).toBe('estimated');
    expect(group(data, 'gpt-6-astra').cost).toMatchObject({ usd: null, runs: 0, provenance: 'unknown', unknownByReason: { unpriced_model: 1 } });
    expect(group(data, null).cost.unknownByReason).toEqual({ no_model: 1 });
    expect(group(data, 'unknown', 'unknown').cost.usd).toBeNull();
});

test('executor location wins over current model registry; a local model name does not make a cloud execution local', () => {
    const models = [{ id: 'gemma', provider: 'local', is_active: 1 }];
    const data = aggregateRoutingEconomics([run('a', { model: 'gemma', executor: 'openrouter' }), run('b', { model: 'gemma', executor: 'local' })], models);
    expect(group(data, 'gemma', 'cloud').cost.usd).toBeNull();
    expect(group(data, 'gemma', 'local').cost.usd).toBe(0);
});

test('rejects invalid measurements, retains recorded zero, and never treats a running row as completed', () => {
    const data = aggregateRoutingEconomics([run('a', { tokens: 0, completed_at: '2026-09-01T00:00:00Z' }),
        run('b', { tokens: -1, completed_at: 'bad', outcome: 'needs_input' }),
        run('c', { tokens: null, completed_at: '2026-08-01T00:00:00Z', outcome: 'cancelled' }),
        run('d', { tokens: null, outcome: 'running' })]);
    const g = group(data, 'gpt-5.6-sol');
    expect(g.latency).toEqual({ medianMs: 0, worstMs: 0, runs: 1 });
    expect(g.tokens).toMatchObject({ total: 0, runs: 1 });
    expect(g.cost).toMatchObject({ usd: 0, runs: 1, provenance: 'estimated' });
    expect(g.outcomes).toMatchObject({ runs: 3, needsInput: 1, cancelled: 1, unfinished: 1, completionRate: 1 / 3 });
});

test('HTTP route reads complete history and active model roster without modifying storage; mutations are unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-economics-'));
    const dbPath = path.join(dir, 'fixture.sqlite');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE task_dispatches (id TEXT, task_id TEXT, executor TEXT, model TEXT, tokens INTEGER, tokens_estimated INTEGER, outcome TEXT, started_at TEXT, completed_at TEXT); CREATE TABLE models (id TEXT, api_model_id TEXT, provider TEXT, is_active INTEGER)');
    const insert = db.prepare('INSERT INTO task_dispatches VALUES (@id,@task_id,@executor,@model,@tokens,@tokens_estimated,@outcome,@started_at,@completed_at)');
    for (let n = 0; n < 61; n++) insert.run(run(String(n)));
    db.prepare('INSERT INTO models VALUES (?,?,?,?)').run('gemma', 'gemma', 'local', 1);
    const before = db.prepare('SELECT * FROM task_dispatches').all();
    const app = express(); app.use('/api/routing-economics', createRouter({ dbPath }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const url = `http://127.0.0.1:${server.address().port}/api/routing-economics`;
        const response = await fetch(url); expect(response.status).toBe(200);
        const data = await response.json();
        expect(group(data, 'gpt-5.6-sol').runCount).toBe(61);
        expect(group(data, 'gemma', 'local').state).toBe('no_data');
        expect((await fetch(url, { method: 'POST' })).status).toBe(404);
        expect(db.prepare('SELECT * FROM task_dispatches').all()).toEqual(before);
    } finally { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('run click-through includes a requested old dispatch beyond the history page, scoped to its task', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-economics-link-'));
    const dbPath = path.join(dir, 'fixture.sqlite');
    const app = express();
    app.use('/api/dispatches', require('../routes/dispatches')({ dbPath }));
    const db = new Database(dbPath);
    const insert = db.prepare('INSERT INTO task_dispatches (id,task_id,executor,started_at) VALUES (?,?,?,?)');
    for (let n = 0; n < 61; n++) insert.run(`run-${n}`, 'task-1', 'codex', new Date(n * 1000).toISOString());
    insert.run('other', 'task-2', 'codex', new Date().toISOString());
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const url = `http://127.0.0.1:${server.address().port}/api/dispatches?task_id=task-1`;
        expect((await (await fetch(url)).json()).dispatches).toHaveLength(50);
        const { dispatches } = await (await fetch(`${url}&include_id=run-0`)).json();
        expect(dispatches).toHaveLength(51);
        expect(dispatches.some(row => row.id === 'run-0')).toBe(true);
        expect((await (await fetch(`${url}&include_id=other`)).json()).dispatches).toHaveLength(50);
    } finally { await new Promise(resolve => server.close(resolve)); db.close(); require('../../db/raw').closeRaw(dbPath); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cloud subtotals round once after summing small run estimates', () => {
    const g = group(aggregateRoutingEconomics(Array.from({ length: 61 }, (_, i) => run(String(i), { tokens: 100 }))), 'gpt-5.6-sol');
    expect(g.cost.usd).toBe(0.015);
});
