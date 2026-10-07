const express = require('express');
const http = require('http');
const createRouter = require('../routes/ai-chat');
let server, base, db, originalFetch;
beforeEach(async () => {
    originalFetch = global.fetch;
    db = { getActiveConversation: async () => ({ id: 'synthetic-conversation' }), getChatMessages: async () => [],
        getChatMessageById: async () => null, saveChatMessage: jest.fn(async row => ({ ...row, id: row.id || 'synthetic-reply', created_at: new Date().toISOString() })) };
    const app = express(); app.use(express.json()); app.use('/api/ai/chat', createRouter({ db, io: { emit: jest.fn() } }));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/ai/chat`;
});
afterEach(async () => { global.fetch = originalFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const frames = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
test('relay preserves turn status separately from assistant output and forwards a stable key', async () => {
    global.fetch = jest.fn(async () => frames([
        { type: 'status', state: 'accepted', message: 'Received; preparing your reply.', turn_id: 'synthetic-client', status_url: '/api/chat/turns/synthetic-client' },
        { type: 'status', state: 'degraded', message: 'The provider is taking longer than expected.', turn_id: 'synthetic-client' },
        { type: 'final', response: 'Actual verified answer' },
    ]));
    const res = await originalFetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Synthetic request', clientMessageId: 'synthetic-client', stream: true }) });
    const body = await res.text();
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).idempotency_key).toBe('synthetic-client');
    expect(body).toContain('"type":"status"'); expect(body).toContain('"state":"degraded"');
    expect(body).toContain('/api/ai/chat/turns/synthetic-client');
    expect(db.saveChatMessage.mock.calls.filter(([r]) => r.role === 'assistant').map(([r]) => r.content)).toEqual(['Actual verified answer']);
});
test.each([false, true])('nonstream/async path retains the same turn key (async=%s)', async async => {
    global.fetch = jest.fn(async () => Response.json({ response: 'Synthetic reply' }));
    const id = async ? 'synthetic-async' : 'synthetic-direct';
    const res = await originalFetch(base, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Synthetic request', clientMessageId: id, async }) });
    expect([200, 202]).toContain(res.status);
    for (let i = 0; i < 30 && !global.fetch.mock.calls.length; i++) await new Promise(setImmediate);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).idempotency_key).toBe(id);
});
test('read-only turn status proxy retrieves the original receipt without issuing a POST', async () => {
    global.fetch = jest.fn(async () => Response.json({ status: 'uncertain', retryable: false }));
    const res = await originalFetch(`${base}/turns/synthetic-client`);
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ status: 'uncertain', retryable: false });
    expect(global.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:54322/api/chat/turns/synthetic-client');
    expect(global.fetch.mock.calls[0][1].method || 'GET').toBe('GET');
    expect(db.saveChatMessage).not.toHaveBeenCalled();
});
test('a completed stream retry archives the same exact reply instead of another assistant message', async () => {
    const rows = new Map();
    db.getChatMessageById = async id => rows.get(id) || null;
    db.saveChatMessage.mockImplementation(async row => {
        const saved = { ...row, id: row.id || `random-${rows.size}`, created_at: new Date().toISOString() };
        if (rows.has(saved.id)) return null;
        rows.set(saved.id, saved); return saved;
    });
    global.fetch = jest.fn(async () => frames([{ type: 'final', response: 'Original confirmed answer' }]));
    const request = { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Synthetic request', clientMessageId: 'synthetic-replay', stream: true }) };
    await (await originalFetch(base, request)).text();
    const replay = await (await originalFetch(base, request)).text();
    expect([...rows.values()].filter(r => r.role === 'assistant')).toHaveLength(1);
    expect(rows.get('synthetic-replay:reply')?.content).toBe('Original confirmed answer');
    expect(replay).toContain('"historySaved":true');
});
