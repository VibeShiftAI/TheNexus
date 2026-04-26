/**
 * AI Chat Routes
 * Handles the main /api/ai/chat endpoint — proxies to Cortex, Praxis, or direct LLM.
 */
const express = require('express');

function createAIChatRouter({ db, callAI, pushService, io }) {
    const router = express.Router();
    const { buildChatMessageEvent, buildPraxisAssistantMetadata } = require('../chat-message-format');

    router.post('/', async (req, res) => {
        const { message, modelConfig, model, mode, history, projectId, session_id, files, attachments, audio, clientMessageId } = req.body || {};

        console.log(`\n🤖 [AI Chat] Request Details:`);
        console.log(`   → Mode: ${mode}`);
        console.log(`   → Model: ${model || (modelConfig && modelConfig.id)}`);
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

                const praxisPayload = { message, history, projectId, audio, attachments: attachments || undefined };
                const praxisResponse = await fetch('http://127.0.0.1:54322/api/chat', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(praxisPayload), signal: AbortSignal.timeout(600000), // 10 min — agent loops with tool calls can be long
                });

                if (!praxisResponse.ok) {
                    const errorText = await praxisResponse.text().catch(() => '(no body)');
                    console.error(`[AI Chat] Praxis returned ${praxisResponse.status}: ${errorText}`);
                    throw new Error(`Praxis returned ${praxisResponse.status}: ${errorText}`);
                }
                const data = await praxisResponse.json();

                const debugFooter = `\n\n_\u2014_\n*\ud83e\udd16 Relayed by Praxis*`;
                const fullResponse = (data.response || "No response") + debugFooter;
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

                return res.json({ response: fullResponse, model: 'praxis-agent', provider: 'Praxis', mode, conversationId, assistantMessageId, isThinking: false, tokenUsage: { total: 0 }, artifacts: [], voiceData: data.voiceData });
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

        const apiKeys = {
            Google: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
            OpenAI: process.env.OPENAI_API_KEY,
            Anthropic: process.env.ANTHROPIC_API_KEY,
            xAI: process.env.XAI_API_KEY,
        };

        if (!apiKeys[config.provider]) {
            return res.json({ response: `Praxis Terminal is ready! To enable ${config.provider} models, add the appropriate API key to your .env file.`, model: config.apiModelId, provider: config.provider, mode });
        }

        try {
            const systemPrompt = 'You are a helpful AI assistant for a developer dashboard called The Nexus.';
            const aiResponse = await callAI(config, message, systemPrompt, history, { returnFullResult: true });
            let debugFooter = `\n\n_—_\n*🔧 Debug: Native Node.js Route (Chat Mode).*`;
            if (message.toLowerCase().includes('autopilot') || message.toLowerCase().includes('cortex') || message.toLowerCase().includes('debate')) {
                debugFooter += `\n*💡 Tip: Switch to "Agent" mode to access Cortex Tools (Autopilot, Debates).*`;
            }
            return res.json({ response: aiResponse.text + debugFooter, model: config.apiModelId, provider: config.provider, mode, isThinking: config.isThinking, tokenUsage: aiResponse.usage });
        } catch (error) {
            console.error(`[AI Chat] Error with ${config.provider}:`, error);
            return res.status(500).json({ error: `Failed to get response from ${config.provider}: ${error.message}`, model: config.apiModelId });
        }
    });

    return router;
}

module.exports = createAIChatRouter;
