import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function loadCouncil(fetchImpl) {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/council.ts"), "utf-8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { exports: module.exports, module, fetch: fetchImpl, Date, URLSearchParams };
  vm.runInNewContext(compiled, sandbox);
  return module.exports;
}

test("summonCouncil posts dashboard input to the Praxis summon proxy", async () => {
  const calls = [];
  const council = loadCouncil(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: "🏛️ **Council convened** — session `council-abc-123`.",
      }),
    };
  });

  const result = await council.summonCouncil({
    topic: "Should we summon the cabinet?",
    context: "Use the existing chamber.",
    deliverable: "analysis",
    domain: "strategy",
    focus: true,
  });

  assert.deepEqual(result, {
    ok: true,
    result: "🏛️ **Council convened** — session `council-abc-123`.",
  });
  assert.equal(calls[0].url, "/api/praxis/council/summon");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    topic: "Should we summon the cabinet?",
    context: "Use the existing chamber.",
    deliverable: "analysis",
    domain: "strategy",
    focus: true,
  });
});

test("sessionIdFromCouncilAck extracts the convened session id", () => {
  const council = loadCouncil(() => {
    throw new Error("fetch should not be called");
  });

  assert.equal(
    council.sessionIdFromCouncilAck("🏛️ **Council convened** — session `council-abc-123`."),
    "council-abc-123",
  );
  assert.equal(council.sessionIdFromCouncilAck("no session here"), null);
});

test("summonCouncil rejects ok:false Praxis responses", async () => {
  const council = loadCouncil(async () => ({
    ok: true,
    json: async () => ({ ok: false, error: "A council is already in session" }),
  }));

  await assert.rejects(
    () => council.summonCouncil({ topic: "Should this fail?" }),
    /A council is already in session/,
  );
});
