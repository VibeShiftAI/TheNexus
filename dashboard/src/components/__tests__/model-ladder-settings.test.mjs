// The Model Control ladder card, mounted against a fake
// /api/praxis/models/ladder-settings. Praxis offers the newest version of every
// flagship Claude Code and Codex line, says which CLI runs each model, and
// carries each tier's fallback on the other CLI ("auto" or a model) with what
// "auto" resolves to. The menus group options by CLI; the fallback menu offers
// only the other CLI's models; an older Praxis (no providers, no fallbacks)
// gets a flat first-choice menu and no fallback menu.
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
    fallbacks: { routine: "auto", advanced: "auto", apex: "gpt-6.1-sol" },
    automaticFallbacks: {
        routine: { "Claude Code": "gpt-6-astra", Codex: "claude-opus-5-5" },
        advanced: { "Claude Code": "gpt-6-astra", Codex: "claude-fable-5-2" },
        apex: { "Claude Code": "gpt-6-astra", Codex: "claude-fable-5-2" },
    },
};

const TOP = "Top tier · complexity 5";
const ADVANCED = "Advanced work · complexity 4";
const ROUTINE = "Bulk of the work · complexity 1–3";

async function mount(view) {
    const original = globalThis.fetch;
    const puts = [];
    globalThis.fetch = async (_url, init = {}) => {
        if (init.method === "PUT") {
            const body = JSON.parse(init.body);
            puts.push(body);
            const { fallbacks, ...settings } = body;
            return { ok: true, status: 200, json: async () => ({ ...view, settings, ...(fallbacks ? { fallbacks } : {}) }) };
        }
        return { ok: true, status: 200, json: async () => view };
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(ModelLadderSettings)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return {
        host,
        puts,
        select: (name) => host.querySelector(`select[aria-label="${name}"]`),
        cleanup: () => { act(() => root.unmount()); host.remove(); globalThis.fetch = original; },
    };
}

const groupsOf = (select) => [...select.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]);

async function choose(select, value) {
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value").set;
        setter.call(select, value);
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
}

test("each tier's first-choice menu groups the newest models under the CLI that runs them", async () => {
    const view = await mount(VIEW);
    try {
        const advanced = view.select(`${ADVANCED}: first choice`);
        assert.equal(advanced.value, "gpt-6-astra");
        assert.deepEqual(groupsOf(advanced), [["Claude Code", ["Opus 5.5", "Fable 5.2"]], ["Codex", ["GPT-6.1 Sol", "GPT-6 Astra"]]]);
        assert.deepEqual([...view.select(`${TOP}: first choice`).querySelectorAll("option")].map((o) => o.value), ["claude-fable-5-2", "gpt-6.1-sol", "gpt-6-astra"]);
    } finally { view.cleanup(); }
});

test("the fallback menu offers the other CLI's models and names what Automatic picks", async () => {
    const view = await mount(VIEW);
    try {
        const top = view.select(`${TOP}: fallback`);
        assert.equal(top.value, "gpt-6.1-sol");
        assert.equal(top.closest("label").textContent.startsWith("If Claude Code can't take it"), true);
        assert.equal(top.querySelector('option[value="auto"]').textContent, "Automatic · GPT-6 Astra");
        assert.deepEqual(groupsOf(top), [["Codex", ["GPT-6.1 Sol", "GPT-6 Astra"]]]);
        const advanced = view.select(`${ADVANCED}: fallback`);
        assert.equal(advanced.value, "auto");
        assert.equal(advanced.querySelector('option[value="auto"]').textContent, "Automatic · Fable 5.2");
        assert.deepEqual(groupsOf(advanced), [["Claude Code", ["Opus 5.5", "Fable 5.2"]]]);
    } finally { view.cleanup(); }
});

test("moving a tier's first choice to the other CLI resets its fallback, and Save sends both", async () => {
    const view = await mount(VIEW);
    try {
        await choose(view.select(`${TOP}: first choice`), "gpt-6-astra");
        const top = view.select(`${TOP}: fallback`);
        assert.equal(top.value, "auto");
        assert.equal(top.querySelector('option[value="auto"]').textContent, "Automatic · Fable 5.2");
        assert.deepEqual(groupsOf(top), [["Claude Code", ["Fable 5.2"]]]);
        await choose(view.select(`${ROUTINE}: fallback`), "gpt-6.1-sol");
        const button = [...view.host.querySelectorAll("button")].find((b) => b.textContent === "Save ladder");
        await act(async () => { button.click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        assert.deepEqual(view.puts, [{
            routine: "claude-opus-5-5", advanced: "gpt-6-astra", apex: "gpt-6-astra",
            fallbacks: { routine: "gpt-6.1-sol", advanced: "auto", apex: "auto" },
        }]);
        assert.ok(view.host.querySelector('[role="status"]'), "Ladder saved");
    } finally { view.cleanup(); }
});

test("an older Praxis without providers or fallbacks gets a flat menu and no fallback menu", async () => {
    const { providers: _p, fallbacks: _f, automaticFallbacks: _a, ...older } = VIEW;
    const view = await mount(older);
    try {
        const routine = view.select(`${ROUTINE}: first choice`);
        assert.equal(routine.querySelectorAll("optgroup").length, 0);
        assert.deepEqual([...routine.querySelectorAll("option")].map((o) => o.textContent), ["Opus 5.5", "Fable 5.2", "GPT-6.1 Sol", "GPT-6 Astra"]);
        assert.equal(view.select(`${ROUTINE}: fallback`), null);
    } finally { view.cleanup(); }
});
