const { readConversationContext } = require('../chat-conversation-context');

test('the canonical receipt excludes another conversation, the current message, system events and later messages', async () => {
    const current = { id: 'current', conversation_id: 'selected', created_at: '2026-09-12T01:00:00Z' };
    const base = { id: 'alert', conversation_id: 'selected', role: 'assistant', content: 'Decide policy', created_at: '2026-09-12T00:59:00Z', metadata: { voiceAnnouncement: true } };
    const db = { getChatMessages: jest.fn(async () => [base, { ...base, id: 'other', conversation_id: 'other' },
        { ...base, id: 'current' }, { ...base, id: 'system', role: 'system' },
        { ...base, id: 'future', created_at: '2026-09-12T01:01:00Z' }]) };
    expect(await readConversationContext(db, current)).toEqual({ conversationId: 'selected', messages: [
        { id: 'alert', role: 'assistant', content: 'Decide policy', createdAt: base.created_at, voiceAnnouncement: true },
    ] });
    expect(db.getChatMessages).toHaveBeenCalledWith('selected', { limit: 12, before: current.created_at });
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
