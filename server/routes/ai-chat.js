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
const { praxisFetch, operatorProvenanceHeaders } = require('../services/praxis-client');
const { praxisTurnOutcome, praxisTurnFailed } = require('../chat-message-format');

const DEFAULT_PRAXIS_CHAT_TIMEOUT_MS = 20 * 60 * 1000;

// Non-streaming chat turns (attachments/audio disable SSE) sit with zero bytes
// on the wire while the Praxis agent works, and undici's default headersTimeout
// (5 min) fires long before the 20-minute budget below — killing the relay with
// UND_ERR_HEADERS_TIMEOUT and losing the reply. The Praxis call therefore uses
// undici's fetch with its phase timeouts disabled; the AbortSignal is the only clock.
let praxisChatDispatcher;
function getPraxisChatDispatcher() {
    if (praxisChatDispatcher === undefined) {
        try {
            const { Agent } = require('undici');
            praxisChatDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
        } catch (err) {
            // undici is a transitive dep; without it, keep default fetch behavior
            // (restores the 5-min ceiling instead of crashing the chat route).
            console.warn(`[AI Chat] undici unavailable (${err.message}) — long non-streaming turns may time out at 5 min`);
            praxisChatDispatcher = null;
        }
    }
    return praxisChatDispatcher || undefined;
}

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

const validTurnKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

/** Same exact user turn, same archived reply across stream reconnects/restarts. */
async function saveRelayReply(db, message, clientMessageId) {
    if (!validTurnKey(clientMessageId)) return { row: await db.saveChatMessage(message), inserted: true };
    const id = `${clientMessageId}:reply`;
    const matches = row => row?.role === 'assistant' && row.conversation_id === message.conversation_id && row.content === message.content;
    const existing = await db.getChatMessageById?.(id);
    if (existing) {
        if (!matches(existing)) throw new Error('Saved reply identity conflicts with this turn');
        return { row: existing, inserted: false };
    }
    const row = await db.saveChatMessage({ ...message, id, metadata: { ...message.metadata, replyTo: clientMessageId } });
    if (row) return { row, inserted: true };
    const raced = await db.getChatMessageById?.(id);
    return { row: matches(raced) ? raced : null, inserted: false };
}

async function writePraxisStreamToClient({ praxisResponse, res, db, io, conversationId, clientMessageId, metadata = {}, onReply = () => {} }) {
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
    let suppressVoice = false;
    let morningKickoff = false;
    let finalized = false;
    let outcome = {};

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

        if (event.type === 'error') throw new Error(event.error || 'Praxis stream failed');
        if (event.type === 'status' && typeof event.message === 'string') {
            res.write(`data: ${JSON.stringify({ type: 'status', state: event.state,
                message: event.message.slice(0, 1000), turn_id: event.turn_id,
                ...(validTurnKey(event.turn_id) ? { status_url: `/api/ai/chat/turns/${encodeURIComponent(event.turn_id)}` } : {}) })}\n\n`);
            return false;
        }
        const delta = event.delta ?? event.choices?.[0]?.delta?.content ?? '';
        if (delta) {
            onReply();
            streamedResponse += delta;
            res.write(`data: ${JSON.stringify({ type: 'delta', delta })}\n\n`);
        }

        if (event.type === 'final' || event.response) {
            finalized = true;
            finalResponse = event.response || streamedResponse;
            voiceData = Array.isArray(event.voiceData) ? event.voiceData : [];
            suppressVoice = event.suppressVoice === true;
            morningKickoff = event.morningKickoff === true;
            outcome = praxisTurnOutcome(event);
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

    if (!finalized) throw new Error('Praxis stream ended before confirming the reply was complete');
    const fullResponse = finalResponse || streamedResponse || 'No response';
    let assistantMessageId = null;

    if (conversationId) {
        try {
            const { row: savedAssistantMessage, inserted } = await saveRelayReply(db, {
                conversation_id: conversationId,
                role: 'assistant',
                content: fullResponse,
                mode: 'praxis',
                metadata: buildPraxisAssistantMetadata({ ...metadata, ...outcome, voiceData, suppressVoice }),
            }, clientMessageId);
            assistantMessageId = savedAssistantMessage?.id || null;
            if (savedAssistantMessage && io && inserted) {
                io.emit('chat-message', buildChatMessageEvent(savedAssistantMessage));
            }
        } catch (dbErr) {
            console.error(`[AI Chat] Failed to persist streamed Praxis response to DB (non-fatal):`, dbErr.message);
        }
    }

    const payload = {
        type: 'final',
        response: fullResponse,
        model: 'praxis-agent',
        provider: 'Praxis',
        mode: 'praxis',
        conversationId,
        assistantMessageId,
        historySaved: !!assistantMessageId,
        ...outcome,
        isThinking: false,
        tokenUsage: { total: 0 },
        artifacts: [],
        voiceData,
        ...(suppressVoice ? { suppressVoice: true } : {}),
        morningKickoff,
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.write('data: [DONE]\n\n');
    return payload;
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

// ── Retry join-map (mobile resilience) ───────────────────────────────────
// A phone on flaky cellular re-POSTs the same message (same clientMessageId)
// after its connection died mid-wait — the agent run takes minutes and the
// non-streaming response sends zero bytes until it finishes, so carrier NATs
// routinely kill the idle socket. Joining the retry onto the ORIGINAL
// in-flight Praxis run means no double agent execution and no duplicate
// persisted messages: the retry just resumes waiting on a fresh connection.
// Completed results stay joinable for a short TTL so a retry that lands just
// after the run finishes still gets the reply.
const CHAT_JOIN_TTL_MS = 10 * 60 * 1000;
const inflightChatRuns = new Map(); // clientMessageId -> Promise<payload>

function rememberChatRun(clientMessageId, runPromise) {
    inflightChatRuns.set(clientMessageId, runPromise);
    runPromise.then(
        () => {
            const timer = setTimeout(() => inflightChatRuns.delete(clientMessageId), CHAT_JOIN_TTL_MS);
            timer.unref?.();
        },
        // A failed run must not be pinned — the next retry should re-run.
        () => inflightChatRuns.delete(clientMessageId),
    );
}

// ── Durable dedupe fallback (2026-08-28 incident) ────────────────────────
// The join-map above is process-local and TTL-bound, but the client's retry
// clock is not: its backoff timers freeze while the app is backgrounded, so
// a re-POST can arrive arbitrarily late (46 minutes in the incident) — past
// the TTL, or after a server restart emptied the map — and would run the
// agent a second time. A saved reply is authoritative only when its identity
// explicitly links it to this clientMessageId. Chronological position alone
// cannot establish which turn an assistant message answered.
// The lookup is id-scoped — clientMessageId IS the row's PRIMARY KEY — so it
// stays exact however many messages have landed since and whichever
// conversation is active now. It deliberately does NOT scan a window of recent
// rows: the earlier window-scan version silently reopened this same duplicate-
// run bug once 200 messages followed the send, which a busy conversation
// reaches in ordinary use.
async function findStoredReplyForClientMessage(db, clientMessageId) {
    try {
        const userMessage = await db.getChatMessageById(clientMessageId);
        // Only a user row can be a re-POSTed send; anything else is not ours.
        if (!userMessage || userMessage.role !== 'user') return null;
        const { formatStoredChatMessage } = require('../chat-message-format');
        const uncertain = () => ({
            response: 'This saved turn has no confirmed, exactly linked reply. Its outcome is uncertain. Inspect the existing conversation before continuing; it will not be replayed automatically.',
            state: 'uncertain', error: 'outcome_uncertain', retryable: false, historySaved: false,
            clientMessageId, conversationId: userMessage.conversation_id || null,
            model: 'system-error', provider: 'System', mode: 'praxis', voiceData: [], suppressVoice: true,
        });
        const exact = await db.getChatMessageById(`${clientMessageId}:reply`);
        // Older replies may have random IDs but an explicit replyTo link. Never
        // infer a link merely because this is the next assistant row.
        const reply = exact || await db.getNextAssistantMessage?.(userMessage);
        const replyTo = reply && formatStoredChatMessage(reply).metadata?.replyTo;
        const linked = reply?.role === 'assistant' && reply.conversation_id === userMessage.conversation_id
            && (replyTo === clientMessageId || (exact && replyTo === undefined));
        if (!linked) {
            if (exact) return uncertain(); // conflicting exact identity is not a cache miss
            // Only newly marked turns are known to have reached Praxis with
            // this durable key. Its ledger can safely answer a missing local
            // receipt; old unkeyed history cannot prove that rerunning is safe.
            return formatStoredChatMessage(userMessage).metadata?.praxisTurnKey === clientMessageId ? null : uncertain();
        }
        const stored = formatStoredChatMessage(reply);
        return {
            response: stored.content || '',
            model: 'praxis-agent',
            provider: 'Praxis',
            mode: 'praxis',
            conversationId: userMessage.conversation_id || null,
            assistantMessageId: reply.id || null,
            isThinking: false,
            tokenUsage: { total: 0 },
            artifacts: [],
            ...praxisTurnOutcome(stored),
            ...(stored.voiceData ? { voiceData: stored.voiceData } : {}),
            ...(stored.suppressVoice === true ? { suppressVoice: true } : {}),
            replayedFromStore: true,
        };
    } catch (err) {
        // Best-effort: a lookup failure must never break a fresh send.
        console.error('[AI Chat] Durable dedupe lookup failed (non-fatal):', err.message);
        return null;
    }
}

function createAIChatRouter({ db, io }) {
    const router = express.Router();
    const authenticateOperator = require('../services/operator-access').createOperatorAuthenticator();
    // Server-owned membership, not a body flag or the legacy req.user stub.
    // The async relay retains this exact body object after sending its 202.
    const operatorTurns = new WeakSet();
    router.post('/', async (req, _res, next) => {
        if (req.body && typeof req.body === 'object' && await authenticateOperator(req)) {
            operatorTurns.add(req.body);
        }
        next();
    });
    const provenanceFor = (body, message, surface) => operatorTurns.has(body)
        ? operatorProvenanceHeaders(message, { surface }) : {};
    const activity = require('../services/chat-activity').createChatActivity({io});
    router.get('/activity', (_req,res) => {res.setHeader('Cache-Control','no-store');res.json(activity.snapshot());});
    router.get('/turns/:key', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!validTurnKey(req.params.key)) return res.status(400).json({ error: 'Invalid turn identity' });
        try {
            const response = await praxisFetch(`/api/chat/turns/${encodeURIComponent(req.params.key)}`, { method: 'GET', timeoutMs: 3000 });
            return res.status(response.status).json(await response.json());
        } catch { return res.status(503).json({ error: 'Saved turn status is temporarily unavailable. Do not resend work whose outcome is uncertain.' }); }
    });
    // Redacted self-check of the caller's own Access session (2026-09-25): reason
    // codes, identity kind and presence booleans only, never claims or tokens, so
    // Robert can see from his laptop why a session does or does not carry operator
    // identity without sending a chat turn or signing in again. Same-origin only;
    // it confers nothing and logs nothing.
    router.get('/operator-identity', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Same-origin requests only' });
        try {
            return res.json(await authenticateOperator.inspect(req));
        } catch {
            return res.status(503).json({ error: 'Operator identity check unavailable' });
        }
    });
    const { buildChatMessageEvent, buildPraxisAssistantMetadata } = require('../chat-message-format');
    const { readConversationContext } = require('../chat-conversation-context');
    const { resolveChatConversation } = require('../chat-conversation');

    router.use(require('./ai-chat-async')({ db, io, activity, run: async (body, userMessage) => {
        const conversationContext = await readConversationContext(db, userMessage);
        // Operator provenance is signed over the exact message Praxis receives
        // (praxis-client.js), so inline the files first and sign that.
        const relayMessage = inlineFilesIntoMessage(body.message, body.files);
        const response = await praxisFetch('/api/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...provenanceFor(body, relayMessage, 'nexus-chat-async-turn') },
            body: JSON.stringify({ message: relayMessage,
                idempotency_key: body.clientMessageId,
                history: body.history, projectId: body.projectId, audio: body.audio, voiceConversation: body.voiceConversation === true,
                attachments: body.attachments, conversationContext }),
            timeoutMs: getPraxisChatTimeoutMs(), dispatcher: getPraxisChatDispatcher(),
        });
        if (!response.ok) throw new Error(`Praxis returned ${response.status}`);
        return response.json();
    } }));

    router.post('/', async (req, res) => {
        const { message, mode, history, projectId, files, attachments, audio, clientMessageId } = req.body || {};

        // Retry join: a re-POST of a message we're already processing (or just
        // finished) attaches to that run instead of running the agent again.
        const joinable = typeof clientMessageId === 'string' && clientMessageId && !wantsEventStream(req);
        if (joinable && inflightChatRuns.has(clientMessageId)) {
            console.log(`[AI Chat] Retry joined onto in-flight run for message ${clientMessageId}`);
            try {
                return res.json(await inflightChatRuns.get(clientMessageId));
            } catch (error) {
                if (res.headersSent) return;
                return res.status(502).json({
                    error: `Praxis proxy error: ${error.message}`,
                    response: `⚠️ **Connection to Praxis Failed**\n\nI couldn't reach the Praxis daemon (Port 54322). Ensure the background service is running.\n\nError: ${error.message}`,
                    model: 'system-error', provider: 'System', mode: 'praxis'
                });
            }
        }

        // Map missed (TTL elapsed or server restarted): check the durable
        // store before running the agent — an already-answered message
        // returns its stored reply instead of executing a second run.
        if (joinable) {
            const storedReply = await findStoredReplyForClientMessage(db, clientMessageId);
            if (storedReply) {
                console.log(`[AI Chat] Late retry for already-answered message ${clientMessageId} — returning stored reply without relaying to Praxis`);
                return res.json(storedReply);
            }
        }

        // Attachments arrive in `attachments` (uploaded refs) and `files`
        // (inline text) — counting only `files` reported "0 attached" for an
        // image send and made the 2026-08-28 incident log misleading.
        const inlineFileCount = Array.isArray(files) ? files.length : 0;
        const uploadedAttachmentCount = Array.isArray(attachments) ? attachments.length : 0;
        console.log(`\n🤖 [AI Chat] Request Details:`);
        console.log(`   → Mode: ${mode || 'praxis'} (all modes relay to Praxis)`);
        console.log(`   → Message: "${message ? message.substring(0, 50) : 'None'}..."`);
        console.log(`   → Files: ${inlineFileCount + uploadedAttachmentCount} attached (${inlineFileCount} inline, ${uploadedAttachmentCount} uploaded)`);

        if (!message) return res.status(400).json({ error: 'Message is required' });

        let conversationId = null;
        let conversationContext;
        const activityId = clientMessageId || require('crypto').randomUUID();
        let activityAttempt;
        try {
            console.log(`[AI Chat] Relaying request to Praxis Agent (Port 54322)...`);
            const conversation = await resolveChatConversation(db, 'praxis', req.body.conversationId);
            conversationId = conversation ? conversation.id : null;

            if (conversationId) {
                const savedUserMessage = await db.saveChatMessage({
                    id: clientMessageId,
                    conversation_id: conversationId, role: 'user', content: message, mode: 'praxis',
                    metadata: {
                        projectId, hasAudio: !!audio,
                        ...(validTurnKey(clientMessageId) ? { praxisTurnKey: clientMessageId } : {}),
                        ...(attachments?.length > 0 ? { attachments: attachments.map(a => ({ type: a.mimeType?.startsWith('image/') ? 'image' : a.mimeType?.startsWith('audio/') ? 'audio' : 'file', url: a.url, name: a.originalName || a.name, mimeType: a.mimeType })) } : {})
                    }
                });
                if (savedUserMessage && io) {
                    io.emit('chat-message', buildChatMessageEvent(savedUserMessage));
                }
                let receipt = savedUserMessage;
                if (!receipt && clientMessageId && db.getChatMessageById) {
                    try {
                        const stored = await db.getChatMessageById(clientMessageId);
                        if (stored?.role === 'user' && stored.conversation_id === conversationId) receipt = stored;
                    } catch { /* Receipt telemetry must not change relay behavior. */ }
                }
                if (receipt) activityAttempt = activity.begin({id:activityId,conversationId,preview:message});
                conversationContext = await readConversationContext(db, receipt);
            }

            // Legacy agent/cortex mode tells Praxis to drive Cortex System-2
            // instead of its normal agent loop; that path is non-streaming
            // (the brain streams its artifacts to the Glass Box separately).
            const isAgentMode = mode === 'agent' || mode === 'cortex';
            const canStream = wantsEventStream(req) && !audio && !(attachments?.length > 0) && !isAgentMode;
            const praxisPayload = {
                message: inlineFilesIntoMessage(message, files),
                ...(validTurnKey(clientMessageId) ? { idempotency_key: clientMessageId } : {}),
                history,
                conversationContext,
                projectId,
                audio,
                attachments: attachments || undefined,
                ...(isAgentMode ? { agentMode: true } : {}),
                ...(canStream ? { stream: true } : {})
            };
            const fetchPraxis = async () => {
                const praxisResponse = await praxisFetch('/api/chat', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', ...(canStream ? { Accept: 'text/event-stream' } : {}),
                        // Operator provenance: signed over the exact message in the payload (praxis-client.js).
                        ...provenanceFor(req.body, praxisPayload.message, 'nexus-chat-turn') },
                    body: JSON.stringify(praxisPayload), timeoutMs: getPraxisChatTimeoutMs(), // local agent loops can be long
                    dispatcher: getPraxisChatDispatcher(),
                });
                if (!praxisResponse.ok) {
                    const errorText = await praxisResponse.text().catch(() => '(no body)');
                    console.error(`[AI Chat] Praxis returned ${praxisResponse.status}: ${errorText}`);
                    throw new Error(`Praxis returned ${praxisResponse.status}: ${errorText}`);
                }
                return praxisResponse;
            };

            if (canStream) {
                const praxisResponse = await fetchPraxis();
                activity.update(activityId,'working',undefined,activityAttempt);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders?.();
                res.socket?.setNoDelay(true);
                try {
                    const result = await writePraxisStreamToClient({
                        praxisResponse,
                        res,
                        db,
                        io,
                        conversationId,
                        clientMessageId,
                        onReply: () => activity.update(activityId,'replying',undefined,activityAttempt),
                    });
                    const failed = praxisTurnFailed(result);
                    activity.update(activityId,failed || !result.historySaved ? 'failed' : 'completed',
                        failed ? result.error || result.state : result.historySaved ? undefined : 'Praxis replied, but Nexus could not save the reply to conversation history.',activityAttempt);
                } catch (streamErr) {
                    activity.update(activityId,'failed',streamErr.message,activityAttempt);
                    console.error(`[AI Chat] Praxis stream relay error:`, streamErr);
                    res.write(`data: ${JSON.stringify({ type: 'error', error: streamErr.message || 'Praxis stream failed' })}\n\n`);
                    res.write('data: [DONE]\n\n');
                }
                return res.end();
            }

            // Non-streaming path (mobile sends, attachments, audio): run the
            // relay behind a joinable promise so a network-level client retry
            // with the same clientMessageId resumes THIS run instead of
            // executing the agent a second time. The reply also reaches the
            // client via the socket 'chat-message' event once persisted, so a
            // send whose every connection died still lands on the phone.
            const runPromise = (async () => {
                const praxisResponse = await fetchPraxis();
                const data = await praxisResponse.json();

                // The "🤖 Relayed by Praxis" debug footer is gone (2026-07-02) —
                // everything relays through Praxis now, so it was pure noise.
                const fullResponse = data.response || "No response";
                let assistantMessageId = null;

                if (conversationId) {
                    try {
                        const { row: savedAssistantMessage, inserted } = await saveRelayReply(db, { conversation_id: conversationId, role: 'assistant', content: fullResponse, mode: 'praxis', metadata: buildPraxisAssistantMetadata(data) }, clientMessageId);
                        assistantMessageId = savedAssistantMessage?.id || null;
                        if (savedAssistantMessage && io && inserted) {
                            io.emit('chat-message', buildChatMessageEvent(savedAssistantMessage));
                        }
                    } catch (dbErr) {
                        console.error(`[AI Chat] Failed to persist Praxis response to DB (non-fatal):`, dbErr.message);
                    }
                }

                const failed = praxisTurnFailed(data);
                activity.update(activityId,failed || !assistantMessageId ? 'failed' : 'completed',
                    failed ? data.error || data.state : assistantMessageId ? undefined : 'Praxis replied, but Nexus could not save the reply to conversation history.',activityAttempt);
                return { response: fullResponse, ...praxisTurnOutcome(data), model: 'praxis-agent', provider: 'Praxis', mode: 'praxis', conversationId, assistantMessageId, historySaved: !!assistantMessageId, isThinking: false, tokenUsage: { total: 0 }, artifacts: data.artifacts || [], voiceData: data.voiceData, ...(data.suppressVoice === true ? { suppressVoice: true } : {}), morningKickoff: data.morningKickoff === true };
            })();

            if (joinable) rememberChatRun(clientMessageId, runPromise);
            return res.json(await runPromise);
        } catch (error) {
            activity.update(activityId,'failed',error.message,activityAttempt);
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
