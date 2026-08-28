// Enforcement boundary for the bridge chat composer:
//   1. Typing must not render the transcript AT ALL — the composer's
//      keystroke state is not readable by the message list.
//   2. An unchanged message body must never re-run the ReactMarkdown/Prism
//      pipeline, however often the transcript re-renders around it
//      (streaming chunks, resync inserts).
// Counters: parseCounter increments once per MarkdownMessage body parse,
// splitCounter once per TaskLinkedText render, and a Date#toLocaleTimeString
// spy fires once per user/assistant row whose render body executes.
import test from "node:test";
import assert from "node:assert/strict";

import {
    loadFixtureMessages,
    mountTerminal,
    findComposerInput,
    typeCharacter,
    act,
    cortexTestStore,
} from "./helpers.mjs";
import { parseCounter } from "./stubs/normalize-markdown.mjs";
import { splitCounter } from "./stubs/task-links.mjs";

function withTimestampSpy(fn) {
    const original = Date.prototype.toLocaleTimeString;
    const spy = { count: 0 };
    Date.prototype.toLocaleTimeString = function toLocaleTimeString(...args) {
        spy.count += 1;
        return original.apply(this, args);
    };
    try {
        return fn(spy);
    } finally {
        Date.prototype.toLocaleTimeString = original;
    }
}

test("typing in the composer renders zero transcript rows and re-parses nothing", () => {
    const { container, commits, unmount } = mountTerminal(loadFixtureMessages());
    try {
        const input = findComposerInput(container);
        withTimestampSpy((rowRenders) => {
            parseCounter.count = 0;
            splitCounter.count = 0;
            rowRenders.count = 0;
            const commitsBefore = commits.length;

            for (const character of "hello") {
                typeCharacter(input, character);
            }

            assert.equal(input.value, "hello", "keystrokes reached the composer");
            assert.ok(commits.length > commitsBefore, "each keystroke did commit (composer re-rendered)");
            assert.equal(parseCounter.count, 0, "no message body re-entered the markdown/Prism pipeline");
            assert.equal(splitCounter.count, 0, "no plain-text row re-ran task-id linking");
            assert.equal(rowRenders.count, 0, "no user/assistant message row executed its render");
        });
    } finally {
        unmount();
    }
});

test("streaming chunks re-parse only the streaming message, never the history", () => {
    const { unmount } = mountTerminal(loadFixtureMessages());
    try {
        act(() => {
            cortexTestStore.update((messages) => [...messages, {
                id: "stream-1",
                role: "assistant",
                content: "",
                timestamp: new Date(),
            }]);
        });

        for (let chunk = 1; chunk <= 3; chunk++) {
            parseCounter.count = 0;
            splitCounter.count = 0;
            act(() => {
                cortexTestStore.update((messages) => messages.map((m) =>
                    m.id === "stream-1"
                        ? { ...m, content: `${m.content}delta ${chunk} with **markdown** ` }
                        : m,
                ));
            });
            assert.equal(parseCounter.count, 1, `chunk ${chunk}: exactly the streaming message re-parsed`);
            assert.equal(splitCounter.count, 0, `chunk ${chunk}: memoized plain-text rows untouched`);
        }
    } finally {
        unmount();
    }
});

test("a resync-style mid-list insert parses only the inserted message", () => {
    const { container, unmount } = mountTerminal(loadFixtureMessages());
    try {
        parseCounter.count = 0;
        const inserted = {
            id: "resync-catchup-1",
            role: "assistant",
            content: "Missed **message** caught up by resync.",
            timestamp: new Date(),
        };
        act(() => {
            cortexTestStore.update((messages) => {
                // Land inside the rendered tail window, mid-list — the shape
                // mergeFetchedMessages produces for a caught-up gap.
                const at = messages.length - 50;
                return [...messages.slice(0, at), inserted, ...messages.slice(at)];
            });
        });
        assert.equal(parseCounter.count, 1, "only the caught-up message entered the markdown pipeline");
        assert.ok(
            [...container.querySelectorAll("[data-message-row]")].some((row) =>
                row.textContent.includes("caught up by resync")),
            "the inserted message rendered",
        );
    } finally {
        unmount();
    }
});
