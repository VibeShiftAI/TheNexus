# Executor document review with individual suggestions

## Requested outcome

Praxis can assign an executor to review an existing document. The executor leaves attributed comments and individual suggested changes in the existing Nexus document viewer. Robert can accept, reject, or edit each suggestion. Robert selected individual suggested edits with comments rather than a complete rewritten draft. He also requires feedback delivery by notification and direct retrieval: comments and document content stay in the document system rather than being copied into the standing chat.

## User flow

1. Robert asks Praxis to have a document reviewed, with optional focus or reviewer preferences. Praxis creates a review task linked to the document and an immutable starting revision. The executor receives the review instructions and stable document/review references, plus tools for reading the assigned revision and submitting review findings.
2. The executor reads the assigned revision and submits a review containing passage comments, whole-document observations, and proposed insertions, replacements, or deletions. Each suggestion includes an explanation. Submission produces a durable receipt; retries do not duplicate comments or suggestions.
3. The document appears in Robert's existing review queue with a label indicating suggested edits are ready. Executor findings are distinguished from Robert's own comments and show the originating task and executor.
4. For each suggestion, Robert sees original text, proposed text, explanation, and Accept, Reject, or Edit & accept. Editing opens the proposed text, not a separate rewrite task. Plain comments support replies and resolution.
5. Robert's choices are saved as a draft while he reviews. A preview shows the combined result. Apply accepted changes creates one new document revision from accepted suggestions and edited replacements; rejected suggestions do not change the text. Pending suggestions remain visible and prevent the review from being represented as fully decided.
6. Review decisions and author attribution remain inspectable after application. Applying suggestions is an editorial change, distinct from approving the resulting document for publication or sending.

## Approach

Extend the existing document registry and viewer with structured suggestions and executor attribution. Reuse immutable revisions, review anchors, the review queue, and the guarded file-edit machinery.

Alternatives considered:

- General comments followed by a rewrite task: simpler, but does not support accepting individual changes directly.
- A complete revised file with an inferred diff: useful for broad rewrites, but breaks the direct association between each suggestion and its explanation. Not the workflow Robert selected.

## Scope

Initial editable suggestion support covers Markdown and plain-text documents, including the Anthropic outline. Other registered document types can receive attributed comments through their existing supported anchors; binary media is not rewritten by a text suggestion. Unsupported suggestion types must be reported explicitly.

The existing human comment submission and Request changes controls remain supported. Their transport changes from chat relay to a durable notification with direct retrieval. Executor reviews are separate review rounds on the same registered document, not human feedback that is relayed back to Praxis as if Robert wrote it.

## Stored records and attribution

An executor review records document ID, base revision ID and hash, task ID, execution identity, instructions, timestamps, status, and stable client submission ID. Server validation checks that the task and document belong to the expected project and that the submission is tied to the assigned review.

Comments identify their author and may anchor to a passage or whole document. Suggestions additionally store an exact original range, original text, proposed text, explanation, and stable suggestion ID. Insertions use explicit zero-width ranges. Ranges are defined against the immutable base content, not rendered Markdown.

Robert's draft choices and final decisions record actor, accepted/rejected status, any edited replacement, and resulting revision ID. Executor submissions cannot make operator decisions. Read endpoints expose provenance needed by the viewer rather than labeling every author Robert.

## Applying selected suggestions

The server validates exact base content, range bounds, original-text matches, and the caller's existing operator authority. It rejects overlapping selected edits with an actionable conflict response; it never silently chooses between alternatives. Nonoverlapping changes are composed against the base snapshot and applied together.

If the source file or registered current revision has changed, application stops with a stale-version message while retaining Robert's choices and typed replacements. It does not guess at relocated passages. The user can request a fresh review of the new revision.

Use the existing guarded document-edit path for source writes and revision registration. The application record must retain a recoverable, idempotent association between the decisions and the resulting revision, including recovery after a file write or registration failure. Repeating an apply request must not apply edits twice.

A partial application leaves remaining suggestions bound to their original revision and visibly historical. They cannot be applied to a newer revision without an explicit fresh review. The UI explains this before applying while choices remain pending.

## Feedback delivery: notify, then retrieve

### Evidence from the current implementation

`server/services/document-review-delivery.js` currently writes the full formatted feedback into `chat_messages` as a user turn, relays it through Praxis `/api/chat`, and stores the reply as the delivery receipt. Praxis `src/documents/review-intake.ts` parses headings and text from that message. `src/documents/revisions.ts` copies that parsed feedback into the executor task prompt. This creates unnecessary copies and makes correct handoff depend on chat formatting.

Replace this chain with a document-review event and structured retrieval. Do not merely shorten the chat message while keeping chat as the review transport.

### Canonical review package

Nexus retains a submitted review snapshot with document ID, exact revision ID/hash, review and submission IDs, actor provenance, summary, passage/whole-document comments and replies, Request changes decision notes, and any suggested edits or review decisions associated with that submission. No feedback field is inferred from a chat transcript. Submission is the boundary: later draft changes or decisions belong to another event/snapshot, not a mutation of an already acknowledged package.

Expose an authenticated read operation for the package and a separate read operation for the exact registered document revision. Readers may retrieve the original immutable snapshot even when a newer version exists, but must also see current-version and review-lifecycle status. The raw source file is not substituted for a different version of the document that was reviewed.

### Notification and receipt

Finishing a review persists the package and outbox event atomically. The event carries only stable identifiers, event type, and schema version, for example:

```json
{
  "type": "document.review_submitted",
  "schema_version": 1,
  "event_id": "stable-outbox-event-id",
  "document_id": "registered-document-id",
  "revision_id": "reviewed-revision-id",
  "submission_id": "immutable-submission-id"
}
```

The outbox posts this event to a dedicated Praxis document-review notification endpoint, not `/api/chat`. Praxis persists receipt before acknowledging it, then reads the package and exact document revision through authenticated Nexus APIs. Event IDs deduplicate resends; restarted workers resume from durable processing state. Fetch failures remain pending with retry status. Receiving an event does not mean the review was read, revision work was dispatched, or a document was approved.

The event never grants additional authority. Praxis reads the recorded operator decision, delegated permission, and explicit holds/read-only requests from the canonical package before deciding what work is authorized. Mere comments, questions, praise, and approvals without requested edits must not automatically become revision tasks. Ambiguous feedback remains available for Praxis to inspect and ask about without fabricating a request to edit.

### Direct access by Praxis and the executor

Praxis uses document-review read tools to inspect the document and feedback when notified. Revision/review tasks carry the exact document and submission references plus the work objective. The executor retrieves the same package and revision directly through its permitted tool surface before making edits or proposing suggestions. Task instructions must not embed a second full copy of all comments or rely on recovering them from recent chat.

For implementation and QA, preserve a receipt showing which package and revision were read. This makes a missing or failed retrieval distinguishable from an executor that read the feedback but did not satisfy it. Status tracks notification received, feedback retrieved, work linked/dispatched where applicable, and result ready.

### User-visible behavior and migration

The review surface shows Saved, Praxis notified, and the actual work state separately. Recent Activity may show concise document-linked status. The standing chat does not receive automatic walls of comments or synthetic messages in Robert's voice; a direct question from Robert can still receive a normal concise answer linking the document.

Already delivered historical chat reviews remain history and are not replayed. Pending old-format outbox entries are processed by the new reference-based path using their saved payload and stable submission IDs. Existing linked revision tasks and request IDs must be adopted to avoid duplicate work. Keep compatibility for already-running older tasks long enough for them to finish, without creating new chat-based deliveries.

## Praxis integration

Add an explicit document review task mode, distinguishable from a revision task that directly edits a file. Its completion criteria require a registered review receipt containing comments/suggestions, or an explicit no-changes assessment.

Provide executor tools for reading the assigned snapshot and submitting attributed findings. Tool access is limited to the assigned review and its permitted submission operations. Existing bridge policy and server identity checks determine authority; caller-supplied author labels are insufficient.

Praxis reports that a review is ready only after the server confirms the submission. A completed review task means the executor's review was delivered, not that Robert accepted its suggestions. Human decisions remain a separate state.

## Rendering and draft preservation

Keep editor state separate from the document renderer so typing a comment or edited replacement does not reparse the whole document. Memoize stable rendered content and comment anchors. Draft persistence should batch writes with a final flush on navigation/page hiding, and retain the existing refresh recovery guarantees. Cover the typing slowdown identified in this conversation where this review UI is changed.

## Verification criteria

- An assigned executor submits a passage comment, whole-document comment, and multiple suggestions; Robert sees the correct author, task, exact passage and proposed text.
- Accept one suggestion, reject another, and edit a third; the resulting source and registered revision contain exactly the chosen text. Draft choices survive refresh.
- Retry submission and application without duplicate records or repeated edits.
- Stale documents, overlapping selected changes and mismatched task/document bindings are refused without losing review input or corrupting source.
- Executor credentials cannot accept, reject, apply or approve on Robert's behalf.
- Finishing a human review emits an identifier-only notification and writes no feedback body or synthetic user turn to chat; Praxis fetches the exact package and document through the new read path.
- Summary, passage comments, replies, Request changes notes, and relevant suggestion decisions all survive direct retrieval; no field depends on Markdown heading parsing.
- Repeated notifications, an acknowledgement lost after receipt, a restart before retrieval, and a transient fetch failure converge on one processing record and at most one revision task.
- Holds, read-only feedback, questions and approvals retain their existing semantics; event receipt alone cannot authorize edits.
- Pending legacy submissions and already-linked requests migrate without losing feedback or creating duplicate tasks.
- Existing human review, Request changes notes, document approval and outgoing-delivery tests continue to pass.
- Typing in a long-document review does not reparse unchanged document Markdown on each keystroke; verify render isolation with a regression test and browser inspection.
- Exercise the complete workflow using an isolated document and task before making it available in the running services.

## Implementation boundaries

Nexus owns review storage, operator decisions, document mutation and UI. Praxis owns task creation, executor instructions, tool access, and delivery announcements. Implement in focused modules rather than expanding the already large document routes and viewer component with all suggestion logic inline.
