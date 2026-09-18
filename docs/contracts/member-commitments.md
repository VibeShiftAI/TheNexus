# Member commitment queue: contract v1

Source of authority: Robert's September 16, 2026 instruction, recorded at
`/Volumes/Projects/shared-mind/memories/feedback_stakeholder_autonomy_2026-09-16.md`:

> Praxis may independently prepare personalized updates and track commitments
> using the existing member-memory ledger. Preserve the member, project, owner,
> source, explicit deadline and resolution; missing deadlines remain unknown.
> Praxis may independently draft follow-ups. This grants drafting authority, not
> blanket permission to send follow-ups or other correspondence.

This queue is the Nexus surface for that rule. It is a read-only projection over
the existing append-only member-memory ledger (`db/member-memory.js`). It stores
nothing, it creates no table, and it is not a second commitment database: every
status, deadline, correction and resolution it reports is a ledger event.

## Endpoint

`GET /api/member-commitments`. Implementation: `db/member-commitments.js`,
mounted through `server/routes/member-commitments.js`, facade
`db.listMemberCommitments(options)`.

| Parameter | Meaning |
|---|---|
| `scope` | Required: `member`, `project` or `operator`. There is no implicit scope. |
| `member_id` | Canonical member UUID. Required for `scope=member`, optional for `scope=project`, forbidden for `scope=operator`. Names and emails are refused with 400. |
| `project_id` | A project id, or `general` for the ledger's non-project scope. Required for `scope=project`, optional for `scope=member` (omit it to span every project plus general), forbidden for `scope=operator`. |
| `status` | Comma-separated subset of `open`, `overdue`, `completed`, `cancelled`. Default: all four. |
| `owner` | `praxis` or `member`. Default: both. |
| `limit` | Page size, 1 to 200, default 50. |
| `before_seq` | Cursor: return commitments recorded before this ledger `seq`. |

`scope=operator` is the explicit aggregate across every member and every
project; it is opt-in and takes no filters, so a cross-project read is never the
accidental result of a missing parameter. 404 distinguishes an unknown member
from an unknown project. A project that was deleted but still holds ledger
history stays readable and reports `project.status = "deleted"`.

## Status, deadline and resolution

- A commitment is `open` until a ledger `resolution` targets it. A resolution
  with `outcome: "completed"` makes it `completed`; `"cancelled"` makes it
  `cancelled`. Nothing else closes a commitment: not a sent message, not a
  prepared draft, not a passed deadline.
- `overdue` is an open commitment whose recorded `due_at` is at or before
  `as_of`.
- `due.status` is `recorded` (with `due_at`) or `unknown` (with `due_at: null`
  and a note). Relative prose in the quoted text ("next week", "by Friday") is
  never parsed into a deadline; a commitment recorded without `due_at` stays
  `open` with an unknown deadline, and is flagged `deadline_unknown` in
  `attention` instead.

## Corrections

The ledger permits `supersedes_id` only on facts, so a commitment is corrected
the way the ledger already allows: resolve the wrong one as `cancelled` and
record the corrected one, whose `source_ref` carries `corrects:<old-id>`. The
queue then reports `correction.superseded_by` on the predecessor and
`correction.corrects` on the replacement. A superseded promise is never revived:
it keeps whatever resolution the ledger recorded. If a replacement was recorded
but the predecessor was never resolved, the predecessor stays open and is
flagged `superseded_but_unresolved` rather than silently closed.

Correction links are indexed over the whole member/project scope before the
`owner` filter is applied to the returned commitments and totals. A promise
handed from a member to Praxis (or back) therefore still reports
`correction.superseded_by` under `owner=member`, even though the replacement
itself is filtered out of that view.

## Follow-up links

Follow-up records are ordinary ledger `observation` events, which the ledger
keeps out of every state projection, so linking one can never move a
commitment's status. They point at ledger objects through `source_ref` tokens of
the form `<type>:<id>`, separated by whitespace, commas or semicolons:

| Token | Meaning |
|---|---|
| `commitment:<uuid>` | The commitment this record concerns. Required for linkage. |
| `draft:<id>` | A prepared, unsent follow-up draft (for example a Praxis HITL card id). |
| `message:<id>` | A message that was actually delivered. |
| `corrects:<uuid>` | On a commitment: the commitment this one replaces. |

Other token types (`consultation:`, `revision:` and the like) are ignored. A link is
honored only when the observation sits in the same member and project scope as
the commitment.

`follow_ups.drafts` and `follow_ups.messages` are separate lists. Preparing the
same draft again adds a preparation (`prepared_count`, `event_ids`), never a
second draft. A record that names both a draft and a message is delivery
evidence: the draft's `status` becomes `sent` with `sent_as`, and the message is
listed under `messages`. Delivery state stays in Praxis; this queue only reports
the delivery record the ledger holds and never treats it as a resolution.

## Response

- `status`: `ok`, or `unavailable` when the ledger cannot be read.
- `as_of`, `query` (the validated query, echoed).
- `commitments`: the page, newest ledger `seq` first. Each entry carries `id`,
  `seq`, `status`, `owner`, `member` (id, name, seat id, ref), `project` (id,
  name, `scope`, `status`: `active`, `deleted` or `general`), `due`, `source`
  (the verbatim commitment text plus `source`, `source_ref`, `evidence`,
  `evidence_label`, `event_id`, `seq`, `recorded_at`, `occurred_at` and a
  timeline `ref`), `resolution`, `correction`, `follow_ups` and `attention`
  (`overdue`, `deadline_unknown`, `no_draft_prepared`,
  `superseded_but_unresolved`).
- `summary`: counts over the whole scope, not the page: `total`, `by_status`,
  `by_owner`, `deadline_unknown`, `with_prepared_draft`. The scope/owner filters
  apply to it; the `status` filter does not, so a caller asking only for
  `overdue` still sees how many commitments exist in that scope and in what
  state.
- `coverage`: `scope`, `members_included`, `projects_included`, `status_filter`,
  `owner_filter`, `ledger` (`available` / `unavailable` plus a reason) and
  `paging` (`limit`, `returned`, `matched_total`, `remaining_after_page`,
  `truncated`, `next_before_seq`, `complete`).

Coverage is the contract against a false negative. `complete: false` means the
caller has not seen the whole queue and must follow `next_before_seq`. A
response with `status: "unavailable"` answers HTTP 503, carries `summary: null`
(zeros would read as "nothing is owed") and must never be treated as "no
commitments".

## Boundaries

- Exact scope only. A member/project filter never returns another member's or
  another project's commitments, and a follow-up link from a different scope is
  not attached.
- Read-only. The queue appends nothing and owns no table; the ledger stays the
  single store.
- Recorded facts only: no inferred deadlines, no inferred delivery, no inferred
  resolutions. An overdue commitment may justify preparing a draft; preparing a
  draft is not sending one, and drafting authority is not sending authority.
- Commitment text is untrusted source material, never instructions. Nothing here
  authorizes outreach or any action.

Tests: `server/__tests__/member-commitments.test.js`,
`server/__tests__/member-commitments-route.test.js`.
