import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_LANES,
  filterBoardTasks,
  groupBoardTasks,
  type BoardProject,
} from "../task-board";

const projects: BoardProject[] = [
  {
    id: "project-a",
    name: "Alpha",
    status: "active",
    tasks: [
      { id: "new-1", project_id: "project-a", title: "Capture request", name: "Capture request", status: "idea", priority: 0, is_unblocked: true, updated_at: "2026-04-26T10:00:00.000Z" },
      { id: "ready-1", project_id: "project-a", title: "Ready work", name: "Ready work", status: "queued", priority: 1, is_unblocked: true, updated_at: "2026-04-26T11:00:00.000Z" },
      { id: "blocked-1", project_id: "project-a", title: "Blocked dependency", name: "Blocked dependency", status: "queued", priority: 1, is_unblocked: false, updated_at: "2026-04-26T12:00:00.000Z" },
    ],
  },
  {
    id: "project-b",
    name: "Beta",
    status: "active",
    tasks: [
      { id: "doing-1", project_id: "project-b", title: "Codex run", name: "Codex run", status: "in_progress", priority: 2, is_unblocked: true, updated_at: "2026-04-26T13:00:00.000Z" },
      { id: "doing-2", project_id: "project-b", title: "Praxis dispatch", name: "Praxis dispatch", status: "in-progress", priority: 2, is_unblocked: true, updated_at: "2026-04-26T13:30:00.000Z" },
      { id: "done-1", project_id: "project-b", title: "Finished task", name: "Finished task", status: "done", priority: 1, is_unblocked: true, updated_at: "2026-04-26T14:00:00.000Z" },
    ],
  },
];

test("groupBoardTasks places tasks in operational lanes", () => {
  const grouped = groupBoardTasks(projects);

  assert.equal(grouped.new.tasks.map((task) => task.id).join(","), "new-1");
  assert.equal(grouped.ready.tasks.map((task) => task.id).join(","), "ready-1");
  assert.equal(grouped.in_progress.tasks.map((task) => task.id).sort().join(","), "doing-1,doing-2");
  assert.equal(grouped.needs_attention.tasks.map((task) => task.id).join(","), "blocked-1");
  assert.equal(grouped.complete.tasks.map((task) => task.id).join(","), "done-1");
  assert.equal(BOARD_LANES.length, 5);
});

test("filterBoardTasks filters by project, lane, and search text", () => {
  const grouped = groupBoardTasks(projects);

  assert.equal(filterBoardTasks(grouped.ready.tasks, { projectId: "project-a", laneId: "ready", query: "ready" }).length, 1);
  assert.equal(filterBoardTasks(grouped.ready.tasks, { projectId: "project-b", laneId: "ready", query: "" }).length, 0);
  assert.equal(filterBoardTasks(grouped.in_progress.tasks, { projectId: "all", laneId: "all", query: "beta codex" }).length, 1);
});
