# Nexus read-stall repair

Goal: keep the phone dashboard and API health responsive during full board reads.

Evidence: live full board request took 18.059 seconds, returned 30,128,025 bytes,
and caused two consecutive five-second health timeouts. V8 attributed 10.889s
to the full-board SQLite read and 3.951s to the stats artifact read.

Implementation and acceptance:
- [x] Reproduce event-loop starvation with a fixture database; preserve full task
  detail, dependency truth across archived projects, and authoritative admissions.
- [ ] Move full-board query, deserialization, receipt overlay and summaries into
  a single read-only worker snapshot. Coalesce concurrent identical reads; bound
  queue and timeout; release idle workers; fail requests on read errors.
- [ ] Compute status counts with SQL aggregation; fetch review artifacts only for
  eligible tasks, preserving existing terminal aliases and archived/orphan behavior.
- [ ] Run focused board, knowledge, admission, intake and route contract suites.
- [ ] Independent code review; merge only this repair; restart the supervised API.
- [ ] Exercise the real full-board/statistics routes with concurrent health probes
  for longer than the previously observed restart interval. Verify phone dashboard.

No records are removed or rewritten. Existing full-board response fields and
provenance guarding remain intact. The worker opens SQLite read-only and never
loads the initialization/migration module. Rollback is the task-scoped commit.
