const express = require('express');
const http = require('http');
const nativeFetch = global.fetch;

const outcomes = [
    { state: 'rejected', error: 'cli_model_incompatible', retryable: false },
    { state: 'uncertain', error: 'outcome_uncertain', retryable: false },
    { error: 'provider_failed', retryable: false },
];
const frames = payload => new Response(`data: ${JSON.stringify({ type: 'final', ...payload })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });

describe('Praxis terminal outcome relay', () => {
    let server, base, rows, db, io;
    async function stop() {
        if (!server) return;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        server = null;
    }
    async function mount() {
        jest.resetModules(); // New process-local join map; persisted rows survive.
        io = { emit: jest.fn() };
        const app = express(); app.use(express.json());
        app.use('/api/ai/chat', require('../routes/ai-chat')({ db, io }));
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}/api/ai/chat`;
    }
    beforeEach(async () => {
        rows = new Map();
        db = {
            getActiveConversation: async () => ({ id: 'synthetic-conversation' }),
            getChatMessages: async () => [],
            getChatMessageById: async id => rows.get(id) || null,
            saveChatMessage: jest.fn(async row => {
                if (rows.has(row.id)) return null;
                const saved = { ...row, metadata: JSON.stringify(row.metadata || {}), created_at: new Date().toISOString() };
                rows.set(row.id, saved); return saved;
            }),
        };
        await mount();
    });
    afterEach(async () => { await stop(); global.fetch = nativeFetch; jest.resetModules(); });
    const post = body => nativeFetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    test.each(outcomes.flatMap(outcome => [false, true].map(stream => [outcome.error, stream, outcome])))
    ('%s remains failed through stream=%s, saved metadata and restart replay', async (_error, stream, outcome) => {
        const payload = { response: 'The requested work did not complete.', ...outcome };
        global.fetch = jest.fn(async () => stream ? frames(payload) : Response.json(payload));
        const request = { message: 'Synthetic request', clientMessageId: 'synthetic-outcome', stream };
        const response = await post(request);
        const result = stream
            ? (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).find(event => event.type === 'final')
            : await response.json();
        expect(result).toMatchObject({ ...outcome, historySaved: true, response: payload.response });
        expect(JSON.parse(rows.get('synthetic-outcome:reply').metadata)).toMatchObject(outcome);
        const activity = await (await nativeFetch(`${base}/activity`)).json();
        expect(activity.turns[0]).toMatchObject({ phase: 'failed', detail: outcome.error });
        expect(io.emit.mock.calls.filter(([name]) => name === 'chat-activity').map(([, snapshot]) => snapshot.turns[0].phase)).not.toContain('completed');
        expect(io.emit).toHaveBeenCalledWith('chat-message', expect.objectContaining({ message: expect.objectContaining({ ...outcome, metadata: expect.objectContaining(outcome) }) }));

        expect(global.fetch).toHaveBeenCalledTimes(1);
        await stop(); await mount(); global.fetch.mockClear();
        const replay = await (await post({ ...request, stream: false })).json();
        expect(replay).toMatchObject({ ...outcome, response: payload.response, replayedFromStore: true });
        expect(global.fetch).not.toHaveBeenCalled();
        expect([...rows.values()].filter(row => row.role === 'assistant')).toHaveLength(1);
    });

    test.each(outcomes)('async $error stays failed after archival and restart', async outcome => {
        global.fetch = jest.fn(async () => Response.json({ response: 'The requested work did not complete.', ...outcome }));
        const request = { message: 'Synthetic async request', clientMessageId: 'synthetic-async-outcome', async: true };
        expect((await post(request)).status).toBe(202);
        let receipt;
        for (let i = 0; i < 30; i++) {
            receipt = await (await nativeFetch(`${base}/requests/${request.clientMessageId}`)).json();
            if (receipt.status !== 'pending') break;
            await new Promise(setImmediate);
        }
        expect(receipt).toMatchObject({ ...outcome, status: 'failed', assistantMessageId: `${request.clientMessageId}:reply` });
        expect(receipt.messages[1]).toMatchObject({ ...outcome, metadata: expect.objectContaining(outcome) });
        expect((await (await nativeFetch(`${base}/activity`)).json()).turns[0]).toMatchObject({ phase: 'failed', detail: outcome.error });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        await stop(); await mount(); global.fetch.mockClear();
        expect(await (await post(request)).json()).toMatchObject({ ...outcome, status: 'failed' });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
