const express = require('express');
const http = require('http');

function listen(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, sockets, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function close(handle) {
  for (const socket of handle.sockets) socket.destroy();
  return new Promise((resolve) => handle.server.close(resolve));
}

function requestJson(url, options = {}) {
  return fetch(url, options).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

describe('praxis-stream route', () => {
  let praxisHandle;
  let nexusHandle;

  afterEach(async () => {
    if (nexusHandle) await close(nexusHandle);
    if (praxisHandle) await close(praxisHandle);
    nexusHandle = null;
    praxisHandle = null;
    jest.resetModules();
    delete process.env.PRAXIS_URL;
  });

  it('proxies HITL list, detail, and resolve calls to Praxis', async () => {
    const praxis = express();
    praxis.use(express.json());
    const seen = [];

    praxis.get('/hitl/pending', (_req, res) => {
      seen.push('pending');
      res.json({ requests: [{ id: 'hitl-1', question: 'Pick a path' }] });
    });
    praxis.get('/hitl/recent', (_req, res) => {
      seen.push('recent');
      res.json({ requests: [{ id: 'hitl-2', question: 'Recent ask' }] });
    });
    praxis.get('/hitl/:id', (req, res) => {
      seen.push(`detail:${req.params.id}`);
      res.json({ id: req.params.id, question: 'Loaded ask' });
    });
    praxis.post('/hitl/:id/resolve', (req, res) => {
      seen.push(`resolve:${req.params.id}:${req.body.freeText}`);
      res.json({ status: 'resolved', request: { id: req.params.id } });
    });

    praxisHandle = await listen(praxis);
    process.env.PRAXIS_URL = praxisHandle.baseUrl;

    const createPraxisStreamRouter = require('../routes/praxis-stream');
    const nexus = express();
    nexus.use(express.json());
    nexus.use('/api/praxis', createPraxisStreamRouter());
    nexusHandle = await listen(nexus);
    const nexusBaseUrl = nexusHandle.baseUrl;

    await expect(requestJson(`${nexusBaseUrl}/api/praxis/hitl/pending`))
      .resolves.toEqual({ status: 200, body: { requests: [{ id: 'hitl-1', question: 'Pick a path' }] } });
    await expect(requestJson(`${nexusBaseUrl}/api/praxis/hitl/recent`))
      .resolves.toEqual({ status: 200, body: { requests: [{ id: 'hitl-2', question: 'Recent ask' }] } });
    await expect(requestJson(`${nexusBaseUrl}/api/praxis/hitl/hitl-3`))
      .resolves.toEqual({ status: 200, body: { id: 'hitl-3', question: 'Loaded ask' } });
    await expect(requestJson(`${nexusBaseUrl}/api/praxis/hitl/hitl-3/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ freeText: 'ship it' }),
    })).resolves.toEqual({ status: 200, body: { status: 'resolved', request: { id: 'hitl-3' } } });

    expect(seen).toEqual([
      'pending',
      'recent',
      'detail:hitl-3',
      'resolve:hitl-3:ship it',
    ]);
  });

  it('summons a council by calling the Praxis spawn_council agent tool', async () => {
    const praxis = express();
    praxis.use(express.json());
    let seenBody = null;

    praxis.post('/agent-tool', (req, res) => {
      seenBody = req.body;
      res.json({
        ok: true,
        result: '🏛️ **Council convened** — session `council-abc-123`.\nSeats: cli:codex.',
      });
    });

    praxisHandle = await listen(praxis);
    process.env.PRAXIS_URL = praxisHandle.baseUrl;

    const createPraxisStreamRouter = require('../routes/praxis-stream');
    const nexus = express();
    nexus.use(express.json());
    nexus.use('/api/praxis', createPraxisStreamRouter());
    nexusHandle = await listen(nexus);

    await expect(requestJson(`${nexusHandle.baseUrl}/api/praxis/council/summon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: 'Should we ship the cabinet panel now?',
        context: 'Keep the first version small.',
        deliverable: 'analysis',
        domain: 'engineering',
        focus: true,
      }),
    })).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        result: '🏛️ **Council convened** — session `council-abc-123`.\nSeats: cli:codex.',
      },
    });

    expect(seenBody).toEqual({
      name: 'spawn_council',
      args: {
        topic: 'Should we ship the cabinet panel now?',
        context: 'Keep the first version small.',
        deliverable: 'analysis',
        domain: 'engineering',
        focus: true,
      },
    });
  });

  it('serves the Praxis snapshot at both dashboard and mobile paths', async () => {
    const praxis = express();
    praxis.get('/presence', (_req, res) => {
      res.json({ activity: 'idle', summary: 'Idle' });
    });
    praxisHandle = await listen(praxis);
    process.env.PRAXIS_URL = praxisHandle.baseUrl;

    const createPraxisStreamRouter = require('../routes/praxis-stream');
    const nexus = express();
    nexus.use('/api/praxis', createPraxisStreamRouter());
    nexusHandle = await listen(nexus);
    const nexusBaseUrl = nexusHandle.baseUrl;

    const expected = {
      status: 200,
      body: {
        presence: { activity: 'idle', summary: 'Idle' },
        upstream: { connected: false, lastEventId: null },
      },
    };

    await expect(requestJson(`${nexusBaseUrl}/api/praxis/snapshot`)).resolves.toEqual(expected);
    await expect(requestJson(`${nexusBaseUrl}/api/praxis/stream/snapshot`)).resolves.toEqual(expected);
  });

  async function driveHitlPush(event) {
    const praxis = express();
    praxis.get('/stream', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`id: ${event.eventId}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    praxisHandle = await listen(praxis);
    process.env.PRAXIS_URL = praxisHandle.baseUrl;

    const notify = jest.fn().mockResolvedValue({ sent: 1, errors: 0 });
    const createPraxisStreamRouter = require('../routes/praxis-stream');
    const nexus = express();
    nexus.use('/api/praxis', createPraxisStreamRouter({ pushService: { notify } }));
    nexusHandle = await listen(nexus);

    await new Promise((resolve) => setTimeout(resolve, 100));
    return notify;
  }

  it('forwards the contract-defined deepLink verbatim into the mobile push', async () => {
    // Praxis now attaches a canonical deepLink (@praxis/contract buildHitlDeepLink)
    // to hitl.created; the relay must forward it as-is, not re-derive its own.
    const deepLink = {
      source: 'praxis-hitl',
      hitlId: 'hitl-1',
      route: '/(tabs)/inbox',
      taskId: 'task-1',
      reason: 'low_confidence',
      priority: 'high',
    };
    const event = {
      type: 'hitl.created',
      eventId: 'evt-1',
      at: '2026-04-17T22:31:00.000Z',
      request: {
        id: 'hitl-1',
        taskId: 'task-1',
        question: 'Should Praxis continue?',
        reason: 'low_confidence',
      },
      deepLink,
    };

    const notify = await driveHitlPush(event);

    expect(notify).toHaveBeenCalledWith({
      title: 'Praxis needs input',
      body: 'Should Praxis continue?',
      data: { type: 'hitl_request', ...deepLink },
      channelId: 'praxis-agent',
      categoryId: 'hitl-response',
    });
  });

  it('falls back to a canonical inbox deep link for older Praxis without deepLink', async () => {
    const event = {
      type: 'hitl.created',
      eventId: 'evt-2',
      at: '2026-04-17T22:31:00.000Z',
      request: {
        id: 'hitl-1',
        taskId: 'task-1',
        question: 'Should Praxis continue?',
        reason: 'low_confidence',
      },
    };

    const notify = await driveHitlPush(event);

    expect(notify).toHaveBeenCalledWith({
      title: 'Praxis needs input',
      body: 'Should Praxis continue?',
      data: {
        type: 'hitl_request',
        source: 'praxis-hitl',
        hitlId: 'hitl-1',
        route: '/(tabs)/inbox',
        taskId: 'task-1',
      },
      channelId: 'praxis-agent',
      categoryId: 'hitl-response',
    });
  });

  it('relays status-report MP3 artifacts byte-identically with audio/mpeg', async () => {
    const praxis = express();
    const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb]);
    const seen = [];
    praxis.get('/reports/:file', (req, res) => {
      seen.push(req.params.file);
      if (req.params.file === 'status-report-20260811-1203.mp3') {
        res.set('Content-Type', 'audio/mpeg');
        return res.send(mp3Bytes);
      }
      res.status(404).json({ error: 'report not found' });
    });

    praxisHandle = await listen(praxis);
    process.env.PRAXIS_URL = praxisHandle.baseUrl;

    const createPraxisStreamRouter = require('../routes/praxis-stream');
    const nexus = express();
    nexus.use('/api/praxis', createPraxisStreamRouter());
    nexusHandle = await listen(nexus);

    const ok = await fetch(`${nexusHandle.baseUrl}/api/praxis/report/status-report-20260811-1203.mp3`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('audio/mpeg');
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(mp3Bytes);

    const missing = await fetch(`${nexusHandle.baseUrl}/api/praxis/report/status-report-20260101-0000.mp3`);
    expect(missing.status).toBe(404);

    expect(seen).toEqual([
      'status-report-20260811-1203.mp3',
      'status-report-20260101-0000.mp3',
    ]);

    // Upstream unreachable → 502, not a hang or a decode attempt.
    await close(praxisHandle);
    praxisHandle = null;
    const down = await fetch(`${nexusHandle.baseUrl}/api/praxis/report/status-report-20260811-1203.mp3`);
    expect(down.status).toBe(502);
  });
});
