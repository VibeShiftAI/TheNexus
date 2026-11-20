# Nexus API traffic, November 20, 2026

Nexus received **2,800 requests in 15 minutes** during an executor run with an active dashboard and mobile client. The largest repeatable costs were Praxis leasing tasks whose schedule and board status already agreed, and several dashboard components polling for the same data. The sample did not exhaust the old allowance. The November 19 logs establish the refusal and restart sequence but cannot identify the exact mix of the 6,000 earlier arrivals.

## Who called Nexus

One complete window, **19:22:53.042 to 19:37:53.042 UTC** (14:22 EST). Counts include 68 exact health reads, which already had their own allowance. The other 2,732 would enter the general limiter before this patch.

| Caller | Requests | Main routes and cadence |
|---|---:|---|
| Dashboard browser | 1,661 | Active dispatches 351, 10 s per mounted hook plus task/dispatch events. Chat activity and knowledge activity 180 each, 5 s each. Council sessions 166, 30 s seed plus debounced live updates and a separate station's 5/30 s poll. Pending inbox 136, live events, 60 s fallback and activity-feed evidence reads. Dispatch state 73, 20 s plus events. LLM log 62, 15 s. Token usage 60, typically 60 s per widget. |
| Praxis runtime | 1,042 | 180 lease acquisitions, 180 releases, 220 task reads, 128 event posts, 34 chat-config reads, 32 board reads, 29 calendar reads and 29 health probes. Two calendar loops tick every 60 s. Supervisor health normally runs every 30 s. Event posts follow incoming frames. |
| Mobile client/relay | 68 | Fleet health, service health and Studio channels 18 each, board 14. This route mix matches the iPad hub's 60 s fast and 300 s full refresh, plus view and manual refreshes. |
| Nexus internal | 18 | One GET of its own health route for each incoming fleet-health check. |
| Executor/CLI directly identified | 0 | No command-line or headless user agent. Executor work can also cause calls through Praxis. |
| Unresolved Node | 11 | Four task GETs, two model resolves, one each for projects, workspace delta, activity publish, stream publish and calendar. |
| **Total** | **2,800** | 60 distinct caller/method/route combinations including separately labelled inferred Praxis rows. |

Source locations for those intervals are `dashboard/src/hooks/use-active-work.ts:59`, `use-chat-activity.ts:36`, `use-core-state.ts:65`, `use-dispatch-state.ts:22`, `use-hitl-inbox.ts:99`, `use-token-usage.ts:8`, and `dashboard/src/components/bridge/{activity-provider.tsx:60,dispatch-station.tsx:268,power-station.tsx:160}`. The runtime paths are `Praxis/src/scheduler/calendar-sync.ts:446`, `Praxis/src/calendar-dispatch.ts:516`, `Praxis/src/supervisor/heartbeat.ts:58` and `Praxis/src/ops-events-routing.ts:845`. The mobile implementation is in `Praxis iPad Home Hub/PraxisHub/Views/ContentView.swift:52` and `FleetDashboardManager.swift:104`. The resulting internal probe is in `server/routes/fleet.js:22`.

The November 19 log shows dropped events, calendar and lease refusals, a 429 on health, and the restart between 15:56:56 and 15:57:54 UTC. It lacks successful-request attribution. A temporary HTTP diagnostics subscriber therefore counted arrivals on November 20 and unsubscribed at the window boundary. Agents identified browser and mobile families. Socket samples within five seconds matched 712 requests to the Praxis PID. Another 330 fell within contiguous acquire/read/release triples with a matching peer and under one second elapsed. Tab count is unknown. `requests.tsv` contains normalized, timestamped arrivals. `traffic.tsv` contains their totals. Both omit headers, queries, ports and task identifiers.

## What changed and how much it saved

The before and after columns below use the same input, with temporary services or counted fetches. None of the after figures is a post-deployment traffic estimate.

| Scenario | Before | After |
|---|---:|---:|
| Three active-work panels, one 60 s refusal, first 50 s | 18 active GETs | 1 GET, followed by one successful read at 60 s |
| Three token-usage panels over the same first 50 s | 3 GETs | 1 GET |
| Closed ambient overlay and three inbox readers on mount | 7 reads (4 telemetry, 3 inbox) | 1 inbox read |
| Activity batch without an actionable human request | 1 pending-inbox read | 0 |
| Four already-settled schedule slots, one sweep | 12 requests | 1 status projection, 0 leases |
| Four stream events arriving during a 60 s refusal | 4 refused posts, 4 events discarded | 1 refused post, 1 successful batch after reset, queue empty |
| Three simultaneous model-setting notifications | 27 Nexus reads, including 6 chat-config | 8 Nexus reads, including 1 chat-config |
| Model-control and calendar test suites pointed at a counting Praxis endpoint | 16 outbound refresh notifications | 0 |
| Three ordinary reads through the browser verification harness | 3 sent to its shared-API destination (intercepted) | 0 shared, 3 isolated. Chrome's direct connection also reached the isolated peer. |

The live schedule had 11 completed slots matching SQLite plus one separate recovery intent. Each minute produced 12 acquire/read/release triples. Praxis now reads all slot statuses in one query. Mismatches and recovery intents still use the authoritative lease and task version. A 404 uses the old sweep during rolling upgrades. Model changes share the existing debounced state-document refresh. The event publisher retains refused events until reset.

Active work and usage share a timer and an in-flight read per page. Hidden tabs skip those reads. The root inbox provider owns one subscription, and the ambient overlay loads telemetry only while open. Browser reads honor both Retry-After formats, keep health independent and scope upstream refusals to their route. Writes are never automatically replayed. The two 5 s feeds serve different data and each fired once per interval.

The original server tests triggered 16 real state collections in the sample. Live Praxis logged a generated `/Volumes/Projects/shared-mind/STATE.md` rewrite at 19:23:51.905Z. The matched test above used a counting receiver and verified zero notifications after the fix. The historical browser QA report records port 4000 as its upstream (`docs/reviews/2026-11-19-retired-backend-calls/after/report.json:8`). Its 401 desktop requests include assets and postdate the restart.

## Allowance decision

`git show af28370d1224 -- server/server.js` traces 6,000 to a July change from 1,000 after two viewers had encountered refusals. The author recorded about 25 requests per minute per tab, without a resource calculation for 6,000.

Authenticated loopback Praxis traffic has **no request-count quota**. Its proof derives from the existing independent runtime credential and grants no route permission. The client sends it only to the configured local API and refuses redirects. Other callers retain a per-IP allowance. GET health keeps its own store. A refusal logs caller, method, route, lane and reason and returns Retry-After.

Each bounded store defaults to **5,758 requests per IP per 15 minutes**. One core provides 900,000 ms in the window. On a private SQLite backup, 11 full-board reads each serialized 28,087,299 bytes with median process CPU of 156.3 ms. A repeat measured 160.5 ms. The 5,758 figure uses a full-board read as a common cost unit. Per-IP counters cannot enforce aggregate CPU consumption across addresses.

## Verification and scope

A cross-checkout HTTP run returned browser 200, browser 429, authenticated Praxis 200, health 200, health 429, browser 429. All 181 server suites passed in the isolated test environment. With the expected sibling contract available, the dashboard passed 1,346 of 1,347 tests. The remaining baseline pricing assertion expects $2.525 and renders $1.820 in both revisions. `verification.txt` records the commands and outcomes. Production after-counts await integration and service restart.

<details>
<summary>Patch inventory</summary>

### Files touched:

- TheNexus/dashboard/scripts/retired-backends-browser-check.mjs
- TheNexus/dashboard/scripts/retired-backends-check-api.cjs
- TheNexus/dashboard/src/app/api/token-usage/route.ts
- TheNexus/dashboard/src/app/layout.tsx
- TheNexus/dashboard/src/components/__tests__/bridge-poll-traffic.test.mjs
- TheNexus/dashboard/src/components/__tests__/inbox-alert-target.test.mjs
- TheNexus/dashboard/src/components/bridge/ambient-mode.tsx
- TheNexus/dashboard/src/hooks/__tests__/use-hitl-inbox.test.mjs
- TheNexus/dashboard/src/hooks/shared-poll.ts
- TheNexus/dashboard/src/hooks/use-active-work.ts
- TheNexus/dashboard/src/hooks/use-hitl-inbox.ts
- TheNexus/dashboard/src/hooks/use-token-usage.ts
- TheNexus/dashboard/src/instrumentation-client.ts
- TheNexus/dashboard/src/lib/__tests__/alert-action.test.ts
- TheNexus/dashboard/src/lib/alert-action.ts
- TheNexus/dashboard/src/lib/poll-fetch.ts
- TheNexus/db/index.js
- TheNexus/evidence/689be7c7/findings.md
- TheNexus/evidence/689be7c7/requests.tsv
- TheNexus/evidence/689be7c7/traffic.tsv
- TheNexus/evidence/689be7c7/verification.txt
- TheNexus/server/__tests__/api-traffic.test.js
- TheNexus/server/__tests__/board-summary.test.js
- TheNexus/server/__tests__/calendar-model-control.test.js
- TheNexus/server/__tests__/model-control-route.test.js
- TheNexus/server/middleware/api-rate-limit.js
- TheNexus/server/routes/dashboard.js
- TheNexus/server/routes/model-control.js
- TheNexus/server/server.js
- Praxis/src/agent-dispatch.ts
- Praxis/src/calendar-dispatch.ts
- Praxis/src/chat-cli-session.ts
- Praxis/src/clients/nexus.ts
- Praxis/src/executors/antigravity-cli.ts
- Praxis/src/executors/claude-code.ts
- Praxis/src/executors/codex.ts
- Praxis/src/executors/thinking-levels.ts
- Praxis/src/local-llm/calendar.ts
- Praxis/src/maintenance/executor-discovery.ts
- Praxis/src/maintenance/fleet-preflight.ts
- Praxis/src/memory/state-doc.ts
- Praxis/src/nexus/client.ts
- Praxis/src/nexus/traffic.ts
- Praxis/src/ops-events-routing.ts
- Praxis/src/routes/ops.ts
- Praxis/src/routing/model-router.ts
- Praxis/src/scheduler/terminal-reconciliation.ts
- Praxis/src/stakeholders/nexus-api.ts
- Praxis/src/tools/infra-tools.ts
- Praxis/tests/nexus_event_publisher.test.ts
- Praxis/tests/nexus_runtime_traffic.test.ts
- Praxis/tests/terminal_reconciliation_board_lease.test.ts

</details>

<details>
<summary>Verbatim dispatch constraints</summary>

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/.praxis-worktrees/689be7c7-3ea6-4df9-99c8-5509099aa88f/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/689be7c7-3ea6-4df9-99c8-5509099aa88f/workspace with the new path and a reason. Robert, if the re-point is refused.
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

#### BC-TASK-COMMITS — Commit your OWN verified work as you go, in small, task-scoped, LOCAL commits on the dispatch branch, each ending with the trailer `Task: 689be7c7-3ea6-4df9-99c8-5509099aa88f`. Never `git push`, and never stage or commit anything you did not change in this run.
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

#### BC-WORKSPACE-BINDING — Your home workspace is `/Volumes/Projects/.praxis-worktrees/689be7c7-3ea6-4df9-99c8-5509099aa88f/TheNexus`. You MAY work in additional repos under /Volumes/Projects when the task genuinely needs it, and you MUST name every extra repo you touched — absolute path — and why, in your completion report.
- **Prerequisite (resolve first):** Before writing outside the home workspace, know that the task genuinely needs that repo. Praxis records every write outside the home root, so the record and your report have to agree.
- **Authority (who may waive it):** You, by declaring it in the completion report — that is the sanctioned way to widen the task's footprint. If the WHOLE task belongs in a different repo, re-point it through the workspace endpoint instead so QA's primary diff moves with you.
- **Fallback (do this instead):** If you touched a repo you did not need, say so in the report anyway (an honest extra repo is not a defect); if you cannot tell which repos you touched, list every one you might have.
- **Consequence (if you proceed anyway):** QA collects the diff from every repo you touched and judges it on merit — it never fails you merely for editing another repo. An UNDECLARED extra repo (recorded by Praxis, never named in your report) is the one cross-repo defect QA may raise.

</details>
