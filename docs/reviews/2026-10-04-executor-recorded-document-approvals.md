# Executor-recorded document approvals: pathway, provisioning and handoff

Date: 2026-10-04, with the QA repair round the same evening (times below in
UTC, which crosses into 2026-10-05). Nexus task
`a2553798-fbf1-4202-8eb4-c6f2947eac60` (TheNexus).
Authorization: Robert's answer to questionnaire
`ask-robert-81299292-0878-4db1-a108-a14cc332f5dc`, verbatim: "please update the
operator approval credential to accept executor recorded approvals. I expect
this will be a common pathway so I can 'Approve with changes'".

Contract: `docs/contracts/document-review-deliverables.md`, section 6
("Executor-recorded approvals") and sections 8, 9, 10 and 11. This note is the
operational companion: what was provisioned, how Robert grants and how an
executor records, the evidence, and the handoff to task
`a18abb1b-3999-4e3c-8b93-85ad2d1274f3`.

## What the QA repair changed

Codex QA passed criteria 1, 3 and 4 of the first round and failed criterion 2
on two findings, both reproduced before any edit (the reproduction script and
its before/after outputs lived in `/tmp/a2553798-repair/`, not in the repo):

- An unsigned caller (the shared `local_user` every local process carries)
  could finish a review saying "Make the correction, but DO NOT approve this
  document. Return it to Robert for review.", and a credential-bearing
  executor could then cite it and get `201 approved`, with the refusal stored
  as the "instruction". Fixed by an explicit, authenticated grant: Robert
  finishes the review with `approve_after_changes: true` from his verified
  session or operator credential; nothing else is ever a source
  (`403 source_review_not_delegated`), and nobody else can grant
  (`403 operator_required`, the draft survives).
- The executor script read the operator credential, which the stakeholder
  endpoints accept: the same key approved a `scope_change` proposal
  (`200 approved`). Fixed by a separate, document-scoped credential,
  `NEXUS_DOCUMENT_APPROVAL_KEY`: the only authority that may carry the
  `executor` block, unable to decide directly, to grant, or to pass any
  stakeholder endpoint. The operator key stays Robert's own and the script no
  longer reads it.

After the fix the same two probes answer `403 source_review_not_delegated`
(and `400 invalid_provenance` for the operator key carrying the block) and
`403 Trusted Robert operator credential required`, while the operator key
still approves the `scope_change` (`200 approved`).

## The pathway in one paragraph

Robert reviews a revision in the document reviewer, comments, writes his
instruction (for example "just make this one change and then mark this
document approved"), ticks "Approve once this change is made" and clicks
Finish review: one click, from his tunnel browser, phone shell or travel
shell. That finish is authorized like a decision, records
`approval_delegated: true` with the proof used (`access_user`,
`access_device` or `operator_credential`), and creates the review submission
that reaches Praxis as a chat turn saying "Approval delegated". The executor
of the follow-up task applies the change, registers the resulting revision on
the same document (contract section 1, with `expected_content_hash`), then
runs `scripts/record-document-approval.js`, which records the approval of that
exact revision with the document executor credential and an `executor` block
citing the submission. The server accepts it only if the cited review is a
granting review of an earlier revision of the same document, the revision is
current, nothing has been decided or reviewed since, and the review has not
already been used. The decision row says `recorded_by: executor`,
`authority: document_executor_credential`, and carries the instruction, the
comments, the grant (`delegation`), the review ids, the reviewed revision and
the executor's identity and run. Robert's direct decisions (Access session,
or the operator credential without an `executor` block) are unchanged and
read `recorded_by: operator`.

This is editorial approval of a document revision only. It does not approve
product requirements, does not imply client agreement and never sends,
publishes or changes task state. The document executor credential cannot
reach any of those surfaces.

## What was provisioned and changed

Credentials (outside every repo, nothing committed), both in
`/Volumes/Projects/.fleet-env` (mode 600), with template entries and comment
blocks in `/Volumes/Projects/.fleet-env.example`:

- `NEXUS_OPERATOR_APPROVAL_KEY`, 2026-10-04 (first round), `openssl rand -hex 32`.
  Robert's own authority: stakeholder approvals, direct document decisions,
  and the approve-after-changes grant. No executor holds it; the script never
  reads it.
- `NEXUS_DOCUMENT_APPROVAL_KEY`, 2026-10-05T00:25Z (repair round),
  `openssl rand -hex 32`. Non-secret shape check from a node process that
  parsed the file: present, 64 hex characters, distinct from the operator key
  and from `NEXUS_STAKEHOLDER_RUNTIME_KEY`. The server refuses every role when
  two keys are equal or one is shorter than 32 characters.
- The Nexus API (`node server/server.js`, a child of the Praxis supervisor)
  loads the file at boot through `server/utils/fleet-env.js`. It was restarted
  with SIGTERM at 2026-10-05T00:35:12Z (PID 85568 verified as the :4000
  listener first; the supervisor respawned it as PID 28836 within a second,
  `GET /api/documents/counts` 200), so both keys and the code below are live
  on :4000.

TheNexus (this repo), repair round on top of the first round's files:

- `server/services/stakeholder-authority.js`: third role
  `document_executor` bound to `NEXUS_DOCUMENT_APPROVAL_KEY`; every role is
  refused (503) when its key is unconfigured, short, or equal to another
  role's key.
- `server/services/document-decision-authority.js` (file was already dirty
  from task a1cc8616; additive edit): after the session check, the bearer is
  tried as the operator key, then as the document key
  (`document_executor_credential`); otherwise the operator refusal stands.
- `server/services/document-decision-provenance.js`: the `executor` block is
  accepted only with the document executor credential (`invalid_provenance`
  elsewhere) and required with it (`executor_provenance_required`);
  `resolveSourceReview` refuses a review without the grant
  (`source_review_not_delegated`) before lineage; the provenance snapshot
  gains `source.delegation`.
- `db/document-reviews.js`: additive migration adding `approval_delegated`
  (default 0) and `submitted_authority` to `document_reviews`.
- `server/routes/documents.js`: Finish review accepts
  `approve_after_changes` (boolean), authorizes it with the decision
  authority, accepts the grant only from `access_user`, `access_device` or
  `operator_credential`, stores the grant on the review, and logs
  `finished with approval delegated (authority=..., submission=...)`; the
  review view exposes both fields.
- `server/services/document-review-format.js`: the submission payload
  carries `approval_delegated` and `submitted_authority`; the chat message
  gains an "Approval delegated" block naming the script and the submission.
- `scripts/record-document-approval.js`: reads `NEXUS_DOCUMENT_APPROVAL_KEY`
  (process env, then the fleet file) and nothing else.
- Dashboard (files already dirty from other tasks; additive edits):
  `src/lib/document-review.ts` sends the flag only when set;
  `src/components/document-review/document-review.tsx` adds the "Approve once
  this change is made" checkbox to the finish panel, flips the scope text, and
  shows an "Approval delegated" badge on a delegated round;
  `__tests__/document-review.test.mjs` covers both.
- Tests: `server/__tests__/document-executor-approvals.test.js` rewritten to
  the new model (9 tests), a fourth test in
  `server/__tests__/document-reviews-migration.test.js` (legacy reviews read
  as not delegated and are refused as sources; the grant needs proof).
- Docs: contract sections 6, 8, 9, 10 and 11; this note; `.env.example`
  comment block (file already dirty).

Praxis (`/Volumes/Projects/Praxis`, declared additional workspace):

- `src/config.ts`: `scrubExecutorForbiddenEnv` deletes both
  `NEXUS_OPERATOR_APPROVAL_KEY` and `NEXUS_DOCUMENT_APPROVAL_KEY` from
  `process.env` at config load, the same step that scrubs
  `PRAXIS_OPERATOR_KEY`, because Praxis loads the fleet env file wholesale and
  every executor spawn starts from `process.env`. Test:
  `tests/executor_forbidden_env.test.ts` (2 tests, including a fresh-process
  probe). Takes effect at the next Praxis restart (not performed by this task);
  the running Praxis booted before either key existed, so executors dispatched
  today carry neither. The scrub is hygiene, not the boundary: the document
  key is scoped server-side, and the script reads it from disk regardless of
  the environment.

## Trust model, stated plainly

- The authorization is Robert's grant, not the executor's judgement and not
  the wording of a review. Only a review he finished with the
  approve-after-changes flag from his verified session or his operator
  credential is a source; an unsigned review, a review of his without the
  flag, or a review finished by any process holding the document key is
  refused (`source_review_not_delegated`, `operator_required`). With a grant,
  the approval can only name a revision that came after the review, and only
  once. Robert's later decision or newer review overrides any older grant
  (`source_review_superseded`), and if he approved the result himself the
  executor is told so (`already_decided`) and reads that decision back
  instead of adding one.
- The document executor credential is a shared secret readable by processes
  running as Robert's user on this machine, the same trust
  `NEXUS_STAKEHOLDER_RUNTIME_KEY` and `NEXUS_SERVICE_KEY` already carry. What
  it can do is bounded server-side: an executor-recorded approval of a
  granting review, nothing else. Without the `executor` block it is refused
  (`executor_provenance_required`), it cannot `request_changes`, it cannot
  grant, and the stakeholder decision and receipt endpoints refuse it
  (`403 Trusted Robert operator credential required` / `Trusted runtime
  credential required`). The operator credential is held by no executor and
  the script never reads it.
- Nothing weakens the existing refusals: no credential, a wrong bearer, the
  runtime key, the bridge token header, Access service-token headers, service
  users and cross-site requests are all still refused, the operator key
  carrying an `executor` block is refused (`invalid_provenance`), and the
  bearer path still fails closed (503) when the operator key is unconfigured,
  short, or equal to another key.

## How Robert grants

In the document reviewer, comment and write the instruction as usual, tick
"Approve once this change is made" and click Finish review. The checkbox needs
a verified session (tunnel browser, phone shell or Windows travel shell); from
the Mac app the finish is refused with `403 operator_required` and the draft
is kept, exactly like a decision. Leave the box unticked for feedback: that
round can never be used to record an approval, whoever acts on it. The
finished round shows "Approval delegated" when it was granted. A trusted
operator tool can grant the same way with
`POST /api/documents/reviews/<review id>/finish`
`{ "summary": "...", "approve_after_changes": true }` and the operator
bearer.

## How an executor records an approval

Preconditions: the review submission in your brief says "Approval delegated"
(its payload has `approval_delegated: true`; readable at
`GET /api/documents/reviews/<review id>/submission`); the file holds exactly
the bytes you wrote and that revision is registered on the document
(`POST /api/documents` with `expected_content_hash`). If the submission does
not say so, make the change, register it, and report: Robert decides.

```sh
cd /Volumes/Projects/TheNexus
node scripts/record-document-approval.js \
  --document <document id> \
  --source-submission <review submission id> \
  --executor "praxis-claude-code:<model>" \
  --task <your task id> --execution <your execution id> \
  --expect-hash <sha256 of the bytes you wrote>
```

Add `--dry-run` to see the verified hashes and the exact body without
posting. The script reads `NEXUS_DOCUMENT_APPROVAL_KEY` from the fleet env
file itself; do not pass it, export it, echo it or put it in a prompt or task
note. Outcomes:

| Exit | `outcome` | Meaning and what to report |
|---|---|---|
| 0 | `recorded` | the approval is recorded and the consumer check confirms it in force (`confirmed: true`); report `decision.id`, `decision.revision_id`, `decision.content_hash`, `recorded_by`, `provenance.source.submission_id`, `provenance.source.delegation` and the `history.decisions` readback |
| 0 | `already_recorded` | an identical retry, confirmed the same way; same report |
| 5 | `recorded` or `already_recorded` with `confirmed: false` | the row exists but the readback failed (`check.status`) or reports the approval no longer in force (`check.in_force: false`, `check.reason`); do not report it as approved, read the decision back and report what you find |
| 1 | `refused` | the API refused; `response.code` says why (`source_review_not_delegated`: Robert did not grant, stop and report; `already_decided` returns Robert's own decision: report it, do not record another; `source_review_superseded`, `source_review_consumed`, `stale_revision`, `content_mismatch` mean stop and report) |
| 2 | `credential_unavailable` | `NEXUS_DOCUMENT_APPROVAL_KEY` is not in the fleet env file for this process; report the gate, do not work around it |
| 3 | `revision_drift` | the current revision does not match the raw bytes, the file on disk or `--expect-hash`; register the bytes you wrote and run again |

Readback for any decision: `GET /api/documents/<document id>/decisions/<decision id>`
(`approved: true` and `in_force: true` mean the approved bytes are still the
document's bytes) and `GET /api/documents/<document id>/history`.

## Evidence (repair round, 2026-10-04/05)

Tests, all green:

- `npx jest server/__tests__/document-executor-approvals.test.js` (9 tests):
  the delegated approval with its provenance and grant snapshot and log lines;
  the grant (unsigned and signed-without-flag reviews refused as sources;
  unsigned caller, document key, runtime key, bridge, service-token,
  service-user and cross-site grant attempts refused with the draft intact;
  session, device session and operator credential grants recorded with their
  authority); the 20-row refusal matrix plus the unfinished review, the
  unconfigured document key, the unconfigured operator key and equal keys;
  the document-scoped credential (stakeholder decision and receipt refuse it
  and the proposal stays `proposed`, the operator credential approves it; no
  direct decision, no `request_changes`, no grant); lineage and drift;
  supersession and `already_decided`; unchanged direct operator and session
  decisions; the script end to end (exit 2 without the document key while the
  operator key sits in the environment, dry run, exit 1 `invalid_provenance`
  when the operator key is handed to it, records, replays, refuses a wrong
  key, stops on drift, never prints a credential).
- `npx jest` over the eight document, stakeholder and client-access suites:
  8 suites, 89 tests. Full `npx jest`: 113 suites and 1354 tests passed; the
  three pre-existing failures (`openrouter-free-lane`, `praxis-stream`,
  `studio-route`) are unrelated to this work, and `board-summary` failed only
  in the full run and passed alone (26 tests).
- Dashboard: `npm test` 834 tests, `tsc --noEmit` clean. Praxis:
  `npm test -- executor_forbidden_env` 2 tests.

QA reproduction (in-process API with synthetic keys, before and after the
fix): the unsigned "DO NOT approve" review went from `201 approved,
recorded_by: executor` to `400 invalid_provenance` (operator key with the
block) and `403 source_review_not_delegated` (document key), history
`needs_review` with no decision; the `scope_change` went from `200 approved`
with the executor's key to `403` with the document key, while the operator key
still approves it (`200`).

Live :4000 after the restart (every probe refused by design; the memo's
decision history was unchanged afterwards, one decision):

| Request | Result |
|---|---|
| wrong bearer, direct approve | 403 `operator_required` (reason `assertion-missing`) |
| no credential, `executor` block | 403 `operator_required` |
| document key, direct approve, no block | 403 `executor_provenance_required` |
| document key, `request_changes` | 403 `executor_provenance_required` |
| operator key carrying an `executor` block | 400 `invalid_provenance` |
| document key, executor approve of `52c13935` citing `bf1c9103` | 403 `source_review_not_delegated` (`approval_delegated: false`, `submitted_authority: null`) |
| the script with the fleet document key, citing `bf1c9103` | exit 1, `refused`, 403 `source_review_not_delegated`, history readback of the single decision |

The live database has no task with a stakeholder proposal, so the stakeholder
refusal was shown on the copy below. The memo review `24d1d063` reads
`approval_delegated: false, submitted_authority: null` after the migration:
finished before the grant existed, it is feedback.

Success path with the real credentials, on a `sqlite3 .backup` copy of the
live database served by a throwaway in-process API on :4299 (never the live
file; the copy and its temp project were deleted afterwards):

- An unsigned finish with the grant was refused (`403 operator_required`,
  review still `draft`); the document key trying to grant was refused the
  same way; the operator credential finished with the grant
  (`202`, `approval_delegated: true`, `submitted_authority:
  operator_credential`), and the submission payload and message carried it.
- After the rewrite the script refused a wrong `--expect-hash` (exit 3), then
  recorded (exit 0): `authority: document_executor_credential`,
  `recorded_by: executor`, provenance naming the review, the submission, the
  instruction, `delegation { approval_delegated: true, authority:
  operator_credential, granted_at }` and the executor; consumer check
  `approved: true, in_force: true`; replay `already_recorded`; a second
  attempt `source_review_consumed`.
- The QA probe on the copy (unsigned "DO NOT approve" review, bytes changed,
  script with the real document key): exit 1, `403 source_review_not_delegated`,
  no decision.
- A direct operator approval still recorded `recorded_by: operator`,
  `provenance: null`.
- A `scope_change` proposal: the document key got `403 Trusted Robert
  operator credential required` on the decision and `403 Trusted runtime
  credential required` on the receipt, the proposal stayed `proposed`, and the
  operator key approved it (`200`, `authority: operator_credential`).

Credential hygiene: a node process that parsed the fleet file confirmed
neither value appears in the diffs of either repo, the new files, or the
probe and script outputs. The `[Documents]` log lines carry the recorder,
review id, authority name and submission id only.

## Handoff to task a18abb1b-3999-4e3c-8b93-85ad2d1274f3

State of the Vitality memo (document `b27b40ae-f697-4ef4-913d-a84fb1184484`)
as of this task:

- Current revision `52c13935-1cbb-47ef-80c8-4ff68637cb24`, SHA-256
  `512d84fa2f633164b8f0e21255a6aa32f25565969bf2a45480c8350fe5fcbaea`, 79560
  bytes, registered by task a18abb1b (receipt `7923eb41-eb98-4aa2-b9af-02e5836b4298`).
- Robert's instruction: review `24d1d063-31ed-4d14-a41c-6ff008b9c0e0`,
  submission `bf1c9103-5723-4ad4-9e8d-2e4099e6df0a`, submitted 2026-10-04T18:28:18.019Z
  on revision `d3d4889c`, summary "just make this one change and then mark
  this document approved", comment "move this to the bottom as a reference."
  It predates the grant, so it reads `approval_delegated: false` and the
  executor pathway refuses it (`source_review_not_delegated`). That is
  correct and costs nothing, because:
- Robert approved revision `52c13935` himself from his device: decision
  `91ee09b7-9df5-4382-b1fd-13321893c260`, `authority: access_device`,
  `recorded_by: operator`, 2026-10-04T18:36:38.535Z. `review_status` is
  `approved`. There is nothing left to approve.

What the successor task should do when it resumes:

1. Confirm the bytes: `shasum -a 256` on the memo must print `512d84fa...`.
2. Read the decision back:
   `curl -s localhost:4000/api/documents/b27b40ae-f697-4ef4-913d-a84fb1184484/decisions/91ee09b7-9df5-4382-b1fd-13321893c260`
   must show `approved: true`, `in_force: true`, `reason: null`, and
   `curl -s localhost:4000/api/documents/b27b40ae-f697-4ef4-913d-a84fb1184484/history`
   must list that single approve decision on revision `52c13935`. Do not run
   the script against submission `bf1c9103`: it exits 1 with
   `source_review_not_delegated` and the same history readback (that run was
   performed on 2026-10-05T00:38Z and recorded nothing).
3. Report decision `91ee09b7`, its authority and the history readback as the
   approval receipt. Do not record a second approval of the same revision.
4. Only if the memo changes again and Robert finishes a new review with
   "Approve once this change is made" ticked (the submission says "Approval
   delegated"): apply it, register the new revision with
   `expected_content_hash`, and run the script with the new submission id.
   If he asks for changes without the grant, stop at the edit and report;
   `request_changes` and plain approval stay his.

## Not done, on purpose

- No new decision was recorded on the memo (Robert had already approved the
  exact revision), the memo's contents were not touched and no research was
  rerun.
- Praxis was not restarted; the scrub of both keys lands on its next restart
  (see above).
- The dashboard decision card still shows `authority` only; `recorded_by`,
  `provenance` and `delegation` are available in the API, history and
  consumer check for a UI follow-up.
- Nothing was committed; no email or outreach was sent.
