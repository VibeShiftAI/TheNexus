import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dashboardRoot = process.cwd();

test("dispatch client forwards the provider selected by the console", async () => {
  const { dispatchTask } = await import("../../lib/dispatches.ts");
  const previousFetch = globalThis.fetch;
  let payload;

  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return new Response(JSON.stringify({
      ok: false,
      refused: true,
      reason: "missing_key",
      reply: "Dispatch blocked by key-aware routing: no ANTHROPIC_API_KEY.",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  };

  let result;
  try {
    result = await dispatchTask({
      taskId: "task-1",
      executor: "claude-code",
      model: "claude-opus-5",
      provider: "anthropic",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(payload.provider, "anthropic");
  assert.equal(result.refused, true);
  assert.match(result.reply, /ANTHROPIC_API_KEY/);
});

test("pinned CLI models use subscriptions; API routes still require keys", async () => {
  const { dispatchModelKeyProvider } = await import("../../lib/dispatch-model-key-lane.ts");
  assert.equal(dispatchModelKeyProvider("codex", "openai"), null);
  assert.equal(dispatchModelKeyProvider("claude-code", "anthropic"), null);
  assert.equal(dispatchModelKeyProvider("antigravity", "google"), null);
  assert.equal(dispatchModelKeyProvider("openrouter", "openrouter"), "openrouter");
  assert.equal(dispatchModelKeyProvider("codex", "anthropic"), "anthropic");
});
