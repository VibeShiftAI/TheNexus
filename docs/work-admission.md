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
repair/session metadata. Unmarked authored rules, including reserved `BC-*` IDs,
remain substantive. A changed exact reservation returns conflict rather than
substituting a differently scoped task. Resolved receipts survive unrelated
history changes but invalidate on any newly relevant owner, including results
beyond the three-item shortlist. `coverage.relevant_count` exposes truncation to
the runtime. Admission GET joins a valid `x-nexus-board-lease` so the runtime can
fence final inspection and launch against concurrent API mutations.
