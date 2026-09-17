/**
 * Chat History Routes
 * Conversation management, message history, and cross-platform sync.
 */
const express = require('express');
const { resolveChatConversation } = require('../chat-conversation');

function createChatHistoryRouter({ db, io }) {
    const router = express.Router();
    const { buildChatMessageEvent, formatStoredChatMessage } = require('../chat-message-format');

    // GET conversations
    router.get('/conversations', async (req, res) => {
        try {
            res.json({ conversations: await db.getChatConversations(req.query.mode || 'praxis') });
        } catch (error) {
            res.status(500).json({ error: 'Failed to list conversations' });
        }
    });

    // GET active conversation + messages (paginated, newest first)
    router.get('/active', async (req, res) => {
        try {
            const conversation = await db.getActiveConversation(req.query.mode || 'praxis');
            if (!conversation) return res.json({ conversation: null, messages: [], hasMore: false, total_count: 0 });
            const limit = Math.min(parseInt(req.query.limit) || 10, 200);
            const messages = (await db.getChatMessages(conversation.id, { limit })).map(formatStoredChatMessage);
            // Get total count to determine if there are older messages
            const allMessages = await db.getChatMessages(conversation.id);
            const total_count = allMessages.length;
            res.json({ conversation, messages, hasMore: total_count > messages.length, total_count });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get active conversation' });
        }
    });

    // POST create conversation
    router.post('/conversations', async (req, res) => {
        try {
            const conversation = await db.createConversation(req.body.mode || 'praxis', req.body.title || 'New Conversation');
            res.json({ conversation, messages: [] });
        } catch (error) {
            res.status(500).json({ error: 'Failed to create conversation' });
        }
    });

    // PUT switch conversation (paginated, newest first)
    router.put('/conversations/:id/switch', async (req, res) => {
        try {
            const conversation = await db.switchConversation(req.params.id);
            if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
            const limit = Math.min(parseInt(req.query.limit) || 10, 200);
            const messages = (await db.getChatMessages(conversation.id, { limit })).map(formatStoredChatMessage);
            const allMessages = await db.getChatMessages(conversation.id);
            const total_count = allMessages.length;
            res.json({ conversation, messages, hasMore: total_count > messages.length, total_count });
        } catch (error) {
            res.status(500).json({ error: 'Failed to switch conversation' });
        }
    });

    // PUT update conversation title
    router.put('/conversations/:id', async (req, res) => {
        try {
            const { title } = req.body;
            if (!title) return res.status(400).json({ error: 'Title is required' });
            const conversation = await db.updateConversationTitle(req.params.id, title);
            if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
            res.json({ conversation });
        } catch (error) {
            res.status(500).json({ error: 'Failed to update conversation' });
        }
    });

    // DELETE conversation
    router.delete('/conversations/:id', async (req, res) => {
        try {
            const deleted = await db.deleteConversation(req.params.id);
            if (!deleted) return res.status(404).json({ error: 'Conversation not found' });
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Failed to delete conversation' });
        }
    });

    // GET chat history (paginated, for scroll-up loading)
    router.get('/history', async (req, res) => {
        try {
            const { conversationId, before } = req.query;
            if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
            const limit = Math.min(parseInt(req.query.limit) || 10, 200);
            const messages = (await db.getChatMessages(conversationId, { limit, before })).map(formatStoredChatMessage);
            // Check if there are even older messages beyond what we returned
            const hasMore = messages.length === limit;
            res.json({ messages, hasMore });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch chat history' });
        }
    });

    // DELETE chat history
    router.delete('/history', async (req, res) => {
        try {
            const { conversationId } = req.query;
            if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
            res.json({ success: await db.clearChatMessages(conversationId) });
        } catch (error) {
            res.status(500).json({ error: 'Failed to clear chat history' });
        }
    });

    // POST sync messages from external platforms
    router.post('/messages/sync', async (req, res) => {
        try {
            const { messages, mode = 'praxis' } = req.body;
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: 'messages array is required' });
            }
            const conversation = await resolveChatConversation(db, mode, req.body.conversationId);
            if (!conversation) return res.status(500).json({ error: 'Could not resolve active conversation' });
            const conversationId = conversation.id;

            const stored = [];
            for (const msg of messages) {
                if (!msg.role || !msg.content) continue;
                try {
                    const announcementId = msg.metadata?.voiceAnnouncement === true && msg.role === 'assistant'
                        && typeof msg.metadata.eventId === 'string' && msg.id === `voice-alert:${msg.metadata.eventId}`;
                    // The first generated wording belongs to the event. A replay
                    // may generate a different sentence, but must reuse that row.
                    let savedMessage = announcementId ? await db.getChatMessageById(msg.id) : null;
                    let inserted = false;
                    try {
                        if (!savedMessage) {
                            savedMessage = await db.saveChatMessage({
                                id: msg.id, conversation_id: conversationId, role: msg.role, content: msg.content, mode,
                                metadata: { platform: msg.platform || 'unknown', ...(msg.metadata || {}) }
                            });
                            inserted = Boolean(savedMessage);
                        }
                    } catch (error) {
                        if (!error.message?.includes('UNIQUE constraint')) throw error;
                    }
                    // The facade returns null for both duplicate IDs and write failures.
                    // Normal messages require an identical row; voice events reuse their canonical wording.
                    if (!savedMessage && msg.id) savedMessage = await db.getChatMessageById(msg.id);
                    if (!savedMessage || savedMessage.role !== msg.role || savedMessage.mode !== mode) continue;
                    const formatted = formatStoredChatMessage(savedMessage);
                    const canonicalAnnouncement = announcementId && formatted.metadata?.voiceAnnouncement === true
                        && formatted.metadata.eventId === msg.metadata.eventId && formatted.metadata.playbackOwner === 'voice'
                        && formatted.metadata.suppressVoice === true;
                    if (!canonicalAnnouncement && (savedMessage.conversation_id !== conversationId || savedMessage.content !== msg.content)) continue;
                    stored.push(formatted);
                    if (inserted && io) {
                        io.emit('chat-message', buildChatMessageEvent(savedMessage));
                        if (msg.role === 'assistant' && formatted.metadata?.attachments?.length > 0) {
                            io.emit('cortex-artifact', { type: 'CHAT_RESPONSE', data: { content: msg.content, attachments: formatted.metadata.attachments } });
                        }
                    }
                } catch (saveErr) {
                    console.error(`[Chat Sync] Error saving message:`, saveErr.message);
                }
            }
            const ok = stored.length === messages.length;
            res.status(ok ? 200 : 503).json({ ok, synced: stored.length, conversationId, messages: stored,
                ...(!ok ? { error: 'Some messages could not be saved. Retry archival with the same message IDs.' } : {}) });
        } catch (error) {
            res.status(error.status || 500).json({ error: 'Failed to sync messages: ' + error.message });
        }
    });

    return router;
}

module.exports = createChatHistoryRouter;
