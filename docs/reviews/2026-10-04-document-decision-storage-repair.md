# Document decision storage repair — a1cc8616

Acceptance checklist for the bounded repair (2026-10-04):

1. Met, settled criterion preserved: re-read the request/session root-cause trace in `2026-10-04-document-decision-session.md:33`; `npx jest server/__tests__/document-deliverables.test.js --runInBand` passed all 16 tests, including the placeholder-bearer refusal reproduction.
2. Met, settled criterion preserved: the same server suite covers authenticated user/device decisions, the screenshot condition and unauthorized caller refusals. The new isolated browser report steps 07–09 confirm exact-revision Request changes, device approval and executor refusal.
3. Met, repaired: reproduced the exact quota/remount loss before editing; the same stdin reproduction now prints `RELOAD RESTORATION: PASS`. The final focused dashboard suite passes 33 tests, including separate comments, Finish review, local quota fallback and both-stores-fail tests for three refusal codes. Browser steps 02, 03a, 03, 05 and 10 exercise these behaviors against running servers.
4. Met, settled criterion preserved: focused component drift tests and browser steps 06–07 retain the original review/comment revision, name both note revisions and submit the decision against the explicit current revision.
5. Met, settled criterion preserved: dashboard build exit 0; focused dashboard 33/33, full dashboard 771/771, server deliverables 16/16; isolated browser `ALL CHECKS PASSED`, zero page exceptions; independent review followed by correction and re-review found no remaining material issue. Activation is reported separately below. Praxis's normal completion-triggered cross-executor QA remains the authoritative next review.

The workspace preflight confirmed the implementation lives in `/Volumes/Projects/TheNexus` and recorded all dirty paths before edits. No additional repository was edited. No commits, pushes, task-status changes, real document decisions, client communications or production restarts occurred.

## Reproduction and repair

Before any source edit, executed the reviewer's sequence through `cd dashboard` and `node --input-type=module --import ./test/register.mjs -`, reusing the setup from `src/components/__tests__/document-decisions.test.mjs`. `Storage.prototype.setItem` threw `QuotaExceededError` only for localStorage; a sessionStorage probe succeeded. After typing `Please preserve this review note.` and submitting into `operator_credential_unconfigured`, the notice recommended reloading but printed `PERSISTED: {"local":null,"session":null}`. Unmount/remount with storage retained and reopening Request changes failed with actual `''`, expected the typed note. An initial data-URL harness attempt failed module resolution before exercising the component; the subsequent stdin run reproduced the reported defect exactly.

The new component tests failed before the implementation: one lost-note assertion and two incorrect-guidance assertions. Independent review later found the same wording defect in `operator_check_unavailable`; its additional regression also failed before correction.

This run changed five existing files, all already dirty/staged at arrival:

- `dashboard/src/lib/decision-note-draft.ts:92`: read both stores and choose the latest retained draft. Writes at line 106 try localStorage then sessionStorage on write failure, return a success boolean, and remove the superseded copy. Clear/blank-note handling visits both stores. Stored revision/origin/attempt fields are preserved.
- `dashboard/src/components/document-review/decision-card.tsx:56`: recovery copy uses that result. Credential-unconfigured, expired-session and verifier-unavailable errors only promise restoration after persistence succeeds. Otherwise the editable textarea and collapsed draft announcement accurately require copying before reload. Editing clears an earlier notice so it cannot keep making an outdated promise after a new write fails.
- `dashboard/src/components/__tests__/document-decisions.test.mjs:460`: quota → refusal → remount → reopen → exact note/revision/attempt → successful retry → fallback cleanup. Both-stores-fail cases cover all three relevant refusal codes and an editable retry.
- `dashboard/src/lib/__tests__/decision-note-draft.test.ts:67`: explicit false return for unavailable storage; fallback, stale-copy removal/latest-copy selection, blank-note cleanup and recovery back to localStorage.
- `dashboard/scripts/decision-session-browser-check.mjs:163`: both-storage failure and persistent local quota injection in real Chrome. The script was listed as foreign/shared at dispatch; it was re-read before narrow additive changes, preserving all earlier work. Page exceptions at line 336 now contribute to failure and exit 1. An isolated VM invocation of the actual final-report block with a synthetic exception previously printed `ALL CHECKS PASSED`/exit 0; it now prints `FAILED (1)`/exit 1, while the empty-exception case still exits 0 (`node /tmp/nexus-storage-exception-check.mjs`).

New artifacts are this report and `2026-10-04-document-decision-storage-repair-browser-check.json`. Prior-round source, authentication changes and evidence remain in place. The shared baseline diff is nonempty (`git diff de7f581492ae --stat`); the entire range is not asserted as this run's ownership. The build's two generated `.next-verify` tsconfig includes were removed without changing other bytes; `git diff -- dashboard/tsconfig.json` is empty.

## Verification commands and observations

From `dashboard/`:

```sh
node --import ./test/register.mjs --test src/components/__tests__/document-decisions.test.mjs src/components/__tests__/document-review.test.mjs src/lib/__tests__/document-review-client.test.ts src/lib/__tests__/decision-note-draft.test.ts
npm test
NEXT_DIST_DIR=.next-verify NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 npm run build
```

Final results: 33 passed; 771 passed; build exit 0 with `/documents/[id]` present. Logs: `/tmp/nexus-storage-focused.log`, `/tmp/nexus-storage-dashboard-tests.log`, `/tmp/nexus-storage-build.log`. The same pre-edit stdin sequence now showed `local:null`, the complete correct draft in sessionStorage and `RELOAD RESTORATION: PASS` (exit 0).

From the repository root: `npx jest server/__tests__/document-deliverables.test.js --runInBand` returned 16 passed. No server implementation changed in this repair. The pre-existing test-fixture warning about `pre_archive_status` did not fail the suite.

The isolated stack was run twice, the final run after the independent review correction:

```sh
node dashboard/scripts/decision-session-check-api.cjs
# dashboard directory:
NEXT_DIST_DIR=.next-verify node node_modules/next/dist/bin/next start -p 3299
# repository root, CHECK_DIR and CHECK_DOC taken from the fixture API's output:
CHECK_BASE=http://127.0.0.1:3299 CHECK_DIR=<fixture-dir> CHECK_DOC=<fixture-document> CHECK_OUT=/tmp/nexus-storage-repair-evidence node dashboard/scripts/decision-session-browser-check.mjs
```

A foreground Python wrapper started both children, awaited the browser command and stopped/awaited both children in `finally`; no detached work remains. Synthetic API/receiver ports were 4299/4300; synthetic tokens stayed in fixture files and were not printed. The final browser run was **18:06:24.512Z–18:06:32.972Z**, `ALL CHECKS PASSED`, zero exceptions, no failures. It saved one comment, restored the quota-fallback note through reload and revision drift, recorded only fixture decisions, and delivered Finish review exactly once to the stub receiver. The both-stores-fail screenshot was visually inspected: editable note and copy-before-reload guidance are visible.

Report: `2026-10-04-document-decision-storage-repair-browser-check.json`, SHA-256 `aafb8a00c17ee27a3e474b2531aef41e6e04aa69109333fc868adf5f38a10f00`. Screenshots: `/tmp/nexus-storage-repair-evidence/`. The page's existing bridge made read-only `socket.io` and `/api/chat/active` requests to localhost:4000; this is recorded in the report and not newly introduced here.

Self-review re-read the attributable uncommitted helper, card, tests and browser-script changes for correctness, leftover debug code, unused imports and placeholders. Independent read-only agent `review_storage_repair` found the verifier-unavailable wording issue, then re-reviewed the corrected patch and reported no remaining material issue; its final narrow suite was 21/21. Strict UTF-8 decoding and mojibake scans passed for every edited/new text file; scoped `git diff --check` passed.

## Activation, distinct from source verification

At **18:05:33Z**, `lsof -nP -iTCP:3000 -sTCP:LISTEN`, the equivalent :4000 check, and `ps -p 2487,2527 -o pid,lstart,comm` showed the existing dashboard PID 2527 (started 11:38:59 local) and API PID 2487 (11:38:58 local). The authority source mtime is 13:17:13 local, after that API start. No production restart was performed; the earlier server-authority activation need remains. The live dashboard uses supervised development mode per AGENTS.md, but this run does not claim a fresh authenticated live-session verification or that an already-open tab has loaded this patch. Reload recovery is proven on the isolated built app. SessionStorage covers reload in the same tab, not closing that tab or transferring the draft to another device.

The screenshot was read and contains Robert's requested wording. No new assertion was made that a separate task-note record currently exists: that original intake claim was not needed for this storage repair, and the real brief/task notes were not changed.

Upstream handoff gap: the brief reports that **BC-CRITERIA originally lacked fallback and consequence**. This run used the complete four-field contract below.

## Binding constraints carried forward verbatim

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/a1cc8616-5d7b-4278-a91f-85d90c366c9e/workspace with the new path and a reason. Robert, if the re-point is refused.
- **Fallback (do this instead):** If the WHOLE task belongs elsewhere, re-point the task first and then do ALL the work in the new directory; if you only realise at the end, still call the endpoint with "baseline":"head". If the task merely also needs another repo, work there and declare it in your report. If neither is possible, report needs_input.
- **Consequence (if you proceed anyway):** QA builds the authoritative diff from this workspace and the dispatch-time snapshot, plus the diff of every additional repo the run touched and declared. Work done in an undeclared repo that Praxis could not record is invisible to review, and a round with no work in any visible repo fails as an empty diff no matter how correct the change is.

#### BC-CRITERIA — Satisfy every acceptance criterion above and cite the command or observation that proves each one.
- **Prerequisite (resolve first):** Each criterion has to be verified against real behavior before you report complete — a criterion you did not run is a criterion you did not meet.
- **Authority (who may waive it):** The QA reviewer rules on a criterion you can show is defective — contest it with "PRAXIS_CRITERION_DISPUTE: <number> — <why, with evidence>", and twice contested without resolution goes to Robert. Robert's operator rulings override both. Neither happens silently — you have to raise it.
- **Fallback (do this instead):** If a criterion cannot be met as written, say so explicitly with evidence and deliver everything else in full. Narrowing the scope quietly is not the fallback.
- **Consequence (if you proceed anyway):** QA scores each criterion mechanically against your diff. An unproven criterion is a fail verdict and a correction round, not a note.

#### BC-REPAIR — Resolve every reviewer finding listed for this repair round (attempt 1 of 2).
- **Prerequisite (resolve first):** Reproduce the reviewer's failing check yourself before changing anything. A finding you cannot reproduce is one to report, not one to guess at.
- **Authority (who may waive it):** The QA reviewer, via a ruling on a contested finding ("PRAXIS_CRITERION_DISPUTE: <number> — <why, with evidence>"). Robert, once a finding has been contested twice without resolution.
- **Fallback (do this instead):** Fix only the listed findings and preserve every criterion not amended by one; if a finding is defective, contest it with evidence instead of complying blindly or ignoring it.
- **Consequence (if you proceed anyway):** Attempts are bounded at 2. Exhausting them stops the task and escalates it to Robert, and a finding that recurs across rounds is read as an unfixed root cause, not a fresh note.

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
