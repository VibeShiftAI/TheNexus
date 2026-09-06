// The shared chat-config store — the single source of truth behind both the
// settings modal's Praxis Terminal section and the MAIN VIEWER header control.
// These cover the option lists, the short indicator labels, and the guarantee
// that a failed write never becomes visible state.
import test from "node:test";
import assert from "node:assert/strict";

import {
    CHAT_MODEL_SUGGESTIONS,
    activeChatModel,
    applyChatConfig,
    chatModelIndicatorLabel,
    getChatConfigState,
    loadChatConfig,
    resetChatConfigStore,
    subscribeChatConfig,
} from "../chat-config-store";
import type { ChatConfig } from "../model-control";

const OPUS: ChatConfig = {
    backend: "claude-code",
    claudeModel: "claude-opus-5",
    codexModel: "gpt-5.6-sol",
    thinkingLevel: "default",
    thinkingTiers: ["default", "low", "medium", "high"],
};

interface Call { url: string; method: string; body: unknown }

function installFetch(handler: (call: Call) => { ok: boolean; status?: number; json?: unknown }) {
    const calls: Call[] = [];
    const original = globalThis.fetch;
    // @ts-expect-error — narrow test double, not the full fetch surface.
    globalThis.fetch = async (url: unknown, init: { method?: string; body?: string } = {}) => {
        const call: Call = {
            url: String(url),
            method: init.method ?? "GET",
            body: init.body ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const result = handler(call);
        return {
            ok: result.ok,
            status: result.status ?? (result.ok ? 200 : 500),
            json: async () => result.json,
        };
    };
    return { calls, restore: () => { globalThis.fetch = original; } };
}

test("the shared suggestion list carries the dash-form Fable 5.1 slug", () => {
    const claude = CHAT_MODEL_SUGGESTIONS["claude-code"];

    assert.ok(claude.includes("claude-fable-5-1"), "claude-fable-5-1 is offerable");
    // The dotted form is OpenRouter-only and the Claude CLI rejects it.
    assert.ok(!claude.includes("claude-fable-5.1"), "the dotted OpenRouter form is never offered");
    assert.ok(claude.includes("claude-fable-5"), "claude-fable-5 stays until it is shown to be dead");
    assert.ok(claude.includes("claude-opus-5"));
    assert.ok(CHAT_MODEL_SUGGESTIONS.codex.includes("gpt-5.6-sol"));
    // 2026-09-06 roster: astra is the codex roster leader, so it is offered first.
    assert.equal(CHAT_MODEL_SUGGESTIONS.codex[0], "gpt-6-astra");
});

test("indicator labels are short and readable, per backend", () => {
    assert.equal(chatModelIndicatorLabel(OPUS), "Opus 5");
    assert.equal(chatModelIndicatorLabel({ ...OPUS, claudeModel: "claude-fable-5-1" }), "Fable 5.1");
    assert.equal(chatModelIndicatorLabel({ ...OPUS, claudeModel: "" }), "Default");
    assert.equal(chatModelIndicatorLabel({ ...OPUS, backend: "codex" }), "gpt-5.6-sol");
    assert.equal(chatModelIndicatorLabel({ ...OPUS, backend: "off" }), "Routed LLM");
    assert.equal(chatModelIndicatorLabel(null), "…");

    assert.equal(activeChatModel(OPUS), "claude-opus-5");
    assert.equal(activeChatModel({ ...OPUS, backend: "codex" }), "gpt-5.6-sol");
    assert.equal(activeChatModel({ ...OPUS, backend: "off" }), "");
});

test("applyChatConfig writes to /api/model-control/chat-config and publishes to every subscriber", async () => {
    resetChatConfigStore();
    const saved = { ...OPUS, claudeModel: "claude-fable-5-1" };
    const { calls, restore } = installFetch((call) =>
        call.method === "PUT" ? { ok: true, json: saved } : { ok: true, json: OPUS });
    let notifications = 0;
    subscribeChatConfig(() => { notifications += 1; });

    try {
        await loadChatConfig();
        assert.equal(getChatConfigState().config?.claudeModel, "claude-opus-5");

        const result = await applyChatConfig({ claudeModel: "claude-fable-5-1" });

        assert.deepEqual(result, saved);
        assert.equal(getChatConfigState().config?.claudeModel, "claude-fable-5-1");
        assert.ok(getChatConfigState().savedAt > 0, "a successful save flashes Saved");
        assert.equal(getChatConfigState().error, null);
        assert.ok(notifications > 0, "subscribers were notified — no surface needs a reload");

        // No parallel endpoint: every call went to the one chat-config route.
        assert.deepEqual([...new Set(calls.map(c => c.url))], ["/api/model-control/chat-config"]);
        const writes = calls.filter(c => c.method === "PUT");
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].body, { claudeModel: "claude-fable-5-1" });
    } finally {
        restore();
        resetChatConfigStore();
    }
});

test("a failed save surfaces the error and leaves the last confirmed config in place", async () => {
    resetChatConfigStore();
    const { restore } = installFetch((call) =>
        call.method === "PUT" ? { ok: false, status: 500 } : { ok: true, json: OPUS });

    try {
        await loadChatConfig();
        const result = await applyChatConfig({ claudeModel: "claude-fable-5-1" });

        assert.equal(result, null, "a rejected write resolves to null");
        assert.equal(getChatConfigState().config?.claudeModel, "claude-opus-5", "the un-saved model never becomes active");
        assert.match(String(getChatConfigState().error), /500/);
        assert.equal(getChatConfigState().savedAt, 0, "nothing claims to be saved");
        assert.equal(getChatConfigState().saving, false);
    } finally {
        restore();
        resetChatConfigStore();
    }
});

test("concurrent writes are serialized, so the last one clicked is the one left standing", async () => {
    resetChatConfigStore();
    // The second PUT resolves FAST and the first SLOW. Unserialized, the slow
    // response would land last and publish a snapshot without the newer choice.
    let server: ChatConfig = { ...OPUS };
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const original = globalThis.fetch;
    // @ts-expect-error — narrow test double, not the full fetch surface.
    globalThis.fetch = async (url: unknown, init: { method?: string; body?: string } = {}) => {
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(init.body) : undefined;
        if (method === "PUT") {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            order.push(String(body.claudeModel));
            await new Promise((resolve) => setTimeout(resolve, body.claudeModel === "slow" ? 20 : 0));
            server = { ...server, ...body };
            inFlight -= 1;
        }
        return { ok: true, status: 200, json: async () => ({ ...server }) };
    };

    try {
        await loadChatConfig();
        const first = applyChatConfig({ claudeModel: "slow" });
        const second = applyChatConfig({ claudeModel: "fast" });
        await Promise.all([first, second]);

        assert.equal(maxInFlight, 1, "never two PUTs on the wire at once");
        assert.deepEqual(order, ["slow", "fast"], "issued in call order");
        assert.equal(
            getChatConfigState().config?.claudeModel,
            "fast",
            "the newest choice wins — no out-of-order response undoes it",
        );
        assert.equal(getChatConfigState().saving, false);
    } finally {
        globalThis.fetch = original;
        resetChatConfigStore();
    }
});
