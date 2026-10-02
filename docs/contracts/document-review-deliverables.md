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
  "client_decision_id": "<optional idempotency key, at most 120 characters>"
}
```

Authority (`server/services/document-decision-authority.js`). The
`local_user` stub every local request carries is not a credential, so a
decision needs one of the operator proofs Nexus already trusts:

| `authority` recorded | Proof |
|---|---|
| `access_user` | a verified Cloudflare Access login session for `NEXUS_OPERATOR_EMAIL` (tunnel browser, phone shell) |
| `access_device` | the Windows travel shell's verified Access device session, pinned by `NEXUS_OPERATOR_DEVICE_IDS` |
| `operator_credential` | `Authorization: Bearer <NEXUS_OPERATOR_APPROVAL_KEY>` from a trusted operator tool |

Refused: service users, `x-praxis-bridge-token`, `cf-access-client-id` /
`cf-access-client-secret` (service tokens), the stakeholder runtime key, a
wrong bearer, an unsigned local request, and any request with
`Sec-Fetch-Site: cross-site`. Dispatched executors and the QA reviewer reach
the API as `local_user` with no operator proof, so they cannot decide. The
Mac app on `localhost:3000` has no Access session either: it can read and
comment but cannot decide (the same rule as the chat restart authority).
Decisions are made from the tunnel browser, the phone shell or the Windows
travel shell, or with the operator credential once it is provisioned.

The server re-reads the file before recording. It records only when the
requested revision is still the current one, then stores an append-only row
(a database trigger refuses updates):

```json
{
  "id": "...", "document_id": "...", "revision_id": "...", "content_hash": "...",
  "decision": "approve", "actor_id": "...", "authority": "access_user",
  "note": "", "client_decision_id": "...", "intended_action": "send",
  "created_at": "..."
}
```

`intended_action` is snapshotted from the document at decision time. Success
is `201 { decision, review_status, document }`.

| Status | `code` | Meaning |
|---|---|---|
| 404 | (none) | document not found |
| 403 | `cross_site` | cross-site browser request |
| 401 | `authentication_required` | no authenticated user |
| 403 | `operator_required` | not an operator proof (Access refusals add `reason`) |
| 503 | `operator_credential_unconfigured` | a bearer was sent but the operator key is not configured |
| 503 | `operator_check_unavailable` | the Access verifier could not run |
| 400 | `invalid_decision` | bad `decision`, missing `revision_id`, bad hash, note or key |
| 200 | (`duplicate: true`) | identical replay of a `client_decision_id`: the original decision |
| 409 | `idempotency_key_reused` | the key was used for a different decision (the original is returned) |
| 409 | `review_not_required` | a reference document takes no decisions |
| 404 | `revision_not_found` | the revision does not belong to this document |
| 409 | `content_mismatch` | `content_hash` does not match that revision |
| 409 | `file_unavailable` | the file cannot be confirmed now (`file_state` says why) |
| 409 | `stale_revision` | the document changed; `current_revision` is returned. Reopen and decide again |

Idempotent replays are answered after authorization and before freshness
checks, so a lost response on a good decision never turns into a conflict.

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
- Never record decisions; Praxis has no operator proof and is refused.
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
- Approve document and Request changes send the `revision_id` (and
  `content_hash`) of the revision on screen, plus a fresh
  `client_decision_id` per click. On `409 stale_revision`, reload and show the
  new revision; on `409 file_unavailable`, show the file problem; on
  `403 operator_required`, explain that decisions need the tunnel, phone or
  travel session (the Mac app cannot decide). There is no capability probe
  endpoint in v1; the 403 is the signal.
- Keep Finish review and the decision buttons separate calls. Neither implies
  the other.
- Show history from `/api/documents/:id/history`: revisions, decisions
  (with `authority`), receipts and review rounds.

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
- `NEXUS_OPERATOR_APPROVAL_KEY` is not provisioned by this task; until it is,
  the bearer path answers 503 and Access sessions are the working decision
  path.

## 11. Verification

- `npx jest server/__tests__/document-deliverables.test.js
  server/__tests__/document-reviews-migration.test.js` covers the refusal
  matrix, receipts, identity and handoffs, the decision authority matrix,
  stale and replayed decisions, the consumer check, the no-approval rule for
  comments, Finish review and QA, the 130-document status and pagination
  consistency check, exact-byte receipts, revisions and decisions for CRLF
  and BOM files (with legacy documents keeping normalized identity), the
  cross-project producer rule, and migration of a frozen pre-change schema.
- The existing document suites (`documents-route`, `document-registry`,
  `document-review-format`, `document-review-delivery`,
  `document-review-receiver` under `server/__tests__/`) still pass unchanged.
