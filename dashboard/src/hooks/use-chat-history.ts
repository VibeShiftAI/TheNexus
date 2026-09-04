"use client";

/**
 * useChatHistory — transcript scrollback: the DOM render window, stick-to-
 * bottom, scroll-position compensation for prepends, scroll-to-top reveal
 * before network pagination, and the conversation-history panel toggle.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03). Message
 * PERSISTENCE itself lives in CortexProvider — this hook owns what the
 * terminal shows of it and where the viewport sits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Message } from "@/components/cortex-provider";

// ── Transcript DOM window (2026-08-28) ──
// The provider's message array is unbounded (a day of socket appends on top
// of the 30-message mount tail), but the DOM doesn't have to be: only the
// newest RENDER_WINDOW messages stay mounted once the transcript is trimmed.
// Scrolling to the top reveals REVEAL_PAGE already-loaded messages at a time
// before any network pagination, the trim only ever happens while the view
// is pinned to the bottom (never under a reader), and the slack batches
// trims so streaming appends don't re-trim per message.
export const RENDER_WINDOW = 200;
export const RENDER_WINDOW_SLACK = 40;
export const REVEAL_PAGE = 100;

/** Stable transcript row identity: server/optimistic ids when present;
 *  id-less local rows (error banners, approval notes) fall back to
 *  timestamp+role. Stable keys are what let pagination prepends and DOM
 *  window shifts reuse the memoized markdown rows instead of re-parsing
 *  every message below the splice point. */
export function messageKey(msg: Message): string {
    return msg.id ?? `local-${msg.timestamp.getTime()}-${msg.role}`;
}

export interface UseChatHistoryOptions {
    messages: Message[];
    conversationId: string | null;
    isOpen: boolean;
    isLoadingHistory: boolean;
    hasMoreMessages: boolean;
    isLoadingMore: boolean;
    loadMoreMessages: () => void;
    loadConversations: () => void;
}

export interface ChatHistoryApi {
    messagesContainerRef: React.RefObject<HTMLDivElement | null>;
    visibleMessages: Message[];
    hiddenMessageCount: number;
    handleMessagesScroll: () => void;
    jumpToBottom: () => void;
    showConversations: boolean;
    setShowConversations: React.Dispatch<React.SetStateAction<boolean>>;
    /** Flip the history panel, loading the conversation list when opening. */
    toggleConversations: () => void;
}

export function useChatHistory({
    messages,
    conversationId,
    isOpen,
    isLoadingHistory,
    hasMoreMessages,
    isLoadingMore,
    loadMoreMessages,
    loadConversations,
}: UseChatHistoryOptions): ChatHistoryApi {
    // Transcript DOM window: number of messages hidden at the HEAD of the
    // list. Anchoring the window by its head means appends never slide it
    // under a reader — the window only trims (hiddenCount grows) while the
    // view is pinned to the bottom, and scrolling up reveals from memory
    // before paginating over the network.
    const [hiddenCount, setHiddenCount] = useState(0);
    // Stale-guard: after a conversation switch the count may briefly exceed
    // the fresh (shorter) list until the reset effect below runs.
    const hiddenMessageCount = hiddenCount < messages.length ? hiddenCount : 0;
    const visibleMessages = useMemo(
        () => hiddenMessageCount > 0 ? messages.slice(hiddenMessageCount) : messages,
        [messages, hiddenMessageCount],
    );
    useEffect(() => {
        setHiddenCount(0);
    }, [conversationId]);

    const [showConversations, setShowConversations] = useState(false); // Conversation history panel
    const toggleConversations = useCallback(() => {
        setShowConversations((prev) => {
            const next = !prev;
            if (next) loadConversations();
            return next;
        });
    }, [loadConversations]);

    const messagesContainerRef = useRef<HTMLDivElement>(null);

    // Track previous message count to detect newly prepended messages
    const prevMessageCountRef = useRef(messages.length);
    const prevScrollHeightRef = useRef(0);
    // Stick-to-bottom: true while the user is at (or near) the newest message.
    // Appends and streaming growth keep the view pinned only in that state —
    // reading older history is never yanked back down.
    const isNearBottomRef = useRef(true);

    const jumpToBottom = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        // Markdown/images settle after first paint — re-pin once layout grows.
        requestAnimationFrame(() => {
            if (messagesContainerRef.current) {
                messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
            }
        });
        isNearBottomRef.current = true;
    }, []);

    // Open at the LATEST message: pin to the bottom when history finishes
    // loading and whenever the conversation changes or the terminal opens.
    // (The old count-diff effect initialized its ref to the mounted length,
    // so a terminal mounting with history already loaded never scrolled —
    // it sat at the top and the newest status was off-screen.)
    useEffect(() => {
        if (isLoadingHistory) return;
        jumpToBottom();
        const settle = setTimeout(jumpToBottom, 150);
        return () => clearTimeout(settle);
    }, [isLoadingHistory, conversationId, isOpen, jumpToBottom]);

    // Trim the DOM window only while pinned to the newest message, and only
    // once the overflow clears the slack — never mid-scrollback (a reader's
    // messages must not vanish above them), never per-append.
    useEffect(() => {
        if (!isNearBottomRef.current) return;
        if (messages.length - hiddenMessageCount > RENDER_WINDOW + RENDER_WINDOW_SLACK) {
            setHiddenCount(messages.length - RENDER_WINDOW);
        }
    }, [messages, hiddenMessageCount]);

    // Auto-scroll on new messages appended to bottom (not when prepending
    // older ones). Tracks the VISIBLE window: pagination prepends and
    // scroll-up reveals both grow its head and get the same scroll
    // compensation.
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        const newCount = visibleMessages.length;
        const prevCount = prevMessageCountRef.current;
        if (newCount > prevCount) {
            // Check if messages were prepended (older messages loaded) or appended (new messages)
            const wereMessagesPrepended = prevCount > 0 && prevScrollHeightRef.current > 0;
            if (wereMessagesPrepended && container.scrollTop < 100) {
                // Messages were prepended — preserve scroll position
                const newScrollHeight = container.scrollHeight;
                const scrollDelta = newScrollHeight - prevScrollHeightRef.current;
                container.scrollTop = scrollDelta;
            } else if (isNearBottomRef.current) {
                // Messages were appended while pinned — follow to bottom.
                container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            }
        } else if (isNearBottomRef.current) {
            // Same count but content grew (streaming deltas into the last
            // message) — keep the growing reply in view, no smooth jitter.
            // Also covers the window trim above: fewer rows while pinned
            // still means "stay pinned to the newest".
            container.scrollTop = container.scrollHeight;
        }
        prevMessageCountRef.current = newCount;
        prevScrollHeightRef.current = container.scrollHeight;
    }, [visibleMessages]);

    // Scroll-to-top detection: first reveal already-loaded messages hidden
    // by the DOM window, then fall through to network pagination.
    const handleMessagesScroll = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        // Track whether the user is at the newest message (stick-to-bottom).
        isNearBottomRef.current =
            container.scrollHeight - container.scrollTop - container.clientHeight < 120;
        // When scrolled near the top (within 50px), reveal or load more
        if (container.scrollTop < 50) {
            if (hiddenMessageCount > 0) {
                prevScrollHeightRef.current = container.scrollHeight;
                setHiddenCount(Math.max(0, hiddenMessageCount - REVEAL_PAGE));
            } else if (hasMoreMessages && !isLoadingMore) {
                prevScrollHeightRef.current = container.scrollHeight;
                loadMoreMessages();
            }
        }
    }, [hiddenMessageCount, hasMoreMessages, isLoadingMore, loadMoreMessages]);

    return {
        messagesContainerRef,
        visibleMessages,
        hiddenMessageCount,
        handleMessagesScroll,
        jumpToBottom,
        showConversations,
        setShowConversations,
        toggleConversations,
    };
}
