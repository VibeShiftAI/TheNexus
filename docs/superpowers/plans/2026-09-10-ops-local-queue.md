# Ops local model queue

Goal: show the actual local model request queue, including requests from Cortex and other callers, and every pending Praxis background job.

The existing dispatch snapshot limits jobs to twenty and does not observe direct requests. Its log-mtime heuristic is affected by model-list probes. Use the installed LM Studio `lms ps --json` read-only telemetry (`status`, `queued`, model identity), and the existing `/local-llm/queue?active=1` for all persisted jobs. Keep model requests and background jobs in separate groups because a running background job may own a model request. Never sum them or invent per-request task names. LM Studio does not expose individual request titles or exact running counts in this feed.

Work in the current shared checkout with targeted additive edits, preserving the existing Ops autonomy controls and unrelated changes. Only the Nexus API child needs a restart; the dashboard hot reloads. Do not interrupt Praxis or Cortex's running work.

Acceptance criteria:
1. Direct model requests appear when the persisted job queue is empty; model queue counts come from LM Studio rather than log activity or configured concurrency.
2. All pending jobs appear, sorted by eligibility then the worker's priority/time ordering, with meaningful titles, running/waiting/scheduled labels and worker controls.
3. Missing telemetry is visibly unavailable, never represented as an empty queue; refreshing updates the queue without clearing good data or allowing stale responses to win.

- [x] Add server regression tests for native telemetry, missing/unsupported stats, independent upstream failures, and all jobs beyond twenty.
- [x] Implement a cached/coalesced read-only snapshot behind `/api/local-queue/work`, preserving existing management endpoints.
- [x] Add component regression tests for direct traffic, full job ordering, refresh/error states and worker control failures.
- [x] Implement the Ops queue panel using the new snapshot, refreshing every five seconds and on manual refresh.
- [x] Run server/component tests, isolated dashboard production build, and live UI verification. Review the task-scoped diff.

Verification: 7 server tests and 8 dashboard tests passed; isolated production build passed. Live `/api/local-queue/work` and browser `/ops` both showed Gemma generating with zero waiting requests and an empty background job queue. Manual refresh advanced the snapshot. Code review identified an unbounded worker action; fixed with an 8-second deadline and reviewed again successfully. Evidence logs and pre-change snapshots are in `/Volumes/Projects/reviews/ops-local-queue-2026-09-10/`.

Follow-up diagnosis: the morning knowledge council's evidence extraction submits one source at a time and bypasses the persisted background job queue. The 235-source batch started at 05:40 EDT, so a native waiting count of zero concealed substantial upstream work. Requests advanced at roughly 22 tokens/second and completed about every one to two minutes, with distinct source identities and no repeated invocations in the observed batch.

- [x] Add a read-only batch observer joining the morning recovery record, report fingerprint, and sealed source checkpoints. Never start/retry extraction.
- [x] Show current source, complete/partial/failed counts, remaining work and an expandable full waiting list; mark stale durable records unconfirmed and unavailable data explicitly.
- [x] Cover resumed complete-cache reuse across source order/report changes, invalid cached claims, published ledger reuse, active retries and corrupt/stale progress.
- [x] Verify 17 server tests, 10 dashboard tests, isolated production build and code review. Restore only the build-added tsconfig includes; baseline matches.
- [x] Restart only the supervised Nexus API child and verify the live API and expanded Ops panel. At 07:07 EDT it showed source 55 processing, 54 attempted (44 complete, 7 partial, 3 failed), and all 180 waiting sources through #235. Praxis/Cortex/LM Studio continued uninterrupted.

Coverage boundary: native counts cover submitted requests from all callers. LM Studio exposes no individual request titles in this feed; the UI labels that limit explicitly. Persisted Praxis jobs cover waiting and scheduled background work, and the morning evidence batch now exposes its upstream backlog from durable checkpoints. Other callers' unsubmitted internal work is not inferred from prompts or logs. This observer mirrors the current Praxis evidence format and marks mismatched report/checkpoint data unavailable.
