// Test stand-in for @/components/cortex-provider: a controllable external
// store behind the same useCortex() surface, so ai-terminal tests can push
// messages (streaming, resync inserts, pagination prepends) from outside
// React. mergeFetchedMessages is re-exported from the REAL provider so its
// behavior stays under test, not stubbed.
import { useSyncExternalStore, useCallback } from "react";

export { mergeFetchedMessages } from "../../src/components/cortex-provider.tsx";

const listeners = new Set();
const state = {
    messages: [],
    hasMoreMessages: true,
    isLoadingMore: false,
    isLoadingHistory: false,
    conversationId: "test-conversation",
    loadMoreCalls: 0,
};

function emit() {
    for (const listener of listeners) listener();
}

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Test-side controls — not part of the real provider surface. */
export const cortexTestStore = {
    reset(messages = []) {
        state.messages = messages;
        state.hasMoreMessages = true;
        state.isLoadingMore = false;
        state.loadMoreCalls = 0;
        emit();
    },
    get messages() {
        return state.messages;
    },
    set(messages) {
        state.messages = messages;
        emit();
    },
    update(fn) {
        state.messages = fn(state.messages);
        emit();
    },
    setHasMore(value) {
        state.hasMoreMessages = value;
        emit();
    },
    get loadMoreCalls() {
        return state.loadMoreCalls;
    },
};

const noop = () => {};
const asyncNoop = async () => {};
const EMPTY_SET = new Set();

export function useCortex() {
    const messages = useSyncExternalStore(subscribe, () => state.messages);
    const hasMoreMessages = useSyncExternalStore(subscribe, () => state.hasMoreMessages);
    const setMessages = useCallback((next) => {
        state.messages = typeof next === "function" ? next(state.messages) : next;
        emit();
    }, []);
    const loadMoreMessages = useCallback(async () => {
        state.loadMoreCalls += 1;
    }, []);
    return {
        messages,
        setMessages,
        readyForReview: EMPTY_SET,
        setReadyForReview: noop,
        conversationId: state.conversationId,
        conversations: [],
        startNewConversation: asyncNoop,
        switchConversation: asyncNoop,
        loadConversations: asyncNoop,
        deleteConversation: asyncNoop,
        isLoadingHistory: state.isLoadingHistory,
        hasMoreMessages,
        isLoadingMore: state.isLoadingMore,
        loadMoreMessages,
        chatAudio: null,
        playChatAudio: noop,
        toggleChatAudio: noop,
        pauseChatAudio: noop,
        stopChatAudio: noop,
    };
}
