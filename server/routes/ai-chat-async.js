/** Short mobile requests: persist acceptance, relay once, read the exact result.
 * A server restart leaves an accepted unfinished receipt "interrupted"; reading
 * or retrying it must never silently execute a potentially side-effecting turn.
 */
const express = require('express');
const { resolveChatConversation } = require('../chat-conversation');
const { buildChatMessageEvent, buildPraxisAssistantMetadata, formatStoredChatMessage } = require('../chat-message-format');

module.exports = function createAsyncChatRouter({ db, io, run, activity }) {
    const router = express.Router();
    const accepting = new Map();
    const running = new Set();
    const failures = new Map();
    const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
    const emit = row => { if (row && io) io.emit('chat-message', buildChatMessageEvent(row)); };

    async function read(id) {
        const user = await db.getChatMessageById(id);
        if (!user || user.role !== 'user') return null;
        const receipt = { accepted: true, clientMessageId: id, conversationId: user.conversation_id, messages: [formatStoredChatMessage(user)] };
        const reply = await db.getChatMessageById(`${id}:reply`);
        if (reply) {
            const formatted = formatStoredChatMessage(reply);
            return { ...receipt, status: 'completed', response: formatted.content, assistantMessageId: reply.id,
                ...(formatted.suppressVoice === true ? { suppressVoice: true } : {}),
                attachments: formatted.attachments, voiceData: formatted.voiceData, messages: [...receipt.messages, formatted] };
        }
        const error = await db.getChatMessageById(`${id}:error`);
        if (error || failures.has(id)) return { ...receipt, status: 'failed', error: error?.content || failures.get(id), messages: error ? [...receipt.messages, formatStoredChatMessage(error)] : receipt.messages };
        return { ...receipt, status: running.has(id) ? 'pending' : 'interrupted' };
    }

    async function finish(id, conversationId, body, userMessage) {
        try {
            const data = await run(body, userMessage);
            const saved = await db.saveChatMessage({ id: `${id}:reply`, conversation_id: conversationId,
                role: 'assistant', content: data.response || 'No response', mode: 'praxis',
                metadata: { ...buildPraxisAssistantMetadata(data), replyTo: id, ...(body.voiceConversation === true ? { voiceConversation: true, playbackOwner: 'voice' } : {}) } });
            if (!saved) throw new Error('The response could not be saved. Check the server before resending.');
            emit(saved);
            activity?.update(id,'completed');
        } catch (error) {
            activity?.update(id,'failed',error.message);
            const content = `Message received, but the final result could not be confirmed. Check saved chat before resending: ${error.message || 'Unknown error'}`;
            failures.set(id, content);
            const saved = await db.saveChatMessage({ id: `${id}:error`, conversation_id: conversationId,
                role: 'system', content, mode: 'praxis', metadata: { replyTo: id, responseFailed: true } });
            emit(saved);
            // Persisted errors survive restarts; memory only backs a failed DB write.
            if (saved) failures.delete(id);
        } finally {
            running.delete(id);
        }
    }

    async function accept(body) {
        const id = body.clientMessageId;
        const selected = body.conversationId === undefined ? null : await resolveChatConversation(db, 'praxis', body.conversationId);
        const existing = await read(id);
        if (existing) return existing;
        const conversation = selected || await resolveChatConversation(db, 'praxis');
        if (!conversation?.id) throw new Error('Chat storage unavailable');
        const saved = await db.saveChatMessage({ id, conversation_id: conversation.id,
            role: 'user', content: body.message, mode: 'praxis', metadata: { asyncChat: true, ...(body.voiceConversation === true ? { voiceConversation: true } : {}),
                projectId: body.projectId, hasAudio: !!body.audio,
                attachments: (body.attachments || []).map(a => ({ type: a.mimeType?.startsWith('image/') ? 'image' : a.mimeType?.startsWith('audio/') ? 'audio' : 'file', url: a.url, name: a.originalName || a.name, mimeType: a.mimeType })) } });
        if (!saved) throw new Error('Message was not saved; please retry');
        running.add(id);
        activity?.begin({id,conversationId:conversation.id,preview:body.message});
        emit(saved);
        // Own rejection handling even if storage itself throws during error recording.
        void finish(id, conversation.id, body, saved).catch(error => { failures.set(id, error.message); running.delete(id); });
        return { accepted: true, clientMessageId: id, conversationId: conversation.id, status: 'pending', messages: [formatStoredChatMessage(saved)] };
    }

    router.get('/requests/:id', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
        try {
            const result = await read(req.params.id);
            return result ? res.json(result) : res.status(404).json({ accepted: false, status: 'not_found' });
        } catch { return res.status(503).json({ error: 'Chat status unavailable' }); }
    });

    router.post('/', async (req, res, next) => {
        if (req.body?.async !== true) return next();
        const body = req.body;
        if (!validId(body.clientMessageId) || typeof body.message !== 'string' || !body.message.trim()
            || (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some(a => !a || typeof a.url !== 'string')))) {
            return res.status(400).json({ error: 'A valid clientMessageId, message, and attachments are required' });
        }
        res.setHeader('Cache-Control', 'no-store');
        const id = body.clientMessageId;
        // Reserve before the first await, including the persistence lookup.
        if (!accepting.has(id)) {
            const promise = accept(body);
            accepting.set(id, promise);
            promise.finally(() => accepting.delete(id)).catch(() => {});
        }
        try {
            const result = await accepting.get(id);
            if (body.conversationId !== undefined && body.conversationId !== result.conversationId) {
                return res.status(409).json({ error: 'Message ID belongs to another conversation' });
            }
            return res.status(result.status === 'pending' ? 202 : 200).json(result);
        } catch (error) { return res.status(error.status || 503).json({ accepted: false, error: error.message }); }
    });
    return router;
};
