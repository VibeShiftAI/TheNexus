"use client"

import { createContext, useContext, useState, useEffect, useRef, ReactNode, Dispatch, SetStateAction } from "react";
import { io, Socket } from "socket.io-client";

// ────────────────────────────────────────────────────────────
// Shared types (also used by ai-terminal.tsx)
// ────────────────────────────────────────────────────────────

export interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
    artifact?: CortexArtifact;
    voiceData?: { audio: string; mimeType: string }[];
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
// Context shape
// ────────────────────────────────────────────────────────────

interface CortexContextValue {
    messages: Message[];
    setMessages: Dispatch<SetStateAction<Message[]>>;
    readyForReview: Set<string>;
    setReadyForReview: Dispatch<SetStateAction<Set<string>>>;
}

const CortexContext = createContext<CortexContextValue | null>(null);

export function useCortex(): CortexContextValue {
    const ctx = useContext(CortexContext);
    if (!ctx) throw new Error("useCortex must be used within <CortexProvider>");
    return ctx;
}

// ────────────────────────────────────────────────────────────
// Provider — owns the Socket.IO connection for the app lifetime
// ────────────────────────────────────────────────────────────

export function CortexProvider({ children }: { children: ReactNode }) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [readyForReview, setReadyForReview] = useState<Set<string>>(new Set());
    const socketRef = useRef<Socket | null>(null);
    const initialised = useRef(false);

    // ── Rehydrate persisted chat history on mount ──
    useEffect(() => {
        const stored = localStorage.getItem('cortex_chat_history');
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                const restored = parsed.map((m: any) => ({
                    ...m,
                    timestamp: new Date(m.timestamp)
                }));
                setMessages(restored);
            } catch (e) {
                console.warn('[CortexProvider] Failed to restore chat history:', e);
            }
        }

        // Check for pending Cortex state (rehydration)
        const lastThreadId = localStorage.getItem('cortex_thread_id');
        if (lastThreadId) {
            fetch(`/api/terminal/state/${lastThreadId}`)
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

    // ── Persist messages to localStorage ──
    useEffect(() => {
        if (messages.length > 0) {
            localStorage.setItem('cortex_chat_history', JSON.stringify(messages.slice(-100)));
        }
    }, [messages]);

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
            reconnectionAttempts: 5,
            reconnectionDelay: 3000,
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

        socket.on('disconnect', () => {
            console.warn('[CortexProvider] WebSocket disconnected');
        });

        socket.on('connect_error', (error: Error) => {
            console.error('[CortexProvider] WebSocket connection failed:', error.message);
        });

        return () => {
            socket.disconnect();
            socketRef.current = null;
            initialised.current = false;
        };
    }, []);

    return (
        <CortexContext.Provider value={{ messages, setMessages, readyForReview, setReadyForReview }}>
            {children}
        </CortexContext.Provider>
    );
}
