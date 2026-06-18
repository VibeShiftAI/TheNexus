import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function loadStudioModule() {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/studio.ts"), "utf-8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === "./auth") {
        return { getAuthHeader: async () => ({}) };
      }
      return require(specifier);
    },
    URLSearchParams,
    fetch: async () => {
      throw new Error("fetch should not run in studio state tests");
    },
  };
  vm.runInNewContext(compiled, sandbox);
  return module.exports;
}

test("normalizes Studio boards that arrive without an embedded channel", () => {
  const { normalizeBoardState } = loadStudioModule();

  const board = normalizeBoardState({
    channels: [
      {
        id: "praxis-youtube",
        name: "Praxis YouTube Channel",
        default_cadence_target: 4,
      },
    ],
    ideas: [],
    sources: [],
    objects: [],
    referenceImages: [],
    promptable: [],
  }, "praxis-youtube");

  assert.equal(board.channel.name, "Praxis YouTube Channel");
  assert.equal(board.targetReady, 4);
  assert.deepEqual(board.ideas, []);
});

test("normalizes legacy Studio project lists into selectable channels", () => {
  const { normalizeBoardState } = loadStudioModule();

  const board = normalizeBoardState({
    targetReady: 2,
    projects: [
      {
        name: "Impossible Worlds Field Guide",
        type: "content",
        description: "A YouTube channel for impossible worlds.",
        eligible: true,
      },
      {
        name: "Praxis",
        type: "tool",
        description: "Discovered by scanner",
        eligible: true,
      },
      {
        name: "Chores Tracker",
        type: "mobile-app",
        eligible: false,
      },
    ],
    ideas: [],
    promptable: ["suggest_topics"],
  }, "impossible-worlds-field-guide");

  assert.deepEqual(Array.from(board.channels, (channel) => channel.id), [
    "impossible-worlds-field-guide",
    "praxis-youtube",
  ]);
  assert.equal(board.channel.name, "Impossible Worlds Field Guide");
});
