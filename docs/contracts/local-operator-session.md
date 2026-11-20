# Automatic local operator session

Task: `5f15ca0f-17b1-48a7-aa93-61f212fcabf6`.
Robert's 2026-10-26 ruling removes the separate operator sign-in. The Mac app
and the configured Google Chrome profile establish and renew the session
silently. No operator password form remains; old `/operator-sign-in` links
redirect home. The tunnel, phone and Windows travel shell still use Access.

## Proof and boundary

The server verifies the **actual client end of the live TCP connection** with
macOS `lsof`, then the peer's UID, start time, parent and running code using
`ps` and `codesign --verify --verbose=1 -R <pinned requirement> PID`, with
`--strict` for the native app and `--strict=symlinks` for Chrome.
A numeric PID selects dynamic validation; verbosity also requires a full static
check (macOS `codesign(1)`, OPERATION; [Apple code-signing guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)). The exact
socket tuple and process generation are rechecked afterward. Neither a PID
header, Origin, User-Agent, loopback address nor `local_user` grants authority.

Chrome's fixed policy permits sideband FinderInfo and ResourceFork metadata,
which can remain after an ordinary browser restart. It retains dynamic code
validation, full static signature/resource checks, the Google signing
requirements, and strict sealed-symlink checks. Apple's [resource validator](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/StaticCode.cpp#L1720-L1797)
keeps these integrity checks separate from optional sideband rejection. No
signature failure triggers a weaker fallback. The native app retains all
strictness checks.

Eligible peers are the explicitly pinned, hardened `/Applications/The Nexus.app`
executable launched through the desktop, or the signed Google Chrome network
service with its signed main process, configured console UID, launchd parent
and ordinary profile. Chrome is pinned to its installed path, signing identifiers
and Google team `EQHXZ8M8AV`. Only a small allowlist of ordinary launch arguments
is accepted; single/double-dash automation, debugging, custom profiles and unknown
switches fail closed. WebKit network helpers and Node/Next proxies never qualify.
The native app bootstraps through its own Rust TCP connection, not WebKit's.

After that check, Nexus issues two independent 256-bit secrets: an opaque
HttpOnly cookie authenticated with HMAC-SHA256 by the independently configured
operator key (`nexus-local-operator/v1` domain), and a random proof returned
only in the bootstrap response body. Only hashes of the pair, expiry, device
kind and configuration fingerprint are retained in memory. **Every local
operator request needs both the cookie and `X-Nexus-Local-Proof`, a valid HMAC,
live server state, a direct loopback socket and the exact dashboard Origin.**
GET/HEAD can use the same-origin Referer when browsers omit Origin.

The cookie is host-only (native WKWebView uses localhost), HttpOnly,
SameSite=Strict and scoped to `/api`. HTTP localhost is the existing shell
transport. Cookies are shared across ports, so a cookie alone is deliberately
insufficient: the second proof lives only in `http://localhost:3000` localStorage
under `nexus:local-operator-proof`. Another localhost port cannot read that
origin's storage. Clients attach the proof only to exact same-origin `/api`
URLs and refuse redirects for proof-bearing requests. Bootstrap does not accept
old cookies, proof headers, bearer credentials or forwarded addresses as root
proof; every issuance repeats OS verification. No operator key enters the app,
JavaScript, browser storage, URLs, logs, task records or client response.

The bootstrap's sole direct API call is necessary to retain the kernel peer:
Next's normal proxy would identify Node instead of Chrome. All mail/document
and chat actions retain the ordinary dashboard `/api` proxy. Bootstrap requires
the exact dashboard Origin, permits its same-site cross-port fetch, returns
credentialed CORS only for that dashboard, and uses a shared rate limit.
Service, bridge and Cloudflare service-token headers are rejected. Access
assertions retain precedence and unchanged signature/profile verification.
Local failures expose only fixed `claim-rejected` / `local-session` diagnostics.

This proves a request came through the pinned operator UI, **not that a human
personally clicked**. Since 2026-11-20 sending mail and every document
decision made through the session also wait for Robert's answer to a native
macOS dialog (see "Per-action confirmation" below). Other operator actions the
session is accepted for do not ask (see "Other operator actions" under that
section's Limits). It does not defend an already-compromised browser,
profile, extension, trusted dashboard code, UI automation of Robert's existing
session, or unrestricted modification of the API/configuration/operator-key
files. The entire application already depends on protecting those resources.
Plain HTTP callers, QA/executor processes, newly launched automated profiles
and another local web server with only a captured cookie remain refused.
Safari and other browsers are not automatically trusted by this contract.

## Provisioning (deployment, no operator sign-in)

1. Keep the server's existing `NEXUS_OPERATOR_APPROVAL_KEY`, at least 32
   characters and distinct from runtime/document-executor keys, private.
2. In the ignored Nexus server environment set `NEXUS_LOCAL_OPERATOR_SESSIONS=1`
   and `NEXUS_LOCAL_OPERATOR_UID` to Robert's verified console UID (`id -u` and
   the owner of `/dev/console` must agree). Enable the installed browser with
   `NEXUS_LOCAL_OPERATOR_CHROME=1`. An absent UID or absent application pins
   fails closed. These settings are not credentials and never replace proof.
3. Build the Mac shell with `cd desktop && npm run build`. Sign the built app
   with hardened runtime (`codesign --force --options runtime --sign - <app>`
   for this locally pinned build), verify it, and install it as
   `/Applications/The Nexus.app`. Set `NEXUS_LOCAL_OPERATOR_DESKTOP_CDHASH` to
   the signed installed executable's 40-hex `CDHash` from
   `codesign --display --verbose=4 <app>`. Re-pin after an app rebuild/update.
   The running native code must have hardened runtime and match that hash.
4. Restart the supervised Nexus API, reopen the Mac app, and reload the local
   dashboard browser. The dashboard and native shell bootstrap automatically.
   Chrome must be its ordinary default profile, not headless/CDP/custom-profile
   testing. If an update replaced its on-disk code while the old process still
   runs, restart Chrome: signature failure is never bypassed.
5. Open `/session` in either client. Its API verdict must show operator with
   identity `local`; the absence of an Access session on localhost is expected.
   Status responses never show the proof. No real mail need be sent to verify
   session establishment.

The native shell accepts only a fixed renewal signal from its local main view,
plants the HttpOnly cookie, then checks the current origin again inside the
same JavaScript evaluation that stores the separate proof. Navigation cannot
leak it to a remote page. Browser bootstrap is serialized across tabs with
Web Locks where available and always rechecks cookie/proof agreement afterward.
Mail/document mutations and chat sends preflight the session; the background
45-minute check renews a one-hour session when less than 20 minutes remain.
No failed business action is automatically retried by the session mechanism.

## Revocation

- `DELETE /api/operator-session` deletes that server entry and clears its cookie.
  The captured pair is no longer useful. An eligible UI may bootstrap again.
- Restart the API to revoke all active entries; no sessions are restored from disk.
- To revoke and prevent reissuance, disable the feature, remove the relevant app
  pin, change the pinned UID, or remove/rotate the signing key, then restart.
  Configuration fingerprint changes invalidate old sessions as well.
- The one-hour expiry applies even if the client retains its cookie/proof.
  Missing or unavailable OS checks, short/colliding keys, invalid pins and a
  different console user all fail closed; unconfigured is never enabled.

## Authority and wire contract

`GET /api/operator-session` returns status, optional expiry and a fixed local
bootstrap URL derived from the API socket port, never credentials.
`POST /api/operator-session/bootstrap` returns 201 `{operator:true, proof,
expiresAt}` and Set-Cookie only after OS verification. It accepts no request
credential. Fixed refusals are 403 `operator_required`, 503
`operator_credential_unconfigured`, or 429 for the limiter. The retired
credential-exchange POST at `/api/operator-session` returns 410. All responses
are `Cache-Control: no-store`; session tokens and proofs must not be logged.

`operator-access.js` reports identity `local`. The document ledger retains
`operator_credential`, signed by the server's operator authority, with
`recorded_by: operator` and the existing Robert dashboard actor id `local_user`.
This preserves downstream operator allowlists and delegated-review checks.
Praxis receives the unchanged body-bound `mail-drafts` provenance surface and
records `operator:mail-drafts`. Chat uses its existing provenance surfaces.
The separate stakeholder bearer API is not broadened. This task wires mail,
documents, text/voice chat and session diagnostics; it makes no promise about
other cockpit consumers of the shared authenticator.

## Verification

Local session/peer/flow Jest suites exercise both proofs, app pin checks,
forged headers, wrong users/origins, altered code, automated profiles, socket
changes, captured cookies, expiry/revocation, document ledgers and mail signatures.
Existing Access/provenance, document/executor, stakeholder and MCP security tests
remain part of the gate. The dashboard build and isolated browser flow exercise
all five requested actions with synthetic data and an injected OS peer fixture;
they do not claim real email delivery. Native build/tests and actual client
Session Check observations verify the deployment separately. Exact evidence
and limitations are retained in the task's review report and evidence JSON.

## Per-action confirmation (Option A, task 5e513530)

Robert's ruling of 2026-11-20 (Option A): browsing, reading and bootstrap stay
click-free, but sending mail and every document decision made through this
local session record nothing until Robert answers a native macOS dialog that
names the exact action and subject. The stored session cannot produce that answer, and
neither can page JavaScript or an executor-edited script. The stored session
means the cookie and proof, including the desktop app's renewed proof.

### Actions that ask

| Action | Route | Dialog |
|---|---|---|
| Approve sending a document's email | `POST /api/documents/:id/outgoing/decision` with `approve_send`, exact draft only (`server/routes/document-outgoing.js`). A send the store would refuse (stale or invalidated revision, changes requested, no operator copy) is refused before asking | "Nexus: send this email?" `Send to <to>: "<subject>"?`, the Cc line and the message. Button **Send** |
| Send a Praxis Mail draft | `POST /api/praxis/mailbox/drafts-review/:id` with `approve_send` (`server/routes/mail-draft-review.js`) | The same wording, built from Praxis's own draft list, never from the request. When the draft also has an HTML part, a line says so and gives its length: most mail apps show that part, and the dialog cannot render it |
| Approve a document, or request changes | `POST /api/documents/:id/decisions` (`server/routes/documents.js`) | "Nexus: approve this document?" or "Nexus: request changes?" Title, version, revision id, content sha256 prefix, direction and note. Button **Approve** or **Request changes** |
| Finish a review that grants approve-after-changes or carries decision answers | `POST /api/documents/reviews/:id/finish` | "Nexus: finish this review?" The grant sentence, each answer, the comment count and the summary. Button **Approve after changes** or **Send answers** |

### How the dialog works

`server/services/operator-confirmation.js` runs the dialog.

- **Who shows it.** The API process itself runs `/usr/bin/osascript` (`display dialog`) inside the same HTTP request.
- **Defaults.** Cancel is the default button, so Return or Escape never confirms. The dialog gives up after 120 seconds.
- **Text.** Every string reaches the script as an argument. Control, bidirectional and zero-width characters are removed from the dialog text. Long text is shown as an excerpt that says how much of it is shown. If the whole text would still pass 4000 characters (a very long recipient or answer list), it is cut with a note giving the exact number of characters left out.
- **Footer.** It always shows, after a blank line, even when the text above it was cut. It names the client (Google Chrome or The Nexus app), the dashboard origin, the time, and a short reference. The response and the server log repeat that reference.
- **Nothing to forge.** The request carries no confirmation token, header or field, so there is nothing to forge or replay. Forged fields are ignored.

### What a confirmation is bound to

Each confirmation is bound to the canonical identity of what the dialog showed:

- **Document decision:** document id, revision id, content hash, decision, selection, and the sha256 of the note.
- **Document email:** document id, revision id, envelope hash, to, cc, subject, and the sha256 of the text.
- **Praxis Mail:** draft id, version, to, cc, subject, the sha256 of the body, and the sha256 of the HTML part if there is one. Praxis gives every change, the HTML part included, a new version. The relay then sends only `{action: 'approve_send', version}`, and Praxis refuses any other version.
- **Review finish:** document id, review id, revision id, the grant, the answers, and the sha256 of the summary and of the comment set.

After the dialog:

1. The route reads the record again; for documents it also recaptures the file.
2. It consumes the confirmation inside the write: once, within 60 seconds, and only if the identity is unchanged.
3. Otherwise it answers 409 `operator_confirmation_mismatch`.

An identical retry with the same `client_decision_id` is answered from the record before any dialog. Any other repeat asks again.

### Refusals

Nothing is recorded, the response says so (`nothing_recorded: true`), and there is no fallback.

| Outcome | Status | Code |
|---|---|---|
| Robert clicked Cancel | 403 | `operator_confirmation_declined` |
| No answer before the dialog gave up | 403 | `operator_confirmation_timeout` |
| The dialog could not be shown, or its process ended | 503 | `operator_confirmation_unavailable` |
| Another confirmation is open (one at a time) | 409 | `operator_confirmation_busy` |
| Three dialogs declined, left unanswered or abandoned (the client went away while one was open) within 10 minutes; asking pauses for 5 minutes | 429 | `operator_confirmation_paused` |
| The client went away: before the dialog opened (it is never shown, and this does not count toward the pause) or while it was open (it closes with the request) | 409 | `operator_confirmation_aborted` |
| The record changed while the dialog was open | 409 | `operator_confirmation_mismatch` |

A request whose authority path is not recognized fails closed with 503.

### What does not ask

- **Other credentials.** These are not local-session requests. Their authority is unchanged, and they are never asked on the Mac:
  - Access sessions: the phone app and the Windows travel shell with their service tokens, or a browser after the Access login.
  - The operator bearer.
  - The document executor bearer.
- **Click-free actions.** These stay click-free in the local session:
  - browsing, reading and bootstrap;
  - mail edit, cancel, return to Praxis and retry;
  - direct content edits and comments;
  - agent-review choices and decision-answer drafts;
  - other consumers of the shared authenticator, such as chat.
- **Other operator actions.** The ruling covers sending mail and document decisions. Other routes that accept the local session as the operator keep the parent behavior and do not ask; see "Other operator actions" under Limits.

### Phone path

The phone rests on a separate operator credential, so it is not asked on the Mac:

- **Where phone approvals happen.** The Android app's own code calls no document, mail or decision route; its native tabs were retired on 2026-09-07 (`Nexus-Mobile-Android`, `app/(tabs)/_layout.tsx`). Phone approvals are made in the dashboard inside the app's WebView.
- **Where the credential lives.** The app (`lib/shell/session.ts`) holds a Cloudflare Access service token in SecureStore (`lib/config.ts`).
- **How it is used.** The app trades the token natively for the `CF_Authorization` cookie, and the token never enters web content.
- **How the server keeps the paths apart.** It takes the local-session path only for a request without an Access assertion (`operator-access.js`, `evaluate`). Access device identities are pinned by Client ID in `NEXUS_OPERATOR_DEVICE_IDS`.

The credential lives on the phone, not in the Mac session. It is still ambient inside the app: the WebView sends the Access session with every request, page-script `/api/*` fetches included. A script an executor added to the dashboard therefore runs there too, and on a phone whose Client ID is pinned it could record a decision as `access_device` without a dialog. Robert's ruling of 2026-11-20 accepts a separate credential for the phone; see "Access sessions" under Limits.

### Limits

- **Accessibility.** The dialog proves a click on this Mac, not who clicked.
  - macOS lets a same-user process that holds the Accessibility permission press buttons in other apps' windows, so while the screen is unlocked such a process could answer the dialog. This was not exercised: the console stayed locked during the recorded runs.
  - The executor process tree on this Mac holds that permission (`AXIsProcessTrusted()` was true on 2026-11-20).
  - While the console was locked on 2026-11-20, an Accessibility read from that tree found none of the dialog's contents, and a key event posted to the dialog process did not answer it.
  - Revoking Accessibility from the executors' responsible process, or adding a device-owner password step, would close this gap.
- **Key file.** `/Volumes/Projects/.fleet-env` (mode 600) holds the operator key and the Praxis relay key, and every process of the same user can read it.
  - Praxis keeps the Nexus keys out of executor environments, but not out of reach.
  - A process that reads the file can act as the operator bearer, which is not asked, or sign a relay to Praxis directly.
  - This is the key-file exclusion stated above. A browser-side confirmation cannot close it; separate users or keychain access control would.
- **Access sessions.** An Access session is an operator credential that the dialog does not cover, and it is ambient in the client that holds it.
  - **Device sessions.** In the phone app and the Windows travel shell, a script an executor added to the dashboard could record a decision as `access_device` while Robert has the app open, if that device's Client ID is pinned.
  - **User session.** The email one-time-PIN login, held by a browser. A modified dashboard opened through the tunnel in such a browser could record without the dialog.
  - The retained live logs on 2026-11-20 show 0 user verifications, against 155 device and 8 local.
  - Closing this needs a confirmation on the device that holds the session (outside its webview), or no decision authority for Access sessions. That is Robert's call and is retained in the task's review report.
- **Other operator actions.** Outside the ruling, these accept the local session as the operator without a dialog, so a script an executor added to the dashboard could use them while Robert has it open:
  - through the shared decision authority: automatic starts, project maintenance settings, checkpoint and intake targets, skill-candidate decisions, the system map, operator task dispatch, "Robert filed this" task labels, and the agent-review operator actions (`server/routes/automatic-start.js`, `project-maintenance.js`, `projects.js`, `skill-candidates.js`, `system-map.js`, `document-agent-reviews.js`; `server/services/task-dispatch-proof.js`, `operator-task-origin.js`);
  - through the shared authenticator: presentations, chat and Groundrules labeling (`server/routes/presentations.js`, `ai-chat.js`, `server/services/groundrules-labeling/authority.js`).
  - None of them sends mail or records a document decision. Workspace-addition sanctions (`server/services/contract-change-authority.js`) need an Access assertion, so the local session never reaches them.
  - Asking on these too would widen the ruling. That is Robert's call and is retained in the task's review report.
- **What the dialog shows.** A page can show anything. The dialog shows only server records (excerpts for long text), so judge by the dialog, not the page.

### Verification

- **Unit tests.** `server/__tests__/operator-confirmation.test.js` covers:
  - the broker and the osascript runner (with an injected exec);
  - each route;
  - replay, mismatch, busy, pause and abort;
  - refusals before asking, the long-dialog cut and the HTML-part line.
- **Live check.** `scripts/operator-confirmation-qa/live-check.cjs` runs the real session store, kernel peer check, routes and osascript dialog against:
  - Robert's own Google Chrome;
  - a WebKit host that sets up the session the way the desktop app does.

  Its README explains how answers are given while the console is locked.
- **Results.** Evidence and results are in `docs/reviews/2026-11-20-operator-confirmation.md`.

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
