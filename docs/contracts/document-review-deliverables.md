# Document review deliverables: consumer contract v1

Owner: Nexus task 708c8a8a (Track required document reviews against the exact
delivered revision), 2026-10-02.
Consumers: the Praxis handoff task (e95e1af1), the Nexus UI task (75de5032)
and, for decisions only, the stakeholder sender (c9658570).

This contract extends the existing Markdown document registry
(`server/routes/documents.js`, store `db/document-reviews.js`). It adds four
things and nothing else:

1. a declared-deliverable registration that answers with a server-validated
   receipt for one immutable revision;
2. a derived review status per document;
3. explicit operator decisions (Approve document, Request changes) pinned to
   one revision;
4. filtered, paginated listing with truthful totals and per-status counts.

Non-goals, on purpose:

- Nothing in this API sends, publishes or implements anything. An approval is
  a recorded editorial decision on one revision. Whoever performs the
  intended action (a sender, a publisher, an implementer) verifies the
  decision first and keeps its own authority checks.
- Comments, Finish review and task QA never approve. Finish review still
  delivers feedback to Praxis exactly as before.
- No file crawler: only paths a producer declares are registered.
- No second review system: comments, review rounds and feedback delivery are
  the existing ones.

All paths below are relative to the Nexus API (`/api/...`) or the dashboard
(`/documents/...`). The dashboard proxies `/api/*` to the API, so a dashboard
consumer calls the same relative paths.

## 1. Registering a declared deliverable

`POST /api/documents` with a `deliverable` object. A body without
`deliverable` is the legacy registration and behaves exactly as before (its
response also carries `review_path` now).

```json
{
  "path": "/Volumes/Projects/<project>/docs/plans/example.md",
  "title": "Example plan",
  "project_id": "<project id>",
  "task_id": "<task id, required unless source.type is chat>",
  "kind": "plan",
  "metadata": { "subject_project_id": "<optional>" },
  "expected_content_hash": "<optional lowercase hex sha256 of the bytes you wrote>",
  "deliverable": {
    "key": "<optional stable identity, see section 2>",
    "purpose": "What this document is for, 1-500 characters",
    "requires_review": true,
    "intended_action": "none | implement | send | publish",
    "source": { "type": "task | chat", "conversation_id": "...", "message_id": "...", "execution_id": "..." }
  }
}
```

Field rules (strict: an unknown or misspelled field is refused, so a typo can
never silently register a reference document in place of a review request):

| Field | Rule |
|---|---|
| `deliverable` | object with only `key`, `purpose`, `requires_review`, `intended_action`, `source` |
| `requires_review` | boolean, required. `false` means a reference document: discoverable, never awaiting a decision |
| `purpose` | required, 1-500 characters |
| `intended_action` | required, one of `none`, `implement`, `send`, `publish`. Anything but `none` requires `requires_review: true` (approval comes before the action) |
| `key` | optional, 1-300 printable characters, must not start with `path:` (that prefix is reserved for derived keys) |
| `source` | optional object: `type` is `task` or `chat`; optional `conversation_id`, `message_id`, `execution_id` (1-200 printable characters each). A chat source needs `conversation_id` |
| `title` | required, 1-300 characters |
| `project_id` | required; the project must exist |
| `task_id` | required unless `source.type` is `chat`; the task must exist and belong to `project_id` |
| `kind` | optional: `document`, `report`, `spec`, `plan`, `research`, `walkthrough`, `other` |
| `metadata` | optional small JSON object (at most 8000 characters serialized), merged into existing metadata |
| `expected_content_hash` | optional lowercase hex SHA-256 of the exact bytes on disk (BOM and line endings included); if given, the file must hold exactly those bytes |

The server then checks, in this order, and stops at the first failure. No
failure writes anything.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_deliverable` | a field rule above failed |
| 404 | `project_not_found` | `project_id` does not exist |
| 404 | `task_not_found` | `task_id` does not exist |
| 422 | `association_mismatch` | the task belongs to a different project |
| 400 | `invalid_path` | path missing or not absolute |
| 415 | `not_markdown` | not `.md` / `.markdown` (also after resolving symlinks) |
| 403 | `forbidden_path` | inside `.git` or `node_modules` |
| 403 | `outside_roots` | outside every registered project root |
| 403 | `symlink_escape` | resolves outside every registered project root |
| 403 | `unresolvable` | the path could not be resolved |
| 404 | `not_found` | the file does not exist |
| 400 | `not_a_file` | not a regular file |
| 413 | `too_large` | over the registry's size limit |
| 500 | `unreadable` | the file exists but cannot be read |
| 422 | `invalid_encoding` | not valid UTF-8 |
| 409 | `content_mismatch` | the exact bytes differ from `expected_content_hash` (response carries the SHA-256 of the actual bytes as `content_hash`) |
| 409 | `identity_conflict` | the identity rules below would merge two different deliverables |
| 409 | `registration_conflict` | a concurrent registration claimed the same identity; retry |

"Allowed root" means any registered Nexus project root. The file does not
have to live under the declared project's root, because a producing task may
legitimately write a document about another project. Record such a subject in
`metadata` (for example `subject_project_id`); the declared `project_id` and
`task_id` are always the producer's, and they must agree with each other.

Success is `201` when a new document was created and `200` when an existing
one was reused:

```json
{
  "document": { "...": "the stored document row" },
  "revision": { "id": "...", "content_hash": "...", "byte_length": 0, "line_count": 0, "...": "..." },
  "review_url": "https://<dashboard>/documents/<id>",
  "review_path": "/documents/<id>",
  "created": true,
  "duplicate": false,
  "receipt": { "...": "see below" }
}
```

The receipt is the proof of what was registered. It is stored append-only and
is returned again, unchanged, for a byte-identical retry of the same
declaration (`duplicate: true`).

| Receipt field | Meaning |
|---|---|
| `id` | receipt id |
| `document_id`, `revision_id`, `content_hash` | the document and the exact immutable revision registered; `content_hash` is the SHA-256 of the exact file bytes |
| `byte_length`, `line_count` | exact byte length of that revision, and its line count |
| `deliverable_key` | the identity used (declared key or derived `path:<canonical path>`) |
| `path`, `root_project_id` | canonical file path and the registered root that contains it |
| `project_id`, `task_id` | the producer association as validated |
| `title`, `purpose`, `kind`, `requires_review`, `intended_action`, `source` | the declaration as accepted |
| `document_created`, `revision_created` | whether this call created the document / the revision |
| `registered_by`, `registered_at` | who and when |
| `review_status` | the document's status when the receipt is read (section 3) |
| `review_path` | relative dashboard route `/documents/<id>` |
| `review_url` | absolute dashboard URL (from `NEXUS_DASHBOARD_URL`) for messages that leave the app |
| `raw_path` | `/api/documents/<id>/raw?revision=<revision_id>`: exactly the registered bytes, which hash to `content_hash` |

## 2. Identity: one document per deliverable

A registration resolves its document in this order, inside one transaction:

1. the declared `key`, or when no key is declared the derived key
   `path:<canonical path>`;
2. a legacy row for the same canonical file and the same task;
3. when a task is declared, a chat-era row for the same file with no task.

So a retry, a re-run of the same task, and a chat-to-task or task-to-task
handoff all land on the same document, provided the producer carries the same
key (or registers the same file without a key).

A document keeps one consistent producer pair (`project_id`, `task_id`): the
task always belongs to the project. A document's `task_id` is adopted once,
from a chat-era `NULL`, and it takes the declaring project together with that
task. A later registration from another task, or from another project, leaves
the document's own pair unchanged and is linked through its receipt; the
`task_id` and `project_id` list filters both include documents linked that
way, so the handoff is discoverable under both producers.

Revisions are content-addressed per document and immutable (a database
trigger refuses updates). For a declared deliverable the address is the
SHA-256 of the exact file bytes: re-registering identical bytes reuses the
revision, and any byte change, including only adding or removing a BOM or
switching LF and CRLF line endings, creates a new revision and makes it
current. Legacy documents that were never declared keep the line-normalized
identity they always had, so their review behavior does not change. Earlier
revisions, receipts, review rounds, comments and decisions are kept and stay
readable in history.

The latest declaration wins for `title`, `purpose`, `requires_review` and
`intended_action`. Re-declaring `requires_review: false` never approves
anything: the document becomes a reference and any earlier approval stops
being in force (`reason: review_not_required`).

`identity_conflict` is returned when the file is already registered for that
task under a different declared key, or when moving a keyed deliverable to a
new path would collide with another document that already holds that file for
that task.

Recommended keys: choose the key when the deliverable is first declared and
carry it through every handoff, for example `praxis:<project slug>:<short
slug>`. Do not put a task id or attempt number in the key if the deliverable
is expected to move between tasks or chats.

## 3. Review status

Derived on read, never stored, one SQL expression shared by list, totals and
counts:

| `review_status` | When |
|---|---|
| `reference` | `requires_review` is false (every legacy document until it is declared) |
| `approved` | the latest decision is `approve` and it is on the current revision |
| `changes_requested` | the latest decision is `request_changes` and it is on the current revision |
| `needs_review` | review is required and no decision applies to the current revision |

New bytes (a BOM or line-ending change included) therefore move an approved
or changes-requested document back to `needs_review` automatically. An
approval never carries over to new bytes.

## 4. Listing and counting

`GET /api/documents?status=&task_id=&project_id=&kind=&q=&limit=&offset=`

- `status`: `all` (default), `needs_review`, `changes_requested`, `approved`,
  `reference`.
- `task_id`, `project_id`: documents whose own `task_id` / `project_id`
  matches, or that have a receipt for that task / project. `kind`: exact
  match.
- `q`: substring of title, purpose or path, case-insensitive for ASCII (at
  most 200 characters; `%` and `_` are literal).
- `limit`: 1-200, default 100 (the legacy page size). `offset`: 0 or more.
- Ordering: newest first (`created_at DESC, id DESC`), stable across pages.
- A repeated parameter or an out-of-range value is `400 invalid_query`.

Response: `{ documents, total, limit, offset, has_more, status }`. `total`
counts every document matching the filters and status, computed in the same
read transaction as the page. Each document row is the legacy list row plus
`review_status`, `review_path` and the caller's own `review_state`.

`GET /api/documents/counts?task_id=&project_id=&kind=&q=` answers
`{ counts: { needs_review, changes_requested, approved, reference, all },
filters }` for the same filters. `counts[s]` always equals `total` from the
list with `status=s`, and `all` is the sum of the four statuses.

## 5. Reading one document

- `GET /api/documents/:id` adds `review_status`, `current_decision` (the
  latest decision plus `applies_to_current_revision`) and
  `links.review_path` to the legacy response.
- `GET /api/documents/:id/history` answers `{ document_id,
  current_revision_id, review_status, revisions, decisions, registrations,
  reviews }`: revision metadata, every decision, every receipt and every
  review round (with comment count and feedback delivery status), oldest
  history preserved.
- `GET /api/documents/:id/raw?revision=<revision_id>` serves the stored
  bytes of that revision with header `X-Document-Revision: <content_hash>`.
  For a declared deliverable these are exactly the registered file bytes
  (BOM and CR kept), so the body hashes to the header. Without `revision` it
  re-reads the file first.
- The `content` field of `GET /api/documents/:id` and of the revision route
  is the line-normalized text the reviewer renders and anchors comments to
  (no BOM, `\n` line endings). Use `raw_path`, not `content`, for exact
  bytes.

## 6. Decisions: Approve document and Request changes

`POST /api/documents/:id/decisions`

```json
{
  "decision": "approve | request_changes",
  "revision_id": "<the revision the operator read>",
  "content_hash": "<optional, must match that revision>",
  "note": "<optional, at most 20000 characters>",
  "client_decision_id": "<optional idempotency key, at most 120 characters>",
  "executor": {
    "id": "<executor identity, required when the block is present>",
    "task_id": "<optional Nexus task>", "execution_id": "<optional Praxis execution>",
    "source_submission_id": "<the review submission that carried Robert's instruction>",
    "source_review_id": "<or the review itself; one of the two is required>",
    "authorization_ref": "<optional standing authorization, for example the questionnaire id>"
  }
}
```

`executor` is optional and marks an executor-recorded approval (below); a
decision without it is a direct operator decision.

Authority (`server/services/document-decision-authority.js`). The
`local_user` stub every local request carries is not a credential, so a
decision needs one of the proofs Nexus trusts:

| `authority` recorded | Proof | Records |
|---|---|---|
| `access_user` | a verified Cloudflare Access login session for `NEXUS_OPERATOR_EMAIL` (tunnel browser, phone shell) | Robert's direct decisions, and the approve-after-changes grant on Finish review |
| `access_device` | the Windows travel shell's verified Access device session, pinned by `NEXUS_OPERATOR_DEVICE_IDS` | the same |
| `operator_credential` | `Authorization: Bearer <NEXUS_OPERATOR_APPROVAL_KEY>` from a trusted operator tool | the same; this key is also Robert's stakeholder approval authority (`docs/contracts/stakeholder-policy.md`) and no executor holds it |
| `document_executor_credential` | `Authorization: Bearer <NEXUS_DOCUMENT_APPROVAL_KEY>` from `scripts/record-document-approval.js` | an executor-recorded approval only (below): it needs the `executor` block citing a review Robert finished with the grant, it cannot decide directly or grant, and every stakeholder endpoint refuses it |

The session is checked first, whatever `Authorization` header the request
carries; a bearer is consulted only for a request with no verified session,
the operator key first and then the document key. Both fail closed: a key
shorter than 32 characters, or equal to another role's key, counts as
unconfigured for every role. The dashboard's shared fetch helper sends a
placeholder bearer with every call, and until 2026-10-04 the authority read
it as an operator-credential attempt before looking at the session, which
refused every browser decision (task a1cc8616). The document review client
now sends no `Authorization` header at all.

Refused: service users, `x-praxis-bridge-token`, `cf-access-client-id` /
`cf-access-client-secret` (service tokens), the stakeholder runtime key, a
wrong bearer, an unsigned local request, and any request with
`Sec-Fetch-Site: cross-site`. Dispatched executors and the QA reviewer reach
the API as `local_user` with no operator proof, so they cannot decide on
their own authority and cannot grant; since 2026-10-04 an executor may
record Robert's own "approve with changes" instruction with the document
executor credential, and only when Robert granted it (next paragraphs). The
Mac app on `localhost:3000` has no Access session: it can read and comment
but cannot decide (the same rule as the chat restart authority). Decisions
are made from the tunnel browser, the phone shell or the Windows travel
shell, or with the operator credential.

### Executor-recorded approvals (2026-10-04, task a2553798)

Robert's ruling in questionnaire `ask-robert-81299292-0878-4db1-a108-a14cc332f5dc`:
his recurring "Approve with changes" review should not need a second click.
The flow has two halves, and each is bound to its own credential.

Robert's half is the grant. He reviews a revision and finishes the review
with his instruction (for example "just make this one change and then mark
this document approved") and `approve_after_changes: true` on
`POST /api/documents/reviews/:reviewId/finish`, which the dashboard offers as
the "Approve once this change is made" checkbox on the same Finish review
click. The grant is Robert's own act, so that finish is authorized like a
decision: it is accepted only from his verified session or his operator
credential. An unsigned caller (the shared `local_user` every local process
carries), the document executor credential, the runtime key, bridge or
service-token headers and service users get `403 operator_required`, a
cross-site request `403 cross_site`, a non-boolean flag `400 invalid_grant`,
and the review stays a draft. A granting review records
`approval_delegated: true` and `submitted_authority` (`access_user`,
`access_device` or `operator_credential`); its submission payload carries
both and its chat message says "Approval delegated". A finish without the
flag is feedback exactly as before: `approval_delegated: false`, no proof
recorded, and it never authorizes an approval, whoever finished it.

The executor's half is the record. The executor of the follow-up task applies
the change, registers the resulting revision (section 1) and records the
approval of that exact revision with the document executor credential and an
`executor` block citing the submission. The supported way to do that is
`scripts/record-document-approval.js` (operations:
`docs/reviews/2026-10-04-executor-recorded-document-approvals.md`), which reads
`NEXUS_DOCUMENT_APPROVAL_KEY` from the fleet env file inside its own process
(it never reads the operator key), re-reads the current revision, fetches its
exact bytes from the raw route, checks their SHA-256 against the revision, the
file on disk and the hash the executor expects, posts the decision with a
deterministic `client_decision_id`, and prints the receipt, the consumer check
and the history. No credential is printed, logged or placed in a prompt.

The server binds an executor-recorded approval to Robert's grant
(`server/services/document-decision-provenance.js`):

- the `executor` block is accepted only with the document executor
  credential, and only for `approve`: on a session or operator-credential
  decision it is `invalid_provenance` (executor and bridge headers are refused
  before the block is read). The document executor credential without the
  block is refused too (`executor_provenance_required`), so on its own it
  records nothing, approves nothing and cannot request changes;
- the cited review must be a submitted review of an earlier revision of the
  same document that Robert finished with the approve-after-changes grant
  from his session or operator credential; anything else, including an
  unsigned review and a review of his finished without the flag, is
  `source_review_not_delegated`. Approving the reviewed revision itself is
  refused (nothing changed, so the reviewer decides directly), as is a
  revision older than it;
- nothing may have been decided or reviewed since the instruction: a later
  decision or a newer submitted review supersedes it, and an approval Robert
  already recorded on the resulting revision is answered `already_decided`
  with that decision;
- a review authorizes exactly one executor-recorded approval;
- the usual freshness rules apply unchanged: the revision must be the current
  one and `content_hash` must match it;
- the review's summary (the instruction), its comments and the grant
  (`delegation`: `approval_delegated`, the granting `authority`, `granted_at`)
  are snapshotted into the decision's `provenance`, with the executor's
  identity and run.

Direct operator decisions are unchanged: an operator-credential request
without an `executor` block, and every Access-session decision, records
`recorded_by: "operator"` with `provenance: null`. The server log lines name
the recorder (`recorded_by=executor <id>, source_review=<review id>`) and the
grant (`finished with approval delegated (authority=<authority>, submission=<id>)`),
never a credential. The document executor credential is editorial only: the
stakeholder decision and receipt endpoints ask for the operator or runtime
role and answer it `403`, so it cannot widen a document approval into a
product-scope approval.

The server re-reads the file before recording. It records only when the
requested revision is still the current one, then stores an append-only row
(a database trigger refuses updates):

```json
{
  "id": "...", "document_id": "...", "revision_id": "...", "content_hash": "...",
  "decision": "approve", "actor_id": "...", "authority": "access_user",
  "note": "", "client_decision_id": "...", "intended_action": "send",
  "created_at": "...",
  "recorded_by": "operator | executor",
  "provenance": null
}
```

For an executor-recorded approval `authority` is
`document_executor_credential`, `recorded_by` is `executor` and `provenance`
is:

```json
{
  "executor": { "id": "...", "task_id": "...", "execution_id": "..." },
  "source": {
    "review_id": "...", "submission_id": "...", "revision_id": "<the revision Robert reviewed>",
    "revision_hash": "...", "reviewer_id": "...", "submitted_at": "...",
    "instruction": "<the review summary, verbatim>",
    "comments": [{ "id": "...", "kind": "passage | document", "start_line": 3, "end_line": 6, "quote": "...", "body": "..." }],
    "delegation": { "approval_delegated": true, "authority": "access_user | access_device | operator_credential", "granted_at": "<the review's submitted_at>" }
  },
  "authorization_ref": "ask-robert-81299292-0878-4db1-a108-a14cc332f5dc"
}
```

`intended_action` is snapshotted from the document at decision time. Success
is `201 { decision, review_status, document }`.

| Status | `code` | Meaning |
|---|---|---|
| 404 | (none) | document not found |
| 403 | `cross_site` | cross-site browser request |
| 401 | `authentication_required` | no authenticated user |
| 403 | `operator_required` | not a trusted proof: no session and a bearer that is neither the operator key nor the document executor key (`reason` names what the session check found, for example `assertion-missing`) |
| 503 | `operator_credential_unconfigured` | no verified session, and the bearer that was sent cannot be checked because the operator key is not configured (`reason` as above) |
| 503 | `operator_check_unavailable` | the Access verifier could not run |
| 400 | `invalid_decision` | bad `decision`, missing `revision_id`, bad hash, note or key |
| 200 | (`duplicate: true`) | identical replay of a `client_decision_id`: the original decision |
| 409 | `idempotency_key_reused` | the key was used for a different decision (the original is returned) |
| 409 | `review_not_required` | a reference document takes no decisions |
| 404 | `revision_not_found` | the revision does not belong to this document |
| 409 | `content_mismatch` | `content_hash` does not match that revision |
| 409 | `file_unavailable` | the file cannot be confirmed now (`file_state` says why) |
| 409 | `stale_revision` | the document changed; `current_revision` is returned. Reopen and decide again |
| 403 | `executor_provenance_required` | the document executor credential without an `executor` block: it records only executor-recorded approvals, never a direct decision |
| 400 | `invalid_provenance` | malformed `executor` block, an unknown field, no source, or an `executor` block on a session or operator-credential decision |
| 400 | `executor_decision_not_allowed` | an `executor` block with `request_changes` |
| 404 | `source_review_not_found` | the cited review or submission is not on this document |
| 409 | `source_review_not_submitted` | the cited review is still a draft |
| 403 | `source_review_not_delegated` | the cited review was not finished with the approve-after-changes grant from Robert's session or operator credential (`approval_delegated` and `submitted_authority` are returned); it is feedback, not an authorization |
| 409 | `source_review_revision` | the revision to approve is the reviewed revision itself, or older (`source_revision_id` is returned) |
| 409 | `source_review_consumed` | an executor already recorded an approval on this review (`decision` is returned) |
| 409 | `already_decided` | the revision is already approved, for example by Robert himself (`decision` is returned; read it back) |
| 409 | `source_review_superseded` | a decision or a newer submitted review came after the cited review (`decision` or `review` is returned) |

Idempotent replays are answered after authorization and before freshness
checks, so a lost response on a good decision never turns into a conflict. A
replay compares the recorder too: the same `client_decision_id` sent with a
different executor identity or source, or without the `executor` block, is
`idempotency_key_reused`. The source checks run before the file is re-read
and again inside the insert transaction, so a decision or review landing in
between wins.

## 7. Consuming a decision: the stakeholder sender (c9658570)

The sender owns sending. This task does not implement it. A sender that wants
to send a document Robert approved does this, every time, immediately before
it sends:

1. Hold a specific decision id (handed over by the operator or the UI, or
   read from `history.decisions`). Never infer approval from
   `review_status` alone and never from comments, Finish review or task QA.
2. `GET /api/documents/:id/decisions/:decisionId`. The response is
   `{ decision, in_force, reason, approved, file_state, revision,
   current_revision, links: { review_path, raw_path } }`. Proceed only when
   `approved === true`. Otherwise stop and surface `reason`:
   `superseded` (a later decision exists), `document_changed` (the file now
   holds different bytes, even if only a BOM or line endings changed),
   `file_unavailable`, or `review_not_required`.
3. Require `decision.intended_action === "send"`. An approval recorded for
   `implement`, `publish` or `none` is not an approval to send.
4. Fetch `links.raw_path` (`/api/documents/<id>/raw?revision=<revision_id>`)
   as bytes and check that both `X-Document-Revision` and the SHA-256 of the
   body equal `decision.content_hash`. Read the body as bytes (for example
   `arrayBuffer()`); a text decoder can silently drop a BOM. Send exactly
   those bytes. Revisions are immutable, so these bytes cannot change after
   the check.
5. Apply the sender's own envelope approval as before
   (`docs/contracts/stakeholder-policy.md`): recipients, CC, subject and
   attachments are not covered by a document approval. Approve document is an
   editorial decision, not a send grant.
6. Record `document_id`, `decision.id` and `decision.content_hash` in the
   sender's own receipt so the outbound message is traceable to the approved
   revision.

## 8. Handoff notes for Praxis (e95e1af1)

- Register after the file is written, with `expected_content_hash` set to the
  SHA-256 of the exact bytes written (hash the buffer you wrote, not a
  normalized string), so a later overwrite cannot be registered under your
  declaration.
- A key carried into a task of another project keeps the document's original
  producer pair; the new task and project are recorded on the receipt and the
  document is listed under both.
- Use a stable `key` across retries and handoffs (section 2). For chat
  output, use `source: { type: "chat", conversation_id }` and omit
  `task_id`; the task that later picks the deliverable up registers the same
  key with its `task_id` and the document is reused.
- Show the operator `receipt.review_path` in-app and `receipt.review_url` in
  messages that leave the app. Treat `receipt.review_status` as the state at
  registration only.
- To learn the outcome, read `GET /api/documents/:id` (`review_status`,
  `current_decision`) or list with `task_id=<task>&status=...`. Feedback
  from Finish review still arrives as the existing chat turn.
- The Praxis runtime never records decisions; it has no operator proof and is
  refused, and `src/config.ts` strips `NEXUS_OPERATOR_APPROVAL_KEY` and
  `NEXUS_DOCUMENT_APPROVAL_KEY` from the environment it hands executors (like
  `PRAXIS_OPERATOR_KEY`). A dispatched executor records only Robert's own
  "approve with changes" instruction, and only when he finished that review
  with the approve-after-changes grant (the submission payload says
  `approval_delegated: true` and the chat message "Approval delegated"), on
  the revision that resulted from it, through
  `scripts/record-document-approval.js` (section 6) with the document-scoped
  executor credential; it never approves on its own judgement, a review
  without the grant is feedback to act on and report, and `request_changes`
  stays with the reviewer. The executor credential approves nothing else:
  stakeholder proposals still need Robert's operator credential.
- `intended_action` describes what happens after approval; the action itself
  stays with its owner (for `send`, the stakeholder sender, section 7).

## 9. Handoff notes for the Nexus UI (75de5032)

- Status tabs Needs review, Changes requested, Approved, Reference and All map
  to `status=needs_review|changes_requested|approved|reference|all`. Badge
  numbers come from `/api/documents/counts` with the same filters. Page with
  `limit` and `offset` and stop at `has_more: false`; more than 100 documents
  are reachable this way.
- Link with `review_path` (`/documents/<id>`) so the app stays in-session; use
  `review_url` only for content that leaves the app.
- `/documents/<id>` always opens on the current revision, also when the
  reader's latest review (`review.revision_id`) is of an earlier one. That
  reviewed revision (`review.pinned_content`) is shown only on an explicit
  switch, read-only for decisions; its comments keep their original lines and
  quotes, and a passage found elsewhere in the current revision is only
  labelled ("now at line N"), never re-anchored.
- Approve document and Request changes send the `revision_id` (and
  `content_hash`) of the revision on screen, plus a fresh
  `client_decision_id` per click. On `409 stale_revision`, reload and show the
  new revision; on `409 file_unavailable`, show the file problem; on
  `403 operator_required`, explain that decisions need the tunnel, phone or
  travel session (the Mac app cannot decide). There is no capability probe
  endpoint in v1; the 403 is the signal.
- Send no `Authorization` header with document requests from a browser
  session: the session is the proof, and a bearer turns a refusal into a
  credential problem (`operator_credential_unconfigured`).
- Keep an unrecorded decision note on the device as it is typed, with the
  document id, the revision it was written for and its `client_decision_id`;
  bring it back after a reload or sign-in round trip, say which revision it
  was written for whenever that is not the revision on screen, reuse the
  attempt id only for the same decision on the same revision, and clear it
  once a decision is recorded. A refusal message that recommends a reload
  must not cost the note.
- Keep Finish review and the decision buttons separate calls. Neither implies
  the other. The "Approve once this change is made" checkbox on Finish review
  sends `approve_after_changes: true` with the same finish call; it is not a
  decision either, it lets the executor record one approval of the corrected
  revision (section 6). It needs the session, so on `403 operator_required`
  explain that the grant, like a decision, needs the tunnel, phone or travel
  session, and keep the draft. Show `approval_delegated` on the finished
  review so the reader can see which rounds delegated.
- Show history from `/api/documents/:id/history`: revisions, decisions
  (with `authority`, `recorded_by` and, for an executor-recorded approval,
  `provenance` with the instruction and the grant it acted on), receipts and
  review rounds.

## 10. Legacy documents, migration and activation

- Migration is additive: four columns on `review_documents`
  (`deliverable_key`, `purpose`, `requires_review` default 0,
  `intended_action` default `none`) and three new append-only tables
  (`review_document_decisions`, `review_document_registrations`, and
  `review_document_revision_exact`, which keeps a declared revision's exact
  text when it has a BOM or CR line endings). Existing documents, revisions,
  review rounds, comments and feedback submissions are not rewritten, and
  queued feedback still delivers.
- Every legacy document is a `reference` until it is declared. A `metadata`
  value such as `requires_review: true` on a legacy row is not trusted as a
  declaration. Promoting existing documents into review is a bounded backfill
  that belongs to the activation task (11a60e5c), which declares each one
  through section 1 (the legacy row is adopted by path and task).
- The running API serves the code it booted with. These routes become live
  when the API restarts, which belongs to the activation task, not to this
  one.
- `NEXUS_OPERATOR_APPROVAL_KEY` was not provisioned by the contract task;
  until 2026-10-04 the bearer path answered 503 and Access sessions were the
  only decision path. Task a2553798 provisioned it in the fleet env file
  `/Volumes/Projects/.fleet-env` (outside every repo, mode 600; template entry
  in `.fleet-env.example`), loaded by `server/utils/fleet-env.js` at boot, and
  in its QA repair round the same day provisioned the separate
  `NEXUS_DOCUMENT_APPROVAL_KEY` there too. A wrong bearer now answers
  `403 operator_required` instead of 503.
- Executor-recorded approvals (2026-10-04) add two columns to
  `review_document_decisions`: `recorded_by` (default `operator`) and
  `provenance` (JSON, null unless executor-recorded). Rows written before the
  columns existed read as direct operator decisions; the append-only trigger
  covers the new columns. The repair round adds two columns to
  `document_reviews`: `approval_delegated` (default 0) and
  `submitted_authority` (null). Reviews finished before the columns existed
  read as feedback and never authorize an executor-recorded approval
  (`source_review_not_delegated`); Robert decides on them directly.

## 11. Verification

- `npx jest server/__tests__/document-deliverables.test.js
  server/__tests__/document-reviews-migration.test.js` covers the refusal
  matrix, receipts, identity and handoffs, the decision authority matrix,
  stale and replayed decisions, the consumer check, the no-approval rule for
  comments, Finish review and QA, the 130-document status and pagination
  consistency check, exact-byte receipts, revisions and decisions for CRLF
  and BOM files (with legacy documents keeping normalized identity), the
  cross-project producer rule, and migration of a frozen pre-change schema
  (including the 2026-10-02 decisions table gaining `recorded_by` and
  `provenance`).
- `npx jest server/__tests__/document-executor-approvals.test.js` covers
  executor-recorded approvals: the delegated approval with its provenance
  and grant snapshot, the grant itself (an unsigned review and a signed review
  without the flag are refused as sources; an unsigned caller, the document
  executor credential, the runtime key, bridge, service-token, service-user
  and cross-site requests cannot grant and the draft survives; the session,
  the device session and the operator credential can), the refusal matrix
  (no, wrong and unconfigured credential, the operator credential or a session
  carrying the block, the document credential without a block, bridge and
  service-token headers, malformed blocks, unknown and unfinished reviews,
  equal keys), the document-scoped credential (stakeholder decisions and
  receipts refuse it while the operator credential still approves a
  `scope_change`; it cannot decide directly or grant), lineage and drift
  (reviewed revision, content mismatch, stale revision, new bytes after
  approval), supersession by Robert's later decision or newer review and
  `already_decided`, unchanged direct operator and session decisions, and
  `scripts/record-document-approval.js` end to end (records with the document
  key, replays, refuses without it, refuses the operator key handed to it,
  stops on drift, never prints a credential). In Praxis,
  `npm test -- executor_forbidden_env` proves both keys are scrubbed from the
  environment executors inherit. In the dashboard,
  `document-review.test.mjs` covers the "Approve once this change is made"
  checkbox: the finish body carries `approve_after_changes: true` only when
  it is ticked, and the delegated badge appears on the finished round.
- The existing document suites (`documents-route`, `document-registry`,
  `document-review-format`, `document-review-delivery`,
  `document-review-receiver` under `server/__tests__/`) still pass unchanged.
