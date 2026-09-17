# Ordered endpoint checkpoints — implementation and QA handoff

Task: `143abc00-b3e5-4071-89a1-bc38ae2832fb`. Continued Fable's September 15 implementation; no commit, push, production restart, task lifecycle edit, or adopted Praxis endpoint change.

## Outcome and attribution

The long-term goal remains in `end_state`. A persisted ordered checkpoint plan supplies the effective current endpoint. Nexus atomically records verified completion and the next selection; Praxis supplies fresh evaluations and retains scheduling ownership. The project page exposes authoring, reordering, current/upcoming/completed checkpoints and dated evidence history.

Fable's preserved executor log was read at `/Volumes/Projects/Praxis/data/claude-code-runs/143abc00-b3e5-4071-89a1-bc38ae2832fb.log`. It ended at a usage limit after implementing the schema, SQLite/API transition, tools, dashboard panel, runtime integration, proposal and source workflow documentation. Its rename fixture failed because it also changed the goal; its dashboard API assertions did not account for cachebuster query strings. Newly written runtime tests and actual UI had not been verified. Those changes were retained, investigated and completed.

This continuation fixed evidence replay/freshness, exact historical definition snapshots, copied-observation invalidation, missing revision guards, stale final success after reopen/plan edits, checkpoint criterion knowledge links, selective assessment invalidation, MCP read/guard/verification mismatches, stale UI edit snapshots, and planning/research/final-goal scoping. Checkpoint task sets now require the latest finalized independent `verified` verdict; historical QA imports cannot revive acceptance after a later dispatch. The final-goal verdict is consistent across persistence, steward flags and dashboard readiness. Added meaningful boundary, task-QA, planning and real HTTP/SQLite end-to-end tests.

The primary workspace is correct: canonical persistence/API and dashboard live here (observed `db/index.js:878`, `server/routes/projects.js:463`, `dashboard/src/app/project/[id]/page.tsx:270`). Existing dirty files were reread before narrow additive edits. Voice-chat scrollbar changes and unrelated concurrent runtime work were preserved. No ownership or line-count claims are made from the whole dirty tree.

## Roots and review scope

| Root | Feature paths to review |
| --- | --- |
| `/Volumes/Projects/TheNexus` | `db/project-checkpoints.js`, `db/project-data.js`, `db/index.js`; `server/routes/projects.js`; `services/praxis-mind-mcp/tools/nexus.js`, `lib/board-ops.js`; dashboard `lib/nexus/projects.ts`, `lib/project-checkpoints.ts`, `lib/project-endpoint.ts`, `components/project-endpoint/checkpoints-panel.tsx`, `components/project-brief/mission-brief.tsx`, `app/project/[id]/page.tsx`; checkpoint, endpoint and governance tests; `scripts/checkpoint-qa/server.cjs`; design and this QA handoff |
| `/Volumes/Projects/nexus-shared` | `src/entities/project.ts`, `src/entities/checkpoints.ts`, `src/entities/index.ts`, checkpoint contract tests and rebuilt dist |
| `/Volumes/Projects/Praxis` | `src/knowledge/project-steward.ts`, `end-state-verify.ts`; `src/telemetry/execution-log.ts`; `src/morning/pipeline.ts`, `endpoint-planning.ts`, `knowledge-council.ts`; `src/orchestrator/context-pack.ts`; `src/antigravity/antigravity-tools.ts`; Fable checkpoint wire/client, heartbeat and reflection integration; checkpoint tests, proposal/fixture, `scripts/checkpoint-ui-evidence.ts` |
| `/Volumes/Projects/shared-mind` | Source `workflows/Project Endpoint Interview.md`, `workflows/Project Data Lifecycle.md`, `skills/operations/interview-project-endpoints.md`. No generated projection edits. |
| `/Users/robertwashko/Projects/Nexus-Mobile-Android` | Only generated `lib/shared/praxis-contract.ts`, refreshed with Praxis's canonical generator. It includes checkpoint schemas plus previously stale canonical types; no mobile UI changes. |

Preserved QA baselines: Nexus `5a9a6ca0df0e6f45bfbccdbeeaabd98015ec93f7`; contract `8465889fe43126916b6acb71f282fd5a826cac1e`; Praxis `48ada94487ac1c93a13018293882205db0c17631`; shared-mind `8e3490f4da1c16cceee9548259fed3457692c413`. Fable's feature files already existed at this handoff baseline, including untracked files; review the complete feature alongside the continuation delta, not only `git diff HEAD`.

The mobile workspace add request was attempted before writing and refused with `workspace must be under /Volumes/Projects`. The actual existing mobile checkout is outside that directory, so this report declares it explicitly. Its exact before/after patch is preserved in [mobile-contract.patch](mobile-contract.patch) for primary-workspace QA visibility. No alias or alternate checkout was created to bypass the restriction.

Cortex was inspected read-only: `/Volumes/Projects/TheCortex/TheCortex/python/cortex/api/routes/nexus.py` and `interface/nexus_client.py` pass through project JSON; the new transition client uses Nexus directly. No Cortex changes were necessary. No additional edited roots.

## Verification commands and observed results

Run from the indicated root. Tests use temporary state, never real endpoint acceptance data.

**Nexus — 8 suites, 90 tests passed:**

```sh
npx jest server/__tests__/project-checkpoints.test.js server/__tests__/checkpoint-evidence-boundary.test.js server/__tests__/project-knowledge.test.js server/__tests__/project-need-conditional.test.js server/__tests__/projects-route.test.js server/__tests__/mcp-boundary-security.test.js server/__tests__/praxis-mind-stateless-conformance.test.js server/__tests__/praxis-mind-board-governance.test.js --runInBand --silent
```

Covers legacy preservation, ordered selection/archive/reopen, stable definitions, criteria/knowledge linking, evidence boundaries, three concurrent callbacks, stale revisions, final policy, tool serialization/guard forwarding and MCP boundary security. The new boundary tests reproduced missing guards, copied manual success and caller-supplied final achievement before the fixes. MCP tests verify both intentional observation clearing and refusal when a faulty backend retains it.

**Praxis — 26 tests passed; TypeScript passed with no diagnostics:**

```sh
npx tsx --test tests/checkpoint_planning.test.ts tests/checkpoint_task_evidence.test.ts tests/checkpoint_end_to_end.test.ts tests/project_steward_checkpoints.test.ts tests/end_state_verify.test.ts
npx tsc --noEmit
```

The real end-to-end test runs the steward against an isolated Express project API and SQLite. It printed:

> E2E: A verified once; restart replay duplicate; B unknown/fail stayed current then passed; C completed sequence; final goal waited for its own acceptance; maintain policy and long-term goal unchanged.

The replay runs in a second Node process against the same database. Task evidence tests reject generic completion, uncertain QA and old QA imported after a newer dispatch. Planning tests verify current-only criteria/needs, goal preservation, no next-horizon proposal while current, and archived task-target wording. Steward tests preserve unknown/unavailable, skip and regression distinctions and final knowledge scoping.

**Contract — 15 tests passed; build and typecheck passed:**

```sh
npm run build
npm run typecheck
node --test test/*.test.cjs
```

**Dashboard — 25 focused tests passed; isolated production build passed:**

```sh
node --import ./test/register.mjs --test src/components/__tests__/project-checkpoints-panel.test.mjs src/components/__tests__/project-endpoint-panels.test.mjs src/lib/__tests__/project-endpoint.test.ts
NEXT_DIST_DIR=.next-checkpoints NEXT_PUBLIC_API_URL=http://127.0.0.1:4311 npm run build
node scripts/check-contract-freshness.mjs
```

Component tests exercise authoring, reorder, archive/evidence display, conflict handling and retaining the original edit token when props refresh. Readiness tests verify that pending sequences cannot show final achievement and historical checkpoint-only needs do not re-gate the final goal. Removed only the isolated build's added tsconfig include entries afterward.

**Mobile mirror and encoding:**

```sh
# Praxis
npm run sync:mobile-contract -- --check
npm run check:encoding -- /Users/robertwashko/Projects/Nexus-Mobile-Android/lib/shared/praxis-contract.ts
```

Both passed. Every automated text edit received strict UTF-8/mojibake validation; Praxis's encoding check also ran on changed runtime/test/docs paths. Final scan: **49 text files passed**, zero binary files skipped. The exact paths are in [encoding-files.json](encoding-files.json); each was also decoded with strict UTF-8 and scanned for mojibake.

## Actual UI verification (September 15, isolated only)

Started `node scripts/checkpoint-qa/server.cjs` in Nexus. Its `/__qa` response identified a temporary `nexus-checkpoint-ui-*` SQLite file and project `33333333-1430-4333-8333-333333333333`. Started the isolated Next build on :3311, proxying to that API on :4311. Other services deliberately returned 503; no production service was proxied or probed.

Reproduce the isolated page with these commands in separate terminals after the build above:

```sh
# TheNexus
node scripts/checkpoint-qa/server.cjs
# TheNexus/dashboard
NEXT_DIST_DIR=.next-checkpoints NEXT_PUBLIC_API_URL=http://127.0.0.1:4311 npm run start -- --port 3311
# Praxis, after authoring manual checkpoints in the fixture page
npx tsx scripts/checkpoint-ui-evidence.ts pass
npx tsx scripts/checkpoint-ui-evidence.ts unavailable
```

Using the actual Chrome page, authored Foundation, Containment and Measured value with manual criteria, saved them, and observed a constant long-term goal plus current checkpoint 1/3 and two upcoming checkpoints. At 390×844, the panel was 336px wide and document width 384px, less than viewport width 390px. Controls and wrapped evidence text were usable without horizontal scrolling.

Ran `npx tsx scripts/checkpoint-ui-evidence.ts pass`, then `unavailable` in Praxis. The helper refuses anything except the isolated QA server/project and manual fixtures. UI reload showed Foundation completed once with date/ref, Containment current 2/3 with unknown acceptance, and Measured value upcoming. Expanded Foundation and its evidence history: the prior goal, exact acceptance description, dated result and `fixture:ui-059bea9b-pass` were visible. Reordered the remaining two through the phone-size UI and saved: both mission brief and checkpoint panel selected Measured value, with Containment upcoming. Passed each remaining synthetic acceptance; UI showed 3/3 verified and **Final goal not yet verified**, retaining the long-term goal and maintain policy. Restored desktop viewport and inspected the final screen (1914×870). Browser sizing was reset. After verification, only the two isolated test processes were stopped; the temporary database was retained. Re-run the two documented fixture/start commands for a new isolated session.

The independent reviewer reran tests and inspected source; these visual observations belong to the implementation run and are not misrepresented as an independent browser session.

## Review and activation

Own code-review pass covered uncommitted feature changes and the retained Fable implementation. Fixed the review findings described above; no debug production probes, placeholders or unrelated cleanups were added. An independent `checkpoint_review` agent separately executed focused suites and reviewed multi-root semantics. Its findings were reproduced and corrected. Its final independent rerun reported Nexus 90, Praxis 26, contract 15 and dashboard 25 passed; it then read this walkthrough and found no documentation discrepancy. This is supplementary evidence; **normal Nexus cross-executor QA remains the lifecycle handler's next gate after the completion handoff**. No task status or QA verdict was changed to simulate that gate.

[Architecture/migration](../project-checkpoints.md) documents ownership, revision guards, freshness, archived definitions, no automatic regression and final completion policy. The proposed Praxis sequence is labelled non-adopted in `/Volumes/Projects/Praxis/docs/proposals/praxis-checkpoint-sequence-proposal.md` and its test fixture. The live criterion IDs and endpoint revision were refreshed read-only. Seven days is explicitly a proposed first acceptance period; final measurement duration remains an operator choice. No invented threshold was adopted and no live criterion was marked passed.

Activation still requires the next authorized reload of the supervised Nexus API and Praxis runtime; existing stdio MCP clients need reconnecting for tool schemas. No production supervisor restart was performed. The production dashboard is configured for dev hot reload, but the actual UI verification here used the isolated production build. No new horizon, auto-park/archive or dispatch permission was added.

The dispatch's path warning was resolved: `src/knowledge/project-steward.ts` exists under `/Volumes/Projects/Praxis`, not under Nexus. The five “unverified assumptions” were treated as requested behaviors/handoff checks: current endpoint selection, prominent UI treatment and guarded evidence progression were exercised above; preserved Fable work/log and current statuses/diffs were inspected before edits.

## Binding constraints (verbatim from task contract)

#### BC-WORKSPACE — Do the work inside /Volumes/Projects/TheNexus — QA's primary diff comes from there; any additional repo you touch must be named in your completion report.
- **Prerequisite (resolve first):** The assigned workspace must be the repo that holds the main body of the code this task changes. Check that before your first edit, not after.
- **Authority (who may waive it):** Praxis, via the task re-point endpoint — POST /api/tasks/143abc00-b3e5-4071-89a1-bc38ae2832fb/workspace with the new path and a reason. Robert, if the re-point is refused.
- **Fallback (do this instead):** If the WHOLE task belongs elsewhere, re-point the task first and then do ALL the work in the new directory; if you only realise at the end, still call the endpoint with "baseline":"head". If the task merely also needs another repo, work there and declare it in your report. If neither is possible, report needs_input.
- **Consequence (if you proceed anyway):** QA builds the authoritative diff from this workspace and the dispatch-time snapshot, plus the diff of every additional repo the run touched and declared. Work done in an undeclared repo that Praxis could not record is invisible to review, and a round with no work in any visible repo fails as an empty diff no matter how correct the change is.

#### BC-CRITERIA — Satisfy every acceptance criterion above and cite the command or observation that proves each one.
- **Prerequisite (resolve first):** Each criterion has to be verified against real behavior before you report complete — a criterion you did not run is a criterion you did not meet.
- **Authority (who may waive it):** The QA reviewer rules on a criterion you can show is defective; Robert's operator rulings override both. Neither happens silently — you have to raise it.
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

#### BC-WORKSPACE-BINDING — Your home workspace is `/Volumes/Projects/TheNexus` and `/Volumes/Projects/nexus-shared` and `/Volumes/Projects/Praxis` and `/Volumes/Projects/shared-mind`. You MAY work in additional repos under /Volumes/Projects when the task genuinely needs it, and you MUST name every extra repo you touched — absolute path — and why, in your completion report.
- **Prerequisite (resolve first):** Before writing outside the home workspace, know that the task genuinely needs that repo. Praxis records every write outside the home root, so the record and your report have to agree.
- **Authority (who may waive it):** You, by declaring it in the completion report — that is the sanctioned way to widen the task's footprint. If the WHOLE task belongs in a different repo, re-point it through the workspace endpoint instead so QA's primary diff moves with you.
- **Fallback (do this instead):** If you touched a repo you did not need, say so in the report anyway (an honest extra repo is not a defect); if you cannot tell which repos you touched, list every one you might have.
- **Consequence (if you proceed anyway):** QA collects the diff from every repo you touched and judges it on merit — it never fails you merely for editing another repo. An UNDECLARED extra repo (recorded by Praxis, never named in your report) is the one cross-repo defect QA may raise.
