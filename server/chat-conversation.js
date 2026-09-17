/** Resolve an explicit chat without changing the active conversation. */
async function resolveChatConversation(db, mode, conversationId) {
    if (conversationId === undefined) return db.getActiveConversation(mode);
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
        throw Object.assign(new Error('Invalid conversation ID'), { status: 400 });
    }
    const conversations = await db.getChatConversations(mode);
    const conversation = conversations.find(c => c.id === conversationId && c.mode === mode);
    if (!conversation) throw Object.assign(new Error('Conversation not found for this chat mode'), { status: 404 });
    return conversation;
}
module.exports = { resolveChatConversation };
