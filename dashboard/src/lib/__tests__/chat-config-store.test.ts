// The shared chat-config store — the single source of truth behind both the
// settings modal's Praxis Terminal section and the MAIN VIEWER header control.
// These cover the option lists, the short indicator labels, and the guarantee
// that a failed write never becomes visible state.
import test from "node:test";
import assert from "node:assert/strict";

import {
    activeChatModel,
    applyChatConfig,
    chatModelChoices,
    chatModelIndicatorLabel,
    chatModelSuggestions,
    getChatConfigState,
    loadChatConfig,
    resetChatConfigStore,
    subscribeChatConfig,
} from "../chat-config-store";
import type { ChatConfig } from "../model-control";
import { MODEL_REGISTRY } from "../../../test/fixtures/model-registry.mjs";

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

test("suggestions are the current models each CLI offers, from the model registry", () => {
    assert.deepEqual(
        chatModelSuggestions(MODEL_REGISTRY, "claude-code"),
        ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"],
        "current Claude models only; older ones stay reachable by free text",
    );
    // Registry order: the codex roster leader first, hidden models never.
    assert.deepEqual(
        chatModelSuggestions(MODEL_REGISTRY, "codex"),
        ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"],
    );
    assert.deepEqual(chatModelSuggestions(null, "claude-code"), [], "no registry, no invented list");
});

test("the configured slug is always a choice, even when the registry does not offer it", () => {
    assert.deepEqual(
        chatModelChoices(MODEL_REGISTRY, OPUS),
        ["claude-opus-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"],
    );
    assert.deepEqual(
        chatModelChoices(MODEL_REGISTRY, { ...OPUS, claudeModel: "claude-fable-5-1" }),
        ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"],
        "a listed slug is not repeated",
    );
    assert.deepEqual(chatModelChoices(null, OPUS), ["claude-opus-5"], "without a registry only the saved value shows");
    assert.deepEqual(chatModelChoices(MODEL_REGISTRY, { ...OPUS, backend: "off" }), []);
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
