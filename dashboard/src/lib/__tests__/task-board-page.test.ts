import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const page = fs.readFileSync(path.join(root, "src/app/task-board/page.tsx"), "utf-8");

test("task board cards show descriptions instead of action controls", () => {
  assert.equal(page.includes("const ACTIONS"), false, "task cards should not define quick status actions");
  assert.equal(page.includes("onMoveTask"), false, "task cards should not expose quick status action handlers");
  assert.equal(page.includes("unblocked"), false, "task cards should not show unblocked badges");
  assert.match(page, /task\.description/, "task cards should render description text");
});
