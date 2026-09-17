const express = require('express');
const http = require('http');
const createRouter = require('../routes/chat-history');

describe('voice exchange archival', () => {
    let server, base, db, rows, io;
    beforeEach(async () => {
        rows = new Map();
        db = {
            getActiveConversation: jest.fn(async () => ({ id: 'active', mode: 'praxis' })),
            getChatConversations: async () => [{ id: 'selected', mode: 'praxis' }, { id: 'wrong', mode: 'other' }],
            getChatMessageById: async id => rows.get(id),
            saveChatMessage: jest.fn(async row => { if (rows.has(row.id)) return null; rows.set(row.id, row); return row; }),
        };
        io = { emit: jest.fn() };
        const app = express(); app.use(express.json()); app.use('/api/chat', createRouter({ db, io }));
        server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}/api/chat/messages/sync`;
    });
    afterEach(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
    const messages = [{ id: 'voice-local', role: 'user', content: 'open tasks' }, { id: 'voice-local:reply', role: 'assistant', content: 'On screen. Task board.', metadata: { voiceConversation: true, playbackOwner: 'voice' } }];
    async function post(extra = {}) { const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, ...extra }) }); return { status: res.status, body: await res.json() }; }
    test('archives in the selected conversation and acknowledges identical retries without duplicate events', async () => {
        const first = await post({ conversationId: 'selected' });
        expect(first).toMatchObject({ status: 200, body: { ok: true, synced: 2, conversationId: 'selected' } });
        expect(first.body.messages[1]).toMatchObject({ id: 'voice-local:reply', conversation_id: 'selected', metadata: { playbackOwner: 'voice' } });
        expect((await post({ conversationId: 'selected' })).body).toMatchObject({ ok: true, synced: 2 });
        expect(rows.size).toBe(2); expect(io.emit).toHaveBeenCalledTimes(2); expect(db.getActiveConversation).not.toHaveBeenCalled();
    });
    test('sync preserves suppression metadata in storage, receipt and socket event', async () => {
        const suppressed = [{ ...messages[1], metadata: { suppressVoice: true, voiceData: [{ audio: 'saved', mimeType: 'audio/wav' }] } }];
        const response = await post({ messages: suppressed });
        expect(response.body.messages[0]).toMatchObject({ suppressVoice: true, metadata: { suppressVoice: true }, voiceData: suppressed[0].metadata.voiceData });
        expect(rows.get('voice-local:reply').metadata.suppressVoice).toBe(true);
        expect(io.emit).toHaveBeenCalledWith('chat-message', expect.objectContaining({ message: expect.objectContaining({ suppressVoice: true, metadata: expect.objectContaining({ suppressVoice: true }) }) }));
    });
    test.each(['missing', 'wrong', 123, ''])('rejects invalid selected conversation %p without writes', async conversationId => {
        expect([400, 404]).toContain((await post({ conversationId })).status);
        expect(db.saveChatMessage).not.toHaveBeenCalled();
    });
    test('retains legacy active conversation selection', async () => {
        expect((await post()).body.conversationId).toBe('active');
    });
    test('does not report null persistence as synced or broadcast unsaved attachments', async () => {
        db.saveChatMessage.mockResolvedValue(null);
        const result = await post({ messages: [{ ...messages[1], metadata: { attachments: [{ type: 'image', url: '/x' }] } }] });
        expect(result).toMatchObject({ status: 503, body: { ok: false, synced: 0 } });
        expect(io.emit).not.toHaveBeenCalled();
    });
    test('a reused ID from another conversation is not successful archival', async () => {
        rows.set('voice-local', { ...messages[0], mode: 'praxis', conversation_id: 'elsewhere' });
        expect((await post()).body).toMatchObject({ ok: false, synced: 1 });
    });
    test('repeated voice event returns its canonical wording without overwriting or rebroadcasting', async () => {
        const announcement = { id: 'voice-alert:event-42', role: 'assistant', content: 'Original announcement.', metadata: { voiceAnnouncement: true, eventId: 'event-42', playbackOwner: 'voice', suppressVoice: true } };
        await post({ conversationId: 'selected', messages: [announcement] });
        const retry = await post({ conversationId: 'selected', messages: [{ ...announcement, content: 'Different generated words.' }] });
        expect(retry.status).toBe(200);
        expect(retry.body.messages[0].content).toBe('Original announcement.');
        expect(rows.size).toBe(1); expect(io.emit).toHaveBeenCalledTimes(1);
    });
    test('voice event reuse from a different conversation returns the existing row in its original conversation', async () => {
        const announcement = { id: 'voice-alert:event-42', role: 'assistant', content: 'Original announcement.', metadata: { voiceAnnouncement: true, eventId: 'event-42', playbackOwner: 'voice', suppressVoice: true } };
        await post({ conversationId: 'selected', messages: [announcement] });
        const retry = await post({ messages: [{ ...announcement, content: 'Regenerated announcement.' }] });
        expect(retry.status).toBe(200);
        expect(retry.body.messages[0]).toMatchObject({ content: 'Original announcement.', conversation_id: 'selected' });
        expect(rows.size).toBe(1); expect(io.emit).toHaveBeenCalledTimes(1);
    });
    test('voice retry cannot adopt an unrelated colliding row', async () => {
        rows.set('voice-alert:event-42', { id: 'voice-alert:event-42', role: 'assistant', content: 'Unrelated.', mode: 'praxis', conversation_id: 'selected', metadata: {} });
        const retry = await post({ conversationId: 'selected', messages: [{ id: 'voice-alert:event-42', role: 'assistant', content: 'Announcement.', metadata: { voiceAnnouncement: true, eventId: 'event-42' } }] });
        expect(retry.status).toBe(503);
    });

});
