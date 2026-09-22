# Nexus board and workspace write leases

Nexus now reserves shared resources before an edit and checks ownership again
when persisting it. The lease records live in `write_leases` in `NEXUS_DB_PATH`
(the normal Nexus database). Every cooperating Nexus process must use the same
database. Acquisition, expiry takeover, renewal and release use SQLite immediate
transactions; ownership is a random per-acquisition bearer token.

## Resources and ownership

- `{"scope":"board"}` reserves task/project state. One board lease deliberately
  includes row edits, collection edits, reorder, archive and reserved stakeholder
  decisions, so those operations cannot bypass each other. It trades board write
  concurrency for a small, auditable boundary. Reads remain available.
- `{"scope":"workspace","path":"/absolute/workspace/or/file"}` reserves that
  path and descendants. Parent and child reservations conflict; unrelated paths
  can proceed. Existing ancestors and symlinks (including dangling links) resolve
  to their actual target. Case and Unicode aliases conservatively conflict even
  on filesystems where those names could be distinct.
- `owner` is a diagnostic label, not authentication. Only the returned token
  authorizes use, renewal or release. Status and conflict responses hide tokens.
- `ttl_ms` is an integer from 1000 to 300000, default 30000. Expired tokens never
  renew or silently reacquire. A stale owner cannot release a successor's lease.
  Release can remove its own expired record if nobody has replaced it yet.

## API protocol

Use the existing authenticated Nexus API seam. The local server's current
authentication model is unchanged; leases provide coordination, not access control.

1. `POST /api/write-leases` with resource, `owner` and optional `ttl_ms` returns
   `201 {"lease":{"token":"...","scope":"board","path":"",...}}`.
2. Read the task/project/file **after acquisition**, then calculate the edit.
3. Pass `X-Nexus-Board-Lease: <token>` on board mutations or
   `X-Nexus-Workspace-Lease: <token>` on workspace mutations. A request that edits
   both may carry both headers. Filesystem and command tools accept `lease_token`.
4. `PATCH /api/write-leases` with `{"token":"...","ttl_ms":30000}` renews.
5. `DELETE /api/write-leases` with `{"token":"..."}` releases in the caller's
   finally path. Neither renewal nor release changes board/task lifecycle state.

`GET /api/write-leases?scope=board` or
`GET /api/write-leases?scope=workspace&path=<URL-encoded-absolute-path>` reports
active overlapping leases without tokens. `409 write_lease_conflict` means an
active owner exists; `409 write_lease_lost` means the supplied/context token is
expired, released or covers another resource. `409 write_lease_busy` means a
fenced commit still holds SQLite's writer transaction. Reacquire and reread
before retrying. Do not reuse a stale request body blindly.

Existing clients may omit tokens. Nexus then acquires an operation lease before
running the route/tool, renews automatic async leases, and releases on completion
or failure. Explicit leases remain the caller's responsibility. The automatic
lease protects that operation; it does **not** reserve a prior client-side read.
Continue supplying `expected_version` on task PATCH and the existing project
revision/snapshot checks. Leases alone do not detect stale snapshots.

## Enforcement and limits

- The DB facade fences task/project CRUD, batch/reorder/archive, checkpoint/need
  edits, reserved stakeholder mutations and context projection writes. The task
  and project route factories hold ownership across their read/await/write flow.
- File HTTP/tool writes fence the actual synchronous mutation. File tool ownership
  spans critic review and read/modify/write. Context projection paths cannot
  escape their project through a context type or a symlink.
- Shell tools, the HTTP command endpoint and project git mutations reserve their
  declared workspace. Foreground commands run under SQLite's writer transaction.
  A private child runner enforces timeout and output limits, kills its process
  group, and waits for closure before the fence is released. Remaining group
  members are terminated on normal leader exit too; background jobs are not a
  supported use of these commands. The default timeout is 30 seconds; the HTTP
  command endpoint accepts up to 300 seconds.
- This synchronous command fence blocks other SQLite writers and the serving
  Node event loop for the command's duration. Use these endpoints for bounded
  operations. Long-running execution and supervision belong in Praxis.
- External CLI sessions, raw SQL connections, independent databases, hard-link
  aliases, commands writing outside their declared workspace and deliberately
  detached descendants must cooperate separately. This is not an OS sandbox.
  The runner checks for parent death every 100 ms and kills its group, but a
  parent crash can release SQLite's lock before that cleanup runs. It is not an
  atomic crash fence for subprocess writes. Worktree isolation remains useful.
- Praxis's existing `src/write-lease.ts` board/schedule client leases remain in
  place. They do not share tokens with this server-side store and need no change
  for automatic operation leases. Explicit read/edit sessions can adopt the API.

## Verification

Run `npx jest server/__tests__/write-leases.test.js server/__tests__/write-leases-routes.test.js server/__tests__/workspace-command.test.js --runInBand`.
The suites use temporary SQLite databases, HTTP servers on ephemeral ports and
temporary workspaces. They test owner/conflicting writes, alternate routes and
tools, version-check preservation, expiry/renewal, directory and symlink aliases,
context escape rejection, process-group termination, and a real second process
trying to take over during a command after the lease's nominal expiry.

## Task 402930f9 verification record

- `npx jest server/__tests__/write-leases.test.js server/__tests__/write-leases-routes.test.js server/__tests__/workspace-command.test.js --runInBand`: **3 suites, 42 tests passed**.
- `npm test -- --runInBand`: **103 suites passed, 3 failed; 1121 tests passed, 3 failed, 1124 total**. The failures are `studio-route.test.js` (enrichment remaining count), `praxis-stream.test.js` (event-ingest authentication expectation), and `openrouter-free-lane.test.js` (credential fallback expectation). The same three failures reproduced when running those suites on a temporary archive of baseline HEAD `02dceb5`, with the same dependencies/environment: **44 passed, 3 failed**. They are not introduced by this patch.
- `node --check server/server.js`, `node --check server/lib/workspace-command-runner.js` and `git diff --check`: exit 0.
- Strict UTF-8 decoding and a mojibake scan passed for every edited text file.
- The author's full diff review and an independent read-only review found and fixed command-tool bypass, subprocess timeout/descendant lifetime, context symlink/traversal escape, new case/dangling-symlink aliases, and disconnect-during-lookup leakage. The subprocess crash and blocking limits above remain deliberate and documented.

The attributable change comprises 18 files (the pre-existing `.env.example`
change is excluded). No additional repository was edited; all changes remain
uncommitted in `/Volumes/Projects/TheNexus` for Praxis QA. No task lifecycle state
was changed and no live service restart was performed.

| Files | Purpose |
| --- | --- |
| `db/write-leases.js`, `db/context-path.js`, `db/index.js` | Durable leases, canonical context paths, facade mutation fencing |
| `server/lib/write-leases.js`, `server/lib/workspace-command-runner.js` | Request ownership, command fencing and foreground process cleanup |
| `server/routes/write-leases.js`, `server/server.js` | Lease API and mount |
| `server/routes/tasks.js`, `server/routes/projects.js`, `server/routes/tools.js` | Board/workspace route enforcement and JSON conflicts; reorder route precedence |
| `server/tools/filesystem.js`, `server/tools/command.js`, `server/services/context-sync.js` | Tool and indirect workspace-write enforcement |
| `server/__tests__/write-leases.test.js`, `server/__tests__/write-leases-routes.test.js`, `server/__tests__/workspace-command.test.js` | 42 ownership, HTTP, persistence and real-process regression tests |
| `docs/write-leases.md`, `docs/superpowers/plans/2026-09-21-write-leases.md` | Protocol, limitations, reconciliation, plan and verification evidence |

## Optional post-pass review

Robert requested an optional review of the passed task. This follow-up changes
only `db/index.js`, adds `server/__tests__/write-leases-compatibility.test.js`,
and records the decisions here. It does not reopen task lifecycle state.

- **Suggestion 1 declined for this follow-up.** Synchronous backoff in `runSync`
  cannot wait for a holder on the same Node event loop without preventing that
  holder from progressing. Async retry, narrower request ownership and dashboard
  conflict handling should be designed and tested together as a separate latency
  improvement. Checking ownership before and after async git cannot fence its
  intervening writes; a longer synchronous network timeout increases the blocking
  cost. A single scaffold lease section could avoid contention between files but
  would not make filesystem writes rollback-atomic. These paths remain unchanged.
- **Suggestion 2 partially taken.** When SQLite failed to open, the facade again
  reaches each method's original null/false/empty-array return. An available DB
  without a lease service still fails closed. Context projection now shares the
  exact public project lookup (name first, UUID-only id fallback), uses the same
  resolved project for its lease and projection, and preserves best-effort lookup
  failure while saving the context row. Invalid/escaping projection paths still
  fail before writes; the existing path-safety tests remain green.
- The review's phrase **every board mutation** was too broad: this resource's
  documented scope is task/project state, not every table in the cockpit database.
  Notes, inline comments and document reviews were not added to that global lease.
  Their separate mutation semantics need a separately scoped analysis. SQLite
  initialization already occurs once at module load (`db/index.js`); there was no
  deferred reopen mechanism to preserve. This follow-up does not introduce one.

Verification: all four new compatibility tests failed before the fixes, then
`npx jest server/__tests__/write-leases-compatibility.test.js server/__tests__/write-leases.test.js server/__tests__/write-leases-routes.test.js server/__tests__/workspace-command.test.js server/__tests__/project-knowledge.test.js server/__tests__/project-checkpoints.test.js server/__tests__/task-cas.test.js --runInBand`
passed **7 suites / 84 tests**. The follow-up diff was reviewed; strict UTF-8,
mojibake and whitespace checks passed. Existing uncommitted task work and the
foreign `.env.example` edit were preserved. No other repository was edited.

## Binding task constraints (verbatim)

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/402930f9-4e3e-411b-97a9-3e0a948ede39/workspace with the new path and a reason. Robert, if the re-point is refused.
- **Fallback (do this instead):** If the WHOLE task belongs elsewhere, re-point the task first and then do ALL the work in the new directory; if you only realise at the end, still call the endpoint with "baseline":"head". If the task merely also needs another repo, work there and declare it in your report. If neither is possible, report needs_input.
- **Consequence (if you proceed anyway):** QA builds the authoritative diff from this workspace and the dispatch-time snapshot, plus the diff of every additional repo the run touched and declared. Work done in an undeclared repo that Praxis could not record is invisible to review, and a round with no work in any visible repo fails as an empty diff no matter how correct the change is.

#### BC-FOREIGN-WORK — The workspace is SHARED and may hold unrelated uncommitted work from other agents or Robert's own sessions. Never revert, stash, `git checkout`/`git restore`, or delete anything you did not change in this run.
- **Prerequisite (resolve first):** Know what was already dirty before you touch the tree: the brief's workspace pre-flight lists it, and `git status` shows the rest. Anything on that list is somebody else's in-flight work.
- **Authority (who may waive it):** Robert alone. No task brief, no reviewer finding, and no cleanup instinct authorizes discarding another session's changes.
- **Fallback (do this instead):** Work additively. Re-read a contended file immediately before each edit, keep your change narrow, and say in your walkthrough that the file was already dirty. Never `git add -A` or `git commit -a`.
- **Consequence (if you proceed anyway):** Git keeps no reflog for working-tree reverts, so the other session's work is gone unrecoverably — that happened on 2026-07-09 and cost a verified-but-uncommitted change.

#### BC-NO-COMMIT — Do NOT commit or push unless the task explicitly says to.
- **Prerequisite (resolve first):** A commit needs explicit authorization in this task's own brief. Absent that sentence, the work stays uncommitted.
- **Authority (who may waive it):** Robert, through the end-of-day commit-approval workflow. The task brief itself, when it explicitly instructs you to commit.
- **Fallback (do this instead):** Leave the change in the working tree; `git add` only the NEW files you created if the task needs them visible to review.
- **Consequence (if you proceed anyway):** QA reviews your UNCOMMITTED diff against a dispatch-time snapshot. Committing moves the work out of that view, and the round can read as an empty diff — a mandatory fail — even though the code is right.

#### BC-LIFECYCLE — Do NOT change this task's status in The Nexus yourself.
- **Prerequisite (resolve first):** The completion protocol markers at the end of this brief are the only status channel available to you; use them instead of the board.
- **Authority (who may waive it):** Praxis's completion handler owns the lifecycle. Robert can override it from the board.
- **Fallback (do this instead):** End with the exact completion / failure / needs-input protocol, and put anything the status cannot express into the walkthrough.
- **Consequence (if you proceed anyway):** A hand-edited status desynchronizes the schedule from the run, and the executor callback that would have carried your result is discarded.

#### BC-QUALITY-GATES — Run BOTH quality gates — verify and code-review — and declare them on the marker line before reporting complete.
- **Prerequisite (resolve first):** The verify pass needs the change actually exercised (run the flow, command, or test — a typecheck is not a verify), and the code-review pass needs your own uncommitted diff re-read end to end.
- **Authority (who may waive it):** Nobody. Neither an executor nor a reviewer may waive a gate; the only sanctioned exception is a change with no runtime surface, and you must say that explicitly on the marker line.
- **Fallback (do this instead):** If there is genuinely nothing to drive, declare that in place of a command rather than omitting the gate or inventing a command you did not run.
- **Consequence (if you proceed anyway):** A completion reported without the marker line is treated as unverified work and flagged for the human reviewer, whatever the walkthrough claims.

#### BC-WORKSPACE-BINDING — Your home workspace is `/Volumes/Projects/TheNexus`. You MAY work in additional repos under /Volumes/Projects when the task genuinely needs it, and you MUST name every extra repo you touched — absolute path — and why, in your completion report.
- **Prerequisite (resolve first):** Before writing outside the home workspace, know that the task genuinely needs that repo. Praxis records every write outside the home root, so the record and your report have to agree.
- **Authority (who may waive it):** You, by declaring it in the completion report — that is the sanctioned way to widen the task's footprint. If the WHOLE task belongs in a different repo, re-point it through the workspace endpoint instead so QA's primary diff moves with you.
- **Fallback (do this instead):** If you touched a repo you did not need, say so in the report anyway (an honest extra repo is not a defect); if you cannot tell which repos you touched, list every one you might have.
- **Consequence (if you proceed anyway):** QA collects the diff from every repo you touched and judges it on merit — it never fails you merely for editing another repo. An UNDECLARED extra repo (recorded by Praxis, never named in your report) is the one cross-repo defect QA may raise.
