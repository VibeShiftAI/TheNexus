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

  it('sends a mobile push notification when Praxis emits hitl.created', async () => {
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
    };
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

    expect(notify).toHaveBeenCalledWith({
      title: 'Praxis needs input',
      body: 'Should Praxis continue?',
      data: {
        type: 'hitl_request',
        hitlId: 'hitl-1',
        taskId: 'task-1',
        route: '/(tabs)/praxis',
      },
      channelId: 'praxis-agent',
      categoryId: 'hitl-response',
    });
  });
});
