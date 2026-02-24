"use client"

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Bot, User, Settings2, Loader2, X, MessageSquare, Lock, Trash2, Paperclip, FileText, XCircle, RotateCcw } from "lucide-react";
import { useParams } from "next/navigation";
import { models } from "@/lib/ai/models";
import { getAuthHeader } from "@/lib/auth";
import { io, Socket } from "socket.io-client";

interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    artifact?: CortexArtifact;
}

// Cortex Artifact types for Glass Box transparency
interface CortexArtifact {
    type: 'PLAN_DRAFT' | 'PLAN_REVISED' | 'COUNCIL_REVIEW' | 'COMPILED_PLAN' | 'CHAT_RESPONSE' | 'STATUS_UPDATE' | 'READY_FOR_REVIEW' | 'UNKNOWN_ARTIFACT';
    data: PlanDraftData | VoteSummaryData | CompiledPlanData | ChatResponseData | StatusUpdateData | UnknownArtifactData | any;
}

// Phase 12: Updated for Markdown-based plans
interface PlanDraftData {
    title: string;
    // Phase 12 fields
    version?: number;     // Plan version number
    markdown?: string;    // Full Markdown content
    rationale?: string;   // Why revisions were made
    diff?: string;        // Diff from previous version
    // Legacy fields (backward compat)
    goal?: string;
    nodes?: { id: string; type: string; description: string }[];
    status?: 'draft' | 'approved' | 'rejected';
    thread_id?: string;
    revision?: number;    // Legacy revision number
    is_final?: boolean;   // True when plan is ready for human review
}

interface CompiledPlanData {
    title: string;
    goal: string;
    nodes: { id: string; type: string; description: string; workflow?: string }[];
    thread_id?: string;
}

interface ChatResponseData {
    response: string;
    thread_id?: string;
}

// Phase 12: Updated with line_comments
interface LineCommentData {
    voter: string;
    line_number: number;
    line_content: string;
    comment: string;
    suggestion?: string;
}

interface VoteSummaryData {
    votes: { voter: string; decision: string; reasoning: string; line_comments?: LineCommentData[] }[];
    thread_id?: string;
}

interface StatusUpdateData {
    status: string;
    preview?: string;
    thread_id?: string;
}

interface UnknownArtifactData {
    node_name: string;
    data: string;
    requires_attention: boolean;
    thread_id?: string;
}

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

const MODELS: ModelConfig[] = [
    // ═══════════════════════════════════════════════════════════════
    // GOOGLE GEMINI MODELS
    // ═══════════════════════════════════════════════════════════════
    {
        id: 'gemini-3-pro',
        apiModelId: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro',
        provider: 'Google',
        limits: { maxInputTokens: 1048576, maxOutputTokens: 65536 },
    },
    {
        id: 'gemini-3-deep-think',
        apiModelId: 'gemini-3-pro-preview', // Same model, different config
        name: 'Gemini 3 Deep Think',
        provider: 'Google',
        isThinking: true,
        parameters: {
            thinking_config: { thinking_level: 'HIGH' },
        },
        limits: { maxInputTokens: 1048576, maxOutputTokens: 65536 },
    },
    {
        id: 'gemini-3-flash',
        apiModelId: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: 'Google',
        parameters: {
            thinking_budget: -1, // Dynamic reasoning (default)
        },
        limits: { maxInputTokens: 1048576, maxOutputTokens: 65535 },
    },
    // ═══════════════════════════════════════════════════════════════
    // ANTHROPIC CLAUDE MODELS
    // ═══════════════════════════════════════════════════════════════
    {
        id: 'claude-opus-4.5',
        apiModelId: 'claude-opus-4-5-20251101',
        name: 'Claude Opus 4.5',
        provider: 'Anthropic',
        limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    },
    {
        id: 'claude-opus-4.5-thinking',
        apiModelId: 'claude-opus-4-5-20251101', // Same model, different config
        name: 'Claude Opus 4.5 Thinking',
        provider: 'Anthropic',
        isThinking: true,
        parameters: {
            thinking: { type: 'enabled', budget_tokens: 16000 },
        },
        limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    },
    {
        id: 'claude-sonnet-4.5',
        apiModelId: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        provider: 'Anthropic',
        limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    },
    // ═══════════════════════════════════════════════════════════════
    // OPENAI GPT MODELS
    // ═══════════════════════════════════════════════════════════════
    {
        id: 'gpt-5.2',
        apiModelId: 'gpt-5.2-chat-latest', // "Instant" variant for speed
        name: 'GPT-5.2',
        provider: 'OpenAI',
        limits: { maxInputTokens: 128000, maxOutputTokens: 16000 },
    },
    {
        id: 'gpt-5.2-thinking',
        apiModelId: 'gpt-5.2', // Default thinking model
        name: 'GPT-5.2 Thinking',
        provider: 'OpenAI',
        isThinking: true,
        parameters: {
            reasoning_effort: 'high',
        },
        limits: { maxInputTokens: 128000, maxOutputTokens: 128000 },
    },
    {
        id: 'gpt-4o',
        apiModelId: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'OpenAI',
        limits: { maxInputTokens: 128000, maxOutputTokens: 16384 },
    },
];

const MODES = [
    { id: 'chat', name: 'Chat', description: 'Natural conversation' },
    { id: 'agent', name: 'Agent', description: 'Execute actions on projects' },
    { id: 'code', name: 'Code', description: 'Code generation focused' },
];

export function AITerminal({ isOpen = true, onClose, mode = 'modal' }: AITerminalProps) {
    const isInline = mode === 'inline';
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [selectedModel, setSelectedModel] = useState(MODELS[0]);
    const [selectedMode, setSelectedMode] = useState(MODES[0]);
    const [showSettings, setShowSettings] = useState(false);
    const [pendingArtifact, setPendingArtifact] = useState<CortexArtifact | null>(null);
    const [currentStatus, setCurrentStatus] = useState<string | null>(null); // Phase 8: Status ticker
    const [attachedFiles, setAttachedFiles] = useState<File[]>([]); // File upload state
    const [isDragging, setIsDragging] = useState(false); // Drag-and-drop state
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
    const [readyForReview, setReadyForReview] = useState<Set<string>>(new Set());
    // Track expanded artifact index for full content viewing
    const [expandedArtifact, setExpandedArtifact] = useState<number | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null); // Hidden file input
    const params = useParams();
    const scopedProjectId = typeof params?.id === 'string' ? params.id : null;

    // Phase 8: Load persisted messages on mount
    useEffect(() => {
        const stored = localStorage.getItem('cortex_chat_history');
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                // Restore timestamps as Date objects
                const restored = parsed.map((m: any) => ({
                    ...m,
                    timestamp: new Date(m.timestamp)
                }));
                setMessages(restored);
            } catch (e) {
                console.warn('Failed to restore chat history:', e);
            }
        }

        // Phase 9: Check for pending Cortex state (rehydration)
        const lastThreadId = localStorage.getItem('cortex_thread_id');
        if (lastThreadId) {
            const cortexUrl = process.env.NEXT_PUBLIC_CORTEX_URL || 'http://localhost:8001';
            fetch(`${cortexUrl}/api/terminal/state/${lastThreadId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.is_paused && data.current_plan) {
                        console.log('[Nexus Terminal] Rehydrating pending plan:', data.current_plan.title);
                        // Add a system message about the pending plan
                        setMessages(prev => [...prev, {
                            role: 'system',
                            content: `⏸️ Pending plan "${data.current_plan.title}" awaiting your review.`,
                            timestamp: new Date(),
                            artifact: {
                                type: 'PLAN_DRAFT',
                                data: { ...data.current_plan, thread_id: lastThreadId }
                            }
                        }]);
                    }
                })
                .catch(err => console.warn('[Nexus Terminal] Rehydration check failed:', err));
        }
    }, []);

    // Phase 8: Persist messages to localStorage
    useEffect(() => {
        if (messages.length > 0) {
            localStorage.setItem('cortex_chat_history', JSON.stringify(messages.slice(-100))); // Keep last 100
        }
    }, [messages]);

    // Auto-scroll on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Focus input when terminal opens (modal only — inline shouldn't steal focus on page load)
    useEffect(() => {
        if (isOpen && !isInline && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isOpen, isInline]);

    // Listen for Cortex artifact events via WebSocket (Phase 8: Glass Box)
    useEffect(() => {
        const nexusUrl = process.env.NEXT_PUBLIC_NEXUS_API_URL || 'http://localhost:4000';
        const socket: Socket = io(nexusUrl, { transports: ['websocket', 'polling'] });

        socket.on('connect', () => {
            console.log('[Nexus Terminal] WebSocket connected:', socket.id);
        });

        socket.on('cortex-artifact', (artifact: CortexArtifact) => {
            console.log('[Nexus Terminal] Artifact:', artifact.type);

            // Phase 8: Handle STATUS_UPDATE separately (status ticker)
            // Robust/Fuzzy handling (trim whitespace, normalize case)
            const type = artifact.type?.trim().toUpperCase();

            // Handle STATUS_UPDATE
            if (type === 'STATUS_UPDATE') {
                const statusData = artifact.data as StatusUpdateData;
                setCurrentStatus(statusData.status);
                setTimeout(() => setCurrentStatus(null), 5000); // Auto-clear after 5s
                return;
            }

            // Handle READY_FOR_REVIEW - signals voting is complete and plan is ready
            if (type === 'READY_FOR_REVIEW') {
                const threadId = artifact.data?.thread_id;
                console.log('[Nexus Terminal] READY_FOR_REVIEW received, thread:', threadId);
                if (threadId) {
                    setReadyForReview(prev => {
                        const newSet = new Set(prev).add(threadId);
                        return newSet;
                    });
                } else {
                    console.warn('[Nexus Terminal] READY_FOR_REVIEW missing thread_id');
                }
                return;
            }

            // All other artifacts become messages
            const labelMap: Record<string, string> = {
                'PLAN_DRAFT': '📋 Draft Plan',
                'PLAN_REVISED': '✅ Final Plan for Review',
                'COUNCIL_REVIEW': '🗳️ Council Review',
                'COMPILED_PLAN': '🔧 Compiled Plan',
                'CHAT_RESPONSE': '💬 Response',
                'UNKNOWN_ARTIFACT': '⚠️ Unknown Event'
            };

            setMessages(prev => [...prev, {
                role: 'assistant',
                content: labelMap[type] || `📋 ${artifact.type}`,
                timestamp: new Date(),
                artifact: artifact
            }]);
        });

        socket.on('disconnect', () => {
            console.warn('[Nexus Terminal] WebSocket disconnected');
        });

        socket.on('connect_error', (error: Error) => {
            console.error('[Nexus Terminal] WebSocket connection failed:', error.message);
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    // File handling functions
    const handleFileDrop = useCallback((files: FileList | File[]) => {
        const fileArray = Array.from(files);
        // Filter for allowed file types
        const allowedTypes = ['.txt', '.md', '.json', '.py', '.js', '.ts', '.tsx', '.yaml', '.yml', '.csv'];
        const validFiles = fileArray.filter(file => {
            const ext = '.' + file.name.split('.').pop()?.toLowerCase();
            return allowedTypes.includes(ext) || file.type.startsWith('text/');
        });

        if (validFiles.length > 0) {
            setAttachedFiles(prev => [...prev, ...validFiles].slice(0, 5)); // Max 5 files
            console.log('[Nexus Terminal] Files attached:', validFiles.map(f => f.name));
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
    }, []);

    const handleSend = async () => {
        if ((!input.trim() && attachedFiles.length === 0) || loading) return;

        // Build user message content
        let messageContent = input.trim();
        if (attachedFiles.length > 0) {
            messageContent += messageContent ? '\n\n' : '';
            messageContent += `📎 ${attachedFiles.length} file(s) attached: ${attachedFiles.map(f => f.name).join(', ')}`;
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
        setLoading(true);

        try {
            const authHeader = await getAuthHeader();

            // Read file contents if any files attached
            let fileContents: { name: string; content: string; type: string }[] = [];
            if (filesToUpload.length > 0) {
                fileContents = await Promise.all(
                    filesToUpload.map(async (file) => {
                        const content = await file.text();
                        return { name: file.name, content, type: file.type || 'text/plain' };
                    })
                );
            }

            const response = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: {
                    ...authHeader as any, // Cast to any to assume HeadersInit compatibility
                },
                body: JSON.stringify({
                    message: input.trim() || `Please analyze the attached file(s): ${filesToUpload.map(f => f.name).join(', ')}`,
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
                    files: fileContents, // Include file contents
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to get response');
            }

            const data = await response.json();

            const assistantMessage: Message = {
                role: 'assistant',
                content: data.response || 'No response received',
                timestamp: new Date(),
            };

            setMessages(prev => [...prev, assistantMessage]);
        } catch (error) {
            console.error('AI Chat error:', error);
            // In Agent mode, artifacts stream via WebSocket — the HTTP response is just a summary.
            // Don't show a scary error if the pipeline is actually working via Glass Box.
            if (selectedMode.id === 'agent') {
                console.warn('[Nexus Terminal] HTTP response failed in Agent mode — artifacts may still be streaming via WebSocket.');
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
                setMessages(prev => [...prev, {
                    role: 'system',
                    content: 'Error: Could not connect to AI service. Make sure the server has an API key configured.',
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
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/50">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Bot size={20} className="text-cyan-400" />
                        <span className="font-bold text-white">Nexus Terminal</span>
                        {scopedProjectId && (
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                <Lock size={10} />
                                <span className="text-[10px] uppercase font-bold tracking-wider">Scoped: {scopedProjectId}</span>
                            </div>
                        )}
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${selectedModel.isThinking
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-cyan-500/20 text-cyan-400'}`}>
                        {selectedModel.isThinking && '⚡ '}{selectedModel.name}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
                        {selectedMode.name}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => {
                            setMessages([]);
                            localStorage.removeItem('cortex_chat_history');
                            localStorage.removeItem('cortex_thread_id');
                            console.log('[Nexus Terminal] New chat started');
                        }}
                        className="p-1.5 rounded text-slate-400 hover:text-cyan-400 hover:bg-slate-700 transition-colors"
                        title="New Chat (clears history and starts fresh)"
                    >
                        <RotateCcw size={18} />
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

            {/* Phase 8: Status Ticker - Shows current processing state */}
            {currentStatus && (
                <div className="px-4 py-2 border-b border-slate-700 bg-gradient-to-r from-purple-900/30 to-cyan-900/30">
                    <div className="flex items-center gap-2 text-sm text-cyan-300">
                        <Loader2 size={14} className="animate-spin" />
                        <span className="animate-pulse">{currentStatus}</span>
                    </div>
                </div>
            )}

            {/* Settings Panel */}
            {showSettings && (
                <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/30 space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs text-slate-400 mb-1">Model</label>
                            <select
                                value={selectedModel.id}
                                onChange={(e) => setSelectedModel(MODELS.find(m => m.id === e.target.value) || MODELS[0])}
                                className="w-full rounded bg-slate-800 border border-slate-600 px-3 py-1.5 text-sm text-white focus:border-cyan-500 focus:outline-none"
                            >
                                {MODELS.map(m => (
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

            {/* Messages - with drag-and-drop support */}
            <div
                className={`flex-1 overflow-y-auto p-4 space-y-4 relative ${isDragging ? 'bg-cyan-500/10' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
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
                        <p className="text-lg font-medium">Welcome to Nexus Terminal</p>
                        <p className="text-sm mt-1">Your AI-powered web development assistant</p>
                        <p className="text-xs mt-4 opacity-70">
                            Try: "Build me a landing page for my SaaS" or "Create a new web-app called MyProject"
                        </p>
                    </div>
                )}

                {messages.map((msg, i) => (
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
                                        {/* Phase 12: Show expand for Markdown or legacy nodes */}
                                        {((msg.artifact.data as PlanDraftData).markdown || ((msg.artifact.data as PlanDraftData).nodes?.length || 0) > 3) && (
                                            <button
                                                onClick={() => setExpandedArtifact(expandedArtifact === i ? null : i)}
                                                className="text-xs text-blue-400 hover:text-blue-300 underline"
                                            >
                                                {expandedArtifact === i ? 'Collapse' : 'Expand Details'}
                                            </button>
                                        )}
                                    </div>
                                    {/* Phase 12: Show Markdown content or legacy nodes */}
                                    {(msg.artifact.data as PlanDraftData).markdown ? (
                                        <>
                                            <div className="mt-2 text-sm text-gray-300">
                                                Markdown Plan (v{(msg.artifact.data as PlanDraftData).version || 1})
                                            </div>
                                            {expandedArtifact === i && (
                                                <pre className="mt-2 text-xs text-slate-400 bg-slate-800 p-3 rounded overflow-auto max-h-60 whitespace-pre-wrap">
                                                    {(msg.artifact.data as PlanDraftData).markdown}
                                                </pre>
                                            )}
                                            {(msg.artifact.data as PlanDraftData).rationale && expandedArtifact === i && (
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
                                                        const cortexUrl = process.env.NEXT_PUBLIC_CORTEX_URL || 'http://localhost:8001';
                                                        const response = await fetch(`${cortexUrl}/api/terminal/interact`, {
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
                                                            const cortexUrl = process.env.NEXT_PUBLIC_CORTEX_URL || 'http://localhost:8001';
                                                            const response = await fetch(`${cortexUrl}/api/terminal/interact`, {
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
                            <span className="text-[10px] text-slate-500 mt-1 block">
                                {msg.timestamp.toLocaleTimeString()}
                            </span>
                        </div>
                    </div>
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

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 border-t border-slate-700 bg-slate-800/50">
                {/* Hidden file input */}
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.json,.py,.js,.ts,.tsx,.yaml,.yml,.csv"
                    className="hidden"
                    onChange={(e) => {
                        if (e.target.files) {
                            handleFileDrop(e.target.files);
                        }
                        e.target.value = ''; // Reset to allow re-selecting same file
                    }}
                />

                {/* File preview chips */}
                {attachedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                        {attachedFiles.map((file, idx) => (
                            <div
                                key={idx}
                                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-sm"
                            >
                                <FileText size={14} />
                                <span className="max-w-[150px] truncate">{file.name}</span>
                                <button
                                    onClick={() => removeFile(idx)}
                                    className="text-cyan-400 hover:text-red-400 transition-colors"
                                >
                                    <XCircle size={14} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <div className="flex gap-2">
                    {/* Upload button */}
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={loading}
                        className="px-3 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Attach files"
                    >
                        <Paperclip size={18} />
                    </button>

                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={attachedFiles.length > 0 ? "Add a message (optional)..." : "Ask me anything about your projects..."}
                        className="flex-1 rounded-lg bg-slate-800 border border-slate-600 px-4 py-2 text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                        disabled={loading}
                    />
                    <button
                        onClick={handleSend}
                        disabled={loading || (!input.trim() && attachedFiles.length === 0)}
                        className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium hover:from-cyan-600 hover:to-purple-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                    </button>
                </div>
            </div>
        </>);
    }
}
