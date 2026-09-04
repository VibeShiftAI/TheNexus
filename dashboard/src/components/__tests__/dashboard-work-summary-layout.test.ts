import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

// cfe131d (2026-05-19, "unified Dashboard cockpit") replaced the journal +
// work-summary home layout with the bridge cockpit: PraxisCore viewer first,
// stations below it, and the HITL inbox / schedule / activity rail beside it.
// DailyJournal, DashboardWorkSummary and DashboardSidebar are no longer
// rendered by the home page, so this test asserts the cockpit layout instead.
test("home page renders the bridge cockpit instead of the journal + work summary layout", () => {
  const page = fs.readFileSync(path.join(root, "src/app/page.tsx"), "utf-8");
  const sidebar = fs.readFileSync(path.join(root, "src/components/dashboard-sidebar.tsx"), "utf-8");

  assert.equal(page.includes("<DailyJournal"), false, "home page no longer renders the Praxis journal (removed in cfe131d)");
  assert.equal(page.includes("<DashboardWorkSummary"), false, "home page no longer renders the work summary row (removed in cfe131d)");
  assert.equal(page.includes("<DashboardSidebar"), false, "home page no longer renders the legacy dashboard sidebar (removed in cfe131d)");

  assert.ok(page.includes("<PraxisCore"), "home page should render the Praxis core viewer");
  assert.ok(page.includes("<TaskBoardStation"), "home page should render the task board station");
  assert.ok(page.includes("<HitlInbox"), "home page should render the HITL inbox rail");
  assert.ok(
    page.indexOf("<TaskBoardStation") > page.indexOf("<PraxisCore"),
    "task board station should render below the Praxis core viewer",
  );

  assert.equal(sidebar.includes("TaskStatusTiles"), false, "legacy sidebar remains free of work-summary widgets");
});
