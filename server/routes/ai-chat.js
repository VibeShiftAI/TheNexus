/**
 * AI Chat Routes
 * Handles the main /api/ai/chat endpoint — proxies to Cortex, Praxis, or direct LLM.
 */
const express = require('express');

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

async function writePraxisStreamToClient({ praxisResponse, res, db, io, conversationId, fullResponsePrefix = '', metadata = {} }) {
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

    const responseBody = finalResponse || streamedResponse || 'No response';
    const fullResponse = responseBody + fullResponsePrefix;
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

function createAIChatRouter({ db, callAI, pushService, io }) {
    const router = express.Router();
    const { buildChatMessageEvent, buildPraxisAssistantMetadata } = require('../chat-message-format');
    const {
        resolveModelAssignment,
        recordModelExecutionSnapshot,
        writeModelSystemMessage
    } = require('../services/model-control');

    async function resolveTerminalAssignment({ modelAssignment, projectId, mode, conversationId }) {
        if (!modelAssignment) return null;
        const resolved = await resolveModelAssignment(db, {
            requestedAssignment: modelAssignment,
            model_assignment: modelAssignment,
            projectId,
            project_id: projectId,
            role: mode === 'praxis' ? 'praxis' : 'chat'
        });
        await recordModelExecutionSnapshot(db, resolved, {
            project_id: projectId || null,
            conversation_id: conversationId || null
        });
        if (resolved.localOnlyActive || resolved.fallbackUsed) {
            const reason = resolved.localOnlyActive
                ? `local-only mode${resolved.localOnlyReason ? ` (${resolved.localOnlyReason})` : ''}`
                : `fallback (${resolved.fallbackReason || 'requested model unavailable'})`;
            await writeModelSystemMessage(
                db,
                io,
                `Model control redirected this terminal request to ${resolved.label || resolved.apiModelId} via ${reason}.`,
                { modelControl: { resolved, modelAssignment } }
            );
        }
        return resolved;
    }

    function toModelOverride(resolved) {
        if (!resolved) return null;
        return {
            provider: resolved.provider,
            apiModelId: resolved.apiModelId,
            parameters: resolved.parameters || {}
        };
    }

    router.post('/', async (req, res) => {
        const { message, modelConfig, model, mode, history, projectId, session_id, files, attachments, audio, clientMessageId, model_assignment, modelAssignment } = req.body || {};
        const requestedModelAssignment = model_assignment || modelAssignment || null;

        console.log(`\n🤖 [AI Chat] Request Details:`);
        console.log(`   → Mode: ${mode}`);
        console.log(`   → Model: ${requestedModelAssignment || model || (modelConfig && modelConfig.id)}`);
        console.log(`   → Message: "${message ? message.substring(0, 50) : 'None'}..."`);
        console.log(`   → Files: ${files ? files.length : 0} attached`);

        if (!message) return res.status(400).json({ error: 'Message is required' });

        // ─── PROXY TO PYTHON CORTEX ──────────────────────────────────────
        if (mode === 'agent' || mode === 'cortex') {
            try {
                console.log(`[AI Chat] Proxying 'agent' request to Python Cortex (Port 8000)...`);
                if (files?.length > 0) console.log(`   📎 Forwarding ${files.length} file(s) to Python:`, files.map(f => f.name));

                const pythonPayload = {
                    user_request: message,
                    session_id: session_id || require('crypto').randomUUID(),
                    project_id: projectId,
                    existing_workflow: null,
                    files: files || null,
                    use_cortex_brain: true
                };

                const pythonResponse = await fetch('http://localhost:8000/ai-builder/chat', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pythonPayload),
                    signal: AbortSignal.timeout(300000),
                });

                if (!pythonResponse.ok) throw new Error(`Python backend error: ${pythonResponse.status} ${await pythonResponse.text()}`);
                const data = await pythonResponse.json();

                if (data.mode === 'cortex_brain_error') {
                    return res.json({ response: data.response, model: 'cortex-error', provider: 'TheCortex', mode, isThinking: false, tokenUsage: { total: 0 }, artifacts: [] });
                }

                const modeInfo = data.mode === 'cortex_brain' ? 'System 2 Brain (Agora)' : 'Simple Responder';
                const debugFooter = `\n\n_—_\n*🧠 Debug: ${modeInfo}*`;

                return res.json({
                    response: data.response + debugFooter,
                    model: data.mode === 'cortex_brain' ? 'cortex-system2' : 'cortex-responder',
                    provider: 'TheCortex', mode, isThinking: false, tokenUsage: { total: 0 },
                    artifacts: data.artifacts || []
                });
            } catch (error) {
                console.error(`[AI Chat] Cortex Proxy Error:`, error);
                return res.json({ response: `⚠️ **Connection to The Cortex Failed**\n\nI couldn't reach the Python engine (Port 8000). Ensure \`launch_system.bat\` is running.\n\nError: ${error.message}`, model: 'system-error', provider: 'System', mode });
            }
        }

        // ─── PROXY TO PRAXIS ─────────────────────────────────────────────
        if (mode === 'praxis') {
            let conversationId = null;
            try {
                console.log(`[AI Chat] Proxying '${mode}' request to Praxis Agent (Port 54322)...`);
                const conversation = await db.getActiveConversation('praxis');
                conversationId = conversation ? conversation.id : null;
                const resolvedModel = await resolveTerminalAssignment({
                    modelAssignment: requestedModelAssignment,
                    projectId,
                    mode,
                    conversationId
                });

                if (conversationId) {
                    const savedUserMessage = await db.saveChatMessage({
                        id: clientMessageId,
                        conversation_id: conversationId, role: 'user', content: message, mode: 'praxis',
                        metadata: {
                            projectId, hasAudio: !!audio,
                            modelAssignment: requestedModelAssignment,
                            resolvedModel,
                            ...(attachments?.length > 0 ? { attachments: attachments.map(a => ({ type: a.mimeType?.startsWith('image/') ? 'image' : a.mimeType?.startsWith('audio/') ? 'audio' : 'file', url: a.url, name: a.originalName || a.name, mimeType: a.mimeType })) } : {})
                        }
                    });
                    if (savedUserMessage && io) {
                        io.emit('chat-message', buildChatMessageEvent(savedUserMessage));
                    }
                }

                const canStream = wantsEventStream(req) && !audio && !(attachments?.length > 0);
                const praxisPayload = {
                    message,
                    history,
                    projectId,
                    audio,
                    attachments: attachments || undefined,
                    modelAssignment: requestedModelAssignment,
                    resolvedModel,
                    modelOverride: toModelOverride(resolvedModel),
                    ...(canStream ? { stream: true } : {})
                };
                const praxisResponse = await fetch('http://127.0.0.1:54322/api/chat', {
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
                            fullResponsePrefix: `\n\n_\u2014_\n*\ud83e\udd16 Relayed by Praxis*`,
                            metadata: { modelAssignment: requestedModelAssignment, resolvedModel },
                        });
                    } catch (streamErr) {
                        console.error(`[AI Chat] Praxis stream relay error:`, streamErr);
                        res.write(`data: ${JSON.stringify({ type: 'error', error: streamErr.message || 'Praxis stream failed' })}\n\n`);
                        res.write('data: [DONE]\n\n');
                    }
                    return res.end();
                }

                const data = await praxisResponse.json();

                const debugFooter = `\n\n_\u2014_\n*\ud83e\udd16 Relayed by Praxis*`;
                const fullResponse = (data.response || "No response") + debugFooter;
                let assistantMessageId = null;

                if (conversationId) {
                    try {
                        const savedAssistantMessage = await db.saveChatMessage({ conversation_id: conversationId, role: 'assistant', content: fullResponse, mode: 'praxis', metadata: buildPraxisAssistantMetadata({ ...data, modelAssignment: requestedModelAssignment, resolvedModel }) });
                        assistantMessageId = savedAssistantMessage?.id || null;
                        if (savedAssistantMessage && io) {
                            io.emit('chat-message', buildChatMessageEvent(savedAssistantMessage));
                        }
                    } catch (dbErr) {
                        console.error(`[AI Chat] Failed to persist Praxis response to DB (non-fatal):`, dbErr.message);
                    }
                }

                return res.json({ response: fullResponse, model: 'praxis-agent', provider: 'Praxis', mode, conversationId, assistantMessageId, resolvedModel, isThinking: false, tokenUsage: { total: 0 }, artifacts: [], voiceData: data.voiceData });
            } catch (error) {
                console.error(`[AI Chat] Praxis Proxy Error:`, error);
                if (res.headersSent) return;
                return res.status(502).json({
                    error: `Praxis proxy error: ${error.message}`,
                    response: `\u26a0\ufe0f **Connection to Praxis Failed**\n\nI couldn't reach the Praxis daemon (Port 54322). Ensure the background service is running.\n\nError: ${error.message}`,
                    model: 'system-error', provider: 'System', mode
                });
            }
        }

        // ─── STANDARD LLM ROUTING ────────────────────────────────────────
        const config = modelConfig || { id: model || 'gemini-2.5-flash', apiModelId: model || 'gemini-2.5-flash', provider: 'Google', isThinking: false, parameters: {} };
        let resolvedModel = null;
        let executionConfig = config;

        const apiKeys = {
            Google: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
            OpenAI: process.env.OPENAI_API_KEY,
            Anthropic: process.env.ANTHROPIC_API_KEY,
            xAI: process.env.XAI_API_KEY,
            Local: 'local', // Local provider doesn't require a cloud API key
        };

        try {
            if (requestedModelAssignment) {
                resolvedModel = await resolveTerminalAssignment({
                    modelAssignment: requestedModelAssignment,
                    projectId,
                    mode,
                    conversationId: null
                });
                executionConfig = {
                    id: resolvedModel.resolvedModelId,
                    apiModelId: resolvedModel.apiModelId,
                    provider: resolvedModel.provider,
                    isThinking: !!resolvedModel.parameters?.thinking_config,
                    parameters: resolvedModel.parameters || {}
                };
            } else if (!apiKeys[config.provider] && config.provider !== 'Local') {
                return res.json({ response: `Praxis Terminal is ready! To enable ${config.provider} models, add the appropriate API key to your .env file.`, model: config.apiModelId, provider: config.provider, mode });
            }

            const systemPrompt = 'You are a helpful AI assistant for a developer dashboard called The Nexus.';
            const aiResponse = await callAI(executionConfig, message, systemPrompt, history || [], { returnFullResult: true });
            let debugFooter = `\n\n_—_\n*🔧 Debug: Native Node.js Route (Chat Mode).*`;
            if (message.toLowerCase().includes('autopilot') || message.toLowerCase().includes('cortex') || message.toLowerCase().includes('debate')) {
                debugFooter += `\n*💡 Tip: Switch to "Agent" mode to access Cortex Tools (Autopilot, Debates).*`;
            }
            return res.json({ response: aiResponse.text + debugFooter, model: executionConfig.apiModelId, provider: executionConfig.provider, mode, resolvedModel, isThinking: executionConfig.isThinking, tokenUsage: aiResponse.usage });
        } catch (error) {
            console.error(`[AI Chat] Error with ${executionConfig.provider}:`, error);
            return res.status(500).json({ error: `Failed to get response from ${executionConfig.provider}: ${error.message}`, model: executionConfig.apiModelId });
        }
    });

    return router;
}

module.exports = createAIChatRouter;
module.exports.getPraxisChatTimeoutMs = getPraxisChatTimeoutMs;
module.exports.wantsEventStream = wantsEventStream;
