// Transcript DOM window behavior: cap at RENDER_WINDOW (200) rows while
// pinned to the bottom, reveal already-loaded messages from memory on
// scroll-up (REVEAL_PAGE at a time), only then paginate over the network
// (loadMoreMessages), preserve the reading position when the head grows,
// and never trim the window out from under a reader.
import test from "node:test";
import assert from "node:assert/strict";

import {
    loadFixtureMessages,
    mountTerminal,
    act,
    cortexTestStore,
} from "./helpers.mjs";

const ROW_HEIGHT = 50;

function rowCount(container) {
    return container.querySelectorAll("[data-message-row]").length;
}

/** jsdom has no layout: derive scrollHeight from mounted row count and make
 *  scrollTop a plain stored value so the scroll-compensation math is real. */
function fakeScrollGeometry(scroller) {
    Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        get: () => scroller.querySelectorAll("[data-message-row]").length * ROW_HEIGHT,
    });
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v) => { scrollTop = v; },
    });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 600 });
}

function dispatchScroll(scroller) {
    act(() => {
        scroller.dispatchEvent(new globalThis.window.Event("scroll"));
    });
}

test("transcript DOM is capped, reveals from memory, then paginates over the network", () => {
    const messages = loadFixtureMessages();
    const { container, unmount } = mountTerminal(messages);
    try {
        const scroller = container.querySelector(".custom-scrollbar");
        assert.ok(scroller, "messages scroller found");

        // Mounted pinned-to-bottom with 305 loaded → trimmed to the window.
        assert.equal(rowCount(container), 200, "DOM capped at RENDER_WINDOW rows");

        fakeScrollGeometry(scroller);

        // Scroll to the top → reveal 100 already-loaded messages, no network.
        scroller.scrollTop = 0;
        dispatchScroll(scroller);
        assert.equal(rowCount(container), 300, "first reveal restores 100 rows from memory");
        assert.equal(cortexTestStore.loadMoreCalls, 0, "no network pagination while memory remains");

        // Reading position preserved: 100 rows appeared above, so scrollTop
        // moved down by exactly the added height.
        assert.equal(scroller.scrollTop, 100 * ROW_HEIGHT, "scroll position compensated for revealed head");

        // Second reveal exhausts the hidden head (305 total).
        scroller.scrollTop = 0;
        dispatchScroll(scroller);
        assert.equal(rowCount(container), 305, "all loaded messages revealed");
        assert.equal(cortexTestStore.loadMoreCalls, 0);

        // With nothing hidden, the next top-scroll goes to the network.
        scroller.scrollTop = 0;
        dispatchScroll(scroller);
        assert.equal(cortexTestStore.loadMoreCalls, 1, "loadMoreMessages called once memory is exhausted");

        // Provider prepends an older page (what loadMoreMessages does) —
        // it must render, and the scroll position must be compensated.
        const olderPage = Array.from({ length: 10 }, (_, i) => ({
            id: `older-${i}`,
            role: "system",
            content: `older message ${i}`,
            timestamp: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000),
        }));
        scroller.scrollTop = 0;
        act(() => {
            cortexTestStore.update((current) => [...olderPage, ...current]);
        });
        assert.equal(rowCount(container), 315, "prepended page rendered without trimming");
        assert.equal(scroller.scrollTop, 10 * ROW_HEIGHT, "scroll position compensated for prepended page");
    } finally {
        unmount();
    }
});

test("appends never trim the window out from under a reader", () => {
    const messages = loadFixtureMessages();
    const { container, unmount } = mountTerminal(messages);
    try {
        const scroller = container.querySelector(".custom-scrollbar");
        fakeScrollGeometry(scroller);

        // Reveal everything, reader parked mid-history (far from bottom).
        scroller.scrollTop = 0;
        dispatchScroll(scroller);
        scroller.scrollTop = 0;
        dispatchScroll(scroller);
        assert.equal(rowCount(container), 305);
        const firstRowBefore = container.querySelector("[data-message-row]").textContent;

        // Live messages keep arriving while they read.
        act(() => {
            cortexTestStore.update((current) => [...current, {
                id: "live-append-1",
                role: "assistant",
                content: "New reply while reading history.",
                timestamp: new Date(),
            }]);
        });
        assert.equal(rowCount(container), 306, "append rendered, nothing trimmed away");
        assert.equal(
            container.querySelector("[data-message-row]").textContent,
            firstRowBefore,
            "the row under the reader is still there",
        );

        // Back to the bottom → the window re-trims to the cap.
        scroller.scrollTop = scroller.scrollHeight;
        dispatchScroll(scroller);
        act(() => {
            cortexTestStore.update((current) => [...current, {
                id: "live-append-2",
                role: "assistant",
                content: "Another reply, reader now at the bottom.",
                timestamp: new Date(),
            }]);
        });
        assert.equal(rowCount(container), 200, "window re-trimmed once pinned to the bottom again");
    } finally {
        unmount();
    }
});
