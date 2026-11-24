"use client"

/**
 * AITerminal — the Praxis viewscreen: composition + chat transport.
 *
 * P2-27 (2026-09-03) decomposed the old ~2,275-line component. What stayed
 * here is the transport lane (SSE stream reader, /ingest, /api/ai/chat send
 * with file + audio upload) and the layout that wires the pieces together.
 * What moved out, and where:
 *   - markdown / highlighting / task-link decoration → components/chat/markdown-message
 *   - one transcript row (bubbles, artifacts, players) → components/chat/message-row
 *   - the fullscreen plan viewer (read-only)          → components/chat/plan-review-modal
 *   - the conversation-history panel                  → components/chat/conversation-list
 *   - attachment chips                                → components/chat/attachment-chips
 *   - the draft textarea + send button                → components/chat/composer
 *   - voice queue / autoplay timing                   → hooks/use-chat-audio
 *   - attachment selection / preview / removal        → hooks/use-file-attachments
 *   - scrollback, DOM window, history panel state     → hooks/use-chat-history
 *   - file upload + voice clip encoding for a send   → lib/chat-uploads
 *   - a turn's live steps and their folded line      → hooks/use-chat-turn-steps, components/chat/turn-steps
 * See docs/ai-terminal-map.md for the full inventory.
 */

import { Fragment, useState, forwardRef, useImperativeHandle } from "react";
import { Bot, Loader2, MessageSquare, Paperclip, Download } from "lucide-react";
import { useParams } from "next/navigation";

import { getAuthHeader } from "@/lib/auth";
import { ensureLocalOperatorSession, localOperatorHeaders } from "@/lib/local-operator-session";
import { noteChatSend } from "@/hooks/use-chat-activity";
import { readPraxisEventStream } from "@/lib/read-praxis-event-stream";
import { useCortex } from "@/components/cortex-provider";
import { dispatchMorningKickoff } from "@/components/bridge/bridge-fx";
import { executeDisplayDirective, readIssuedDirective, renderDisplayReport } from "@/lib/presentation-chat-relay";
import { currentOpenDocument } from "@/lib/presentation-open-document";
import { prepareChatFiles, voiceClipBase64 } from "@/lib/chat-uploads";
import { useChatAudio } from "@/hooks/use-chat-audio";
import { useChatHistory, messageKey } from "@/hooks/use-chat-history";
import { chatTurnSteps } from "@/lib/chat-turn-steps";
import { useChatTurnSteps } from "@/hooks/use-chat-turn-steps";
import { useFileAttachments } from "@/hooks/use-file-attachments";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { ComposerRow } from "@/components/chat/composer";
import { ConversationList } from "@/components/chat/conversation-list";
import { TerminalHeader } from "@/components/chat/terminal-header";
import { MessageRow } from "@/components/chat/message-row";
import { FoldedTurnSteps, LiveTurnSteps, UnconfirmedTurnNotice } from "@/components/chat/turn-steps";
import { PlanReviewModal } from "@/components/chat/plan-review-modal";
import type { Message, CortexArtifact, SendConversation } from "@/components/cortex-provider";

interface AITerminalProps {
    isOpen?: boolean;
    onClose?: () => void;
    mode?: 'modal' | 'inline';
    /** Hide the terminal's own header row; the host (e.g. PraxisCore) renders
     *  the new-conversation / history controls in its station header instead. */
    hideHeader?: boolean;
}

/** Imperative controls a host can drive when it hoists the header (hideHeader). */
export interface AITerminalHandle {
    newConversation: () => void;
    toggleHistory: () => void;
}

// 2026-07-02 simplification: the terminal is praxis-only. The old Agent/Chat
// modes and the model picker were removed — every message relays to Praxis,
// which does its own model routing (the picked model was ignored end-to-end).

/** A failed submission the transcript cannot show in full. Only chat turns have a saved-turn page. */
interface UnconfirmedSend {
    id: string;
    heading: string;
    text: string;
    turnId?: string;
}

function createClientMessageId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function noteReplyOutcome(clientMessageId: string, reply: { state?: string; error?: string; historySaved?: boolean }) {
    const failed = ['rejected', 'uncertain', 'failed'].includes(reply.state ?? '') || !!reply.error;
    noteChatSend(clientMessageId, failed || reply.historySaved === false ? 'failed' : 'completed', {
        detail: failed ? reply.error || reply.state : reply.historySaved === false
            ? 'Praxis replied, but Nexus could not save the reply to conversation history.' : undefined,
    });
}

export const AITerminal = forwardRef<AITerminalHandle, AITerminalProps>(function AITerminal({ isOpen = true, onClose, mode = 'modal', hideHeader = false }, ref) {
    const isInline = mode === 'inline';
    const { messages, setMessages, beginChatSend, conversationId, conversations, startNewConversation, switchConversation, loadConversations, deleteConversation, isLoadingHistory, hasMoreMessages, isLoadingMore, loadMoreMessages, chatAudio, playChatAudio, toggleChatAudio, pauseChatAudio } = useCortex();
    // NOTE: the composer's draft text deliberately does NOT live here — it is
    // ChatComposer's own state, so keystrokes can't re-render the transcript.
    const [loading, setLoading] = useState(false);
    const [unconfirmedSends, setUnconfirmedSends] = useState<UnconfirmedSend[]>([]);
    // A turn's status, steps and elapsed time live in the step store, outside the transcript.
    const turnSteps = useChatTurnSteps({ messages, conversationId, isLoadingHistory });

    // Scrollback + DOM render window + the history panel toggle.
    const {
        messagesContainerRef,
        visibleMessages,
        hiddenMessageCount,
        handleMessagesScroll,
        followBottom,
        showConversations,
        setShowConversations,
        toggleConversations,
    } = useChatHistory({
        messages,
        conversationId,
        isOpen,
        isLoadingHistory,
        hasMoreMessages,
        isLoadingMore,
        loadMoreMessages,
        loadConversations,
    });

    // Attachments (picker, drag-and-drop, previews) and the voice memo.
    const {
        attachedFiles,
        attachedPreviews,
        isDragging,
        fileInputRef,
        mediaInputRef,
        handleFileDrop,
        handleDragEnter,
        handleDragOver,
        handleDragLeave,
        handleDrop,
        removeFile,
        clearAttachments,
    } = useFileAttachments();
    const { isRecording, recordingTime, audioBlob, audioPreviewUrl, startRecording, stopRecording, clearAudio } = useVoiceRecorder(setMessages);

    // Voice-note autoplay queue + the global briefing player handoff.
    const {
        voiceAudioRefs,
        nowPlayingVoiceRef,
        dismissedVoice,
        setDismissedVoice,
        listenedVoice,
        setListenedVoice,
        getPlayedVoice,
        markVoicePlayed,
        playNextQueuedVoice,
        saveVoiceMemo,
    } = useChatAudio({ messages, chatAudio, playChatAudio, pauseChatAudio });

    // Expose chat controls so a host that hides the terminal header (e.g. the
    // consolidated PraxisCore station bar) can still drive new-conversation /
    // history from its own toolbar.
    useImperativeHandle(ref, () => ({
        newConversation: () => { void startNewConversation(); },
        toggleHistory: toggleConversations,
    }), [startNewConversation, toggleConversations]);
    // Track expanded artifact index for full content viewing (council reviews)
    const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
    // Fullscreen plan review modal state
    const [reviewModalData, setReviewModalData] = useState<{ artifact: CortexArtifact; messageKey: string } | null>(null);

    const params = useParams();
    const scopedProjectId = typeof params?.id === 'string' ? params.id : null;

    // Message persistence, the Socket.IO connection and artifact handling are
    // all owned by CortexProvider; praxis is the only mode.

    // A pending switch previews the row immediately. Accept (and clear) the
    // draft only once its conversation opens, so a failed switch is retryable.
    const sendInConversation = (message: Message, send: (chat: SendConversation) => void) => {
        setLoading(true);
        const destination = beginChatSend(message);
        if (destination instanceof Promise) {
            return destination.then(chat => {
                send(chat);
                return true;
            }, () => {
                setLoading(false);
                return false;
            });
        }
        send(destination);
        return true;
    };

    const handleSend = (rawText: string): boolean | Promise<boolean> => {
        const text = rawText.trim();
        if ((!text && attachedFiles.length === 0 && !audioBlob) || loading) return false;

        // ---------------------------------------------------------------
        // SLASH COMMAND: /ingest <url_or_text>
        // Directly ingests a link or text without invoking Praxis
        // ---------------------------------------------------------------
        if (text.startsWith('/ingest ') || text === '/ingest') {
            const payload = text.replace(/^\/ingest\s*/, '').trim();
            if (!payload) {
                setMessages(prev => [...prev, {
                    role: 'system',
                    content: '⚠️ Usage: /ingest <url> or /ingest <text to save>',
                    timestamp: new Date()
                }]);
                return false;
            }

            // Show user message
            const isUrl = /^https?:\/\//i.test(payload);
            const rowPayload = isUrl ? payload : payload.substring(0, 80) + (payload.length > 80 ? '...' : '');
            return sendInConversation({
                id: `ingest:${createClientMessageId()}`, // Survives a repeat pick; the colon keeps it from being followed as a chat turn.
                role: 'user',
                content: `📥 /ingest ${rowPayload}`,
                timestamp: new Date()
            }, chat => { void runIngest(payload, isUrl, chat, rowPayload !== payload); });
        }

        // Build user message content
        let messageContent = text;
        if (attachedFiles.length > 0) {
            messageContent += messageContent ? '\n\n' : '';
            messageContent += `📎 ${attachedFiles.length} file(s) attached: ${attachedFiles.map(f => f.name).join(', ')}`;
        }
        if (audioBlob) {
            messageContent += messageContent ? '\n\n' : '';
            messageContent += `🎤 Voice memo attached (${recordingTime}s)`;
        }

        const clientMessageId = createClientMessageId();
        const userMessage: Message = {
            id: clientMessageId,
            role: 'user',
            content: messageContent,
            timestamp: new Date(),
        };

        return sendInConversation(userMessage, chat => {
            noteChatSend(clientMessageId, 'sending', { conversationId: chat.id, preview: messageContent });
            clearAttachments(attachedPreviews);
            clearAudio();
            chatTurnSteps.begin(clientMessageId, chat.id, 'Sending your message…');
            void runSend(chat, text, clientMessageId, attachedFiles, audioBlob, 0, messageContent);
        });
    };

    const runIngest = async (payload: string, isUrl: boolean, chat: SendConversation, rowCutPayload: boolean) => {
        const { setMessages, finish } = chat;
        try {
            const authHeader = await getAuthHeader();
            const body = isUrl
                ? { url: payload, projectId: scopedProjectId }
                : { text: payload, projectId: scopedProjectId };

            const response = await fetch('/api/ingest', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', ...authHeader as any },
                body: JSON.stringify(body),
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Ingestion failed');
            }

            const cortexNote = data.cortex === 'dispatched' ? ' → Cortex 🧠' : '';
            setMessages(prev => [...prev, {
                role: 'system',
                content: `✅ Ingested: "${data.title}" — ${data.contentLength?.toLocaleString()} chars ${data.contentType ? `(${data.contentType}) ` : ''}saved to notes${cortexNote}`,
                timestamp: new Date()
            }]);
        } catch (err: any) {
            setMessages(prev => [...prev, {
                role: 'system',
                content: `❌ Ingestion failed: ${err.message}`,
                timestamp: new Date()
            }]);
            // The draft is gone by now, so the payload must stay readable somewhere.
            if (!chat.isVisible() || (rowCutPayload && chat.crossedSwitch())) {
                setUnconfirmedSends(prev => [...prev, {
                    id: createClientMessageId(),
                    heading: `An /ingest sent before you switched chats failed: ${err.message}`,
                    text: `/ingest ${payload}`,
                }]);
            }
        } finally {
            finish();
            setLoading(false);
        }
    };

    // Display commands: only a reply's structured `displayDirective` field (never its text) is run,
    // once, with the operator's own session; the PRAXIS_DISPLAY_REPORT turn that follows may carry
    // one follow-up directive (a stop for a cancelled start), no deeper. lib/presentation-chat-relay.
    const relayDisplayDirective = (chat: SendConversation, reply: { displayDirective?: unknown } | null | undefined, depth: number) => {
        const directive = readIssuedDirective(reply?.displayDirective);
        if (!directive || depth >= 2) return;
        void (async () => {
            const report = await executeDisplayDirective(directive);
            const reportText = renderDisplayReport(report);
            const reportMessageId = createClientMessageId();
            chat.setMessages(prev => [...prev, {
                id: reportMessageId,
                role: 'user',
                content: reportText,
                timestamp: new Date(),
                metadata: { displayReport: { action: directive.action, ok: report.ok, code: report.code } },
            }]);
            noteChatSend(reportMessageId, 'sending', { conversationId: chat.id, preview: `Display ${directive.action}: ${report.ok ? 'done' : report.code || 'failed'}` });
            chatTurnSteps.begin(reportMessageId, chat.id, 'Reporting the display result to Praxis…');
            setLoading(true);
            await runSend(chat, reportText, reportMessageId, [], null, depth + 1);
        })();
    };

    // `submitted` is the row's text: the message plus every attached file and voice memo.
    const runSend = async (chat: SendConversation, text: string, clientMessageId: string, filesToUpload: File[], currentAudioBlob: Blob | null, relayDepth = 0, submitted = text) => {
        const { setMessages } = chat;
        let receivedReply: Message | undefined;
        const reportFailure = (detail: string) => {
            noteChatSend(clientMessageId, 'failed', { detail });
            if (!chat.isVisible()) {
                setUnconfirmedSends(prev => [...prev, {
                    id: clientMessageId,
                    turnId: clientMessageId,
                    heading: 'A message sent before you switched chats could not be confirmed.',
                    text: submitted,
                }]);
            }
        };
        try {
            const authHeader = await getAuthHeader();

            // Inline text files and uploaded attachments; the voice clip as base64 (lib/chat-uploads).
            const { fileContents, uploadedAttachments } = await prepareChatFiles(filesToUpload);
            const base64Audio = await voiceClipBase64(currentAudioBlob);

            // Retry-on-connection-reset wrapper: Next.js Fast Refresh (HMR) full reloads
            // destroy all in-flight proxy connections, causing ECONNRESET / "socket hang up".
            // This is transient — the backend is still processing — so retry once.
            const MAX_RETRIES = 1;
            let lastError: Error | null = null;
            let response: Response | null = null;

            const canStreamPraxis = !base64Audio && uploadedAttachments.length === 0;
            const streamingAssistantId = canStreamPraxis ? createClientMessageId() : null;
            const requestBody = JSON.stringify({
                message: text || (currentAudioBlob ? "Voice recording attached" : `Please analyze the attached file(s): ${filesToUpload.map(f => f.name).join(', ')}`),
                mode: 'praxis',
                conversationId: chat.id ?? undefined,
                history: chat.history.slice(-10), // Last 10 messages for context
                projectId: scopedProjectId, // Send scope if available
                clientMessageId,
                files: fileContents, // Include text file contents for LLM context
                audio: base64Audio, // Include base64 voice recording if any
                attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined, // Uploaded file refs
                stream: canStreamPraxis,
                ...((open => open ? { displayContext: { document: open } } : {})(currentOpenDocument())), // the review on screen pins "this document"
            });
            if (!canStreamPraxis) turnSteps.followWithoutStream(clientMessageId);

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    await ensureLocalOperatorSession();
                    const localHeaders = localOperatorHeaders('/api/ai/chat');
                    response = await fetch(`/api/ai/chat?_cb=${Date.now()}`, {
                        method: 'POST',
                        credentials: 'include',
                        ...(Object.keys(localHeaders).length ? { redirect: 'error' as const } : {}),
                        headers: {
                            ...(canStreamPraxis ? { Accept: 'text/event-stream' } : {}),
                            ...authHeader as any,
                            ...localHeaders,
                        },
                        body: requestBody,
                    });
                    lastError = null;
                    break; // Success — exit retry loop
                } catch (fetchErr: any) {
                    lastError = fetchErr;
                    const isTransient = fetchErr?.message?.includes('fetch') ||
                                        fetchErr?.message?.includes('network') ||
                                        fetchErr?.message?.includes('Failed to fetch') ||
                                        fetchErr?.name === 'TypeError'; // Network errors in browsers are TypeErrors
                    if (isTransient && attempt < MAX_RETRIES) {
                        console.warn(`[Praxis Terminal] Connection reset (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in 2s...`);
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    throw fetchErr; // Not transient or out of retries
                }
            }

            if (!response) {
                throw lastError || new Error('No response received');
            }

            if (!response.ok) {
                // Try to extract a meaningful error + fallback response from the body
                let detail = `HTTP ${response.status}`;
                let fallbackResponse: string | null = null;
                try {
                    const errBody = await response.json();
                    if (errBody?.error) detail = errBody.error;
                    if (errBody?.response) fallbackResponse = errBody.response;
                } catch { /* ignore parse errors */ }
                // If the server included a user-facing response (e.g., Praxis proxy error),
                // show it instead of a raw error so the user gets context
                if (fallbackResponse) {
                    reportFailure(detail);
                    setMessages(prev => [...prev, {
                        role: 'assistant',
                        content: fallbackResponse,
                        timestamp: new Date(),
                    }]);
                    return;
                }
                throw new Error(`Server returned ${detail}`);
            }

            const responseContentType = response.headers.get('content-type') || '';
            if (streamingAssistantId && responseContentType.includes('text/event-stream')) {
                noteChatSend(clientMessageId,'working');

                // The reply's row appears with its first text, so no empty bubble sits above the steps.
                const finalEvent = await readPraxisEventStream(response, (delta) => {
                    turnSteps.noteStatus(clientMessageId, { message: 'Receiving the reply…' });
                    noteChatSend(clientMessageId,'replying');
                    setMessages(prev => prev.some(message => message.id === streamingAssistantId)
                        ? prev.map(message => message.id === streamingAssistantId
                            ? { ...message, content: `${message.content}${delta}` }
                            : message)
                        : [...prev, { id: streamingAssistantId, role: 'assistant', content: delta, timestamp: new Date() }]);
                }, status => turnSteps.noteStatus(clientMessageId, status), step => turnSteps.noteStep(clientMessageId, step));

                const finalMessage: Message = {
                    id: finalEvent?.assistantMessageId || streamingAssistantId,
                    role: 'assistant',
                    content: finalEvent?.response || 'No response received',
                    timestamp: new Date(),
                    voiceData: finalEvent?.voiceData,
                    ...(finalEvent?.suppressVoice === true ? { metadata: { suppressVoice: true } } : {}),
                };

                setMessages(prev => {
                    const withoutStreaming = prev.filter(message => message.id !== streamingAssistantId);
                    if (finalMessage.id && withoutStreaming.some(message => message.id === finalMessage.id)) {
                        return withoutStreaming;
                    }
                    return [...withoutStreaming, finalMessage];
                });
                turnSteps.fold(clientMessageId, messageKey(finalMessage), finalEvent);
                if (finalEvent?.morningKickoff) dispatchMorningKickoff();
                relayDisplayDirective(chat, finalEvent, relayDepth);
                noteReplyOutcome(clientMessageId, finalEvent);
                receivedReply = finalMessage;
                return;
            }

            const data = await response.json();

            const assistantMessage: Message = {
                id: data.assistantMessageId,
                role: 'assistant',
                content: data.response || 'No response received',
                timestamp: new Date(),
                voiceData: data.voiceData, // Attach any voice responses
                ...(data.suppressVoice === true ? { metadata: { suppressVoice: true } } : {}),
            };

            setMessages(prev => {
                if (assistantMessage.id && prev.some(message => message.id === assistantMessage.id)) {
                    return prev;
                }
                return [...prev, assistantMessage];
            });
            void turnSteps.foldAfterReply(clientMessageId, messageKey(assistantMessage));
            if (data.morningKickoff) dispatchMorningKickoff();
            relayDisplayDirective(chat, data, relayDepth);
            noteReplyOutcome(clientMessageId, data);
            receivedReply = assistantMessage;
        } catch (error: any) {
            reportFailure(error?.message || 'Reply could not be confirmed');
            turnSteps.followAfterLoss(clientMessageId);
            console.error('AI Chat error:', error);
            // Show a diagnostic error instead of the misleading "429 Rate Limit"
            const errMsg = error?.message || String(error);
            const isNetworkError = errMsg.includes('fetch') || errMsg.includes('network') || errMsg.includes('Failed to fetch') || error?.name === 'TypeError';
            const isRateLimit = errMsg.includes('429') || errMsg.includes('Too many');
            const userMessage = isRateLimit
                ? `The request reached a rate limit (429).\n\n[Check this saved turn](/chat/turns/${encodeURIComponent(clientMessageId)}) before sending it again.`
                : isNetworkError
                ? `Connection lost while waiting for Praxis.\n\n[Check this saved turn](/chat/turns/${encodeURIComponent(clientMessageId)}) before resending; its work may still be running.`
                : `Reply could not be confirmed: ${errMsg}\n\n[Check this saved turn](/chat/turns/${encodeURIComponent(clientMessageId)}) before sending it again.`;
            setMessages(prev => [...prev, {
                role: 'system',
                content: userMessage,
                timestamp: new Date(),
            }]);
        } finally {
            // Display-report follow-ups reuse the originating chat handle.
            if (relayDepth === 0) chat.finish(receivedReply);
            setLoading(false);
            turnSteps.release(clientMessageId);
        }
    };

    if (!isInline && !isOpen) return null;

    // Inline mode: frameless — the surrounding station panel (PraxisCore)
    // provides the chrome, so the terminal reads as its viewscreen rather
    // than a boxed widget.
    if (isInline) {
        return (
            <div className="h-full min-h-0 flex flex-col overflow-hidden">
                {renderTerminalContent()}
            </div>
        );
    }

    // Modal mode: full-screen overlay with backdrop
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Terminal Window */}
            <div className="relative z-10 w-full max-w-3xl max-h-[80vh] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl flex flex-col overflow-hidden">
                {renderTerminalContent()}
            </div>
        </div>
    );

    // --- Extracted inner content shared by both modes ---
    function renderTerminalContent() {
        return (<>
            {/* Fullscreen Plan Review Modal */}
            {reviewModalData && (
                <PlanReviewModal
                    data={reviewModalData}
                    onClose={() => setReviewModalData(null)}
                />
            )}
            {/* Header — modal keeps the full title bar. In the bridge viewscreen
                the host hides it (hideHeader) and hoists the controls into the
                PraxisCore station header, so the chat reads as one surface. */}
            {!hideHeader && (
                <TerminalHeader
                    isInline={isInline}
                    scopedProjectId={scopedProjectId}
                    showConversations={showConversations}
                    onToggleConversations={toggleConversations}
                    onNewConversation={async () => {
                        await startNewConversation();
                        console.log('[Praxis Terminal] New conversation started');
                    }}
                    onClose={onClose}
                />
            )}

            {/* Conversation History Panel */}
            {showConversations && (
                <ConversationList
                    isInline={isInline}
                    conversations={conversations}
                    conversationId={conversationId}
                    switchConversation={switchConversation}
                    deleteConversation={deleteConversation}
                    onPicked={() => setShowConversations(false)}
                />
            )}
            {/* Messages - with drag-and-drop support */}
            <div
                ref={messagesContainerRef}
                className={`custom-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2 sm:p-4 space-y-4 relative ${isDragging ? 'bg-cyan-500/10' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onScroll={handleMessagesScroll}
            >
                {/* Drag overlay */}
                {isDragging && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-900/80 border-2 border-dashed border-cyan-500 rounded-lg z-10">
                        <div className="text-center">
                            <Paperclip size={48} className="mx-auto text-cyan-400 mb-2" />
                            <p className="text-cyan-400 font-medium">Drop files here</p>
                            <p className="text-slate-500 text-sm">.txt, .md, .json, .py, .js, .ts, .yaml, .csv</p>
                        </div>
                    </div>
                )}
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center text-slate-500">
                        <MessageSquare size={48} className="mb-4 opacity-50" />
                        <p className="text-lg font-medium">{isInline ? 'Viewscreen standing by' : 'Welcome to Praxis Terminal'}</p>
                        <p className="text-sm mt-1">Your direct line to Praxis</p>
                        <p className="text-xs mt-4 opacity-70">
                            Try: "Build me a landing page for my SaaS" or "Create a new web-app called MyProject"
                        </p>
                        <div className="flex items-center gap-2 mt-3 px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
                            <Download size={12} className="text-cyan-400" />
                            <p className="text-[11px] text-cyan-400 font-mono">/ingest &lt;url&gt; — save articles directly</p>
                        </div>
                    </div>
                )}

                {/* Loading older messages indicator */}
                {isLoadingMore && (
                    <div className="flex items-center justify-center py-3">
                        <Loader2 size={16} className="text-cyan-500/60 animate-spin mr-2" />
                        <span className="text-xs text-slate-500">Loading older messages...</span>
                    </div>
                )}

                {/* Scroll-up hint when more messages exist (on the server, or
                    already loaded but trimmed out of the DOM window) */}
                {(hasMoreMessages || hiddenMessageCount > 0) && !isLoadingMore && messages.length > 0 && (
                    <div className="flex items-center justify-center py-2">
                        <span className="text-[11px] text-slate-600">↑ Scroll up for older messages</span>
                    </div>
                )}

                {visibleMessages.map((msg, i) => {
                    const foldedTurn = turnSteps.folded.get(messageKey(msg));
                    return (
                    <Fragment key={messageKey(msg)}>
                    {foldedTurn && <FoldedTurnSteps turn={foldedTurn} />}
                    <MessageRow
                        msg={msg}
                        rowKey={messageKey(msg)}
                        i={i}
                        isLast={i === visibleMessages.length - 1}
                        loading={loading}
                        expandedArtifact={expandedArtifact}
                        setExpandedArtifact={setExpandedArtifact}
                        setReviewModalData={setReviewModalData}
                        chatAudio={chatAudio}
                        toggleChatAudio={toggleChatAudio}
                        pauseChatAudio={pauseChatAudio}
                        voiceAudioRefs={voiceAudioRefs}
                        nowPlayingVoiceRef={nowPlayingVoiceRef}
                        dismissedVoice={dismissedVoice}
                        setDismissedVoice={setDismissedVoice}
                        listenedVoice={listenedVoice}
                        setListenedVoice={setListenedVoice}
                        getPlayedVoice={getPlayedVoice}
                        markVoicePlayed={markVoicePlayed}
                        playNextQueuedVoice={playNextQueuedVoice}
                        saveVoiceMemo={saveVoiceMemo}
                    />
                    </Fragment>
                    );
                })}

                <LiveTurnSteps conversationId={conversationId} busy={loading} onGrow={followBottom} />
                {turnSteps.unconfirmedTurn && <UnconfirmedTurnNotice turnId={turnSteps.unconfirmedTurn} />}

            </div>

            {/* Input */}
            {unconfirmedSends.map(failure => (
                <div key={failure.id} role="alert" className="shrink-0 rounded-md border border-amber-700/60 p-2 text-sm text-amber-200">
                    {failure.heading}
                    <p className="my-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{failure.text}</p>
                    {failure.turnId && <a className="mr-3 underline" href={`/chat/turns/${encodeURIComponent(failure.turnId)}`} target="_blank" rel="noreferrer">Check this saved turn</a>}
                    <button type="button" className="underline" onClick={() => setUnconfirmedSends(prev => prev.filter(item => item.id !== failure.id))}>Dismiss</button>
                </div>
            ))}
            <ComposerRow
                isInline={isInline}
                isOpen={isOpen}
                loading={loading}
                isDragging={isDragging}
                attachedFiles={attachedFiles}
                attachedPreviews={attachedPreviews}
                fileInputRef={fileInputRef}
                mediaInputRef={mediaInputRef}
                handleFileDrop={handleFileDrop}
                removeFile={removeFile}
                isRecording={isRecording}
                recordingTime={recordingTime}
                audioBlob={audioBlob}
                audioPreviewUrl={audioPreviewUrl}
                startRecording={startRecording}
                stopRecording={stopRecording}
                clearAudio={clearAudio}
                onSend={handleSend}
            />
        </>);
    }
});
