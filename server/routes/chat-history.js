/**
 * Chat History Routes
 * Conversation management, message history, and cross-platform sync.
 */
const express = require('express');

function createChatHistoryRouter({ db, io }) {
    const router = express.Router();
    const { formatStoredChatMessage } = require('../chat-message-format');

    // GET conversations
    router.get('/conversations', async (req, res) => {
        try {
            res.json({ conversations: await db.getChatConversations(req.query.mode || 'praxis') });
        } catch (error) {
            res.status(500).json({ error: 'Failed to list conversations' });
        }
    });

    // GET active conversation + messages
    router.get('/active', async (req, res) => {
        try {
            const conversation = await db.getActiveConversation(req.query.mode || 'praxis');
            if (!conversation) return res.json({ conversation: null, messages: [] });
            const messages = (await db.getChatMessages(conversation.id)).map(formatStoredChatMessage);
            res.json({ conversation, messages });
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

    // PUT switch conversation
    router.put('/conversations/:id/switch', async (req, res) => {
        try {
            const conversation = await db.switchConversation(req.params.id);
            if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
            const messages = (await db.getChatMessages(conversation.id)).map(formatStoredChatMessage);
            res.json({ conversation, messages });
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

    // GET chat history
    router.get('/history', async (req, res) => {
        try {
            const { conversationId, before } = req.query;
            if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
            const limit = Math.min(parseInt(req.query.limit) || 200, 200);
            const messages = (await db.getChatMessages(conversationId, { limit, before })).map(formatStoredChatMessage);
            res.json({ messages });
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
            const conversation = await db.getActiveConversation(mode);
            if (!conversation) return res.status(500).json({ error: 'Could not resolve active conversation' });
            const conversationId = conversation.id;

            let synced = 0;
            for (const msg of messages) {
                if (!msg.role || !msg.content) continue;
                try {
                    await db.saveChatMessage({
                        id: msg.id, conversation_id: conversationId, role: msg.role, content: msg.content, mode,
                        metadata: { platform: msg.platform || 'unknown', ...(msg.metadata || {}) }
                    });
                    synced++;
                } catch (saveErr) {
                    if (saveErr.message?.includes('UNIQUE constraint')) continue;
                    console.error(`[Chat Sync] Error saving message:`, saveErr.message);
                }
            }

            // Broadcast synced assistant messages with attachments via WebSocket
            for (const msg of messages) {
                if (msg.role === 'assistant' && msg.metadata?.attachments?.length > 0) {
                    io.emit('cortex-artifact', { type: 'CHAT_RESPONSE', data: { content: msg.content, attachments: msg.metadata.attachments } });
                }
            }

            res.json({ ok: true, synced, conversationId });
        } catch (error) {
            res.status(500).json({ error: 'Failed to sync messages: ' + error.message });
        }
    });

    return router;
}

module.exports = createChatHistoryRouter;
