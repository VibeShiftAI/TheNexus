# Automatic local operator sessions — verified

Task: `5f15ca0f-17b1-48a7-aa93-61f212fcabf6`.
QA baseline: `13a75c9e6e80e69c772efd67f6221eb057266cc1`.
Local implementation commits: `4e1f107`, `d0ba169`; prior evidence commit `e779bc0`.

The installed Mac app and Robert's restarted Chrome now establish operator
identity automatically. Their Session Check pages displayed **State ok · Reason
ok · Identity local** at 18:15:48 and 18:14:32 respectively, with no credential
entry (docs/reviews/2026-10-25-local-operator-evidence.json:621, :628). This implements Robert's ruling
against a separate sign-in. The five requested actions pass the shared dashboard
flow: edit, approve/send, cancel, approve document and request changes
(docs/reviews/2026-10-25-local-operator-evidence.json:681, :697). No real client email or business approval was
made for verification; actual client identity and isolated action/ledger evidence
are separate checks (docs/reviews/2026-10-25-local-operator-evidence.json:851).

## What changed and why

The earlier implementation verifies the live TCP peer, console UID, process
ancestry, installed application path and running code before minting authority
(`server/services/local-operator-peer.js:62`). Every local decision then requires
an HMAC-authenticated HttpOnly cookie, a separate random origin-scoped proof,
active one-hour server state and the permitted local origin
(`server/services/local-operator-session.js:56`). The native app uses a fixed
Rust TCP bootstrap and plants its own cookie/proof; the browser bootstraps
silently. Mail/documents and chat retain the dashboard API proxy
(`desktop/src-tauri/src/local_operator.rs:35`,
`dashboard/src/lib/local-operator-session.ts:45`,
`dashboard/src/lib/mail-drafts.ts:135`, `dashboard/src/lib/document-review.ts:410`).

Robert's Chrome restart exposed an overly strict metadata check in this task's
implementation. The new process and installed Chrome had matching code hashes,
but full `--strict` still rejected FinderInfo on its framework. The earlier
old-process hypothesis was insufficient (docs/reviews/2026-10-25-local-operator-evidence.json:608).
A narrow attempt to remove that metadata returned `Operation not permitted`
before changing anything; the attributes and Chrome code were left intact
(docs/reviews/2026-10-25-local-operator-evidence.json:612).

The correction uses the fixed Chrome-only `--strict=symlinks` policy, retaining
both Google signature requirements, dynamic and full static validation, sealed
resource hashes and strict symlink checks. It permits FinderInfo and ResourceFork
sideband metadata. Apple's [resource validator](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/StaticCode.cpp#L1720-L1797)
separates those metadata checks from resource integrity checks. Native validation
retains full `--strict`; a failed Chrome helper or main signature never triggers
a weaker fallback (`server/services/local-operator-peer.js:85`,
`server/__tests__/local-operator-peer.test.js:25`). Real Chrome accepted the
correct Google requirement (exit 0) and rejected the wrong team (exit 3)
(docs/reviews/2026-10-25-local-operator-evidence.json:733). Only the supervised Nexus API child was
restarted, PID 96627 to 67202 (docs/reviews/2026-10-25-local-operator-evidence.json:633).

The document ledger retains `operator_credential`, `recorded_by: operator` and
Robert's existing dashboard actor id `local_user`; that stub still confers no
authority alone. Mail retains the body-bound `mail-drafts` provenance and Praxis
records `operator:mail-drafts` (docs/reviews/2026-10-25-local-operator-evidence.json:698, :715).
Access validation and precedence remain unchanged
(`server/services/operator-access.js:145`, docs/reviews/2026-10-25-local-operator-evidence.json:840).
Proof, provisioning and revocation are documented in both authority headers and
the contract (`server/services/operator-access.js:15`,
`server/services/document-decision-authority.js:16`,
`docs/contracts/local-operator-session.md:11`, :75, :110).

## Verification

- `npx jest` with the 13 named security/authority suites: **360 tests passed**.
  The full command and output are retained at docs/reviews/2026-10-25-local-operator-evidence.json:648.
  The peer regression was written first: **3 failed / 18 passed** before the
  correction, then **21 passed** (docs/reviews/2026-10-25-local-operator-evidence.json:643).
- `node dashboard/scripts/local-operator-browser-check.cjs`: all five actions
  passed; all mail actions carried `operator:mail-drafts`, both document
  decisions were recorded by operator, and `errors: []`
  (docs/reviews/2026-10-25-local-operator-evidence.json:675, :683, :698, :709). Only OS attestation is
  injected; data and email transport are synthetic. Production rejects the
  test's headless/custom profile.
- The actual Praxis tests selected by `migration is idempotent|cancel is
  permanent|operator proof is bound to exact action payload`: **3 passed**.
  They prove edited bytes are sent once through a stub transport, cancellation
  persists, unsigned/altered actions are refused, and the real router stores
  `operator:mail-drafts` (docs/reviews/2026-10-25-local-operator-evidence.json:714).
- Twelve live probes across bootstrap, mail and documents for unsigned,
  placeholder-bearer, bridge and forged-executor requests returned **403
  operator_required** (docs/reviews/2026-10-25-local-operator-evidence.json:763). Document probes used
  the reference contract's existing id with an empty body, so even an authority
  regression could not record a decision. An initial absent-id probe returned
  404 before authority and was correctly excluded (docs/reviews/2026-10-25-local-operator-evidence.json:838).
  Executor-credential `executor_provenance_required` and runtime-key refusal
  pass in `server/__tests__/local-operator-flows.test.js:90`.
- Existing Access user/tunnel, phone, travel-device, document and stakeholder
  tests remain byte-for-byte unchanged against the QA baseline (`git diff
  13a75c9e6e80 --exit-code --` the six paths listed in docs/reviews/2026-10-25-local-operator-evidence.json:841
  exited 0). They pass in the 360-test run, including both JWT audience shapes;
  mixed local/Access precedence also passes.
- Retained earlier-round gates: **90 dashboard tests**, **30/30-page production
  build**, native release build and native parser test (**1 passed**)
  (docs/reviews/2026-10-25-local-operator-evidence.json:32, :137, :149, :165). This resumed correction
  changed server verification and documentation only, so no dashboard/native
  rebuild was needed.
- The broader client-access suite has **23 pre-existing fixture failures** at
  structured-knowledge setup. The baseline revision, commands, both outcomes and
  all matching names are retained at docs/reviews/2026-10-25-local-operator-evidence.json:336. It is not
  counted as passing or changed by this task.

The verify and code-review gates both passed. The attributable authority,
session, client and native changes were reread against the QA baseline, along
with the full resumed patch. Independent security review found no remaining
blocker and reran all 21 peer tests. Strict UTF-8, mojibake scans and
`git diff --check` passed (docs/reviews/2026-10-25-local-operator-evidence.json:845).

## Scope, assumptions and limits

The assigned workspace contains the main API, dashboard and native shell;
`git diff 13a75c9e6e80 --stat` is nonempty. Its shared aggregate includes
unrelated work and is not an ownership claim. The resumed implementation commit
`d0ba169` contains **5 files, 39 insertions, 8 deletions**, as printed by the
reviewed staged diff and commit. The earlier task-owned changes were extended
in place. No additional repository was edited. `/Volumes/Projects/Praxis` was
read for the consumer contract and its existing isolated tests were run.
The brief's missing-path checks were false negatives:
`../Praxis/src/operator-provenance.ts:158` verifies provenance and
`../Praxis/src/feedback/mail-drafts.ts:163` enforces it before actor attribution.
The original unsigned-local refusal remains intentional; the current live
negative probes and real UI verdicts prove the distinction
(docs/reviews/2026-10-25-local-operator-evidence.json:621, :628, :763).

The foreign `.env.example`, `dashboard/src/app/page.tsx`, schedule-layout
report directory and schedule-layout plan were preserved. Earlier deployment
wrote the ignored local configuration, installed native app and /tmp backups;
this resume wrote only /tmp diagnostics outside the repo. Chrome attributes
were not changed (docs/reviews/2026-10-25-local-operator-evidence.json:371, :612).

This proof trusts the configured operator UI, not a human click. Compromise or
automation of that existing UI/profile, or unrestricted modification of server
configuration/code, is outside its boundary. Other browsers are not enabled.
Groundrules labeling's separate local-identity mapping stays outside this task
(`docs/contracts/local-operator-session.md:66`,
`server/services/groundrules-labeling/authority.js:48`).

## Files touched:

- server/services/local-operator-peer.js
- server/__tests__/local-operator-peer.test.js
- server/services/operator-access.js
- server/services/document-decision-authority.js
- docs/contracts/local-operator-session.md
- docs/reviews/2026-10-25-local-operator-evidence.json
- docs/reviews/2026-10-25-local-operator-session.md
- docs/superpowers/plans/2026-10-26-local-operator.md

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
