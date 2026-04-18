import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("dashboard work summary lives below the Praxis journal, not in the right sidebar", () => {
  const page = fs.readFileSync(path.join(root, "src/app/page.tsx"), "utf-8");
  const sidebar = fs.readFileSync(path.join(root, "src/components/dashboard-sidebar.tsx"), "utf-8");

  assert.ok(page.includes("<DailyJournal />"), "home page should render the Praxis journal");
  assert.ok(page.includes("<DashboardWorkSummary"), "home page should render the work summary row");
  assert.ok(
    page.indexOf("<DashboardWorkSummary") > page.indexOf("<DailyJournal />"),
    "work summary should render after the Praxis journal",
  );

  assert.equal(sidebar.includes("TaskStatusTiles"), false, "right sidebar should not render task status tiles");
  assert.equal(sidebar.includes("Active Project Workflows"), false, "right sidebar should not render active workflows");
});
