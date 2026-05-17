import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("Praxis journal exposes stock analysis and YouTube script tabs", () => {
  const component = fs.readFileSync(path.join(root, "src/components/daily-journal.tsx"), "utf-8");
  const contract = fs.readFileSync(path.join(root, "../packages/contract/src/notes.ts"), "utf-8");

  assert.match(component, /key: "stock-analysis"/);
  assert.match(component, /label: "Stock Analysis"/);
  assert.match(component, /key: "youtube-scripts"/);
  assert.match(component, /label: "YouTube Scripts"/);

  assert.match(contract, /'stock-analysis'/);
  assert.match(contract, /'youtube-scripts'/);
});
