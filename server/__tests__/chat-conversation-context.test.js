const { readConversationContext } = require('../chat-conversation-context');

test('current operator message identity survives missing or unavailable history', async () => {
    const current = { id: 'user-1', role: 'user', conversation_id: 'conversation-1', created_at: '2026-11-01T00:00:00Z' };
    const expected = { conversationId: 'conversation-1', currentMessage: { id: 'user-1', role: 'user', createdAt: current.created_at }, messages: [] };
    expect(await readConversationContext({}, current)).toEqual(expected);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(await readConversationContext({ getChatMessages: async () => { throw new Error('offline'); } }, current)).toEqual(expected); }
    finally { warning.mockRestore(); }
});

test('the canonical receipt excludes another conversation, the current message, system events and later messages', async () => {
    const current = { id: 'current', conversation_id: 'selected', created_at: '2026-09-12T01:00:00Z' };
    const base = { id: 'alert', conversation_id: 'selected', role: 'assistant', content: 'Decide policy', created_at: '2026-09-12T00:59:00Z', metadata: { voiceAnnouncement: true } };
    const db = { getChatMessages: jest.fn(async () => [base, { ...base, id: 'other', conversation_id: 'other' },
        { ...base, id: 'current' }, { ...base, id: 'system', role: 'system' },
        { ...base, id: 'future', created_at: '2026-09-12T01:01:00Z' }]) };
    expect(await readConversationContext(db, current)).toEqual({ conversationId: 'selected', messages: [] });
    expect(db.getChatMessages).toHaveBeenCalledWith('selected', { limit: 50, before: current.created_at, conversationalOnly: true });
});

test('missing storage context fails open and never guesses the active conversation', async () => {
    const db = { getActiveConversation: jest.fn(), getChatMessages: jest.fn(() => { throw new Error('unavailable'); }) };
    expect(await readConversationContext(db, undefined)).toBeUndefined();
    expect(db.getChatMessages).not.toHaveBeenCalled();
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        expect(await readConversationContext(db, { conversation_id: 'known', created_at: '2026-09-12T01:00:00Z' })).toBeUndefined();
    } finally { warning.mockRestore(); }
    expect(db.getActiveConversation).not.toHaveBeenCalled();
});

test('context retains actual voice dialogue and excludes duplicate operational transcripts', async () => {
    const base = { conversation_id: 'selected', role: 'assistant', content: 'The answer', created_at: '2026-09-12T00:59:00Z' };
    const db = { getChatMessages: async () => [
        { ...base, id: 'voice', metadata: { voiceConversation: true } },
        { ...base, id: 'delivery', metadata: { voiceDeliveryNotice: true } },
        { ...base, id: 'hitl', metadata: { hitlAnnounce: true } },
    ] };
    const result = await readConversationContext(db, { id: 'current', conversation_id: 'selected', created_at: '2026-09-12T01:00:00Z' });
    expect(result.messages.map(row => row.id)).toEqual(['voice']);
});

// 2026-11-01 chat-history decision: the latest sitting, whole (it was the
// last 12 messages, each cut to 1,200 characters).
describe('the latest sitting', () => {
    const at = minutes => new Date(Date.parse('2026-11-01T12:00:00Z') + minutes * 60_000).toISOString();
    const row = (id, minutes, content = `content-${id}`) => ({ id, conversation_id: 'c', role: 'assistant', content, created_at: at(minutes), metadata: {} });
    // A store that pages like db.getChatMessages: newest `limit` rows before `before`, returned oldest first.
    const store = rows => ({ getChatMessages: jest.fn(async (_id, { limit, before }) =>
        rows.filter(r => r.created_at < before).slice(-limit)) });

    test('a new sitting carries the previous sitting, every message whole, and stops at the 45-minute gap', async () => {
        const long = 'x'.repeat(5000) + 'END-OF-LONG';
        const rows = [row('older', 0), row('s1', 60), row('s2', 70, long), row('s3', 80)];
        const result = await readConversationContext(store(rows), { id: 'now', conversation_id: 'c', created_at: at(200) });
        expect(result.messages.map(m => m.id)).toEqual(['s1', 's2', 's3']);
        expect(result.messages[1].content).toBe(long);
    });

    test('mid-sitting it carries the sitting so far', async () => {
        const rows = [row('before-gap', 0), row('a', 50), row('b', 55)];
        const result = await readConversationContext(store(rows), { id: 'now', conversation_id: 'c', created_at: at(56) });
        expect(result.messages.map(m => m.id)).toEqual(['a', 'b']);
    });

    test('a sitting longer than one page is read across pages', async () => {
        const rows = [row('old', 0), ...Array.from({ length: 120 }, (_, i) => row(`m${i}`, 100 + i))];
        const db = store(rows);
        const result = await readConversationContext(db, { id: 'now', conversation_id: 'c', created_at: at(300) });
        expect(result.messages).toHaveLength(120);
        expect(result.messages[0].id).toBe('m0');
        expect(db.getChatMessages.mock.calls.length).toBeGreaterThan(2);
    });
});
