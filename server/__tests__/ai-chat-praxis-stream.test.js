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

function createDbStub() {
  let saveCount = 0;
  return {
    getActiveConversation: jest.fn().mockResolvedValue({ id: 'conv-1', mode: 'praxis' }),
    saveChatMessage: jest.fn().mockImplementation(async (message) => {
      saveCount += 1;
      return {
        ...message,
        id: message.id || `msg-${saveCount}`,
        created_at: `2026-05-08T20:00:0${saveCount}.000Z`,
        metadata: message.metadata || {},
      };
    }),
  };
}

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  };
}

describe('AI chat Praxis token streaming', () => {
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

  it('streams Praxis deltas to the browser and persists one final assistant message', async () => {
    global.fetch = jest.fn().mockResolvedValue(streamResponse([
      'data: {"type":"delta","delta":"hello "}\n\n',
      'data: {"type":"delta","delta":"Robert"}\n\n',
      'data: {"type":"final","response":"hello Robert","voiceData":[],"suppressVoice":true}\n\n',
      'data: [DONE]\n\n',
    ]));

    const db = createDbStub();
    db.getChatMessages = jest.fn(async () => [{ id: 'previous', conversation_id: 'conv-1', role: 'assistant', content: 'Decide the wakeup policy', created_at: '2026-05-08T19:59:00.000Z', metadata: { voiceAnnouncement: true } }]);
    const io = { emit: jest.fn() };
    const createAIChatRouter = require('../routes/ai-chat');
    const app = express();
    app.use(express.json());
    app.use('/api/ai/chat', createAIChatRouter({ db, callAI: jest.fn(), io }));
    handle = await listen(app);

    const res = await originalFetch(`${handle.baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'praxis', message: 'systems check', history: [] }),
    });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).conversationContext).toMatchObject({ conversationId: 'conv-1', messages: [expect.objectContaining({ id: 'previous', voiceAnnouncement: true })] });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('data: {"type":"delta","delta":"hello "}');
    expect(body).toContain('data: {"type":"delta","delta":"Robert"}');
    expect(body).toContain('"type":"final"');
    expect(body).toContain('data: [DONE]');
    expect(body).toContain('"suppressVoice":true');
    expect(db.saveChatMessage.mock.calls.at(-1)[0].metadata.suppressVoice).toBe(true);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:54322/api/chat',
      expect.objectContaining({
        body: expect.stringContaining('"stream":true'),
      }),
    );
    expect(db.saveChatMessage).toHaveBeenCalledTimes(2);
    expect(db.saveChatMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      conversation_id: 'conv-1',
      role: 'assistant',
      content: expect.stringContaining('hello Robert'),
      mode: 'praxis',
    }));
    expect(io.emit).toHaveBeenCalledWith('chat-message', expect.objectContaining({
      conversationId: 'conv-1',
      message: expect.objectContaining({ id: 'msg-2', role: 'assistant' }),
    }));
    const phases=io.emit.mock.calls.filter(([name])=>name==='chat-activity').map(([,s])=>s.turns[0].phase);
    expect(phases).toEqual(['received','working','replying','completed']);
    const activity=await (await originalFetch(`${handle.baseUrl}/api/ai/chat/activity`)).json();
    expect(activity.turns[0]).toMatchObject({conversationId:'conv-1',phase:'completed'});
  });
  it('reports an interrupted stream as failed rather than a completed reply',async()=>{
    global.fetch=jest.fn().mockResolvedValue(streamResponse(['data: {"type":"delta","delta":"partial"}\n\n']));
    const io={emit:jest.fn()}, db=createDbStub();const app=express();app.use(express.json());app.use('/api/ai/chat',require('../routes/ai-chat')({db,io}));handle=await listen(app);
    const res=await originalFetch(`${handle.baseUrl}/api/ai/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'hello',stream:true,clientMessageId:'broken'})});
    expect(await res.text()).toContain('"type":"error"');
    const activity=await (await originalFetch(`${handle.baseUrl}/api/ai/chat/activity`)).json();
    expect(activity.turns[0].phase).toBe('failed');expect(db.saveChatMessage).toHaveBeenCalledTimes(1);
  });
  it.each([true,false])('preserves the reply but reports unsaved history for stream=%s',async(stream)=>{
    global.fetch=jest.fn().mockResolvedValue(stream?streamResponse(['data: {"type":"final","response":"Finished"}\n\n']):{ok:true,json:async()=>({response:'Finished'})});
    const db=createDbStub();db.saveChatMessage.mockImplementation(async message=>message.role==='user'?{...message,id:'u',created_at:new Date().toISOString()}:null);
    const io={emit:jest.fn()},app=express();app.use(express.json());app.use('/api/ai/chat',require('../routes/ai-chat')({db,io}));handle=await listen(app);
    const res=await originalFetch(`${handle.baseUrl}/api/ai/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'hello',stream,clientMessageId:'unsaved'})});
    const body=await res.text();expect(body).toContain('Finished');expect(body).toContain('"historySaved":false');
    const activity=await(await originalFetch(`${handle.baseUrl}/api/ai/chat/activity`)).json();
    expect(activity.turns[0]).toMatchObject({phase:'failed',detail:expect.stringContaining('could not save')});
  });
});
