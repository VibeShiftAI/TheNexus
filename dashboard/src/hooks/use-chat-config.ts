"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
    subscribeChatConfig,
    getChatConfigState,
    loadChatConfig,
    applyChatConfig,
    type ChatConfigState,
} from "@/lib/chat-config-store";

export interface UseChatConfig extends ChatConfigState {
    /** Save a partial update. Resolves to the server's config, or null if the write failed. */
    apply: typeof applyChatConfig;
    /** Re-read from the server (e.g. when the settings modal opens). */
    reload: typeof loadChatConfig;
}

/**
 * Subscribe to the shared chat-config store (see `@/lib/chat-config-store`).
 * Every mounted consumer sees the same snapshot, so a save in the settings
 * modal repaints the MAIN VIEWER header control immediately and vice versa.
 *
 * `reloadKey` re-fetches whenever it changes to a truthy value — pass the
 * modal's `isOpen` to refresh on open, or leave it out to load once on mount.
 */
export function useChatConfig(reloadKey: unknown = true): UseChatConfig {
    const state = useSyncExternalStore(subscribeChatConfig, getChatConfigState, getChatConfigState);

    useEffect(() => {
        if (!reloadKey) return;
        void loadChatConfig();
    }, [reloadKey]);

    return { ...state, apply: applyChatConfig, reload: loadChatConfig };
}
