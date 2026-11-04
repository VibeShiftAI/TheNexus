# Executor document suggestions and direct feedback retrieval

> Use superpowers:subagent-driven-development to implement and review bounded components. Approved spec: ../specs/2026-11-01-executor-document-suggestions.md.

Goal: executor review comments and individual suggestions with human decisions, plus identifier-only feedback notification instead of chat relay.
Architecture: Nexus retains immutable reviews, structured suggestions and decisions; Praxis receives durable events and fetches exact document/review packages. Executors use assigned review tools. React editor is isolated from document parsing.
Tech stack: existing Express/SQLite Nexus, React/Next dashboard, TypeScript Praxis runtime.

## Shared API contract

Nexus agent review routes live under `/api/documents/:id/agent-reviews`.
- POST creates assignment `{task_id, base_revision_id, instructions?, client_request_id}`; returns `{review, submission_token}`. Token is a bounded review capability, only creation/retry returns it to the assigning runtime, never public listing.
- GET lists `{reviews}` with comments, suggestions, saved choices and lifecycle.
- GET `/:reviewId` reads exact assigned document snapshot, review and findings. Submission token authorizes executor reads; existing operator/session access authorizes human reads.
- POST `/:reviewId/submit` with capability submits `{client_submission_id, summary, comments:[{id,body,start?,end?,original?}], suggestions:[{id,start,end,original,proposed,explanation}]}`. Offsets are UTF-16 character offsets in immutable source. Comments with omitted ranges are whole-document. IDs stable per review. Returns receipt. No direct source mutation.
- PATCH `/:reviewId/choices` operator-only persists `{choices:[{suggestion_id,status:'accepted'|'rejected'|'pending',replacement?}]}`; preserves entered replacement text including empty deletion.
- POST `/:reviewId/apply` operator-only `{client_apply_id}` applies saved accepted choices against current exact base snapshot and returns `{review,revision}`. Overlap/staleness fail closed and preserve drafts. Partial-application warnings; no publication/approval authority.
- POST `/:reviewId/comments` permits operator replies/resolution with attribution.
Nexus human feedback package: GET `/api/documents/:id/submissions/:submissionId/package` returns `{submission_id,document_id,revision_id,document,revision:{id,content_hash,content},feedback:<saved payload>,decisions:<exact revision decisions as of submission>,current_revision_id}`. Existing source revision is returned, never current file substituted.
Praxis receives POST `/api/document-review-notifications` event `{type:'document.review_submitted',schema_version:1,event_id,document_id,revision_id,submission_id}` and returns a durable receipt. No content in event and no chat persistence. Reader tools retrieve canonical packages and assigned reviews.

## Work packages

- [x] Nexus backend: failing route/store tests; new focused store/routes/services; assignment capabilities and provenance; immutable submission validation; operator draft decisions; guarded application and idempotency; package read; tests including stale/overlap/auth/retry. Preserve existing human-review changes.
- [x] Dashboard: failing component tests; API client and suggestion panel; attributed original/proposed/comments; accept/reject/edit choices; preview/apply; recovery and stale failure; integrate existing review page. Fix Markdown rerenders on composer keystrokes while preserving draft recovery. Verify focused tests/typecheck.
- [x] Praxis: failing notification/tool tests; durable receipt/retrieval worker; idempotent existing revision lifecycle integration with holds/read-only/ambiguity; reference-based executor task prompt; document review assignment/read/submit tool and policy registration; startup recovery and shutdown wiring. Verify focused tests/typecheck.
- [x] Nexus outbox: tests assert no chat writes and identifier-only event; retain retry/inflight/status machinery, historical delivered entries and pending migration; endpoint uses canonical package. Verify delivery tests.
- [x] Integration: independent spec/code review; exact source snapshot to executor findings to operator choices to new registered revision; notification-to-canonical-package-to-single-revision-task; no chats generated. Run appropriate existing suites. Restart only affected services after checks; check health. Report actual coverage and any limits.

## Execution constraints

Reuse active checkouts and preserve unrelated work. Each worker owns its files and does not revert others. No live review submissions/test tasks or outbound messages. Test with isolated databases/files. Keep review suggestions metadata separate from human feedback rounds. Record completion evidence in this plan.

## Completion evidence — November 1, 2026

- Nexus: 12 document suites, 180 tests passed.
- Praxis: 99 notification, review, revision, bridge, routing and finalization tests passed; TypeScript check passed.
- Dashboard: final focused run 35 tests passed, including unchanged Markdown parse count and final-keystroke persistence. Isolated production build and typecheck passed during implementation. Browser fixture verified edit/accept/reject/apply controls.
- Cross-service integration passed with real isolated stores/routes and stubbed dispatch: identifier-only delivery, canonical package capability enforcement, one revision task, executor read/submission completion gate, choices and idempotent apply; zero chat rows. Evidence: `/Volumes/Projects/outputs/document-review-2026-11-01/integration-evidence.json`.
- Activated through the documented Praxis LaunchAgent restart. Read-only smoke checks: Nexus health running, dashboard HTTP 200, both new route families registered and returning the expected unknown-record response. No live test documents, reviews or tasks created.
