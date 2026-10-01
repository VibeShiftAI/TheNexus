/**
 * Completion evidence dossier (services/task-evidence.js, routes/task-evidence.js).
 *
 * Fixture board DB, fixture Praxis spine and fixture log files in a temp dir;
 * the live nexus.db and ~/.praxis-mind spine are never opened. Covers the
 * fully-evidenced, partially-evidenced and no-evidence cases end to end
 * through the HTTP route, plus the honesty edges: an unreadable spine and a
 * stale verification record never read as verified.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const createTaskEvidenceRouter = require('../routes/task-evidence');
const {
    buildEvidenceDossier,
    splitGateDetail,
    parseQualityGatesLine,
    parseQaVerdictLine,
} = require('../services/task-evidence');

const FULL = 'task-full';
const PARTIAL = 'task-partial';
const BARE = 'task-bare';
const OPEN = 'task-open';
const FALLBACK = 'task-fallback';

function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
}

async function getJson(url) {
    const res = await fetch(url);
    return { status: res.status, body: await res.json() };
}

let tmp;
let logsDir;
let boardPath;
let spinePath;

function seed() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-evidence-'));
    logsDir = path.join(tmp, 'praxis-data');
    fs.mkdirSync(path.join(logsDir, 'claude-code-runs'), { recursive: true });
    fs.mkdirSync(path.join(logsDir, 'codex-runs'), { recursive: true });
    const execLog = path.join(logsDir, 'claude-code-runs', `${FULL}.log`);
    const qaLog = path.join(logsDir, 'codex-runs', `qa--${FULL}.log`);
    fs.writeFileSync(execLog, 'executor transcript line\nPRAXIS_QUALITY_GATES: verify=npm test; code-review=clean\n');
    fs.writeFileSync(qaLog, 'reviewer transcript\nPRAXIS_QA_VERDICT: pass\n');
    const outsideLog = path.join(tmp, 'outside.log');
    fs.writeFileSync(outsideLog, 'should never be served');

    boardPath = path.join(tmp, 'board.db');
    const board = new Database(boardPath);
    board.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, walkthrough TEXT, updated_at TEXT);
        CREATE TABLE task_dispatches (
            id TEXT PRIMARY KEY, task_id TEXT, kind TEXT DEFAULT 'dispatch', executor TEXT, model TEXT,
            outcome TEXT, output TEXT, log_path TEXT, started_at TEXT, completed_at TEXT
        );
    `);
    const wt = (content, generatedAt) => JSON.stringify({ content, generatedAt, executor: 'claude-code', source: 'praxis' });
    const task = board.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)');
    task.run(FULL, 'completed', wt('## Outcome\nShipped it.', '2026-09-28T02:43:22.000Z'), '2026-09-28T02:50:00.000Z');
    task.run(PARTIAL, 'completed', wt('## Outcome\nPartly shipped.', '2026-09-29T15:40:00.000Z'), '2026-09-29T15:50:00.000Z');
    task.run(BARE, 'completed', null, '2026-07-01T00:00:00.000Z');
    task.run(OPEN, 'in_progress', null, '2026-09-30T00:00:00.000Z');
    task.run(FALLBACK, 'done', wt('Done.', '2026-09-30T10:00:00.000Z'), '2026-09-30T10:05:00.000Z');

    const run = board.prepare(`INSERT INTO task_dispatches
        (id, task_id, kind, executor, outcome, output, log_path, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // FULL: an earlier failed attempt, the successful run, the QA run, and a
    // follow-up after verification (follow-ups must not stale the record).
    run.run('d-full-0', FULL, 'dispatch', 'claude-code', 'failure', null, execLog, '2026-09-28T01:00:00.000Z', '2026-09-28T01:10:00.000Z');
    run.run('d-full-1', FULL, 'dispatch', 'claude-code', 'success', 'ok', execLog, '2026-09-28T02:28:00.000Z', '2026-09-28T02:43:22.000Z');
    run.run('q-full-1', `qa--${FULL}`, 'dispatch', 'codex', 'success', 'PRAXIS_QA_VERDICT: pass', qaLog, '2026-09-28T02:43:25.000Z', '2026-09-28T02:47:01.000Z');
    run.run('f-full-1', FULL, 'follow_up', 'claude-code', 'success', 'thanks', null, '2026-09-28T02:48:36.000Z', '2026-09-28T02:49:18.000Z');
    run.run('d-full-outside', FULL, 'dispatch', 'claude-code', 'failure', null, outsideLog, '2026-09-27T00:00:00.000Z', '2026-09-27T00:01:00.000Z');
    // PARTIAL: executor run only; QA never ran.
    run.run('d-part-1', PARTIAL, 'dispatch', 'codex', 'success', 'done', path.join(logsDir, 'codex-runs', `${PARTIAL}.log`), '2026-09-29T15:00:00.000Z', '2026-09-29T15:40:00.000Z');
    // FALLBACK: no spine record at all; the executor and reviewer lines carry it.
    run.run('d-fb-1', FALLBACK, 'dispatch', 'claude-code', 'success',
        'Report.\nPRAXIS_QUALITY_GATES: verify=npx jest printed 4 passed; code-review=clean', path.join(logsDir, 'claude-code-runs', `${FALLBACK}.log`),
        '2026-09-30T09:00:00.000Z', '2026-09-30T10:00:00.000Z');
    run.run('q-fb-1', `qa--${FALLBACK}`, 'dispatch', 'codex', 'success', 'PRAXIS_QA_VERDICT: fail\nfindings', path.join(logsDir, 'codex-runs', `qa--${FALLBACK}.log`),
        '2026-09-30T10:01:00.000Z', '2026-09-30T10:04:00.000Z');
    board.close();

    spinePath = path.join(tmp, 'spine.sqlite');
    const spine = new Database(spinePath);
    spine.exec(`CREATE TABLE run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, task_id TEXT NOT NULL, executor TEXT,
        kind TEXT, type TEXT NOT NULL, phase TEXT, outcome TEXT, title TEXT, workspace TEXT, summary TEXT, data TEXT)`);
    const ev = spine.prepare('INSERT INTO run_events (ts, task_id, type, phase, data) VALUES (?, ?, ?, ?, ?)');
    ev.run('2026-08-01T00:00:00.000Z', 'some-other-task', 'verification', 'verified', '{}');
    ev.run('2026-09-28T02:48:35.591Z', FULL, 'verification', 'uncertain', JSON.stringify({
        verdict: 'uncertain',
        gates: { declared: ['verify', 'code-review'], missing: [], detail: 'verify=npm test printed 58 pass; code-review=re-read the diff; nothing left' },
        qa: { outcome: 'pass', reviewer: 'codex', author: 'claude-code', detail: 'QA passed (codex)' },
    }));
    ev.run('2026-09-29T15:47:09.926Z', PARTIAL, 'verification', 'partial', JSON.stringify({
        verdict: 'partial',
        gates: { declared: ['verify'], missing: ['code-review'], detail: 'verify=npx playwright test, 3 passed' },
        qa: { outcome: 'none', author: 'codex', detail: 'QA run failed (quota) and no other reviewer is available' },
    }));
    spine.close();
}

let handle;
beforeAll(async () => {
    seed();
    const app = express();
    app.use('/api/task-evidence', createTaskEvidenceRouter({
        dbPath: boardPath,
        spineDbPath: spinePath,
        logRoots: [logsDir],
    }));
    handle = await listen(app);
});

afterAll(async () => {
    if (handle) await new Promise((resolve) => handle.server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
});

const byKey = (dossier) => Object.fromEntries(dossier.pieces.map((p) => [p.key, p]));

describe('GET /api/task-evidence/:taskId', () => {
    test('fully evidenced completion is verified, every piece with a timestamp and a log reference', async () => {
        const { status, body } = await getJson(`${handle.baseUrl}/api/task-evidence/${FULL}`);
        expect(status).toBe(200);
        expect(body.state).toBe('verified');
        expect(body.missing).toEqual([]);
        expect(body.pieces.map((p) => p.key)).toEqual(['walkthrough', 'verify', 'code_review', 'qa']);
        for (const p of body.pieces) {
            expect(p.status).toBe('present');
            expect(typeof p.at).toBe('string');
            expect(p.log && p.log.path).toBeTruthy();
            expect(p.log.href).toMatch(new RegExp(`^/api/task-evidence/${FULL}/log/`));
        }
        const pieces = byKey(body);
        expect(pieces.walkthrough.at).toBe('2026-09-28T02:43:22.000Z');
        expect(pieces.walkthrough.log.dispatchId).toBe('d-full-1');
        // Gates come from the verification row, split into their own clauses.
        expect(pieces.verify.source).toBe('praxis-verification');
        expect(pieces.verify.detail).toBe('npm test printed 58 pass');
        expect(pieces.code_review.detail).toBe('re-read the diff; nothing left');
        expect(pieces.verify.ref).toMatchObject({ source: 'praxis-run-events', ts: '2026-09-28T02:48:35.591Z' });
        expect(pieces.verify.log.dispatchId).toBe('d-full-1');
        // The QA log is the reviewer's own run, not the author's.
        expect(pieces.qa).toMatchObject({ verdict: 'pass', reviewer: 'codex', at: '2026-09-28T02:48:35.591Z' });
        expect(pieces.qa.log.dispatchId).toBe('q-full-1');
        expect(body.verification).toMatchObject({ verdict: 'uncertain' });
    });

    test('partially evidenced completion is unverified and names exactly the missing gates', async () => {
        const { body } = await getJson(`${handle.baseUrl}/api/task-evidence/${PARTIAL}`);
        expect(body.state).toBe('unverified');
        expect(body.missing).toEqual(['code_review', 'qa']);
        expect(body.summary).toBe('Unverified: missing Code-review gate, QA verdict.');
        const pieces = byKey(body);
        expect(pieces.walkthrough.status).toBe('present');
        expect(pieces.verify).toMatchObject({ status: 'present', detail: 'npx playwright test, 3 passed' });
        expect(pieces.code_review.status).toBe('absent');
        expect(pieces.code_review.reason).toMatch(/code-review pass/);
        // QA `none` is an explicit absent marker with its reason and timestamp.
        expect(pieces.qa).toMatchObject({ status: 'absent', verdict: 'none', at: '2026-09-29T15:47:09.926Z' });
        expect(pieces.qa.reason).toMatch(/No independent QA audit/);
    });

    test('completion with no evidence at all is unverified on every gate, never blank or green', async () => {
        const { body } = await getJson(`${handle.baseUrl}/api/task-evidence/${BARE}`);
        expect(body.state).toBe('unverified');
        expect(body.missing).toEqual(['walkthrough', 'verify', 'code_review', 'qa']);
        for (const p of body.pieces) {
            expect(p.status).toBe('absent');
            expect(p.at).toBeNull();
            expect(typeof p.reason).toBe('string');
            expect(p.reason.length).toBeGreaterThan(0);
        }
        // Completed before the spine's first verification record existed.
        expect(body.predatesEvidenceCapture).toBe(true);
    });

    test('fallback sources are labelled, and a failing QA verdict keeps the task unverified', async () => {
        const { body } = await getJson(`${handle.baseUrl}/api/task-evidence/${FALLBACK}`);
        const pieces = byKey(body);
        expect(pieces.verify).toMatchObject({ status: 'present', source: 'executor-report', detail: 'npx jest printed 4 passed' });
        expect(pieces.code_review).toMatchObject({ status: 'present', source: 'executor-report' });
        expect(pieces.qa).toMatchObject({ status: 'failed', verdict: 'fail', source: 'qa-run' });
        expect(body.state).toBe('unverified');
        expect(body.missing).toEqual(['qa']);
    });

    test('a task that is not completed is reported as such, not as verified', async () => {
        const { body } = await getJson(`${handle.baseUrl}/api/task-evidence/${OPEN}`);
        expect(body.state).toBe('not_completed');
        expect(body.completed).toBe(false);
    });

    test('unknown task is a 404', async () => {
        const { status } = await getJson(`${handle.baseUrl}/api/task-evidence/nope`);
        expect(status).toBe(404);
    });
});

describe('GET /api/task-evidence?task_ids=', () => {
    test('batch returns the compact board state for each task', async () => {
        const { status, body } = await getJson(`${handle.baseUrl}/api/task-evidence?task_ids=${[FULL, PARTIAL, BARE, 'nope'].join(',')}`);
        expect(status).toBe(200);
        expect(body.spineAvailable).toBe(true);
        expect(body.tasks[FULL]).toMatchObject({ state: 'verified', missing: [] });
        expect(body.tasks[PARTIAL]).toMatchObject({ state: 'unverified', missing: ['code_review', 'qa'] });
        expect(body.tasks[BARE].state).toBe('unverified');
        expect(body.tasks.nope).toBeUndefined();
    });

    test('batch requires ids', async () => {
        const { status } = await getJson(`${handle.baseUrl}/api/task-evidence`);
        expect(status).toBe(400);
    });
});

describe('GET /api/task-evidence/:taskId/log/:dispatchId', () => {
    test('serves a bounded tail of a log recorded on this task or its QA shadow', async () => {
        const exec = await getJson(`${handle.baseUrl}/api/task-evidence/${FULL}/log/d-full-1`);
        expect(exec.status).toBe(200);
        expect(exec.body.text).toContain('PRAXIS_QUALITY_GATES');
        expect(exec.body.truncated).toBe(false);
        const qa = await getJson(`${handle.baseUrl}/api/task-evidence/${FULL}/log/q-full-1`);
        expect(qa.body.text).toContain('PRAXIS_QA_VERDICT: pass');
    });

    test('refuses a dispatch of another task and a recorded path outside the log roots', async () => {
        expect((await getJson(`${handle.baseUrl}/api/task-evidence/${PARTIAL}/log/d-full-1`)).status).toBe(404);
        const outside = await getJson(`${handle.baseUrl}/api/task-evidence/${FULL}/log/d-full-outside`);
        expect(outside.status).toBe(403);
        expect(JSON.stringify(outside.body)).not.toContain('should never be served');
    });
});

describe('honesty edges (pure builder)', () => {
    const task = { id: 't', status: 'completed', walkthrough: JSON.stringify({ content: 'x', generatedAt: '2026-09-01T00:00:00Z' }) };
    const runs = [{ id: 'r1', task_id: 't', kind: 'dispatch', outcome: 'success', log_path: '/logs/t.log', started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:10:00Z' }];
    const qaRuns = [{ id: 'q1', task_id: 'qa--t', kind: 'dispatch', executor: 'codex', outcome: 'success', log_path: '/logs/qa--t.log', output: 'PRAXIS_QA_VERDICT: pass', started_at: '2026-09-01T00:11:00Z', completed_at: '2026-09-01T00:15:00Z' }];
    const record = {
        seq: 1, ts: '2026-09-01T00:20:00Z', data: JSON.stringify({
            gates: { declared: ['verify', 'code-review'], missing: [], detail: 'verify=a; code-review=b' },
            qa: { outcome: 'pass', reviewer: 'codex' },
        }),
    };

    test('an unreadable spine leaves the gates absent with that reason, never verified', () => {
        const d = buildEvidenceDossier({ task, runs, spine: { available: false, reason: 'database is locked' } });
        expect(d.state).toBe('unverified');
        expect(d.missing).toEqual(['verify', 'code_review', 'qa']);
        expect(d.pieces[1].reason).toMatch(/database is locked/);
        expect(d.sources.spine.available).toBe(false);
    });

    test('a verification record older than the latest executor run does not vouch for it', () => {
        const rerun = [...runs, { id: 'r2', task_id: 't', kind: 'dispatch', outcome: 'success', log_path: '/logs/t.log', started_at: '2026-09-02T00:00:00Z', completed_at: '2026-09-02T00:10:00Z' }];
        const d = buildEvidenceDossier({ task, runs: rerun, qaRuns, spine: { available: true, record } });
        expect(d.state).toBe('unverified');
        expect(d.sources.spine.staleRecord).toMatchObject({ seq: 1 });
        expect(d.pieces[3].reason).toMatch(/predates the latest executor run/);
    });

    test('QA exempt and deferred are not passes', () => {
        for (const outcome of ['exempt', 'deferred']) {
            const r = { ...record, data: JSON.stringify({ ...JSON.parse(record.data), qa: { outcome } }) };
            const d = buildEvidenceDossier({ task, runs, qaRuns, spine: { available: true, record: r } });
            expect(d.state).toBe('unverified');
            expect(d.missing).toEqual(['qa']);
        }
    });

    test('the same fixture with a QA pass bound to this attempt is verified (control for the cases below)', () => {
        const d = buildEvidenceDossier({ task, runs, qaRuns, spine: { available: true, record } });
        expect(d.state).toBe('verified');
        expect(d.pieces[3].log.dispatchId).toBe('q1');
    });

    test('an earlier attempt\'s QA pass cannot verify a newer completion (fallback path)', () => {
        const newer = { id: 'r2', task_id: 't', kind: 'dispatch', outcome: 'success', log_path: '/logs/t.log',
            output: 'PRAXIS_QUALITY_GATES: verify=a; code-review=b', started_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T01:00:00Z' };
        const d = buildEvidenceDossier({ task, runs: [...runs, newer], qaRuns, spine: { available: true, record } });
        expect(d.sources.spine.staleRecord).toMatchObject({ seq: 1 });
        // Gates come from the new attempt's own line; QA from 2026-09-01 does not count.
        expect(d.pieces[1]).toMatchObject({ status: 'present', source: 'executor-report' });
        expect(d.pieces[3].status).toBe('absent');
        expect(d.pieces[3].reason).toMatch(/started before the completion attempt under review/);
        expect(d.state).toBe('unverified');
        expect(d.missing).toEqual(['qa']);
    });

    test('an earlier attempt\'s QA cannot be borrowed by the verification-record path either', () => {
        const newer = { ...runs[0], id: 'r2', started_at: '2026-09-01T00:16:00Z', completed_at: '2026-09-01T00:18:00Z' };
        const d = buildEvidenceDossier({ task, runs: [...runs, newer], qaRuns, spine: { available: true, record } });
        // The record (00:20) postdates the new attempt, but the only reviewer run started before it.
        expect(d.pieces[3].status).toBe('incomplete');
        expect(d.pieces[3].metadataMissing).toEqual(['log reference']);
        expect(d.state).toBe('unverified');
    });

    test('an older success\'s gate line is not reused when the newest run failed', () => {
        const withGates = [{ ...runs[0], output: 'PRAXIS_QUALITY_GATES: verify=a; code-review=b' }];
        const failed = { id: 'r2', task_id: 't', kind: 'dispatch', outcome: 'failure', log_path: '/logs/t.log', started_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:05:00Z' };
        const d = buildEvidenceDossier({ task, runs: [...withGates, failed], qaRuns, spine: { available: true, record: null } });
        expect(d.pieces[1].status).toBe('absent');
        expect(d.pieces[1].reason).toMatch(/ended "failure"/);
        expect(d.pieces[3].status).toBe('absent');
        expect(d.missing).toEqual(['walkthrough', 'verify', 'code_review', 'qa']);
        expect(d.state).toBe('unverified');
    });

    test('pieces with no timestamp or no log path are incomplete and never verify', () => {
        const bare = { id: 't', status: 'completed', walkthrough: JSON.stringify({ content: 'x' }) };
        const noMeta = [{ id: 'r', task_id: 't', kind: 'dispatch', outcome: 'success', log_path: null,
            output: 'PRAXIS_QUALITY_GATES: verify=a; code-review=b', started_at: '2026-09-01T00:00:00Z', completed_at: null }];
        const qaNoMeta = [{ id: 'q', task_id: 'qa--t', kind: 'dispatch', outcome: 'success', log_path: null,
            output: 'PRAXIS_QA_VERDICT: pass', started_at: '2026-09-01T00:11:00Z', completed_at: null }];
        const d = buildEvidenceDossier({ task: bare, runs: noMeta, qaRuns: qaNoMeta, spine: { available: true, record: null } });
        expect(d.state).toBe('unverified');
        expect(d.missing).toEqual(['walkthrough', 'verify', 'code_review', 'qa']);
        for (const p of d.pieces) {
            expect(p.status).toBe('incomplete');
            expect(p.metadataMissing).toEqual(['timestamp', 'log reference']);
            expect(p.reason).toMatch(/timestamp and log reference are missing/);
        }
        expect(d.summary).toBe('Unverified: no timestamp or log for Walkthrough, Verify gate, Code-review gate, QA verdict.');
        // A timestamp alone is not enough: the log path is still required.
        const dated = buildEvidenceDossier({
            task: { ...bare, walkthrough: JSON.stringify({ content: 'x', generatedAt: '2026-09-01T00:10:00Z' }) },
            runs: noMeta, qaRuns: qaNoMeta, spine: { available: true, record: null },
        });
        expect(dated.pieces[0]).toMatchObject({ status: 'incomplete', metadataMissing: ['log reference'] });
    });

    test('gate and verdict line parsers', () => {
        expect(splitGateDetail('verify=npm test; a; b; code-review=clean; ok')).toEqual({ verify: 'npm test; a; b', code_review: 'clean; ok' });
        expect(splitGateDetail('')).toEqual({ verify: null, code_review: null });
        expect(parseQualityGatesLine('x\nPRAXIS_QUALITY_GATES: verify=v; code-review=c\n')).toMatchObject({ verify: 'v', code_review: 'c' });
        expect(parseQualityGatesLine('no marker')).toBeNull();
        expect(parseQaVerdictLine('PRAXIS_QA_VERDICT: PASS\n')).toBe('pass');
        expect(parseQaVerdictLine('QA pass')).toBeNull();
    });
});
