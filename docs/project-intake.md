# Durable project intake

Nexus stores project intake with the project record. `phase` is separate from
lifecycle `status`; old projects keep `phase = NULL` and `intake = NULL`.
Unassigned workspaces use `path = ''` plus `intake.workspace.state = unassigned`.
No intake operation creates directories, initializes Git, or dispatches work.

The shared wire contract is exported by `@praxis/contract` as
`CreateProjectIntakeSchema`, `ProjectIntakeOperationSchema`, and
`ProjectIntakeSchema`. Request schemas reject unknown fields.

## API

- `POST /api/projects/intake`: `operation_id`, `name`, `problem`, `source_ref`,
  optional `project_id`, `existing_path`, and `sources`. Returns 201 and
  `{ project, intake }`. `project_id` is an explicit exact existing binding;
  names and paths already owned by another project conflict rather than merge.
- `GET /api/projects/:id/intake`: exact project ID, returns `{ project, intake }`.
- `POST /api/projects/:id/intake/operations`: `operation_id`,
  `expected_revision`, `action`, and the action-specific fields below. Returns
  `{ project, intake }` after durable commit.

All operations require a stable client-generated operation ID. The same payload
replays the original saved response even after later changes. Reusing the ID for
a different payload returns 409 `INTAKE_OPERATION_COLLISION`. A stale revision
returns 409 `INTAKE_REVISION_STALE`. The caller must reload and reconcile rather
than silently retry a changed answer against a newer revision.

| Action | Fields and effect |
| --- | --- |
| `prepare` | Optional `brief`, `sources`, `needs`, `pending_need_id`; preparing → awaiting_choice. |
| `start` | Optional `pending_need_id`; awaiting_choice/deferred → interviewing. |
| `defer` | Optional `pending_need_id`; saves setup for later without starting work. |
| `answer` | `need_id`, `answer`, `source_ref`, `expected_knowledge_revision`; optional `evidence`, `verification`, `pending_need_id`. |
| `revise` | Optional `brief`, `sources`, `needs`, `pending_need_id`; material changes invalidate review. |
| `request_review` | `session_id`, `brief_revision`; records the frozen council identity and moves to council_review. |
| `record_review` | Matching `session_id`, `brief_revision`, `source_ref`, `findings`; optional `status` (completed/failed/partial) and follow-up `needs`. |
| `accept` | `brief_revision`, `source_ref`, `next_step`; adopts reviewed outcome and manual success criteria through project-data guards, then moves phase to planning. |
| `attach_workspace` | `existing_path`; exact existing or unavailable folder association on the same project ID, also permitted after handoff. |

`revision` increments for every successful operation. `brief_revision` increments
for material brief, source, question, and answer changes. A review and acceptance
refer to `brief_revision`, so state transitions do not make their own evidence
stale. `brief_history` preserves prior brief/source snapshots and the need
revisions required to reconstruct their evidence. Review history and immutable
operation responses remain durable.

## Need and evidence ownership

`project.needs` remains authoritative. Intake stores stable `need_ids` and one
`pending_need_id`, not another question registry. Definition writes merge by ID
and preserve omitted fields and unrelated needs. They cannot truncate a large
legacy registry or overwrite a need outside this intake.

Answers use the existing knowledge lifecycle guards. The original answer is
stored with its message evidence before explicit verification is applied, in
the same transaction. Human/decision/acceptance needs may use the answer message
as satisfaction evidence. Empirical needs also require an independently cited
evidence reference. A corrected answer preserves revision history and reopens
prior satisfaction. Invalid evidence or a failed receipt insert rolls back the
entire operation.

Open blocking needs require a resolution owner and next action before handoff.
Acceptance requires outcome, beneficiary, scope, success criteria, decision
owner, and a completed current review. Partial and failed reviews remain visible
and cannot authorize acceptance. Handoff preserves remaining needs.

## Admission boundaries

While `phase = intake`, work admission refuses new task filing, current dispatch
admission, and promotion into scheduled/executing states with 409
`PROJECT_INTAKE`. Existing board records remain readable. Knowledge corrections
save history but do not generate reconciliation tasks. Generic project writes
cannot bypass intake revision, phase, workspace, or endpoint handoff guards.

Workspace routes reject absent or unavailable paths with 409
`WORKSPACE_UNAVAILABLE`; paths never fall back to the server working directory.
Workspace writes are also blocked during intake for attached folders. Association
checks canonical identity, supports non-Git folders, and preserves an unavailable
supplied path without creating a replacement.

## Verification

`server/__tests__/project-intake.test.js` exercises the HTTP routes and temporary
SQLite databases, including replay, collisions, concurrent answers, storage
rollback, exact folder association, deferred/reopened state, stale review,
atomic handoff, large registries, and delivery admission. Existing project
knowledge and admission suites exercise compatibility outside intake.
