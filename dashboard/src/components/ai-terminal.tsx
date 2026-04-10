"use client"

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Bot, User, Settings2, Loader2, X, MessageSquare, Lock, Trash2, Paperclip, FileText, XCircle, RotateCcw, Maximize2, Mic, Square, Plus, History, ChevronRight, Download, Image, Film, Music, FileArchive, Volume2, Save } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useParams } from "next/navigation";

import { getAuthHeader } from "@/lib/auth";
import { normalizeMarkdown } from "@/lib/normalizeMarkdown";
import { useCortex } from "@/components/cortex-provider";
import type { Message, CortexArtifact, PlanDraftData, CompiledPlanData, ChatResponseData, LineCommentData, VoteSummaryData, StatusUpdateData, UnknownArtifactData } from "@/components/cortex-provider";

// Types are now imported from cortex-provider.tsx

interface AITerminalProps {
    isOpen?: boolean;
    onClose?: () => void;
    mode?: 'modal' | 'inline';
}

// Model configuration following "Configuration-over-Identity" pattern
// See: AI Model ID API Research for detailed specifications
interface ModelConfig {
    id: string;           // Internal identifier for UI
    apiModelId: string;   // Actual API model ID to send
    name: string;         // Display name
    provider: 'Google' | 'Anthropic' | 'OpenAI';
    isThinking?: boolean; // Whether this is a "thinking" variant
    parameters?: {
        // Google Gemini thinking config
        thinking_config?: {
            thinking_level?: 'LOW' | 'HIGH';
        };
        thinking_budget?: number; // For Gemini 2.5 Flash
        // Anthropic thinking config
        thinking?: {
            type: 'enabled';
            budget_tokens: number;
        };
        // OpenAI reasoning config
        reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
    };
    limits?: {
        maxInputTokens: number;
        maxOutputTokens: number;
    };
}

const MODES = [
    { id: 'agent', name: 'Agent', description: 'Execute actions on projects' },
    { id: 'chat', name: 'Chat', description: 'Natural conversation' },
    { id: 'praxis', name: 'Praxis', description: 'Your personal AI supervisor' },
];

export function AITerminal({ isOpen = true, onClose, mode = 'modal' }: AITerminalProps) {
    const isInline = mode === 'inline';
    const { messages, setMessages, readyForReview, setReadyForReview, conversationId, conversations, startNewConversation, switchConversation, loadConversations, deleteConversation, isLoadingHistory, hasMoreMessages, isLoadingMore, loadMoreMessages } = useCortex();
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [availableModels, setAvailableModels] = useState<ModelConfig[]>([]);
    const [selectedModel, setSelectedModel] = useState<ModelConfig | null>(null);
    const [selectedMode, setSelectedMode] = useState(MODES[2]);
    const [showSettings, setShowSettings] = useState(false);
    const [pendingArtifact, setPendingArtifact] = useState<CortexArtifact | null>(null);
    const [attachedFiles, setAttachedFiles] = useState<File[]>([]); // File upload state
    const [attachedPreviews, setAttachedPreviews] = useState<{ name: string; size: number; type: string; previewUrl?: string }[]>([]); // Rich preview state
    const [isDragging, setIsDragging] = useState(false); // Drag-and-drop state
    const [showConversations, setShowConversations] = useState(false); // Conversation history panel
    const dragCounter = useRef(0); // Counter to properly track drag enter/leave across child elements
    // Inline critique feedback state
    const [critiqueFeedback, setCritiqueFeedback] = useState<{ messageIndex: number | null; text: string; loading: boolean }>({
        messageIndex: null,
        text: '',
        loading: false
    });
    // Approval loading state
    const [approvalLoading, setApprovalLoading] = useState<number | null>(null);
    // Track which thread_ids are ready for human review (after voting completes)
    // readyForReview is now provided by CortexProvider via useCortex()
    // Track expanded artifact index for full content viewing (council reviews)
    const [expandedArtifact, setExpandedArtifact] = useState<number | null>(null);
    // Fullscreen plan review modal state
    const [reviewModalData, setReviewModalData] = useState<{ artifact: CortexArtifact; messageIndex: number } | null>(null);
    
    // Voice recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);

    // Voice message dismiss/listened tracking
    // Keys are "msgIdx-voiceIdx", values track state
    const [dismissedVoice, setDismissedVoice] = useState<Set<string>>(new Set());
    const [listenedVoice, setListenedVoice] = useState<Set<string>>(new Set());

    // Save voice memo to disk (browser download)
    const saveVoiceMemo = useCallback((audio: string, mimeType: string, msgIndex: number, voiceIndex: number) => {
        const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'mp3';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `praxis-voice-${timestamp}.${ext}`;
        const byteChars = atob(audio);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
            byteNumbers[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null); // Hidden file input (all types)
    const mediaInputRef = useRef<HTMLInputElement>(null); // Hidden media input (camera/gallery)
    const params = useParams();
    const scopedProjectId = typeof params?.id === 'string' ? params.id : null;

    // Message persistence and rehydration are now handled by CortexProvider

    // Praxis is now the default mode everywhere (no remote-only override needed)

    // Track previous message count to detect newly prepended messages
    const prevMessageCountRef = useRef(messages.length);
    const prevScrollHeightRef = useRef(0);

    // Auto-scroll on new messages appended to bottom (not when prepending older ones)
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        const newCount = messages.length;
        const prevCount = prevMessageCountRef.current;
        if (newCount > prevCount) {
            // Check if messages were prepended (older messages loaded) or appended (new messages)
            const wereMessagesPrepended = prevCount > 0 && prevScrollHeightRef.current > 0;
            if (wereMessagesPrepended && container.scrollTop < 100) {
                // Messages were prepended — preserve scroll position
                const newScrollHeight = container.scrollHeight;
                const scrollDelta = newScrollHeight - prevScrollHeightRef.current;
                container.scrollTop = scrollDelta;
            } else {
                // Messages were appended — scroll to bottom
                container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            }
        }
        prevMessageCountRef.current = newCount;
        prevScrollHeightRef.current = container.scrollHeight;
    }, [messages]);

    // Scroll-to-top detection for loading older messages
    const handleMessagesScroll = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        // When scrolled near the top (within 50px), load more
        if (container.scrollTop < 50 && hasMoreMessages && !isLoadingMore) {
            prevScrollHeightRef.current = container.scrollHeight;
            loadMoreMessages();
        }
    }, [hasMoreMessages, isLoadingMore, loadMoreMessages]);

    // Fetch available models from the model discovery API
    useEffect(() => {
        let attempts = 0;
        const maxAttempts = 3;

        const fetchModels = () => {
            fetch(`/api/models?_cb=${Date.now()}`, { credentials: 'include' })
                .then(res => res.json())
                .then(data => {
                    if (data.models && data.models.length > 0) {
                        setAvailableModels(data.models);
                        setSelectedModel(data.models[0]);
                        console.log(`[Praxis Terminal] Loaded ${data.models.length} models from discovery API`);
                    } else if (++attempts < maxAttempts) {
                        // Discovery may still be running — retry after 2s
                        setTimeout(fetchModels, 2000);
                    }
                })
                .catch(err => {
                    console.warn('[Praxis Terminal] Model discovery unavailable:', err.message);
                    if (++attempts < maxAttempts) {
                        setTimeout(fetchModels, 2000);
                    }
                });
        };

        fetchModels();
    }, []);

    // Focus input when terminal opens (modal only — inline shouldn't steal focus on page load)
    useEffect(() => {
        if (isOpen && !isInline && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen, isInline]);

    // Socket.IO connection and artifact handling are now managed by CortexProvider

    // File handling functions
    const handleFileDrop = useCallback((files: FileList | File[]) => {
        const fileArray = Array.from(files);
        // Accept all file types up to 25 MB each
        const MAX_SIZE = 25 * 1024 * 1024;
        const validFiles = fileArray.filter(f => f.size <= MAX_SIZE);

        if (validFiles.length > 0) {
            setAttachedFiles(prev => [...prev, ...validFiles].slice(0, 5)); // Max 5 files

            // Generate preview metadata for chips
            const previews = validFiles.map(f => {
                const preview: { name: string; size: number; type: string; previewUrl?: string } = {
                    name: f.name,
                    size: f.size,
                    type: f.type,
                };
                // Generate image thumbnails
                if (f.type.startsWith('image/')) {
                    preview.previewUrl = URL.createObjectURL(f);
                }
                return preview;
            });
            setAttachedPreviews(prev => [...prev, ...previews].slice(0, 5));
            console.log('[Praxis Terminal] Files attached:', validFiles.map(f => `${f.name} (${(f.size / 1024).toFixed(0)} KB)`));
        }
    }, []);

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragging(true);
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsDragging(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setIsDragging(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileDrop(e.dataTransfer.files);
        }
    }, [handleFileDrop]);

    const removeFile = useCallback((index: number) => {
        setAttachedFiles(prev => prev.filter((_, i) => i !== index));
        setAttachedPreviews(prev => {
            const removed = prev[index];
            if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
            return prev.filter((_, i) => i !== index);
        });
    }, []);

    // Audio recording functions
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                setAudioBlob(blob);
                setAudioPreviewUrl(URL.createObjectURL(blob));
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            setIsRecording(true);
            setRecordingTime(0);
            recordingTimerRef.current = setInterval(() => {
                setRecordingTime(prev => prev + 1);
            }, 1000);
        } catch (err) {
            console.error("Error accessing microphone:", err);
            setMessages(prev => [...prev, {
                role: 'system',
                content: 'Error: Could not access microphone. Please check permissions.',
                timestamp: new Date()
            }]);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            if (recordingTimerRef.current) {
                clearInterval(recordingTimerRef.current);
            }
        }
    };

    const clearAudio = () => {
        setAudioBlob(null);
        if (audioPreviewUrl) {
            URL.revokeObjectURL(audioPreviewUrl);
            setAudioPreviewUrl(null);
        }
    };

    const handleSend = async () => {
        if ((!input.trim() && attachedFiles.length === 0 && !audioBlob) || loading || !selectedModel) return;

        // ---------------------------------------------------------------
        // SLASH COMMAND: /ingest <url_or_text>
        // Directly ingests a link or text without invoking Praxis
        // ---------------------------------------------------------------
        const trimmed = input.trim();
        if (trimmed.startsWith('/ingest ') || trimmed === '/ingest') {
            const payload = trimmed.replace(/^\/ingest\s*/, '').trim();
            if (!payload) {
                setMessages(prev => [...prev, {
                    role: 'system',
                    content: '⚠️ Usage: /ingest <url> or /ingest <text to save>',
                    timestamp: new Date()
                }]);
                return;
            }

            // Show user message
            const isUrl = /^https?:\/\//i.test(payload);
            setMessages(prev => [...prev, {
                role: 'user',
                content: `📥 /ingest ${isUrl ? payload : payload.substring(0, 80) + (payload.length > 80 ? '...' : '')}`,
                timestamp: new Date()
            }]);
            setInput('');
            setLoading(true);

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
            return; // Don't continue to normal chat flow
        }

        // Build user message content
        let messageContent = input.trim();
        if (attachedFiles.length > 0) {
            messageContent += messageContent ? '\n\n' : '';
            messageContent += `📎 ${attachedFiles.length} file(s) attached: ${attachedFiles.map(f => f.name).join(', ')}`;
        }
        if (audioBlob) {
            messageContent += messageContent ? '\n\n' : '';
            messageContent += `🎤 Voice memo attached (${recordingTime}s)`;
        }

        const userMessage: Message = {
            role: 'user',
            content: messageContent,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInput("");
        const filesToUpload = [...attachedFiles];
        setAttachedFiles([]);
        // Clean up preview URLs
        attachedPreviews.forEach(p => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
        setAttachedPreviews([]);
        const currentAudioBlob = audioBlob;
        clearAudio(); // Reset recording UI
        setLoading(true);

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
                const CHUNK_SIZE = 0x8000;
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

            const requestBody = JSON.stringify({
                message: input.trim() || (currentAudioBlob ? "Voice recording attached" : `Please analyze the attached file(s): ${filesToUpload.map(f => f.name).join(', ')}`),
                // Send full model configuration for proper routing
                modelConfig: {
                    id: selectedModel.id,
                    apiModelId: selectedModel.apiModelId,
                    provider: selectedModel.provider,
                    isThinking: selectedModel.isThinking || false,
                    parameters: selectedModel.parameters || {},
                },
                mode: selectedMode.id,
                history: messages.slice(-10), // Last 10 messages for context
                projectId: scopedProjectId, // Send scope if available
                files: fileContents, // Include text file contents for LLM context
                audio: base64Audio, // Include base64 voice recording if any
                attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined, // Uploaded file refs
            });

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    response = await fetch(`/api/ai/chat?_cb=${Date.now()}`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
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

            const data = await response.json();

            const assistantMessage: Message = {
                role: 'assistant',
                content: data.response || 'No response received',
                timestamp: new Date(),
                voiceData: data.voiceData, // Attach any voice responses
            };

            setMessages(prev => [...prev, assistantMessage]);
        } catch (error: any) {
            console.error('AI Chat error:', error);
            // In Agent mode, artifacts stream via WebSocket — the HTTP response is just a summary.
            // Don't show a scary error if the pipeline is actually working via Glass Box.
            if (selectedMode.id === 'agent') {
                console.warn('[Praxis Terminal] HTTP response failed in Agent mode — artifacts may still be streaming via WebSocket.');
                // Only show error if no artifacts have arrived (i.e., Cortex is truly down)
                const hasRecentArtifact = messages.some(m =>
                    m.artifact && m.timestamp && (Date.now() - new Date(m.timestamp).getTime()) < 120000
                );
                if (!hasRecentArtifact) {
                    setMessages(prev => [...prev, {
                        role: 'system',
                        content: '⚠️ Cortex Brain is processing your request. Artifacts will appear as they are produced.',
                        timestamp: new Date(),
                    }]);
                }
            } else {
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
            }
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (!isInline && !isOpen) return null;

    // Inline mode: render directly as a block element filling its parent
    if (isInline) {
        return (
            <div className="h-full rounded-xl border border-slate-700 bg-slate-900 shadow-2xl flex flex-col overflow-hidden">
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
            {reviewModalData && (() => {
                const planData = reviewModalData.artifact.data as PlanDraftData;
                const modalMsgIndex = reviewModalData.messageIndex;
                const isRevised = reviewModalData.artifact.type?.trim().toUpperCase() === 'PLAN_REVISED';
                const threadId = (planData as any)?.thread_id;
                const showActions = (planData as any)?.is_final || readyForReview.has(threadId);
                return (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center">
                        {/* Backdrop */}
                        <div
                            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                            onClick={() => setReviewModalData(null)}
                        />
                        {/* Modal */}
                        <div className="relative z-10 w-[92vw] max-w-5xl h-[90vh] rounded-2xl border border-slate-600 bg-slate-900 shadow-2xl flex flex-col overflow-hidden">
                            {/* Modal Header */}
                            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 bg-slate-800/60 flex-shrink-0">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className={`p-2 rounded-lg ${isRevised ? 'bg-emerald-500/20' : 'bg-blue-500/20'}`}>
                                        <FileText size={20} className={isRevised ? 'text-emerald-400' : 'text-blue-400'} />
                                    </div>
                                    <div className="min-w-0">
                                        <h2 className="text-lg font-bold text-white truncate">
                                            {isRevised ? '✅ Final for Review' : 'Draft Plan'} — {planData.title}
                                        </h2>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isRevised
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                                                }`}>v{planData.version || 1}</span>
                                            <span className="text-xs text-slate-500">Markdown Plan</span>
                                        </div>
                                    </div>
                                </div>
                                <button
                                    onClick={() => setReviewModalData(null)}
                                    className="p-2 hover:bg-slate-700 rounded-lg transition-colors flex-shrink-0"
                                >
                                    <X size={20} className="text-slate-400" />
                                </button>
                            </div>

                            {/* Modal Body — Rendered Markdown */}
                            <div className="flex-1 overflow-y-auto px-8 py-6 min-h-0">
                                <div className="prose prose-invert prose-sm max-w-none
                                    prose-headings:text-slate-100 prose-headings:font-bold
                                    prose-h1:text-2xl prose-h1:border-b prose-h1:border-slate-600/50 prose-h1:pb-3 prose-h1:mb-6
                                    prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:text-slate-50
                                    prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3 prose-h3:text-cyan-300
                                    prose-h4:text-base prose-h4:mt-6 prose-h4:mb-2 prose-h4:text-slate-200
                                    prose-p:text-slate-300 prose-p:leading-relaxed prose-p:my-3
                                    prose-li:text-slate-300 prose-li:my-1 prose-li:leading-relaxed
                                    prose-ul:my-3 prose-ol:my-3
                                    prose-strong:text-white prose-strong:font-semibold
                                    prose-em:text-slate-200
                                    prose-code:text-cyan-300 prose-code:bg-slate-800/80 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono
                                    prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
                                    prose-hr:border-slate-700/50 prose-hr:my-8
                                    prose-blockquote:border-l-cyan-500/70 prose-blockquote:bg-slate-800/30 prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:rounded-r-lg prose-blockquote:italic prose-blockquote:text-slate-400
                                    prose-table:text-sm prose-th:text-slate-200 prose-th:bg-slate-800/50 prose-th:px-4 prose-th:py-2 prose-td:text-slate-300 prose-td:px-4 prose-td:py-2 prose-td:border-slate-700/50
                                ">
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={{
                                            code({ node, inline, className, children, ...props }: any) {
                                                const match = /language-(\w+)/.exec(className || '');
                                                return !inline && match ? (
                                                    <SyntaxHighlighter
                                                        style={oneDark as any}
                                                        language={match[1]}
                                                        PreTag="div"
                                                        className="rounded-lg !bg-slate-950 !text-sm"
                                                        {...props}
                                                    >
                                                        {String(children).replace(/\n$/, '')}
                                                    </SyntaxHighlighter>
                                                ) : (
                                                    <code className={className} {...props}>{children}</code>
                                                );
                                            },
                                        }}
                                    >
                                        {normalizeMarkdown(planData.markdown) || ''}
                                    </ReactMarkdown>
                                </div>

                                {/* Rationale — shown at bottom after reading the plan */}
                                {planData.rationale && (
                                    <div className="mt-8 px-5 py-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
                                        <div className="flex items-center gap-2 mb-3">
                                            <div className="w-1 h-5 rounded-full bg-amber-400/60" />
                                            <span className="text-sm font-semibold text-amber-400 uppercase tracking-wider">Council Rationale</span>
                                        </div>
                                        <div className="prose prose-invert prose-sm max-w-none
                                            prose-p:text-amber-200/90 prose-p:leading-relaxed prose-p:my-2
                                            prose-strong:text-amber-300 prose-strong:font-semibold
                                            prose-li:text-amber-200/90 prose-li:my-1
                                            prose-ol:my-2 prose-ul:my-2
                                            prose-code:text-amber-300 prose-code:bg-amber-900/30 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
                                        ">
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                {planData.rationale}
                                            </ReactMarkdown>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Modal Footer — Actions */}
                            {showActions && (
                                <div className="flex-shrink-0 px-6 py-4 border-t border-slate-700 bg-slate-800/60">
                                    {critiqueFeedback.messageIndex === modalMsgIndex ? (
                                        <div className="space-y-3">
                                            <label className="block text-sm font-medium text-red-300">Revision Feedback</label>
                                            <textarea
                                                value={critiqueFeedback.text}
                                                onChange={(e) => setCritiqueFeedback(prev => ({ ...prev, text: e.target.value }))}
                                                placeholder="Describe the changes you'd like to see..."
                                                className="w-full h-28 bg-slate-950 border border-slate-600 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-red-500 focus:outline-none resize-none"
                                                autoFocus
                                                disabled={critiqueFeedback.loading}
                                            />
                                            <div className="flex gap-3 justify-end">
                                                <button
                                                    onClick={() => setCritiqueFeedback({ messageIndex: null, text: '', loading: false })}
                                                    className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors"
                                                    disabled={critiqueFeedback.loading}
                                                >Cancel</button>
                                                <button
                                                    onClick={async () => {
                                                        if (!critiqueFeedback.text.trim()) return;
                                                        setCritiqueFeedback(prev => ({ ...prev, loading: true }));
                                                        const formData = new FormData();
                                                        formData.append('thread_id', threadId || 'unknown');
                                                        formData.append('action', 'REJECT');
                                                        formData.append('comment', critiqueFeedback.text);
                                                        try {
                                                            const response = await fetch(`/api/terminal/interact`, {
                                                                method: 'POST',
                                                                body: formData
                                                            });
                                                            if (!response.ok) throw new Error('Failed to submit feedback');
                                                            setMessages(prev => [...prev, {
                                                                role: 'user',
                                                                content: `🔄 Requested revision: ${critiqueFeedback.text}`,
                                                                timestamp: new Date()
                                                            }]);
                                                            setCritiqueFeedback({ messageIndex: null, text: '', loading: false });
                                                            setReviewModalData(null);
                                                        } catch (e) {
                                                            console.error('Critique failed:', e);
                                                            setMessages(prev => [...prev, {
                                                                role: 'system',
                                                                content: '❌ Failed to submit feedback. Please try again.',
                                                                timestamp: new Date()
                                                            }]);
                                                            setCritiqueFeedback(prev => ({ ...prev, loading: false }));
                                                        }
                                                    }}
                                                    disabled={critiqueFeedback.loading || !critiqueFeedback.text.trim()}
                                                    className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                                >
                                                    {critiqueFeedback.loading && <Loader2 size={14} className="animate-spin" />}
                                                    {critiqueFeedback.loading ? 'Submitting...' : 'Submit Feedback'}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex gap-3">
                                            <button
                                                onClick={() => setCritiqueFeedback({ messageIndex: modalMsgIndex, text: '', loading: false })}
                                                className="flex-1 py-3 px-4 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 flex items-center justify-center gap-2 transition-colors font-medium"
                                                disabled={approvalLoading === modalMsgIndex}
                                            >
                                                <XCircle size={18} /> Request Revisions
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    if (!threadId || threadId === 'unknown') {
                                                        setMessages(prev => [...prev, {
                                                            role: 'system',
                                                            content: '❌ Cannot approve: No valid thread ID found. Please try again.',
                                                            timestamp: new Date()
                                                        }]);
                                                        return;
                                                    }
                                                    setApprovalLoading(modalMsgIndex);
                                                    const formData = new FormData();
                                                    formData.append('thread_id', threadId);
                                                    formData.append('action', 'APPROVE');
                                                    formData.append('comment', 'Plan approved by user');
                                                    try {
                                                        const response = await fetch(`/api/terminal/interact`, {
                                                            method: 'POST',
                                                            body: formData
                                                        });
                                                        if (!response.ok) throw new Error(`Server returned ${response.status}`);
                                                        setMessages(prev => [...prev, {
                                                            role: 'user',
                                                            content: '✅ Plan Approved - Execution starting...',
                                                            timestamp: new Date()
                                                        }]);
                                                        setReviewModalData(null);
                                                    } catch (e) {
                                                        console.error('Approve failed:', e);
                                                        setMessages(prev => [...prev, {
                                                            role: 'system',
                                                            content: `❌ Approval failed: ${e instanceof Error ? e.message : 'Unknown error'}. Please try again.`,
                                                            timestamp: new Date()
                                                        }]);
                                                    } finally {
                                                        setApprovalLoading(null);
                                                    }
                                                }}
                                                className="flex-1 py-3 px-4 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 flex items-center justify-center gap-2 transition-colors font-medium"
                                                disabled={approvalLoading === modalMsgIndex}
                                            >
                                                {approvalLoading === modalMsgIndex && <Loader2 size={14} className="animate-spin" />}
                                                {approvalLoading === modalMsgIndex ? 'Approving...' : '✅ Approve Plan'}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                );
            })()}

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/50">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Bot size={20} className="text-cyan-400" />
                        <span className="font-bold text-white">Praxis Terminal</span>
                        {scopedProjectId && (
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                <Lock size={10} />
                                <span className="text-[10px] uppercase font-bold tracking-wider">Scoped: {scopedProjectId}</span>
                            </div>
                        )}
                    </div>
                    {selectedModel ? (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${selectedModel.isThinking
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-cyan-500/20 text-cyan-400'}`}>
                            {selectedModel.isThinking && '⚡ '}{selectedModel.name}
                        </span>
                    ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-500/20 text-slate-400 animate-pulse">
                            Loading models…
                        </span>
                    )}
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
                        {selectedMode.name}
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={async () => {
                            await startNewConversation();
                            console.log('[Praxis Terminal] New conversation started');
                        }}
                        className="p-1.5 rounded text-slate-400 hover:text-emerald-400 hover:bg-slate-700 transition-colors"
                        title="New Conversation"
                    >
                        <Plus size={18} />
                    </button>
                    <button
                        onClick={() => {
                            setShowConversations(!showConversations);
                            if (!showConversations) loadConversations();
                        }}
                        className={`p-1.5 rounded transition-colors ${showConversations ? 'text-cyan-400 bg-slate-700' : 'text-slate-400 hover:text-cyan-400 hover:bg-slate-700'}`}
                        title="Conversation History"
                    >
                        <History size={18} />
                    </button>
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                    >
                        <Settings2 size={18} />
                    </button>
                    {!isInline && onClose && (
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>
            </div>

            {/* Settings Panel */}
            {showSettings && (
                <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/30 space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs text-slate-400 mb-1">Model</label>
                            <select
                                value={selectedModel?.id || ''}
                                onChange={(e) => setSelectedModel(availableModels.find((m: ModelConfig) => m.id === e.target.value) || availableModels[0])}
                                className="w-full rounded bg-slate-800 border border-slate-600 px-3 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none"
                            >
                                {availableModels.map((m: ModelConfig) => (
                                    <option key={m.id} value={m.id}>{m.name} ({m.provider})</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs text-slate-400 mb-1">Mode</label>
                            <select
                                value={selectedMode.id}
                                onChange={(e) => setSelectedMode(MODES.find(m => m.id === e.target.value) || MODES[0])}
                                className="w-full rounded bg-slate-800 border border-slate-600 px-3 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none"
                            >
                                {MODES.map(m => (
                                    <option key={m.id} value={m.id}>{m.name} - {m.description}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
            )}

            {/* Conversation History Panel */}
            {showConversations && (
                <div className="border-b border-slate-700 bg-slate-800/50 max-h-64 overflow-y-auto">
                    <div className="px-3 py-2 text-xs text-slate-400 font-medium border-b border-slate-700/50 sticky top-0 bg-slate-800/90 backdrop-blur-sm">
                        Conversations
                    </div>
                    {conversations.length === 0 ? (
                        <div className="px-4 py-6 text-center text-sm text-slate-500">No conversations yet</div>
                    ) : (
                        conversations.map(conv => (
                            <div
                                key={conv.id}
                                className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors border-l-2 ${
                                    conv.id === conversationId
                                        ? 'bg-cyan-500/10 border-cyan-500 text-white'
                                        : 'border-transparent hover:bg-slate-700/50 text-slate-300 hover:text-white'
                                }`}
                                onClick={() => {
                                    switchConversation(conv.id);
                                    setShowConversations(false);
                                }}
                            >
                                <ChevronRight size={14} className={`flex-shrink-0 transition-transform ${
                                    conv.id === conversationId ? 'text-cyan-400 rotate-90' : 'text-slate-500'
                                }`} />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm truncate">{conv.title}</div>
                                    <div className="text-[10px] text-slate-500">
                                        {conv.message_count || 0} messages · {new Date(conv.updated_at).toLocaleDateString()}
                                    </div>
                                </div>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (confirm('Delete this conversation?')) {
                                            deleteConversation(conv.id);
                                        }
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                    title="Delete conversation"
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* Messages - with drag-and-drop support */}
            <div
                ref={messagesContainerRef}
                className={`flex-1 overflow-y-auto p-4 space-y-4 relative ${isDragging ? 'bg-cyan-500/10' : ''}`}
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
                        <p className="text-lg font-medium">Welcome to Praxis Terminal</p>
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

                {/* Scroll-up hint when more messages exist */}
                {hasMoreMessages && !isLoadingMore && messages.length > 0 && (
                    <div className="flex items-center justify-center py-2">
                        <span className="text-[11px] text-slate-600">↑ Scroll up for older messages</span>
                    </div>
                )}

                {messages.map((msg, i) => (
                    msg.role === 'system' ? (
                        /* System messages: compact activity log line */
                        <div key={i} className="flex items-center gap-2 py-1 px-2">
                            {loading && i === messages.length - 1 ? (
                                <Loader2 size={12} className="text-cyan-500/60 animate-spin flex-shrink-0" />
                            ) : (
                                <div className="w-3 h-3 flex items-center justify-center flex-shrink-0">
                                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-500/50" />
                                </div>
                            )}
                            <span className="text-xs text-slate-400">{msg.content}</span>
                        </div>
                    ) : (
                        <div
                            key={i}
                            className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                        >
                            <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${msg.role === 'user'
                                ? 'bg-cyan-500/20 text-cyan-400'
                                : msg.role === 'assistant'
                                    ? 'bg-purple-500/20 text-purple-400'
                                    : 'bg-red-500/20 text-red-400'
                                }`}>
                                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                            </div>
                            <div className={`max-w-[80%] rounded-lg px-4 py-2 ${msg.role === 'user'
                                ? 'bg-cyan-500/10 text-white'
                                : msg.role === 'assistant'
                                    ? 'bg-slate-800 text-slate-200'
                                    : 'bg-red-500/10 text-red-400'
                                }`}>
                                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                                {/* Render PLAN_DRAFT and PLAN_REVISED artifacts */}
                                {(msg.artifact?.type?.trim().toUpperCase() === 'PLAN_DRAFT' || msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED') && (
                                    <div className={`mt-3 p-4 rounded-lg ${msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED'
                                        ? 'border border-emerald-500/50 bg-emerald-900/20'
                                        : 'border border-blue-500/50 bg-blue-900/20'
                                        }`}>
                                        <div className="flex justify-between items-center">
                                            <h3 className={`font-bold ${msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED'
                                                ? 'text-emerald-300'
                                                : 'text-blue-300'
                                                }`}>
                                                {msg.artifact?.type?.trim().toUpperCase() === 'PLAN_REVISED'
                                                    ? `✅ Final for Review — Plan v${(msg.artifact.data as PlanDraftData).version || 1}`
                                                    : (msg.artifact.data as PlanDraftData).is_final
                                                        ? `Final Review: Plan v${(msg.artifact.data as PlanDraftData).version || (msg.artifact.data as PlanDraftData).revision || 1}`
                                                        : `Draft Plan v${(msg.artifact.data as PlanDraftData).version || (msg.artifact.data as PlanDraftData).revision || 1}`
                                                }: {(msg.artifact.data as PlanDraftData).title}
                                            </h3>
                                            {/* Open fullscreen review modal for markdown plans */}
                                            {(msg.artifact.data as PlanDraftData).markdown && (
                                                <button
                                                    onClick={() => setReviewModalData({ artifact: msg.artifact!, messageIndex: i })}
                                                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                                >
                                                    <Maximize2 size={12} /> Open Full View
                                                </button>
                                            )}
                                            {/* Legacy nodes expand toggle */}
                                            {!(msg.artifact.data as PlanDraftData).markdown && ((msg.artifact.data as PlanDraftData).nodes?.length || 0) > 3 && (
                                                <button
                                                    onClick={() => setExpandedArtifact(expandedArtifact === i ? null : i)}
                                                    className="text-xs text-blue-400 hover:text-blue-300 underline"
                                                >
                                                    {expandedArtifact === i ? 'Collapse' : 'Expand Details'}
                                                </button>
                                            )}
                                        </div>
                                        {/* Markdown plans: show summary + open modal button */}
                                        {(msg.artifact.data as PlanDraftData).markdown ? (
                                            <>
                                                <div
                                                    className="mt-2 text-sm text-slate-400 cursor-pointer hover:text-blue-300 transition-colors flex items-center gap-2"
                                                    onClick={() => setReviewModalData({ artifact: msg.artifact!, messageIndex: i })}
                                                >
                                                    <span>Markdown Plan (v{(msg.artifact.data as PlanDraftData).version || 1})</span>
                                                    <span className="text-xs text-slate-500">— click to review</span>
                                                </div>
                                                {(msg.artifact.data as PlanDraftData).rationale && (
                                                    <div className="mt-2 text-xs text-amber-400 bg-amber-900/20 p-2 rounded">
                                                        <span className="font-semibold">Rationale:</span> {(msg.artifact.data as PlanDraftData).rationale}
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <>
                                                <div className="mt-2 text-sm text-gray-300">
                                                    Proposed Steps: {(msg.artifact.data as PlanDraftData).nodes?.length || 0}
                                                </div>
                                                <ul className="mt-2 text-xs text-slate-400 space-y-1">
                                                    {(expandedArtifact === i
                                                        ? (msg.artifact.data as PlanDraftData).nodes || []
                                                        : ((msg.artifact.data as PlanDraftData).nodes || []).slice(0, 3)
                                                    ).map((node, idx) => (
                                                        <li key={idx}>• [{node.type}] {node.description}</li>
                                                    ))}
                                                    {expandedArtifact !== i && ((msg.artifact.data as PlanDraftData).nodes?.length || 0) > 3 && (
                                                        <li className="text-slate-500 cursor-pointer hover:text-blue-400" onClick={() => setExpandedArtifact(i)}>...and {((msg.artifact.data as PlanDraftData).nodes?.length || 0) - 3} more</li>
                                                    )}
                                                </ul>
                                            </>
                                        )}
                                        {/* Only show Approve/Critique buttons when plan is marked as final for review */}
                                        {((msg.artifact?.data as PlanDraftData)?.is_final || readyForReview.has((msg.artifact?.data as any)?.thread_id)) && (
                                            <div className="mt-3 flex gap-2">
                                                <button
                                                    onClick={async () => {
                                                        const threadId = (msg.artifact?.data as any)?.thread_id;
                                                        if (!threadId || threadId === 'unknown') {
                                                            setMessages(prev => [...prev, {
                                                                role: 'system',
                                                                content: '❌ Cannot approve: No valid thread ID found. Please try again.',
                                                                timestamp: new Date()
                                                            }]);
                                                            return;
                                                        }
                                                        setApprovalLoading(i);
                                                        const formData = new FormData();
                                                        formData.append('thread_id', threadId);
                                                        formData.append('action', 'APPROVE');
                                                        formData.append('comment', 'Plan approved by user');
                                                        try {
                                                            const response = await fetch(`/api/terminal/interact`, {
                                                                method: 'POST',
                                                                body: formData
                                                            });
                                                            if (!response.ok) {
                                                                throw new Error(`Server returned ${response.status}`);
                                                            }
                                                            setMessages(prev => [...prev, {
                                                                role: 'user',
                                                                content: '✅ Plan Approved - Execution starting...',
                                                                timestamp: new Date()
                                                            }]);
                                                        } catch (e) {
                                                            console.error('Approve failed:', e);
                                                            setMessages(prev => [...prev, {
                                                                role: 'system',
                                                                content: `❌ Approval failed: ${e instanceof Error ? e.message : 'Unknown error'}. Please try again.`,
                                                                timestamp: new Date()
                                                            }]);
                                                        } finally {
                                                            setApprovalLoading(null);
                                                        }
                                                    }}
                                                    className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                                    disabled={critiqueFeedback.messageIndex === i || approvalLoading === i}
                                                >
                                                    {approvalLoading === i && <Loader2 size={14} className="animate-spin" />}
                                                    {approvalLoading === i ? 'Approving...' : 'Approve'}
                                                </button>
                                                <button
                                                    onClick={() => setCritiqueFeedback({ messageIndex: i, text: '', loading: false })}
                                                    className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-sm transition-colors"
                                                    disabled={critiqueFeedback.messageIndex === i || approvalLoading === i}
                                                >Critique</button>
                                            </div>
                                        )}
                                        {/* Inline Critique Feedback Form */}
                                        {critiqueFeedback.messageIndex === i && (
                                            <div className="mt-3 border border-red-500/30 bg-red-900/20 rounded-lg p-3">
                                                <label className="block text-xs text-red-300 mb-2 font-medium">Revision Feedback</label>
                                                <textarea
                                                    value={critiqueFeedback.text}
                                                    onChange={(e) => setCritiqueFeedback(prev => ({ ...prev, text: e.target.value }))}
                                                    placeholder="Describe the changes you'd like to see..."
                                                    className="w-full h-24 bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-red-500 focus:outline-none resize-none"
                                                    autoFocus
                                                    disabled={critiqueFeedback.loading}
                                                />
                                                <div className="mt-2 flex gap-2 justify-end">
                                                    <button
                                                        onClick={() => setCritiqueFeedback({ messageIndex: null, text: '', loading: false })}
                                                        className="px-3 py-1 text-slate-400 hover:text-white text-sm transition-colors"
                                                        disabled={critiqueFeedback.loading}
                                                    >Cancel</button>
                                                    <button
                                                        onClick={async () => {
                                                            if (!critiqueFeedback.text.trim()) return;
                                                            setCritiqueFeedback(prev => ({ ...prev, loading: true }));
                                                            const threadId = (msg.artifact?.data as any)?.thread_id || 'unknown';
                                                            const formData = new FormData();
                                                            formData.append('thread_id', threadId);
                                                            formData.append('action', 'REJECT');
                                                            formData.append('comment', critiqueFeedback.text);
                                                            try {
                                                                const response = await fetch(`/api/terminal/interact`, {
                                                                    method: 'POST',
                                                                    body: formData
                                                                });
                                                                if (!response.ok) throw new Error('Failed to submit feedback');
                                                                setMessages(prev => [...prev, {
                                                                    role: 'user',
                                                                    content: `🔄 Requested revision: ${critiqueFeedback.text}`,
                                                                    timestamp: new Date()
                                                                }]);
                                                                setCritiqueFeedback({ messageIndex: null, text: '', loading: false });
                                                            } catch (e) {
                                                                console.error('Critique failed:', e);
                                                                setMessages(prev => [...prev, {
                                                                    role: 'system',
                                                                    content: '❌ Failed to submit feedback. Please try again.',
                                                                    timestamp: new Date()
                                                                }]);
                                                                setCritiqueFeedback(prev => ({ ...prev, loading: false }));
                                                            }
                                                        }}
                                                        disabled={critiqueFeedback.loading || !critiqueFeedback.text.trim()}
                                                        className="px-3 py-1 bg-red-600 hover:bg-red-500 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                                    >
                                                        {critiqueFeedback.loading && <Loader2 size={14} className="animate-spin" />}
                                                        {critiqueFeedback.loading ? 'Submitting...' : 'Submit Feedback'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {/* Render COMPILED_PLAN artifacts */}
                                {msg.artifact?.type?.trim().toUpperCase() === 'COMPILED_PLAN' && (
                                    <div className="mt-3 border border-emerald-500/50 bg-emerald-900/20 p-4 rounded-lg">
                                        <h4 className="font-semibold text-emerald-300">🔧 Compiled Plan: {(msg.artifact.data as CompiledPlanData).title}</h4>
                                        <p className="mt-1 text-sm text-slate-300">{(msg.artifact.data as CompiledPlanData).goal}</p>
                                        <ul className="mt-2 text-xs text-slate-400 space-y-1">
                                            {(msg.artifact.data as CompiledPlanData).nodes?.map((node, idx) => (
                                                <li key={idx}>• [{node.type}] {node.description}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {/* Render COUNCIL_REVIEW artifacts - VoteGrid */}
                                {(msg.artifact?.type?.trim().toUpperCase() === 'COUNCIL_REVIEW' || msg.artifact?.type?.trim().toUpperCase() === 'VOTE_SUMMARY') && (
                                    <div className="mt-3 border border-purple-500/50 bg-purple-900/20 rounded-lg p-4">
                                        <div className="flex justify-between items-center mb-2">
                                            <h4 className="font-semibold text-purple-300">Council Review</h4>
                                            <button
                                                onClick={() => setExpandedArtifact(expandedArtifact === i ? null : i)}
                                                className="text-xs text-purple-400 hover:text-purple-300 underline"
                                            >
                                                {expandedArtifact === i ? 'Collapse' : 'Expand Details'}
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-3 gap-2 text-xs">
                                            {(msg.artifact.data as VoteSummaryData).votes.map((vote, idx) => (
                                                <div key={idx} className={`p-2 rounded text-center cursor-pointer hover:opacity-80 ${vote.decision === 'approve' ? 'bg-green-800/50 border border-green-600/30' :
                                                    vote.decision === 'reject' ? 'bg-red-800/50 border border-red-600/30' :
                                                        'bg-yellow-800/50 border border-yellow-600/30'
                                                    }`}
                                                    onClick={() => setExpandedArtifact(expandedArtifact === i ? null : i)}
                                                >
                                                    <div className="font-semibold text-white">{vote.voter}</div>
                                                    <div className={`text-lg ${vote.decision === 'approve' ? 'text-green-400' :
                                                        vote.decision === 'reject' ? 'text-red-400' : 'text-yellow-400'
                                                        }`}>
                                                        {vote.decision === 'approve' ? '✅' : vote.decision === 'reject' ? '❌' : '❓'}
                                                    </div>
                                                    <div className="text-slate-400 truncate" title={vote.reasoning}>
                                                        {expandedArtifact === i ? vote.reasoning : vote.reasoning.substring(0, 40) + '...'}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        {/* Full reasoning panel when expanded */}
                                        {expandedArtifact === i && (
                                            <div className="mt-3 pt-3 border-t border-purple-500/30 space-y-2">
                                                <h5 className="text-sm font-semibold text-purple-300">Full Reasoning:</h5>
                                                {(msg.artifact.data as VoteSummaryData).votes.map((vote, idx) => (
                                                    <div key={idx} className={`p-2 rounded text-xs ${vote.decision === 'approve' ? 'bg-green-900/30' :
                                                        vote.decision === 'reject' ? 'bg-red-900/30' : 'bg-yellow-900/30'
                                                        }`}>
                                                        <div className="font-semibold text-white mb-1">{vote.voter} ({vote.decision})</div>
                                                        <div className="text-slate-300 whitespace-pre-wrap">{vote.reasoning}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                                {/* Phase 8: Render UNKNOWN_ARTIFACT with attention flag */}
                                {msg.artifact?.type === 'UNKNOWN_ARTIFACT' && (
                                    <div className="mt-3 border border-orange-500/50 bg-orange-900/20 rounded-lg p-4">
                                        <div className="flex items-center gap-2 text-orange-400">
                                            <span className="text-lg">⚠️</span>
                                            <span className="font-bold">Requires Attention</span>
                                        </div>
                                        <p className="mt-2 text-sm text-slate-300">
                                            Unknown event from node: <code className="bg-slate-800 px-1 rounded">{(msg.artifact.data as UnknownArtifactData).node_name}</code>
                                        </p>
                                        <pre className="mt-2 text-xs text-slate-400 bg-slate-800 p-2 rounded overflow-x-auto">
                                            {(msg.artifact.data as UnknownArtifactData).data.substring(0, 200)}...
                                        </pre>
                                    </div>
                                )}
                                {/* DEFAULT: Catch-all for any unrecognized artifact type (e.g., UNKNOWN_SIGNAL) */}
                                {msg.artifact && !['PLAN_DRAFT', 'PLAN_REVISED', 'COUNCIL_REVIEW', 'VOTE_SUMMARY', 'COMPILED_PLAN', 'CHAT_RESPONSE', 'UNKNOWN_ARTIFACT', 'STATUS_UPDATE', 'READY_FOR_REVIEW'].includes(msg.artifact.type) && (
                                    <div className="mt-3 p-4 rounded-lg border border-yellow-500/50 bg-yellow-900/20 text-yellow-200 font-mono text-sm">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="text-xl">⚠️</span>
                                            <span className="font-bold">UNKNOWN SIGNAL</span>
                                            <span className="text-xs text-yellow-400/70 ml-auto">{msg.artifact.type}</span>
                                        </div>
                                        <pre className="text-xs text-yellow-200/70 overflow-auto max-h-40 bg-black/40 p-2 rounded">
                                            {JSON.stringify(msg.artifact.data, null, 2)}
                                        </pre>
                                        <div className="mt-2 text-[10px] uppercase tracking-widest text-yellow-600">
                                            Flagged for Human Review
                                        </div>
                                    </div>
                                )}
                                {/* Render Voice Data */}
                                {msg.voiceData && msg.voiceData.map((v, vidx) => {
                                    const voiceKey = `${i}-${vidx}`;
                                    if (dismissedVoice.has(voiceKey)) return null;
                                    const isListened = listenedVoice.has(voiceKey);
                                    return (
                                        <div 
                                            key={vidx} 
                                            className={`mt-3 p-3 rounded-lg w-fit transition-all duration-500 ${
                                                isListened 
                                                    ? 'bg-black/20 border border-purple-500/10' 
                                                    : 'bg-purple-950/30 border border-purple-500/40 shadow-[0_0_12px_rgba(168,85,247,0.15)]'
                                            }`}
                                        >
                                            <div className="flex items-center gap-2 mb-2 px-1">
                                                <Volume2 size={12} className={`${isListened ? 'text-purple-400/50' : 'text-purple-400 animate-pulse'}`} />
                                                <span className={`text-[10px] uppercase tracking-wider font-bold ${isListened ? 'text-purple-400/50' : 'text-purple-400'}`}>
                                                    {isListened ? 'Voice Message' : '🔔 New Voice Message'}
                                                </span>
                                                <div className="flex items-center gap-1 ml-auto">
                                                    <button
                                                        onClick={() => saveVoiceMemo(v.audio, v.mimeType, i, vidx)}
                                                        className="p-1 rounded hover:bg-purple-500/20 text-purple-400/60 hover:text-purple-300 transition-colors"
                                                        title="Save voice memo"
                                                    >
                                                        <Save size={12} />
                                                    </button>
                                                    <button
                                                        onClick={() => setDismissedVoice(prev => new Set([...prev, voiceKey]))}
                                                        className="p-1 rounded hover:bg-red-500/20 text-slate-500 hover:text-red-400 transition-colors"
                                                        title="Dismiss"
                                                    >
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            </div>
                                            <audio 
                                                src={`data:${v.mimeType};base64,${v.audio}`} 
                                                controls 
                                                autoPlay={vidx === 0 && i === messages.length - 1 && !isListened}
                                                onEnded={() => setListenedVoice(prev => new Set([...prev, voiceKey]))}
                                                className="h-8 max-w-[260px] [&::-webkit-media-controls-enclosure]:bg-transparent" 
                                            />
                                        </div>
                                    );
                                })}

                                <span className="text-[10px] text-slate-500 mt-1 block">
                                    {msg.timestamp.toLocaleTimeString()}
                                </span>
                            </div>
                        </div>
                    )
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
            <div className="p-4 border-t border-slate-700 bg-slate-800/50">
                {/* Hidden file input — any file type */}
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="*/*"
                    className="hidden"
                    onChange={(e) => {
                        if (e.target.files) handleFileDrop(e.target.files);
                        e.target.value = '';
                    }}
                />
                {/* Hidden media input — camera/gallery (images + video) */}
                <input
                    ref={mediaInputRef}
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                        if (e.target.files) handleFileDrop(e.target.files);
                        e.target.value = '';
                    }}
                />

                {/* Attachment preview chips */}
                {attachedPreviews.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                        {attachedPreviews.map((file, idx) => {
                            const isImage = file.type.startsWith('image/');
                            const isVideo = file.type.startsWith('video/');
                            const isAudio = file.type.startsWith('audio/');
                            const sizeStr = file.size < 1024 ? `${file.size} B`
                                : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(0)} KB`
                                : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

                            return (
                                <div
                                    key={idx}
                                    className={`group relative flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg border text-sm transition-all ${
                                        isImage ? 'bg-violet-500/10 border-violet-500/30 text-violet-300'
                                        : isVideo ? 'bg-pink-500/10 border-pink-500/30 text-pink-300'
                                        : isAudio ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                                        : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'
                                    }`}
                                >
                                    {/* Image thumbnail */}
                                    {isImage && file.previewUrl ? (
                                        <img
                                            src={file.previewUrl}
                                            alt={file.name}
                                            className="w-8 h-8 rounded object-cover border border-white/10"
                                        />
                                    ) : (
                                        <div className="w-8 h-8 rounded bg-black/20 flex items-center justify-center">
                                            {isVideo ? <Film size={14} />
                                            : isAudio ? <Music size={14} />
                                            : file.type.includes('zip') || file.type.includes('archive') ? <FileArchive size={14} />
                                            : <FileText size={14} />}
                                        </div>
                                    )}
                                    <div className="flex flex-col min-w-0">
                                        <span className="max-w-[140px] truncate text-xs font-medium">{file.name}</span>
                                        <span className="text-[10px] opacity-60">{sizeStr}</span>
                                    </div>
                                    <button
                                        onClick={() => removeFile(idx)}
                                        className="ml-1 opacity-50 hover:opacity-100 hover:text-red-400 transition-all"
                                    >
                                        <XCircle size={14} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Audio Preview Chip */}
                {audioPreviewUrl && (
                    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 mb-3 w-fit text-sm">
                        <Mic size={14} className="text-red-400 font-bold" />
                        <span className="text-red-300 font-mono">{recordingTime}s</span>
                        <audio src={audioPreviewUrl} controls className="h-6 w-48 [&::-webkit-media-controls-enclosure]:bg-transparent [&::-webkit-media-controls-panel]:bg-transparent" />
                        <button onClick={clearAudio} className="text-slate-400 hover:text-red-400 transition-colors ml-2">
                            <XCircle size={16} />
                        </button>
                    </div>
                )}

                <div className="flex gap-2">
                    {/* Voice Record button — only in Praxis mode */}
                    {selectedMode.id === 'praxis' && !isRecording && !audioBlob && (
                        <button
                            onClick={startRecording}
                            disabled={loading || isDragging}
                            className="px-3 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Record voice memo"
                        >
                            <Mic size={18} />
                        </button>
                    )}

                    {isRecording && (
                        <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 animate-pulse">
                            <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
                            <span className="text-red-400 font-mono text-sm font-medium">
                                {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                            </span>
                            <button
                                onClick={stopRecording}
                                className="ml-2 text-slate-300 hover:text-red-400 transition-colors"
                                title="Stop recording"
                            >
                                <Square size={16} className="fill-current" />
                            </button>
                        </div>
                    )}

                    {/* Camera/Gallery picker — hide when recording */}
                    {!isRecording && (
                        <button
                            onClick={() => mediaInputRef.current?.click()}
                            disabled={loading}
                            className="px-3 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-violet-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Photo / Gallery"
                        >
                            <Image size={18} />
                        </button>
                    )}

                    {/* General file picker — hide when recording */}
                    {!isRecording && (
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={loading}
                            className="px-3 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-cyan-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Attach file"
                        >
                            <Paperclip size={18} />
                        </button>
                    )}

                    {!isRecording && (
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={audioBlob ? "Add a message (optional)..." : (attachedFiles.length > 0 ? "Add a message (optional)..." : "Message Praxis...")}
                            className="flex-1 rounded-lg bg-slate-800 border border-slate-600 px-4 py-2 text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                            disabled={loading}
                        />
                    )}
                    
                    <button
                        onClick={handleSend}
                        disabled={loading || (!input.trim() && attachedFiles.length === 0 && !audioBlob) || isRecording}
                        className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium hover:from-cyan-600 hover:to-purple-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                    </button>
                </div>
            </div>
        </>);
    }
}
