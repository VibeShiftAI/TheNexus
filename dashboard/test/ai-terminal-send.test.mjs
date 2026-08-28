// End-to-end send paths through the extracted composer: plain text, Enter
// (Shift+Enter excluded), attached files, the voice-memo path, and the
// external nexus:chat-seed fill-the-input event. fetch is mocked; the
// component logic (upload, base64 audio, optimistic append, input clearing)
// is real.
import test from "node:test";
import assert from "node:assert/strict";

import {
    loadFixtureMessages,
    mountTerminal,
    findComposerInput,
    typeCharacter,
    pressKey,
    act,
    cortexTestStore,
} from "./helpers.mjs";

function installFetchMock() {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const entry = { url: String(url), init };
        calls.push(entry);
        if (entry.url.includes("/api/chat/files/upload")) {
            return {
                ok: true,
                json: async () => ({
                    fileId: "file-1",
                    url: "/api/chat/files/file-1",
                    mimeType: "text/plain",
                    originalName: "notes.txt",
                    size: 3,
                }),
            };
        }
        return {
            ok: true,
            headers: { get: () => "application/json" },
            json: async () => ({ response: "Acknowledged.", assistantMessageId: "srv-reply-1" }),
        };
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

function chatCalls(calls) {
    return calls.filter((c) => c.url.includes("/api/ai/chat"));
}

test("plain text send: optimistic append, POST body, reply, input cleared", async () => {
    const { calls, restore } = installFetchMock();
    const { container, unmount } = mountTerminal(loadFixtureMessages().slice(-20));
    try {
        const input = findComposerInput(container);
        for (const c of "hello praxis") typeCharacter(input, c);

        await act(async () => {
            container.querySelector('button[aria-label="Send message"]').click();
        });
        await settle();

        const sent = chatCalls(calls);
        assert.equal(sent.length, 1, "one chat POST");
        const body = JSON.parse(sent[0].init.body);
        assert.equal(body.message, "hello praxis");
        assert.equal(body.mode, "praxis");
        assert.equal(input.value, "", "input cleared after accepted send");
        const stored = cortexTestStore.messages;
        assert.ok(stored.some((m) => m.role === "user" && m.content === "hello praxis"), "optimistic user message appended");
        assert.ok(stored.some((m) => m.id === "srv-reply-1" && m.content === "Acknowledged."), "assistant reply appended");
    } finally {
        unmount();
        restore();
    }
});

test("Enter sends; Shift+Enter does not", async () => {
    const { calls, restore } = installFetchMock();
    const { container, unmount } = mountTerminal(loadFixtureMessages().slice(-20));
    try {
        const input = findComposerInput(container);
        for (const c of "enter send") typeCharacter(input, c);

        pressKey(input, "Enter", { shiftKey: true });
        await settle();
        assert.equal(chatCalls(calls).length, 0, "Shift+Enter did not send");
        assert.equal(input.value, "enter send", "draft kept after Shift+Enter");

        pressKey(input, "Enter");
        await settle();
        assert.equal(chatCalls(calls).length, 1, "Enter sent the message");
        assert.equal(JSON.parse(chatCalls(calls)[0].init.body).message, "enter send");
        assert.equal(input.value, "", "input cleared");
    } finally {
        unmount();
        restore();
    }
});

test("nexus:chat-seed fills and focuses the composer input", () => {
    const { container, unmount } = mountTerminal(loadFixtureMessages().slice(-20));
    try {
        const input = findComposerInput(container);
        act(() => {
            globalThis.window.dispatchEvent(
                new globalThis.window.CustomEvent("nexus:chat-seed", { detail: { text: "chat about this note" } }),
            );
        });
        assert.equal(input.value, "chat about this note", "seed text landed in the input");
        assert.equal(globalThis.document.activeElement, input, "seed event focused the composer input");
    } finally {
        unmount();
    }
});

test("attached file rides the send: upload + inline text content", async () => {
    const { calls, restore } = installFetchMock();
    const { container, unmount } = mountTerminal(loadFixtureMessages().slice(-20));
    try {
        const fileInput = container.querySelector('input[accept="*/*"]');
        const file = new File(["abc"], "notes.txt", { type: "text/plain" });
        Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
        await act(async () => {
            fileInput.dispatchEvent(new globalThis.window.Event("change", { bubbles: true }));
        });
        await settle();

        await act(async () => {
            container.querySelector('button[aria-label="Send message"]').click();
        });
        await settle();

        assert.ok(calls.some((c) => c.url.includes("/api/chat/files/upload")), "file uploaded");
        const sent = chatCalls(calls);
        assert.equal(sent.length, 1);
        const body = JSON.parse(sent[0].init.body);
        assert.deepEqual(body.files, [{ name: "notes.txt", content: "abc", type: "text/plain" }]);
        assert.equal(body.attachments.length, 1);
        assert.match(body.message, /notes\.txt/);
        assert.ok(
            cortexTestStore.messages.some((m) => m.role === "user" && m.content.includes("📎 1 file(s) attached: notes.txt")),
            "optimistic message names the attachment",
        );
    } finally {
        unmount();
        restore();
    }
});

test("voice memo path: record, stop, send as base64 audio", async () => {
    const { calls, restore } = installFetchMock();
    class FakeMediaRecorder {
        constructor(stream) { this.stream = stream; }
        start() {}
        stop() {
            this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }) });
            this.onstop?.();
        }
    }
    globalThis.MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(globalThis.window.navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });

    const { container, unmount } = mountTerminal(loadFixtureMessages().slice(-20));
    try {
        await act(async () => {
            container.querySelector('button[title="Record voice memo"]').click();
        });
        await settle();
        const stopButton = container.querySelector('button[title="Stop recording"]');
        assert.ok(stopButton, "recording UI appeared");
        await act(async () => { stopButton.click(); });
        await settle();

        await act(async () => {
            container.querySelector('button[aria-label="Send message"]').click();
        });
        await settle();

        const sent = chatCalls(calls);
        assert.equal(sent.length, 1, "voice memo sent");
        const body = JSON.parse(sent[0].init.body);
        assert.equal(body.message, "Voice recording attached");
        assert.equal(body.audio, Buffer.from([1, 2, 3, 4]).toString("base64"), "audio blob sent as base64");
        assert.equal(body.stream, false, "audio sends do not stream");
        assert.ok(
            cortexTestStore.messages.some((m) => m.role === "user" && m.content.includes("🎤 Voice memo attached")),
            "optimistic message notes the memo",
        );
    } finally {
        unmount();
        restore();
        delete globalThis.MediaRecorder;
    }
});
