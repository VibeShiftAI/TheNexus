import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf-8");

// Task 56c15b54 (2026-11-23) removed the Crew section from the main viewer:
// which executor runs what is the Ops graphic's job. PraxisCore pulls in a
// dozen live hooks, so this reads the source; the browser check
// (scripts/ops-graphic-browser-check.mjs) proves the same on the rendered page.
test("the main viewer no longer renders a Crew section or owns the executor drill-down", () => {
  const core = read("src/components/bridge/praxis-core.tsx");
  assert.equal(/useCrewActivity/.test(core), false, "the viewer does not read crew activity");
  assert.equal(/ExecutorDetailModal/.test(core), false, "the viewer does not mount the drill-down");
  assert.equal(/EXECUTOR_COLORS/.test(core), false, "the chip colours went with the chips");
  assert.equal(/>\s*crew\s*</i.test(core), false, "no Crew heading");
  assert.equal(/busyCrew|crew\.map/.test(core), false, "no crew chips");
});

test("the executor drill-down stays reachable from the Ops graphic: provider nodes and run nodes open it", () => {
  const station = read("src/components/bridge/dispatch-station.tsx");
  assert.match(station, /onInspect=\{setInspecting\}/);
  assert.match(station, /\{inspecting && <ExecutorDetailModal executor=\{inspecting\}/);
  const map = read("src/components/bridge/dispatch-map.tsx");
  assert.match(map, /className="dispatch-provider-button"/);
  assert.match(map, /<RunNode run=\{run\} provider=\{n\.label\} onOpen=\{\(\) => onInspect\(n\.id\)\} \/>/);
});

test("the Ops graphic has no fixed maximum on run nodes", () => {
  const map = read("src/components/bridge/dispatch-map.tsx");
  const graph = read("src/lib/ops-graph.ts");
  // Every provider's whole run list is mapped; nothing slices or caps it.
  assert.match(map, /n\.runs\.map\(run => <li key=\{run\.key\}>/);
  assert.equal(/runs\.slice\(|Math\.min\(\s*\d+\s*,\s*(n\.)?runs/.test(map), false);
  assert.equal(/\.slice\(|Math\.min\(/.test(graph), false);
});
