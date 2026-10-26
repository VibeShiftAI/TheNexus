# Automatic local operator sessions — correction and verification

Task: `5f15ca0f-17b1-48a7-aa93-61f212fcabf6`.
QA baseline: `13a75c9e6e80e69c772efd67f6221eb057266cc1`.
Implementation commit: `4e1f107` (local only, task trailer present).

The separate sign-in is removed in accordance with Robert's 2026-10-26 ruling.
The installed Mac app now establishes operator identity automatically: its
Session Check displayed **State ok · Identity local**, without credential entry
(`docs/reviews/2026-10-25-local-operator-evidence.json:238`). Chrome verification
remains blocked pending a normal browser restart; this is not a completion claim
(`docs/reviews/2026-10-25-local-operator-evidence.json:255`).

## What changed and why

The server now verifies the exact live TCP peer, console UID, process ancestry,
installed application path and running code before minting authority
(`server/services/local-operator-peer.js:62`). It accepts the explicitly pinned,
hardened native app or the signed ordinary Google Chrome profile; an argument
allowlist rejects automated/custom-profile browsers
(`server/services/local-operator-peer.js:17`, `:93`). macOS's numeric PID form
with `--verbose=1` checks running code and full static integrity. The real native
process passed the configured CDHash and failed an all-zero pin
(`docs/reviews/2026-10-25-local-operator-evidence.json:245`, `:249`).

Each request needs both a signed HttpOnly cookie and a separate random proof
kept in the localhost:3000 origin, plus an active one-hour server entry. A cookie
captured by a different localhost port is insufficient
(`server/services/local-operator-session.js:56`). The browser silently renews;
the native shell makes its own fixed TCP request and plants the cookie and
origin-scoped proof (`dashboard/src/lib/local-operator-session.ts:45`,
`desktop/src-tauri/src/local_operator.rs:38`). No credential form remains;
old sign-in URLs redirect home (`dashboard/src/app/operator-sign-in/page.tsx:1`).
Mail, document and chat mutations preflight the automatic session, retain their
normal /api proxy, and never retry a failed decision just because a session was
established (`dashboard/src/lib/mail-drafts.ts:135`,
`dashboard/src/lib/document-review.ts:410`, `dashboard/src/components/ai-terminal.tsx:375`).

Access keeps its prior validation and precedence
(`server/services/operator-access.js:143`). Document decisions retain
`operator_credential` and `recorded_by: operator`; the fixture's actor id is the
existing Robert dashboard id `local_user`, which still grants nothing alone
(`server/services/document-decision-authority.js:86`,
`docs/reviews/2026-10-25-local-operator-evidence.json:203`). Mail retains the
body-bound `mail-drafts` surface (`server/routes/mail-draft-review.js:30`).

## Activation and remaining check

Only non-secret pins were added to the ignored server .env: console UID 501,
Chrome opt-in, and native CDHash `d6d663582a4cf6b349d4d43ae5bd7b6ccb753aac`.
The previous installed app was backed up to
`/tmp/nexus-local-operator-app-backup-20261026`; the hardened build was installed
at `/Applications/The Nexus.app`. Only the supervised Nexus API child was
restarted for activation (`docs/reviews/2026-10-25-local-operator-evidence.json:385`).

Chrome PID 82710 began on October 20 and its installed code has since been
updated. Its current strict running-code check exits 1 with “resource fork,
Finder information, or similar detritus not allowed”
(`docs/reviews/2026-10-25-local-operator-evidence.json:259`). No signature check
was weakened. The browser tool rejected `chrome://restart` because its URL
policy disallows that protocol and forbids alternate automation routes
(`docs/reviews/2026-10-25-local-operator-evidence.json:262`). Robert was asked only
to quit/reopen Chrome, not to sign in. On resume, verify localhost:3000/session
shows **State ok · Identity local**, then finish criterion 1 against the retained
flow evidence. Do not repeat implementation or retrieve an operator credential.

The five-action browser run uses synthetic drafts/documents and injected OS
attestation. It proves edit, approve/send and cancel relay behavior, both document
ledger decisions, note preservation and revocation. It is not a claim that a real
client email was sent or a real business document approved
(`docs/reviews/2026-10-25-local-operator-evidence.json:178`, `:217`). Both actual
clients and real live decision receipts have not all been observed, so criterion
1 remains blocked under its full wording.

## Verification

- Final focused server command and output: **13 suites / 358 tests passed**,
  including operator/session, document/executor, stakeholder, mail/provenance and
  MCP security (`docs/reviews/2026-10-25-local-operator-evidence.json:8`).
- Dashboard behavior tests: **90 passed, 0 failed**; build compiled and generated
  **30/30 pages** (`docs/reviews/2026-10-25-local-operator-evidence.json:32`, `:137`).
- `node dashboard/scripts/local-operator-browser-check.cjs`: all five synthetic
  actions passed, all mail actors `operator:mail-drafts`, both document decisions
  recorded by operator, `errors: []`
  (`docs/reviews/2026-10-25-local-operator-evidence.json:189`, `:203`, `:215`).
- Native release build and parser test passed (**1 passed, 0 failed**)
  (`docs/reviews/2026-10-25-local-operator-evidence.json:149`, `:165`).
- The unchanged Praxis receiver test passed and stored the signed cancellation
  actor as `operator:mail-drafts` in isolated durable state
  (`docs/reviews/2026-10-25-local-operator-evidence.json:220`).
- Twelve live negative probes, across bootstrap/mail/documents for unsigned,
  placeholder bearer, forged reviewer and bridge requests, all returned
  **403 operator_required**; the document probe used existing id
  `9f6c4952-88b8-494b-8ae9-3f2331392206`
  (`docs/reviews/2026-10-25-local-operator-evidence.json:268`). Executor-key-specific
  `executor_provenance_required` and runtime-key refusal are also asserted in
  `server/__tests__/local-operator-flows.test.js:90`.
- Existing Access user, async phone and pinned travel-device tests are unchanged
  against the QA baseline and pass. Mixed Access/local-cookie precedence passes
  too (`docs/reviews/2026-10-25-local-operator-evidence.json:345`).
- The broader client-access suite still has **23 baseline fixture failures** at
  structured knowledge setup. Baseline and current commands, all matching names
  and both outcomes are retained; this suite is not counted as passing
  (`docs/reviews/2026-10-25-local-operator-evidence.json:351`).

The verify and code-review gates were run explicitly. The implementation diff
was reread, independent security review findings were fixed, `git diff --check`
passed, and strict UTF-8 plus mojibake scans passed. Review fixes and the bounded
threat model are retained at
`docs/reviews/2026-10-25-local-operator-evidence.json:396`.

## Scope and ownership

TheNexus contains the primary API, dashboard and native-shell changes
(`server/routes/operator-session.js:1`, `dashboard/src/lib/local-operator-session.ts:1`,
`desktop/src-tauri/src/local_operator.rs:1`). `git diff 13a75c9e6e80 --stat`
is nonempty; it also includes unrelated shared changes, so its aggregate is not
an ownership claim. The earlier task-owned paths were extended in place. This
round's local commit `4e1f107` contains only the correction's reviewed hunks.
The mail implementation predates this correction: only its session hooks and
removal of this task's sign-in controls are claimed here.

No additional repository was edited. `/Volumes/Projects/Praxis` was inspected
read-only and its existing isolated receiver test was run. Both paths the brief's
mechanical lookup missed do exist: `../Praxis/src/operator-provenance.ts:158`
verifies provenance, and `../Praxis/src/feedback/mail-drafts.ts:163` checks it
before recording `operator:<surface>`. The original refusal remains deliberate:
the plain-local probes still fail while the actual native session succeeds
(`docs/reviews/2026-10-25-local-operator-evidence.json:238`, `:268`).

The foreign .env.example, dashboard/src/app/page.tsx, schedule-layout report
folder and schedule-layout plan were left untouched and uncommitted. The only
outside-workspace writes were the installed app and /tmp verification artifacts
and backup (`docs/reviews/2026-10-25-local-operator-evidence.json:388`).

The process proof trusts the operator UI; it cannot establish a human click if
that UI, profile, extension, OS account or server is already controlled. Other
browsers are not enabled. Groundrules labeling's separate local-identity mapping
remains outside scope (`docs/contracts/local-operator-session.md:57`,
`server/services/groundrules-labeling/authority.js:48`). Provisioning and revocation
are documented in both authority headers and the contract
(`server/services/operator-access.js:15`, `server/services/document-decision-authority.js:16`,
`docs/contracts/local-operator-session.md:66`, `:101`).

## Files touched:

- dashboard/scripts/local-operator-browser-check.cjs
- dashboard/src/app/layout.tsx
- dashboard/src/app/operator-sign-in/page.tsx
- dashboard/src/app/session/page.tsx
- dashboard/src/components/__tests__/local-operator-sign-in.test.mjs
- dashboard/src/components/ai-terminal.tsx
- dashboard/src/components/document-review/decision-card.tsx
- dashboard/src/components/local-operator-session.tsx
- dashboard/src/components/local-operator-sign-in.tsx
- dashboard/src/components/mail-drafts.tsx
- dashboard/src/lib/__tests__/local-operator-session.test.mjs
- dashboard/src/lib/__tests__/session-check.test.ts
- dashboard/src/lib/document-review.ts
- dashboard/src/lib/local-operator-session.ts
- dashboard/src/lib/mail-drafts.ts
- dashboard/src/lib/session-check.ts
- dashboard/src/lib/voice-chat.ts
- desktop/src-tauri/src/local_operator.rs
- desktop/src-tauri/src/main.rs
- docs/contracts/document-review-deliverables.md
- docs/contracts/local-operator-session.md
- docs/reviews/2026-10-25-local-operator-evidence.json
- docs/reviews/2026-10-25-local-operator-session.md
- docs/superpowers/plans/2026-10-26-local-operator.md
- server/__tests__/local-operator-flows.test.js
- server/__tests__/local-operator-peer.test.js
- server/__tests__/local-operator-session.test.js
- server/routes/operator-session.js
- server/server.js
- server/services/document-decision-authority.js
- server/services/local-operator-peer.js
- server/services/local-operator-session.js
- server/services/operator-access.js

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
