import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("Praxis journal exposes the YouTube script tab", () => {
  const component = fs.readFileSync(path.join(root, "src/components/daily-journal.tsx"), "utf-8");
  // Read through the installed package, the contract this dashboard builds against.
  // A task worktree has no nexus-shared folder beside its TheNexus checkout.
  const contract = fs.readFileSync(path.join(root, "node_modules/@praxis/contract/src/notes.ts"), "utf-8");

  assert.match(component, /key: "youtube-scripts"/);
  assert.match(component, /label: "YouTube Scripts"/);

  assert.match(contract, /'youtube-scripts'/);
});

test("Stock Analysis has no journal tab after the trading council retirement, but its old notes keep their badge", () => {
  const component = fs.readFileSync(path.join(root, "src/components/daily-journal.tsx"), "utf-8");
  const contract = fs.readFileSync(path.join(root, "node_modules/@praxis/contract/src/notes.ts"), "utf-8");

  // Retired 2026-11-23: no tab and no way to file a new stock-analysis note.
  assert.doesNotMatch(component, /key: "stock-analysis"/);
  assert.doesNotMatch(component, /<option value="stock-analysis">/);

  // The 67 historical notes stay in the database and still render under "All".
  assert.match(component, /"stock-analysis": \{ label: "Stock Analysis"/);
  assert.match(contract, /'stock-analysis'/);
});
