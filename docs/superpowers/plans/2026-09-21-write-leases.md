# Write leases implementation plan

**Goal:** prevent overlapping Nexus board and workspace writers from silently clobbering an active writer.

**Architecture:** SQLite owns durable, expiring leases. One board lease covers task and project mutations, including batch, reorder and archive; workspace leases cover canonical filesystem paths and descendants. Existing clients acquire short automatic leases; explicit clients acquire before reading and pass a bearer token through the edit. Mutations revalidate ownership at the persistence boundary. Existing version checks remain necessary for stale snapshots.

**Tech stack:** existing better-sqlite3, Express, AsyncLocalStorage and Jest. Work directly in the assigned TheNexus workspace. Leave all work uncommitted for Praxis QA; preserve the pre-existing `.env.example` edit.

## Decisions

- Prefer a durable server lease over process-local mutexes, which do not coordinate multiple API processes. Do not introduce a CRDT without a collaborative document model.
- Use a coarse board lease so collection, archive and row edits cannot bypass each other. Independent workspace paths remain concurrent. Fine-grained board concurrency is a later optimization.
- Keep orchestration in Praxis. Its existing client-side board/schedule leases remain compatible but are independent of this API boundary.
- Expose acquire/inspect/renew/release at `/api/write-leases`. Use `X-Nexus-Board-Lease` and `X-Nexus-Workspace-Lease` for requests that own explicit leases; filesystem tools accept `lease_token`.
- Tokens are ownership capabilities, not user authentication. Public status/conflicts never expose them. TTL is 1–300 seconds, default 30 seconds. Expired tokens cannot resurrect ownership.
- External CLI and raw SQL writers must cooperate; this feature cannot sandbox arbitrary processes. Workspace shell/git operations reserve their declared working directory and must not be represented as a universal filesystem fence.

## Steps and acceptance checks

- [x] Add `server/__tests__/write-leases.test.js`; run `npx jest server/__tests__/write-leases.test.js --runInBand` and observe missing lease behavior. Implement `db/write-leases.js`: transactional acquisition, renewal, release, canonical overlapping paths, async ownership and synchronous fenced commits. Rerun to green.
- [x] Add HTTP and real SQLite/filesystem integration tests in `server/__tests__/write-leases-routes.test.js`. Prove a second writer gets HTTP 409 with unchanged contents, the owner succeeds, expiry recovers, aliases and alternate edit paths cannot bypass leases, and CAS still rejects stale versions.
- [x] Wire the lease service into the DB facade's board mutation exports, task/project route factories, filesystem tools and workspace edit routes. Keep existing caller signatures and response shapes except explicit conflict errors. Exercise each newly guarded route with a held lease.
- [x] Document usage and scope in `docs/write-leases.md`. Run focused suites, then the server suite for cross-cutting regression coverage. Validate strict UTF-8 and scan every edited text file for mojibake. Read the attributable diff end to end and fix any correctness findings before reporting.

## Reconciliation evidence

Before the first edit, `pwd` printed `/Volumes/Projects/TheNexus`; `git status --short` printed only ` M .env.example`; `git branch --show-current` printed `main`; HEAD was `02dceb5`.
`git show 1dbe51e5 -- db/index.js dashboard/src/components/live-board-state-logic.ts` shows member evidence/commitment readers and a `task.qa-passed` invalidation mapping, not write leases. Existing Praxis commit `aaedec0` implements board/schedule client leases, but does not guard Nexus filesystem writes. No additional repository is being edited.



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
