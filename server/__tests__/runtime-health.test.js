const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createRouter = require('../routes/praxis-stream');
const { readRuntimeReport, projectRuntimeHealth } = require('../services/runtime-health');

// Names/statuses from the 2026-11-03 Praxis report; details are synthetic.
function realisticReport(capturedAt = new Date().toISOString()) {
  const checks = [
    ['service com.thenexus.vault-watcher', 'green'],
    ['Nexus API :4000 (Praxis child)', 'green'],
    ['LM Studio :1234 (local LLM)', 'green'],
    ['supervised TheNexus', 'green'],
    ['supervised NexusDashboard', 'green'],
    ['supervised TheCortex', 'green'],
    ['vault git sync', 'green'],
    ['dispatches (24h)', 'green'],
    ['day activity', 'green', '2 dispatched in 24h'],
    ['approval → dispatch stages', 'green'],
    ['dispatch provenance', 'green'],
    ['executor circuits', 'yellow', 'Previously suspended worker; current posture owns its recovery'],
    ['CLI dispatch queue', 'green'],
    ['local-LLM queue', 'green'],
    ['local-LLM model', 'green'],
    ['hosted-API credits', 'green'],
    ['voice / TTS', 'green'],
    ['QA lessons (14d)', 'yellow', '27 fail rounds across 22 tasks'],
    ['QA learning loop (7d)', 'green'],
    ['execution scorecard (14d)', 'green'],
    ['running code freshness', 'green'],
    ['swap', 'red', '16098 MB used'],
    ['disk /Volumes/Projects', 'green'],
    ['disk /', 'green'],
    ['backups', 'green'],
    ['feedback relay deploy', 'green'],
    ['iPad hub fleet relay', 'green'],
    ['restore drill', 'green'],
    ['overnight ingest', 'red', 'Feed ingestion failed'],
    ['graph health', 'yellow', 'Graph cull overdue'],
    ['council quorum', 'green'],
    ['eval availability', 'red', 'Required eval unavailable'],
    ['skill bus', 'green'],
    ['skill telemetry', 'green'],
  ].map(([name, status, detail = 'Check passed']) => ({ name, status, detail }));
  return { capturedAt, checks };
}

const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const healthyState = () => ({ executors: {
  runs: [], cliQueue: [], sessions: [],
  posture: { mode: 'nominal', summary: 'All workers routable', suspended: [] },
  attemptStalls: { violations: [], pending: 0 },
}, cron: [], localLlm: { jobs: [] } });

describe('runtime health on the existing dispatch-state relay', () => {
  let upstream, server, router, dir, state, upstreamStatus;
  let saved;
  beforeEach(async () => {
    saved = { PRAXIS_URL: process.env.PRAXIS_URL, PRAXIS_DATA_DIR: process.env.PRAXIS_DATA_DIR, PRAXIS_USAGE_RESUME_FILE: process.env.PRAXIS_USAGE_RESUME_FILE };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-runtime-'));
    fs.mkdirSync(path.join(dir, 'morning-health'));
    process.env.PRAXIS_DATA_DIR = dir;
    process.env.PRAXIS_USAGE_RESUME_FILE = path.join(dir, 'waits.json');
    fs.writeFileSync(process.env.PRAXIS_USAGE_RESUME_FILE, '[]', 'utf8');
    report('green', '2 dispatched in 24h');
    state = healthyState(); upstreamStatus = 200;
    const app = express();
    app.get('/api/dispatch/state', (_req, res) => res.status(upstreamStatus).json(state));
    upstream = await listen(app);
    process.env.PRAXIS_URL = `http://127.0.0.1:${upstream.address().port}`;
    const nexus = express(); router = createRouter(); nexus.use('/api/praxis', router);
    server = await listen(nexus);
  });
  afterEach(async () => {
    router.closeUpstream();
    for (const handle of [server, upstream]) { handle.closeAllConnections(); await new Promise(resolve => handle.close(resolve)); }
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function report(status, detail, date = day()) {
    fs.writeFileSync(path.join(dir, 'morning-health', `${day()}.json`), JSON.stringify({ date, report: { capturedAt: new Date().toISOString(), checks: [{ name: 'day activity', status, detail }] } }), 'utf8');
  }
  async function read() {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/praxis/dispatch-state`);
    return { status: response.status, body: await response.json() };
  }
  test('healthy only when all sources are available and nominal', async () => {
    expect((await read()).body.runtimeHealth).toMatchObject({ status: 'healthy', causes: [] });
  });
  test.each(['wedged executor', 'silent failure', 'usage-limited executor'])('names Praxis circuit cause: %s', async reason => {
    state.executors.posture = { mode: 'degraded', summary: 'Fleet capacity reduced', suspended: [{ executor: 'codex', reason }] };
    const health = (await read()).body.runtimeHealth;
    expect(health.status).toBe('degraded');
    expect(health.causes).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining(reason), href: '/ops' })]));
  });
  test('critical posture remains degraded even without detailed suspension records', async () => {
    state.executors.posture = { mode: 'critical', summary: 'No review capacity', suspended: [] };
    expect((await read()).body.runtimeHealth).toMatchObject({ status: 'degraded', causes: [expect.objectContaining({ detail: 'No review capacity' })] });
  });
  test('active usage waits name the executor and link to its task even after the reset time', async () => {
    fs.writeFileSync(process.env.PRAXIS_USAGE_RESUME_FILE, JSON.stringify([{taskId:'quota task',executor:'codex',kind:'usage_limit',resumeAtIso:'2026-01-01T00:00:00Z'}]), 'utf8');
    expect((await read()).body.runtimeHealth).toMatchObject({ status: 'degraded', causes: [expect.objectContaining({ detail: expect.stringContaining('codex'), href: '/task/quota%20task' })] });
  });
  test('current silent-attempt violations carry runtime diagnosis, not dashboard timers', async () => {
    state.executors.attemptStalls.violations = [{ taskId:'stalled', causeTitle:'Silent failure', detail:'Approved slot has no attempt' }];
    expect((await read()).body.runtimeHealth).toMatchObject({ status:'degraded', causes:[expect.objectContaining({ detail:expect.stringContaining('Silent failure'), href:'/task/stalled' })] });
  });
  test('Praxis zero-dispatch day grade is respected; zero counts alone do not create an alarm', async () => {
    state.executors.dispatchedToday = {total:0};
    expect((await read()).body.runtimeHealth.status).toBe('healthy');
    report('yellow', 'completely quiet — 0 dispatched, 0 in flight');
    expect((await read()).body.runtimeHealth).toMatchObject({ status:'degraded', causes:[expect.objectContaining({ detail:expect.stringContaining('0 dispatched'), href:'/ops' })] });
  });
  test('a realistic 34-check report does not turn unrelated preflight warnings into runtime degradation', async () => {
    const daily = realisticReport();
    expect(daily.checks).toHaveLength(34);
    fs.writeFileSync(path.join(dir, 'morning-health', `${day()}.json`), JSON.stringify({ date: day(), report: daily }), 'utf8');
    expect((await read()).body.runtimeHealth).toMatchObject({ status: 'healthy', causes: [], reportCapturedAt: daily.capturedAt });
    Object.assign(daily.checks.find(check => check.name === 'day activity'), { status: 'yellow', detail: '0 dispatched, 0 in flight' });
    fs.writeFileSync(path.join(dir, 'morning-health', `${day()}.json`), JSON.stringify({ date: day(), report: daily }), 'utf8');
    expect((await read()).body.runtimeHealth).toMatchObject({ status: 'degraded', causes: [expect.objectContaining({ detail: expect.stringContaining('day activity:'), href: '/ops' })] });
  });
  test('missing, stale and malformed health sources never report healthy', async () => {
    report('green', 'old report', '2020-01-01');
    expect((await read()).body.runtimeHealth.status).toBe('unknown');
    report('green', 'fine');
    fs.writeFileSync(process.env.PRAXIS_USAGE_RESUME_FILE, 'bad json', 'utf8');
    expect((await read()).body.runtimeHealth.status).toBe('unknown');
    fs.writeFileSync(process.env.PRAXIS_USAGE_RESUME_FILE, '[]', 'utf8');
    delete state.executors.posture;
    expect((await read()).body.runtimeHealth.status).toBe('unknown');
  });
  test('a known failure still appears when another source is unavailable', async () => {
    report('yellow', 'zero-dispatch day');
    delete state.executors.posture;
    expect((await read()).body.runtimeHealth).toMatchObject({status:'degraded', unavailable:expect.arrayContaining(['Fleet posture'])});
  });
  test('unreachable or rejected upstream never returns a green snapshot', async () => {
    upstreamStatus = 503;
    expect((await read()).status).toBe(503);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    expect((await read()).body.runtimeHealth.status).toBe('unknown');
  });
});
function listen(app) { return new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); }); }

describe('daily runtime report before the 05:35 ET preflight', () => {
  let dir, saved;
  beforeEach(() => {
    saved = process.env.PRAXIS_DATA_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-report-'));
    fs.mkdirSync(path.join(dir, 'morning-health'));
    process.env.PRAXIS_DATA_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PRAXIS_DATA_DIR;
    else process.env.PRAXIS_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function write(date, capturedAt, status = 'green') {
    const report = realisticReport(capturedAt);
    report.checks.find(check => check.name === 'day activity').status = status;
    if (status !== 'green') report.checks.find(check => check.name === 'day activity').detail = '0 dispatched, 0 in flight';
    fs.writeFileSync(path.join(dir, 'morning-health', `${date}.json`), JSON.stringify({ date, report }), 'utf8');
    return report;
  }
  test.each(['green', 'yellow'])('uses the latest prior day activity (%s) with its actual capture time at 02:00 ET', status => {
    write('2026-11-02', '2026-11-03T03:20:00Z');
    const latest = write('2026-11-03', '2026-11-04T03:20:00Z', status);
    write('2026-11-05', '2026-11-05T10:35:00Z');
    const report = readRuntimeReport(new Date('2026-11-04T07:00:00Z'));
    expect(report).toEqual(latest);
    expect(projectRuntimeHealth(healthyState(), { available: true, items: [] }, report)).toMatchObject({
      status: status === 'green' ? 'healthy' : 'degraded', reportCapturedAt: latest.capturedAt,
    });
  });
  test('prefers today even before preflight and does not mask malformed current reports', () => {
    write('2026-11-03', '2026-11-04T03:20:00Z');
    const today = write('2026-11-04', '2026-11-04T06:00:00Z', 'yellow');
    expect(readRuntimeReport(new Date('2026-11-04T07:00:00Z'))).toEqual(today);
    fs.writeFileSync(path.join(dir, 'morning-health', '2026-11-04.json'), 'bad json', 'utf8');
    expect(readRuntimeReport(new Date('2026-11-04T07:00:00Z'))).toBeNull();
  });
  test('missing reports remain unknown and prior reports expire at the morning preflight', () => {
    expect(readRuntimeReport(new Date('2026-11-04T07:00:00Z'))).toBeNull();
    write('2026-11-03', '2026-11-04T03:20:00Z');
    expect(readRuntimeReport(new Date('2026-11-04T10:34:59Z'))).not.toBeNull();
    expect(readRuntimeReport(new Date('2026-11-04T10:35:00Z'))).toBeNull();
  });
});
