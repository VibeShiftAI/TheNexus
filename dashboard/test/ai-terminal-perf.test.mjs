// Keypress-to-commit latency for the bridge chat composer at a realistic
// transcript size (305 real messages of the live conversation, tables and
// fenced code included). Reports numbers; run before AND after the
// composer-isolation fix to compare. performance.now() around each act()
// commit + a React Profiler actualDuration per commit.
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
    assert.ok(messages.length >= 150, "fixture must hold at least 150 real messages");
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
