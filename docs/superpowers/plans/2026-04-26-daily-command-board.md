# Daily Command Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated `/task-board` Nexus page that tracks active tasks across projects by daily operational lane.

**Architecture:** Reuse the existing `/api/board-state` backend endpoint. Add a small typed client helper, pure board grouping/filtering utilities with tests, and a new Next client page that renders the command board with polling, filters, and status move actions.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind CSS, lucide-react, Node `node:test` for pure utility tests.

---

## File Structure

- Create `dashboard/src/lib/task-board.ts`: pure types, lane definitions, grouping, filtering, date formatting helpers.
- Create `dashboard/src/lib/__tests__/task-board.test.ts`: Node tests for lane grouping and filters.
- Modify `dashboard/src/lib/nexus.ts`: add board-state response types and `getBoardState()`.
- Create `dashboard/src/app/task-board/page.tsx`: dedicated command board UI.
- Modify `dashboard/src/app/page.tsx`: add `Task Board` link to the home header.

### Task 1: Task Board Utilities

**Files:**
- Create: `dashboard/src/lib/task-board.ts`
- Test: `dashboard/src/lib/__tests__/task-board.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
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
      { id: "done-1", project_id: "project-b", title: "Finished task", name: "Finished task", status: "done", priority: 1, is_unblocked: true, updated_at: "2026-04-26T14:00:00.000Z" },
    ],
  },
];

test("groupBoardTasks places tasks in operational lanes", () => {
  const grouped = groupBoardTasks(projects);

  assert.equal(grouped.new.tasks.map((task) => task.id).join(","), "new-1");
  assert.equal(grouped.ready.tasks.map((task) => task.id).join(","), "ready-1");
  assert.equal(grouped.in_progress.tasks.map((task) => task.id).join(","), "doing-1");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx tsx src/lib/__tests__/task-board.test.ts`

Expected: FAIL because `../task-board` does not exist.

- [ ] **Step 3: Implement the utility module**

Create `dashboard/src/lib/task-board.ts` with exported types `BoardTask`, `BoardProject`, `BoardLaneId`, constants `BOARD_LANES`, and functions `getBoardLaneId()`, `groupBoardTasks()`, `filterBoardTasks()`, `formatBoardTime()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx tsx src/lib/__tests__/task-board.test.ts`

Expected: PASS.

### Task 2: Board-State Client Helper

**Files:**
- Modify: `dashboard/src/lib/nexus.ts`

- [ ] **Step 1: Add typed board-state API helper**

Import `BoardProject` from `./task-board` and add:

```ts
export async function getBoardState(projectId?: string): Promise<BoardProject[]> {
    const baseUrl = API_URL.replace('/projects', '');
    const params = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await authFetch(`${baseUrl}/board-state${params}`);
    if (!res.ok) {
        throw new Error("Failed to fetch board state");
    }
    return res.json();
}
```

- [ ] **Step 2: Type-check**

Run: `cd dashboard && npx tsc --noEmit`

Expected: no TypeScript errors from the new helper.

### Task 3: Dedicated Task Board Page

**Files:**
- Create: `dashboard/src/app/task-board/page.tsx`

- [ ] **Step 1: Build the page shell**

Create a client page with Nexus-style header, back link, `Task Board` active badge, refresh button, search input, project selector, lane selector, and five columns from `BOARD_LANES`.

- [ ] **Step 2: Wire board data**

Use `getBoardState()`, `groupBoardTasks()`, and a 12-second polling interval. Show loading, error, and empty states.

- [ ] **Step 3: Render cards**

Each card shows title, project, status, priority, last updated, unblocked/blocked signal, and transcript marker when `task.metadata?.codex_transcript_path` or `task.metadata?.praxis_transcript_path` exists.

- [ ] **Step 4: Add simple status moves**

Use existing `updateTask(projectId, taskId, { status })` for card actions: start, block, suspend, complete, reopen. Refresh after successful updates.

- [ ] **Step 5: Type-check**

Run: `cd dashboard && npx tsc --noEmit`

Expected: no TypeScript errors.

### Task 4: Navigation And Verification

**Files:**
- Modify: `dashboard/src/app/page.tsx`

- [ ] **Step 1: Add home header navigation**

Add a top-header `Task Board` link using a lucide icon, placed near `System Monitor`.

- [ ] **Step 2: Run focused tests**

Run: `cd dashboard && npx tsx src/lib/__tests__/task-board.test.ts`

Expected: PASS.

- [ ] **Step 3: Build dashboard**

Run: `cd dashboard && npm run build`

Expected: production build completes.

- [ ] **Step 4: Start or reuse local dashboard**

Run: `lsof -nP -iTCP:3000 -sTCP:LISTEN || npm run dev -- --hostname 0.0.0.0`

Expected: dashboard is reachable locally.

- [ ] **Step 5: Browser smoke test**

Open `/task-board` and verify lanes render, filters work, and task cards do not overlap at desktop width.
