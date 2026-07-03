/**
 * AI Chat Routes
 * Handles the main /api/ai/chat endpoint — a thin relay to Praxis.
 *
 * History note (2026-07-02 simplification): this route used to carry three
 * branches — a direct-to-Cortex proxy (dead once AGENT_VIA_PRAXIS became the
 * only configuration), a direct-LLM branch with per-provider API keys (never
 * used: every chat message ever stored is mode 'praxis'), and model-control
 * assignment resolution whose output Praxis ignored entirely. All of that is
 * gone; Praxis is the single orchestrator and does its own model routing.
 */
const express = require('express');
const { PRAXIS_URL } = require('../shared/constants');

const DEFAULT_PRAXIS_CHAT_TIMEOUT_MS = 20 * 60 * 1000;

function getPraxisChatTimeoutMs() {
    const configured = Number.parseInt(process.env.PRAXIS_CHAT_TIMEOUT_MS || '', 10);
    return Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_PRAXIS_CHAT_TIMEOUT_MS;
}

function wantsEventStream(req) {
    if (req.body?.stream === true) return true;
    return /\btext\/event-stream\b/i.test(req.get('accept') || '');
}

async function writePraxisStreamToClient({ praxisResponse, res, db, io, conversationId, metadata = {} }) {
    const { buildChatMessageEvent, buildPraxisAssistantMetadata } = require('../chat-message-format');
    const decoder = new TextDecoder();
    const reader = praxisResponse.body?.getReader?.();
    if (!reader) {
        throw new Error('Praxis stream response did not include a readable body');
    }

    let buffer = '';
    let streamedResponse = '';
    let finalResponse = '';
    let voiceData = [];

    async function handleFrame(frame) {
        const dataLines = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) return false;
        const data = dataLines.join('\n');
        if (data === '[DONE]') return true;

        let event;
        try {
            event = JSON.parse(data);
        } catch {
            return false;
        }

        const delta = event.delta ?? event.choices?.[0]?.delta?.content ?? '';
        if (delta) {
            streamedResponse += delta;
            res.write(`data: ${JSON.stringify({ type: 'delta', delta })}\n\n`);
        }

        if (event.type === 'final' || event.response) {
            finalResponse = event.response || streamedResponse;
            voiceData = Array.isArray(event.voiceData) ? event.voiceData : [];
        }

        return false;
    }

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
            const upstreamDone = await handleFrame(frame);
            if (upstreamDone) {
                buffer = '';
                break;
            }
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
        await handleFrame(buffer);
    }

    const fullResponse = finalResponse || streamedResponse || 'No response';
    let assistantMessageId = null;

    if (conversationId) {
        try {
            const savedAssistantMessage = await db.saveChatMessage({
                conversation_id: conversationId,
                role: 'assistant',
                content: fullResponse,
                mode: 'praxis',
                metadata: buildPraxisAssistantMetadata({ ...metadata, voiceData }),
            });
            assistantMessageId = savedAssistantMessage?.id || null;
            if (savedAssistantMessage && io) {
                io.emit('chat-message', buildChatMessageEvent(savedAssistantMessage));
            }
        } catch (dbErr) {
            console.error(`[AI Chat] Failed to persist streamed Praxis response to DB (non-fatal):`, dbErr.message);
        }
    }

    res.write(`data: ${JSON.stringify({
        type: 'final',
        response: fullResponse,
        model: 'praxis-agent',
        provider: 'Praxis',
        mode: 'praxis',
        conversationId,
        assistantMessageId,
        isThinking: false,
        tokenUsage: { total: 0 },
        artifacts: [],
        voiceData,
    })}\n\n`);
    res.write('data: [DONE]\n\n');
}

/** Inline attached text-file contents into the message Praxis receives.
 *  (Previously `files` was only forwarded on the removed Cortex branch and
 *  silently dropped in praxis mode.) */
function inlineFilesIntoMessage(message, files) {
    if (!Array.isArray(files) || files.length === 0) return message;
    const blocks = files
        .filter((f) => f && typeof f.content === 'string')
        .map((f) => `[Attached file: ${f.name || 'file'}]\n${f.content}`);
    if (blocks.length === 0) return message;
    return `${message}\n\n${blocks.join('\n\n')}`;
}

function createAIChatRouter({ db, io }) {
    const router = express.Router();
    const { buildChatMessageEvent, buildPraxisAssistantMetadata } = require('../chat-message-format');

    router.post('/', async (req, res) => {
        const { message, mode, history, projectId, files, attachments, audio, clientMessageId } = req.body || {};

        console.log(`\n🤖 [AI Chat] Request Details:`);
        console.log(`   → Mode: ${mode || 'praxis'} (all modes relay to Praxis)`);
        console.log(`   → Message: "${message ? message.substring(0, 50) : 'None'}..."`);
        console.log(`   → Files: ${files ? files.length : 0} attached`);

        if (!message) return res.status(400).json({ error: 'Message is required' });

        let conversationId = null;
        try {
            console.log(`[AI Chat] Relaying request to Praxis Agent (Port 54322)...`);
            const conversation = await db.getActiveConversation('praxis');
            conversationId = conversation ? conversation.id : null;

            if (conversationId) {
                const savedUserMessage = await db.saveChatMessage({
                    id: clientMessageId,
                    conversation_id: conversationId, role: 'user', content: message, mode: 'praxis',
                    metadata: {
                        projectId, hasAudio: !!audio,
                        ...(attachments?.length > 0 ? { attachments: attachments.map(a => ({ type: a.mimeType?.startsWith('image/') ? 'image' : a.mimeType?.startsWith('audio/') ? 'audio' : 'file', url: a.url, name: a.originalName || a.name, mimeType: a.mimeType })) } : {})
                    }
                });
                if (savedUserMessage && io) {
                    io.emit('chat-message', buildChatMessageEvent(savedUserMessage));
                }
            }

            // Legacy agent/cortex mode tells Praxis to drive Cortex System-2
            // instead of its normal agent loop; that path is non-streaming
            // (the brain streams its artifacts to the Glass Box separately).
            const isAgentMode = mode === 'agent' || mode === 'cortex';
            const canStream = wantsEventStream(req) && !audio && !(attachments?.length > 0) && !isAgentMode;
            const praxisPayload = {
                message: inlineFilesIntoMessage(message, files),
                history,
                projectId,
                audio,
                attachments: attachments || undefined,
                ...(isAgentMode ? { agentMode: true } : {}),
                ...(canStream ? { stream: true } : {})
            };
            const praxisResponse = await fetch(`${PRAXIS_URL}/api/chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...(canStream ? { Accept: 'text/event-stream' } : {}) },
                body: JSON.stringify(praxisPayload), signal: AbortSignal.timeout(getPraxisChatTimeoutMs()), // local agent loops can be long
            });

            if (!praxisResponse.ok) {
                const errorText = await praxisResponse.text().catch(() => '(no body)');
                console.error(`[AI Chat] Praxis returned ${praxisResponse.status}: ${errorText}`);
                throw new Error(`Praxis returned ${praxisResponse.status}: ${errorText}`);
            }

            if (canStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders?.();
                res.socket?.setNoDelay(true);
                try {
                    await writePraxisStreamToClient({
                        praxisResponse,
                        res,
                        db,
                        io,
                        conversationId,
                    });
                } catch (streamErr) {
                    console.error(`[AI Chat] Praxis stream relay error:`, streamErr);
                    res.write(`data: ${JSON.stringify({ type: 'error', error: streamErr.message || 'Praxis stream failed' })}\n\n`);
                    res.write('data: [DONE]\n\n');
                }
                return res.end();
            }

            const data = await praxisResponse.json();

            // The "🤖 Relayed by Praxis" debug footer is gone (2026-07-02) —
            // everything relays through Praxis now, so it was pure noise.
            const fullResponse = data.response || "No response";
            let assistantMessageId = null;

            if (conversationId) {
                try {
                    const savedAssistantMessage = await db.saveChatMessage({ conversation_id: conversationId, role: 'assistant', content: fullResponse, mode: 'praxis', metadata: buildPraxisAssistantMetadata(data) });
                    assistantMessageId = savedAssistantMessage?.id || null;
                    if (savedAssistantMessage && io) {
                        io.emit('chat-message', buildChatMessageEvent(savedAssistantMessage));
                    }
                } catch (dbErr) {
                    console.error(`[AI Chat] Failed to persist Praxis response to DB (non-fatal):`, dbErr.message);
                }
            }

            return res.json({ response: fullResponse, model: 'praxis-agent', provider: 'Praxis', mode: 'praxis', conversationId, assistantMessageId, isThinking: false, tokenUsage: { total: 0 }, artifacts: data.artifacts || [], voiceData: data.voiceData });
        } catch (error) {
            console.error(`[AI Chat] Praxis Proxy Error:`, error);
            if (res.headersSent) return;
            return res.status(502).json({
                error: `Praxis proxy error: ${error.message}`,
                response: `⚠️ **Connection to Praxis Failed**\n\nI couldn't reach the Praxis daemon (Port 54322). Ensure the background service is running.\n\nError: ${error.message}`,
                model: 'system-error', provider: 'System', mode: 'praxis'
            });
        }
    });

    return router;
}

module.exports = createAIChatRouter;
module.exports.getPraxisChatTimeoutMs = getPraxisChatTimeoutMs;
module.exports.wantsEventStream = wantsEventStream;
