import test from "node:test";
import assert from "node:assert/strict";

import { CHAT_DRAFT_KEY, clearChatDraft, readChatDraft, writeChatDraft } from "../chat-draft";

function mapStorage() {
    const m = new Map<string, string>();
    return {
        m,
        storage: {
            getItem: (k: string) => m.get(k) ?? null,
            setItem: (k: string, v: string) => void m.set(k, v),
            removeItem: (k: string) => void m.delete(k),
        },
    };
}

test("a draft round-trips; an empty write removes the key instead of storing an empty string", () => {
    const { m, storage } = mapStorage();
    assert.equal(readChatDraft(storage), "");
    writeChatDraft("half-typed message", storage);
    assert.equal(m.get(CHAT_DRAFT_KEY), "half-typed message");
    assert.equal(readChatDraft(storage), "half-typed message");
    writeChatDraft("", storage);
    assert.equal(m.has(CHAT_DRAFT_KEY), false);
    writeChatDraft("again", storage);
    clearChatDraft(storage);
    assert.equal(m.has(CHAT_DRAFT_KEY), false);
});

test("a storage that throws (disabled, quota) never breaks typing: reads return empty, writes are swallowed", () => {
    const broken = {
        getItem: () => {
            throw new Error("SecurityError");
        },
        setItem: () => {
            throw new Error("QuotaExceededError");
        },
        removeItem: () => {
            throw new Error("SecurityError");
        },
    };
    assert.equal(readChatDraft(broken), "");
    assert.doesNotThrow(() => writeChatDraft("x", broken));
    assert.doesNotThrow(() => clearChatDraft(broken));
    assert.equal(readChatDraft(null), "");
    assert.doesNotThrow(() => writeChatDraft("x", null));
});

test("the default storage is the window's sessionStorage (dies with the tab, survives a same-tab navigation)", () => {
    window.sessionStorage.removeItem(CHAT_DRAFT_KEY);
    writeChatDraft("kept across the sign-in round trip");
    assert.equal(window.sessionStorage.getItem(CHAT_DRAFT_KEY), "kept across the sign-in round trip");
    assert.equal(readChatDraft(), "kept across the sign-in round trip");
    clearChatDraft();
    assert.equal(window.sessionStorage.getItem(CHAT_DRAFT_KEY), null);
});
