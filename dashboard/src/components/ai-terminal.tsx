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
 *   - the fullscreen plan review                      → components/chat/plan-review-modal
 *   - the conversation-history panel                  → components/chat/conversation-list
 *   - attachment chips                                → components/chat/attachment-chips
 *   - the draft textarea + send button                → components/chat/composer
 *   - voice queue / autoplay timing                   → hooks/use-chat-audio
 *   - attachment selection / preview / removal        → hooks/use-file-attachments
 *   - scrollback, DOM window, history panel state     → hooks/use-chat-history
 * See docs/ai-terminal-map.md for the full inventory.
 */

import { useState, forwardRef, useImperativeHandle } from "react";
import { Bot, Loader2, MessageSquare, Paperclip, Download } from "lucide-react";
import { useParams } from "next/navigation";

import { getAuthHeader } from "@/lib/auth";
import { useCortex } from "@/components/cortex-provider";
import { dispatchMorningKickoff } from "@/components/bridge/bridge-fx";
import { useChatAudio } from "@/hooks/use-chat-audio";
import { useChatHistory, messageKey } from "@/hooks/use-chat-history";
import { useFileAttachments } from "@/hooks/use-file-attachments";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { ComposerRow } from "@/components/chat/composer";
import { ConversationList } from "@/components/chat/conversation-list";
import { TerminalHeader } from "@/components/chat/terminal-header";
import { MessageRow } from "@/components/chat/message-row";
import { PlanReviewModal, type CritiqueFeedbackState } from "@/components/chat/plan-review-modal";
import type { Message, CortexArtifact } from "@/components/cortex-provider";

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

function createClientMessageId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readPraxisEventStream(
    response: Response,
    onDelta: (delta: string) => void,
): Promise<any> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Streaming response did not include a readable body');

    const decoder = new TextDecoder();
    let buffer = '';
    let finalEvent: any = null;

    const handleFrame = (frame: string) => {
        const data = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data || data === '[DONE]') return;

        const event = JSON.parse(data);
        if (event.type === 'delta' && typeof event.delta === 'string') {
            onDelta(event.delta);
        } else if (event.type === 'final') {
            finalEvent = event;
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        frames.forEach(handleFrame);
    }

    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
    return finalEvent;
}

export const AITerminal = forwardRef<AITerminalHandle, AITerminalProps>(function AITerminal({ isOpen = true, onClose, mode = 'modal', hideHeader = false }, ref) {
    const isInline = mode === 'inline';
    const { messages, setMessages, readyForReview, conversationId, conversations, startNewConversation, switchConversation, loadConversations, deleteConversation, isLoadingHistory, hasMoreMessages, isLoadingMore, loadMoreMessages, chatAudio, playChatAudio, toggleChatAudio, pauseChatAudio } = useCortex();
    // NOTE: the composer's draft text deliberately does NOT live here — it is
    // ChatComposer's own state, so keystrokes can't re-render the transcript.
    const [loading, setLoading] = useState(false);

    // Scrollback + DOM render window + the history panel toggle.
    const {
        messagesContainerRef,
        visibleMessages,
        hiddenMessageCount,
        handleMessagesScroll,
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
    // Inline critique feedback state
    // Keyed by messageKey(msg), NOT by array index: reveals, prepends and
    // window trims shift indices, and this state must stay glued to its row.
    const [critiqueFeedback, setCritiqueFeedback] = useState<CritiqueFeedbackState>({
        messageKey: null,
        text: '',
        loading: false
    });
    // Approval loading state
    const [approvalLoading, setApprovalLoading] = useState<string | null>(null);
    // readyForReview (which thread_ids are ready for human review after voting) comes from useCortex()
    // Track expanded artifact index for full content viewing (council reviews)
    const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
    // Fullscreen plan review modal state
    const [reviewModalData, setReviewModalData] = useState<{ artifact: CortexArtifact; messageKey: string } | null>(null);

    const params = useParams();
    const scopedProjectId = typeof params?.id === 'string' ? params.id : null;

    // Message persistence, the Socket.IO connection and artifact handling are
    // all owned by CortexProvider; praxis is the only mode.

    // Synchronous dispatch decision for the composer: returns true when the
    // message was accepted (the composer then clears its input), false when
    // nothing was consumed (empty draft, mid-request, /ingest with no
    // payload). The slow work continues in runIngest/runSend below.
    const handleSend = (rawText: string): boolean => {
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
            setMessages(prev => [...prev, {
                role: 'user',
                content: `📥 /ingest ${isUrl ? payload : payload.substring(0, 80) + (payload.length > 80 ? '...' : '')}`,
                timestamp: new Date()
            }]);
            setLoading(true);
            void runIngest(payload, isUrl);
            return true;
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

        setMessages(prev => [...prev, userMessage]);
        const filesToUpload = [...attachedFiles];
        clearAttachments(); // detaches the files and revokes their preview URLs
        const currentAudioBlob = audioBlob;
        clearAudio(); // Reset recording UI
        setLoading(true);
        void runSend(text, clientMessageId, filesToUpload, currentAudioBlob);
        return true;
    };

    const runIngest = async (payload: string, isUrl: boolean) => {
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
        } finally {
            setLoading(false);
        }
    };

    const runSend = async (text: string, clientMessageId: string, filesToUpload: File[], currentAudioBlob: Blob | null) => {
        try {
            const authHeader = await getAuthHeader();

            // Upload files to the Nexus file endpoint
            let fileContents: { name: string; content: string; type: string }[] = [];
            let uploadedAttachments: { fileId: string; url: string; mimeType: string; originalName: string; size: number }[] = [];
            if (filesToUpload.length > 0) {
                const authHeader = await getAuthHeader();
                // Upload binary files (images, audio, etc.) to the file endpoint
                // and read text files inline for context
                const uploadPromises = filesToUpload.map(async (file) => {
                    const isTextFile = file.type.startsWith('text/') || /\.(txt|md|json|py|js|ts|tsx|jsx|yaml|yml|csv|xml|html|css|sql|sh|bat|log|cfg|ini|toml|env)$/i.test(file.name);
                    
                    if (isTextFile && file.size < 512 * 1024) {
                        // Small text files: read inline for LLM context
                        const content = await file.text();
                        fileContents.push({ name: file.name, content, type: file.type || 'text/plain' });
                    }

                    // All files: upload to file storage for persistence and serving
                    try {
                        const formData = new FormData();
                        formData.append('file', file);
                        const uploadRes = await fetch('/api/chat/files/upload', {
                            method: 'POST',
                            credentials: 'include',
                            body: formData,
                        });
                        if (uploadRes.ok) {
                            const data = await uploadRes.json();
                            uploadedAttachments.push(data);
                        } else {
                            console.error(`[Praxis Terminal] File upload failed for ${file.name}:`, await uploadRes.text());
                        }
                    } catch (err) {
                        console.error(`[Praxis Terminal] File upload error for ${file.name}:`, err);
                    }
                });
                await Promise.all(uploadPromises);
            }

            // Read audio blob to base64
            let base64Audio = undefined;
            if (currentAudioBlob) {
                // We use Buffer in the browser via a polyfill if needed, but arrayBuffer -> base64 can be done via btoa:
                const buffer = await currentAudioBlob.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = '';
                // Chunked processing to avoid call stack limits on huge arrays
                const CHUNK_SIZE = 32768;
                for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
                  binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SIZE)));
                }
                base64Audio = btoa(binary);
            }

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
                history: messages.slice(-10), // Last 10 messages for context
                projectId: scopedProjectId, // Send scope if available
                clientMessageId,
                files: fileContents, // Include text file contents for LLM context
                audio: base64Audio, // Include base64 voice recording if any
                attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined, // Uploaded file refs
                stream: canStreamPraxis,
            });

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    response = await fetch(`/api/ai/chat?_cb=${Date.now()}`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            ...(canStreamPraxis ? { Accept: 'text/event-stream' } : {}),
                            ...authHeader as any,
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
                setMessages(prev => [...prev, {
                    id: streamingAssistantId,
                    role: 'assistant',
                    content: '',
                    timestamp: new Date(),
                }]);

                const finalEvent = await readPraxisEventStream(response, (delta) => {
                    setMessages(prev => prev.map(message =>
                        message.id === streamingAssistantId
                            ? { ...message, content: `${message.content}${delta}` }
                            : message
                    ));
                });

                const finalMessage: Message = {
                    id: finalEvent?.assistantMessageId || streamingAssistantId,
                    role: 'assistant',
                    content: finalEvent?.response || 'No response received',
                    timestamp: new Date(),
                    voiceData: finalEvent?.voiceData,
                };

                setMessages(prev => {
                    const withoutStreaming = prev.filter(message => message.id !== streamingAssistantId);
                    if (finalMessage.id && withoutStreaming.some(message => message.id === finalMessage.id)) {
                        return withoutStreaming;
                    }
                    return [...withoutStreaming, finalMessage];
                });
                if (finalEvent?.morningKickoff) dispatchMorningKickoff();
                return;
            }

            const data = await response.json();

            const assistantMessage: Message = {
                id: data.assistantMessageId,
                role: 'assistant',
                content: data.response || 'No response received',
                timestamp: new Date(),
                voiceData: data.voiceData, // Attach any voice responses
            };

            setMessages(prev => {
                if (assistantMessage.id && prev.some(message => message.id === assistantMessage.id)) {
                    return prev;
                }
                return [...prev, assistantMessage];
            });
            if (data.morningKickoff) dispatchMorningKickoff();
        } catch (error: any) {
            console.error('AI Chat error:', error);
            // Show a diagnostic error instead of the misleading "429 Rate Limit"
            const errMsg = error?.message || String(error);
            const isNetworkError = errMsg.includes('fetch') || errMsg.includes('network') || errMsg.includes('Failed to fetch') || error?.name === 'TypeError';
            const isRateLimit = errMsg.includes('429') || errMsg.includes('Too many');
            const userMessage = isRateLimit
                ? 'Rate limit exceeded (429). Your API quota may be exhausted — try again in a few minutes.'
                : isNetworkError
                ? 'Connection lost — the server may be restarting. Please try again in a moment.'
                : `Error: ${errMsg}`;
            setMessages(prev => [...prev, {
                role: 'system',
                content: userMessage,
                timestamp: new Date(),
            }]);
        } finally {
            setLoading(false);
        }
    };

    if (!isInline && !isOpen) return null;

    // Inline mode: frameless — the surrounding station panel (PraxisCore)
    // provides the chrome, so the terminal reads as its viewscreen rather
    // than a boxed widget.
    if (isInline) {
        return (
            <div className="h-full flex flex-col overflow-hidden">
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
                    readyForReview={readyForReview}
                    critiqueFeedback={critiqueFeedback}
                    setCritiqueFeedback={setCritiqueFeedback}
                    approvalLoading={approvalLoading}
                    setApprovalLoading={setApprovalLoading}
                    setMessages={setMessages}
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
                className={`custom-scrollbar flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4 relative ${isDragging ? 'bg-cyan-500/10' : ''}`}
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

                {visibleMessages.map((msg, i) => (
                    <MessageRow
                        key={messageKey(msg)}
                        msg={msg}
                        rowKey={messageKey(msg)}
                        i={i}
                        isLast={i === visibleMessages.length - 1}
                        loading={loading}
                        readyForReview={readyForReview}
                        expandedArtifact={expandedArtifact}
                        setExpandedArtifact={setExpandedArtifact}
                        setReviewModalData={setReviewModalData}
                        critiqueFeedback={critiqueFeedback}
                        setCritiqueFeedback={setCritiqueFeedback}
                        approvalLoading={approvalLoading}
                        setApprovalLoading={setApprovalLoading}
                        setMessages={setMessages}
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
                ))}

                {loading && (
                    <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center">
                            <Loader2 size={16} className="animate-spin" />
                        </div>
                        <div className="bg-slate-800 rounded-lg px-4 py-2">
                            <div className="flex gap-1">
                                <span className="w-2 h-2 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                                <span className="w-2 h-2 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                                <span className="w-2 h-2 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                        </div>
                    </div>
                )}

            </div>

            {/* Input */}
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
