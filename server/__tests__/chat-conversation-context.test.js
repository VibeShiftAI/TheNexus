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
    expect(db.getChatMessages).toHaveBeenCalledWith('selected', { limit: 12, before: current.created_at, conversationalOnly: true });
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
