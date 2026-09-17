# Project checkpoints: ordered endpoints with verified advancement

**Status:** design + implementation record, 2026-09-15 (Nexus task `143abc00`).
**Roots touched:** `/Volumes/Projects/TheNexus` (persistence, API, MCP, dashboard),
`/Volumes/Projects/nexus-shared` (contract), `/Volumes/Projects/Praxis`
(steward, planning, briefing, agent tool), `/Volumes/Projects/shared-mind`
(endpoint workflow and skill docs), plus
`/Users/robertwashko/Projects/Nexus-Mobile-Android` (generated contract mirror;
see `docs/checkpoint-qa/walkthrough.md` for binding and attribution).

## Why

A project's `end_state` is its long-term goal. Robert asked for ordered
checkpoints under that goal: the current checkpoint is the effective endpoint
until it is verified, then the next one becomes current automatically. The
long-term goal stays visible and unchanged; nothing appends a new horizon.

## Ownership (no parallel state store)

| Concern | Owner |
|---|---|
| Shared schema and selection helpers | `@praxis/contract` `src/entities/project.ts` schemas and `src/entities/checkpoints.ts` helpers |
| Persistence, guards, the one advancement transition | TheNexus `db/project-checkpoints.js`, `db/project-data.js`, `db/index.js` |
| HTTP surface | `PATCH /api/projects/:id` (`checkpoints`), `POST /api/projects/:id/checkpoints/transition`, `POST /api/projects/:id/checkpoints/:checkpointId/reopen` |
| MCP / agent tools | praxis-mind `nexus_project_update` (`checkpoints`, `expected_checkpoints_revision`); Praxis `nexus_projects` action=update |
| Evaluation and orchestration | Praxis `src/knowledge/project-steward.ts` (evaluates the current checkpoint, submits evidence to the transition) |
| Planning targeting | Praxis morning pipeline goal regression, context pack, heartbeat text, council roster, reflection |
| Cockpit | dashboard `components/project-endpoint/checkpoints-panel.tsx`, mission brief |

## Data model

`projects.checkpoints` is a nullable JSON column (`null` = no checkpoint plan,
which is every existing project). Shape (`CheckpointPlanSchema`):

```
{
  items: Checkpoint[],          // ordered plan; status pending | completed
  archived: Checkpoint[],       // removed checkpoints, evidence retained
  revision: ISO timestamp,      // bumps on every plan mutation (edit, reorder, remove, advance, reopen)
  sequence_completed_at: ISO | null
}
Checkpoint = {
  id, title, goal, criteria: EndStateCriterion[], need_ids: string[],   // the definition (author-owned)
  created_at, definition_revision,                                       // server-owned
  status, completion: { at, definition_revision, source, assessment } | null,
  assessment: CheckpointAssessment | null,                               // latest evaluation of the current definition
  history: [{ kind: completed | reopened | definition_changed | archived | restored, at, definition_revision, ... }]
}
```

Rules:

- **Current checkpoint** = the first `pending` item in order (`currentCheckpoint(plan)` in the contract). Exactly one while unfinished items remain; none once every item is completed. There is no stored pointer to drift.
- **Long-term goal** stays in `end_state`, `endpoint`, `end_state_criteria`. Those criteria are final-goal criteria and project-wide invariants; they are evaluated for visibility every steward run and gate **final completion**, not intermediate advancement.
- **Requirement scoping**: a checkpoint's requirements are its own criteria plus blocking information needs linked to it (`need_ids`, or a need whose `criterion_ids` name one of the checkpoint's criteria). Blocking needs linked to no checkpoint are project-wide and gate final completion only.
- **Evidence binds to a definition**: `definition_revision` changes when goal, criteria definitions or `need_ids` change (the title is a label: renaming keeps the revision and its evidence). Creating a new checkpoint never reopens knowledge it links; only redefining an existing checkpoint does. A completion whose `definition_revision` no longer matches is not a completion: the server moves it into `history` and the checkpoint returns to `pending`. Changed criteria cannot reuse old success.
- **Edits are replacement arrays** like `end_state_criteria`: clients PATCH `checkpoints` as the ordered array of definitions (or `{items: [...]}`); the server merges by id, preserves server-owned fields for unchanged definitions, assigns ids to new items, archives removed items (with their history) instead of deleting, restores an archived id that reappears, and bumps `revision`. The required guard `expected_checkpoints_revision` returns 428 when omitted and 409 on a stale plan (null for a new plan). Long-term endpoint/criteria edits on projects with checkpoints also require `expected_updated_at`.
- **Legacy writes** never touch the column: a PATCH without `checkpoints` leaves the plan intact, and clients that do not know the field keep working. Old readers ignore the extra field.
- **Assessment invalidation is scoped**: a checkpoint definition change clears only that checkpoint's assessment and completion; an observation change clears that checkpoint assessment; need edits clear only pending assessments linked to changed needs, while fencing in-flight evaluations with a new plan revision. Plan changes and transitions clear the final assessment. Unrelated long-term edits leave checkpoint assessments intact. Needs linked to a changed checkpoint are reopened as `stale`, exactly as needs linked to changed final-goal criteria already are.

## The advancement transition

`POST /api/projects/:id/checkpoints/transition` is the single authoritative,
revision-guarded write. Body:

```
{ checkpoint_id, definition_revision, expected_checkpoints_revision,
  assessment: { evaluated_at, results: [...], knowledge: {...} }, source? }
```

Inside one `BEGIN IMMEDIATE` transaction the server:

1. Rejects (409 `CHECKPOINT_REVISION_STALE`) when `expected_checkpoints_revision` is not the stored plan revision.
2. Rejects (409 `CHECKPOINT_NOT_CURRENT`) unless `checkpoint_id` is the current checkpoint. A replay against an already completed checkpoint carrying the same `evaluated_at` returns 200 `{outcome: "duplicate"}` and writes nothing.
3. Rejects (409 `CHECKPOINT_DEFINITION_STALE`) unless `definition_revision` matches the stored definition revision, and (409 `ASSESSMENT_NOT_FRESH`) unless `evaluated_at` is after the definition revision and not in the future. An `evaluated_at` no newer than the stored assessment is a duplicate, not an advance.
4. Recomputes the verdict itself: every enabled criterion must appear with `status: "pass"`, there must be at least one result (an empty or all-disabled criteria set cannot complete anything), and every applicable blocking need must be satisfied against the project's own needs registry. `fail`, `unknown`, `unverifiable`, manual criteria without a passing dated observation, and skipped tasks (which Praxis reports as `fail`) all leave the checkpoint current.
   Passing results must have a checked timestamp after the plan/definition revision and no more than 15 minutes old (60 seconds of clock skew tolerated). Manual/metric results must agree with the persisted observation; changed/reopened definitions reject earlier observation dates even if reattached later. Metric targets, freshness windows and sample minimums are checked against the stored observation.
5. On a verdict of verified: stores `completion` (with the assessment snapshot), appends a `completed` history event, sets `status: "completed"`, bumps `revision`, and, when no pending item remains, sets `sequence_completed_at`. The next pending item is current by definition. Otherwise it stores the assessment as "waiting for evidence" without bumping the plan revision.

Because the advance bumps `revision`, a concurrent duplicate evaluation with the
old revision fails the guard, and a retry that re-reads sees the checkpoint as
no longer current. Restarts cannot double-advance.

**No automatic regression.** Completed checkpoints stay completed; the steward
re-checks completed checkpoints' offline criteria (task sets, manual and metric
observations) and reports `checkpoint_regression` flags for visibility, but
never reopens them. An operator can reopen a checkpoint explicitly via
`POST .../checkpoints/:checkpointId/reopen` (recorded as a `reopened` event and
clearing `sequence_completed_at`, the final assessment and prior observations; a new definition revision fences old acceptance), or by editing its definition. Completion/history entries retain an exact definition snapshot with their evidence.

**Final checkpoint.** When the last checkpoint is verified the plan records
`sequence_completed_at`. The steward then evaluates the final goal exactly as
before (final-goal criteria, project-wide blocking needs) and only then flags
`end_state_possibly_achieved` under the existing completion policy. While a
sequence is incomplete the project-wide assessment carries
`checkpoints.sequence_complete: false` and `achieved: false`. Nothing adopts a
new horizon, parks, or archives; the transition is not a dispatch permission.

## Praxis behaviour

- **Steward** (`runProjectSteward`): for each active project with a plan it evaluates the current checkpoint's criteria with the existing evaluator (skip detection, allowlist, unavailable/unknown distinctions intact), computes applicable knowledge, and submits the assessment to the transition endpoint. Outcomes become flags: `checkpoint_advanced`, `checkpoint_waiting` (reason as today), `checkpoint_sequence_complete`, `checkpoint_regression`. Then it runs the existing final-goal evaluation, gated by sequence completion. Dry runs evaluate but never write.
- **Goal regression**: gap projects carry the current checkpoint; the prompt names the long-term goal as context, the current checkpoint as the endpoint to plan toward, and upcoming checkpoints as out of scope for now. Created tasks carry `metadata.checkpoint_id`; criterion links target current-checkpoint criteria while one is active; future-only needs are deferred in planning, research-term reconciliation and council inputs. Proposing another horizon is suppressed while a checkpoint is active.
- **Context pack** adds a "Current checkpoint" item so executors know the effective endpoint. **Heartbeat** agenda text, the **knowledge-council roster**, **project reflection** and the **morning snapshot** carry the current checkpoint beside the long-term goal.
- **Task evidence**: projects with checkpoints require the latest finalized independent `verified` task verdict on the run-events spine. A later dispatch invalidates prior QA. Events are ordered by event time, then sequence, so importing old QA cannot revive it. `uncertain`, `partial`, `unverified`, unavailable and skipped task evidence never advance. Existing projects without checkpoints retain their evaluator semantics.
- **Agent tool** `nexus_projects` action=update accepts `checkpoints` and `expected_checkpoints_revision`, and forwards `expected_updated_at` for endpoint editing.

## Migration and activation

- Schema: `ALTER TABLE projects ADD COLUMN checkpoints TEXT` runs automatically on Nexus API start (same migration block as `endpoint`). No backfill; existing projects have no plan.
- Contract: rebuild with `cd /Volumes/Projects/nexus-shared && npm run build`, then refresh the dashboard installed copy using the repository procedure. Fable performed an install refresh; the continuation copied canonical src/dist into the existing installed package and verified freshness. `npm run sync:mobile-contract -- --check` in Praxis verifies the generated mobile mirror.
- Runtime activation (not performed): the next authorized reload of the supervised Nexus API loads the route/migration; the next authorized Praxis runtime reload loads the steward, planning and task-QA reader. Reconnect existing stdio MCP clients to load the updated tool schema. Do not start duplicate servers or restart the production supervisor as a verification step. The dashboard is configured for dev hot reload; the tested production build was isolated at :3311 with `.next-checkpoints`, proxying only to the temporary API at :4311. Source verification, independent lifecycle QA, and production activation are separate states.
- Praxis example: `Praxis/docs/proposals/praxis-checkpoint-sequence-proposal.md` is a labelled proposal grounded in the live Praxis criteria. It is not adopted; adopting it is an operator action through the normal endpoint tools.
