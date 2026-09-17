const express = require('express');
const http = require('http');
const nativeFetch = global.fetch;
const createRouter = require('../routes/ai-chat');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

describe('short acknowledged mobile chat requests', () => {
    let server, base, gate, db, rows, io;
    beforeEach(async () => {
        rows = new Map();
        gate = deferred();
        global.fetch = jest.fn(async () => { await gate.promise; return { ok: true, json: async () => ({ response: 'actual reply' }) }; });
        db = {
            getActiveConversation: async () => ({ id: 'conversation' }),
            getChatConversations: async () => [{ id: 'selected', mode: 'praxis' }, { id: 'wrong-mode', mode: 'other' }],
            getChatMessageById: async id => rows.get(id) || null,
            saveChatMessage: async row => { const saved = { ...row, created_at: new Date().toISOString() }; rows.set(row.id, saved); return saved; },
        };
        io = { emit: jest.fn() };
        const app = express(); app.use(express.json()); app.use('/api/ai/chat', createRouter({ db, io }));
        server = http.createServer(app);
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}/api/ai/chat`;
    });
    afterEach(async () => { gate.resolve(); server.closeAllConnections(); await new Promise(r => server.close(r)); global.fetch = nativeFetch; });
    async function post(id = 'async-1', extra = {}) {
        const res = await nativeFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hello', clientMessageId: id, async: true, ...extra }), signal: AbortSignal.timeout(500) });
        return { status: res.status, body: await res.json() };
    }
    async function status(id = 'async-1') { const res = await nativeFetch(`${base}/requests/${id}`); return { status: res.status, body: await res.json() }; }
    test('accepts and deduplicates concurrent sends before Praxis answers, then returns the exact reply', async () => {
        const [a, b] = await Promise.all([post(), post()]);
        expect(a.status).toBe(202); expect(b.status).toBe(202);
        expect(a.body).toMatchObject({ accepted: true, clientMessageId: 'async-1', status: 'pending' });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect((await status()).body.status).toBe('pending');
        expect((await (await nativeFetch(`${base}/activity`)).json()).turns[0]).toMatchObject({id:'async-1',phase:'received',conversationId:'conversation'});
        gate.resolve();
        for (let i = 0; i < 30 && (await status()).body.status === 'pending'; i++) await new Promise(r => setTimeout(r, 5));
        expect((await status()).body).toMatchObject({ status: 'completed', response: 'actual reply', assistantMessageId: 'async-1:reply' });
        expect((await post()).body.status).toBe('completed');
        expect((await (await nativeFetch(`${base}/activity`)).json()).turns[0].phase).toBe('completed');
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    test('keeps the selected conversation, forwards voice intent and exposes saved voice rows', async () => {
        db.getChatMessages = jest.fn(async () => [{ id: 'voice-alert:decision', conversation_id: 'selected', role: 'assistant', content: 'Decide the wakeup policy', created_at: '2026-09-12T00:49:55.162Z', metadata: { voiceAnnouncement: true } }]);
        const request = { conversationId: 'selected', voiceConversation: true, history: [{ role: 'user', content: 'earlier typed turn' }], projectId: 'project-1' };
        const accepted = await post('voice-turn', request);
        expect(accepted.body.conversationId).toBe('selected');
        expect(accepted.body.messages[0]).toMatchObject({ id: 'voice-turn', role: 'user', metadata: { voiceConversation: true } });
        expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ voiceConversation: true, history: request.history, projectId: 'project-1' });
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).conversationContext).toMatchObject({ conversationId: 'selected', messages: [expect.objectContaining({ id: 'voice-alert:decision', voiceAnnouncement: true })] });
        expect(db.getChatMessages).toHaveBeenCalledWith('selected', { limit: 12, before: rows.get('voice-turn').created_at });
        db.getActiveConversation = async () => ({ id: 'different' });
        gate.resolve();
        for (let i = 0; i < 30 && (await status('voice-turn')).body.status === 'pending'; i++) await new Promise(r => setTimeout(r, 5));
        const receipt = (await status('voice-turn')).body;
        expect(receipt.messages).toHaveLength(2);
        expect(receipt.messages[1]).toMatchObject({ id: 'voice-turn:reply', conversation_id: 'selected', metadata: { voiceConversation: true, playbackOwner: 'voice' } });
        expect(io.emit).toHaveBeenCalledWith('chat-message', expect.objectContaining({ conversationId: 'selected', message: expect.objectContaining({ id: 'voice-turn:reply' }) }));
    });
    test.each(['missing', 'wrong-mode', '', 42])('rejects invalid selected conversation %p before accepting or running', async conversationId => {
        const result = await post('invalid', { conversationId });
        expect([400, 404]).toContain(result.status);
        expect(rows.size).toBe(0); expect(global.fetch).not.toHaveBeenCalled();
    });
    test('does not invent a reply from unrelated assistant messages or replay an orphaned accepted send', async () => {
        rows.set('orphan', { id: 'orphan', role: 'user', content: 'hello', conversation_id: 'conversation', metadata: { asyncChat: true } });
        const result = await post('orphan');
        expect(result.body).toMatchObject({ accepted: true, status: 'interrupted' });
        expect(global.fetch).not.toHaveBeenCalled();
    });
    test('reports upstream failure as a response failure after acceptance, not a failed send', async () => {
        global.fetch.mockImplementation(async () => { await gate.promise; throw new Error('upstream unavailable'); });
        expect((await post('failure')).status).toBe(202);
        gate.resolve();
        for (let i = 0; i < 30 && (await status('failure')).body.status === 'pending'; i++) await new Promise(r => setTimeout(r, 5));
        expect((await status('failure')).body).toMatchObject({ accepted: true, status: 'failed', error: expect.stringContaining('upstream unavailable') });
        expect((await post('failure')).body.status).toBe('failed');
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
    test('does not acknowledge persistence failure or invoke Praxis', async () => {
        db.saveChatMessage = async () => null;
        expect((await post('disk-failure')).status).toBe(503);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
