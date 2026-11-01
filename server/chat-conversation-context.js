const { isConversationalChatMessage } = require('../db/chat-message-policy');

/**
 * The quiet gap that ends a sitting: Praxis compacts its chat session after
 * this much idle time (CHAT_IDLE_COMPACT_MS in Praxis src/chat-cli-session.ts),
 * so a new sitting starts a fresh session seeded with a brief of the last one.
 */
const SITTING_GAP_MS = 45 * 60 * 1000;
/** Rows read per query while walking back; the walk continues until the sitting ends. */
const PAGE_ROWS = 50;

/**
 * Supply the canonical snapshot Praxis's chat session may lack: the latest
 * sitting before this message, every message whole. On a new sitting that is
 * the sitting the compacted session covered; mid-sitting it is the sitting so
 * far. It was the last 12 messages, each cut to 1,200 characters (2026-11-01
 * chat-history decision). Praxis decides what its native session has not
 * already seen and sizes it to the chat model's window.
 */
async function readConversationContext(db, userMessage) {
    if (!userMessage?.conversation_id || !userMessage.created_at) return undefined;
    const currentMessage = userMessage.role === 'user' && typeof userMessage.id === 'string' && userMessage.id.trim()
        ? { id: userMessage.id, role: 'user', createdAt: userMessage.created_at } : undefined;
    const receipt = { conversationId: userMessage.conversation_id, ...(currentMessage ? { currentMessage } : {}), messages: [] };
    if (!db.getChatMessages) return currentMessage ? receipt : undefined;
    try {
        const current = Date.parse(userMessage.created_at);
        const sitting = [];
        let before = userMessage.created_at;
        let newer = null;
        walk: for (;;) {
            const rows = await db.getChatMessages(userMessage.conversation_id, { limit: PAGE_ROWS, before, conversationalOnly: true });
            if (!rows.length) break;
            for (const row of [...rows].reverse()) {
                const at = Date.parse(row.created_at);
                if (newer !== null && newer - at >= SITTING_GAP_MS) break walk;
                newer = at;
                sitting.unshift(row);
            }
            if (rows.length < PAGE_ROWS) break;
            before = rows[0].created_at;
        }
        const messages = sitting.filter(row => row.conversation_id === userMessage.conversation_id
            && row.id !== userMessage.id && isConversationalChatMessage(row)
            && typeof row.content === 'string' && Date.parse(row.created_at) < current)
            .map(row => ({ id: row.id, role: row.role, content: row.content,
                createdAt: row.created_at, voiceAnnouncement: row.metadata?.voiceAnnouncement === true }));
        return { ...receipt, messages };
    } catch (error) {
        console.warn('[AI Chat] Recent conversation unavailable:', error.message);
        return currentMessage ? receipt : undefined;
    }
}
module.exports = { readConversationContext, SITTING_GAP_MS };
