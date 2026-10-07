# Canonical task mutations

Task GETs return an executor projection. For external and NULL sources the
projection wraps the prompt and withholds commands. Never persist that
projection as a replacement payload. These mutation surfaces instead merge
only the requested fields into raw canonical storage and keep the existing
board lease, task-version CAS, contract guard, and origin classification.
No endpoint unwraps prompts or changes trust classification on a read.

`POST /api/tasks/:id/operator-rulings` accepts one raw `ruling`, optional
`source`, `provenance: {kind, id, instructed_at?}`, `source_scoped`, and
`expected_version`. Nexus owns the 1,200-character clipping and full-text ID
stamp. It preserves existing rulings and appends inside the same SQLite
transaction as admission auditing. Exact duplicates return success without a
version bump. A scoped provenance identity compares kind + decision ID, so a
new decision with the same words is distinct. Without scope, an already vouched
identical answer can deduplicate across channels as before. Provenance labels
are descriptive; only verified credentials determine the audit origin. A plain
fallback remains unverified. Prompt, commands, source and governed hash are
unchanged by an answer. The response `{success, task}` is guarded for dispatch.

`POST /api/tasks/:id/workspace-delta` accepts optional `workspace`, required
`workspace_roots` (union), and `history: {from?, to, action, at, reason?, by?}`
(append). Omitting workspace adds roots without changing the primary pointer.
Optional `payload_ledger` requires `expected_version`. Optional
`contract_change` uses the existing authenticated authority mechanism; an
unverified workspace scope change during execution still produces a drift hold.
The merge and update are transactional and return a guarded task projection.

`PATCH /api/tasks/:id` also supports three narrow fields, with required
`expected_version`:

- `payload_delta`: explicit payload keys to set; `null` removes that key. Allowed
  keys are the governed payload fields plus operational `repair_context` and
  `improvement_issue`. Operator rulings use the append endpoint. Explicit prompt
  or command edits keep the existing provenance cap. Actual changed fields still
  undergo contract admission and exact relayed-field checks.
- `acceptance_criteria_append`: append new criteria to current criteria, keeping
  existing authored entries and deduplicating trimmed case-insensitive matches.
- `payload_ledger`: exactly `binding_constraints` and `binding_constraints_text`,
  merged after any explicit delta. Ledger projection itself does not authorize
  changes to authored constraints.

A replacement `antigravity_payload` cannot accompany these fields. A payload
set delta and criteria append cannot accompany one another. Unknown keys fail
with `400 task_delta_invalid`; stale versions and conflicting/lost leases
fail with the existing 409 codes, before a write. Full explicit replacement
remains supported with its existing guards; it must be authored canonical
content, never an executor GET projection.

Praxis uses these seams for answer recording, workspace transitions, criteria
stamping, relayed operator scope decisions, constraint refresh, parked repair
context and improvement-evidence markers. The operator relay retains its
one-decision application ledger and retries only through its existing CAS
protocol; unrelated drift is never automatically approved.

For a relayed explicit prompt/command delta, Praxis declares those requested
keys even when GET cannot reveal whether the value changed. Nexus validates the
decision reference and computes the actual diff against raw canonical storage.
A withheld-command deletion therefore retains its authorization; setting the
canonical prompt to its current value records no contract change. The applied
decision ledger uses Nexus's recorded fields, not a diff of the executor view.
This does not authorize an unnamed field or alter full-replacement semantics.

Deploy the Nexus delta API before starting Praxis with the new callers. Old
Nexus servers do not support these operations; callers retain failure evidence
and must not fall back to copying the executor payload.

Verification uses synthetic tasks in temporary SQLite and ephemeral HTTP
servers in `server/__tests__/task-canonical-deltas.test.js`. No historical
canonical row is automatically repaired: the October 6 trust-wrapper mutation
requires a separately reviewed exact data repair, not heuristic unwrapping.
