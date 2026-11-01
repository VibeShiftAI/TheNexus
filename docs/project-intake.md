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
| `prepare` | Optional `brief`, `sources`, `needs`, `pending_need_id`; preparing → awaiting_choice only with a nonblank outcome or purpose and at least one authoritative information need (answered needs count). |
| `start` | Optional `pending_need_id`; awaiting_choice/deferred → interviewing. |
| `defer` | Optional `pending_need_id`; saves the interview for later without initiating work. Explicitly requested tasks and research remain available. |
| `answer` | `need_id`, `answer`, `source_ref`, `expected_knowledge_revision`; optional `evidence`, `verification`, `pending_need_id`. |
| `revise` | Optional `brief`, `sources`, `needs`, `pending_need_id`; material changes invalidate review. |
| `request_review` | `session_id`, `brief_revision`, optional `mode` (review by default). Explicit preparation additionally requires `source_ref`; records frozen council identity and moves to council_review. |
| `record_review` | Matching `session_id`, `brief_revision`, `source_ref`, `findings`; optional `status` (completed/failed/partial) and follow-up `needs`. Preparation alone may supply `brief` and `sources`. |
| `accept` | Current `brief_revision`, real `source_ref`, `next_step`; optional `decision_note`. Records the operator decision from any non-handed-off state, adopts known endpoint fields through project-data guards, then moves phase to planning. |
| `attach_workspace` | `existing_path`; optional audit `source_ref`. Explicitly attaches or replaces the existing or unavailable folder association on the same project ID, before or after handoff. |

`revision` increments for every successful operation. `brief_revision` increments
for material brief, source, question, and answer changes. A review and acceptance
refer to `brief_revision`, so state transitions do not make their own evidence
stale. `brief_history` preserves prior brief/source snapshots and the need
revisions required to reconstruct their evidence. Review history and immutable
operation responses remain durable.

## Need and evidence ownership

`project.needs` remains authoritative. Intake stores stable `need_ids` and one
`pending_need_id`, not another question registry. Explicit existing-project binding adopts its structured information need IDs
without rewriting answers, verification, or history. Definition writes merge by ID,
require `expected_knowledge_revision` for existing needs, and preserve omitted fields and unrelated needs. They cannot truncate a large
legacy registry or overwrite a need outside this intake.

Answers use the existing knowledge lifecycle guards. The original answer is
stored with its message evidence before explicit verification is applied, in
the same transaction. Human/decision/acceptance needs may use the answer message
as satisfaction evidence. Empirical needs also require an independently cited
evidence reference. A corrected answer preserves revision history and reopens
prior satisfaction. Invalid evidence or a failed receipt insert rolls back the
entire operation. Source content, revision, availability, or processing-result
changes reopen only knowledge that cites the changed source in its evidence or
verification. They retain the old answer and verification in revision history,
invalidate dependent assessments, and fence prior council results in the same
transaction. Retired needs remain retired. Identical source content and changes
only to `retrieved_at` retain verification and the current reviewed brief.

Purpose, outcome, beneficiary, scope, success criteria, decision owner, a current
completed review, and resolution plans for open intake or blocking knowledge needs
are readiness goals. A clear instruction to proceed is authorization; missing goals
do not require an additional approval or override flag. Acceptance records remaining
goals in `acceptance.readiness_gaps`, including unresolved review follow-ups and
missing resolution methods, owners or next actions. Need plans are checked after
endpoint adoption, which can reopen previously verified knowledge. Unknown plans,
answers, evidence and their history remain in the authoritative need registry.

`acceptance.review_disposition` records `not_requested`, `pending`, `completed`,
`failed`, `partial`, `stale`, or `preparation_only`. Only a completed current
post-interview review is `completed`. Failed and partial results stay visible.
An active pending review is archived unchanged and cleared at acceptance, fencing
eventual callbacks; accepting never claims the council completed. Runtime owns
stopping any still-running council job. Optional `decision_note` records the
operator's reason. These fields are optional when reading older records.

Handoff adopts nonblank outcome, beneficiary, scope and exclusions and nonempty
success criteria only when provided in the brief. Missing fields preserve the
existing endpoint; no missing facts are invented. `next_step` becomes the proposed
next action. The operation does not create tasks, dispatch work or scaffold files.

Preparation councils retain their explicit `request_source_ref`, `mode`, and
`resume_state`. Completed preparation is archived in review history and restores
the prior preparing, awaiting-choice, deferred, or interviewing state. Its
material changes increment the brief revision. It never provides the completed
post-interview review. Partial preparation cannot install
a changed brief; its result stays visible for explicit retry. Changes during a
pending deferred preparation preserve the deferred choice and fence stale callbacks.

## Admission boundaries

While `phase = intake`, tasks may be created, admitted and promoted through the
ordinary authority and work-admission rules, including definition and research
tasks. Intake does not add a special task permission or label. Knowledge corrections
save history but do not automatically generate reconciliation tasks. Generic
project writes cannot bypass intake revision, phase, workspace or endpoint history;
use `accept` for endpoint handoff and `attach_workspace` for a deliberate rebind.

Workspace routes reject absent or unavailable paths with 409
`WORKSPACE_UNAVAILABLE`; paths never fall back to the server working directory.
Explicit workspace writes, including Git initialization, are available during
Intake for the recorded available folder. Legacy project creation and scaffold routes preflight existing intake bindings
before any filesystem mutation. Generic database project creation and path edits
also respect canonical intake reservations; scanner lookup reuses those bindings
when the supplied path spelling differs. Association
checks canonical identity, supports non-Git folders, and preserves an unavailable
supplied path without creating a replacement. The recorded canonical identity
remains authoritative if a symlink is retargeted or becomes unavailable, until an
explicit `attach_workspace` operation adopts a new binding. That operation records
`workspace_history` entries containing `previous`, `next`, `operation_id`, `at`,
and optional `source_ref`; it never moves or creates files or initializes Git.
A missing new path is retained as unavailable. Cross-project path collisions and
revision checks still apply. Generic path changes must use this explicit operation
so history and identity stay coherent. Workspace routes check the recorded identity
before accessing files. Pulse and activity readers use
the same eligibility check and canonical path for Git reads; unavailable or
retargeted bindings produce no repository events while board activity remains
visible. Pulse caches recheck eligibility on each read. Intake-bound projects are
excluded from legacy fuzzy ID recovery, so mistyped IDs cannot rewrite folder metadata.

## Verification

`server/__tests__/project-intake.test.js` exercises the HTTP routes and temporary
SQLite databases, including replay, collisions, concurrent answers, storage
rollback, exact folder association, deferred/reopened state, stale review,
atomic flexible handoff, large registries, explicit workspace rebinding and Intake
task admission. Existing project
knowledge and admission suites exercise compatibility outside intake.
`server/__tests__/project-workspace-readers.test.js` uses temporary repositories
and real HTTP readers to verify canonical identity, pulse-cache invalidation,
unavailable folders, and preservation of task activity.
