# Work admission

All facade task creates, including batch and both HTTP creation routes, use the
SQLite admission boundary. `work_admissions` stores the authoritative receipt
and a unique exact identity in the same transaction as the task insert. Retries
return the canonical task row, even after completion. Batch sibling dependencies
follow canonical reused task IDs. Existing response envelopes are preserved;
`metadata.work_admission` is additive.

Identity compares project, canonical workspace, description/scope, acceptance
criteria, machine payload and declared recurrence. A title alone never merges
tasks. Producers can provide `metadata.work_identity` with `proposal_id`,
`workspace`, `scope`, `acceptance`, and `recurrence: {run_id,
observation_window}`. A stable proposal ID tolerates a renamed title but remains
bound to the same scope. Different recurring runs with different observation
windows are distinct. Without an explicit identity, an exact substantive
contract is still retry-safe.

Lexical lookup searches the full retained project/workspace history and returns
at most three likely matches. Similarity only puts the new proposal into
`needs_evidence`; it never merges or completes work. Lookup failure also holds.
The receipt names its owner, reason, checked time, fingerprint, matched task
versions and searched coverage. Raw task metadata is only a projection; facade
reads overlay the durable receipt. Ordinary metadata writes cannot grant or
clear admission. Material scope edits invalidate a decision.

## HTTP contract

- `GET /api/tasks/:id/work-admission`: refresh current scope/board comparison and
  return the full task row. Unchanged receipts are reused. Read refreshes do not
  create task-version churn. Consumers must check the receipt immediately before
  execution; the ordinary task status is not an admission override.
- `POST /api/tasks/:id/work-admission/concerns`: authenticated runtime request
  with `{expected_task_version, concerns:[{reason, existing_task_id?, seat_id?}]}`.
  One to three concerns per request. Persists an evidence hold. Repeated concerns
  coalesce; an unchanged previously resolved concern stays resolved.
- `POST /api/tasks/:id/work-admission/resolve`: authenticated runtime request
  with `{expected_task_version, fingerprint, checked_at, decision, reason,
  matched_tasks:[{task_id,task_version}], evidence:[{ref,hash}], remaining_scope?}`.
  Copy fingerprint, checked_at, and compared versions from the receipt. The
  comparison must be at most 15 minutes old, and every current match must be
  represented. Evidence requires reference strings and SHA-256 hashes.
  `partial_overlap` also requires concrete `remaining_scope` clauses. This does
  not edit the implementation brief or mark the task complete.

Mutation responses return full task rows. Conflicts are 409, invalid evidence
or shape is 400, absent/untrusted credentials are 403, unconfigured credentials
are 503. Runtime endpoints reuse the independently configured
`NEXUS_STAKEHOLDER_RUNTIME_KEY` bearer convention. A body field, local-admin
stub, operator label, or bridge token does not authenticate a decision.

An operator may explicitly repeat a create using
`work_repeat: {repeat_id, reason}` and the independent
`NEXUS_OPERATOR_APPROVAL_KEY` bearer. Reusing that repeat ID is itself idempotent.
An operator repeat never overrides a failed lookup.

The five receipt decisions are `new_work`, `covered_by_open`,
`already_delivered`, `partial_overlap`, and `needs_evidence`. Only the
authenticated evidence resolver can claim semantic delivery/coverage. The
runtime owns bounded evidence review and dispatch policy: Nexus validates the
receipt binding and evidence shape, not the truth of the review or arbitrary
external artifact contents. Changed retained task evidence invalidates reuse;
an external artifact change must be reported by the reviewer. No model call,
filesystem-wide scan, execution, or completion is performed by admission.

Scope excludes explicitly marked generated constraint projections and operational
repair/session metadata.

Operator rulings (`antigravity_payload.operator_rulings`, Robert's answers to
executor questions) are delivered context, not proposal scope. Appending one
keeps the receipt, its decision and fingerprint, and records
`operator_answers: [{index, sha256, recorded_at, origin, requester}]` for
provenance (`origin` is the checked origin of the write that appended it:
`operator`, `runtime`, `operator_relayed` or `unverified`; entries recorded
before 2026-10-04 carry neither field); the ruling text itself stays in the
payload for the executor brief and QA contract. Any
other scope, acceptance or workspace change in the same write still holds the
task. Rewriting, reordering or removing an already recorded ruling is not an
answer and holds as a contract edit. An answer never clears an existing hold or
concern. Receipts fingerprinted before 2026-10-01 (rulings then counted as
scope) are rebound once, recorded as `legacy_fingerprint`, only when their
stored fingerprint exactly matches the current task under the old rule. Unmarked authored rules, including reserved `BC-*` IDs,
remain substantive. A changed exact reservation returns conflict rather than
substituting a differently scoped task. Resolved receipts survive unrelated
history changes but invalidate on any newly relevant owner, including results
beyond the three-item shortlist. `coverage.relevant_count` exposes truncation to
the runtime. Admission GET joins a valid `x-nexus-board-lease` so the runtime can
fence final inspection and launch against concurrent API mutations.

Retrieval version 2 uses corpus-frequency weighted cosine and excludes recognized
appended ingestion-report/constraint-ledger sections only from retrieval. Full
contracts and evidence are still hashed and reviewed. A copied 1,412-task corpus
keeps distinct reader, historical-feedback and curation controls eligible, while
retrieving the two prior brief-quality reviews. Explicit concerns always hold
until adjudicated, even when lexical retrieval finds no candidate. Reopening a
terminal task through ordinary status PATCH creates a fresh evidence hold; it
does not silently revive its prior new-work clearance.

## Contract changes: origin and timing

Robert's rule (task 9021f20d, 2026-10-04): when he changes a task's contract,
directly or through a faithful Praxis relay of a decision he already made, the
change is authorized and he is never asked to approve it again. Only a contract
change that an unverified writer (an executor, QA, the dashboard placeholder
bearer, an MCP write) makes while the task is executing is held. Before
execution, while suspended, or after completion such a change is recorded and
the next dispatch admits the task against the edited contract, overlap
comparison included. Until this rule, any fingerprint change held the task
("Proposal contract changed"), which is how incident a18abb1b held Robert's own
"approve with changes" ruling at todo.

Governed fields are the contract fields plus `dependencies`: `name`,
`description`, `dispatch_instructions`, `dependencies`, `project_id`,
`workspace`, `identity.*` from `metadata.work_identity`, and `payload.<key>` for
every scope key (prompt, acceptance_criteria, target/context files, scope,
commands, constraints, declared paths, workspace roots, authored binding
constraints). Operator rulings stay answers, never governed fields. Generated
constraint projections and repair/session state stay excluded. Rewriting or
removing a recorded ruling by anyone but Robert himself (`operator` origin) is a
hold of its own, not contract drift: `concerns[]` gains a `kind: rulings_rewrite`
entry (`key`, `reason`, `recorded` and `rewritten` as per-entry sha256 lists,
`origin`, `requester`, `phase`, `task_version`, `recorded_at`) and
`rulings_changes[]` records the event (`outcome: held`, `concern_key`; capped at
30 with `rulings_changes_dropped`). Rulings are not contract fields, so approving
the drift, returning to the authorized contract and an executor's own revert of
the drift all leave that concern in place: the receipt stays `needs_evidence`
with the rulings reason, on write and on read. It ends only by its own
resolution: `/work-admission/resolve` with evidence adjudicates it (a later
authorized edit carries that resolution, the concern being among the keys it
adjudicated), or Robert himself, under his credential, rewrites the rulings or
puts his recorded words back, exactly or followed by new answers, whether the
executor rewrote them or removed them all (`rulings_changes` entry `outcome:
authorized` with `cleared_concern_keys`, plus `restores_recorded: true` for a
restoration; an open drift hold is a separate matter and stays). An answer he
appends on top of the executor's text decides nothing about that text: the
concern stays, and his answer is an authenticated addition
(`operator_answers[].origin: operator`). A chained rewrite is measured
against his recorded words (the earliest open concern's `recorded`), never
against the executor's own earlier text. Putting his recorded words back without
his credential is recorded (`restores_recorded: true`), adds no second concern
and clears nothing; a resolution already recorded for that concern stays in
force. While drift is also held, `reason` names both holds, on write and on
read. A relayed decision authorizes contract fields, not a change to what he
said, so a relayed rewrite is held like any other, its `decision_ref` is checked
even when the write changes no governed field, and while a rulings-rewrite
concern is on record, adjudicated or not, an `operator_ruling` reference may
cite only the words the concern recorded or an answer appended since under his
credential or the runtime's (`operator_answers[].origin` of `operator`,
`operator_relayed` or `runtime`); the executor's text, and an answer an
unverified source appended, are refused (`409 decision_ref_under_review`).

Origin is a checked credential, never a label in the payload. The route
(`server/services/contract-change-authority.js`) classifies every PATCH:

- `operator`: Robert's verified Cloudflare Access session
  (`cf-access-jwt-assertion`, authority `access_user` or `access_device`) or
  his `NEXUS_OPERATOR_APPROVAL_KEY` bearer (`operator_credential`).
- `operator_relayed`: the `NEXUS_STAKEHOLDER_RUNTIME_KEY` bearer plus a
  `contract_change` block that names the decision it applies and the fields it
  changes.
- `runtime`: the runtime bearer with no relayed decision.
- `unverified`: everything else, with `requester` recording what was seen
  (`unauthenticated`, `unverified_bearer`, `executor_bridge`).

A PATCH without a `contract_change` block never fails on credentials. A PATCH
that claims an origin must prove it or nothing is written: 403
`contract_change_unverified` (missing or wrong credential, bridge or executor
headers, a payload saying operator), 400 `contract_change_invalid` (bad shape,
relay without `decision_ref` or `fields`), 409 `decision_ref_mismatch` (a ruling
hash that is not on the task), 409 `decision_ref_under_review` with
`concern_key` (the cited ruling is text an unverified source wrote or appended
while a rulings-rewrite concern is on record; only the words Robert recorded,
or an answer appended under his credential or the runtime's, ground a
relay), 409 `contract_change_mixed` with
`undeclared_fields` when a relayed write also changes fields the decision did
not declare, 503 `contract_change_unverifiable` when identity cannot be checked.

```
PATCH /api/tasks/:id
Authorization: Bearer <runtime key>
{ "antigravity_payload": {...}, "dependencies": [...],
  "contract_change": {
    "origin": "operator_relayed",
    "fields": ["payload.prompt", "dependencies"],
    "decision_ref": { "kind": "operator_ruling", "index": 2, "sha256": "<sha256 of the trimmed ruling text>" },
    "reason": "Folding Robert's questionnaire answer into the brief." } }
```

`decision_ref` kinds: `operator_ruling` `{index, sha256}` (checked against the
ruling already recorded in `antigravity_payload.operator_rulings` and its
`operator_answers` entry, whose `recorded_at` and `origin` are echoed as
`recorded_at` and `recorded_by`; this proves the relay matches the recorded
ruling, the runtime credential is what vouches that the ruling is Robert's),
`document_decision` `{id}` (checked against `review_document_decisions`, which
only an operator decision can write), and `chat_instruction` / `inbox_answer` /
`questionnaire` `{id, instruction, instructed_at?}`, which Nexus cannot check
and records as `verification: "runtime_attested", verified: false`. A direct
operator write may carry a `decision_ref` and `reason` too; `fields` is optional
for it.

### Receipt fields (schema_version stays 1, all additive)

- `contract`: the authorized baseline. `{version, hash, fingerprint, fields:
  {field: sha256}, authorized_at, authorized_by: {origin, authority, requester,
  basis, decision_ref?, reason?}}`. `fingerprint` is null while the row drifts
  from the baseline. `fields` is stored sorted and `hash` is the sha256 of that
  sorted map, the same reading the governed-fields hash of the task produces,
  so a return compares the two exactly whatever order fields were added in.
  Receipts older than this field are materialized from the
  stored task on their next read (`basis: receipt_without_contract`, version 1).
- `contract_changes[]`: one entry per governed write. `{id, recorded_at,
  task_version, fields: [{field, before_sha256, after_sha256, before?, after?}],
  origin, execution: {phase, status, next_status?, task_version,
  open_dispatches}, outcome: authorized | recorded | held, contract_version,
  resolution?, restores_baseline?}`. Values are stored only on held entries.
  `resolution.decision` is `approve`, `return_to_authorized`, `reverted_by_edit`
  (the fields are back at the authorized reading, whoever wrote them, a write
  found on read included) or `superseded_by_authorized_edit` (Robert edited a
  held field to a new reading, which became the baseline); `restores_baseline`
  marks the entry that brought the fields back. History keeps the last 30
  entries, never dropping an open hold; `contract_changes_dropped` counts the
  rest.
- `rulings_changes[]`: one entry per rewrite or removal of a recorded operator
  ruling that was not a plain append. `{recorded_at, task_version, before:
  [sha256...], after: [sha256...], origin: {kind, authority, requester},
  outcome: held | authorized, concern_key?, restores_recorded?,
  cleared_concern_keys?}`. `held` entries point at the `kind: rulings_rewrite`
  concern they opened or rejoined; the `authorized` entry is Robert's own direct
  rewrite, or his restoration of his recorded words (`restores_recorded:
  true`), that cleared them. Last 30 entries, `rulings_changes_dropped` counts
  the rest; the open concern itself is never dropped.
- `contract_hold` with `hold_kind: "contract_drift"`: `{since, change_ids,
  drifted_fields, authorized_values: {field: value}, prior: {decision, reason,
  resolved_at?, authority?, evidence?}}`. While it is open the decision is
  `needs_evidence` and the reason names the drift.
- Phases: `executing` (status in_progress, dispatched, ready_for_review or
  review, the write moving into one of those, or an open `task_dispatches` row
  for the task or its `qa--<id>` run), `before_execution`, `suspended`
  (suspended, needs_input), `after_execution` (terminal statuses).
- An authorized change carries a manual overlap resolution forward when the
  compared owners are unchanged and no concern has joined the receipt since
  (`resolution_carried_from`): a resolution adjudicated exactly the concerns
  recorded when it was made (`contract_hold.prior.concern_keys`), so an
  explicit concern or a reopen recorded during a hold is decided fresh by
  approve and return alike. A recorded pre-execution change by an unverified
  writer is a fresh proposal and is compared again. Overlap holds, explicit concerns, the reopen hold, dependency
  gates, `expected_version` CAS and the resolve/concerns authorities are
  unchanged. A write that returns every drifted field to the baseline clears the
  hold without a decision (`resolution.decision: reverted_by_edit`), and the
  pre-drift decision applies again when the compared owners still stand.
- An open hold is sticky. While it is open the baseline moves only by Robert's
  decision or his own authorized edit: a later unverified or runtime write joins
  the hold whatever the phase (a task parked at blocked or todo included), and
  the hold survives a rulings rewrite or a cancel-then-reopen in the same write.
  Status changes alone never touch it.

### Deciding a hold

```
POST /api/tasks/:id/work-admission/contract
{ "expected_task_version": 12, "decision": "approve" | "return_to_authorized",
  "change_ids": ["change-..."], "reason": "...", "decision_ref": {...}? }
```

Authority: Robert's Access session or operator credential directly; the runtime
credential only with a `decision_ref` it relays (`origin: operator_relayed`).
Refusals: 403 `contract_decision_unauthorized` with `reason` (for example
`assertion-missing` from the Mac app, which has no session), 409
`no_contract_hold` (already decided; read back, do not repeat), 409
`contract_hold_changed` with the current `change_ids`, 409 on a stale
`expected_task_version`. `approve` makes the current contract the authorized one
(`basis: approved_drift`, version + 1) and recomputes admission, carrying the
pre-drift resolution only when the compared owners are unchanged and no concern
was raised meanwhile, the same rule `return_to_authorized` follows below; a
rulings rewrite recorded during the hold stays in force after either decision.
`return_to_authorized` writes the recorded authorized values back in the same
row update that records the decision (one version bump), leaves the baseline
version untouched, and recomputes admission, carrying the pre-drift resolution
only when the compared owners still stand and no concern was raised meanwhile:
an overlap, an explicit concern or a reopen recorded during the drift stays
visible. While a drift hold is
open, `/work-admission/resolve` answers 409 `contract_hold_open`: overlap
evidence cannot stand in for Robert's decision on the drift, and a new concern
joins the hold rather than replacing it. Drift that reached the row without
passing the guard (`requester: unattributed_write`, found on read) has no
recorded authorized values, so it can be approved but not returned; the return
answers 409 `contract_restore_failed`. A field the drift added has no authorized
value either, and returning removes it. A row put back to the authorized
contract by a write that bypassed the guard clears the hold on the next read
(`reverted_by_edit` by `unattributed_write`). A task without a receipt is not
governed, but a relayed `decision_ref` is still verified before its write
lands. Legacy "Proposal contract changed" holds
written before this rule have no `contract_hold`; they still resolve through
`/work-admission/resolve`.

### Praxis successor notes

- Relay Robert's decisions with the block above and the runtime key; send
  unrelated executor edits as separate plain PATCHes. Mixed writes are refused
  whole.
- The receipt `fingerprint` moves whenever the baseline advances. A dispatch
  that prepared a fingerprint before a relayed change must re-read
  `GET /work-admission` before `withAdmittedWork`.
- Criteria-gate stamping of `acceptance_criteria` happens before the
  `in_progress` transition, so it lands as `recorded`; stamping after the
  transition would hold unless relayed with a `decision_ref`.
- Read `hold_kind === "contract_drift"` and `contract_hold` to surface the diff;
  `hasWorkAdmissionHold` (decision !== new_work) already covers it. A
  `concerns[]` entry with `kind: "rulings_rewrite"` is a separate hold on what
  Robert said: deciding the drift never clears it, `/work-admission/resolve`
  with evidence or Robert's own rulings edit does.
- The dashboard task page renders the hold with both actions
  (`dashboard/src/components/task-view/contract-hold-panel.tsx`); from
  localhost it explains that it carries no verified session. Its "Now in the
  brief" column reads the task row itself, so a field deleted while held shows
  as absent, and a stale or changed hold offers a "Refresh diff" action.
