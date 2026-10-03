# Measured routing economics — implementation walkthrough

Task: b4b102c4-aaed-44dd-bd9a-6353509a95cb. Workspace: /Volumes/Projects/TheNexus. No additional repository was edited. Work remains uncommitted. The pre-existing `.env.example` change was preserved. Build-generated tsconfig includes were removed without changing other settings.

## Result and source map

- `server/routes/routing-economics.js:5` adds GET `/api/routing-economics`; line 10 opens SQLite read-only and lines 12–18 take a consistent complete-history snapshot. `server/server.js:197` mounts it behind the existing authenticator.
- `server/services/routing-economics.js:23` aggregates per-model/per-lane counts, median/worst observed duration, tokens, cost subtotals, and terminal executor outcomes. Each metric carries its own run denominator. Lines 91–108 include active roster models with no observations and links to contributing dispatches. Unknown lanes/model identities stay unknown.
- `server/services/run-cost.js:1` holds the pre-existing static rate table and token-mix assumptions extracted from dispatch-insight. No rate was added or changed. Its raw estimator at line 91 lets the new aggregate round only once; per-run dispatch cost behavior remains unchanged. Cloud values explicitly say `estimated`, with `meteredRuns: 0`; local zero denotes provider inference fees, excluding electricity/hardware. There is no new billing integration.
- `dashboard/src/components/routing-economics-panel.tsx:1` renders one comparison table, coverage beside each metric, estimated-token/cost labels, no-data rows, read-error/retry states, and expandable exact-run links. The types are in `dashboard/src/lib/routing-economics.ts:1`. `dashboard/src/app/activity/page.tsx:132` embeds the panel; `dashboard/src/components/usage-routing-panel.tsx:213` links to it.
- `server/routes/dispatches.js:334`, `dashboard/src/lib/dispatches.ts:55`, and `dashboard/src/components/task-view/dispatch-console.tsx:1189` include a deep-linked dispatch even when it lies beyond the normal latest-50 page. The lookup is task-scoped, and initial hash resolution happens before the request to avoid competing responses.
- New coverage: `server/__tests__/routing-economics.test.js:1` and `dashboard/src/components/__tests__/routing-economics.test.mjs:1`. Design/sequence: `docs/plans/2026-09-28-routing-economics.md`.

The brief's first unverified premise was confirmed by reading the dispatch schema (`server/routes/dispatches.js:57`), trace adapter (`server/services/run-trace.js:223`), prior estimate code, and existing activity deep link (`dashboard/src/components/activity-feed.tsx:305`). Git activity is correlated to dispatches, so counting activity rows again would duplicate attempts. The second quoted “assumption” (“Choose the best implementation approach…”) is an instruction, not a factual claim; the implementation follows these inspected seams.

## Verification and review

- Initial Jest run failed because the new module did not yet exist. Later regression-first checks failed for older-run lookup (50 returned instead of 51) and per-run rounding ($0 instead of $0.015); both were corrected.
- `npx jest server/__tests__/routing-economics.test.js server/__tests__/dispatch-insight.test.js server/__tests__/dispatches.test.js --runInBand` → 2 matched suites, 34 tests passed. There is no separately matching dispatches.test.js; dispatch lookup coverage is in the new economics suite. Its 9 tests exercise aggregate values, empty and single-run data, cost provenance, invalid/missing measurements, read-only HTTP behavior, full 61-row history, exact older-run lookup, cross-task exclusion, and rounding.
- Plain `npm test -- --runInBand` initially produced 106 passing suites and 3 failures in unchanged tests: studio enrichment assumed no YouTube/Google key; praxis-stream loopback assumed no NEXUS_SERVICE_KEY; praxis-env assumed no OPENROUTER_API_KEY. The failure locations are `server/__tests__/studio-route.test.js:383`, `server/__tests__/praxis-stream.test.js:486`, and `server/__tests__/openrouter-free-lane.test.js:138`. No production authentication or test code was changed to work around these assumptions.
- `env -u NEXUS_SERVICE_KEY -u OPENROUTER_API_KEY -u YOUTUBE_API_KEY -u GOOGLE_API_KEY npm test -- --runInBand` → **109 suites passed, 1243 tests passed, 1 skipped**, exit 0. This is the full cockpit suite with absent credentials as those tests expect.
- `cd dashboard && npm test` → **638 passed, 0 failed**, exit 0. Four new rendered tests cover fetching, labels/coverage, empty models/lanes, failure+refresh, and opening an older run's output.
- `cd dashboard && NEXT_DIST_DIR=.next-verify npm run build` → successful compilation/typecheck and route generation, exit 0. Removed only the generated `.next-verify` tsconfig includes afterward.
- Live: `curl -s -o /tmp/nexus-routing-live.json -w 'API HTTP %{http_code}\n' http://127.0.0.1:4000/api/routing-economics` → **API HTTP 200** at `2026-09-29T03:00:18.861Z`. The read returned 2493 cloud attempts, 2484 latency/token observations, estimated USD 15454.038 from 1613 runs, 880 unpriced runs, and 2245 completed of 2484 terminal attempts. Local lane and `google/gemma-4-31b-qat` both returned `state: no_data`, cost/latency/token totals and completion rate null. See `live-summary.json` for the captured summary.
- The supervised API child was restarted once after checking its PID/parent against Praxis's supervisor; Praxis respawned it with the new route. No new daemon or detached work was launched.
- Chrome UI observation: `http://localhost:3000/activity` showed the live comparison, sample sizes and amber estimate labels. Expanded `stealth/ox-alpha` (4 runs), clicked run `9b20c79c-404e-4a96-985f-302e17c32854`, and verified navigation to `/task/a0077b4c-7cf1-4f07-8711-b390ff837515#dispatch-9b20c79c-404e-4a96-985f-302e17c32854`. The matching Codex row opened with its recorded failed-run evidence. The screenshot showed a readable five-column comparison without clipped cells at the browser viewport.
- Code review: re-read the attributable uncommitted tracked diff and new source/tests. A separate read-only review found the old-run paging gap and subtotal rounding issue; both were fixed with regressions, and re-review found no further issue. No leftover debug code or placeholders. `git diff --check` passed. Strict UTF-8 decoding and mojibake scans passed for edited text after each automated edit and in the final validation.

## Knowledge findings and limits

Machine-readable answers, native file hashes/line spans and check times for both research questions are in `research.json`. Cortex discovery returned broad advisory material, not evidence of current populated fields; answers are grounded in current code and the live read.

| Input | Cloud dispatch history | Local dispatch history |
|---|---|---|
| Model/executor | Recorded columns; model missing for some runs | Same schema; no local run observations in the current history |
| Latency | Derived from recorded start/end timestamps for terminal attempts; missing/invalid spans excluded | Same derivation when recorded; currently no data |
| Tokens | Recorded total, or text-volume estimate marked `tokens_estimated`; missing stays null | Same fields supported; currently no data |
| Dollars | Locally estimated from static rates and assumed token mix; no per-dispatch metered dollars | Zero provider inference fees only if an observed local run exists; otherwise null |
| Outcome | Recorded executor status; success share over terminal runs, including failure/timeout/input/cancelled | Same schema; currently no data |
| Rework / QA quality | Follow-up attempts count in spend and duration totals; no claim of QA acceptance or difficulty-adjusted quality | No data |

This is recorded dispatch history, not all inference calls in the fleet. The active model roster is a current inventory; it does not establish a model's historical routing. Unsupported/ambiguous lanes remain unknown. Prices are reused static estimates, not freshly verified provider rates or invoices. Token estimates are not promoted to telemetry. Outcome comparisons reflect assigned work and include failures before model execution; they cannot establish causal model quality or savings. No dispatch routing behavior changed.

PRAXIS_CRITERION: 1 met — New Jest aggregation/HTTP tests passed; live GET returned HTTP 200 with model/lane run counts, median/worst latency, tokens, explicit estimated cost provenance and completion outcomes, each with coverage.
PRAXIS_CRITERION: 2 met — Empty and single-run Jest tests passed; live local lane and configured local model returned no_data with null dollars and completion rate, and the browser displayed “No data — no recorded runs”.
PRAXIS_CRITERION: 3 met — Four rendered dashboard tests passed; live Activity view showed comparison/estimates/sample sizes and clicking the named run opened its matching dispatch evidence; old-run (>50) lookup also passed server and rendered tests.
PRAXIS_CRITERION: 4 met — New Jest suite has 9 passing tests covering aggregation, metered-vs-estimated honesty, empty/thin history; full credential-clean cockpit run passed 109 suites/1243 tests, 1 skipped. Plain-shell credential-dependent failures are identified above.
PRAXIS_QUALITY_GATES: verify=full credential-clean npm test passed 109 suites/1243 tests; dashboard npm test passed 638; isolated build passed; live API HTTP 200 and browser click-through observed; code-review=fixed old-run paging and per-run rounding, re-review clean; UTF-8/mojibake and diff checks passed.

## Binding constraints (verbatim)

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/b4b102c4-aaed-44dd-bd9a-6353509a95cb/workspace with the new path and a reason. Robert, if the re-point is refused.
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
