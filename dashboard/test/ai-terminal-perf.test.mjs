// Keypress-to-commit latency for the bridge chat composer at a realistic
// transcript size (305 fixture messages, tables and fenced code included).
// Reports numbers via performance.now() around each act() commit + a React
// Profiler actualDuration per commit.
//
// Record (2026-08-28, task c75b2fc6): measured with a 305-message extract of
// the REAL 5,207-message conversation (fixture since sanitized — regenerate
// via fixtures/generate-fixture.mjs). BEFORE, at baseline 5c41a07800e1:
// mean 178.02 ms/keystroke (median 175.59, max 220.88; Profiler
// actualDuration 146.6–200.6 ms). AFTER, at the fix commit: mean 0.27 ms
// (median 0.23, max 0.53; actualDuration 0.03–0.07 ms). Reproduce a BEFORE
// run by checking out dashboard/src/components/ai-terminal.tsx from
// 5c41a07800e1 in a scratch worktree and running:
//   node --import ./test/register.mjs --test test/ai-terminal-perf.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
    loadFixtureMessages,
    mountTerminal,
    findComposerInput,
    typeCharacter,
    summarize,
} from "./helpers.mjs";

test("composer keypress-to-commit latency at 305 loaded messages", () => {
    const messages = loadFixtureMessages();
    assert.ok(messages.length >= 150, "fixture must hold at least 150 messages");
    assert.ok(messages.some((m) => m.content.includes("```")), "fixture includes fenced code");
    assert.ok(messages.some((m) => /\|\s*---|---\s*\|/.test(m.content)), "fixture includes tables");

    const { container, commits, unmount } = mountTerminal(messages);
    try {
        const input = findComposerInput(container);

        // Warmup (first keystrokes pay one-off module/JIT costs).
        typeCharacter(input, "w");
        typeCharacter(input, "w");

        const commitsBefore = commits.length;
        const durations = [];
        const text = "status rep";
        for (const character of text) {
            durations.push(typeCharacter(input, character));
        }

        assert.equal(input.value, `ww${text}`, "typed text reached the input");

        const profiled = commits.slice(commitsBefore).map((c) => Number(c.actualDuration.toFixed(2)));
        console.log(`[perf] keypress-to-commit ms over ${durations.length} keystrokes:`, summarize(durations));
        console.log(`[perf] React Profiler actualDuration ms per keystroke commit:`, profiled);
    } finally {
        unmount();
    }
});
