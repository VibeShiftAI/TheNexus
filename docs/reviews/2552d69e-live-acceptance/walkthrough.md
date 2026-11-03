# Live acceptance walkthrough of the trustworthy instrument surfaces

Recorded 3 November 2026, 21:34–21:39 UTC, against the running API on port 4000 and dashboard on port 3000. Task: `2552d69e-69f7-4a18-bc42-b648da20e26b`.

The four evidence-gathering criteria are met, with the qualifications below. This is an acceptance record, not approval to close the project checkpoint. The default test environment fails three tests; the complete server suite passes with four inherited service credentials removed for that command. All 11 MCP security checks pass, but the probe exits 1 during final symlink maintenance. Both named attribution-and-trust tasks are archived with their evidence gates absent. These gaps remain follow-ups; no implementation, task status, or checkpoint was changed.

## Acceptance attestation

1. **Met — running cockpit.** Python `urllib.request.urlopen` GETs returned HTTP 200 for `http://localhost:4000/api/projects` and `http://localhost:3000`. The headless Chrome run loaded the dashboard and interacted with live task cards. HTTP observations: [observations.txt:1](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:1) and [observations.txt:2](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:2). Dashboard capture: [Review screenshot](/documents/b62c9810-5530-4660-8842-3bbe23292f1f) · [exact captured revision](/api/documents/b62c9810-5530-4660-8842-3bbe23292f1f/raw?revision=ff60019d-f1db-4327-88ac-cd44248cc88f).
2. **Met — full suite green in an isolated test environment.** `env -u OPENROUTER_API_KEY -u NEXUS_SERVICE_KEY -u YOUTUBE_API_KEY -u GOOGLE_API_KEY npm test` ran every root Jest suite: **171 suites passed; 2,254 tests passed, 1 skipped, 2,255 total; exit 0**. No tests were selected out or altered. The first plain `npm test` failed three tests; both complete outputs and the baseline comparison are retained. [observations.txt:3](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:3) and [observations.txt:4](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:4). This does not claim that plain `npm test` passes with this executor's inherited credentials.
3. **Met — probe result recorded per check.** `node scripts/mcp-boundary-probe.js` printed **PASS for all 11 security checks**. It then exited 1 with `Path is a directory: /Volumes/Projects/TheNexus/logs/mcp-boundary-probe/latest` at `scripts/mcp-boundary-probe.js:292`. This is a recorded probe failure after its checks, not an exit-zero claim. Every named check and corroborating source is retained. [observations.txt:7](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:7).
4. **Met — four surface entries.** Attribution, routing economics, the one-click evidence dossier, and unverified-completion appearance each have a live observation and screenshot below. Missing estimate/local examples and task-set evidence are explicitly named as gaps. [observations.txt:19](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:19), [observations.txt:243](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:243), [observations.txt:303](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:303), and [observations.txt:323](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:323).

## Live walkthrough

### Attribution badges

Opened the dashboard, waited for Recent Activity to finish loading, then selected **Commits**. The feed showed 20 commits. Commit `49b036f` showed model `gpt-6-astra` and `10.2M` tokens; its retained API record has `tokens: 10193910` and `tokensSource: measured`. The browser also showed `gpt-6-astra` / `12.2M` on `6accf29` and `e4546d2`, and `unavailable` on a manual commit. Model badges were purple, measured token badges cyan, and missing usage was explicit. [observations.txt:19](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:19). [Review screenshot](/documents/e5eb4729-63d4-4fc5-a79b-8526aa41661f) · [exact captured revision](/api/documents/e5eb4729-63d4-4fc5-a79b-8526aa41661f/raw?revision=b0ab6833-d50a-43d4-9e53-392111bdc36e).

**Gaps:** None of the 20 retained recent activity rows has estimated tokens, so this run cannot prove an estimated *activity badge* appears on a real recent run. The routing panel does demonstrate visible estimate styling below. No local executor run is represented in routing history. Do not treat those missing live examples as a local/cloud acceptance pass. API and browser captures were taken minutes apart while tasks were running: early unavailable counts becoming measured later are separate observations, not a fixed dataset. Source response: `evidence/activity.json`, with exact excerpts and SHA-256 in `evidence/http-evidence-excerpts.json`.

**Attribution mismatch found:** the initial live `/api/activity` response assigns commit `6accf294756ef43f9ebd89f28fdc7c92f83cbacf` to task `2552d69e-69f7-4a18-bc42-b648da20e26b`, but `git show -s --format=%H%n%B 6accf294756ef43f9ebd89f28fdc7c92f83cbacf` shows trailer `Task: 07403a02-3731-4b19-941d-57d7289f3a6b`. The model badge alone therefore does not prove correct task attribution. Follow up on commit-to-dispatch matching during concurrent runs. This is a transient captured mismatch; no cause or permanence is claimed. Evidence: `evidence/activity.json:45` (taskId) and `evidence/attribution-commit.txt:5` (trailer).

### Routing economics

Opened `/activity` and scrolled to **Measured routing economics**. The live table showed the local lane as **0 runs / No data — no recorded runs**. The cloud lane showed **3,344 runs**, **3.8m median**, **3.0h worst observed**, **~10,626,767,607 est**, **707 estimated runs**, and **$32137.391 estimate**. Both the estimated tokens and cost were visibly amber. Coverage counts and missing model/rate/token reasons were displayed. [observations.txt:243](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:243). [Review screenshot](/documents/57379526-9e25-49a9-ad54-456b7b29970c) · [exact captured revision](/api/documents/57379526-9e25-49a9-ad54-456b7b29970c/raw?revision=bf0b9113-6f1c-4f26-bcad-4fb4951d034a).

The panel reports **89% completed** as executor outcome, not QA acceptance. The API explicitly describes this distinction and says costs are estimated API-equivalent values, not provider bills. **Gap:** this is not the promised QA pass-rate comparison, and there is no local sample to compare against cloud. The earlier API snapshot has 3,343 cloud runs; the browser's later 3,344 is retained with its own timestamp. See `evidence/routing-economics.json` and the excerpt file rather than assuming these counters are static.

### One-click completion evidence dossier

Opened `/task-board?lane=complete` (the Complete lane is hidden by default), searched for `7fe1005f-f05f-430c-a6a0-b1e4dddf6876` — **Keep document review actions reachable with audio and feedback widgets visible** — and clicked its **Verified** badge once. The browser navigated directly to `/task/7fe1005f-f05f-430c-a6a0-b1e4dddf6876`, whose Completion evidence panel showed Walkthrough, Verify gate, Code-review gate, and QA verdict **ON RECORD**, each with a timestamp. The exact before/after navigation is retained at [observations.txt:392](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:392).

Clicked **Verify gate** once: `aria-expanded` changed from `false` to `true`; the panel displayed the verification detail, **Praxis verification record**, **run-events seq 55441**, a `claude-code` dispatch/log reference, and an actual bounded transcript tail. [observations.txt:342](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:342) and [observations.txt:393](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:393). The API marks the QA piece `verdict: pass` and all four pieces `present` in `evidence/verified-dossier.json`.

Card: [Review screenshot](/documents/1dbdcfe0-e3df-445a-b5f3-c951ecde3385) · [exact captured revision](/api/documents/1dbdcfe0-e3df-445a-b5f3-c951ecde3385/raw?revision=0755ca4b-c940-4d3a-9bfd-49f8aaa208c9). Dossier: [Review screenshot](/documents/8e6cb7f8-da3b-4290-80c2-388c9c6fcd49) · [exact captured revision](/api/documents/8e6cb7f8-da3b-4290-80c2-388c9c6fcd49/raw?revision=e434e3e6-a172-44a9-b5e8-e2a2ce3cf93c). Expanded verification: [Review screenshot](/documents/555bdae1-674c-48bf-b08d-0d40e79c6d60) · [exact captured revision](/api/documents/555bdae1-674c-48bf-b08d-0d40e79c6d60/raw?revision=950a0faa-c4c8-4bc2-a783-4c380e3111f8).

**Qualification:** the green **Verified** presence badge coexists with **Praxis grade: uncertain**. Both are visible. This demonstrates that all four evidence pieces are attached, not that the underlying work has an unqualified verification grade. Follow up on whether that distinction is clear enough for unattended trust; no badge logic was changed.

### Unverified-completion appearance

Searched the Complete lane for `69cb9a87-0c9a-462e-a282-322718f581c6` — **Python: Update LLMFactory for local orchestrator**. Its status remains Completed, while the evidence badge is amber **Unverified (pre-capture)** and names missing walkthrough, verify, code review, and QA. One click opened the dossier with the same amber warning. [observations.txt:394](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:394).

The dossier distinguishes an **INCOMPLETE** walkthrough (no timestamp/log) from **ABSENT** verify, code-review, and QA records. Expanding Verify gate showed the absence reason and no source record, rather than fabricated verification. [observations.txt:323](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:323) and [observations.txt:395](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:395). Card: [Review screenshot](/documents/a89f2839-322e-4b86-a906-f7dc487f2f27) · [exact captured revision](/api/documents/a89f2839-322e-4b86-a906-f7dc487f2f27/raw?revision=1de00f60-c3cf-4969-8214-7969dce7a968). Dossier: [Review screenshot](/documents/f202441e-327d-4b06-92f1-ed7bf1b96f14) · [exact captured revision](/api/documents/f202441e-327d-4b06-92f1-ed7bf1b96f14/raw?revision=c605f540-ef61-42c6-a27b-c78c74cdc1c6). Expanded absence: [Review screenshot](/documents/fa08d4e9-f23d-42d7-9bef-674e07dfaf88) · [exact captured revision](/api/documents/fa08d4e9-f23d-42d7-9bef-674e07dfaf88/raw?revision=f11c9691-b489-497e-bbdb-ca393784728c).

This is an existing historical, pre-capture completion. No deliberately unevidenced task was created, and no live evidence was removed for the demonstration.

## Suite results and baseline comparison

Initial command: `npm test`, at test-start HEAD `6accf294756ef43f9ebd89f28fdc7c92f83cbacf`, in the shared working tree. Result: **168 passed / 3 failed suites; 2,251 passed / 3 failed / 1 skipped tests; exit 1**. The following exact failures were retained:

| Test | Initial outcome | QA-baseline comparison |
| --- | --- | --- |
| `openrouter-free-lane.test.js` — “an unreadable file degrades to no values rather than throwing” | Expected null; inherited OPENROUTER_API_KEY resolved | Same assertion fails in supplemented baseline |
| `praxis-stream.test.js` — “ignores X-Forwarded-For and judges loopback by the socket peer” | Expected 200, received 401 | Same assertion fails in pristine and supplemented baseline |
| `studio-route.test.js` — “the enrich endpoint drains un-enriched objects and reports remaining” | Expected 0, received 2 | Same assertion fails in pristine and supplemented baseline |

Baseline: `1b0e22079ef905a5c107188d65fc3745fae67fe5`, exported with `git archive` to a temporary directory and using this workspace's installed dependencies. Command: `npm test -- --runInBand server/__tests__/openrouter-free-lane.test.js server/__tests__/praxis-stream.test.js server/__tests__/studio-route.test.js`.

The pristine snapshot cannot load `openrouter-free-lane` because it excludes the pre-existing untracked `db/document-agent-reviews.js` required by `db/index.js:27`. A second comparison copies that file and `db/document-draft-versions.js` from the shared tree into the temporary baseline, explicitly recorded as a **supplemented, not pristine, baseline**. It reproduces all three original failures: **3 failed / 54 passed tests**. Neither foreign file was changed. Both baseline outputs are retained. [observations.txt:5](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:5) and [observations.txt:6](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:6).

The complete suite then passed with only the four named environment variables removed from the child process. No persistent environment or source changed. The green run still printed a worker-teardown warning (“failed to exit gracefully … force exited”); it did not fail a suite. Follow up on test isolation, teardown, and credential-safe failure output. An inherited OpenRouter credential printed by the failed assertion is replaced with `[REDACTED_OPENROUTER_CREDENTIAL]` in the retained logs; test names, expectations, counts and exit codes remain intact.

## MCP boundary probe

The original probe was run unchanged; its isolated HOME was removed by the probe. Its report and corroborating RPC transcripts, stderr logs, ledger rows, SQLite ledger, and directory listing are copied under `evidence/mcp-probe-sources/`. The live `~/.praxis-mind` was not the probe HOME (`scripts/mcp-boundary-probe.js:61`, `:152`).

| Check | Result |
| --- | --- |
| scoped credential resolves and whoami succeeds | PASS |
| nexus_task_create refused for the scoped credential | PASS |
| vault_write refused for the scoped credential | PASS |
| stderr log corroborates the caller binding for the spawn | PASS |
| cost-ledger row corroborates the whoami invocation, attributed to the probe identity | PASS |
| refused mutations left no ledger trace (rejected before any side effect) | PASS |
| refused mutations opened no write transaction (transition log absent) | PASS |
| the same previously-valid key now resolves unauthenticated | PASS |
| stderr FATAL log corroborates the loose-keys refusal | PASS |
| stderr log corroborates the unauthenticated spawn | PASS |
| the unauthenticated refusal left no new ledger rows | PASS |

All 11 checks are corroborated at [observations.txt:8](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:8). **Follow-up:** repair the probe's final `latest` link replacement so a completed security run exits correctly; the existing symlink was not removed or repaired in this evidence task. The report still exists because it is written before the failing cleanup (`scripts/mcp-boundary-probe.js:289`).

## Named task-set knowledge check

Question `research:5d922b5db161fb3a1052`: Did tasks 7308afe3 and 3ea04ca2 close with verify, code-review and QA evidence attached?

**Supported answer from live records: no current evidence establishes that condition.** Both `7308afe3-71dd-4f2e-ac37-773cc67446b4` (Expose model routing economics) and `3ea04ca2-0777-451d-963e-f8d74fc1204f` (Security-test the skill and MCP boundary) are **archived**, with `completed: false`, `state: not_completed`, all four pieces absent, and an available spine. [observations.txt:396](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:396) and [observations.txt:397](/Volumes/Projects/TheNexus/docs/reviews/2552d69e-live-acceptance/evidence/observations.txt:397). Their archived state does not establish historical completion. No successor task was substituted for either named ID.

`evidence/knowledge-assessment.json` carries the requested structured entry, native HTTP source references, exact response SHA-256 values, check times, and limitations. Cortex search was used for discovery but returned degraded partial results with a query-expansion timeout and unrelated snippets. None was treated as proof; no canonical relevant vault passage was returned to pin/read. The answer is established by the current task and dossier APIs, not the retrieved summaries.

**Follow-up:** reconcile these two task IDs and their evidence with the checkpoint owner before checkpoint acceptance. This walkthrough does not mark the checkpoint complete.

## Verification, review, and scope

The browser command `node docs/reviews/2552d69e-live-acceptance/capture-live.mjs` completed with exit 0 and nine captures against localhost, without fixtures, request interception, or API writes. It searched the actual board, clicked evidence badges, and expanded verify rows. Screenshots were visually inspected. The helper closes its Chrome process and deletes only its own temporary profile. No production server was started or restarted. The dashboard's runtime banner said **Status unknown** during capture; this is an observation, not an uptime failure or a tested degraded-state simulation.

Only the new `docs/reviews/2552d69e-live-acceptance/` evidence package is claimed as task work. The probe also generated `logs/mcp-boundary-probe/2026-11-03T21-34-10-089Z/`; its contents are retained in the evidence package. There were no writes to additional repositories. Praxis source/configuration was read to discover the permitted handoff schema; an isolated baseline copy was written only under the system temporary directory. The sibling's advancing HEAD and pre-existing dirty files remain foreign work; the initial status and revision are retained in `evidence/preflight.txt` and `evidence/revision.txt`.

The task-scoped review checks the captured data against the claims, the read-only browser helper and cleanup, secret redaction, exact artifact links, UTF-8/mojibake validation, and the attributable staged diff. The final task walkthrough records the resulting local commit SHA; no push is authorized or performed.

## Files touched

- docs/reviews/2552d69e-live-acceptance/walkthrough.md
- docs/reviews/2552d69e-live-acceptance/binding-constraints.md
- docs/reviews/2552d69e-live-acceptance/capture-live.mjs
- docs/reviews/2552d69e-live-acceptance/evidence/
- docs/reviews/2552d69e-live-acceptance/*handoff*.json
- logs/mcp-boundary-probe/2026-11-03T21-34-10-089Z/

## Registered evidence

The nine screenshot revisions have been registered in Documents and verified current/reviewable. All screenshot links above name both the review page and the exact captured revision. The report's final handoff also includes the observation transcript, complete green and failing suite outputs, baseline comparisons, MCP output/report, HTTP excerpts and structured knowledge answer. Registration is not QA approval or checkpoint authority.


| Evidence record | Documents review | Exact revision |
| --- | --- | --- |
| observations.txt | [Open](/documents/82410c9b-329b-4e6b-895f-4f361c55ca4b) | [Raw](/api/documents/82410c9b-329b-4e6b-895f-4f361c55ca4b/raw?revision=c9c50165-ef6c-44f4-bf89-c17be561beb9) |
| npm-test.txt | [Open](/documents/6b984f49-f4b5-4ca9-8288-fab45cc07085) | [Raw](/api/documents/6b984f49-f4b5-4ca9-8288-fab45cc07085/raw?revision=3afe1f27-ed80-4325-85d3-5f48883bf36e) |
| npm-test-isolated-env.txt | [Open](/documents/8c292527-6bba-4ac3-a0d3-c7bd92b8fcb1) | [Raw](/api/documents/8c292527-6bba-4ac3-a0d3-c7bd92b8fcb1/raw?revision=ebea0801-f294-485f-aa6a-2f3b1a97f134) |
| baseline-tests.txt | [Open](/documents/e4149298-b496-473f-afaf-8df652644d76) | [Raw](/api/documents/e4149298-b496-473f-afaf-8df652644d76/raw?revision=5b5636a8-0f4a-4e1e-9d25-89256b51822e) |
| baseline-tests-supplemented.txt | [Open](/documents/81a4f55a-6763-40cf-b037-86b8649bd7f5) | [Raw](/api/documents/81a4f55a-6763-40cf-b037-86b8649bd7f5/raw?revision=0d09d1b2-9dfe-4816-bb36-63f1163b0077) |
| mcp-probe.txt | [Open](/documents/945d60a2-4999-4ce6-bddc-4814491b2bc4) | [Raw](/api/documents/945d60a2-4999-4ce6-bddc-4814491b2bc4/raw?revision=6aa072a6-3d41-48dc-86c4-2b4ba397b8fc) |
| http-evidence-excerpts.json | [Open](/documents/9274f7ae-1103-46ff-ab1f-c52eba36c634) | [Raw](/api/documents/9274f7ae-1103-46ff-ab1f-c52eba36c634/raw?revision=a45b2bf0-056d-4a10-b77d-4ce827ddfced) |
| knowledge-assessment.json | [Open](/documents/ebdfc41e-6721-4258-a408-356d84be68da) | [Raw](/api/documents/ebdfc41e-6721-4258-a408-356d84be68da/raw?revision=4d699c0f-a7a1-41c7-921d-877cac78e511) |
| report.json | [Open](/documents/44cccdbf-e815-42e9-9df7-95d506ca7af0) | [Raw](/api/documents/44cccdbf-e815-42e9-9df7-95d506ca7af0/raw?revision=7859e305-53bb-4b2c-9d37-0ee6193756e1) |

# Binding constraints carried verbatim from the task brief

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/2552d69e-69f7-4a18-bc42-b648da20e26b/workspace with the new path and a reason. Robert, if the re-point is refused.
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

#### BC-TASK-COMMITS — Commit your OWN verified work as you go, in small, task-scoped, LOCAL commits on the dispatch branch, each ending with the trailer `Task: 2552d69e-69f7-4a18-bc42-b648da20e26b`. Never `git push`, and never stage or commit anything you did not change in this run.
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
