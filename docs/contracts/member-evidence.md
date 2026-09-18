# Member evidence lookup: contract v1

Source of authority: Robert's September 16, 2026 instruction, recorded at
`/Volumes/Projects/shared-mind/memories/feedback_stakeholder_autonomy_2026-09-16.md`:
project-specific assertions and general directory policy must remain distinct, and
an absent project fact must be disclosed as absent rather than answered from a
general default. This lookup is the Nexus surface for that rule. It is a read-only
projection over the existing member-memory ledger (`db/member-memory.js`), the
directory row (`contacts`, `project_contacts`) and the profile-proposal queue
(`db/member-profile-proposals.js`). It stores nothing and it is not a second
profile database.

## Endpoint

`GET /api/members/:id/evidence` (also on the legacy `/api/contacts` alias).
Implementation: `db/member-evidence.js`, mounted in `server/routes/contacts.js`,
facade `db.getMemberEvidence(id, options)`.

Query parameters (all strings; unknown or repeated fields fail with 400):

| Parameter | Meaning |
|---|---|
| `scope` | Required. `general` or `project`. There is no implicit scope. |
| `project_id` | Required with `scope=project`, forbidden with `scope=general`. |
| `question` | Question type, default `all`: `all`, `contact_channel`, `tone`, `availability`, `approval`, `role` (project scope only), `preference`, `goal`, `expertise`, `commitment`. |
| `fact_key` | Optional exact ledger topic. Narrows the question's ledger and proposal matches to records carrying exactly this key (with `question=all` it is a pure exact-key filter). |
| `limit` | Per-bucket cap, 1 to 200, default 50. |

Each question maps to directory fields, ledger topics and proposal categories. A
ledger key matches a question when it starts with one of the question's prefixes
(`profile.goal.`, `profile.expertise.`, `profile.preference.`) or carries one of
its topics as a dot-separated segment: `contact_channel`/`channel`, `tone`,
`availability`, `approval`/`require_approval`, `role`, `goal`, `expertise`/`skill`.
So a fact keyed `availability` or `profile.preference.availability` is found by
`question=availability` (and by `preference`) without a second key. A pending
proposal matches by category or by its own fact key under the same rule.

`:id` must be the canonical member UUID. Names, emails and seat ids are refused
with 400; they are resolved through `GET /api/members?search=` or `?email=`
first. 404 distinguishes an unknown member from an unknown project. A project
that was deleted but still holds this member's historical events stays readable
and reports `project_link.status = "project_deleted"`.

## Response

- `member_id`, `scope`, `project_id`, `question`, `as_of`, `directory_updated_at`.
- `identity`: name, seat id, kind, status, `ambiguous` and
  `same_name_member_ids`. The result is for the canonical id only; the flag only
  warns that another record shares the name.
- `project_link` (project scope only): `linked`, `unlinked` or `project_deleted`,
  plus role and Primary Decision Maker flag.
- `sources`, one bucket per source class:
  - `directory_settings`: operator-maintained operating settings (`preferences.*`,
    `status`, `expertise`, `interests`, `claims`, and in project scope the link's
    `project.role` and `project.decision_maker`). `applies_to: "all_projects"`
    and `is_project_statement: false` except for the link fields. Contact details
    (email, phone, birthday, notes) are never included.
  - `general_assertions`: current general-scope facts with evidence
    `self_reported`, `operator_confirmed` or `observed`.
  - `project_assertions`: the same for the requested project. When none exist the
    bucket is `status: "missing"` with an explicit note; in general scope it is
    `not_requested`. Inferred project records never count as a project assertion.
  - `inferred_observations`: current facts with `inferred` or `legacy` evidence in
    the eligible scopes, each labelled with its scope.
  - `demonstrated_contributions`: member-owned commitments resolved as
    `completed` on `operator_confirmed` or `observed` evidence, carrying the
    resolution's id and evidence. Council reputation standing lives in Praxis and
    is reported as `external.council_reputation.status = "unavailable"` with the
    seat id.
  - `completion_claims`: member-owned commitments resolved as `completed` on
    `self_reported`, `inferred` or `legacy` evidence (`source_class:
    "completion_claim"`). These are claims of completion and never appear under
    demonstrated contributions.
- `context`: `open_commitments`, `pending_proposals` (unreviewed claims,
  `is_evidence: false`) and `history` (`corrected` with `corrected_by`,
  `retracted` with `retracted_by` and the retraction text, `conflicts` with
  `source_class: "conflict"`, the competing event ids and `status: "unresolved"`).
- `coverage`: eligible scopes, and explicit `other_projects_included`,
  `observations_included` and `contact_details_included`, all `false`.

Every ledger record keeps its full event fields (`id`, `seq`, `fact_key`,
`source`, `source_ref`, `supersedes_id`, `target_id`, timestamps) plus `scope`,
`source_class` and a human `evidence_label`, so a downstream answer can cite
exact identifiers. Bucket `status` values are `present`, `missing` (known
absence in the exact scope), `partial` (truncated by `limit`; `total` and
`truncated` say how much is missing), `not_requested` (outside the question) and
`unavailable` (a store that cannot be read, with a `reason`).

## Boundaries

- Exact scope only: project scope reads that project and general; general scope
  reads general. Another project's records are never returned.
- Raw observations (consultation transcripts, Praxis notes, directory-change
  captures) are excluded; they remain available in the memory timeline.
- This is an operator-side lookup on the trusted Nexus API. It is not a member
  portal surface and does not authorize outreach or any action.
- The dashboard panel "Evidence by question" in the member working-memory
  section (`dashboard/src/components/member-evidence.tsx`) renders the same
  buckets with the same labels and refuses any response whose records fall
  outside the requested member and scope.

Tests: `server/__tests__/member-evidence.test.js`,
`server/__tests__/member-evidence-route.test.js`,
`dashboard/src/components/__tests__/member-evidence.test.mjs`.
