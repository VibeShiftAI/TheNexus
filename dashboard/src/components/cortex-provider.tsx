"use client"

import { createContext, useContext, useState, useEffect, useRef, ReactNode, Dispatch, SetStateAction, useCallback } from "react";
import { io, Socket } from "socket.io-client";

// ────────────────────────────────────────────────────────────
// Shared types (also used by ai-terminal.tsx)
// ────────────────────────────────────────────────────────────

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

function mapStoredMessage(m: any): Message {
    return {
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role,
        content: m.content,
        timestamp: new Date(m.created_at),
        voiceData: Array.isArray(m.voiceData) ? m.voiceData : undefined,
        metadata: m.metadata,
    };
}

/**
 * Merge a freshly fetched tail of the active conversation into the local
 * message list — the reconnect/visibility catch-up. Messages we don't
 * already hold are merged in CHRONOLOGICAL position: dedup by server id when
 * present, then by exact (role, content) so optimistic local copies
 * (in-flight sends, streamed replies that never got an id) aren't
 * duplicated.
 *
 * Position matters: the fetched window can be LONGER than what we hold (the
 * mount fetch is a shorter tail than the resync fetch), so additions may be
 * OLDER than existing messages. Blind appending put yesterday's messages at
 * the bottom of the chat after a tab refocus — newest messages stranded
 * mid-list until a hard reload (2026-07-10). The sort is stable: equal
 * timestamps keep their existing relative order, and messages without one
 * (optimistic local sends) sink to the newest end.
 */
export function mergeFetchedMessages(prev: Message[], fetched: Message[]): Message[] {
    if (fetched.length === 0) return prev;
    if (prev.length === 0) return fetched;
    const ids = new Set(prev.map(m => m.id).filter(Boolean));
    const bodies = new Set(prev.map(m => `${m.role}\u0000${m.content}`));
    const additions = fetched.filter(m =>
        !(m.id && ids.has(m.id)) && !bodies.has(`${m.role}\u0000${m.content}`)
    );
    if (additions.length === 0) return prev;
    const at = (m: Message) =>
        m.timestamp instanceof Date && !Number.isNaN(m.timestamp.getTime())
            ? m.timestamp.getTime()
            : Number.MAX_SAFE_INTEGER;
    return [...prev, ...additions].sort((a, b) => at(a) - at(b));
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
    const socketRef = useRef<Socket | null>(null);
    const initialised = useRef(false);
    // Current conversation id for the resync closure (socket handlers are
    // registered once with empty deps, so state must ride a ref).
    const conversationIdRef = useRef<string | null>(null);
    useEffect(() => {
        conversationIdRef.current = conversationId;
    }, [conversationId]);
    const lastResyncAtRef = useRef(0);

    // ── Catch-up resync ──
    // The socket drops whenever the backend restarts (Praxis kickstarts are
    // routine) and whenever the tab sleeps — anything emitted in that window
    // is gone from the UI until a manual reload. This re-fetches the active
    // conversation's tail and merges the missed messages in. Called on every
    // socket (re)connect and whenever the tab becomes visible again.
    const resyncActiveConversation = useCallback(async (reason: string) => {
        const now = Date.now();
        if (now - lastResyncAtRef.current < 4000) return; // connect+focus often fire together
        lastResyncAtRef.current = now;
        try {
            const base = apiBase();
            const res = await fetch(`${base}/api/chat/active?mode=praxis&limit=30`);
            if (!res.ok) return;
            const data = await res.json();
            if (!data.conversation) return;
            const fetched: Message[] = (data.messages || []).map(mapStoredMessage);
            if (conversationIdRef.current && conversationIdRef.current === data.conversation.id) {
                setMessages(prev => {
                    const merged = mergeFetchedMessages(prev, fetched);
                    if (merged !== prev) {
                        console.log(`[CortexProvider] Resync (${reason}): caught up ${merged.length - prev.length} missed message(s)`);
                    }
                    return merged;
                });
            } else {
                // The active conversation changed while we were away (started
                // from mobile / another surface) — adopt it wholesale.
                console.log(`[CortexProvider] Resync (${reason}): active conversation changed — reloading`);
                setConversationId(data.conversation.id);
                setMessages(fetched);
                setHasMoreMessages(data.hasMore ?? false);
            }
        } catch (e) {
            console.warn('[CortexProvider] Resync failed:', e);
        }
    }, []);

    // ── Fetch active conversation + history from server on mount ──
    useEffect(() => {
        const base = apiBase();

        async function loadActiveConversation() {
            try {
                setIsLoadingHistory(true);
                // Same window as the focus/reconnect resync (limit=30) — a
                // shorter mount tail is what let the resync surface OLDER
                // messages as "additions" in the first place.
                const res = await fetch(`${base}/api/chat/active?mode=praxis&limit=30`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (data.conversation) {
                    setConversationId(data.conversation.id);
                    setMessages((data.messages || []).map(mapStoredMessage));
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
            setMessages((data.messages || []).map(mapStoredMessage));
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
            const older: Message[] = (data.messages || []).map(mapStoredMessage);
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

        let hadConnected = false;
        socket.on('connect', () => {
            console.log('[CortexProvider] WebSocket connected:', socket.id);
            // A REconnect means we were deaf for a while (backend restart,
            // network blip) — catch up on whatever was said in the gap.
            if (hadConnected) void resyncActiveConversation('reconnect');
            hadConnected = true;
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
            // Only append messages for the conversation on screen — events
            // for other conversations would silently corrupt the view.
            const eventConversation = incoming.conversation_id || event.conversationId;
            if (eventConversation && conversationIdRef.current && eventConversation !== conversationIdRef.current) {
                return;
            }

            // Status report landed → tint the bridge header its condition
            // color (bridge-fx). Presentation-only, fires regardless of which
            // conversation is on screen.
            const meta = incoming.metadata as { eventType?: string; condition?: string } | undefined;
            if (meta?.eventType === 'status_report_ready' && typeof meta.condition === 'string') {
                import("@/components/bridge/bridge-fx")
                    .then(({ dispatchStatusCondition }) => dispatchStatusCondition(meta.condition!))
                    .catch(() => { /* presentation only */ });
            }

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

        socket.on('disconnect', () => {
            console.warn('[CortexProvider] WebSocket disconnected');
        });

        socket.on('connect_error', (error: Error) => {
            // Downgraded from console.error — backend restarts are routine
            // (self_upgrade, launchd respawn, model changes). The socket
            // will auto-reconnect with exponential backoff.
            console.warn('[CortexProvider] WebSocket connection failed:', error.message);
        });

        // Sleeping tabs miss socket traffic even without a formal disconnect
        // (throttled timers, suspended laptops) — resync whenever the tab
        // comes back into view or focus. Throttled inside resync, so the
        // visibility+focus double-fire costs one fetch.
        const onVisible = () => {
            if (document.visibilityState === 'visible') void resyncActiveConversation('visible');
        };
        const onFocus = () => void resyncActiveConversation('focus');
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onFocus);

        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onFocus);
            socket.disconnect();
            socketRef.current = null;
            initialised.current = false;
        };
    }, [resyncActiveConversation]);

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
        }}>
            {children}
        </CortexContext.Provider>
    );
}
