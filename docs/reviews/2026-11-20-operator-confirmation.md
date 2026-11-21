# Per-action Mac confirmation (Option A): review report

| | |
|---|---|
| Task | `5e513530-0d18-5939-87b8-583274b5bf5e`, the QA follow-up of `5f15ca0f` |
| Date | 2026-11-20 |
| Branch | `praxis/run/5e513530-0d18-5939-87b8-583274b5bf5e` |
| QA baseline | `fddc44b5` |
| Commits | `ec55f35c` (server), `5216b80a` (dashboard), `4372f1dc` (live harness), `c3aebd10` (earlier live evidence), `e9364a1d` (this report and the contract), `cdad4ab6` (code-review fixes), `8cf041e9` (the code review). QA repair rounds 1 and 2 are uncommitted: a commit hold applies |
| Contract | `docs/contracts/local-operator-session.md`, section "Per-action confirmation" |
| Evidence | In `docs/reviews/2026-11-20-operator-confirmation/`, all on the final code: `live-chrome-attended-2.json` and `live-webview-attended.json` (Robert's clicks, every check passed), `live-chrome-attended.json` (Robert's first attended Chrome run, kept as recorded; see "Run 1"), `live-chrome-unattended.json` and `live-webview-unattended.json` (no answers), `qa-repair-red-green.txt`, `baseline-failures.txt`, `recovery-recheck.txt` (receipts, hashes, source bindings and the reruns after the background-hold recovery), `qa-round-2-ruling.txt` (Robert's ruling on the desktop clause as stored, the source bindings rechecked and the confirmation suite rerun). Earlier and superseded: `live-chrome.json`, `live-webview.json`. Earlier gate: `code-review-red-green.txt` |

## Where this stands (QA rounds 1 and 2)

QA round 1 failed criteria 2, 3, 5 and 6 on `cf770e92`; repair round 1 (attempt 0/2) did items 1 to 6. QA round 2 passed criteria 1, 2, 3, 4, 6 and 7 and failed only the installed-app clause of criterion 5, as an evidence gap. Item 3 records how Robert closed that clause, and item 7 what repair round 2 (attempt 1/2) did.

1. **Numeric policies: removed.** The 120-second give-up, the 60-second consumption window, the pause (three outcomes in ten minutes, then five minutes), the 15-second process allowance and the 64-KiB output cap are gone. A dialog now lives exactly as long as the request that asked for it; the contract states the bounds that come from the request ("How long a dialog stays open"). Red/green: 5 of the 26 tests fail on `8cf041e9`, and all 26 pass now (`qa-repair-red-green.txt`).
2. **Native answers: observed.** `dialog-probe` has no press mode, the harness no longer ends a dialog to hand the broker a planned answer, and each dialog's `outcome` is what osascript returned. Unattended runs on the final code cover every step that needs no answer: Chrome 120 of 120 checks, webview 67 of 67, console locked. Robert then answered the dialogs himself at the Mac: Chrome 196 of 196 checks with four Cancel clicks and four confirming clicks (`live-chrome-attended-2.json`), webview 87 of 87 with one of each (`live-webview-attended.json`). His first Chrome run is kept as recorded: he confirmed all eight dialogs there, including the four the page labeled Cancel, and each confirmed action was recorded once (see "Run 1").
3. **Desktop proof: the stand-in, accepted by Robert in place of the app.** The installed desktop app cannot be exercised before landing within the brief's constraints (see "The installed desktop app"). The webview host is labeled a stand-in in the code, the evidence and the README. Robert's first reply, "Ready", started the attended runs but chose none of the options A, B and C, so none was assumed. QA round 2 then asked for evidence from the installed app or "an explicit operator amendment accepting substitution or deferral". Robert was asked again, with B recommended (accept the test window as the desktop evidence), A (defer an app check until after landing) and C (stop Praxis, the API and the dashboard for a test before landing). His answer, verbatim: "Ok complete the task then" (2026-11-21 00:38:41 UTC, inbox answer `task-question-5e513530-1795220618318`). He named no letter. This report reads the answer as B, for the reasons under "The installed desktop app": the desktop clause of criterion 5 rests on the stand-in, under his amendment, and the stand-in is still not claimed to be the app.
4. **Baselines: retained.** `baseline-failures.txt` has the commands, the baseline revision, the four test names and both outcomes.
5. **Time limits: none.** QA's correction removed the unsourced limits. Robert was asked whether he wants numbers and gave none, so none were added back (retained suggestion 4).
6. **Recovery recheck.** The first attended child exited 1 because of run 1, and its receipt held the task for background evidence. Praxis recovered the hold under Robert's standing policy (23:49 UTC) and dispatched a recovery run. That run rechecked both receipts, every registered artifact and the source binding of every live report against the unchanged tree, and reran the non-interactive suites with the same results (`recovery-recheck.txt`). It rewrote nothing, kept the failed trial and ran nothing live.
7. **Repair round 2 (attempt 1/2).** Only this report changed, plus the new `qa-round-2-ruling.txt`: Robert's two answers as stored, every current live report still bound to HEAD `8cf041e9` and 15 of 15 current file hashes, and the confirmation suite rerun (26 of 26). No code, harness or earlier evidence changed, nothing ran live, and nothing was committed (commit hold).

## Outcome

Sending mail and document decisions made through the local operator session no longer record on the session alone. The covered actions are:

- approving a document or requesting changes;
- approving a document's email for sending;
- sending a Praxis Mail draft;
- finishing a review with the approve-after-changes grant or with decision answers.

Each one waits until Robert answers a native macOS dialog that names the exact action. The Nexus API process shows that dialog itself (`/usr/bin/osascript`), inside the same request. Browsing, reading and bootstrap stay click-free. Other operator actions the local session can take keep the parent behavior and are not asked (see "Other operator actions" under Limits).

What is shown, and where:

- **Live, on the final code, with nobody answering, in Robert's Chrome and in the webview stand-in.**
  - A page script holding the stored session puts up the dialog for each covered action and records nothing while the dialog is open or after its request ends.
  - Forged confirmation fields and headers change nothing and do not appear in the dialog.
  - A dialog whose process ends refuses as unavailable, with no fallback.
  - A second request while a dialog is open is refused as busy.
  - An unanswered dialog is still open after 135 seconds, the longest the previous version allowed, and records nothing.
- **Live, on the final code, with Robert's own clicks in Chrome and in the webview stand-in.**
  - A Cancel click refuses with 403 `operator_confirmation_declined` and records nothing. Forged fields and the stored session alone do not get past the dialog.
  - A confirming click records exactly once with the confirmed identity: the decision for that revision, content hash, decision and note; the send grant for that envelope hash; one signed relay carrying only the confirmed draft version; one review submission with the grant.
  - After a confirmation, an exact replay answers from the record without a dialog, and a repeat without the idempotency key asks again.
  - Each click was checked twice: osascript returned that button, and the HID idle time at the answer was shorter than the time the dialog had been open.
- **Jest, at the server boundary.** A confirmed decision, send or finish records exactly once with the confirmed identity. Declined and unavailable refuse. An exact replay answers from the record, any other repeat asks again, and a record that changes during the dialog is refused.
- **Not exercised: the installed desktop app.** Robert accepted the webview stand-in in its place (see "The installed desktop app").

None of this is live yet. It takes effect when this branch lands and the `:4000` API restarts. After landing, the dashboard's `next dev` on `:3000` picks up the dashboard copy on its own.

## QA round 1 corrections

| QA correction | What changed | Evidence |
|---|---|---|
| Desktop proof: the harness admitted a substitute host after the real verifier declined it | The substitute stays as component evidence for the webview path, labeled "stand-in pin ... (not the desktop app)"; it is not offered as the desktop proof. The desktop clause of criterion 5 was disputed in that round; after QA round 2, Robert accepted the stand-in in place of the app | `scripts/operator-confirmation-qa/live-check.cjs:207-221`; `live-webview-unattended.json:1414`; "The installed desktop app" below |
| Native answers: the harness ended the dialog and supplied its planned answer, and that answer overrode the process outcome | Removed. The probe only looks; `show()` records the osascript outcome only; unattended runs carry only steps that need no answer; `--attended` waits for Start and then for Robert's clicks, and checks each click against the HID idle time. Robert's attended runs on the final code are retained | `scripts/operator-confirmation-qa/dialog-probe.swift:8-10`; `live-check.cjs:279-335`, `:512-521`; `harness.answers_dialogs: false` (`live-chrome-unattended.json:37`, `live-chrome-attended-2.json:37`); attended: `live-chrome-attended-2.json:4579` (196 of 196), `live-webview-attended.json:2060` (87 of 87) |
| Numeric policies in `server/services/operator-confirmation.js` | Removed; the Praxis Mail route's draft read reuses the route's existing relay timeout (30 s, unchanged from the baseline) | `operator-confirmation.js:32-39`, `:136-152`; `server/routes/mail-draft-review.js:7-9`; `qa-repair-red-green.txt` |
| Baseline failures | Retained with commands, revision, names and both outcomes | `baseline-failures.txt` |
| Report claims | Rewritten to match the observations; the earlier stand-in runs are marked superseded | This report |

## Dispositions

| Item | Disposition | Rationale and evidence |
|---|---|---|
| Suggestion 1, objection 1: an executor edits the dashboard and drives Robert's Chrome or the desktop webview to record decisions | **Implemented** (Option A, as Robert decided at 14:19 EST) | `server/services/operator-confirmation.js` plus the four routes. A stored session alone records nothing. Evidence: Chrome steps S02, S03, S06, S09 and S12; webview steps W02 to W05; jest `server/__tests__/operator-confirmation.test.js:319`. |
| Suggestion 1, objection 2: the decisions were proven only with a stubbed OS attestation, and the desktop app was never exercised | **Chrome and real clicks: done. Desktop app: the stand-in, accepted by Robert** | **Done.** The live check uses the real peer verifier against Robert's running Chrome, not a stub (`live-chrome-unattended.json:2561`, `:2568`; `live-chrome-attended-2.json:4261-4277`), and runs the real routes and real osascript dialogs. Robert answered them himself: an approve, two sends and a finish recorded from his confirming clicks, and four Cancel clicks that recorded nothing (`live-chrome-attended-2.json`).<br>**Stand-in accepted.** The installed app talks only to the live `:4000` and its production attestation admits only the signed app in `/Applications`, so it was not driven. Robert's ruling of 2026-11-21, verbatim: "Ok complete the task then", read as option B (the webview stand-in, with his clicks, as the desktop evidence); see "The installed desktop app". |
| Option B: wall executors off from the dashboard | **Declined** | Robert rejected it in the same decision. |
| Phone approvals | **Protected by a separate operator credential**; no change, one residual recorded | See "Phone path" below. |
| The reviewer's pass rationale ("The five decision actions were exercised on synthetic data rather than a real draft or document") | **Superseded** | The objections stand. Option A changes the guarantee. Synthetic data is kept on purpose: no real mail is sent and no real document is decided. |

## What changed

- **Server (`ec55f35c`)**
  - **New broker.** `server/services/operator-confirmation.js` (dialog, refusals, single-use binding, abort; the first version also had a pause and timers, removed in QA round 1).
  - **Authority now reports the path it took.** `document-decision-authority.js` returns `via` (`local_session`, `access_session`, `operator_bearer`, `document_executor_bearer`) and the device.
  - **Each route confirms, then re-reads and consumes:** document decisions and review finish (`server/routes/documents.js`), document email (`server/routes/document-outgoing.js:116-139`) and Praxis Mail (`server/routes/mail-draft-review.js`).
  - **Unknown paths fail closed.** A `via` other than the local session or a never-asked path is refused with 503 (`operator-confirmation.js:179`, `:84`).
- **Dashboard (`5216b80a`).** The mail and document screens say "Confirm on your Mac" while the dialog is open, each refusal is explained, and a mismatch reloads the record.
- **Harness (`4372f1dc`), evidence (`c3aebd10`), docs (`e9364a1d`), code-review fixes (`cdad4ab6`)**, as recorded in those commits.
- **QA repair round 1 (uncommitted, commit hold)**
  - `server/services/operator-confirmation.js`: no give-up time, no consumption window, no pause, no process timeout and no output cap. The response's `close` still aborts the dialog.
  - `server/routes/mail-draft-review.js`: the draft read before a confirmation reuses the route's relay timeout constant.
  - `dashboard/src/lib/local-operator-session.ts` and `dashboard/src/components/document-review/decision-card.tsx`: the timeout and paused refusals are gone from the dashboard.
  - `server/__tests__/operator-confirmation.test.js`: five tests changed or added for the removed limits.
  - `scripts/operator-confirmation-qa/`: `live-check.cjs` rewritten (it never answers; four endings; unattended and attended steps; the hold step; declared guards; evidence bound to file hashes), `check-page.html` (Start button; the page can only give up), `dialog-probe.swift` (look-only modes, new `watch`), `webview-host.swift` (the desktop app's bootstrap read timeout; stops when the harness is gone) and the README.
  - `docs/contracts/local-operator-session.md`: "How long a dialog stays open", the refusals table and two new limits.

## Live evidence

**The page.** The page served at `/check` plays the part of a script an executor added to a dashboard page (`scripts/operator-confirmation-qa/check-page.html`). It runs in the client under the session's pinned origin, holds the same HttpOnly cookie and stored proof, and calls the same routes. Nothing in a request tells the server which page a script came from. The isolated API serves the page on its own origin, so the run never touches the live `:3000` or `:4000`.

**The harness never answers a dialog.** A dialog ends when Robert clicks it (attended runs only), when the page gives up and its request ends, when the harness ends the dialog process (the unavailable path), or, in the hold step, after the harness has watched it stay open. Its guards (helper commands, window lookups, page boot and end) can only fail a check or stop a run; a dialog itself is never timed (`live-check.cjs:73-91`).

### Robert's Chrome (unattended, final code)

`node scripts/operator-confirmation-qa/live-check.cjs --client chrome` ran on 2026-11-20 from 22:49:20 to 22:51:54 UTC, on HEAD `8cf041e9` plus this round's uncommitted files. The report's `source.sha256` matches all 15 files under test as they stand. Result: 120 of 120 checks (`live-chrome-unattended.json:2785`), 8 dialogs. The console was locked at the start and at the end, idle for 3701 seconds at the start (`:2527`, `:2664`).

**Boot.** The page opened the session with no click (before `operator: false`, bootstrap 201, after `operator: true`). The real verifier accepted the connection from Chrome's network service helper (pid 73516), whose parent is the interactive Google Chrome (ppid 1) (`:2561`, `:2568`).

| Step | The page script tried | How the dialog ended | Result |
|---|---|---|---|
| S01 | Five reads | no dialog | 200 each |
| S02 | Approve document D with the stored session only | the page gave up | `aborted`; the dialog closed; no decision |
| S03 | Approve A with forged `confirmed`, `confirmation`, `operator_confirmation`, `confirmation_ref` (the last dialog's Ref), `via` and `authority` fields and three forged confirmation headers | the page gave up | asked anyway; `aborted`; no decision |
| S06 | Approve sending B's email, stored session only | the page gave up | `aborted`; still a draft with no send grant |
| S09 | Send the Praxis draft with forged `to`, `cc`, `subject` and `body` | the page gave up | the dialog named `harness-member@example.test` and none of the forged values; nothing reached Praxis |
| S12 | Finish review C with the approve-after-changes grant | the page gave up | `aborted`; still a draft, no submission |
| S14 | Approve D while the harness ends the dialog process | process ended | 503 `operator_confirmation_unavailable`; no decision (no fallback) |
| S15 | Two decisions on D at once | the page gave up on the first | second: 409 `operator_confirmation_busy`; one dialog; no decision |
| S16 | Approve document E; nobody answers | watched, then the page gave up | still on screen after 135.1 s (`watched_ms` 135114, `:2294-2295`) with osascript still waiting and nothing recorded; then `aborted` and closed |

**Checks on every dialog:** the window server listed its window, owned by `osascript`; the title, the action line and the button name the action; osascript received exactly that title, text and button as arguments, with no timeout and no output cap; the footer says "Requested by Google Chrome on 127.0.0.1:4299"; the records did not change while it was open or after. **Final state:** no decision on A, D or E; B a draft without a grant; C a draft without a submission; no Praxis relay. **End:** the page revoked its session (200) and removed the stored proof.

### WebKit webview host (stand-in for the desktop app; unattended, final code)

`node scripts/operator-confirmation-qa/live-check.cjs --client webview` ran from 22:52:00 to 22:52:11 UTC. Result: 67 of 67 checks (`live-webview-unattended.json:1620`), 4 dialogs, console locked throughout (`:1384`, `:1503`). The host loaded the page; its native code bootstrapped the session, planted the HttpOnly cookie through WebKit's cookie store and stored the proof with the desktop app's origin-checked evaluation. The real verifier declined the host, and the stand-in pin then admitted it as `mac-desktop` (`:1414`).

| Step | Result |
|---|---|
| W01 | Five reads: 200, no dialog |
| W02 | Approve D with the stored session only: `aborted`, no decision. The footer says "Requested by The Nexus app on 127.0.0.1:4299" |
| W03 | Praxis send with forged fields: `aborted`; the dialog shows none of the forged values; nothing reached Praxis |
| W04 | Approve sending B's email, stored session only: `aborted`; no send grant |
| W05 | Approve A with forged confirmation fields and headers: `aborted`; no decision |

### Robert's Chrome, attended (run 2, final code)

Nothing is asked until Robert presses "Start the attended check" on the page, and the page names the button for each dialog.

`node scripts/operator-confirmation-qa/live-check.cjs --client chrome --attended --out docs/reviews/2026-11-20-operator-confirmation/live-chrome-attended-2.json` ran on 2026-11-20 from 23:29:29 to 23:30:11 UTC, on HEAD `8cf041e9` plus this round's uncommitted files; the report's `source.sha256` matches all 15 files under test as they stand. Result: 196 of 196 checks (`live-chrome-attended-2.json:4579`), 12 dialogs: 8 answered by Robert's click, 3 ended by the request and 1 by its process. The console was unlocked with Robert at the Mac: HID idle 235 ms at the start, and 79 ms when he pressed Start at 23:29:34 (`:4228-4233`, `:4361-4366`). The real verifier accepted Chrome's network service helper (pid 73516), whose parent is the interactive Google Chrome (pid 73507, ppid 1) (`:4261-4277`).

| Step | The page script asked | Robert's answer, as osascript returned it | Result |
|---|---|---|---|
| S01 | Five reads | no dialog | 200 each |
| S02 | Approve document D with the stored session only | none; the page gave up | `aborted`; no decision |
| S03 | Approve A with forged confirmation fields and headers | Cancel: `declined` (`:674-675`) | 403 `operator_confirmation_declined`; no decision |
| S04 | Approve A | Approve: `confirmed` (`:1014-1015`) | 201; exactly one decision, for revision `c0a7bb05`, content sha256 `7a867be4`, decision `approve`, the note and `client_decision_id` `harness-a-1`, authority `operator_credential`; logged with Ref `761bfe24` |
| S05 | The same request again, then once more without its idempotency key | none for the replay; the page gave up on the repeat's dialog | replay: 200 `duplicate`, the same decision, no dialog; the repeat asked again (Ref `bef69d69`, not `761bfe24`); still one decision |
| S06 | Approve sending B's email with the stored session only | Cancel: `declined` (`:1592-1593`) | 403; still a draft without a send grant |
| S07 | Approve sending B's email | Send: `confirmed` (`:1954-1955`) | 200; one approval event; the grant is for envelope hash `74b159f7` on `operator_credential` |
| S08 | The same send again | no dialog | 200 with the same approval; still one approval event |
| S09 | Send the Praxis draft with forged recipients | Cancel: `declined` (`:2402-2403`) | 403; nothing reached Praxis |
| S10 | The same forged send | Send: `confirmed` (`:2725-2726`) | Praxis 200; exactly one signed relay, carrying only `approve_send` and version `v1` |
| S11 | The same send again | no dialog | 409 before any dialog, nothing recorded; still one relay |
| S12 | Finish review C with the approve-after-changes grant | Cancel: `declined` (`:3115-3116`) | 403; still a draft, no submission |
| S13 | Finish review C with the grant | Approve after changes: `confirmed` (`:3519-3520`) | 202; submitted once with the grant on `operator_credential` (submission `c219e958`) |
| S14 | Approve D while the harness ends the dialog process | none; the process ended | 503 `operator_confirmation_unavailable`; no decision, no fallback |
| S15 | Two decisions on D at once | none; the page gave up on the first | the second: 409 `operator_confirmation_busy`; no decision |

**Every click** was checked twice: osascript returned that button, and the HID idle time at the answer (91 to 150 ms) was shorter than the time the dialog had been open (790 to 1773 ms). With the screen unlocked, Accessibility read the same text that osascript received, with two buttons: Cancel and the action's own label. **End:** the page revoked its session (200) and removed the stored proof.

### Run 1 (Robert confirmed every dialog)

`live-chrome-attended.json` is Robert's first attended Chrome run (23:26:27 to 23:27:19 UTC, the same HEAD and file hashes), kept as recorded: 130 of 166 checks (`live-chrome-attended.json:4275`). Robert clicked the confirming button on all eight dialogs, including the four where the page asked for Cancel (S03, S06, S09 and S12; S03 at `:709-710`: `confirmed`, Ref `55ba4c70`). Every failed check follows from that:

- S03, S06, S09 and S12 recorded what Robert confirmed (a decision on A, B's send grant, the Praxis relay and C's submission) instead of refusing, so their declined and nothing-recorded checks failed.
- S04 recorded a second decision on A from its own confirmed click, so "exactly one decision on document A" failed.
- S07, S10 and S13 found their action already recorded and asked nothing: B answered 200 with the existing approval, the Praxis draft 409 "no longer waiting for review", and C 200 `duplicate`. Their click and one-dialog checks failed because no dialog was shown.

What the run still shows: each confirming click recorded exactly one record, logged with its Ref; a later request for an action already recorded asked nothing and recorded nothing new (one approval, one relay, one submission); the replay, kill and busy steps passed. After this run, the executor posted a macOS notification saying that four of the dialogs need Cancel, and run 2 followed the plan.

### WebKit webview host, attended (stand-in for the desktop app; final code)

`node scripts/operator-confirmation-qa/live-check.cjs --client webview --attended` ran from 23:27:19 to 23:28:20 UTC, between the two Chrome runs. Result: 87 of 87 checks (`live-webview-attended.json:2060`), 5 dialogs, console unlocked (`:1777-1779`). The stand-in pin admitted the host as `mac-desktop` (`:1806-1807`).

| Step | Result |
|---|---|
| W01 | Five reads: 200, no dialog |
| W02 to W04 | Approve D, the forged Praxis send and B's send, each with the stored session only: `aborted` when the page gave up; nothing recorded |
| W05 | Approve A with forged fields and headers: Robert clicked Cancel, `declined` (`:1293-1294`); 403, no decision |
| W06 | Approve A: Robert clicked Approve, `confirmed` (`:1633-1634`); 201, exactly one decision for the confirmed revision and content hash on `operator_credential` |

### The installed desktop app (criterion 5: the stand-in, accepted by Robert)

The desktop clause cannot be observed before landing within this task's constraints:

- The app bootstraps only against `127.0.0.1:4000` with Origin `http://localhost:3000` (`desktop/src-tauri/src/local_operator.rs:35`, `:39`) and renews only for a page on `http://localhost:3000` (`:50`).
- The production attestation admits only `/Applications/The Nexus.app/Contents/MacOS/nexus-desktop`, launched by launchd (ppid 1), with the hardened runtime and the CDHash pinned in `NEXUS_LOCAL_OPERATOR_DESKTOP_CDHASH` (`server/services/local-operator-peer.js:14`, `:25-34`, `:93-96`).
- The live `:4000` runs `main`, without Option A, and the brief forbids touching the live `:3000` and `:4000` and writing in the shared checkout.

What exists instead: the server-boundary test of a desktop session (`operator-confirmation.test.js:370`) and the webview stand-in above, unattended and attended. The stand-in sets up the session the way the app does: native code, not the page, sends the bootstrap with the dashboard Origin, plants the HttpOnly session cookie through the webview cookie API and stores the proof with one evaluation that first checks the page origin (`scripts/operator-confirmation-qa/webview-host.swift:41-73`, `:134-176`). It differs in three ways: it runs against the isolated API on `127.0.0.1:4299` instead of the live hosts, its webview store does not persist, and the harness pins its process in place of the app's code-signature attestation (`live-check.cjs:214-217`). That attestation decides only whether a local session may be opened. Once one exists, the server asks for every covered decision whatever the device: only the Access session and the two bearers are never asked (`operator-confirmation.js:56`, `:178-179`), and the device changes only the dialog's footer (`:160`, `:165`) and the log lines.

Robert was first offered three options: (A) after landing and the `:4000` restart, approve a synthetic document in The Nexus app, click Cancel once, and confirm that nothing was recorded; (B) accept the stand-in as the webview evidence; or (C) authorize a brief stop of the live `:4000` so an isolated API can take its port for the app. His answer (2026-11-20, 23:22 UTC) was "Ready", which started the attended runs above but chose none of the three, so none was assumed. (A first version of this paragraph kept the recommended option A as a default; the recovery run withdrew that, because silence is not a choice.)

QA round 2 (attempt 1/2) passed every other criterion and failed only this clause, as an evidence gap. It asked for evidence from the installed signed app "under authorized testing conditions" or, alternatively, "an explicit operator amendment accepting substitution or deferral", and it authorized no production interruption. A test of the real app before landing needs Praxis itself stopped: the app's hosts are fixed (above), and the Praxis supervisor can only restart the API and the dashboard, not pause them (`restartChild`, `/Volumes/Projects/Praxis/src/supervisor/index.ts:127`, `:161`).

Robert was asked again on 2026-11-21 (00:23 UTC), for one letter: B) accept the test window as the desktop evidence (recommended: the evidence exists and nothing more is needed from him); A) defer the app check until after landing, closing the task now; C) stop Praxis, the API and the dashboard for a test of the real app before landing (not recommended). The question told him that QA accepts his explicit OK in place of that test. His answer (00:38:41 UTC, inbox answer `task-question-5e513530-1795220618318`), verbatim:

> Ok complete the task then

He named no letter. The resumed brief says to "make the most reasonable choice and note it in your summary", and Praxis lists the answer among Robert's rulings, which amend the criteria. This report reads it as **B**:

- It closes the task now, which rules out C, the only option that needed a test first.
- It takes on no later check, which A would have needed from him; B was the option that needed nothing more.
- It opens with "Ok", the explicit OK the question said QA would accept in place of the test.

So the desktop clause of criterion 5 rests on the stand-in runs, under Robert's amendment: unattended W01 to W05 (67 of 67, `live-webview-unattended.json:1620-1627`), attended W05 declined (`live-webview-attended.json:1293-1294`) and W06 confirmed (`:1633-1634`), and Robert's Chrome runs for the real peer verifier. The stand-in is still not the app, and nothing here claims the installed app was observed. An optional look in the app after landing is retained as suggestion 10; it is not a condition of the task.

### Earlier runs (superseded)

`live-chrome.json` and `live-webview.json` were generated at 20:56Z and 20:57Z by the first harness against the first broker. With the console locked, that harness ended each dialog it meant to answer and handed the broker a planned answer (`answer_source: "stand-in (console locked)"`: 5 dialogs in Chrome, 1 in the webview), letting that answer stand in for the process outcome. Its other dialogs ended on the broker's give-up time (8 s in those runs), which no longer exists. The files are kept as generated. They are not evidence of a native answer, and their timeout and paused results describe code that is gone.

### Server boundary (jest)

`server/__tests__/operator-confirmation.test.js` covers:

- `:319`: the stored proof alone; declined and unavailable refuse; forged fields are ignored;
- `:333`: a confirmed decision records exactly once with the confirmed identity, and a repeat asks again;
- `:352`: an idempotent retry answers from the record without asking;
- `:362`: a file that changes during the dialog;
- `:370`: the desktop session;
- `:381` and `:394`: busy, and closing the request while the dialog is open;
- `:432` and `:487`: a comment or an email edit that lands during the dialog;
- `:461` and `:542`: a confirmed send approves exactly the reviewed envelope once, and Praxis gets exactly the confirmed version once;
- this round: `:133` (no expiry), `:153` (no pause), `:179` (no give-up time) and `:289` (no timeout or output cap on osascript).

## Phone path

Phone approvals rest on a separate operator credential, not on the Mac session, so they are not asked on the Mac.

- **Where phone approvals happen.** The Android app's own code calls no document, mail or decision route. A `git grep` over its TypeScript for `/documents`, `mailbox`, `drafts`, `approve_send`, `operator-session`, `/decisions`, `/finish` and `outgoing` found nothing. Its native tabs were retired on 2026-09-07 in favor of the dashboard shell (`Nexus-Mobile-Android/app/(tabs)/_layout.tsx:1-12`). Phone approvals are therefore made in the dashboard, inside the app's WebView.
- **The credential lives in the app.** The app holds a Cloudflare Access service token in SecureStore (`lib/config.ts:59-75`). It trades the token natively for the `CF_Authorization` cookie, and its source says "The credentials themselves never enter web content" (`lib/shell/session.ts:1-17`, `:32-48`). The headers are built in `lib/auth.ts:21-26`.
- **The server keeps the paths apart.**
  - It takes the local-session path only for a request without an Access assertion (`server/services/operator-access.js:147-151`).
  - An Access device identity needs a pinned Client ID (`operator-access.js:190-194`) and is recorded as `access_device` (`document-decision-authority.js:96-104`).
  - Its `via` is `access_session`, which is never asked (`operator-confirmation.js:56`, `:178`; `mail-draft-review.js:43`).
- **Live logs agree.** The retained live logs (`/Volumes/Projects/Praxis/data/logs/launchd-stdout.log` and `.log.1`) show 155 `operator verified (identity=device)` lines, 8 `identity=local` lines and 0 `identity=user` lines.
- **Residual.** A separate credential is not a per-action confirmation.
  - The WebView carries the Access session on every request it makes, `/api/*` fetches from page scripts included (`lib/shell/session.ts:9-12`).
  - A script an executor added to the dashboard would therefore also run in the phone app. On a phone whose Client ID is pinned, it could record a decision as `access_device` without any dialog while Robert has the app open. The Windows travel shell is in the same position.
  - Robert's ruling accepts a separate credential for the phone, so this run records the residual instead of closing it. A confirmation outside the phone's WebView would need a change to the Android app, which this task may only read.

## Code review

### QA round 1 gate

The code-review gate (medium effort) reported eight findings. Product changes this round are limited to the failed criteria; criterion 4 (Option A as implemented) passed QA and is settled, so findings about the first version's dialog coverage are retained, not changed.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | With the pause removed, a script can put up one dialog after another | important | **Kept removed.** QA required removing unsourced policies. Stated in the contract (Limits, "Repeated asking"); put to Robert with the old values for reference (retained suggestion 4) |
| 2 | An unanswered dialog keeps every other confirmation `busy` until its request ends (on the dashboard path, up to the proxy timeout, 21 minutes by default) | important | **Kept.** Same reason. Stated in the contract ("Busy while open"); a late click records only if the record is unchanged; put to Robert (retained suggestion 4) |
| 3 | A document email's bound HTML part (`metadata.html_body`) is neither named in the send dialog nor carried in the confirmed identity | important | **Retained** (suggestion 6). The bound part is an approved HTML document revision that Praxis re-verifies before delivery (`dashboard/src/lib/mail-drafts.ts:14-20`), but Robert does not see in the dialog that it exists |
| 4 | The decision dialog names other `selection` keys but not their values, and names none when the selection has no direction | important | **Retained** (suggestion 7). The confirmed identity binds the whole selection (`server/routes/documents.js:1893-1896`) |
| 5 | A Praxis draft sent without a version gets a generic 400 with no code | nit | **Retained** (suggestion 8) |
| 6 | The finish screen's "confirm on your Mac" hint follows `sendableCount`, while the server asks whenever stored answers exist | nit | **Retained** (suggestion 8) |
| 7 | `excerpt` and `oneLine` can cut inside a surrogate pair | nit | **Retained** (suggestion 8); display shortening only |
| 8 | This report still described the timeout and paused results | nit | **Fixed** in this rewrite |

### Earlier gate (`cdad4ab6`)

Six findings: five fixed in `cdad4ab6` (the footer survives any cut; a document email the store would refuse is refused before the dialog; a client gone before the dialog is refused without asking; the paused wording; a Praxis draft's HTML part is named and hashed), one pre-existing and stated (other operator routes). QA round 1 then removed the pause itself, so the paused wording fix no longer applies. Red/green for that gate: `code-review-red-green.txt`.

## Gates

On the final tree (HEAD `8cf041e9` plus this round's uncommitted changes):

| Gate | Result |
|---|---|
| Affected and MCP security suites (14) | 275 of 275 pass |
| Confirmation tests, red/green | 5 failed of 26 on `8cf041e9`; 26 of 26 now (`qa-repair-red-green.txt`) |
| Full server jest | 2438 pass, 1 skipped, 2 fail (2441 tests). The same two tests fail the same way on the baseline `fddc44b5` (`baseline-failures.txt`) |
| Dashboard `npm test` | 1342 of 1344 pass; the same two tests fail on the baseline (`baseline-failures.txt`) |
| Dashboard typecheck | `tsc --noEmit` exit 0; `dashboard/tsconfig.json` unchanged |
| Live, unattended, final code | Chrome 120 of 120; webview 67 of 67; both bound to the current file hashes |
| Live, attended, final code | Chrome run 2: 196 of 196; webview 87 of 87; Chrome run 1: 130 of 166, every failure from Robert confirming the four dialogs the page labeled Cancel ("Run 1"). All three are bound to HEAD `8cf041e9` and the current file hashes |
| Encoding | Strict UTF-8 decode and mojibake scan over every file this round changed or added: 0 problems; `git diff --check` clean |
| Recovery recheck, same tree (2026-11-20 23:57 to 2026-11-21 00:00 UTC) | Both receipts byte-identical to the recovery archive, every registered artifact matching its receipt hash and fresh, all five current reports bound to HEAD `8cf041e9` and 15 of 15 current file hashes, every click verified again. Rerun with the same results as above: full server jest (2438 pass, the same 2 baseline failures), the 14 suites (275 of 275), the confirmation suite (26 of 26), dashboard `npm test` (1342 of 1344, the same 2 baseline failures) and the typecheck (exit 0) (`recovery-recheck.txt`) |
| QA round 2 recheck, same tree (2026-11-21 00:45 UTC) | Robert's two answers read from Praxis `hitl.db` opened read-only; all five current reports bound to HEAD `8cf041e9` and 15 of 15 current file hashes; confirmation suite 26 of 26; strict UTF-8 and mojibake scan of this report and `qa-round-2-ruling.txt`: 0 problems; `git diff --check` clean (`qa-round-2-ruling.txt`) |

## Limits

- **A confirming click is a confirmation.** The dialog cannot tell a click Robert meant from a habitual one. In run 1 he confirmed the four dialogs the page had asked him to cancel, and the server recorded each of them, as designed. The dialog names the action and its subject, defaults to Cancel and says "If you did not just ask for this in Nexus, click Cancel", but it protects only as well as it is read.
- **The installed desktop app was not driven.** Robert accepted the webview stand-in in its place (2026-11-21, read as option B). The stand-in has no code-signature attestation of its own (the harness pins its process instead) and runs against the isolated API, not the live hosts; see "The installed desktop app".
- **Accessibility.** The dialog proves a click on this Mac, not who clicked.
  - macOS lets a same-user process that holds the Accessibility permission press buttons in other apps' windows, so while the screen is unlocked such a process could answer the dialog. Not exercised: `dialog-probe` cannot press.
  - This executor tree holds that permission: in the attended runs, with the screen unlocked, `dialog-probe read` reached every clicked dialog's text and buttons (`"trusted": true`).
- **Key file.** `/Volumes/Projects/.fleet-env` (mode 600, same user) holds the operator key and the Praxis relay key.
  - Praxis keeps the Nexus keys out of executor environments (`Praxis/src/config.ts:273`; none of the three keys was in this executor's environment).
  - The file is still readable. A process that reads it can use the operator bearer, which is never asked, or sign a relay to Praxis directly.
  - The parent contract already excludes this. A browser-side confirmation cannot close it.
- **Access sessions.** An Access session is ambient in the client that holds it, so the dialog does not cover a script running there.
  - **Device sessions.** The phone app and the Windows travel shell (see "Phone path").
  - **User session.** The email one-time-PIN login, which a browser holds, counts as an operator (`operator-access.js:6-7`, `:186`), and `NEXUS_OPERATOR_EMAIL` is set. A modified dashboard opened through the tunnel in such a browser could record without the dialog. No user-session operator verification appears in the retained logs.
- **Repeated asking and busy dialogs.** Without a pause, a script can put up one dialog after another; each defaults to Cancel, warns "If you did not just ask for this in Nexus, click Cancel." and records nothing unless clicked. While one dialog is open, other confirmations are refused as busy.
- **API restart during a dialog.** The Praxis supervisor signals only the API process (`Praxis/src/supervisor/processes.ts:290`, then `SIGKILL` after 5 seconds, `:282-287`) and the API has no signal handler, so an open dialog stays on screen until clicked; clicking it records nothing.
- **Not asked by design.** These keep the parent behavior: mail edit, cancel, return to Praxis and retry; content edits and comments; agent-review choices and decision-answer drafts; chat.
- **Other operator actions.** Robert's ruling covers sending mail and document decisions. Other routes accept the local session as the operator without a dialog, so a script an executor added to the dashboard could still use them while Robert has it open:
  - automatic starts (`server/routes/automatic-start.js:23`), project maintenance settings (`project-maintenance.js:26`), checkpoint and intake targets (`projects.js:562-567`), skill-candidate decisions (`skill-candidates.js:25`), the system map (`system-map.js:67`) and the agent-review operator actions (`document-agent-reviews.js:76-83`);
  - operator task dispatch (`server/services/task-dispatch-proof.js:11`, mounted at `server/routes/praxis-stream.js:654`) and the "Robert filed this" task label (`operator-task-origin.js:136-138`);
  - presentations (`server/routes/presentations.js:67`), chat (`ai-chat.js:318`) and Groundrules labeling (`server/services/groundrules-labeling/authority.js:43-48`).
  - None of them sends mail or records a document decision. Workspace-addition sanctions need an Access assertion (`server/services/contract-change-authority.js:106`), so the local session never reaches them.
- **Housekeeping.** Each Chrome run leaves its finished check tab open in Robert's Chrome (`http://127.0.0.1:4299/check?client=chrome`); six were opened on 2026-11-20 (four unattended, two attended) and can simply be closed.

## Retained suggestions

Not filed as tasks, per the brief:

1. **Accessibility.** Revoke the Accessibility permission from the executors' responsible process, or add a device-owner password step to the dialog for sends.
2. **Key file.** Run executors as a separate macOS user without read access to `/Volumes/Projects/.fleet-env`, or keep the operator and relay keys in the keychain with an access-control list.
3. **Access sessions.** Decide what Access sessions may do: keep decision authority, as now; require a native confirmation on their own device, outside the WebView in the phone app and the travel shell; or lose decision authority. This applies to user sessions and to the device sessions of the phone app and the travel shell.
4. **Time limits, if Robert sets them.** A give-up time for an unanswered dialog, and a pause after repeated unanswered dialogs. The removed version used 120 seconds, and three outcomes within ten minutes pausing five minutes; none of those numbers had a source. Robert was asked on 2026-11-20 and gave no numbers; none were added back.
5. **Other operator actions.** Decide whether the Mac confirmation should also cover the routes listed under "Other operator actions" in Limits, operator task dispatch first. Separately, Groundrules labeling records a local session as `access_user`, because only device sessions are told apart there (`server/services/groundrules-labeling/authority.js:47-48`).
6. **Document email HTML part.** Name a bound HTML revision in the send dialog and carry its sha256 in the confirmed identity.
7. **Decision selection.** Show every selection value in the dialog, or refuse selection keys other than `direction` on the local session.
8. **Small fixes.** A specific code for a Praxis draft without a version; base the finish hint on the server's condition; cut `excerpt` and `oneLine` without splitting a surrogate pair.
9. **Habituation.** Run 1 showed confirming clicks on dialogs the operator was meant to cancel. If that matters for sends, the dialog could ask for more than one click, for example typing the recipient's domain, or show a send's recipient as the button label.
10. **A look in the installed app after landing (optional).** Robert's ruling accepted the stand-in, so this is not a condition of the task. Once this branch has landed and `:4000` has restarted, approve a synthetic document in The Nexus app, click Cancel once, and confirm that no decision was recorded.

## Repeat

```sh
node scripts/operator-confirmation-qa/live-check.cjs --client chrome
node scripts/operator-confirmation-qa/live-check.cjs --client webview
node scripts/operator-confirmation-qa/live-check.cjs --client chrome --attended
node scripts/operator-confirmation-qa/live-check.cjs --client webview --attended
npx jest server/__tests__/operator-confirmation.test.js --forceExit
```
