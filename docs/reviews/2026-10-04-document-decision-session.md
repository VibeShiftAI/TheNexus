# Document decisions through Robert's existing session (2026-10-04, task a1cc8616)

Robert could not record "Request changes" on the Best Self Capital brief from
his signed-in Nexus session. The decision card answered "The operator
credential is not configured; no decision can be recorded with it. No decision
was recorded." This record traces the request and session path that produced
that refusal, names the root cause, and separates what the source fix proves
from what is live.

No decision, comment, email or Praxis restart was made by this task. Every
test ran against isolated fixtures (a temporary database, a fixture Access
issuer and a synthetic operator credential). No credential value appears here.

Round 2 (same day, after QA): the kept-note recovery and the isolated browser
run were added; the sections marked "round 2" and the timestamped activation
section record them. Nothing in round 2 touched the live database, :4000,
:3000 or Praxis either.

## Symptom

- Document `6daf8a8c-28d4-49b9-b53b-abe5874a73a8`, "Best Self Capital: draft
  product brief (not agreed)", declared for review.
- The screenshot (`data/chat-files/8b17001a-dda5-4b5e-8975-36fe07fe46c6.png`)
  shows the changed banner, a Request changes confirmation targeting rev
  `61ec17db` (revision `d3b72a76`, captured 16:57:12Z), the typed note, and the
  refusal.
- Database at dispatch: one draft review `895b402f` pinned to rev `faf67324`
  (revision `935345d6`, captured 16:51:43Z) with zero comments; zero decisions
  on the document; a newer revision `32aabb8e` captured 17:05:04Z. So the
  review was pinned to an older revision, the decision targeted the revision
  on screen, and nothing was recorded, exactly as the card said.

## Request and session trace

1. Browser to dashboard. The decision card calls `recordDecision` in
   `dashboard/src/lib/document-review.ts`, whose `request()` used `authFetch`
   from `dashboard/src/lib/nexus/shared.ts`. That helper merges
   `getAuthHeader()` from `dashboard/src/lib/auth.ts`, which always returns
   `Authorization: Bearer <NEXUS_SERVICE_KEY or 'local-dev-token'>`. The
   browser bundle has no non-public env, so the header is the placeholder;
   the live dev server's compiled chunks on disk contained `local-dev-token`.
2. Dashboard to API. `dashboard/next.config.ts` rewrites `/api/:path*` to
   :4000 and `dashboard/src/proxy.ts` passes the request headers through
   unchanged (it only logs a redacted trace). The Praxis log shows that trace
   for Robert's travel shell: `client=windows assertion=present
   kind=service-token ... audience=match issuer=match`, so a verified device
   session did reach the dashboard. The same proxy carries chat turns, and
   the API logged `[OperatorAccess] operator verified (identity=device)` for
   them, so the Access assertion header does propagate to :4000.
3. API. `server/server.js` stamps `local_user` on every documents request.
   `server/routes/documents.js` (`POST /:id/decisions`) calls
   `authorizeDecision`. Before this fix,
   `server/services/document-decision-authority.js` checked
   `req.get('authorization')` before `operator.inspect(req)`: any Authorization
   header sent the request down the operator-credential path,
   `requireStakeholderAuthority(req, 'operator')` in
   `server/services/stakeholder-authority.js`, which throws 503 when
   `NEXUS_OPERATOR_APPROVAL_KEY` is absent. It is absent on this host (neither
   `.env` nor `/Volumes/Projects/.fleet-env` defines it; checked by line
   count, not value). Result: 503 `operator_credential_unconfigured`, and the
   verified Access session was never inspected. With a key provisioned the
   same request would have been 403 (`The supplied credential is not Robert's
   operator credential`), because the placeholder is not the key. Either way
   the session path was unreachable from the dashboard.

Root cause: the dashboard's generic bearer placeholder, combined with an
authority that treated any bearer as the caller's chosen proof and checked it
before the session.

### Live reproduction (refusals only, nothing recorded)

Against the live API, with the real document and revision ids:

```
POST /api/documents/6daf8a8c.../decisions  + Authorization: Bearer local-dev-token
  -> 503 {"code":"operator_credential_unconfigured"}
POST /api/documents/6daf8a8c.../decisions  (no bearer)
  -> 403 {"code":"operator_required","reason":"assertion-missing"}
decisions on the document afterwards: 0
```

The second line shows the live code reaches the session check as soon as no
bearer is present; a request with Robert's assertion and no bearer is the path
the pre-existing test "a verified Access operator session (person or pinned
device) can decide" already proves.

## Fix

- `server/services/document-decision-authority.js`: the session is checked
  first, whatever Authorization header the request carries. Only a request
  with no verified session falls through to the bearer, which still fails
  closed when the key is unconfigured. Refusals on the bearer path now carry
  `reason` (what the session check found, for example `assertion-missing`),
  so a client can tell "no Access session here" from "wrong credential".
  Service users, bridge and executor headers, the runtime key, a wrong bearer,
  an unsigned local request, other people's sessions, unpinned devices and
  cross-site requests are refused as before. If the Access verifier itself
  fails, a bearer is still checked and a bare request gets 503
  `operator_check_unavailable` as before.
- `dashboard/src/lib/document-review.ts`: document review requests no longer
  use the shared helper. They send the session cookies
  (`credentials: 'include'`) and no Authorization header. `DocumentApiError`
  gains `reason`.
- `dashboard/src/components/document-review/decision-card.tsx`: refusals with
  `operator_credential_unconfigured` or `operator_check_unavailable` now say
  what happened, that nothing was recorded, that the note is kept, and what to
  do. The typed note already survived a failed save; the new test proves it.
- `docs/contracts/document-review-deliverables.md`: authority precedence, the
  error rows and the consumer rule (send no bearer from a browser session).

### Round 2 (QA finding): the note had to survive the recovery the message recommends

QA (codex) drove refusal, retained note, page remount, reopen Request changes
with the component harness and found the note empty: the card said "your note
is kept" and recommended a reload, but the note lived only in component state
(`decision-card.tsx`, the `useState("")` at line 147 at that time). The same
reproduction, run from stdin against the harness before the fix, failed with
actual `''`, expected the typed note. Fix, 2026-10-04:

- `dashboard/src/lib/decision-note-draft.ts` (new): the note is written to
  the device's storage as it is typed (localStorage, sessionStorage as the
  fallback, every call wrapped so disabled or full storage never breaks
  typing), keyed by document, together with the decision kind, the attempt id
  (`client_decision_id`), the revision the attempt targets and the revision
  the note was first written for. Only the note text is stored, never a
  credential. A blank note removes the entry; an unusable stored value reads
  as no note.
- `decision-card.tsx`: on mount the kept note is restored and announced
  ("Unsaved note from <time>, written for rev <hash>, is kept on this device;
  open Request changes to continue", with a Discard note control). Reopening
  the same decision on the same revision resumes the same attempt id, so a
  retry after the reload is answered from the record when the earlier
  response was lost after recording; any other revision or kind is a new
  attempt with a new id. Inside the panel the card says the note was restored
  and for which revision, and when that is not the revision on screen it says
  so in amber: "you are now deciding on rev <hash>, so check that it still
  applies". Recording a decision clears the kept note. The refusal messages
  now say "your note is kept on this device".
- Tests: `dashboard/src/lib/__tests__/decision-note-draft.test.ts` (round
  trip per document, blank note, unusable values and older records, throwing
  or missing storage) and three card tests in `document-decisions.test.mjs`:
  the recovery itself (refusal, unmount, remount with the device's storage
  kept, announcement, reopen, same attempt id, recorded, cleared, nothing to
  restore afterwards), the drift case (the file changed between the refusal
  and the reload: both revisions named, the decision targets the revision on
  screen as a new attempt) and Discard note. The reviewer's stdin
  reproduction passes against the same harness after the fix.
- `docs/contracts/document-review-deliverables.md`: a UI handoff note for the
  kept note (what to store, when to restore, when to reuse the attempt id,
  when to clear).

## Comments and Finish review

Comments and Finish review never go through the decision authority: they are
the reviewer's own feedback on the review they opened (`ownReview` by
`reviewer_id`). The new server test saves a comment and finishes a review from
a placeholder-carrying session with no operator proof (201 and 202) while the
same session is refused a decision. The dashboard suite already covers a
failed comment save keeping its text and retrying with the same client id, and
a rejected finish keeping the draft editable; both re-ran green.

## Revision drift

A decision is pinned to the `revision_id` and `content_hash` the operator
read; the server re-reads the file and refuses with 409 `stale_revision` when
that revision is no longer current. A review stays pinned to the revision it
was opened on and its passage comments are not moved. The new server test
opens a review on v1, rewrites the file, records decisions on v2 from user and
device sessions, and shows the review still pinned to v1, every decision
naming v2, and a decision on v1 refused as stale. The new card test shows the
request names the revision on screen, the review and its comment stay on the
older revision, and no comment, review or finish call is made by a decision.

The kept note (round 2) follows the same rule. Its origin revision is written
once and never moved: after a reload onto a newer revision the card names both
revisions next to the note, the decision request names the revision on
screen, and the attempt id is new. The drift card test and step 06 of the
isolated browser run below show it.

## Verification

Source-level, run on 2026-10-04 after the round-2 changes unless marked
round 1:

- `npx jest server/__tests__/document-deliverables.test.js --runInBand`:
  16 passed (round 2 re-run; the two round-1 tests failed before the fix with
  `Expected: 201, Received: 503`, and with no `reason` on the 503). Server
  code is unchanged in round 2.
- `npx jest --silent` (full server suite, round 1): 1303 passed, 3 failed,
  1 skipped. The three failures (`openrouter-free-lane`, `praxis-stream`
  loopback, `studio-route` enrich) predate this task, import none of the
  changed modules, and are the same three recorded on 2026-10-02.
- `cd dashboard && npm test`: 764 passed, 0 failed (757 in round 1 plus the
  seven new tests).
- Focused: `node --import ./test/register.mjs --test
  src/components/__tests__/document-decisions.test.mjs
  src/components/__tests__/document-review.test.mjs
  src/lib/__tests__/document-review-client.test.ts
  src/lib/__tests__/decision-note-draft.test.ts` from `dashboard/`: 26 passed.
- `cd dashboard && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`: exit 0.
- `cd dashboard && NEXT_DIST_DIR=.next-verify
  NEXT_PUBLIC_API_URL=http://127.0.0.1:4299 npm run build`: exit 0, with
  `/documents/[id]` in the route list. The two `.next-verify` include lines
  the build appends to `dashboard/tsconfig.json` were removed again and the
  file matches HEAD.
- Strict UTF-8, BOM, CR, mojibake and em-dash scan over every edited and new
  file: all ok.

### Isolated stack run (round 2), 2026-10-04 17:48:57Z to 17:49:05Z

The protocol (`docs/verification-protocol.md`, "Dashboard") asks for the
build plus the affected page driven against a running server. Two scripts are
checked in for that and were run once, end to end:

- `node dashboard/scripts/decision-session-check-api.cjs`: the real
  `server/server.js` (same mounting, same `req.user` stamping, same documents
  router, authority and Access verifier) on a temporary database under
  `/private/var/folders/.../nexus-decision-check-1PoXng/`, port 4299, with the
  fixture Access issuer from `server/__tests__/helpers/operator-access.js`
  (its one outbound call, the signing-key fetch, answered in-process), one
  trusted device, the operator credential unset, and a synthetic Praxis
  receiver on port 4300 that accepts the keyed review relay. It registered one
  synthetic brief as a declared deliverable (document `d7257024`) under a
  temp project root with a completed source task. The host's pins, database,
  :4000, :3000 and Praxis were not touched; the fleet env still loads, so
  model discovery at boot listed providers as the live server does.
- `NEXT_DIST_DIR=.next-verify npx next start -p 3299` served the verify build
  built against `http://127.0.0.1:4299`.
- `CHECK_BASE=http://127.0.0.1:3299 CHECK_DIR=<temp dir> CHECK_DOC=d7257024...
  node dashboard/scripts/decision-session-browser-check.mjs`: headless Chrome
  with a fresh profile at 1440 px, the Access assertion injected as an extra
  request header (where the edge injects it), never from page code. Result:
  ALL CHECKS PASSED, 0 page exceptions. The report is
  `docs/reviews/2026-10-04-document-decision-session-browser-check.json`
  (SHA-256 `5892e8717496baad7822b1078fdbeea2c0b8958dc09e4f143860cd8b20abb4ac`);
  the per-step screenshots are in `/tmp/nexus-decision-check-evidence/` on
  this machine, not in the repo.

What the browser did and saw, in order:

| Step | Session on the wire | Observed |
| --- | --- | --- |
| 01 open | none | `Document: review pending`, card `needs_review`, 1 revision, 0 decisions, 0 reviews |
| 02 comment | none | passage comment saved (201); a draft review pinned to revision 1 with 1 comment |
| 03 Request changes with the note | placeholder bearer only (the old client, emulated) | the screenshot refusal, now worded "This session carries no operator sign-in, so the request fell back to a credential this Nexus does not have configured. Nothing was recorded and your note is kept on this device. Reload the app and try again; ..."; note still in the textarea and on the device; 0 decisions |
| 04 retry | none (the new client) | "Recording a document decision needs Robert’s verified operator session or operator credential; this request carries neither. Nothing was recorded. ..."; note kept; 0 decisions |
| 05 reload | none | "Unsaved note from 10/4/2026, 1:48:58 PM, written for rev 0e6fdb4b, is kept on this device; open Request changes to continue"; reopening shows the note and "Unsaved note restored from ..., written for rev 0e6fdb4b." |
| 06 file changed, reload | none | a second revision captured (rev df59292b), changed banner, View current file; the panel says "written for rev 0e6fdb4b; you are now deciding on rev df59292b, so check that it still applies"; the note unchanged |
| 07 submit | user assertion plus the placeholder bearer (a stale tab) | "Changes requested rev df59292b. Nothing was sent or published."; API history: one `request_changes` on the second revision, `authority=access_user`, the note verbatim, the matching content hash; the review still pinned to revision 1 with its comment; the kept note cleared; header `Document: changes requested` |
| 08 approve | device assertion | "Approved rev df59292b"; `authority=access_device` on the second revision |
| 09 Request changes | user assertion plus `x-praxis-bridge-token` | "Executor and bridge credentials cannot record document decisions. Nothing was recorded. ..."; still 2 decisions; Discard note cleared the device copy |
| 10 Finish review | none | accepted; the submission `delivered` after 1 attempt with a receipt; the receiver saw exactly one relay keyed `docreview:<submission id>`; still 2 decisions; the submitted review still pinned to revision 1 |

The isolated API logged `[Documents] request_changes recorded for d7257024...
revision d5d74728... (authority=access_user)` and `[Documents] approve
recorded ... (authority=access_device)`; nothing else was recorded there.

Network, as recorded by Chrome: 35 API requests, 14 of them document
requests; no document request carried an `Authorization` header outside the
two steps that emulate the old client or a stale tab. Two other page calls
(`GET /api/praxis/voice-status`, `GET /api/board-state`) still carry the
shared helper's placeholder bearer (follow-up below). The page also contacted
the live `http://localhost:4000` for `socket.io` and `GET /api/chat/active`
(read-only; the bridge components do that on every dashboard page). The verify
dashboard's `[SessionCheck]` trace reported pin mismatches for the fixture
tokens because that dashboard reads the host's pins from `.env`; the trace is
diagnostic only, and the isolated API, pinned to the fixture, accepted the
session.

## Activation, separate from the source-level result

Observed on 2026-10-04 at 17:50:35Z (round 2) unless stated otherwise:

- Dashboard layer: live at that time. :3000 is the supervised `next dev`
  (`next-server` pid 2527, started 11:38:59 local, `PRAXIS_DASHBOARD_DEV=1`).
  The chunk served for `/documents/6daf8a8c...` at 17:50:35Z
  (`dashboard_src_58195049._.js`) contained the round-2 draft key
  `nexus:document-decision-note:` and the new card wording. In round 1 (about
  17:20Z) the served chunk already contained the client change
  (`credentials: 'include'`, no `nexus/shared.ts` import). A tab opened
  before a change keeps the module it loaded until it reloads.
- Server layer: not live at that time. The :4000 process (pid 2487) was still
  the one started at 11:38:58 local (15:38:58Z), before any edit of this task,
  so it runs the bearer-first authority. Activating it needs the Nexus child
  restarted (the Praxis supervisor respawns it); this task restarted nothing.
- Expected live behavior before that restart: Robert's tunnel, phone or
  Windows session should record decisions, because the live client sends no
  bearer and the live server code then inspects the session (the no-bearer
  reproduction line above; steps 04 and 07 of the isolated run show the same
  order of checks on the fixed server). The server fix adds the same outcome
  for a stale tab or another client that still sends a bearer (step 07).
- Live data at 17:51:11Z (read-only query of `review_document_revisions` and
  `review_document_decisions` in `nexus.db`): the brief has 6 revisions, the
  latest `f6b683e4` captured 17:12:48Z, and 0 decisions. This task recorded
  nothing and captured no revision on the live database (the decision route
  captures only after the authority check, and the refused round-1 probes
  never reached it).
- Robert's wording ("Change the "identity" column in the table below to be a
  summary of the documents instead of just listing what documents are
  available.") remains a chat-sourced task note, not a recorded decision; his
  decision has to be made on whatever revision is current when he decides.
- `NEXUS_OPERATOR_APPROVAL_KEY` stays unprovisioned; nothing here depends on
  it.

## Follow-ups, out of scope

- `dashboard/src/lib/auth.ts` still attaches the placeholder bearer to every
  other nexus client call. No server route treats that bearer as a credential
  today, so there is no functional effect, but it is a standing trap for any
  future route that reads `Authorization` first.
- The same placeholder bearer still rides on `GET /api/praxis/voice-status`
  and `GET /api/board-state` from the document page (seen in the isolated
  run). No route treats it as a credential today.
- Every dashboard page, an isolated verify build included, still opens
  `socket.io` and `GET /api/chat/active` against the live `localhost:4000`
  (the bridge components ignore `NEXT_PUBLIC_API_URL`). Read-only, but an
  isolated run is not fully isolated until that goes through the proxy.

## Binding constraints from the task brief

Restated with all four fields each; wording unchanged apart from replacing the
brief's em dashes with colons.

BC-WORKSPACE: Do the work inside /Volumes/Projects/TheNexus; QA's primary diff
comes from there; any additional repo you touch must be named in your
completion report.
- Prerequisite (resolve first): The assigned workspace must be the repo that
  holds the main body of the code this task changes. Check that before your
  first edit, not after.
- Authority (who may waive it): Praxis, via the task re-point endpoint: POST
  /api/tasks/a1cc8616-5d7b-4278-a91f-85d90c366c9e/workspace with the new path
  and a reason. Robert, if the re-point is refused.
- Fallback (do this instead): If the WHOLE task belongs elsewhere, re-point
  the task first and then do ALL the work in the new directory; if you only
  realise at the end, still call the endpoint with "baseline":"head". If the
  task merely also needs another repo, work there and declare it in your
  report. If neither is possible, report needs_input.
- Consequence (if you proceed anyway): QA builds the authoritative diff from
  this workspace and the dispatch-time snapshot, plus the diff of every
  additional repo the run touched and declared. Work done in an undeclared
  repo that Praxis could not record is invisible to review, and a round with
  no work in any visible repo fails as an empty diff no matter how correct
  the change is.

BC-CRITERIA: Satisfy every acceptance criterion above and cite the command or
observation that proves each one.
- Prerequisite (resolve first): Each criterion has to be verified against real
  behavior before you report complete; a criterion you did not run is a
  criterion you did not meet.
- Authority (who may waive it): The QA reviewer rules on a criterion you can
  show is defective; contest it with "PRAXIS_CRITERION_DISPUTE: <number>:
  <why, with evidence>", and twice contested without resolution goes to
  Robert. Robert's operator rulings override both. Neither happens silently;
  you have to raise it.
- Fallback (do this instead): If a criterion cannot be met as written, say so
  explicitly with evidence and deliver everything else in full. Narrowing the
  scope quietly is not the fallback.
- Consequence (if you proceed anyway): QA scores each criterion mechanically
  against your diff. An unproven criterion is a fail verdict and a correction
  round, not a note.

BC-FOREIGN-WORK: The workspace is SHARED and may hold unrelated uncommitted
work from other agents or Robert's own sessions. Never revert, stash, `git
checkout`/`git restore`, or delete anything you did not change in this run.
- Prerequisite (resolve first): Know what was already dirty before you touch
  the tree: the brief's workspace pre-flight lists it, and `git status` shows
  the rest. Anything on that list is somebody else's in-flight work.
- Authority (who may waive it): Robert alone. No task brief, no reviewer
  finding, and no cleanup instinct authorizes discarding another session's
  changes.
- Fallback (do this instead): Work additively. Re-read a contended file
  immediately before each edit, keep your change narrow, and say in your
  walkthrough that the file was already dirty. Never `git add -A` or `git
  commit -a`.
- Consequence (if you proceed anyway): Git keeps no reflog for working-tree
  reverts, so the other session's work is gone unrecoverably; that happened
  on 2026-07-09 and cost a verified-but-uncommitted change.

BC-NO-COMMIT: Do NOT commit or push unless the task explicitly says to.
- Prerequisite (resolve first): A commit needs explicit authorization in this
  task's own brief. Absent that sentence, the work stays uncommitted.
- Authority (who may waive it): Robert, through the end-of-day
  commit-approval workflow. The task brief itself, when it explicitly
  instructs you to commit.
- Fallback (do this instead): Leave the change in the working tree; `git add`
  only the NEW files you created if the task needs them visible to review.
- Consequence (if you proceed anyway): QA reviews your UNCOMMITTED diff
  against a dispatch-time snapshot. Committing moves the work out of that
  view, and the round can read as an empty diff (a mandatory fail) even
  though the code is right.

BC-LIFECYCLE: Do NOT change this task's status in The Nexus yourself.
- Prerequisite (resolve first): The completion protocol markers at the end of
  this brief are the only status channel available to you; use them instead
  of the board.
- Authority (who may waive it): Praxis's completion handler owns the
  lifecycle. Robert can override it from the board.
- Fallback (do this instead): End with the exact completion / failure /
  needs-input protocol, and put anything the status cannot express into the
  walkthrough.
- Consequence (if you proceed anyway): A hand-edited status desynchronizes
  the schedule from the run, and the executor callback that would have
  carried your result is discarded.

BC-QUALITY-GATES: Run BOTH quality gates, verify and code-review, and declare
them on the marker line before reporting complete.
- Prerequisite (resolve first): The verify pass needs the change actually
  exercised (run the flow, command, or test; a typecheck is not a verify),
  and the code-review pass needs your own uncommitted diff re-read end to
  end.
- Authority (who may waive it): Nobody. Neither an executor nor a reviewer
  may waive a gate; the only sanctioned exception is a change with no runtime
  surface, and you must say that explicitly on the marker line.
- Fallback (do this instead): If there is genuinely nothing to drive, declare
  that in place of a command rather than omitting the gate or inventing a
  command you did not run.
- Consequence (if you proceed anyway): A completion reported without the
  marker line is treated as unverified work and flagged for the human
  reviewer, whatever the walkthrough claims.

BC-WORKSPACE-BINDING: Your home workspace is `/Volumes/Projects/TheNexus`.
You MAY work in additional repos under /Volumes/Projects when the task
genuinely needs it, and you MUST name every extra repo you touched (absolute
path) and why, in your completion report.
- Prerequisite (resolve first): Before writing outside the home workspace,
  know that the task genuinely needs that repo. Praxis records every write
  outside the home root, so the record and your report have to agree.
- Authority (who may waive it): You, by declaring it in the completion
  report; that is the sanctioned way to widen the task's footprint. If the
  WHOLE task belongs in a different repo, re-point it through the workspace
  endpoint instead so QA's primary diff moves with you.
- Fallback (do this instead): If you touched a repo you did not need, say so
  in the report anyway (an honest extra repo is not a defect); if you cannot
  tell which repos you touched, list every one you might have.
- Consequence (if you proceed anyway): QA collects the diff from every repo
  you touched and judges it on merit; it never fails you merely for editing
  another repo. An UNDECLARED extra repo (recorded by Praxis, never named in
  your report) is the one cross-repo defect QA may raise.
