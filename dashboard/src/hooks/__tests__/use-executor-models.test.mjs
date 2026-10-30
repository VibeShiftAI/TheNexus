// The per-executor model dropdowns (morning-plan card, task dispatch console)
// read the model registry, not hand-kept lists. Drives the real hook against
// stubbed fetches.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { useExecutorModelOptions } from "../use-executor-models";
import { resetAvailableModels } from "../use-available-models";
import { MODEL_REGISTRY } from "../../../test/fixtures/model-registry.mjs";

const OPTIONS_STATE = {
    models: [
        { id: "anthropic-claude-opus", provider: "anthropic", display_name: "Claude Opus 5", api_model_id: "claude-opus-5" },
        { id: "openrouter-glm", provider: "openrouter", display_name: "GLM 5.2 (free)", api_model_id: "z-ai/glm-5.2:free" },
    ],
    claudeDefault: "claude-opus-5-5",
    codexDefault: "gpt-6-astra",
    antigravityDefault: "Gemini 4 Argon (High)",
};

async function render(registry) {
    resetAvailableModels();
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const path = String(url);
        if (path === "/api/model-control/available-models") {
            return registry
                ? { ok: true, status: 200, json: async () => registry }
                : { ok: false, status: 404, json: async () => ({ error: "no model registry yet" }) };
        }
        if (path.startsWith("/api/model-control/options")) return { ok: true, status: 200, json: async () => OPTIONS_STATE };
        return { ok: false, status: 503, json: async () => ({}) };
    };
    let latest = null;
    function Probe() { latest = useExecutorModelOptions(); return null; }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(Probe)); });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return {
        get: () => latest,
        cleanup() {
            act(() => root.unmount());
            container.remove();
            globalThis.fetch = original;
            resetAvailableModels();
        },
    };
}

test("Claude, Codex and Antigravity options come from the model registry", async () => {
    const view = await render(MODEL_REGISTRY);
    try {
        const claude = view.get().optionsFor("claude-code");
        assert.deepEqual(
            claude.options.map((o) => [o.id, o.label, Boolean(o.older)]),
            [
                ["claude-opus-5-5", "Claude Opus 5.5", false],
                ["claude-fable-5-1", "Claude Fable 5.1", false],
                ["claude-sonnet-5-5", "Claude Sonnet 5.5", false],
                ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", true],
                ["claude-opus-5", "Claude Opus 5", true],
                ["claude-opus-4-6", "Claude Opus 4.6", true],
            ],
        );
        assert.ok(claude.options.every((o) => o.provider === "anthropic"));
        assert.equal(claude.fallback, "claude-opus-5-5");
        assert.equal(claude.listMissing, false);

        const codex = view.get().optionsFor("codex");
        assert.deepEqual(codex.options.filter((o) => !o.older).map((o) => o.id), ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"]);
        assert.ok(!codex.options.some((o) => o.id === "gpt-reserve"), "hidden models are never offered");

        const agy = view.get().optionsFor("antigravity");
        assert.ok(agy.options.some((o) => o.id === "Gemini 4 Argon (High)"), "agy options are display names");
        assert.ok(agy.options.every((o) => o.provider === undefined), "agy spends the Google subscription, not a key");

        // OpenRouter is outside the registry and still reads the discovered roster.
        assert.deepEqual(view.get().optionsFor("openrouter").options.map((o) => o.id), ["z-ai/glm-5.2:free"]);
    } finally {
        view.cleanup();
    }
});

test("a missing registry offers no invented list and says so", async () => {
    const view = await render(null);
    try {
        for (const executor of ["claude-code", "codex", "antigravity"]) {
            const choices = view.get().optionsFor(executor);
            assert.deepEqual(choices.options, [], `${executor} has no hardcoded fallback`);
            assert.equal(choices.listMissing, true);
        }
        assert.equal(view.get().optionsFor("claude-code").fallback, "claude-opus-5-5", "the saved default still shows");
        assert.equal(view.get().optionsFor("openrouter").listMissing, false);
    } finally {
        view.cleanup();
    }
});
