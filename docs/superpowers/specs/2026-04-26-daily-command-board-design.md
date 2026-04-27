# Daily Command Board Design

## Goal

Create a top-level Nexus page that tracks work moving through the day across all active projects. The board should make it easy to see new tasks, queued work, active agent/operator work, blocked items, and completions without opening each project.

## Route And Navigation

- Add a new dashboard route at `/task-board`.
- Add a top-header link from the home dashboard labeled `Task Board`.
- Keep the page visually consistent with the current Nexus dashboard and system monitor: dark operational UI, compact controls, dense readable cards.

## Data Source

- Use the existing `/api/board-state` endpoint as the primary data source.
- The endpoint already returns active projects, tasks, dependency resolution, and task summaries.
- Add dashboard client types/helpers in `dashboard/src/lib/nexus.ts` rather than duplicating fetch logic in the page.

## Board Columns

The first pass groups existing task statuses into five operational lanes:

- `New`: `idea`, `planning`
- `Ready`: unblocked tasks that are not complete, suspended, blocked, failed, or already active
- `In Progress`: `building`, `in_progress`, `review`, `implementing`, `researching`
- `Needs Attention`: `blocked`, `suspended`, `failed`, `awaiting_approval`, `rejected`
- `Complete`: `done`, `complete`, `completed`

If a task has dependencies, the existing `is_unblocked` flag controls whether it appears as `Ready` or `Needs Attention`.

## Task Cards

Each card should show:

- Task title
- Project name
- Current status
- Priority
- Last updated time
- Blocked/unblocked indicator
- Optional source/executor hints when present in existing task fields or metadata
- Optional transcript marker when Codex/Praxis transcript metadata exists

Cards should be compact and scannable. Opening a card should reuse the existing `TaskDetailModal` when practical, or link to the project/task context if the modal requires too much project-local state.

## Controls

First pass controls:

- Project filter
- Status/lane filter
- Text search across task and project names
- Manual refresh
- Automatic polling every 10 to 15 seconds
- Per-card status move controls using existing task update APIs when the project ID is available

Deferred controls:

- Drag-and-drop between lanes
- Custom lane definitions
- Persistent board ordering
- Inline transcript drawer

## Empty And Error States

- Loading state: centered spinner or compact skeleton lanes.
- Empty state: clear message when no tasks match filters.
- Error state: show backend connection failure and a retry button.
- Partial data state: render projects/tasks that are available and surface failures without blanking the whole page.

## Testing

Add focused tests for:

- Status-to-lane grouping logic
- Filter behavior
- Board-state client helper route

If the page is implemented mostly as a client component, keep pure grouping/filtering logic in a separate helper so it can be tested without a browser.

## Out Of Scope

- Replacing the per-project task manager
- Creating a new task database table
- Full drag-and-drop project-management behavior
- Building transcript storage, though the board should expose transcript metadata once the Praxis/Codex dispatch work provides it
