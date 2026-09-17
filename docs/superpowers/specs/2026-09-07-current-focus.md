# Current Focus — approved design

Robert approved evolving CREW on September 7, 2026 after discussing the alternative of an additional pip. Preserve the seven-pip grid and HUD styling. A click opens a wide HUD panel grouped by project, showing task purpose/title, reported stage/action, executor/model when known, timestamp, task/activity links and approval links. Keep existing crew controls inside the Praxis viewer and Ops station.

## Acceptance

1. The Current Focus pip occupies CREW's existing position. The full panel groups all reported running and waiting tasks by their real project; unknown ownership is explicit. No project is inferred from task wording or workspace guesses.
2. Runtime execution, queue entries, persisted provider reset waits, pending human input, and board-only in-progress tasks are different states. A board label alone never counts as running. Task IDs deduplicate signals; evidence freshness and feed failures are visible. No invented percentages, actions, model identity, or reset times.
3. Reuse shared dashboard read feeds, expose only safe fields from the existing persisted usage-wait ledger, and make no model calls or execution/email mutations. Provide keyboard-accessible opening/closing, mobile-safe rows and links. Verify with focused derivation/API/UI tests, a dashboard build and live interaction.

## Data and boundaries

Use the shared board and dispatch snapshots, existing status-strip HITL requests, and shared task-correlated progress events. Resolve titles/projects from board IDs. Match model identity from the same task/executor's recorded session. Expose a sanitized usage-resume ledger projection on the existing Nexus dispatch-state proxy: taskId, executor, model, limitedAt, resumeAt and attention state; omit prompts, session IDs, workspace, baselines and execution payloads. Missing or malformed telemetry is unavailable, not an empty successful state.

Work not tied to a project (e.g. active or queued local jobs) appears in its own group. Full raw task text and execution history remain in the existing task page. Current Focus is visibility, not a scheduler or a strategic priority picker. Email remains manually triaged by Robert.

## Verified coverage note

Praxis cron-registry defines `running` as schedule enabled (`!paused`), not callback execution. These records cannot prove live maintenance work and are deliberately excluded from execution counts. The panel states that maintenance without execution reports may not appear. No scheduler instrumentation was added.
