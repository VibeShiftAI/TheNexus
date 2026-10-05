/**
 * chat-draft: keep the composer's unsent text across a reload or the sign-in
 * round trip the connection banner offers when a session has expired.
 *
 * sessionStorage on purpose: it survives a navigation and a reload within the
 * same tab (the reauth path is a top-level navigation back to this URL), it is
 * not shared with other tabs, and it dies with the tab, so an abandoned draft
 * does not reappear days later. Every call is wrapped: a WebView with storage
 * disabled, or a quota error, must never break typing.
 */

export const CHAT_DRAFT_KEY = "nexus:chat-draft";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): DraftStorage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

export function readChatDraft(storage: DraftStorage | null = defaultStorage()): string {
    try {
        return storage?.getItem(CHAT_DRAFT_KEY) ?? "";
    } catch {
        return "";
    }
}

/** Persist the current text; an empty draft removes the key. */
export function writeChatDraft(text: string, storage: DraftStorage | null = defaultStorage()): void {
    try {
        if (text) storage?.setItem(CHAT_DRAFT_KEY, text);
        else storage?.removeItem(CHAT_DRAFT_KEY);
    } catch {
        /* storage unavailable or full: the draft only lives in React state */
    }
}

export function clearChatDraft(storage: DraftStorage | null = defaultStorage()): void {
    writeChatDraft("", storage);
}
