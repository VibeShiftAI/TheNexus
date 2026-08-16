"use client"

import { createContext, useContext, useState, useEffect, useRef, ReactNode, Dispatch, SetStateAction, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Pause, Play, Volume2, X } from "lucide-react";
import { reportClientActivity } from "@/lib/active-client";
import type { ChatAudioItem } from "@/lib/chat-audio";

// ────────────────────────────────────────────────────────────
// Shared types (also used by ai-terminal.tsx)
// ────────────────────────────────────────────────────────────

export interface MessageAttachment {
    type: string;
    url?: string;
    name?: string;
    mimeType?: string;
    kind?: string;
    durationMs?: number;
}

export interface Message {
    id?: string;
    conversation_id?: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    artifact?: CortexArtifact;
    voiceData?: { audio: string; mimeType: string }[];
    attachments?: MessageAttachment[];
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
        attachments?: MessageAttachment[];
    };
}

/** Top-level attachments first (the server hoists them), metadata fallback. */
function mapAttachments(source: {
    attachments?: unknown;
    metadata?: Record<string, any>;
}): MessageAttachment[] | undefined {
    const fromTop = Array.isArray(source.attachments) ? source.attachments : undefined;
    const fromMeta = Array.isArray(source.metadata?.attachments) ? source.metadata!.attachments : undefined;
    const attachments = fromTop ?? fromMeta;
    return attachments && attachments.length > 0 ? attachments : undefined;
}

// ────────────────────────────────────────────────────────────
// Context shape
// ────────────────────────────────────────────────────────────

export interface ChatAudioNowPlaying {
    item: ChatAudioItem;
    playing: boolean;
    currentTime: number;
    duration: number;
}

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
    // Global chat audio: the element lives HERE (root layout), so playback
    // survives route changes — opening the fullscreen inbox used to unmount
    // AITerminal's inline <audio> mid-briefing (Robert, 2026-08-16).
    chatAudio: ChatAudioNowPlaying | null;
    playChatAudio: (item: ChatAudioItem) => void;
    toggleChatAudio: (item: ChatAudioItem) => void;
    pauseChatAudio: () => void;
    stopChatAudio: () => void;
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
        attachments: mapAttachments(m ?? {}),
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
                attachments: mapAttachments(incoming),
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
            if (document.visibilityState === 'visible') {
                void resyncActiveConversation('visible');
                reportClientActivity();
            }
        };
        const onFocus = () => {
            void resyncActiveConversation('focus');
            reportClientActivity();
        };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onFocus);

        // Last-active-location heartbeat (see lib/active-client.ts): real user
        // input marks THIS device as where Robert is working, which is where
        // voice announcements auto-play. Throttled inside the lib.
        const onUserInput = () => reportClientActivity();
        window.addEventListener('pointerdown', onUserInput, { passive: true });
        window.addEventListener('keydown', onUserInput, { passive: true });
        if (document.visibilityState === 'visible' && document.hasFocus()) reportClientActivity();

        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('pointerdown', onUserInput);
            window.removeEventListener('keydown', onUserInput);
            socket.disconnect();
            socketRef.current = null;
            initialised.current = false;
        };
    }, [resyncActiveConversation]);

    // ── Global chat audio engine ────────────────────────────────
    // A single detached HTMLAudioElement owned by the provider (root layout):
    // it is never part of any page's React subtree, so navigating between /
    // and /inbox cannot interrupt playback.
    const [chatAudio, setChatAudio] = useState<ChatAudioNowPlaying | null>(null);
    const chatAudioElRef = useRef<HTMLAudioElement | null>(null);
    const chatAudioItemRef = useRef<ChatAudioItem | null>(null);

    const ensureChatAudioEl = useCallback((): HTMLAudioElement => {
        if (!chatAudioElRef.current) {
            const el = new Audio();
            el.preload = "metadata";
            el.addEventListener("loadedmetadata", () => {
                setChatAudio(prev => prev ? { ...prev, duration: Number.isFinite(el.duration) ? el.duration : 0 } : prev);
            });
            el.addEventListener("timeupdate", () => {
                setChatAudio(prev => prev ? {
                    ...prev,
                    currentTime: el.currentTime,
                    duration: Number.isFinite(el.duration) ? el.duration : prev.duration,
                } : prev);
            });
            el.addEventListener("play", () => {
                setChatAudio(prev => (prev ? { ...prev, playing: true } : prev));
            });
            el.addEventListener("pause", () => {
                setChatAudio(prev => (prev ? { ...prev, playing: false } : prev));
            });
            el.addEventListener("ended", () => {
                setChatAudio(prev => (prev ? { ...prev, playing: false } : prev));
            });
            chatAudioElRef.current = el;
        }
        return chatAudioElRef.current;
    }, []);

    const playChatAudio = useCallback((item: ChatAudioItem) => {
        const el = ensureChatAudioEl();
        if (chatAudioItemRef.current?.key !== item.key) {
            el.src = item.src;
            chatAudioItemRef.current = item;
            setChatAudio({ item, playing: false, currentTime: 0, duration: 0 });
        }
        void el.play().catch(() => { /* autoplay blocked — controls remain */ });
    }, [ensureChatAudioEl]);

    const toggleChatAudio = useCallback((item: ChatAudioItem) => {
        const el = ensureChatAudioEl();
        if (chatAudioItemRef.current?.key === item.key && !el.paused) {
            el.pause();
            return;
        }
        playChatAudio(item);
    }, [ensureChatAudioEl, playChatAudio]);

    const pauseChatAudio = useCallback(() => {
        chatAudioElRef.current?.pause();
    }, []);

    const stopChatAudio = useCallback(() => {
        const el = chatAudioElRef.current;
        if (el) {
            el.pause();
            el.removeAttribute("src");
            el.load();
        }
        chatAudioItemRef.current = null;
        setChatAudio(null);
    }, []);

    const seekChatAudio = useCallback((seconds: number) => {
        const el = chatAudioElRef.current;
        if (el && Number.isFinite(seconds)) el.currentTime = Math.max(0, seconds);
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
            chatAudio,
            playChatAudio,
            toggleChatAudio,
            pauseChatAudio,
            stopChatAudio,
        }}>
            {children}
            <GlobalAudioMiniPlayer
                nowPlaying={chatAudio}
                onToggle={toggleChatAudio}
                onStop={stopChatAudio}
                onSeek={seekChatAudio}
            />
        </CortexContext.Provider>
    );
}

function formatAudioClock(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const whole = Math.floor(seconds);
    const mins = Math.floor(whole / 60);
    const secs = String(whole % 60).padStart(2, "0");
    return `${mins}:${secs}`;
}

/**
 * Slim always-on-top player shown while chat audio is loaded. Rendered by
 * the provider (root layout), so it follows Robert onto /inbox and keeps the
 * briefing controllable while he reads the full task list.
 */
function GlobalAudioMiniPlayer({
    nowPlaying,
    onToggle,
    onStop,
    onSeek,
}: {
    nowPlaying: ChatAudioNowPlaying | null;
    onToggle: (item: ChatAudioItem) => void;
    onStop: () => void;
    onSeek: (seconds: number) => void;
}) {
    if (!nowPlaying) return null;
    const { item, playing, currentTime, duration } = nowPlaying;
    const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
    return (
        <div className="fixed bottom-4 right-4 z-[90] flex items-center gap-3 rounded-lg border border-cyan-500/30 bg-slate-900/95 px-3 py-2 shadow-[0_0_18px_rgba(34,211,238,0.15)] backdrop-blur">
            <button
                onClick={() => onToggle(item)}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-500/40 text-cyan-300 transition hover:bg-cyan-500/20"
                title={playing ? "Pause" : "Play"}
                aria-label={playing ? "Pause" : "Play"}
            >
                {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
            </button>
            <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                    <Volume2 size={11} className={playing ? "text-cyan-400 animate-pulse" : "text-cyan-400/60"} />
                    <span className="max-w-[190px] truncate text-[10px] font-bold uppercase tracking-wider text-cyan-300">
                        {item.name}
                    </span>
                </div>
                <div
                    className="mt-1.5 h-1 w-[220px] cursor-pointer rounded-full bg-slate-700/70"
                    onClick={(e) => {
                        if (duration <= 0) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        onSeek(((e.clientX - rect.left) / rect.width) * duration);
                    }}
                    role="slider"
                    aria-label="Seek"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(duration)}
                    aria-valuenow={Math.round(currentTime)}
                >
                    <div className="h-1 rounded-full bg-cyan-400/80" style={{ width: `${progress}%` }} />
                </div>
                <div className="mt-0.5 text-[9px] tabular-nums text-slate-400">
                    {formatAudioClock(currentTime)} / {formatAudioClock(duration)}
                </div>
            </div>
            <button
                onClick={onStop}
                className="rounded p-1 text-slate-500 transition hover:bg-red-500/20 hover:text-red-400"
                title="Stop and dismiss"
                aria-label="Stop and dismiss"
            >
                <X size={12} />
            </button>
        </div>
    );
}
