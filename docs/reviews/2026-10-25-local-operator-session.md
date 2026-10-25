# Local operator session — implementation and verification

Task: `5f15ca0f-17b1-48a7-aa93-61f212fcabf6`.
QA baseline: `13a75c9e6e80e69c772efd67f6221eb057266cc1`.
Status: implemented and activated; actual Robert/Mac-session acceptance remains blocked.

## What changed

Explicit sign-in exchanges Robert's existing operator credential for a signed,
one-hour HttpOnly local session. It requires a server-held session entry, a
loopback socket and the exact dashboard origin; localhost alone is still not
proof (`server/services/local-operator-session.js:19`, `:55`, `:75`).
The sign-in form clears its password before awaiting the response and keeps
credentials out of browser storage (`dashboard/src/components/local-operator-sign-in.tsx:27`).

The shared authenticator checks local sessions only in the absence of an
Access assertion (`server/services/operator-access.js:139`). Credential-derived
sessions retain `operator_credential` in the document ledger
(`server/services/document-decision-authority.js:84`), preserving existing
Praxis operator allowlists and the `mail-drafts` relay surface. The browser
fixture records all three mail actions as `operator:mail-drafts` and both
document decisions as `recorded_by: operator`; see
`docs/reviews/2026-10-25-local-operator-evidence.json:53` and `:67`.

The Mail and document dialogs keep unsaved work mounted underneath. The
real-browser check specifically confirms preservation of an edited mail
subject and document notes (`docs/reviews/2026-10-25-local-operator-evidence.json:49`).
The standalone entry point is `http://localhost:3000/operator-sign-in`.
Provisioning, revocation and the threat model are documented in
`docs/contracts/local-operator-session.md:12` and the headers of both authority
services. This is credential authentication; it does not claim OS/process
attestation or protection against a compromised browser/profile.

## Activation and remaining operator check

Appended only `NEXUS_LOCAL_OPERATOR_SESSIONS=1` and its explanatory comment to
the ignored `.env`, preserving existing bytes. Sent TERM to supervised Nexus
API child 67815; Praxis respawned it as PID 23056 on port 4000. Neither Praxis
nor the dashboard was restarted. These observations are retained at
`docs/reviews/2026-10-25-local-operator-evidence.json:156`.

Live requests through `http://localhost:3000/api/operator-session` now return
200 with `operator:false`. Placeholder sign-in, foreign origin, unsigned
document decision and unsigned mail decision return 403 `operator_required`
(`docs/reviews/2026-10-25-local-operator-evidence.json:84`). The first document
probe used a nonexistent id and returned 404 before authorization; the
repeated probe used an existing document and was refused before any write.
No live operator credential was retrieved, no real decision was recorded,
and no client email was sent.

Robert must sign in separately in his actual Mac desktop app and local
browser using **Operator sign-in**, then verify the intended live mail and
document actions. He must not paste the credential into chat or a task.
The isolated Chrome test proves the implementation flow, not his actual
WKWebView identity or real Praxis delivery receipts. Criterion 1 therefore
remains blocked; this is not a completion claim.

## Verification

Exact commands and outputs are retained in
`docs/reviews/2026-10-25-local-operator-evidence.json`:

- Line 5: the ten-suite Jest command; line 20: **308 passed, 308 total**.
  It covers local sessions, document decision/executor boundaries,
  stakeholder key separation, mail relay/mount, Access/provenance, MCP boundary
  security and stateless conformance. Local session tests first failed before
  implementation; the six new authority flows initially returned 403, then
  passed after integration.
- Line 26: dashboard component test command; line 27: **62 passed, 0 failed**.
- Line 30: `cd dashboard && NEXT_DIST_DIR=.next-local-operator-verify npm run build`;
  line 31: **exit 0**, compiled and generated 30 static pages. Removed only the
  build-added verification-directory entries from tsconfig; no tsconfig change remains.
- Line 43: `node dashboard/scripts/local-operator-browser-check.cjs`; line 81:
  **errors: []**. Real localhost dashboard, fresh Chrome profile, isolated
  in-memory API and synthetic mail receiver. Every browser API request was
  intercepted; Socket.IO was blocked. Sign-in, edit, approve/send, cancel,
  document approve/request changes, note preservation and logout were driven.
  Harness-only CDP serialization, cancellation and selector-escaping errors
  were corrected before the successful run. One crashed harness left a test
  Chrome process; that identified fixture process was stopped before rerun.
- Line 120: baseline failure comparison. The initial broader run had **23
  failures in client-access.test.js** plus 303 passing tests. An isolated
  `git archive 13a75c9e6e80` checkout, with the same installed dependencies,
  reproduced **all 23 identical test names** and the same setup exception:
  “New information needs require structured knowledge with question, purpose
  and resolution”, at `db/knowledge-lifecycle.js:71` via
  `server/__tests__/client-access.test.js:73`. No authentication assertion was
  reached by that fixture. This suite remains failing; it is not counted as
  passing. Five subsequently added regressions bring the green set to 308.

## Code review and ownership

Re-read the full attributable diff, including new files, the two owned server
mount lines and the two owned Mail UI lines. No debug code, unused imports,
placeholders or remaining correctness defects were found. A separate read-only
security review under the requesting-code-review skill found no blocking
security issue. Its session-capacity finding was reproduced with a failing
test and fixed; reauthentication now replaces the current session at capacity.
Added the requested Access-precedence, replacement and rate-limit regressions.
Strict UTF-8 decoding and mojibake scans passed for the edited text files.

All work is in `/Volumes/Projects/TheNexus`; no additional repository was edited.
Praxis source files were read only. Contrary to the brief's mechanical misses,
`../Praxis/src/operator-provenance.ts` and `../Praxis/src/feedback/mail-drafts.ts`
exist; the latter's router verifies loopback plus signed provenance and assigns
`operator:` plus the verified surface (`../Praxis/src/feedback/mail-drafts.ts:163`).
The baseline authority header explicitly said the unsigned Mac app could not
decide (`server/services/document-decision-authority.js:40` at `13a75c9e6e80`),
confirming that refusal was deliberate.

Local commit `00440e5` contains the verified authority, UI, tests and contract.
The subsequent evidence commit contains the browser harness, retained report,
contract guidance correction and only the owned server mount hunk. Both carry
the task trailer; nothing was pushed. Its SHA is reported in the final response.

`server/server.js` was already dirty; it was re-read immediately before the
additive edit, and only our two-line mount was staged using an isolated index
patch. The foreign mail mount stays outside this task's commits.
`dashboard/src/components/mail-drafts.tsx` was already untracked foreign work;
it was re-read and only an import plus `<LocalOperatorSignIn />` were added
(lines 4 and 90). Those two lines remain uncommitted because committing an
untracked file would also commit its foreign contents. The mail route itself
was not edited. Ignored `.env` remains local and is never staged.

## Acceptance attestation

PRAXIS_CRITERION: 1 blocked — isolated browser flow passed all five actions with operator attribution (evidence.json:43); Robert's actual Mac/browser sign-in and live Praxis receipts still require his own credential and observations.
PRAXIS_CRITERION: 2 met — local-operator-session and local-operator-flows tests cover unsigned/QA, executor, runtime, bridge and placeholder refusals; evidence.json:20 records 308 passing server tests, and evidence.json:95 records live 403 refusals.
PRAXIS_CRITERION: 3 met — unchanged praxis-operator-provenance, document-deliverables, document-executor-approvals and mail Access tests pass (evidence.json:8); additional mixed Access/local-cookie precedence tests pass. The separate client-access fixture failure reproduces on the baseline (evidence.json:120).
PRAXIS_CRITERION: 4 met — proof, provisioning and revocation are in server/services/operator-access.js:15, server/services/document-decision-authority.js:16 and docs/contracts/local-operator-session.md:12; the document-review contract also links and describes the mechanism.
PRAXIS_CRITERION: 5 met — this report and docs/reviews/2026-10-25-local-operator-evidence.json retain the exact commands, observed results, baseline failures, live negative checks and remaining operator gate per docs/verification-protocol.md.

PRAXIS_QUALITY_GATES: verify=node dashboard/scripts/local-operator-browser-check.cjs passed all five synthetic review actions, sign-in and logout; 308 server and 62 dashboard tests passed; isolated dashboard build passed; code-review=full attributable diff reviewed; session-capacity edge fixed and tested; no remaining blocking findings; UTF-8/mojibake scan passed

## Files touched:

- .env
- server/server.js
- server/services/stakeholder-authority.js
- server/services/document-decision-authority.js
- server/services/operator-access.js
- server/services/local-operator-session.js
- server/routes/operator-session.js
- server/__tests__/local-operator-session.test.js
- server/__tests__/local-operator-flows.test.js
- dashboard/src/components/local-operator-sign-in.tsx
- dashboard/src/components/mail-drafts.tsx
- dashboard/src/components/document-review/decision-card.tsx
- dashboard/src/components/__tests__/local-operator-sign-in.test.mjs
- dashboard/src/app/operator-sign-in/page.tsx
- dashboard/scripts/local-operator-browser-check.cjs
- docs/contracts/local-operator-session.md
- docs/contracts/document-review-deliverables.md
- docs/reviews/2026-10-25-local-operator-session.md
- docs/reviews/2026-10-25-local-operator-evidence.json

## Binding constraints (verbatim from the execution brief)

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/5f15ca0f-17b1-48a7-aa93-61f212fcabf6/workspace with the new path and a reason. Robert, if the re-point is refused.
- **Fallback (do this instead):** If the WHOLE task belongs elsewhere, re-point the task first and then do ALL the work in the new directory; if you only realise at the end, still call the endpoint with "baseline":"head". If the task merely also needs another repo, work there and declare it in your report. If neither is possible, report needs_input.
- **Consequence (if you proceed anyway):** QA builds the authoritative diff from this workspace and the dispatch-time snapshot, plus the diff of every additional repo the run touched and declared. Work done in an undeclared repo that Praxis could not record is invisible to review, and a round with no work in any visible repo fails as an empty diff no matter how correct the change is.

#### BC-CRITERIA — Satisfy every acceptance criterion above and cite the command or observation that proves each one.
- **Prerequisite (resolve first):** Each criterion has to be verified against real behavior before you report complete — a criterion you did not run is a criterion you did not meet.
- **Authority (who may waive it):** The QA reviewer rules on a criterion you can show is defective — contest it with "PRAXIS_CRITERION_DISPUTE: <number> — <why, with evidence>", and twice contested without resolution goes to Robert. Robert's operator rulings override both. Neither happens silently — you have to raise it.
- **Fallback (do this instead):** If a criterion cannot be met as written, say so explicitly with evidence and deliver everything else in full. Narrowing the scope quietly is not the fallback.
- **Consequence (if you proceed anyway):** QA scores each criterion mechanically against your diff. An unproven criterion is a fail verdict and a correction round, not a note.

#### BC-FOREIGN-WORK — The workspace is SHARED and may hold unrelated uncommitted work from other agents or Robert's own sessions. Never revert, stash, `git checkout`/`git restore`, or delete anything you did not change in this run.
- **Prerequisite (resolve first):** Know what was already dirty before you touch the tree: the brief's workspace pre-flight lists it, and `git status` shows the rest. Anything on that list is somebody else's in-flight work.
- **Authority (who may waive it):** Robert alone. No task brief, no reviewer finding, and no cleanup instinct authorizes discarding another session's changes.
- **Fallback (do this instead):** Work additively. Re-read a contended file immediately before each edit, keep your change narrow, and say in your walkthrough that the file was already dirty. Never `git add -A` or `git commit -a`.
- **Consequence (if you proceed anyway):** Git keeps no reflog for working-tree reverts, so the other session's work is gone unrecoverably — that happened on 2026-07-09 and cost a verified-but-uncommitted change.

#### BC-TASK-COMMITS — Commit your OWN verified work as you go, in small, task-scoped, LOCAL commits on the dispatch branch, each ending with the trailer `Task: 5f15ca0f-17b1-48a7-aa93-61f212fcabf6`. Never `git push`, and never stage or commit anything you did not change in this run.
- **Prerequisite (resolve first):** Before each commit: the change is verified (its test, typecheck or hand-run passed); `git branch --show-current` is still the dispatch branch and HEAD is not detached; you stage explicit paths only (`git add -- <path>`, never `-A`, `-u` or `commit -a`); and `git diff --cached --stat` lists nothing but files you changed in this run. A file that was already dirty at dispatch, or that a sibling is editing, needs your hunks separated from theirs before it can be in your commit.
- **Authority (who may waive it):** An explicit commit hold (a task brief or operator note that says not to commit, or dispatch metadata `commitPolicy: hold`) prevails over this default, and then the work stays uncommitted. Pushing is Robert's alone: the QA-pass commit and the end-of-day commit-approval workflow are the only publishers, and no sentence in a task brief authorizes `git push`.
- **Fallback (do this instead):** Cannot separate your hunks from foreign ones in a shared dirty file? Leave that file uncommitted, commit the rest, and name it in your walkthrough; QA still reviews it from the working tree. Under a hold, leave everything uncommitted and `git add` only the NEW files you created. Either way, record every commit SHA you made in your walkthrough.
- **Consequence (if you proceed anyway):** QA diffs the dispatch snapshot against the WORKING TREE, so committed and uncommitted work both stay in view. A commit carrying your trailer whose files start from their dispatch-time version is attributed to you; a commit without the trailer, or one whose files first moved under someone else's commit or dirty edit, reaches the reviewer only as an unattributed candidate. A commit that sweeps foreign work misattributes it under your task's name (a defect in its own right), and a push without Robert's approval publishes unreviewed work.

#### BC-LIFECYCLE — Do NOT change this task's status in The Nexus yourself.
- **Prerequisite (resolve first):** The completion protocol markers at the end of this brief are the only status channel available to you; use them instead of the board.
- **Authority (who may waive it):** Praxis's completion handler owns the lifecycle. Robert can override it from the board.
- **Fallback (do this instead):** End with the exact completion / failure / needs-input protocol, and put anything the status cannot express into the walkthrough.
- **Consequence (if you proceed anyway):** A hand-edited status desynchronizes the schedule from the run, and the executor callback that would have carried your result is discarded.

#### BC-QUALITY-GATES — Run BOTH quality gates — verify and code-review — and declare them on the marker line before reporting complete.
- **Prerequisite (resolve first):** The verify pass needs the change actually exercised (run the flow, command, or test — a typecheck is not a verify), and the code-review pass needs your own task diff, every commit you made this run plus the edits still uncommitted, re-read end to end.
- **Authority (who may waive it):** Nobody. Neither an executor nor a reviewer may waive a gate; the only sanctioned exception is a change with no runtime surface, and you must say that explicitly on the marker line.
- **Fallback (do this instead):** If there is genuinely nothing to drive, declare that in place of a command rather than omitting the gate or inventing a command you did not run.
- **Consequence (if you proceed anyway):** A completion reported without the marker line is treated as unverified work and flagged for the human reviewer, whatever the walkthrough claims.

#### BC-WORKSPACE-BINDING — Your home workspace is `/Volumes/Projects/TheNexus`. You MAY work in additional repos under /Volumes/Projects when the task genuinely needs it, and you MUST name every extra repo you touched — absolute path — and why, in your completion report.
- **Prerequisite (resolve first):** Before writing outside the home workspace, know that the task genuinely needs that repo. Praxis records every write outside the home root, so the record and your report have to agree.
- **Authority (who may waive it):** You, by declaring it in the completion report — that is the sanctioned way to widen the task's footprint. If the WHOLE task belongs in a different repo, re-point it through the workspace endpoint instead so QA's primary diff moves with you.
- **Fallback (do this instead):** If you touched a repo you did not need, say so in the report anyway (an honest extra repo is not a defect); if you cannot tell which repos you touched, list every one you might have.
- **Consequence (if you proceed anyway):** QA collects the diff from every repo you touched and judges it on merit — it never fails you merely for editing another repo. An UNDECLARED extra repo (recorded by Praxis, never named in your report) is the one cross-repo defect QA may raise.
