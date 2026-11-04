# Executor reviews and direct feedback delivery

Implemented November 1, 2026. Extends the existing document registry; document approval and publishing authority remain separate.

## Operator workflow

Ask Praxis to have an executor review a registered document. Praxis creates a review-only task tied to its exact revision. The executor reads the assigned snapshot and submits attributed comments and suggested insertions/replacements/deletions. Source files remain unchanged until the operator applies accepted suggestions.

Executor findings appear in the document's existing inline comment surface, beside human passage comments. Each suggested change offers Accept, Reject and Edit & accept on its comment card. Choices persist; the combined preview shows only accepted changes. Apply accepted changes saves one new immutable snapshot within the same editorial draft. Finish suggestions review closes a comments-only or all-rejected review without a file mutation. Applying a partial selection leaves unresolved suggestions bound to the historical version; request a fresh review to work against a newer revision.

Cards follow document order and use one action row. Suggested edits expose Accept, Edit & accept, Reject and Reply; saved decisions offer Undo until application. Resolve applies only to discussion comments as a secondary action. A comment without replacement text offers Turn into suggested edit: Praxis reads the saved comment and exact document snapshot and drafts a pending proposal. The operator can accept, reject or edit that wording before application. For a document-wide comment Praxis must identify one exact, unambiguous passage. The original comment and its author remain intact, and the proposal appears on the same card attributed to Praxis. Generation does not accept or apply changes. Selecting a suggestion card scrolls to and highlights its affected source passage; action buttons and text editing remain independent of card selection.

If the file changes, or selected suggestions overlap, application refuses with an explanation and keeps the choices. Retrying a lost application response reuses the recorded application ID. Replies and resolutions retain author attribution.

## API

Routes under `/api/documents/:id/agent-reviews`:

| Operation | Request |
| --- | --- |
| Assign | POST `{task_id,base_revision_id,client_request_id,instructions?}` |
| List | GET |
| Read immutable assignment | GET `/:reviewId` |
| Submit findings | POST `/:reviewId/submit` `{client_submission_id,summary,comments,suggestions}` |
| Save choices | PATCH `/:reviewId/choices` `{choices:[{suggestion_id,status,replacement?}]}` |
| Reply/resolve | POST `/:reviewId/comments` `{comment_id,body?,resolved?,client_id?}` |
| Apply/finish | POST `/:reviewId/apply` `{client_apply_id}` |

Assignment requires runtime or operator authority. It returns a scoped `submission_token`; executor reads/submission use `x-document-review-token`. Invalid explicit capabilities fail closed. Human choices, replies and application require operator authority, not executor credentials. Finding author identity comes from the assigned task, not submission text.

Suggestion ranges are UTF-16 offsets into the immutable source, with exact `original` text and `proposed` replacement plus `explanation`. Markdown/plain-text suggestions are supported; other media receive comments only. Publication is not implicitly approved by accepting suggestions.

POST `/api/documents/reviews/:reviewId/comments/:commentId/suggestion` converts an executor comment into a separately attributed operator proposal. The body is `{client_request_id,proposed,status:'accepted'|'pending',start?,end?,original?,base_revision_id?}`. Passage comments retain their exact assigned range; document-wide comments require all three range fields. Empty proposed text means deletion. The stable request ID makes retries idempotent, and conflicting reuse fails. Conversion records a new canonical suggestion linked by `source_comment_id` without modifying the original comment, sealed executor receipt or source file. Original and operator suggestions share the reviewed base and apply together with the existing stale-source and overlap checks.

The default UI uses POST `/api/documents/reviews/:reviewId/comments/:commentId/proposal` with `{client_request_id}` instead. Nexus loads the immutable snapshot and original comment and invokes Praxis's raw completion service (`/v1/llm/chat/completions`, role `brain.chat`, `require_no_tools:true`), without posting chat messages. Generation jobs survive lost responses; one linked proposal per source comment prevents duplicate findings. A valid result is saved as pending with Praxis attribution, and malformed, ambiguous, truncated or stale results are refused. The explicit manual conversion API remains for retained operator drafts. Accepting or editing a generated proposal uses the existing choice API; Apply remains the only source-writing step.

## Human feedback transport

Finishing a human review seals its summary, comments/replies, Request changes notes and decision provenance. GET `/api/documents/:id/submissions/:submissionId/package` reads that package and the exact reviewed source revision. It never replaces the snapshot with the latest file. New text revisions preserve original line endings; legacy snapshots whose exact bytes cannot be reconstructed fail explicitly.

The durable outbox sends only identifiers to Praxis POST `/api/document-review-notifications`:

```json
{"type":"document.review_submitted","schema_version":1,"event_id":"docreview:SUBMISSION_ID","document_id":"DOCUMENT_ID","revision_id":"REVISION_ID","submission_id":"SUBMISSION_ID"}
```

A matching durable receipt means Praxis was notified. Praxis retrieves the saved package, respects decision authority and holds, and records or adopts tracked revision work. Task prompts carry package references and a capability scoped to the exact document, submission and revision instead of copied feedback. Praxis can inspect retained notifications with `document_review status` and retrieve packages with privileged `inspect`; executors use scoped `read`. Review task completion requires both a snapshot-read receipt and a matching canonical submission receipt. Notification outcomes requiring interpretation remain discoverable for Praxis; they are not fabricated into automatic edit authority.

New deliveries do not create chat messages. Existing delivered chat receipts remain historical; pending old outbox rows move through the new event path with the same submission identity. Retry and restart recovery do not duplicate reviews or tasks. Failed retrieval is distinct from receipt and work completion.

## Verification

Server suites: document-agent-reviews, document-review-delivery, document-review-receiver, document-reviews-migration, documents-route and existing document approval/replacement/media suites.

Dashboard suites: agent-reviews, document-review-drafts, document-markdown and review draft persistence. Existing typing now avoids reparsing unchanged Markdown; batched draft saves flush on navigation/page hiding/unmount.

Praxis suites: document_review_notifications, document_review_routes, document_review_tools and existing revision lifecycle/bridge policy tests. Integration checks use isolated databases, sources and stubbed execution; no test submissions enter live project history.

## Unified comments and draft versions — November 1 correction

Executor findings use `document_review_comments`, attributed to their assigned executor, with structured suggestion/provenance fields. A submitted executor round remains distinct from the human draft round so feedback authority is not mixed. The document reader returns `inline_comments`; the existing card list, passage markers, replies and resolution render those records. Assignment endpoints remain a compatibility transport for bounded executor access and immutable receipts; they no longer own a separate commenting surface. Saved findings are migrated transactionally and idempotently without applying suggestions.

Review versions are editorial drafts, not snapshot counts. Exact capture IDs/hashes remain unchanged for anchors and recovery. Draft grouping uses primary document version metadata and delivered replacement/handoff identity. `history.drafts` drives normal review history; raw captures remain in `history.revisions` with `capture_number` and are accessible in expanded snapshot history. Intermediate writes do not add review versions.
