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
personally clicked**. It does not defend an already-compromised browser,
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
