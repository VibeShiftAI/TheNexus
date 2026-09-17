/** Supply a small canonical snapshot, not the browser's paginated transcript.
 * Praxis decides which excerpts its native CLI session has not already seen.
 */
async function readConversationContext(db, userMessage) {
    if (!userMessage?.conversation_id || !userMessage.created_at || !db.getChatMessages) return undefined;
    try {
        const rows = await db.getChatMessages(userMessage.conversation_id, { limit: 12, before: userMessage.created_at });
        const messages = rows.slice(-12).filter(row => row.conversation_id === userMessage.conversation_id
            && row.id !== userMessage.id && (row.role === 'user' || row.role === 'assistant')
            && typeof row.content === 'string' && Date.parse(row.created_at) < Date.parse(userMessage.created_at))
            .map(row => ({ id: row.id, role: row.role,
                content: row.content.length > 1200 ? `${row.content.slice(0, 1200)} …[truncated]` : row.content,
                createdAt: row.created_at, voiceAnnouncement: row.metadata?.voiceAnnouncement === true }));
        return { conversationId: userMessage.conversation_id, messages };
    } catch (error) {
        console.warn('[AI Chat] Recent conversation unavailable:', error.message);
        return undefined;
    }
}
module.exports = { readConversationContext };
