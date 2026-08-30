// Layout regression guard for the 2026-08-30 revert (commit 24fa60c shipped
// panel-height changes riding along with the auto-growing composer; only the
// composer was wanted). Pins the composer's growth cap and the modal panel's
// content-sized height so a future edit can't silently re-widen either.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { AITerminal } from "../src/components/ai-terminal.tsx";
import { mountTerminal, findComposerInput, act, cortexTestStore } from "./helpers.mjs";

const COMPOSER_MAX_HEIGHT = 200;

test("composer starts at rows=1 and its auto-grow height caps at 200px", () => {
    const { container, unmount } = mountTerminal([]);
    try {
        const input = findComposerInput(container);
        assert.equal(input.getAttribute("rows"), "1", "composer starts single-row");
        assert.equal(input.style.maxHeight, `${COMPOSER_MAX_HEIGHT}px`, "inline maxHeight style matches the cap");

        // jsdom never lays out text, so scrollHeight is always 0 — stand in
        // for "content taller than the cap" the way ai-terminal-window.test.mjs
        // fakes scroller geometry.
        Object.defineProperty(input, "scrollHeight", {
            configurable: true,
            get: () => COMPOSER_MAX_HEIGHT + 400,
        });
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLTextAreaElement.prototype, "value").set;
            setter.call(input, "a very long draft\n".repeat(40));
            input.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
        });
        assert.equal(input.style.height, `${COMPOSER_MAX_HEIGHT}px`, "grown height clamps at the cap, does not exceed it");
    } finally {
        unmount();
    }
});

test("modal terminal panel sizes to content up to 80vh, not pinned at 80vh", () => {
    cortexTestStore.reset([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(createElement(AITerminal, { isOpen: true, mode: "modal" }));
    });
    try {
        const panel = container.querySelector(".max-w-3xl");
        assert.ok(panel, "modal panel found");
        assert.ok(panel.classList.contains("max-h-[80vh]"), "panel still caps at 80vh");
        assert.ok(!panel.classList.contains("h-[80vh]"), "panel is no longer pinned to a fixed 80vh height");
    } finally {
        act(() => root.unmount());
        container.remove();
    }
});
