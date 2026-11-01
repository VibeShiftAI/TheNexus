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

test('intake preparation surfaces tool-level rejection inside a successful bridge response', async () => {
  const council = loadCouncil(async () => ({ ok: true, json: async () => ({ ok: true, result: JSON.stringify({ ok: false, error: 'operation_id conflict' }) }) }));
  await assert.rejects(() => council.summonProblemCouncil({ operation_id: 'request-1', source_ref: 'chamber:request-1', problem: 'Help teachers' }), /operation_id conflict/);
});

test('intake preparation exposes its actual saved job and project instead of claiming completion', async () => {
  const calls = [];
  const council = loadCouncil(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, result: JSON.stringify({ ok: true, session_id: 'intake-abc', project_id: 'project-1', operation_id: 'request-1:preparation', state: 'queued', next: 'Request saved; use status.' }) }) }; });
  const result = await council.summonProblemCouncil({ operation_id: 'request-1', source_ref: 'chamber:request-1', problem: 'Help teachers' });
  assert.equal(result.session_id, 'intake-abc');
  assert.equal(result.project_id, 'project-1');
  assert.equal(result.state, 'queued');
  assert.match(result.result, /saved|queued/i);
  assert.equal(JSON.parse(calls[0].options.body).operation_id, 'request-1');
});

test('Chamber persists one request identity across retries and reloads and allocates another when words change', () => {
  const council = loadCouncil(() => { throw Error('No network'); });
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let sequence = 0;
  const identity = () => `request-${++sequence}`;
  assert.equal(typeof council.prepareProblemCouncilRequest, 'function');
  const first = council.prepareProblemCouncilRequest({ problem: 'Help teachers', context: 'Limited time' }, storage, identity);
  const replay = loadCouncil(() => {}).prepareProblemCouncilRequest({ problem: 'Help teachers', context: 'Limited time' }, storage, identity);
  assert.equal(first.operation_id, replay.operation_id);
  assert.equal(replay.source_ref, 'chamber:request-1');
  assert.equal(council.prepareProblemCouncilRequest({ problem: 'Help nurses' }, storage, identity).operation_id, 'request-2');
});
