// Shared harness for the ai-terminal component tests: loads the real-
// conversation fixture, mounts AITerminal against the cortex test store, and
// drives keystrokes the way a browser would (native value setter + input
// event), timing each act() commit with performance.now().
import fs from "node:fs";
import { createElement, Profiler, act } from "react";
import { createRoot } from "react-dom/client";

import { AITerminal } from "../src/components/ai-terminal.tsx";
import { cortexTestStore } from "./stubs/cortex-provider.mjs";

const FIXTURE_PATH = new URL("./fixtures/bridge-conversation.json", import.meta.url);

/** 305 real messages of the live bridge conversation (tables + fenced code). */
export function loadFixtureMessages() {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    return raw.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: new Date(m.created_at),
    }));
}

/**
 * Mounts <AITerminal mode="inline"> with the given messages in the store.
 * Returns handles plus a commit log fed by a React Profiler wrapping the
 * whole terminal (actualDuration per commit, dev-build React).
 */
export function mountTerminal(messages, props = {}) {
    cortexTestStore.reset(messages);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const commits = [];
    act(() => {
        root.render(
            createElement(
                Profiler,
                {
                    id: "ai-terminal",
                    onRender: (_id, phase, actualDuration) => {
                        commits.push({ phase, actualDuration });
                    },
                },
                createElement(AITerminal, { isOpen: true, mode: "inline", hideHeader: true, ...props }),
            ),
        );
    });
    return {
        container,
        commits,
        unmount() {
            act(() => root.unmount());
            container.remove();
        },
    };
}

export function findComposerInput(container) {
    const input = container.querySelector('input[type="text"]');
    if (!input) throw new Error("composer input not found");
    return input;
}

const valueSetter = Object.getOwnPropertyDescriptor(
    globalThis.window.HTMLInputElement.prototype,
    "value",
).set;

/**
 * One keystroke: append a character through the native value setter and a
 * bubbling input event (what React 19 listens for), synchronously flushed
 * inside act(). Returns the wall-clock milliseconds the commit took —
 * keypress-to-commit latency.
 */
export function typeCharacter(input, character) {
    const started = performance.now();
    act(() => {
        valueSetter.call(input, input.value + character);
        input.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
    });
    return performance.now() - started;
}

export function pressKey(target, key, init = {}) {
    act(() => {
        target.dispatchEvent(
            new globalThis.window.KeyboardEvent("keydown", {
                key,
                bubbles: true,
                cancelable: true,
                ...init,
            }),
        );
    });
}

export function summarize(durations) {
    const sorted = [...durations].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return {
        n: sorted.length,
        mean: Number(mean.toFixed(2)),
        median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
        min: Number(sorted[0].toFixed(2)),
        max: Number(sorted[sorted.length - 1].toFixed(2)),
    };
}

export { cortexTestStore, act };
