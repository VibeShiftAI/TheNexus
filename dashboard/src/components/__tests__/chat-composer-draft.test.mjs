// Unsent chat text survives the composer going away (a reload, or the
// sign-in round trip the connection banner offers after a session expiry) and
// is cleared only by a send the terminal accepted.
import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ChatComposer } from "../chat/composer.tsx";
import { CHAT_DRAFT_KEY } from "../../lib/chat-draft.ts";

const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;

/** Type like a browser: native value setter + bubbling input event (what React 19 listens for). */
function type(input, text) {
    act(() => {
        valueSetter.call(input, text);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
}

function mount(onSend) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
        root.render(
            createElement(ChatComposer, {
                isInline: true,
                isOpen: true,
                loading: false,
                isRecording: false,
                hasAudio: false,
                attachedCount: 0,
                onSend,
            }),
        ),
    );
    return {
        input: () => container.querySelector("textarea"),
        send: () => container.querySelector('button[aria-label="Send message"]'),
        unmount() {
            act(() => root.unmount());
            container.remove();
        },
    };
}

const stored = () => window.sessionStorage.getItem(CHAT_DRAFT_KEY);

test("typed text is mirrored to sessionStorage and a fresh composer restores it", () => {
    window.sessionStorage.removeItem(CHAT_DRAFT_KEY);
    const first = mount(() => true);
    try {
        type(first.input(), "half a thought");
        assert.equal(stored(), "half a thought");
    } finally {
        first.unmount(); // the page goes away without sending
    }
    const second = mount(() => true);
    try {
        assert.equal(second.input().value, "half a thought", "restored on mount");
        type(second.input(), "half a thought, finished");
        assert.equal(stored(), "half a thought, finished");
    } finally {
        second.unmount();
        window.sessionStorage.removeItem(CHAT_DRAFT_KEY);
    }
});

test("a rejected send keeps the draft; an accepted send clears both the box and the stored copy", () => {
    window.sessionStorage.removeItem(CHAT_DRAFT_KEY);
    const sent = [];
    let accept = false;
    const c = mount((text) => {
        sent.push(text);
        return accept;
    });
    try {
        type(c.input(), "do not lose me");
        act(() => c.send().click());
        assert.deepEqual(sent, ["do not lose me"]);
        assert.equal(c.input().value, "do not lose me", "rejected: still in the box");
        assert.equal(stored(), "do not lose me", "and still stored");

        accept = true;
        act(() => c.send().click());
        assert.deepEqual(sent, ["do not lose me", "do not lose me"], "one send per click, no duplicate");
        assert.equal(c.input().value, "");
        assert.equal(stored(), null, "accepted: nothing left to restore");
    } finally {
        c.unmount();
    }
});

test("text dropped in by nexus:chat-seed is a draft too", () => {
    window.sessionStorage.removeItem(CHAT_DRAFT_KEY);
    const c = mount(() => true);
    try {
        act(() => {
            window.dispatchEvent(new window.CustomEvent("nexus:chat-seed", { detail: { text: "chat about this note" } }));
        });
        assert.equal(c.input().value, "chat about this note");
        assert.equal(stored(), "chat about this note");
    } finally {
        c.unmount();
        window.sessionStorage.removeItem(CHAT_DRAFT_KEY);
    }
});
