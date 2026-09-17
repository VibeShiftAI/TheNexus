const express = require('express');
const http = require('http');
const listen = app => new Promise(resolve => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

describe('autonomy relay', () => {
  let upstream, nexus, router;
  afterEach(async () => {
    router?.closeUpstream();
    if (nexus) await close(nexus.server);
    if (upstream) await close(upstream.server);
    delete process.env.PRAXIS_URL;
    jest.resetModules();
  });
  async function setup(app) {
    app.get('/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); });
    upstream = await listen(app);
    process.env.PRAXIS_URL = upstream.url;
    router = require('../routes/praxis-stream')();
    const api = express();
    api.use(express.json());
    api.use('/api/praxis', router);
    nexus = await listen(api);
  }
  it('forwards state, pause and resume with operator attribution and in-flight runs', async () => {
    const app = express(); app.use(express.json());
    let flag = { paused: false };
    const inFlight = [{ taskId: 'active-task', executor: 'codex', phase: 'running' }];
    app.get('/api/autonomy', (_req, res) => res.json({ paused: flag.paused, flag, inFlight }));
    app.post('/api/autonomy/pause', (req, res) => {
      expect(req.body).toEqual({ by: 'Robert', reason: 'ops_console' });
      flag = { paused: true, since: '2026-09-07T12:00:00Z', requestedBy: req.body.by, reason: req.body.reason };
      res.json({ ok: true });
    });
    app.post('/api/autonomy/resume', (req, res) => {
      expect(req.body).toEqual({ by: 'Robert' }); flag = { paused: false }; res.json({ ok: true });
    });
    await setup(app);
    const get = async () => { const res = await fetch(`${nexus.url}/api/praxis/autonomy`); expect(res.status).toBe(200); return res.json(); };
    const post = action => fetch(`${nexus.url}/api/praxis/autonomy/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'pause' ? { by: 'Robert', reason: 'ops_console' } : { by: 'Robert' }),
    });
    expect((await get()).paused).toBe(false);
    expect((await post('pause')).status).toBe(200);
    expect(await get()).toEqual({ paused: true, flag, inFlight });
    expect((await post('resume')).status).toBe(200);
    expect((await get()).paused).toBe(false);
  });
  it('preserves a rejected action status and error', async () => {
    const app = express();
    app.post('/api/autonomy/pause', (_req, res) => res.status(503).json({ error: 'pause storage unavailable' }));
    await setup(app);
    const res = await fetch(`${nexus.url}/api/praxis/autonomy/pause`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'pause storage unavailable' });
  });
});
