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
  // P3-30: the relay is the seam where Praxis's SSE becomes the dashboard's
  // live transport. Every upstream frame must reach BOTH the downstream SSE
  // subscribers and the Socket.IO fan-out (`praxis:event`), because the
  // dashboard's shared LiveBoardState context subscribes over the socket while
  // the SSE half is still carrying the older hooks.
  it('fans every upstream frame out to Socket.IO as well as downstream SSE', async () => {
    const praxis = express();
    let upstreamRes = null;
    praxis.get('/stream', (_req, res) => {
      res.status(200);
      res.set('Content-Type', 'text/event-stream');
      res.set('Cache-Control', 'no-cache');
      res.flushHeaders();
      upstreamRes = res;
    });

    praxisHandle = await listen(praxis);
    process.env.PRAXIS_URL = praxisHandle.baseUrl;

    const emitted = [];
    const io = { emit: (name, payload) => emitted.push([name, payload]) };

    const createPraxisStreamRouter = require('../routes/praxis-stream');
    const nexus = express();
    nexus.use('/api/praxis', createPraxisStreamRouter({ io }));
    nexusHandle = await listen(nexus);

    // Wait for the relay's upstream connection to land.
    for (let i = 0; i < 100 && !upstreamRes; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(upstreamRes).toBeTruthy();

    // A downstream SSE subscriber, so we can prove BOTH paths carry the frame.
    const controller = new AbortController();
    const sse = await fetch(`${nexusHandle.baseUrl}/api/praxis/stream`, { signal: controller.signal });
    expect(sse.status).toBe(200);
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();

    const frame = { type: 'task.completed', eventId: 'evt-fanout-1', taskId: 'task-9' };
    upstreamRes.write(`id: ${frame.eventId}\n`);
    upstreamRes.write(`event: ${frame.type}\n`);
    upstreamRes.write(`data: ${JSON.stringify(frame)}\n\n`);

    let seenDownstream = '';
    for (let i = 0; i < 50 && !seenDownstream.includes(frame.eventId); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      seenDownstream += decoder.decode(value, { stream: true });
    }
    expect(seenDownstream).toContain(`event: ${frame.type}`);
    expect(seenDownstream).toContain(frame.eventId);

    // Same frame, same object shape, on the socket.
    expect(emitted).toContainEqual(['praxis:event', frame]);

    controller.abort();
    try { upstreamRes.end(); } catch { /* already gone */ }
  });

  // P3-30 phase 2, step 3 — Praxis pushes events in instead of Nexus pulling
  // them off SSE. The route's whole job is to be the SAME broadcast() the
  // relay uses: if it grew its own fan-out, HITL pushes would keep firing on
  // the SSE copy and stop the day the SSE route is deleted, with the UI
  // looking perfectly correct throughout.
  describe('POST /api/praxis/events ingest', () => {
    async function startIngest({ serviceKey } = {}) {
      const praxis = express();
      // No /stream handler: the upstream relay just fails to connect and
      // retries, which is exactly the "Praxis pushes, Nexus doesn't pull"
      // end state and proves the POST path stands alone.
      praxisHandle = await listen(praxis);
      process.env.PRAXIS_URL = praxisHandle.baseUrl;
      if (serviceKey) process.env.NEXUS_SERVICE_KEY = serviceKey;
      else delete process.env.NEXUS_SERVICE_KEY;

      const emitted = [];
      const io = { emit: (name, payload) => emitted.push([name, payload]), on: () => {} };
      const notify = jest.fn().mockResolvedValue({ sent: 1, errors: 0 });

      const createPraxisStreamRouter = require('../routes/praxis-stream');
      const nexus = express();
      nexus.use('/api/praxis', createPraxisStreamRouter({ io, pushService: { notify } }));
      nexusHandle = await listen(nexus);

      const post = (body, headers = {}) =>
        fetch(`${nexusHandle.baseUrl}/api/praxis/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });

      return { post, emitted, notify };
    }

    afterEach(() => { delete process.env.NEXUS_SERVICE_KEY; });

    // Phase-2 review follow-up: the ingest boundary is the socket peer, not req.ip.
    // server.js sets `trust proxy`, so req.ip would honour a forged X-Forwarded-For.
    it('ignores X-Forwarded-For and judges loopback by the socket peer', async () => {
      const createPraxisStreamRouter = require('../routes/praxis-stream');
      const io = { emit: () => {}, on: () => {} };
      const notify = jest.fn().mockResolvedValue({ sent: 0, errors: 0 });
      const nexus = express();
      nexus.set('trust proxy', 1);
      let fakePeer = null;
      nexus.use((req, _res, next) => {
        if (fakePeer) Object.defineProperty(req, 'socket', { value: { remoteAddress: fakePeer }, configurable: true });
        next();
      });
      nexus.use('/api/praxis', createPraxisStreamRouter({ io, pushService: { notify } }));
      const handle = await listen(nexus);
      try {
        const post = () => fetch(`${handle.baseUrl}/api/praxis/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1' },
          body: JSON.stringify({ type: 'heartbeat', eventId: `xff-${Date.now()}`, at: new Date().toISOString() }),
        });
        // genuine loopback peer + forged header: accepted (header irrelevant)
        expect((await post()).status).toBe(200);
        // LAN peer + forged loopback header: rejected
        fakePeer = '192.168.1.55';
        expect((await post()).status).toBe(403);
      } finally {
        fakePeer = null;
        await new Promise((resolve) => handle.server.close(resolve));
      }
    });


    it('feeds a posted event through the same broadcast: SSE, socket, ring and HITL push', async () => {
      const ingest = await startIngest();

      const controller = new AbortController();
      const sse = await fetch(`${nexusHandle.baseUrl}/api/praxis/stream`, { signal: controller.signal });
      const reader = sse.body.getReader();
      const decoder = new TextDecoder();

      const event = {
        type: 'hitl.created',
        eventId: 'evt-post-1',
        at: '2026-09-04T09:00:00.000Z',
        request: { id: 'hitl-post-1', taskId: 'task-7', question: 'Ship it?' },
      };
      const res = await ingest.post(event);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, accepted: 1, duplicates: 0 });

      // Downstream SSE subscribers.
      let seen = '';
      for (let i = 0; i < 50 && !seen.includes('evt-post-1'); i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
      expect(seen).toContain('event: hitl.created');

      // Socket.IO fan-out.
      expect(ingest.emitted).toContainEqual(['praxis:event', event]);

      // And the HITL push — the choke point the design calls out by name.
      await new Promise((r) => setTimeout(r, 20));
      expect(ingest.notify).toHaveBeenCalledTimes(1);
      expect(ingest.notify.mock.calls[0][0].data).toMatchObject({ hitlId: 'hitl-post-1' });

      controller.abort();
    });

    it('dedupes by eventId so dual-publish costs nothing (and never double-pushes)', async () => {
      const ingest = await startIngest();
      const event = {
        type: 'hitl.created',
        eventId: 'evt-dupe-1',
        request: { id: 'hitl-dupe-1', question: 'Again?' },
      };

      expect(await (await ingest.post(event)).json()).toEqual({ ok: true, accepted: 1, duplicates: 0 });
      // The SSE relay's copy of the same event, arriving second.
      expect(await (await ingest.post(event)).json()).toEqual({ ok: true, accepted: 0, duplicates: 1 });

      expect(ingest.emitted.filter(([, p]) => p.eventId === 'evt-dupe-1')).toHaveLength(1);
      expect(ingest.notify).toHaveBeenCalledTimes(1);
    });

    it('accepts a batch and rejects a malformed event without half-publishing', async () => {
      const ingest = await startIngest();
      const res = await ingest.post({
        events: [
          { type: 'task.started', eventId: 'b-1' },
          { type: 'task.completed', eventId: 'b-2' },
        ],
      });
      expect(await res.json()).toEqual({ ok: true, accepted: 2, duplicates: 0 });
      expect(ingest.emitted.map(([, p]) => p.eventId)).toEqual(['b-1', 'b-2']);

      const bad = await ingest.post({ eventId: 'b-3' });
      expect(bad.status).toBe(400);
      expect(ingest.emitted.some(([, p]) => p.eventId === 'b-3')).toBe(false);
    });

    it('requires the service key when one is configured', async () => {
      const ingest = await startIngest({ serviceKey: 'sekrit' });
      const event = { type: 'task.started', eventId: 'evt-auth-1' };

      expect((await ingest.post(event)).status).toBe(401);
      expect((await ingest.post(event, { 'X-Nexus-Service-Key': 'wrong' })).status).toBe(401);
      expect(ingest.emitted).toHaveLength(0);

      const ok = await ingest.post(event, { 'X-Nexus-Service-Key': 'sekrit' });
      expect(ok.status).toBe(200);
      expect(ingest.emitted).toContainEqual(['praxis:event', event]);
    });

    it('makes posted events replayable on the socket resume handshake', async () => {
      const praxis = express();
      praxisHandle = await listen(praxis);
      process.env.PRAXIS_URL = praxisHandle.baseUrl;

      let onConnection = null;
      const io = { emit: () => {}, on: (n, fn) => { if (n === 'connection') onConnection = fn; } };
      const createPraxisStreamRouter = require('../routes/praxis-stream');
      const nexus = express();
      nexus.use('/api/praxis', createPraxisStreamRouter({ io }));
      nexusHandle = await listen(nexus);

      const post = (body) =>
        fetch(`${nexusHandle.baseUrl}/api/praxis/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      await post({ type: 'task.started', eventId: 'r-1' });
      await post({ type: 'task.completed', eventId: 'r-2' });

      const emitted = [];
      const handlers = {};
      onConnection({ on: (n, fn) => { handlers[n] = fn; }, emit: (n, p) => emitted.push([n, p]) });
      handlers['praxis:resume']({ since: 'r-1' });

      expect(emitted).toEqual([['praxis:event', { type: 'task.completed', eventId: 'r-2' }]]);
    });
  });

  // P3-30 phase 2, step 1 — the reconnect handshake.
  //
  // Socket.IO has no `Last-Event-ID`, so a tab that reconnects after a gap
  // would silently miss every frame in it. The relay answers `praxis:resume
  // { since }` from its ring buffer: replay when it holds the cursor,
  // `praxis:resync` when it does not. These three tests pin the whole
  // contract, because a wrong answer here is invisible in the UI — the board
  // just quietly stops matching reality.
  describe('praxis:resume replay handshake', () => {
    /**
     * A relay wired to a fake Socket.IO server, plus a live upstream SSE
     * response to push frames into. Returns the captured `connection` handler
     * so a test can attach a fake socket and speak the handshake directly.
     */
    async function startRelayWithFakeIo() {
      const praxis = express();
      let upstreamRes = null;
      praxis.get('/stream', (_req, res) => {
        res.status(200);
        res.set('Content-Type', 'text/event-stream');
        res.set('Cache-Control', 'no-cache');
        res.flushHeaders();
        upstreamRes = res;
      });

      praxisHandle = await listen(praxis);
      process.env.PRAXIS_URL = praxisHandle.baseUrl;

      const broadcasted = [];
      let onConnection = null;
      const io = {
        emit: (name, payload) => broadcasted.push([name, payload]),
        on: (name, fn) => { if (name === 'connection') onConnection = fn; },
      };

      const createPraxisStreamRouter = require('../routes/praxis-stream');
      const nexus = express();
      nexus.use('/api/praxis', createPraxisStreamRouter({ io }));
      nexusHandle = await listen(nexus);

      for (let i = 0; i < 100 && !upstreamRes; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(upstreamRes).toBeTruthy();
      expect(typeof onConnection).toBe('function');

      /** Push frames upstream and wait for the LAST one to reach the fan-out. */
      const sendMany = async (frames) => {
        for (const frame of frames) {
          upstreamRes.write(`id: ${frame.eventId}\n`);
          upstreamRes.write(`event: ${frame.type}\n`);
          upstreamRes.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        const last = frames[frames.length - 1];
        for (let i = 0; i < 600; i += 1) {
          const tail = broadcasted[broadcasted.length - 1];
          if (tail && tail[1] && tail[1].eventId === last.eventId) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`frame ${last.eventId} never reached the socket fan-out`);
      };
      const send = (frame) => sendMany([frame]);

      /** A fake connected client; `resume(since)` speaks the handshake. */
      const connect = () => {
        const emitted = [];
        const handlers = {};
        const socket = {
          emitted,
          on: (name, fn) => { handlers[name] = fn; },
          emit: (name, payload) => emitted.push([name, payload]),
        };
        onConnection(socket);
        expect(typeof handlers['praxis:resume']).toBe('function');
        return {
          socket,
          emitted,
          resume: (since) => handlers['praxis:resume']({ since }),
        };
      };

      return { send, sendMany, connect, broadcasted, close: () => { try { upstreamRes.end(); } catch { /* gone */ } } };
    }

    it('replays only the frames after `since` when the cursor is still in the ring', async () => {
      const relay = await startRelayWithFakeIo();
      await relay.send({ type: 'task.created', eventId: 'evt-1', taskId: 't1' });
      await relay.send({ type: 'task.started', eventId: 'evt-2', taskId: 't1' });
      await relay.send({ type: 'task.completed', eventId: 'evt-3', taskId: 't1' });

      const client = relay.connect();
      client.resume('evt-1');

      // Everything strictly after evt-1, in stream order, on this socket only.
      expect(client.emitted.map(([name, p]) => [name, p.eventId])).toEqual([
        ['praxis:event', 'evt-2'],
        ['praxis:event', 'evt-3'],
      ]);
      relay.close();
    });

    it('sends praxis:resync instead of a partial replay when the client is past the ring', async () => {
      const relay = await startRelayWithFakeIo();
      // RING_BUFFER_SIZE is 500; 520 frames evicts the earliest 20. Written in
      // one burst (the relay parses whole frames out of the chunk stream), then
      // we wait once for the last id to land.
      const ids = [];
      for (let i = 0; i < 520; i += 1) ids.push(`evt-${i}`);
      await relay.sendMany(ids.map((eventId) => ({ type: 'heartbeat', eventId })));

      const client = relay.connect();
      client.resume('evt-0'); // evicted — the relay cannot prove what we missed

      expect(client.emitted).toHaveLength(1);
      const [name, payload] = client.emitted[0];
      expect(name).toBe('praxis:resync');
      expect(payload.reason).toBe('ring-miss');
      // A still-held cursor near the end replays normally, proving the buffer
      // is a window and not simply broken.
      const fresh = relay.connect();
      fresh.resume('evt-517');
      expect(fresh.emitted.map(([n, p]) => [n, p.eventId])).toEqual([
        ['praxis:event', 'evt-518'],
        ['praxis:event', 'evt-519'],
      ]);
      relay.close();
    }, 30000);

    it('replays frames verbatim so the client dedupe set can drop the overlap', async () => {
      const relay = await startRelayWithFakeIo();
      const frames = [
        { type: 'task.created', eventId: 'evt-a', taskId: 't1' },
        { type: 'task.completed', eventId: 'evt-b', taskId: 't1' },
      ];
      for (const f of frames) await relay.send(f);

      const client = relay.connect();
      // Two resumes from the SAME cursor (a flapping connection) must produce
      // byte-identical frames both times: the provider dedupes by eventId, so
      // an overlapping replay costs nothing — but only if the ids are stable
      // and the payload is the original object, not a re-wrapped copy.
      client.resume('evt-a');
      client.resume('evt-a');
      expect(client.emitted).toEqual([
        ['praxis:event', frames[1]],
        ['praxis:event', frames[1]],
      ]);

      // No `since` at all (first connect) replays nothing.
      const fresh = relay.connect();
      fresh.resume(undefined);
      expect(fresh.emitted).toEqual([]);
      relay.close();
    });
  });
});
