// The Model Control ladder card, mounted against a fake
// /api/praxis/models/ladder-settings. Praxis offers the newest version of every
// flagship Claude Code and Codex line and says which CLI runs each model; the
// menus group the options under those names, and stay a flat list when an
// older Praxis sends no providers.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { ModelLadderSettings } from "../model-ladder-settings.tsx";

const VIEW = {
    settings: { routine: "claude-opus-5-5", advanced: "gpt-6-astra", apex: "claude-fable-5-2" },
    models: ["claude-opus-5-5", "claude-fable-5-2", "gpt-6.1-sol", "gpt-6-astra"],
    modelsByRole: {
        routine: ["claude-opus-5-5", "claude-fable-5-2", "gpt-6.1-sol", "gpt-6-astra"],
        advanced: ["claude-opus-5-5", "claude-fable-5-2", "gpt-6.1-sol", "gpt-6-astra"],
        apex: ["claude-fable-5-2", "gpt-6.1-sol", "gpt-6-astra"],
    },
    labels: { "claude-opus-5-5": "Opus 5.5", "claude-fable-5-2": "Fable 5.2", "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-astra": "GPT-6 Astra" },
    providers: { "claude-opus-5-5": "Claude Code", "claude-fable-5-2": "Claude Code", "gpt-6.1-sol": "Codex", "gpt-6-astra": "Codex" },
};

async function mount(view) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => view });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(ModelLadderSettings)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return {
        host,
        select: (label) => host.querySelector(`select[aria-label^="${label}"]`),
        cleanup: () => { act(() => root.unmount()); host.remove(); globalThis.fetch = original; },
    };
}

test("each tier's menu groups the newest models under the CLI that runs them", async () => {
    const view = await mount(VIEW);
    try {
        const advanced = view.select("Advanced work");
        assert.equal(advanced.value, "gpt-6-astra");
        const groups = [...advanced.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]);
        assert.deepEqual(groups, [["Claude Code", ["Opus 5.5", "Fable 5.2"]], ["Codex", ["GPT-6.1 Sol", "GPT-6 Astra"]]]);
        const apex = [...view.select("Top tier").querySelectorAll("option")].map((o) => o.value);
        assert.deepEqual(apex, ["claude-fable-5-2", "gpt-6.1-sol", "gpt-6-astra"]);
    } finally { view.cleanup(); }
});

test("without providers the menu is one flat list", async () => {
    const { providers: _ignored, ...older } = VIEW;
    const view = await mount(older);
    try {
        const routine = view.select("Bulk of the work");
        assert.equal(routine.querySelectorAll("optgroup").length, 0);
        assert.deepEqual([...routine.querySelectorAll("option")].map((o) => o.textContent), ["Opus 5.5", "Fable 5.2", "GPT-6.1 Sol", "GPT-6 Astra"]);
    } finally { view.cleanup(); }
});
