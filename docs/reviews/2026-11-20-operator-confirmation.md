# Per-action Mac confirmation (Option A): review report

| | |
|---|---|
| Task | `5e513530-0d18-5939-87b8-583274b5bf5e`, the QA follow-up of `5f15ca0f` |
| Date | 2026-11-20 |
| Branch | `praxis/run/5e513530-0d18-5939-87b8-583274b5bf5e` |
| QA baseline | `fddc44b5` |
| Commits | `ec55f35c` (server), `5216b80a` (dashboard), `4372f1dc` (live harness), `c3aebd10` (live evidence) and the commit that adds this report |
| Contract | `docs/contracts/local-operator-session.md`, section "Per-action confirmation" |
| Evidence | `docs/reviews/2026-11-20-operator-confirmation/live-chrome.json` and `live-webview.json` |

## Outcome

A decision made through the local operator session no longer records on the session alone. The covered actions are:

- approving a document or requesting changes;
- approving a document's email for sending;
- sending a Praxis Mail draft;
- finishing a review with the approve-after-changes grant or with decision answers.

Each one now waits until Robert answers a native macOS dialog that names the exact action. The Nexus API process shows that dialog itself (`/usr/bin/osascript`), inside the same request. Browsing, reading and bootstrap stay click-free.

The live check ran a page script in two clients: Robert's own Google Chrome (the real kernel peer check identified it) and a WebKit webview host. It shows four things:

- A page script holding the stored session cannot record any of these actions without the dialog.
- Forged confirmation fields and replays are refused.
- A confirmed action records exactly once with the confirmed identity.
- Every other outcome refuses with a reason and records nothing.

None of this is live yet. It takes effect when this branch lands and the `:4000` API restarts. After landing, the dashboard's `next dev` on `:3000` picks up the dashboard copy on its own.

## Dispositions

| Item | Disposition | Rationale and evidence |
|---|---|---|
| Suggestion 1, objection 1: an executor edits the dashboard and drives Robert's Chrome or the desktop webview to record decisions | **Implemented** (Option A, as Robert decided at 14:19 EST) | `server/services/operator-confirmation.js` plus the four routes. A stored session alone gets 403 and records nothing. Evidence: Chrome steps S02, S03, S06 and S09; webview steps W02, W03 and W05; jest `server/__tests__/operator-confirmation.test.js:242`. |
| Suggestion 1, objection 2: the decisions were proven only with a stubbed OS attestation, and the desktop app was never exercised | **Implemented, with two stated gaps** | **Done.** The live check uses the real peer verifier against Robert's running Chrome, not a stub (`live-chrome.json:2892` device `mac-chrome`, `:2900` Chrome's network service). It then records real decisions, sends and a delegating finish through the real routes and real osascript dialogs.<br>**Gap 1: answers.** The console was locked for the whole run, so the five answered dialogs were stand-ins (see Limits). `--attended` repeats the run with Robert's clicks.<br>**Gap 2: desktop app.** The installed desktop app only talks to the live `:4000` and `localhost:3000` (`desktop/src-tauri/src/local_operator.rs:34-43`), and the brief forbids touching live data. A WebKit host that reproduces its bootstrap stands in. The harness pin admits that host only after the real verifier has declined it (`scripts/operator-confirmation-qa/live-check.cjs:176-185`; `live-webview.json:900-901`). |
| Option B: wall executors off from the dashboard | **Declined** | Robert rejected it in the same decision. |
| Phone approvals | **Protected by a separate operator credential**; no change, one residual recorded | See "Phone path" below. |
| The reviewer's pass rationale ("The five decision actions were exercised on synthetic data rather than a real draft or document") | **Superseded** | The objections stand. Option A changes the guarantee, and the live evidence replaces the stubbed run. Synthetic data is kept on purpose: no real mail is sent and no real document is decided. |

## What changed

- **Server (`ec55f35c`)**
  - **New broker.** `server/services/operator-confirmation.js` (dialog, refusals, single-use binding, pause, abort).
  - **Authority now reports the path it took.** `document-decision-authority.js` returns `via` (`local_session`, `access_session`, `operator_bearer`, `document_executor_bearer`) and the device (`:102-104`, `:118`).
  - **Each route confirms, then re-reads and consumes:**
    - document decisions and review finish (`server/routes/documents.js:1897-1956`, `:2752-2835`);
    - document email (`server/routes/document-outgoing.js:116-135`);
    - Praxis Mail (`server/routes/mail-draft-review.js:39-62`).
  - **Unknown paths fail closed.** A `via` other than the local session or a never-asked path is refused with 503 (`operator-confirmation.js:161`, `:76`).
  - **Tests.** New `server/__tests__/operator-confirmation.test.js`, plus updated local-flow and agent-review tests.
- **Dashboard (`5216b80a`)**
  - The mail and document screens say "Confirm on your Mac" while the dialog is open.
  - Each refusal is explained.
  - A mismatch reloads the record.
- **Harness (`4372f1dc`)**
  - `scripts/operator-confirmation-qa/` with a README.
  - The broker takes an `origin` label (default `localhost:3000`) so the harness dialog names its own port.
  - The mail relay log line names the confirmed version.
- **Evidence (`c3aebd10`).** The two JSON files.
- **Docs.** The contract section, this report and README wording.

## Live evidence

**The page.** The page served at `/check` plays the part of a script an executor added to a dashboard page (`scripts/operator-confirmation-qa/check-page.html`). It runs in the client under the session's pinned origin, holds the same HttpOnly cookie and stored proof, and calls the same routes. Nothing in a request tells the server which page a script came from. The isolated API serves the page on its own origin, so the run never touches the live `:3000` or `:4000`.

### Robert's Chrome

`node scripts/operator-confirmation-qa/live-check.cjs --client chrome` ran from 2026-11-20 20:56:07 to 20:57:41 UTC. Result: 169 of 169 checks (`live-chrome.json:3195`), 14 osascript dialogs. The console was locked at the start and at the end (`live-chrome.json:2861`, `:2991`).

**Boot.** The page opened the session with no click:

- before: `operator: false`;
- bootstrap: 201;
- after: `operator: true`.

The real verifier accepted the connection. It came from Chrome's network service helper (`Google Chrome Helper (Aperitif)`, pid 73516), whose parent is the interactive Google Chrome (ppid 1).

| Step | The page script tried | Answer | Result |
|---|---|---|---|
| S01 | Five reads | none | 200 each; no dialog |
| S02 | Approve document A with the stored session only | left alone | 403 `operator_confirmation_timeout`; no decision |
| S03 | The same with forged `confirmed`, `confirmation_ref`, `via` and `x-nexus-confirmation` fields and headers | left alone | 403 timeout; the dialog asked anyway; no decision |
| S04 | Approve A with `client_decision_id` | confirm (stand-in) | 201; exactly one decision with the confirmed revision, content hash, decision and note, `operator_credential`, `local_user`, `recorded_by: operator`. The dialog Ref matches the response and the server log |
| S05 | Replay S04 exactly, then repeat it without its idempotency key | left alone | Replay: 200, the same record marked `duplicate`, before any dialog. Repeat: asked again, 403 timeout. Still one decision |
| S06 | Approve sending B's email, stored session only | left alone | 403 timeout; still a draft with no send grant |
| S07 | The same | confirm (stand-in) | 200 approved; the send grant is for exactly the confirmed envelope; one approval event |
| S08 | Replay S07 | none | 200 with the same approval; no dialog; still one event |
| S09 | Send the Praxis draft with forged `to`, `cc`, `subject` and `body` | left alone | 403 timeout. The dialog named `harness-member@example.test` and none of the forged values. Nothing reached Praxis |
| S10 | The same forged request | confirm (stand-in) | Exactly one signed relay, carrying only the confirmed version |
| S11 | Replay S10 | none | 409 before any dialog; still one relay |
| S12 | Finish review C with the approve-after-changes grant | decline (stand-in) | 403 `operator_confirmation_declined`; still a draft without the grant; no submission |
| S13 | The same | confirm (stand-in) | 202; submitted once, with the grant, on `operator_credential` |
| S14 | Approve D while the dialog process ends before any answer | none | 503 `operator_confirmation_unavailable`; the dialog is gone; no decision (no fallback) |
| S15 | Approve D, then abort the fetch while the dialog is open | none | Aborted; the dialog closed with the request; no decision |
| S16 | Two decisions on D at once | left alone | First 403 timeout, second 409 `operator_confirmation_busy` |
| S17 | Request changes on D: the third declined, unanswered or aborted dialog in a row (after S15 and S16) | left alone | 403 timeout |
| S18 | Approve D right away | none | 429 `operator_confirmation_paused`; no dialog; D has no decision |

**Checks on every dialog:**

- the window server listed its window, owned by `osascript`;
- the title, the action line and the button name the action;
- osascript received exactly that title and text as arguments;
- the footer says "Requested by Google Chrome on 127.0.0.1:4299".

**End of run.** The page revoked its session (200) and removed the stored proof.

### WebKit webview host (stand-in for the desktop app)

`node scripts/operator-confirmation-qa/live-check.cjs --client webview` ran from 20:57:47 to 20:58:22 UTC. Result: 57 of 57 checks (`live-webview.json:1119`), with the console locked throughout (`:873`, `:985`).

The webview host loaded the page. Native code then did what the desktop app does (`live-webview.json:1095-1099`):

- bootstrapped the session;
- planted the HttpOnly cookie through WebKit's cookie store;
- stored the proof with the desktop app's origin-checked evaluation.

The real verifier declined the host, as it should. The harness pin then admitted it as `mac-desktop`.

| Step | Result |
|---|---|
| W01 | Five reads: 200, no dialog |
| W02 | Approve with the stored session only: 403 timeout; no decision. The dialog says "Requested by The Nexus app on 127.0.0.1:4299" |
| W03 | Praxis send with forged fields: 403 timeout; the dialog shows none of the forged values; nothing reached Praxis |
| W04 | Approve, confirmed (stand-in): 201, exactly one decision with the confirmed identity |
| W05 | Approve sending B's email, stored session only: 403 timeout; still a draft with no send grant |

### Server boundary (jest)

`server/__tests__/operator-confirmation.test.js` covers the same paths:

- `:300`: the desktop session;
- `:133`, `:263` and `:282`: replay and single use;
- `:292`: a file that changes during the dialog;
- `:362` and `:417`: a comment or an email edit that lands during the dialog.

## Phone path

Phone approvals rest on a separate operator credential, not on the Mac session, so they are not asked on the Mac.

- **Where phone approvals happen.** The Android app's own code calls no document, mail or decision route. A `git grep` over its TypeScript for `/documents`, `mailbox`, `drafts`, `approve_send`, `operator-session`, `/decisions`, `/finish` and `outgoing` found nothing. Its native tabs were retired on 2026-09-07 in favor of the dashboard shell (`Nexus-Mobile-Android/app/(tabs)/_layout.tsx:1-12`). Phone approvals are therefore made in the dashboard, inside the app's WebView.
- **The credential lives in the app.** The app holds a Cloudflare Access service token in SecureStore (`lib/config.ts:59-75`). It trades the token natively for the `CF_Authorization` cookie, and "the credentials themselves never enter web content" (`lib/shell/session.ts:1-17`, `:32-48`). The headers are built in `lib/auth.ts:21-26`.
- **The server keeps the paths apart.**
  - It takes the local-session path only for a request without an Access assertion (`server/services/operator-access.js:147-151`).
  - An Access device identity needs a pinned Client ID (`operator-access.js:190-194`) and is recorded as `access_device` (`document-decision-authority.js:96-104`).
  - Its `via` is `access_session`, which is never asked (`operator-confirmation.js:46`, `:160`; `mail-draft-review.js:40`).
- **Live logs agree.** The retained live logs (`/Volumes/Projects/Praxis/data/logs/launchd-stdout.log` and `.log.1`) show 155 `operator verified (identity=device)` lines, 8 `identity=local` lines and 0 `identity=user` lines.
- **Residual.** A separate credential is not a per-action confirmation.
  - The WebView carries the Access session on every request it makes, `/api/*` fetches from page scripts included (`lib/shell/session.ts:9-12`).
  - A script an executor added to the dashboard would therefore also run in the phone app. On a phone whose Client ID is pinned, it could record a decision as `access_device` without any dialog while Robert has the app open. The Windows travel shell is in the same position.
  - Robert's ruling accepts a separate credential for the phone, so this run records the residual instead of closing it. A confirmation outside the phone's WebView would need a change to the Android app, which this task may only read.

## Gates

Rerun on the final tree (HEAD `c3aebd10` plus these docs):

| Gate | Result |
|---|---|
| Affected and MCP security suites (14) | 270 of 270 pass |
| Full server jest | 2433 pass, 1 skipped, 2 fail. The two failures fail the same way on a detached worktree of the baseline `fddc44b5`, so they predate this work and are unrelated: `praxis-stream` "ignores X-Forwarded-For and judges loopback by the socket peer" and `studio-route` "the enrich endpoint drains un-enriched objects and reports remaining" |
| Dashboard `npm test` | 1342 of 1344 pass. The two failures also fail on the baseline: `routing-economics` (expects "$2.525 estimate"), and `daily-journal-tabs`, which reads `../nexus-shared` relative to the worktree |
| Dashboard typecheck | `tsc --noEmit` exit 0; `dashboard/tsconfig.json` unchanged |
| Encoding | Strict UTF-8 decode, mojibake and added-line em-dash scan over every file this task changed: 0 problems; `git diff --check` clean |

## Limits

- **Answers were stand-ins.** The Mac stayed locked. The console had been idle 1884 seconds when the Chrome run started.
  - With the console locked, an Accessibility read from this executor tree found no dialog contents, and a key event sent to the dialog process did not answer it. Both were tested in this run.
  - For the five answered dialogs, the harness therefore closed the real dialog and handed the broker the planned answer.
  - The evidence marks each one `answer_source: "stand-in (console locked)"`. Each record shows the window the window server listed before the answer and no window after it (for example `live-chrome.json:605` and the S04 record above it).
  - Those records' `action` text says "no process can press". That overstates what was tested, which was this harness's read and key event. The harness now says "the harness cannot press" (`scripts/operator-confirmation-qa/live-check.cjs:234`). The evidence files stay exactly as generated.
  - What the stand-in leaves unproven is only the step from Robert's click to osascript printing `confirmed`. Jest covers that mapping with an injected exec (`operator-confirmation.test.js:214`).
  - `--attended` repeats the run with Robert's own clicks.
- **The installed desktop app was not driven** (see Dispositions). After landing and the `:4000` restart, Robert can check it by hand: approve any document in the Mac app, click Cancel in the dialog, and see that nothing was recorded.
- **Accessibility.** The dialog proves a click on this Mac, not who clicked.
  - macOS lets a same-user process that holds the Accessibility permission press buttons in other apps' windows. While the screen is unlocked, such a process could therefore answer the dialog.
  - This path was not exercised, because the console stayed locked.
  - This executor tree holds that permission (`AXIsProcessTrusted()` reported `true`).
  - `dialog-probe` only presses dialogs from an osascript process that its own harness started, but a hostile process could write its own.
- **Key file.** `/Volumes/Projects/.fleet-env` (mode 600, same user) holds the operator key and the Praxis relay key.
  - Praxis keeps the Nexus keys out of executor environments (`Praxis/src/config.ts:273`; none of the three keys was in this executor's environment).
  - The file is still readable. A process that reads it can use the operator bearer, which is never asked, or sign a relay to Praxis directly.
  - The parent contract already excludes this. A browser-side confirmation cannot close it.
- **Access sessions.** An Access session is ambient in the client that holds it, so the dialog does not cover a script running there.
  - **Device sessions.** The phone app and the Windows travel shell (see "Phone path").
  - **User session.** The email one-time-PIN login, which a browser holds, counts as an operator (`operator-access.js:6-7`, `:186`), and `NEXUS_OPERATOR_EMAIL` is set. A modified dashboard opened through the tunnel in such a browser could record without the dialog. No user-session operator verification appears in the retained logs.
- **Not asked by design.** These keep the parent behavior:
  - mail edit, cancel, return to Praxis and retry;
  - content edits and comments;
  - agent-review choices and decision-answer drafts;
  - chat.
- **Housekeeping.** Each Chrome run leaves its finished check tab open in Robert's Chrome (`http://127.0.0.1:4299/check?client=chrome`). Two such tabs were opened on 2026-11-20, and they can simply be closed.

## Retained suggestions

Not filed as tasks, per the brief:

1. **Accessibility.** Revoke the Accessibility permission from the executors' responsible process, or add a device-owner password step to the dialog for sends.
2. **Key file.** Run executors as a separate macOS user without read access to `/Volumes/Projects/.fleet-env`, or keep the operator and relay keys in the keychain with an access-control list.
3. **Access sessions.** Decide what Access sessions may do:
   - keep decision authority, as now;
   - require a native confirmation on their own device, outside the WebView in the phone app and the travel shell;
   - or lose decision authority.

   This applies to user sessions and to the device sessions of the phone app and the travel shell.
4. **Real clicks.** Robert runs `node scripts/operator-confirmation-qa/live-check.cjs --client chrome --attended` once at the Mac for evidence with real clicks.

## Repeat

```sh
node scripts/operator-confirmation-qa/live-check.cjs --client chrome
node scripts/operator-confirmation-qa/live-check.cjs --client webview
node scripts/operator-confirmation-qa/live-check.cjs --client chrome --attended
npx jest server/__tests__/operator-confirmation.test.js --forceExit
```
