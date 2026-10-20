# Actionable knowledge implementation plan

> Use superpowers:subagent-driven-development for implementation and independent spec/code review. Follow test-driven-development. User explicitly requested the workflow refinement; continue the existing approved implementation without another approval round.

**Goal:** Show only prioritized actionable knowledge by default, display completed stages accurately, and make semantic changes to applied knowledge produce traceable work.

**Architecture:** Derive UI state from the current verified answer and latest per-task application outcomes. Completed, deferred and superseded records remain in collapsed history. At the database write boundary, changes to previously applied knowledge create or refresh work in the same governed transaction, using normal task admission and existing immutable application records as the routing receipt. No new scheduler and no task dispatch.

**Tech stack:** Existing Express/SQLite and Next/React/TypeScript.

## 1. Task routing after applied knowledge changes

- [x] Add failing real-DB tests: changed applied answer creates an idea task when prior tasks have run; a linked never-run task is updated; retries/no-op edits do not duplicate work; wrong-project targets are rejected; task/admission failure rolls back the knowledge edit; completed/in-progress/previously-run tasks remain unchanged.
- [x] Add focused helper `db/knowledge-change-work.js`, call it from `writeProject` after `prepareProjectPatch` and before persistence, under the existing board lease and SQLite transaction. Trigger only actual question/answer/test/evidence/criterion changes with a prior positive application, not labels, deferral, verification or application recording alone. Preserve old applications/history. Resolve task IDs from canonical rows and durable dispatch evidence, never status alone.
- [x] Update all relevant never-run tasks through existing `updateTask` with version guard, retaining unrelated fields, and register a source/revision-specific pending-work receipt. When a destination already ran (or is missing), create one ordinary idea follow-up through `createTask`/work admission and bind the current need to the replacement task. Existing completed task IDs remain in application history. A pending follow-up is reusable on further revisions only while never run.
- [x] Keep positive application separate from work creation: append a `ready` application receipt at the new answer revision; require verification before applying the revision. Provide source/new/old revision and instructions in task context. Fail closed if persistence/admission fails. Preserve route/version/history on all writers and verify no-op replay.

## 2. Action list and buttons

- [x] Add failing helper/component tests for the actual historical-applied case, deferred exclusion, partially applied and later-failed applications, legacy singular application compatibility, and priority ordering independent of storage order.
- [x] Extend `knowledgeLifecycle` with `applied`, `complete`, `actionRequired`, stage labels, and pending task counts. Use last per-task current-revision outcomes, and recognize legacy singular application where no list exists.
- [x] Default list is Action needed, with only actionable records. Order current-checkpoint blockers first, then other blockers, then questions linked to current unfinished tasks, then remaining questions; stable age/id ties. Display the reason for priority. Completed/deferred/superseded records remain in separately collapsed sections.
- [x] Show Answer recorded / Verified / Applied stage completion. Action buttons represent remaining steps; never offer Verify answer again as an unfinished action on a verified record, or Apply to task on an already fully applied record. Keep View history and Revise applied answer available in completed history. Edit form explains and labels the save as saving a revision plus updating follow-up work.

## 3. Verification and activation

- [x] Run focused UI and API suites, contract/security regressions as relevant, TypeScript/production dashboard build, and isolated real-API browser checks for save/route/readback behavior.
- [x] Independent spec review, then code-quality review, fix material findings and reverify affected paths.
- [x] Commit only task changes in existing isolated worktrees, copy only deltas to originals under fresh source hash guards and backup, restart supervised Nexus if changed, inspect Joey live page (read-only). No fabricated answer/application or live demonstration task.
- [x] Report the historical item has no remaining action, the new ordering and completion controls, routing behavior, and concrete verification.

## Verification recorded

- Backend: 210 passing tests across nine scoped suites; one intentional skip.
- Dashboard: 35 focused helper/component tests pass; isolated production build passes.
- Browser: synthetic applied answer revised through real UI/API; original completed task unchanged, admitted idea follow-up linked, previous application retained, new revision awaits verification.
- Spec review approved at `1e5a899`; final code review approved at `d1cf8cf`.
- Follow-up task ancestry and reverse-only task links are included in action/priority calculations; saves refresh project tasks.
- Activation: 12 scoped files copied under hash guards with backups; original index retained. Supervised Nexus PID changed from 31291 to 42635. Live page confirms 11 action items, 1 completed, 37 deferred, 1 retired; historical item shows verified/applied and no remaining action. Integrated checks: 35 UI and 72 backend tests pass.
