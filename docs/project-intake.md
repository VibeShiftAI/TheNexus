# Durable project intake

Nexus stores project intake with the project record. `phase` is separate from
lifecycle `status`; old projects keep `phase = NULL` and `intake = NULL`.
Unassigned workspaces use `path = ''` plus `intake.workspace.state = unassigned`.
No intake operation creates directories, initializes Git, or dispatches work.
One operation creates tasks: `record_backlog`, the step after `accept`
([The initial backlog receipt](#the-initial-backlog-receipt)).

The shared wire contract is exported by `@praxis/contract` as
`CreateProjectIntakeSchema`, `ProjectIntakeOperationSchema`, and
`ProjectIntakeSchema`, with `IntakeAcceptanceSchema`, `IntakeBacklogReceiptSchema`,
`IntakeBacklogProposalSchema` and `IntakeHandoffSummarySchema` for the acceptance,
the backlog receipt, one planned slot and the two handed-off response fields.
Request schemas reject unknown fields.

## API

- `POST /api/projects/intake`: `operation_id`, `name`, `problem`, `source_ref`,
  optional `project_id`, `existing_path`, and `sources`. Returns 201 and
  `{ project, intake }`. `project_id` is an explicit exact existing binding;
  names and paths already owned by another project conflict rather than merge.
- `GET /api/projects/:id/intake`: exact project ID, returns `{ project, intake }`.
- `POST /api/projects/:id/intake/operations`: `operation_id`,
  `expected_revision`, `action`, and the action-specific fields below. Returns
  `{ project, intake }` after durable commit.

While the intake is `handed_off`, the `GET` and every operation response (the
`accept` that hands off included) also carry `open_task_count` and `backlog`
beside `project` and `intake`: the number of tasks on the project that are still
open work (not archived, cancelled, failed or completed) and the current backlog
receipt, `null` until one is recorded.

All operations require a stable client-generated operation ID. The same payload
replays the original saved response even after later changes. Reusing the ID for
a different payload returns 409 `INTAKE_OPERATION_COLLISION`. A stale revision
returns 409 `INTAKE_REVISION_STALE`. The caller must reload and reconcile rather
than silently retry a changed answer against a newer revision.

| Action | Fields and effect |
| --- | --- |
| `prepare` | Optional `brief`, `sources`, `needs`, `pending_need_id`; preparing → awaiting_choice only with a nonblank outcome or purpose and at least one authoritative information need (answered needs count). |
| `start` | Optional `pending_need_id`; any pre-handoff state → interviewing, retaining a pending council unchanged. |
| `defer` | Optional `pending_need_id`; any pre-handoff state → deferred, retaining a pending council unchanged. Saves the interview for later without initiating work. Explicitly requested tasks and research remain available. |
| `answer` | `need_id`, `answer`, `source_ref`, `expected_knowledge_revision`; optional `evidence`, `verification`, `pending_need_id`. Available in every state, including handed_off; a supplied answer does not resume a deferred interview. |
| `revise` | Optional `brief`, `sources`, `needs`, `pending_need_id`; available before and after handoff. Material changes invalidate review while retaining historical acceptance. |
| `request_review` | New `session_id`, current `brief_revision`, optional `mode` (review by default). A real request `source_ref` permits either council mode from any pre-handoff state, including replacing an earlier council. Preparation always requires `source_ref`; records frozen council identity and moves to council_review. |
| `record_review` | Matching current pending `session_id`, `brief_revision`, `source_ref`, `findings`; optional `status` (completed/failed/partial) and follow-up `needs`. Available regardless of interview state before handoff. Preparation alone may supply `brief` and `sources`. |
| `accept` | Current `brief_revision`, real `source_ref`, `next_step`; optional `decision_note`. Records the operator decision from any non-handed-off state, adopts known endpoint fields through project-data guards, then moves phase to planning. |
| `record_backlog` | `status` (generated, existing or deferred) with `proposals`, `task_ids`, `remaining`, `covers`, `reason`, `source_ref`, `supersedes`, `brief_revision`, `source` as the status allows. Only while handed_off. Files the proposals as tasks and records the initial backlog receipt in one transaction; see [The initial backlog receipt](#the-initial-backlog-receipt). |
| `attach_workspace` | `existing_path`; optional audit `source_ref`. Explicitly attaches or replaces the existing or unavailable folder association on the same project ID, before or after handoff. |

`revision` increments for every successful operation. `brief_revision` increments
for material brief, source, question, and answer changes. A review and acceptance
refer to `brief_revision`, so state transitions do not make their own evidence
stale. `brief_history` preserves prior brief/source snapshots and the need
revisions required to reconstruct their evidence. Review history and immutable
operation responses remain durable.

Council progress and interview choice are independent. `start` and `defer` never
erase or complete a pending council. A valid result saves its actual status and
findings without overriding a later conversation choice. Requesting either kind
of council while deferred does not resume the interview: completion and material
changes retain that deferred choice unless the operator subsequently starts it.
An explicit replacement archives the previous council unchanged, including its
pending/failed/partial status. New requests must use new session IDs; retry the
original operation ID to replay the same request. Superseded, completed, stale,
and post-handoff callbacks cannot overwrite the record. Source-less automatic
requests retain the ordinary conversation sequence and cannot replace a pending
explicit council.

## Need and evidence ownership

`project.needs` remains authoritative. Intake stores stable `need_ids` and one
`pending_need_id`, not another question registry. Explicit existing-project binding adopts its structured information need IDs
without rewriting answers, verification, or history. Definition writes merge by ID,
require `expected_knowledge_revision` for existing needs, and preserve omitted fields and unrelated needs. They cannot truncate a large
legacy registry or overwrite a need outside this intake.
New structured information needs created through canonical project editors join
the intake registry and can be answered through `answer`, before or after handoff.
This does not silently adopt untouched legacy needs outside the registry.

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
Its response reports `open_task_count` and `backlog: null`, so the caller sees that
the initial backlog is the step still owed.

After handoff, `answer`, `revise`, `attach_workspace` and `record_backlog` remain available. Material
knowledge or brief changes increment the intake and brief revisions and preserve
the accepted version in `brief_history`. `phase = planning`, `state = handed_off`,
and the original acceptance source, version, next step, readiness gaps and review
disposition remain unchanged. The dashboard labels a newer current brief as newer
than the historical acceptance; editing it does not silently re-adopt the project
goal. Start/defer and other intake sequencing operations return planning guidance
instead of reopening Intake.

Preparation councils retain their explicit `request_source_ref`, `mode`, and
`resume_state`. Completed preparation is archived in review history and restores
the prior preparing, awaiting-choice, deferred, or interviewing state. Its
material changes increment the brief revision. It never provides the completed
post-interview review. Partial preparation cannot install
a changed brief; its result stays visible for explicit retry. Changes during a
pending deferred preparation preserve the deferred choice and fence stale callbacks.

## The initial backlog receipt

Accepting a project is the first of two recorded steps. The second is the backlog
receipt at `intake.acceptance.backlog`: which tasks are the project's initial
backlog, or why there are none yet. Only `record_backlog` writes it, and only
while the intake is `handed_off`. `accept` is unchanged and still creates no task.

The receipt is a record of what was filed. It has no schedule, dispatch or
publication field, and nothing outside intake reads it: writing one gives no task
a schedule slot, starts no run and publishes nothing. It changes the tasks it
creates, `acceptance.backlog` and `acceptance.backlog_history`, and nothing else:
the acceptance decision, the brief, the review, the phase and the workspace stay
as they were. No council and no second approval is asked for.

### What the caller sends

| Field | Meaning |
| --- | --- |
| `status` | `generated` (file or name the backlog), `existing` (open tasks already on the board cover the accepted next step) or `deferred` (no backlog yet, with the reason). `partial` is never sent; Nexus derives it. |
| `proposals` | `generated` only. The bodies Nexus files as tasks inside this operation. Each has a `slot` (a positive whole number, used once in the call), `name`, `description`, `antigravity_payload` (an object), and optional `dependencies` and `metadata`. There is no fixed number of slots. |
| `task_ids` | Tasks already on the board that belong to the backlog. For `existing`, at least one is required. For `generated`, they are tasks that were filed outside this operation. |
| `remaining` | `generated` only. Planned slots that are not filed yet, in the same shape as a proposal. Any entry makes the stored status `partial`, and the bodies are kept so a later writer files exactly those slots. |
| `covers` | `generated` only, and only when superseding: `[{ slot, task_id }]` says a slot the superseded receipt held in `remaining` was filed outside the operation as that task. |
| `reason`, `source_ref` | Both required for `deferred`. `source_ref` is the reference of Robert's message that asked for the deferral, or `hold:<name>` for a declared hold, and then the reason has to name that hold. |
| `supersedes` | The `operation_id` of the receipt this call replaces. |
| `brief_revision` | Optional: the brief the plan was made against. Refused unless it is the current brief revision. |
| `source` | Optional provenance claim for the created tasks. It is capped like every task source claim, so it can never record operator authorship. Without it the tasks are recorded as `nexus-api`. |

A dependency is either a slot number or a task id. A slot number has to be filed
in the same call, filed earlier under the receipt being superseded, or named in
`covers` (for a `remaining` body it may be any slot of the plan). A task id has to
be one the receipt names. A slot may not depend on itself, directly or through a
chain. Nexus stores the real task ids on the created tasks.

Status is not an input. Every task the receipt creates is filed in `idea` status,
the same status the stage planner files proposals in, so nothing is schedulable
until it is approved in the ordinary way. Nexus sets
`metadata.work_identity.proposal_id` on each one to
`intake-backlog:<project_id>:<acceptance.at>:<slot>`; a value the caller supplies
there is replaced. Other proposal `metadata` is kept after the same knowledge
metadata check the task routes apply.

### What Nexus does, in one transaction

1. The existing intake guards run first: an identical `operation_id` and payload
   replays the stored response, and a stale `expected_revision` is refused before
   anything is read or created.
2. One receipt per acceptance. If one exists and the call does not name it in
   `supersedes`, the call is refused and the current receipt is returned in the
   error body, so the caller reports the existing ids instead of filing again.
3. The fields are checked against the status, then every proposal and remaining
   body is checked and refused by slot.
4. Every named task has to be a task on this project that is not archived,
   cancelled or failed; `existing` also refuses a completed task, which is not
   open work. Ids the superseded receipt already holds are not checked again.
5. A superseding receipt may not lose work. Its `task_ids` must include every id
   of the receipt it replaces, and every slot that receipt held in `remaining`
   must be accounted for in exactly one way: carried in `remaining` with the same
   body, filed as a proposal with the same slot, or named in `covers` with a task
   filed after acceptance whose `proposal_id` is the one Nexus derives for that
   slot. A `deferred` receipt may replace one that names work; it carries that
   work and adds none.
6. A call with `proposals` is refused when tasks were filed on the project at or
   after `acceptance.at` that neither the call nor the superseded receipt names
   (archived, cancelled and failed tasks do not count). The caller records those
   ids with `generated` and `task_ids` instead of filing a second backlog beside
   them. Tasks older than the acceptance never block.
7. The proposals are created through the board's batch create, and the result is
   checked: one new task per proposal, in slot order. Anything else fails the
   operation.
8. The receipt is written and the intake revision increments.

A failure at any step rolls the whole operation back: no task, no receipt, and the
intake revision unchanged, so a corrected call under a new `operation_id` starts
from the same state.

### What is stored

`acceptance.backlog` holds `status` (`generated`, `existing`, `partial` or
`deferred`), `task_ids` (named and created, in that order), `proposals` (every
filed slot's body with the `task_id` it became, earlier filings carried forward),
`remaining`, `reason` and `source_ref` when given, `brief_revision` (the current
brief when the receipt was written), `operation_id`, `at`, `supersedes` when it
replaced a receipt, and `replayed`. `replayed` is `false` in storage and `true`
only in the response to an identical retry of the operation that wrote the
receipt. Each replaced receipt is appended to `acceptance.backlog_history`.

The receipt is historical like the acceptance. A later `revise` moves the brief
revision and leaves the receipt, its `brief_revision` and its tasks as they were;
a read shows the current brief and the receipt side by side. A deferral waits for
an explicit lift: a later `record_backlog` that names it in `supersedes`. Nothing
expires it.

### Refusals

| Code | Status | When | Also in the body |
| --- | --- | --- | --- |
| `INTAKE_STATE_CONFLICT` | 409 | The intake is not handed off. | |
| `INTAKE_REVISION_STALE` | 409 | `expected_revision` is not the current revision. | |
| `INTAKE_OPERATION_COLLISION` | 409 | The `operation_id` was used with a different payload, for example a recomposed plan. | |
| `INTAKE_BACKLOG_EXISTS` | 409 | A receipt exists and `supersedes` does not name it. | `backlog` |
| `INTAKE_BACKLOG_SUPERSEDES_UNKNOWN` | 409 | `supersedes` is given and no receipt exists. | `backlog: null` |
| `INTAKE_BACKLOG_BRIEF_STALE` | 409 | `brief_revision` is not the current brief revision. | `brief_revision`, `accepted_brief_revision` |
| `INVALID_INTAKE` | 400 | The fields do not fit the status, or the envelope fails the schema. | |
| `INTAKE_BACKLOG_REASON_REQUIRED` | 400 | A deferral without a reason and a message reference or named hold. | |
| `INTAKE_BACKLOG_PROPOSAL_INVALID` | 400 | A proposal, remaining or covers entry is not valid; the message names the slot. | `list`, `slot` |
| `INTAKE_BACKLOG_TASK_UNKNOWN` | 400 | A named task is not a live task on this project. | `task_ids`, `problems` |
| `INTAKE_BACKLOG_PARTIAL_DROPPED` | 409 | A superseding receipt would lose a recorded id or an unfiled slot. | `dropped_task_ids`, `dropped_slots`, `backlog` |
| `INTAKE_BACKLOG_UNRECORDED_TASKS` | 409 | Proposals were sent while unrecorded tasks filed since acceptance exist. | `task_ids` |
| `INTAKE_BACKLOG_CREATE_FAILED` | 422 | The board did not create one new task per proposal. | `slot` or `admission` when known |

## Admission boundaries

While `phase = intake`, tasks may be created, admitted and promoted through the
ordinary authority and work-admission rules, including definition and research
tasks. Intake does not add a special task permission or label. Knowledge corrections
save history but do not automatically generate reconciliation tasks. Corrections
to previously applied knowledge refresh already authorized, never-run linked tasks
through ordinary task CAS, preserving completed work and avoiding new follow-ups.
This includes source-only invalidation: a new stale knowledge revision replaces
old verification claims in pending task context even when the answer and evidence
references remain unchanged. Repeated source revisions refresh that context again;
identical source content and retrieval-time-only updates do not. Canonical freshness
invalidation during Intake follows the same refresh rule without expanding automatic
task creation outside Intake.
This refresh shares the knowledge transaction and intake operation receipt rollback.

An explicit operational scope instruction from Robert can be relayed at any phase
through [project scope decisions](contracts/project-scope-decisions.md), using the
existing runtime credential and actual instruction reference. It needs no proposal,
new task or repeated approval. Draft-only corrections still use intake `revise`.

Ordinary goal edits are available during Intake: explicitly supplied changed
`end_state` maps to brief `outcome`, endpoint `beneficiary`, `scope`, and `exclusions`
map to the same brief fields, and criterion descriptions map to `success_criteria`.
Omitted and unchanged canonical values do not overwrite the brief. Explicit empty
values clear the corresponding fields. Material changes snapshot the prior brief,
increment both revisions and invalidate its review without accepting it or changing
phase. Normal endpoint validation, stale-write guards and endpoint history still
apply. After handoff, ordinary goal edits remain canonical project edits and do not
rewrite the historical intake adoption. Canonical knowledge edits continue versioning
intake history after handoff while preserving acceptance. Use `accept` for endpoint
handoff and `attach_workspace` for a deliberate rebind. Checkpoint, goal and knowledge
editors remain available on the project page during Intake.

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
task admission. Its `record_backlog` block covers the receipt: creation and receipt
in one transaction, replay, two competing writers, each refusal above with a raw
read showing that nothing was written, a forced create failure, partial receipts
and their superseding rules, deferral, and a brief that moves after the receipt.
Existing project
knowledge and admission suites exercise compatibility outside intake.
`server/__tests__/project-workspace-readers.test.js` uses temporary repositories
and real HTTP readers to verify canonical identity, pulse-cache invalidation,
unavailable folders, and preservation of task activity.

The project page's intake panel (`dashboard/src/components/project-intake/panel.tsx`)
shows the receipt beside the intake state once an intake is accepted:
`backlog: not recorded` in the warning colour when the acceptance has no receipt,
the task count for a generated or existing receipt, filed of planned for a partial
one with every unfiled slot listed, and the reason and reference of a deferral.
`dashboard/src/components/__tests__/project-intake-panel.test.mjs` covers each
state. `dashboard/scripts/intake-backlog-panel-browser-check.mjs` opens the page
for each state in a real browser, at desktop and phone width, against this API on a
temporary database (the two commands are in its header); the run recorded on
2026-11-14 is in `docs/reviews/2026-11-14-intake-backlog-receipt/`.
