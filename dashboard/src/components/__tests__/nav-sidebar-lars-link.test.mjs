import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

test("Nexus hamburger menu links to the LARS dashboard", () => {
  const sidebar = fs.readFileSync(path.join(root, "src/components/nav-sidebar.tsx"), "utf-8");

  assert.match(sidebar, /label:\s*"LARS Dashboard"/);
  assert.match(sidebar, /const larsDashboardHref = "http:\/\/192\.168\.86\.205:7878"/);
  assert.doesNotMatch(sidebar, /href:\s*"http:\/\/127\.0\.0\.1:7878"/);
  assert.match(sidebar, /external:\s*true/);
});
