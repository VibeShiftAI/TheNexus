// The MAIN VIEWER header's chat-model indicator + picker, mounted for real
// against a fake /api/model-control/chat-config. The point of these tests is
// the "one source of truth" contract: the header control and the settings
// modal's ChatSettingsSection are two views of one state, so a change in one
// must land in the other with no reload and no second endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";

import { ChatModelControl } from "../bridge/chat-model-control.tsx";
import { ChatSettingsSection } from "../chat-settings-section.tsx";
import { resetChatConfigStore } from "../../lib/chat-config-store.ts";

const BASE_CONFIG = {
    backend: "claude-code",
    claudeModel: "claude-opus-5",
    codexModel: "gpt-5.6-sol",
    thinkingLevel: "default",
    thinkingTiers: ["default", "low", "medium", "high"],
};

/**
 * Stands in for the chat-config route: GET returns the current server state,
 * PUT merges the patch (or fails when `failWrites` is set) and returns the new
 * config, exactly as server/routes/model-control.js does.
 */
function installChatConfigApi({ failWrites = false } = {}) {
    let server = { ...BASE_CONFIG };
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const call = {
            url: String(url),
            method: init.method ?? "GET",
            body: init.body ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        if (call.method === "PUT") {
            if (failWrites) return { ok: false, status: 500, json: async () => ({}) };
            server = { ...server, ...call.body };
        }
        return { ok: true, status: 200, json: async () => ({ ...server }) };
    };
    return {
        calls,
        writes: () => calls.filter((c) => c.method === "PUT"),
        server: () => server,
        restore: () => { globalThis.fetch = original; },
    };
}

function mount(element) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(element));
    return {
        container,
        unmount() {
            act(() => root.unmount());
            container.remove();
        },
    };
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
}

function click(node) {
    assert.ok(node, "expected the element to exist before clicking it");
    act(() => node.click());
}

/** The popover is portalled to <body> (the header panel is overflow-hidden). */
function popover() {
    return document.body.querySelector('[role="dialog"][aria-label="Praxis chat model"]');
}

function indicator(container) {
    return container.querySelector('[data-testid="chat-model-indicator"]');
}

function openPicker(container) {
    click(container.querySelector('button[aria-haspopup="dialog"]'));
    const dialog = popover();
    assert.ok(dialog, "picker opened");
    return dialog;
}

function setup(options) {
    resetChatConfigStore();
    return installChatConfigApi(options);
}

function teardown(api, ...mounted) {
    for (const m of mounted) m.unmount();
    api.restore();
    resetChatConfigStore();
}

test("the header shows which model is answering as Praxis without a click", async () => {
    const api = setup();
    const view = mount(createElement(ChatModelControl));
    try {
        await settle();

        assert.equal(indicator(view.container).textContent, "Opus 5", "short readable form, not the raw slug");
        assert.equal(popover(), null, "the readout needs no interaction");
        const trigger = view.container.querySelector('button[aria-haspopup="dialog"]');
        assert.match(trigger.getAttribute("aria-label"), /Praxis chat model: Opus 5/);
        assert.equal(trigger.getAttribute("aria-expanded"), "false");
        assert.deepEqual(api.calls.map((c) => c.url), ["/api/model-control/chat-config"]);
    } finally {
        teardown(api, view);
    }
});

test("picking a model saves through the shared chat-config helpers and repaints both surfaces", async () => {
    const api = setup();
    const header = mount(createElement(ChatModelControl));
    const settings = mount(createElement(ChatSettingsSection, { reloadKey: true }));
    try {
        await settle();
        assert.equal(settings.container.querySelector('input[list="chat-model-suggestions"]').value, "claude-opus-5");

        const dialog = openPicker(header.container);
        click(dialog.querySelector('[data-model="claude-fable-5-1"]'));
        await settle();

        const writes = api.writes();
        assert.equal(writes.length, 1, "exactly one save");
        assert.equal(writes[0].url, "/api/model-control/chat-config", "no new endpoint");
        assert.deepEqual(writes[0].body, { claudeModel: "claude-fable-5-1" });
        assert.deepEqual(
            [...new Set(api.calls.map((c) => c.url))],
            ["/api/model-control/chat-config"],
            "every request went to the one chat-config route",
        );

        assert.equal(indicator(header.container).textContent, "Fable 5.1");
        assert.equal(
            settings.container.querySelector('input[list="chat-model-suggestions"]').value,
            "claude-fable-5-1",
            "the settings modal reflects the header's change without a reload",
        );
    } finally {
        teardown(api, header, settings);
    }
});

test("a change made in the settings modal repaints the header control", async () => {
    const api = setup();
    const header = mount(createElement(ChatModelControl));
    const settings = mount(createElement(ChatSettingsSection, { reloadKey: true }));
    try {
        await settle();

        const input = settings.container.querySelector('input[list="chat-model-suggestions"]');
        const setValue = Object.getOwnPropertyDescriptor(
            globalThis.window.HTMLInputElement.prototype, "value").set;
        act(() => {
            setValue.call(input, "claude-sonnet-5");
            input.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
        });
        act(() => {
            input.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        await settle();

        assert.deepEqual(api.writes().map((w) => w.body), [{ claudeModel: "claude-sonnet-5" }]);
        assert.equal(indicator(header.container).textContent, "Sonnet 5");
    } finally {
        teardown(api, header, settings);
    }
});

test("a backend switch is confirmed first; a model switch inside the backend is not", async () => {
    const api = setup();
    const header = mount(createElement(ChatModelControl));
    try {
        await settle();
        const dialog = openPicker(header.container);

        click(dialog.querySelector('[data-backend="codex"]'));
        await settle();

        assert.equal(api.writes().length, 0, "no write until the switch is confirmed");
        assert.match(
            popover().textContent,
            /FRESH CLI session/,
            "the warning names the lost conversation continuity",
        );
        assert.match(popover().textContent, /continuity is lost/);

        const buttons = [...popover().querySelectorAll("button")];
        click(buttons.find((b) => b.textContent.includes("Switch anyway")));
        await settle();

        assert.deepEqual(api.writes().map((w) => w.body), [{ backend: "codex" }]);
        assert.equal(indicator(header.container).textContent, "gpt-5.6-sol");

        // Same backend, same CLI session: a model pick saves straight away.
        click(popover().querySelector('[data-model="gpt-5.6-terra"]'));
        await settle();
        assert.deepEqual(api.writes().map((w) => w.body), [{ backend: "codex" }, { codexModel: "gpt-5.6-terra" }]);
    } finally {
        teardown(api, header);
    }
});

test("cancelling a backend switch leaves the executor alone", async () => {
    const api = setup();
    const header = mount(createElement(ChatModelControl));
    try {
        await settle();
        const dialog = openPicker(header.container);
        click(dialog.querySelector('[data-backend="off"]'));
        await settle();

        const buttons = [...popover().querySelectorAll("button")];
        click(buttons.find((b) => b.textContent.includes("Keep")));
        await settle();

        assert.equal(api.writes().length, 0);
        assert.equal(indicator(header.container).textContent, "Opus 5");
        assert.equal(popover().querySelector('[data-backend="claude-code"]').getAttribute("aria-pressed"), "true");
    } finally {
        teardown(api, header);
    }
});

test("a failed save shows an error and never presents the un-saved model as active", async () => {
    const api = setup({ failWrites: true });
    const header = mount(createElement(ChatModelControl));
    try {
        await settle();
        const dialog = openPicker(header.container);
        click(dialog.querySelector('[data-model="claude-fable-5-1"]'));
        await settle();

        const alert = popover().querySelector('[role="alert"]');
        assert.ok(alert, "the failure is visible, not swallowed");
        assert.match(alert.textContent, /500/);
        assert.equal(indicator(header.container).textContent, "Opus 5", "the indicator still names the model that is really answering");
        assert.equal(popover().querySelector('[data-model="claude-fable-5-1"]').getAttribute("aria-pressed"), "false");
        assert.equal(popover().querySelector('[data-model="claude-opus-5"]').getAttribute("aria-pressed"), "true");
    } finally {
        teardown(api, header);
    }
});

test("a rejected free-text save restores the settings field to the confirmed model", async () => {
    // QA round 1 caught this: the settings input kept the rejected slug while
    // the header (same store) still showed the confirmed one, so the two
    // surfaces disagreed about which model was actually answering.
    const api = setup({ failWrites: true });
    const header = mount(createElement(ChatModelControl));
    const settings = mount(createElement(ChatSettingsSection, { reloadKey: true }));
    try {
        await settle();
        const input = settings.container.querySelector('input[list="chat-model-suggestions"]');
        const setValue = Object.getOwnPropertyDescriptor(
            globalThis.window.HTMLInputElement.prototype, "value").set;
        act(() => {
            setValue.call(input, "claude-fable-5-1");
            input.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
        });
        act(() => {
            input.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        await settle();

        assert.equal(api.writes().length, 1, "it did attempt the save");
        assert.equal(
            settings.container.querySelector('input[list="chat-model-suggestions"]').value,
            "claude-opus-5",
            "the rejected slug is rolled back to the confirmed model",
        );
        assert.equal(
            indicator(header.container).textContent,
            "Opus 5",
            "and the header agrees — the two surfaces never disagree",
        );
        assert.match(
            settings.container.textContent,
            /500/,
            "the failure is shown, not swallowed",
        );
    } finally {
        teardown(api, header, settings);
    }
});

test("the picker stops taking clicks while a save is in flight", async () => {
    const api = setup();
    const header = mount(createElement(ChatModelControl));
    try {
        await settle();
        const dialog = openPicker(header.container);

        // Hold the PUT open so the in-flight state is observable: rapid second
        // choices must not stack up behind a write whose response could then
        // land out of order.
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const passthrough = globalThis.fetch;
        globalThis.fetch = async (url, init = {}) => {
            if ((init.method ?? "GET") === "PUT") await held;
            return passthrough(url, init);
        };

        click(dialog.querySelector('[data-model="claude-fable-5-1"]'));
        await settle();

        assert.equal(popover().querySelector('[data-thinking="high"]').disabled, true, "thinking tiers locked while saving");
        assert.equal(popover().querySelector('[data-backend="codex"]').disabled, true, "executor locked while saving");
        assert.equal(popover().querySelector('[data-model="claude-opus-5"]').disabled, true, "models locked while saving");

        await act(async () => { release(); });
        await settle();

        assert.equal(popover().querySelector('[data-thinking="high"]').disabled, false, "controls come back after the save lands");
        assert.deepEqual(api.writes().map((w) => w.body), [{ claudeModel: "claude-fable-5-1" }], "the held save was the only write");
        assert.equal(indicator(header.container).textContent, "Fable 5.1");
    } finally {
        teardown(api, header);
    }
});

test("clicking the trigger after a failed load actually retries, as its tooltip promises", async () => {
    resetChatConfigStore();
    // First GET fails, so the control sits on "Chat model unavailable — click
    // to retry". That tooltip has to be true: opening the picker must re-fetch.
    let failNextLoad = true;
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method ?? "GET" });
        if (failNextLoad) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ ...BASE_CONFIG }) };
    };
    const header = mount(createElement(ChatModelControl));
    try {
        await settle();
        assert.equal(calls.length, 1, "the initial load was attempted");
        const trigger = header.container.querySelector('button[aria-haspopup="dialog"]');
        assert.equal(trigger.getAttribute("title"), "Chat model unavailable — click to retry");

        failNextLoad = false;
        click(trigger);
        await settle();

        assert.equal(calls.length, 2, "opening the picker re-fetched the config");
        assert.equal(calls[1].method, "GET");
        assert.equal(
            indicator(header.container).textContent,
            "Opus 5",
            "the retry recovered the readout without a page reload",
        );
    } finally {
        header.unmount();
        globalThis.fetch = original;
        resetChatConfigStore();
    }
});

test("the picker is keyboard-dismissable with Escape", async () => {
    const api = setup();
    const header = mount(createElement(ChatModelControl));
    try {
        await settle();
        openPicker(header.container);

        act(() => {
            document.dispatchEvent(new globalThis.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });

        assert.equal(popover(), null, "Escape closes the popover");
    } finally {
        teardown(api, header);
    }
});
