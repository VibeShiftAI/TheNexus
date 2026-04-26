"use client"

import { createContext, useContext, useState, useEffect, useRef, ReactNode, Dispatch, SetStateAction, useCallback } from "react";
import { io, Socket } from "socket.io-client";

// ────────────────────────────────────────────────────────────
// Shared types (also used by ai-terminal.tsx)
// ────────────────────────────────────────────────────────────

export interface AgEvent {
    id: number;
    event_type: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    message?: string;
    task_id?: string;
    source?: string;
    metadata?: Record<string, any>;
    requires_action?: boolean;
    action_taken?: boolean;
    created_at: string;
}

export interface Message {
    id?: string;
    conversation_id?: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    artifact?: CortexArtifact;
    voiceData?: { audio: string; mimeType: string }[];
    metadata?: Record<string, any>;
}

export interface CortexArtifact {
    type: 'PLAN_DRAFT' | 'PLAN_REVISED' | 'COUNCIL_REVIEW' | 'COMPILED_PLAN' | 'CHAT_RESPONSE' | 'STATUS_UPDATE' | 'READY_FOR_REVIEW' | 'UNKNOWN_ARTIFACT';
    data: PlanDraftData | VoteSummaryData | CompiledPlanData | ChatResponseData | StatusUpdateData | UnknownArtifactData | any;
}

export interface PlanDraftData {
    title: string;
    version?: number;
    markdown?: string;
    rationale?: string;
    diff?: string;
    goal?: string;
    nodes?: { id: string; type: string; description: string }[];
    status?: 'draft' | 'approved' | 'rejected';
    thread_id?: string;
    revision?: number;
    is_final?: boolean;
}

export interface CompiledPlanData {
    title: string;
    goal: string;
    nodes: { id: string; type: string; description: string; workflow?: string }[];
    thread_id?: string;
}

export interface ChatResponseData {
    response: string;
    thread_id?: string;
}

export interface LineCommentData {
    voter: string;
    line_number: number;
    line_content: string;
    comment: string;
    suggestion?: string;
}

export interface VoteSummaryData {
    votes: { voter: string; decision: string; reasoning: string; line_comments?: LineCommentData[] }[];
    thread_id?: string;
}

export interface StatusUpdateData {
    status: string;
    message?: string;
    preview?: string;
    thread_id?: string;
}

export interface UnknownArtifactData {
    node_name: string;
    data: string;
    requires_attention: boolean;
    thread_id?: string;
}

// ────────────────────────────────────────────────────────────
// Conversation type
// ────────────────────────────────────────────────────────────

export interface ChatConversation {
    id: string;
    title: string;
    mode: string;
    is_active: boolean;
    message_count?: number;
    first_message?: string;
    created_at: string;
    updated_at: string;
}

interface ChatMessageEvent {
    conversationId?: string;
    mode?: string;
    message?: {
        id?: string;
        conversation_id?: string;
        role?: 'user' | 'assistant' | 'system';
        content?: string;
        created_at?: string;
        metadata?: Record<string, any>;
        voiceData?: { audio: string; mimeType: string }[];
    };
}

// ────────────────────────────────────────────────────────────
// Context shape
// ────────────────────────────────────────────────────────────

interface CortexContextValue {
    messages: Message[];
    setMessages: Dispatch<SetStateAction<Message[]>>;
    readyForReview: Set<string>;
    setReadyForReview: Dispatch<SetStateAction<Set<string>>>;
    // Conversation management
    conversationId: string | null;
    conversations: ChatConversation[];
    startNewConversation: () => Promise<void>;
    switchConversation: (id: string) => Promise<void>;
    loadConversations: () => Promise<void>;
    deleteConversation: (id: string) => Promise<void>;
    isLoadingHistory: boolean;
    // Pagination
    hasMoreMessages: boolean;
    isLoadingMore: boolean;
    loadMoreMessages: () => Promise<void>;
    // Antigravity event stream
    agEvents: AgEvent[];
    dismissAgEvent: (id: number) => Promise<void>;
}

const CortexContext = createContext<CortexContextValue | null>(null);

export function useCortex(): CortexContextValue {
    const ctx = useContext(CortexContext);
    if (!ctx) throw new Error("useCortex must be used within <CortexProvider>");
    return ctx;
}

// ────────────────────────────────────────────────────────────
// Helper: build API base URL
// ────────────────────────────────────────────────────────────

function apiBase(): string {
    if (typeof window === 'undefined') return '';
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return isLocal ? 'http://localhost:4000' : '';
}

// ────────────────────────────────────────────────────────────
// Provider — owns the Socket.IO connection for the app lifetime
// ────────────────────────────────────────────────────────────

export function CortexProvider({ children }: { children: ReactNode }) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [readyForReview, setReadyForReview] = useState<Set<string>>(new Set());
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [conversations, setConversations] = useState<ChatConversation[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(true);
    const [hasMoreMessages, setHasMoreMessages] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [agEvents, setAgEvents] = useState<AgEvent[]>([]);
    const socketRef = useRef<Socket | null>(null);
    const initialised = useRef(false);

    // ── Fetch active conversation + history from server on mount ──
    useEffect(() => {
        const base = apiBase();

        async function loadActiveConversation() {
            try {
                setIsLoadingHistory(true);
                const res = await fetch(`${base}/api/chat/active?mode=praxis`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (data.conversation) {
                    setConversationId(data.conversation.id);
                    const restored: Message[] = (data.messages || []).map((m: any) => ({
                        role: m.role,
                        content: m.content,
                        timestamp: new Date(m.created_at),
                        voiceData: Array.isArray(m.voiceData) ? m.voiceData : undefined,
                    }));
                    setMessages(restored);
                    setHasMoreMessages(data.hasMore ?? false);
                }
            } catch (e) {
                console.warn('[CortexProvider] Failed to load chat history from server:', e);
                // Fallback: try localStorage for backward compat
                const stored = localStorage.getItem('cortex_chat_history');
                if (stored) {
                    try {
                        const parsed = JSON.parse(stored);
                        setMessages(parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) })));
                    } catch { /* ignore */ }
                }
            } finally {
                setIsLoadingHistory(false);
            }
        }

        loadActiveConversation();

        // Check for pending Cortex state (rehydration)
        const lastThreadId = localStorage.getItem('cortex_thread_id');
        if (lastThreadId) {
            fetch(`${base}/api/terminal/state/${lastThreadId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.is_paused && data.current_plan) {
                        console.log('[CortexProvider] Rehydrating pending plan:', data.current_plan.title);
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
                .catch(err => console.warn('[CortexProvider] Rehydration check failed:', err));
        }
    }, []);

    // ── Load conversation list ──
    const loadConversations = useCallback(async () => {
        try {
            const base = apiBase();
            const res = await fetch(`${base}/api/chat/conversations?mode=praxis`);
            if (!res.ok) return;
            const data = await res.json();
            setConversations(data.conversations || []);
        } catch (e) {
            console.warn('[CortexProvider] Failed to load conversations:', e);
        }
    }, []);

    // ── Start a new conversation (old one stays in history) ──
    const startNewConversation = useCallback(async () => {
        try {
            const base = apiBase();
            const res = await fetch(`${base}/api/chat/conversations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'praxis' }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setConversationId(data.conversation.id);
            setMessages([]); // Fresh conversation — no messages yet
            await loadConversations(); // Refresh the sidebar list
        } catch (e) {
            console.error('[CortexProvider] Failed to start new conversation:', e);
        }
    }, [loadConversations]);

    // ── Switch to an existing conversation ──
    const switchConversationFn = useCallback(async (id: string) => {
        try {
            const base = apiBase();
            const res = await fetch(`${base}/api/chat/conversations/${id}/switch`, {
                method: 'PUT',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setConversationId(data.conversation.id);
            const restored: Message[] = (data.messages || []).map((m: any) => ({
                role: m.role,
                content: m.content,
                timestamp: new Date(m.created_at),
                voiceData: Array.isArray(m.voiceData) ? m.voiceData : undefined,
            }));
            setMessages(restored);
            setHasMoreMessages(data.hasMore ?? false);
            await loadConversations();
        } catch (e) {
            console.error('[CortexProvider] Failed to switch conversation:', e);
        }
    }, [loadConversations]);

    // ── Delete a conversation ──
    const deleteConversationFn = useCallback(async (id: string) => {
        try {
            const base = apiBase();
            const res = await fetch(`${base}/api/chat/conversations/${id}`, {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // If we deleted the active one, start a new conversation
            if (id === conversationId) {
                await startNewConversation();
            } else {
                await loadConversations();
            }
        } catch (e) {
            console.error('[CortexProvider] Failed to delete conversation:', e);
        }
    }, [conversationId, startNewConversation, loadConversations]);

    // ── Load older messages (scroll-up pagination) ──
    const loadMoreMessages = useCallback(async () => {
        if (!conversationId || !hasMoreMessages || isLoadingMore) return;
        setIsLoadingMore(true);
        try {
            const base = apiBase();
            const oldestMessage = messages[0];
            const before = oldestMessage?.timestamp?.toISOString();
            const url = `${base}/api/chat/history?conversationId=${conversationId}&limit=10${before ? `&before=${encodeURIComponent(before)}` : ''}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const older: Message[] = (data.messages || []).map((m: any) => ({
                role: m.role,
                content: m.content,
                timestamp: new Date(m.created_at),
                voiceData: Array.isArray(m.voiceData) ? m.voiceData : undefined,
            }));
            if (older.length > 0) {
                setMessages(prev => [...older, ...prev]);
            }
            setHasMoreMessages(data.hasMore ?? false);
        } catch (e) {
            console.warn('[CortexProvider] Failed to load more messages:', e);
        } finally {
            setIsLoadingMore(false);
        }
    }, [conversationId, hasMoreMessages, isLoadingMore, messages]);

    // ── Persistent Socket.IO connection ──
    useEffect(() => {
        // Strict-mode guard: only connect once
        if (initialised.current) return;
        initialised.current = true;

        // Connect to the Socket.IO backend.
        // - Local: direct to localhost:4000 (the Node.js backend)
        // - Remote: same origin — Cloudflare Tunnel has a path-based ingress
        //   rule that routes /socket.io/* directly to port 4000
        const isLocal = typeof window !== 'undefined' &&
            (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

        const socketUrl = isLocal ? 'http://localhost:4000' : undefined; // undefined = same origin
        const socket: Socket = io(socketUrl as string, {
            path: '/socket.io/',
            reconnectionAttempts: Infinity,   // Backend restarts are normal (self_upgrade, launchd)
            reconnectionDelay: 3000,
            reconnectionDelayMax: 15000,      // Back off to 15s max between retries
        });
        socketRef.current = socket;

        socket.on('connect', () => {
            console.log('[CortexProvider] WebSocket connected:', socket.id);
        });

        socket.on('cortex-artifact', (artifact: CortexArtifact) => {
            console.log('[CortexProvider] Artifact:', artifact.type);

            const type = artifact.type?.trim().toUpperCase();

            // STATUS_UPDATE → system message
            if (type === 'STATUS_UPDATE') {
                const statusData = artifact.data as StatusUpdateData;
                setMessages(prev => [...prev, {
                    role: 'system',
                    content: statusData.message || statusData.status,
                    timestamp: new Date(),
                }]);
                return;
            }

            // READY_FOR_REVIEW → mark thread as ready
            if (type === 'READY_FOR_REVIEW') {
                const threadId = artifact.data?.thread_id;
                console.log('[CortexProvider] READY_FOR_REVIEW received, thread:', threadId);
                if (threadId) {
                    setReadyForReview(prev => new Set(prev).add(threadId));
                } else {
                    console.warn('[CortexProvider] READY_FOR_REVIEW missing thread_id');
                }
                return;
            }

            // All other artifacts become chat messages
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

        // ── Praxis Chat Stream ──
        socket.on('chat-message', (event: ChatMessageEvent) => {
            if (event?.mode && event.mode !== 'praxis') return;
            const incoming = event?.message;
            if (!incoming?.role || !incoming.content) return;

            const nextMessage: Message = {
                id: incoming.id,
                conversation_id: incoming.conversation_id || event.conversationId,
                role: incoming.role,
                content: incoming.content,
                timestamp: incoming.created_at ? new Date(incoming.created_at) : new Date(),
                voiceData: Array.isArray(incoming.voiceData) ? incoming.voiceData : undefined,
                metadata: incoming.metadata,
            };

            setMessages(prev => {
                if (nextMessage.id && prev.some(message => message.id === nextMessage.id)) {
                    return prev;
                }
                return [...prev, nextMessage];
            });
        });

        // ── Antigravity Event Stream ──
        socket.on('ag-event', (event: AgEvent) => {
            console.log('[CortexProvider] AG Event:', event.event_type, event.title);
            setAgEvents(prev => [...prev.slice(-99), event]); // Keep last 100
        });

        socket.on('ag-event-actioned', ({ id }: { id: number }) => {
            setAgEvents(prev => prev.map(e => e.id === id ? { ...e, action_taken: true } : e));
        });

        socket.on('disconnect', () => {
            console.warn('[CortexProvider] WebSocket disconnected');
        });

        socket.on('connect_error', (error: Error) => {
            // Downgraded from console.error — backend restarts are routine
            // (self_upgrade, launchd respawn, model changes). The socket
            // will auto-reconnect with exponential backoff.
            console.warn('[CortexProvider] WebSocket connection failed:', error.message);
        });

        return () => {
            socket.disconnect();
            socketRef.current = null;
            initialised.current = false;
        };
    }, []);

    // ── Hydrate AG events on mount ──
    useEffect(() => {
        const base = apiBase();
        fetch(`${base}/api/ag/events?limit=50`)
            .then(res => res.json())
            .then(data => {
                if (data.events) setAgEvents(data.events);
            })
            .catch(() => { /* silent */ });
    }, []);

    // ── Dismiss AG event callback ──
    const dismissAgEvent = useCallback(async (id: number) => {
        try {
            const base = apiBase();
            await fetch(`${base}/api/ag/events/${id}/action`, { method: 'PUT' });
            setAgEvents(prev => prev.map(e => e.id === id ? { ...e, action_taken: true } : e));
        } catch (e) {
            console.warn('[CortexProvider] Failed to dismiss AG event:', e);
        }
    }, []);

    return (
        <CortexContext.Provider value={{
            messages, setMessages,
            readyForReview, setReadyForReview,
            conversationId, conversations,
            startNewConversation,
            switchConversation: switchConversationFn,
            loadConversations,
            deleteConversation: deleteConversationFn,
            isLoadingHistory,
            hasMoreMessages,
            isLoadingMore,
            loadMoreMessages,
            agEvents,
            dismissAgEvent,
        }}>
            {children}
        </CortexContext.Provider>
    );
}
