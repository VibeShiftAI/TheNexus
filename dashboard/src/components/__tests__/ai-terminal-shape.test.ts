/**
 * Source-shape guard for the P2-27 decomposition.
 *
 * ai-terminal.tsx was ~2,275 lines mixing chat transport, markdown +
 * syntax-highlight rendering, voice/audio playback, file attachments, history
 * management and task-link decoration. A 2026-07-02 comment records an
 * earlier pruning that removed the model picker WITHOUT decomposing — the
 * file grew back. This test is the ratchet: the terminal stays composition +
 * transport, and the render pipeline stays behind the memoized chat
 * components where a re-render can't pay for it twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../ai-terminal.tsx", import.meta.url));
const source = readFileSync(SOURCE, "utf8");

/** Max lines ai-terminal.tsx is allowed to be. */
const LINE_BUDGET = 700;

test("ai-terminal.tsx does not import the markdown/highlight pipeline directly", () => {
    const importedModules = [...source.matchAll(/^\s*import\s[\s\S]*?from\s+["']([^"']+)["']/gm)]
        .map((m) => m[1]);
    for (const banned of ["react-markdown", "remark-gfm", "react-syntax-highlighter"]) {
        const hit = importedModules.find((m) => m === banned || m.startsWith(`${banned}/`));
        assert.equal(
            hit,
            undefined,
            `ai-terminal.tsx must render markdown through components/chat/*, not import ${banned} itself`,
        );
    }
});

test("ai-terminal.tsx stays under its line budget", () => {
    const lines = source.split("\n").length;
    assert.ok(
        lines < LINE_BUDGET,
        `ai-terminal.tsx is ${lines} lines, budget is ${LINE_BUDGET} — extract another lane rather than raising this number`,
    );
});

test("the extracted lanes are the ones the terminal composes with", () => {
    for (const mod of [
        "@/hooks/use-chat-audio",
        "@/hooks/use-chat-history",
        "@/hooks/use-file-attachments",
        "@/components/chat/composer",
        "@/components/chat/message-row",
    ]) {
        assert.ok(source.includes(`from "${mod}"`), `expected ai-terminal.tsx to compose ${mod}`);
    }
});
