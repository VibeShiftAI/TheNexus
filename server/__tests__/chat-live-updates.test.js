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

async function requestJson(url, options = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, options);
  return {
    status: res.status,
    body: await res.json(),
  };
}

function createDbStub() {
  let saveCount = 0;
  return {
    getActiveConversation: jest.fn().mockResolvedValue({ id: 'conv-1', mode: 'praxis' }),
    saveChatMessage: jest.fn().mockImplementation(async (message) => {
      saveCount += 1;
      return {
        ...message,
        id: message.id || `msg-${saveCount}`,
        created_at: `2026-04-25T12:00:0${saveCount}.000Z`,
        metadata: message.metadata || {},
      };
    }),
  };
}

describe('Praxis chat live updates', () => {
  let handle;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    if (handle) await close(handle);
    handle = null;
    global.fetch = originalFetch;
    jest.resetModules();
  });

  it('broadcasts saved user and assistant messages from the Praxis chat route', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'Fresh Praxis response' }),
    });

    const db = createDbStub();
    const io = { emit: jest.fn() };
    const createAIChatRouter = require('../routes/ai-chat');
    const app = express();
    app.use(express.json());
    app.use('/api/ai/chat', createAIChatRouter({ db, callAI: jest.fn(), io }));
    handle = await listen(app);

    await expect(requestJson(`${handle.baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'praxis', message: 'hello praxis', history: [] }),
    }, originalFetch)).resolves.toMatchObject({
      status: 200,
      body: expect.objectContaining({ assistantMessageId: 'msg-2' }),
    });

    expect(io.emit).toHaveBeenCalledWith('chat-message', expect.objectContaining({
      conversationId: 'conv-1',
      mode: 'praxis',
      message: expect.objectContaining({
        id: 'msg-1',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'hello praxis',
      }),
    }));
    expect(io.emit).toHaveBeenCalledWith('chat-message', expect.objectContaining({
      conversationId: 'conv-1',
      mode: 'praxis',
      message: expect.objectContaining({
        id: 'msg-2',
        conversation_id: 'conv-1',
        role: 'assistant',
        content: expect.stringContaining('Fresh Praxis response'),
      }),
    }));
  });

  it('broadcasts externally synced Praxis messages as live chat messages', async () => {
    const db = createDbStub();
    const io = { emit: jest.fn() };
    const createChatHistoryRouter = require('../routes/chat-history');
    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatHistoryRouter({ db, io }));
    handle = await listen(app);

    await expect(requestJson(`${handle.baseUrl}/api/chat/messages/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'praxis',
        messages: [{ id: 'external-1', role: 'assistant', content: 'sent from Praxis elsewhere' }],
      }),
    })).resolves.toEqual({ status: 200, body: { ok: true, synced: 1, conversationId: 'conv-1' } });

    expect(io.emit).toHaveBeenCalledWith('chat-message', expect.objectContaining({
      conversationId: 'conv-1',
      mode: 'praxis',
      message: expect.objectContaining({
        id: 'external-1',
        conversation_id: 'conv-1',
        role: 'assistant',
        content: 'sent from Praxis elsewhere',
      }),
    }));
  });
});
