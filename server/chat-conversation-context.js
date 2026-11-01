const { isConversationalChatMessage } = require('../db/chat-message-policy');
/** Supply a small canonical snapshot, not the browser's paginated transcript.
 * Praxis decides which excerpts its native CLI session has not already seen.
 */
async function readConversationContext(db, userMessage) {
    if (!userMessage?.conversation_id || !userMessage.created_at) return undefined;
    const currentMessage = userMessage.role === 'user' && typeof userMessage.id === 'string' && userMessage.id.trim()
        ? { id: userMessage.id, role: 'user', createdAt: userMessage.created_at } : undefined;
    const receipt = { conversationId: userMessage.conversation_id, ...(currentMessage ? { currentMessage } : {}), messages: [] };
    if (!db.getChatMessages) return currentMessage ? receipt : undefined;
    try {
        const rows = await db.getChatMessages(userMessage.conversation_id, { limit: 12, before: userMessage.created_at, conversationalOnly: true });
        const messages = rows.slice(-12).filter(row => row.conversation_id === userMessage.conversation_id
            && row.id !== userMessage.id && isConversationalChatMessage(row)
            && typeof row.content === 'string' && Date.parse(row.created_at) < Date.parse(userMessage.created_at))
            .map(row => ({ id: row.id, role: row.role,
                content: row.content.length > 1200 ? `${row.content.slice(0, 1200)} …[truncated]` : row.content,
                createdAt: row.created_at, voiceAnnouncement: row.metadata?.voiceAnnouncement === true }));
        return { ...receipt, messages };
    } catch (error) {
        console.warn('[AI Chat] Recent conversation unavailable:', error.message);
        return currentMessage ? receipt : undefined;
    }
}
module.exports = { readConversationContext };
