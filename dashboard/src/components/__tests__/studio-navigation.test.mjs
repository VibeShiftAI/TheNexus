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

test("Studio page exposes the YouTube production workflow", () => {
  const studioPage = fs.readFileSync(path.join(root, "src/app/studio/page.tsx"), "utf-8");

  assert.match(studioPage, /Pipeline running low/);
  assert.match(studioPage, /Ready to film/);
  assert.match(studioPage, /Add an idea manually/);
  assert.doesNotMatch(studioPage, /Object Catalog/);
});

test("Studio idea page keeps the video editor focused on production assets", () => {
  const ideaPage = fs.readFileSync(path.join(root, "src/app/studio/idea/[id]/page.tsx"), "utf-8");

  assert.match(ideaPage, /Write Script/);
  assert.match(ideaPage, /Thumbnail Concepts/);
  assert.match(ideaPage, /Publish Kit/);
  assert.doesNotMatch(ideaPage, /Object Catalog/);
  // Reference images are a first-class production asset on the episode page.
  assert.match(ideaPage, /Reference Images/);
});
