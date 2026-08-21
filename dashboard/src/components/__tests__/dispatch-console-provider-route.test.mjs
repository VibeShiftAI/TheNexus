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

test("console blocks a selected provider model when its key is missing", () => {
  const hook = fs.readFileSync(
    path.join(dashboardRoot, "src/hooks/use-executor-models.ts"),
    "utf-8",
  );
  const consoleSource = fs.readFileSync(
    path.join(dashboardRoot, "src/components/task-view/dispatch-console.tsx"),
    "utf-8",
  );

  assert.match(hook, /provider:\s*m\.provider/);
  assert.match(hook, /providerKeys\.find\(\(p\) => p\.provider === option\.provider\)/);
  assert.match(consoleSource, /const selectedProvider = model/);
  assert.match(consoleSource, /selectedOption\?\.provider\s*\?\?/);
  assert.match(consoleSource, /provider:\s*selectedProvider/);
  assert.match(consoleSource, /disabled=\{busy \|\| Boolean\(routeBlock\)\}/);
});
