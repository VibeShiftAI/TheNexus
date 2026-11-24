# Nexus read-stall repair

Goal: keep the phone dashboard and API health responsive during full board reads.

Evidence: live full board request took 18.059 seconds, returned 30,128,025 bytes,
and caused two consecutive five-second health timeouts. V8 attributed 10.889s
to the full-board SQLite read and 3.951s to the stats artifact read.

Implementation and acceptance:
- [x] Reproduce event-loop starvation with a fixture database; preserve full task
  detail, dependency truth across archived projects, and authoritative admissions.
- [x] Move full-board query, deserialization, receipt overlay and summaries into
  a single read-only worker snapshot. Coalesce concurrent identical reads; bound
  queue and timeout; release idle workers; fail requests on read errors.
- [x] Compute status counts with SQL aggregation; fetch review artifacts only for
  eligible tasks, preserving existing terminal aliases and archived/orphan behavior.
- [x] Run focused board, knowledge, admission, intake and route contract suites.
- [x] Independent code review; merge only this repair; restart the supervised API.
- [x] Exercise real full-board/statistics routes with concurrent health probes;
  the six-minute run exceeded the first deployment's time to recurring failures.
- [x] Verify the desktop dashboard loads and remains connected.
- [ ] Confirm on the physical phone (not available to this session; user asked
  to reopen the app, response pending).

No records are removed or rewritten. Existing full-board response fields and
provenance guarding remain intact. The worker opens SQLite read-only and never
loads the initialization/migration module. Rollback is the task-scoped commit.

Implementation commits: `36a91fa8`, `bef7513b` and `2df4452d`. The second commit moves
provenance guarding, JSON serialization and optional gzip encoding into the
reader worker, transferring owned bytes instead of a large object graph.

Verification so far:
- Final focused suite: 14 suites passed; 355 tests passed, one skipped.
- Independent review: no blocking findings; exercised gzip/plain/compat variants,
  coalescing, provenance and Unicode, including transfer buffer ownership.
- Read-only production-data candidate: gzip 7,815,951 bytes in 2.026s; identity
  29,810,922 bytes in 0.597s. Thirteen concurrent health probes, maximum 13.4ms,
  no failures. This isolated harness is not the loaded production server.
- The first live deployment still stalled under severe host pressure; it was
  not accepted as a completed repair. The delayed profiler result identified
  70.410s in project-pulse `boardRollups` / SQLite `all`. Its global dispatch
  recency query scanned the task-prefixed index and sorted the full history.
  Added an index on `task_dispatches(started_at DESC)` in the existing migration
  path, serving both pulse and recent activity without the full-history sort.
  The regression inspects SQL actually prepared by both routers. It failed
  before the index and passed after; all 37 dispatch/activity tests passed.
- Unloaded only the resident Gemma chat model through LM Studio. It held about
  32GiB; memory availability rose from 11% to 83%. Embeddings remained loaded.
  This was an immediate recovery action, not a permanent change to model routing.
- Supervised API restarted with the second commit; desktop dashboard then showed
  LIVE, current task/project data, and the saved Praxis chat model gpt-6.2-astra.
  Physical phone verification remains pending the user's response.
- Six-minute live check after worker encoding and memory recovery: 344 checks,
  no errors, unchanged API PID. Eight gzip full-board reads completed in
  1.744–8.713s; maximum health latency 3.547s. This preceded the recency-index
  activation; final index activation checks are recorded below.
- Index activated by a supervised API-only restart. The production query plan
  now uses `idx_task_dispatches_started`, with no temporary sort. Independent
  review found no blocker.
- Final 150-second live run: 156 successful checks, no errors, unchanged PID
  92252. Five full-board loads took 0.396–1.103s. Five project-pulse reads
  completed (four cached reads at 5–19ms; one fresh build at 11.167s, including
  asynchronous git work). Maximum concurrent health latency was 1.878s, below
  the five-second supervisor deadline. Dashboard/proxied health returned 200.
- Astra chat configuration was re-read after both API restarts: backend `codex`,
  model `gpt-6.2-astra`, thinking `high`. No chat was sent as a test.
- Temporary Node inspector was closed; no listener remained on port 9229.

Remaining scope: the physical phone/Cloudflare Access session has not been
directly verified. Unloading Gemma was temporary; its normal overnight routing
may load it again. Other synchronous endpoints still exist, so the observations
above are evidence of this repair, not a guarantee against future host overload.
