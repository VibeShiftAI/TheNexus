# Reserved stakeholder actions — contract v1

The September 16, 2026 operator instruction is recorded at
`/Volumes/Projects/shared-mind/memories/feedback_stakeholder_autonomy_2026-09-16.md`.
The Nexus stores that general policy in `stakeholder_policies`. No project override
is inferred: `project_policy: null` means none is recorded. Independent operations
are recommendations, personalized-update preparation, commitment tracking,
follow-up drafting and evidenced/deduplicated enhancement-ticket filing. These
permissions do not authorize correspondence, invitations, promises of expanded
scope, or changes to the project's approved scope. Other existing permissions
and member-memory/profile/briefing/answer flows are unchanged.

## Authority and activation

Inspection found no authenticated human identity in the existing Nexus local
`req.user` stub. The Praxis HITL resolver also accepts caller-supplied
`resolvedBy`; importing that string would not meet this task's authority rule.
The existing Nexus `/stakeholder-decision` endpoint therefore now has a separate,
fail-closed credential check for reserved proposals. Legacy PDM decisions remain
backwards compatible for unrelated requests.

Provision `NEXUS_OPERATOR_APPROVAL_KEY` through the supervisor/secret store into
the Nexus server environment (not a generic settings-editable `.env` file), at least
32 random characters, exclusively for Robert's decision surface. Provision a
**different** `NEXUS_STAKEHOLDER_RUNTIME_KEY` for the trusted runtime's receipt
writer. Never give the operator key to a requester, member, agent tool, runtime
worker, or JavaScript bundle. The dashboard accepts Robert's key in a password
field, holds it only in component memory and clears it after success; it does
not persist it or fetch it from the API. Use the existing protected HTTPS
operator deployment when accessing remotely. Missing, short or equal keys fail
closed with 503; a wrong/missing credential fails with 403. No credentials were
created, changed or printed by this task. No production process was restarted.

Only a valid operator bearer credential records `authority: operator_credential`
and server-owned `operator: robert`. `decided_by`, `req.user.role`, member/PDM
status, missing PDMs, and service/local-dev tokens confer no reserved authority.
The machine bridge header is rejected. The runtime credential cannot approve.
This credential is a capability; its possession must remain exclusive to Robert.

## Reuse of the request queue

Create an ordinary task for the exact canonical project using the existing task
API. Register its concrete proposal with:

```
POST /api/tasks/:taskId/stakeholder-proposal
{
  "kind": "invitation",
  "member_id": "canonical-member-id",
  "content": { "message": "Exact invitation text", "role": "Reviewer" }
}
```

A scope proposal uses `kind: "scope_change"`, an optional canonical `member_id`,
and concrete `content: {before, after, reason}` strings. Include any additional
material terms in `content`; all keys participate in the immutable hash.
Registration validates canonical project/member existence. Invitation approval
binds the stored member identity/email, exact project, kind, task snapshot,
project snapshot, entire content and revision. Do not substitute destinations,
roles, terms or project IDs in the consumer. A directory link is neither needed
nor created by registration and conveys no invitation or participation evidence.

The task receives a backwards-compatible `stakeholder_gate`; reserved tasks stay
blocked even when approved, because generic task scheduling is not delivery or
scope-application authority. Existing gate fields/history are retained. The
immutable ledger, not writable task metadata, owns reserved approval state.

Revising uses the same endpoint and a full replacement proposal plus
`expected_revision`. The first request expects 0 (omitted is 0); revisions expect
the current integer. Every new revision is proposed and requires fresh approval.
Old content and decisions remain inspectable. Rejected/cancelled/duplicate or
executed proposals cannot be revised: create a new task to propose new work.
Material task text/project/execution-instruction changes and canonical member
name/email changes and project description/end-state changes persist an invalidation; restoring the old values does not
resurrect approval. Refresh the concrete proposal and obtain a new decision.
Task cancellation also persists; metadata forgery and task reopening do not
restore approval. Deleting a task/project preserves ledger history and disables
execution. SQL update/delete of ledger history is rejected by SQLite triggers.

Legacy explicitly reserved requests can carry
`metadata.stakeholder_action.kind` or
`metadata.stakeholder_gate.action_kind` (`invitation` or `scope_change`). They
cannot pass through the legacy decision path and must first register an immutable
proposal. Natural-language task text is not an action classifier. Runtime code
must classify actions by their actual effect, not requester labels; neither an
ordinary approved task nor a PDM exemption authorizes a reserved effect.

## Reads and decisions

- `GET /api/projects/:id/stakeholder-policy` returns `{policy, project_id,
  project_policy: null}`.
- `GET /api/projects/:id/stakeholders` retains `members`/`decision_makers` and
  adds policy and proposal records.
- `GET /api/projects/:id/requests?status=all` retains request fields and adds
  each reserved `proposal`. Default `pending` includes proposed, deferred and
  invalidated proposals. The immutable registry survives removal of gate metadata.
- `GET /api/tasks/:taskId/stakeholder-proposal` returns `{proposal}` with current
  state, revision, hash, snapshots, every revision, decisions and history.
- `POST /api/tasks/:taskId/stakeholder-decision` reuses the existing decision API:
  `{decision: "approve"|"reject"|"duplicate"|"defer", revision, content_hash,
  note?, duplicate_of?}`, with Robert's bearer credential. Missing/stale revision
  or hash yields 409 without changing history. Duplicate requires a real other
  task. Decisions never issue invitations, assert acceptance or apply scope.

## Runtime consumer handoff

The downstream Praxis task
`1366bb2d-938d-4141-a374-59138e762227` (correspondence/CC and reserved gates) must
use this contract at its effect boundary; its dependent preparation task is
`c9658570-4fec-45b1-8626-2f3298b0f819`. This change does not install a second
orchestrator in Nexus or claim that existing arbitrary runtime sends are gated.
No additional repository was modified.

Before issuing or promising an invitation or scope change, read the proposal
from Nexus and require `state: approved`, `execution_allowed: true`, and an exact
match of the intended member, project, kind, revision, hash and content. Refuse
missing records, lookup failures, stale revisions and all other states. Never
fallback to PDM/no-PDM exemptions. `execution_allowed` is a point-in-time check,
not a transferable permission or permission to queue an unchecked later send.
Serialize proposal editing/decisions and the effect in the runtime's existing
write lease. Re-read immediately before the effect. Do not automatically retry
an uncertain delivery/application; reconcile its external evidence first.

After a successful effect, record its **actual** provider/application reference:

```
POST /api/tasks/:taskId/stakeholder-receipt
Authorization: Bearer <runtime-only key>
{ "revision": 1, "content_hash": "<approved hash>",
  "state": "issued", "evidence": "provider:message-id" }
```

Invitations transition approved → issued → accepted. Acceptance requires a
separate member-response reference; neither delivery nor a project contact link
implies consent. Scope proposals transition approved → applied. Receipts validate
current approval/revision and state; exact same-state receipt retries are
idempotent. `applied` records the trusted runtime's application receipt: this
endpoint normally does not itself rewrite a project's description/end state.
For a Nexus description change, propose `content.field: "description"` with exact
`before` and `after`, then pass `apply_to_project: true` on the applied receipt.
Nexus checks the current description against `before` and atomically applies
only the approved `after` plus the receipt; no separate generic PATCH is needed.
Other scope representations are external application receipts. A Nexus scope
edit made separately invalidates pending approval, so do not use separate PATCH
then receipt for the same Nexus description change. Generic
project editing remains an existing API surface; the runtime must gate actual
scope expansion before invoking it. Receipt failure does not undo an external
effect; reconcile and retain its evidence rather than sending/applying twice.

Credentials and endpoint state enforce the Nexus record boundary. Runtime
serialization/effect integration, verified operator address and universal CC
remain the named dependent task's responsibility. This contract is not evidence
of deployment of those runtime changes.

## Verification

All tests use temporary SQLite data and synthetic `.invalid` members. No real
member is contacted. The policy suite drives the real HTTP router and database,
including forged decision identities, PDM/no-PDM cases, independent credentials,
revision invalidation, immutable history, separate execution receipts and scope
non-mutation. Dashboard tests mount the real request panel and inspect its
credential-bearing, revision-bound decision request and lifecycle labels.
