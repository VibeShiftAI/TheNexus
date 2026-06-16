import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("Nexus menu links to the multi-channel Studio", () => {
  const sidebar = fs.readFileSync(path.join(root, "src/components/nav-sidebar.tsx"), "utf-8");

  assert.match(sidebar, /label:\s*"Studio"/);
  assert.match(sidebar, /href:\s*"\/studio"/);
  assert.match(sidebar, /Clapperboard/);
});

test("Studio page exposes channel profile, source, object, and reference image work areas", () => {
  const studioPage = fs.readFileSync(path.join(root, "src/app/studio/page.tsx"), "utf-8");

  assert.match(studioPage, /Channel Profile/);
  assert.match(studioPage, /Source Ingestion/);
  assert.match(studioPage, /Object Catalog/);
  assert.match(studioPage, /Reference Images/);
});
