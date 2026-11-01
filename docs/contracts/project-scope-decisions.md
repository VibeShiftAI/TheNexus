# Direct project scope instructions

Robert’s explicit instruction to change a project’s scope is sufficient approval.
Praxis faithfully relays that instruction through this endpoint. It does not create
a task, stakeholder proposal or second approval request. Autonomous suggestions
still use the reserved proposal workflow. Invitation authority is unchanged.

## API

`POST /api/projects/:id/scope-decisions` requires an exact project ID and:

```json
{
  "operation_id": "project-scope:stable-intent-id",
  "expected_updated_at": "2026-11-01T12:00:00.000Z",
  "decision_ref": {
    "kind": "chat_instruction",
    "id": "actual-message-id",
    "source_ref": "actual-message-reference",
    "instruction": "Expand the pilot to two neighborhoods and update its goal."
  },
  "updates": {
    "description": "A two-neighborhood pilot",
    "end_state": "Both neighborhoods can complete a loan",
    "endpoint": { "scope": "Two neighborhoods" }
  }
}
```

The existing `NEXUS_STAKEHOLDER_RUNTIME_KEY` authenticates a faithful relay.
The existing operator credential or verified Access session may also apply the
instruction. Runtime requests are recorded as `operator_relayed` with
`runtime_credential`, never as an operator credential. Executor/bridge headers,
service credentials and unverified payload claims confer no authority. No new key
is introduced. Authentication reuses `contract-change-authority`.

References support `chat_instruction`, `questionnaire` and `inbox_answer`. Every
reference requires a named `id` and nonblank actual `instruction`. Optional
`source_ref` and `instructed_at` carry only known facts. A generated identity is
labelled `attestation: "runtime_attestation"` and must not invent a Nexus message
or instruction time. Chat references are runtime attestations, not database-verified
operator messages; the receipt records that distinction explicitly.

Supported scope fields are `description`, `end_state`, `endpoint`,
`end_state_criteria` and `checkpoints`. Endpoint updates merge with current fields;
empty strings explicitly clear strings. Normal canonical validation, criterion
IDs, checkpoint revision guards, endpoint history, knowledge invalidation and
knowledge work routing all apply. Requested metadata can accompany the instruction:
`name`, `type`, `vibe`, `stack`, `urls`, `path`, `status`, `priority`, `tags`,
`upgrade_posture`, `comms_settings`, `report_template`, `end_state_source` and
`end_state_reason`. `expected_status`, `expected_end_state_updated_at` and
`expected_checkpoints_revision` remain available guards in `updates`.
Unknown fields, unrelated `needs`/assessment writes and caller-owned intake/phase
state are rejected, not filtered. The relay must send only the fields requested by
the instruction; Nexus validates the declared mutation rather than classifying
natural-language permission.

The result is `{project, receipt, replayed}`. The immutable receipt records the
exact project, operation, decision reference and instruction, authenticated origin,
supplied fields, requested values, before/after values, project versions and time.
One SQLite transaction under the board lease owns the normal canonical write,
knowledge-task updates, stale proposal invalidation and receipt. Any failure rolls
back all of them. Endpoint scope/beneficiary/exclusions changes invalidate stale
proposal authority; changing a `proposed_next` suggestion alone does not.

Duplicate operation IDs with the same project, reference and intent return the
original result with `replayed: true`, even after a newer scope edit. Guards are
not intent. Different intent using the same ID fails with
`409 SCOPE_OPERATION_CONFLICT`. A new operation with stale `expected_updated_at`
fails with `409 SCOPE_REVISION_STALE` and writes nothing. The caller can reconcile
against a fresh project read and retry the same instruction with a fresh guard;
no repeated human approval is required.

`GET /api/projects/:id/scope-decisions` returns `{decisions: [receipt, ...]}`.
The optional `?operation_id=...` selects one operation. Audit history survives project deletion without blocking it; writes still require a live exact project. Runtime/operator
authentication is required. Praxis exposes it as `nexus_projects action=scope_decisions` with exact `project_id` and optional `operation_id`. This is the canonical recovery surface after an
uncertain acknowledgement. Praxis retains its exact request before sending and
returns `retry_request` and `retry_file` on write failures. Retry that exact body
or reconcile the stored receipt before any new write. Credential failures are
technical, not evidence that Robert failed to approve his own instruction.

Canonical edits work during Intake, adopted existing projects and Planning. Before
handoff they use the existing intake fence and mirror changed endpoint fields to
the brief. A changed description also invalidates old council review without
inventing a description-to-brief mapping; after handoff the recorded acceptance remains historical. Draft-only
corrections use intake `revise`. An `operator_decision` with a legacy `scope_change`
reference takes only this direct path; it never also applies the old proposal.
