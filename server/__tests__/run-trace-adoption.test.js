/**
 * Adoption of the standard run-trace field list by the two attribution
 * surfaces (contract: docs/contracts/run-trace.md).
 *
 * The unit tests in run-trace.test.js prove the SCHEMA behaves; these prove
 * the SURFACES actually report against it and do not quietly gain telemetry
 * they never read. Two properties matter most here:
 *
 *   - Retry depth on the dispatch console must come from the task's COMPLETE
 *     dispatch history, not the 50-run display page: read off a page, attempt
 *     51 reports as attempt 1.
 *   - The activity feed must declare the channels it did NOT read
 *     (`not_queried` approvals, `not_recorded` retries) rather than defaulting
 *     them, because the feed holds a rolling cross-project window that cannot
 *     answer either question.
 *
 * Uses a temp SQLite board; the live board DB and the real Praxis daemon are
 * never touched.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const createDispatchInsightRouter = require('../routes/dispatch-insight');
const { activityRunTrace } = require('../routes/projects');

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}`,
        }));
    });
}

function close(handle) {
    if (!handle) return Promise.resolve();
    for (const s of handle.sockets) s.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

const TASK = 'task-traced';
// More runs than the console's 50-row display page, so the attempt number of
// the newest run can only be right if it came from the full history.
const TOTAL_RUNS = 55;

let tmpDir;
let handle;
let baseUrl;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-run-trace-'));
    const dbPath = path.join(tmpDir, 'board.db');
    const spinePath = path.join(tmpDir, 'spine.db');

    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT,
            priority INTEGER DEFAULT 0, dependencies TEXT DEFAULT '[]', default_executor TEXT,
            metadata TEXT DEFAULT '{}', archived_at TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, status TEXT);
        CREATE TABLE task_dispatches (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT, executor TEXT,
            model TEXT, tokens INTEGER, tokens_estimated INTEGER DEFAULT 0, outcome TEXT,
            error TEXT, started_at TEXT, completed_at TEXT, created_at TEXT
        );
        CREATE TABLE ag_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT,
            event_type TEXT, message TEXT, metadata TEXT, created_at TEXT);
    `);
    const ins = db.prepare(`
        INSERT INTO task_dispatches (id, task_id, executor, model, tokens, tokens_estimated,
            outcome, error, started_at, completed_at, created_at)
        VALUES (@id, @task_id, @executor, @model, @tokens, @te, @outcome, @error, @s, @c, @s)
    `);
    for (let i = 1; i <= TOTAL_RUNS; i += 1) {
        const start = new Date(Date.UTC(2026, 6, 1, i, 0, 0)).toISOString();
        const end = new Date(Date.UTC(2026, 6, 1, i, 30, 0)).toISOString();
        ins.run({
            id: `disp-${String(i).padStart(2, '0')}`, task_id: TASK, executor: 'claude-code',
            // The oldest run recorded no model: its agentVersion must stay unknown.
            model: i === 1 ? null : 'claude-opus-5',
            tokens: 1000, te: 0,
            outcome: i === TOTAL_RUNS ? 'failure' : 'success',
            error: i === TOTAL_RUNS ? 'executor exited 1' : null,
            s: start, c: end,
        });
    }
    const ev = db.prepare('INSERT INTO ag_events (task_id, event_type, created_at) VALUES (?, ?, ?)');
    ev.run(TASK, 'task_qa_passed', '2026-07-01T12:00:00Z');
    ev.run(TASK, 'task_qa_passed', '2026-07-01T13:00:00Z');
    ev.run(TASK, 'qa_improvement_requested', '2026-07-01T14:00:00Z');
    ev.run(TASK, 'task_correction_redispatch', '2026-07-01T15:00:00Z');
    ev.run(TASK, 'cli_gate_stall_requires_reconciliation', '2026-07-01T16:00:00Z');
    db.close();

    // Spine present but carrying no verification for this task: the approval
    // channel is READABLE and empty, which is a measurement.
    const spine = new Database(spinePath);
    spine.exec(`CREATE TABLE run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
        task_id TEXT NOT NULL, executor TEXT, kind TEXT, type TEXT NOT NULL, phase TEXT,
        outcome TEXT, title TEXT, workspace TEXT, summary TEXT, data TEXT);`);
    spine.close();

    const app = express();
    app.use(express.json());
    app.use('/api/dispatch-insight', createDispatchInsightRouter({
        dbPath, spineDbPath: spinePath,
        detachedRunsDir: path.join(tmpDir, 'runs'),
        // Praxis unreachable: incidents are simply absent, which must not
        // change how the trace reports the channels it CAN read.
        praxisUrl: 'http://127.0.0.1:1',
    }));
    handle = await listen(app);
    baseUrl = handle.baseUrl;
});

afterAll(async () => {
    await close(handle);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('dispatch console adopts the field list', () => {
    let body;
    beforeAll(async () => {
        const res = await fetch(`${baseUrl}/api/dispatch-insight/task/${TASK}`);
        body = await res.json();
    });

    it('reports a trace on every displayed run', () => {
        expect(body.runs).toHaveLength(50); // the display page
        for (const run of body.runs) {
            expect(run.runTrace.version).toBe(1);
            expect(run.runTrace.completeness.requiredFields).toBe(8);
        }
    });

    it('takes retry depth from the complete history, not the display page', () => {
        // runs are newest-first, so runs[0] is attempt 55 of 55.
        expect(body.runs[0].runTrace.fields.retries.value)
            .toEqual({ attempt: TOTAL_RUNS, priorAttempts: TOTAL_RUNS - 1 });
        // The oldest run still on the page is attempt 6, not attempt 1.
        expect(body.runs[49].runTrace.fields.retries.value.attempt).toBe(TOTAL_RUNS - 49);
    });

    it('carries the run id, outcome and error the board actually recorded', () => {
        const newest = body.runs[0].runTrace.fields;
        expect(newest.runId.value).toEqual({ dispatchId: 'disp-55', attemptId: null });
        expect(newest.finalOutcome).toEqual({ known: true, value: 'failure' });
        expect(newest.errors.value.message).toBe('executor exited 1');
    });

    it('leaves agentVersion unknown on the run that recorded no model', () => {
        const byId = Object.fromEntries(body.runs.map((r) => [r.dispatchId, r]));
        // disp-01 is off the 50-row page; the roll-up still saw it.
        expect(byId['disp-01']).toBeUndefined();
        expect(body.traceQuality.controlEffectiveness.auditTraceCompleteness.missingByField.agentVersion).toBe(1);
    });

    it('treats the readable, empty spine as "no approval recorded", not unknown', () => {
        expect(body.spineAvailable).toBe(true);
        expect(body.runs[0].runTrace.fields.approvals).toEqual({ known: true, value: [] });
    });

    it('rolls trace quality up over the COMPLETE history, like the cost rollup', () => {
        expect(body.traceQuality.runs).toBe(TOTAL_RUNS);
        expect(body.traceQuality.terminalRuns).toBe(TOTAL_RUNS);
        expect(body.usageRollup.totalRuns).toBe(TOTAL_RUNS);
        expect(body.traceQuality.controlEffectiveness.auditTraceCompleteness.scoredRuns).toBe(TOTAL_RUNS);
    });

    it('derives the reviewer measures from the board event log', () => {
        const dq = body.traceQuality.decisionQuality;
        // 1 rejection over the 3 rounds that produced a verdict (2 passed + 1 failed).
        expect(dq.reviewerRejection).toEqual({ rejections: 1, adjudicatedRuns: 3, rate: 0.333 });
        expect(dq.reviewerCorrection.corrections).toBe(1);
        // And never relabels machine adjudication as human judgement.
        expect(dq.humanRejection.known).toBe(false);
        expect(dq.humanCorrection.known).toBe(false);
    });

    it('counts the fleet stale-state failure it can see', () => {
        expect(body.traceQuality.controlEffectiveness.staleStateFailures.count).toBe(1);
    });
});

describe('the activity feed adopts the same list and declares what it did not read', () => {
    const row = {
        id: 'disp-9', executor: 'claude-code', model: 'claude-opus-5',
        tokens: 4200, tokens_estimated: 0, outcome: 'success', error: null,
    };

    it('reports the fields it can see off a correlated dispatch row', () => {
        const trace = activityRunTrace(row);
        expect(trace.fields.runId.value).toEqual({ dispatchId: 'disp-9', attemptId: null });
        expect(trace.fields.agentVersion.value.model).toBe('claude-opus-5');
        expect(trace.fields.finalOutcome).toEqual({ known: true, value: 'success' });
    });

    it('will not guess retry depth from a rolling cross-project window', () => {
        expect(activityRunTrace(row).fields.retries).toMatchObject({
            known: false, reason: 'not_recorded',
        });
    });

    it('says the approval channel was not read, rather than reporting none', () => {
        expect(activityRunTrace(row).fields.approvals).toMatchObject({
            known: false, reason: 'not_queried',
        });
    });

    it('prefers the commit trailer\'s precise model as the agent version', () => {
        const noModelRow = { ...row, model: null };
        // Without a trailer the field stays unknown: the executor name is an
        // identity, not a version.
        expect(activityRunTrace(noModelRow).fields.agentVersion.known).toBe(false);
        // With one, the precise name from the commit satisfies it.
        expect(activityRunTrace(noModelRow, 'Claude Fable 5').fields.agentVersion.value.model)
            .toBe('Claude Fable 5');
    });

    it('gives a commit with no run behind it one honest reason, not a zero score', () => {
        const trace = activityRunTrace(null);
        expect(trace.completeness.ratio).toBeNull();
        expect(trace.completeness.missing).toHaveLength(8);
        expect(new Set(trace.completeness.missing.map((m) => m.reason))).toEqual(new Set(['no_dispatch_match']));
    });
});
