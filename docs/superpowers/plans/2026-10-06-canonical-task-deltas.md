# Canonical task delta repair implementation plan

> Agentic execution: implement inline with TDD and review checkpoints. Existing repair task: `0caed491-b34e-498a-8a54-7ad4cff67b27`; no new task, live data writes, restart, redispatch, staging, or commit.

**Goal:** Record operator answers and workspace/ledger changes without persisting the guarded executor projection or overwriting unrelated concurrent edits.

**Architecture:** Narrow HTTP operations read and merge the canonical row inside the existing board lease and a SQLite transaction, then use the existing updateTask admission guard and version compare. Task responses remain guarded; source, prompt and commands are not replaced by delta operations. Existing operator/runtime origin classification and scope authorization remain authoritative.

**Tech stack:** Express, better-sqlite3/Jest, TypeScript/node:test.

- [x] Add failing isolated HTTP/temporary SQLite tests in `server/__tests__/task-canonical-deltas.test.js` for NULL/external source, commands/prompt/hash preservation, authenticated and unverified answer audit, idempotency, concurrent answers/scope edits, workspace merge, lease and CAS refusal, genuine drift and exact relayed authorization.
- [x] Implement focused `db/task-deltas.js`, transactional facade wrappers in `db/index.js`, and routes in `server/routes/tasks.js` for ruling append and workspace delta. Reject unknown fields; no arbitrary raw read endpoint.
- [x] Add failing Praxis regression tests for POST delta calls; retain formatting and boolean recordOperatorRuling interface, migrate existing mock seams, use narrow workspace writes.
- [x] Fix demonstrated dependency/name ledger refresh hazard with a narrow `payload_ledger` PATCH surface merged into canonical payload with version checking. Add client HTTP/body and DB preservation tests.
- [x] Run Nexus canonical, admission, provenance, and lease tests; Praxis ruling/delivery/contract/workspace/ledger tests and `npx tsc --noEmit`. Review attributable diff and `git diff --check`.

Approved scope extensions use the same delta surface: acceptance-criteria append,
exact operator scope relay, parked QA repair context create/clear, and improvement
evidence refresh. Peer review identified hidden-command deletion losing its
claim against GET; a failing HTTP wire regression now passes. The relay declares
only explicitly requested prompt/command keys and Nexus computes the canonical
diff. Canonical no-op and invalid-decision cases are covered too.

Verification on October 6 (isolated fixtures only):

- Nexus canonical/admission/answer/origin/CAS/lease/provenance sweep: 10 suites,
  320 passed and 1 skipped. Subsequent added canonical authorization regression:
  canonical suite 15/15 passed.
- Praxis answer/workspace/criteria/ledger/contract sweep: 122/122 passed. Adjacent
  workspace-transition/write-failure/task-update/schema suites: 40/40 passed.
- After final authorization changes, canonical wire/contract-authority/contract
  dispatch suites: 37/37 passed; TypeScript `npx tsc --noEmit` passed.
- The coordinated durable-suspension recovery seam adds optional
  `nexusSuspendTask.expectedVersion`, forwarded through the existing status
  PATCH. Its wire regression failed without the forwarding, then the canonical
  client suite passed 6/6 with the seam in place.
- Parked queue/evidence suites: 38/38 passed. Restart fixture explicitly
  re-registers the real dispatcher after its test reset, preserving reset rules.
- Expanded QA/parked/evidence run initially had 164/167 passed. The owned parked
  restart fixture is fixed and rerun above. Two unrelated QA fixtures remain:
  `a thrown improvement follow-up leaves the parent task complete` and
  `a none-offered improvement is recorded and never dispatched`. Their fake
  fetch returns a task at the board-lease endpoint, causing
  `WORK_ADMISSION_HELD: authoritative board lease unavailable`; left unchanged
  per parent instruction. No production lease behavior was relaxed.
- The separate nexus client funnel test reports pre-existing direct health
  fetches in `src/index.ts` and `src/ingestion/evidence-preparation.ts`, confirmed
  by the parent against baseline; this repair does not alter those paths.
- Node syntax checks and `git diff --check` passed.

Audited remaining payload mentions in the owned boundaries: creation payloads
create new tasks; local clones assemble a dispatch view or generated ledger
only. The generic explicit replacement client/tool remains supported and must
receive authored canonical data. It is still unsafe for callers to supply a GET
projection there; no heuristic unwrapping or full-replacement exception exists.

Shared pre-existing changes in `db/work-admission.js`, `docs/work-admission.md`
and Praxis `src/nexus/client.ts` remain preserved. No live task data, API writes,
restarts, redispatch, notifications, staging or commits occurred. The exact
historical canonical corruption requires separately reviewed data repair.
