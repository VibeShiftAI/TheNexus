# Evidence: local model chosen under Model Control (task fa032fc0, 2026-11-24)

The review package in `../2026-11-23-local-model-control/` holds only the three
review screenshots (registered revision `5a481277`). Everything else that backs
the task is here. Test and log outputs are copied verbatim, so they can contain
the products' own wording (including dashes in their log messages). One file is
an extract rather than a whole log: `merged-main/praxis-full-suite-summary-and-failures.txt`,
cut verbatim from a 6.1 MB log by `merged-main/praxis-full-suite-extract.sh`.

Three repositories changed, each on its own task branch:

| Repository | Baseline | Branch head | Main at the merged checks |
| --- | --- | --- | --- |
| TheNexus | `bd02642` | `6e14bc87`, plus evidence-only commits after it (`f8761e33` and the one that adds this update) | `3189bb99` |
| Praxis | `1fcf4b59` | `cad6afb2` | `24c1abaa`, `4d076f91`, `613f66b6`, then `fbce5c26` |
| TheCortex | `5fdb76a` | `e611edc` | `3617672` |

The task's commits, oldest first:

| Repository | Commits |
| --- | --- |
| TheNexus | `fc23f07a`, `d93b3453`, `5d43f2c9`, `3770d86e`, `e1bfcc97` (round 1 and its evidence); `f2644c44`, `7f915704`, `09b75ae8` (the model row made at apply, the seed fix, the evidence update); `6e14bc87` (reasoning checked both ways) |
| Praxis | `766635bc`, `ac0b13e0`, `90d44073`; `6f9fb79b` (switch findings held, local primary follows Model Control); `cad6afb2` (round 4, below) |
| TheCortex | `42b67e2`, `ea37c44`, `0909b22`; `e611edc` (overlapping reads, below) |

## Changes since the 13:06 evidence update (`09b75ae8`)

### TheNexus `6e14bc87` (test only)

Code review of `f2644c44` and `7f915704` noted that "reasoning is carried onto
the row" was proven one way only: a reasoning model's row was checked for
reasoning, but no row was checked for its absence. The test now also checks
that the row made for Gemma 4 31B, whose listing names no reasoning, claims none
(`capabilities: { chat: true, local: true }`).

- `nexus-round3-checks.sh`, output in `nexus-round3-checks-output.txt`:
  - `local-model-selection.test.js` on the working tree that became `6e14bc87`:
    17/17 (`nexus-local-model-selection-tests.txt`).
  - Mutation X, in a scratch copy: every made row claims reasoning. Only the
    test with the new assertion fails, 1 failed and 16 passed
    (`mutations/nexus-mutation-x.txt`).
  - The 23 related server suites: 268/268 (`nexus-related-server-tests.txt`).
  - The network guard refused nothing in any of the three.

### TheCortex `e611edc`

Code review of `0909b22` found that the last model Nexus named was written by
whichever read reached the lock last. Graphiti runs its LLM calls at the same
time, each reading Nexus in its own thread, so a read served just before Praxis
applied a switch could come back after one served just after it, and put the
replaced model back as the last answer. A Nexus outage right after that would
have sent every call to the replaced model.

- Reads are now numbered as they start. The last answer changes only for a read
  newer than the one it came from, as Praxis already does
  (`src/llm/local-model-selection.ts`, `newestReadActedOn`). Each call still
  sends what its own read returned.
- `cortex-local-model-tests.txt`: `tests/test_local_model_setting.py`, 23
  passed. The new test makes two overlapping reads, the older one coming back
  last, then an outage: Graphiti and the eval teacher keep the newer model.
- `cortex-offline-tests.txt`: the 11 offline test files, 293 passed.
- Mutation Y, in a scratch copy, removes the read-order guard. Only the new test
  fails, 1 failed and 22 passed (`mutations/cortex-mutation-y.txt`, script and
  summary beside it).
- This memory lasts one process. An eval run that starts while Nexus is down has
  had no answer yet, so it takes its environment fallback and logs it (the
  start-up rule).

### Praxis `cad6afb2` (round 4)

The review of `6f9fb79b` found three defects in the local model switch.

1. A call that waited out a switch being recorded was refused as
   `switched_away` whenever an earlier switch had replaced the model it names,
   even when the wait took nothing into effect (busy, superseded, failed). Each
   switch now carries its number (`localModelSwitchCount`), and the slot claim
   refuses only for a switch that took effect during the call's own wait.
2. Only the last switch was remembered. After two switches with no local call
   between them, the first replaced model still had to wait out its idle
   period, and a new spelling of the model in effect was recorded as a switch.
   `src/llm/local-model-state.ts` now keeps one entry per replaced model,
   dropped by model key when that model is chosen again; a new spelling
   replaces nothing.
3. `chat()` on a local primary counted each attempt on its own, so a switch
   could take effect between the empty-slot reload and its retry, and between a
   cut answer and the output-room retry. The primary's attempts now run as one
   counted local call (`tryPrimary` inside `trackLocalCall`). The local provider
   is registered with its count outside the output-room wrapper
   (`countedLocalProvider`). `chatStream` reads the local primary's model when
   that candidate is tried.

Tests:
- Eight new cases in `tests/local_model_selection.test.ts` and
  `tests/local_model_primary.test.ts` (33 cases before, 41 now). The commit
  message says seven: the eighth is the unit case for the idle judgement ("each
  model a switch replaced may go without the idle period, judged by the latest
  switch away from it"), which mutation s2 fails together with its integration
  case.
- Mutations s1 to s7 each undo one part of these fixes, and each fails only the
  cases that cover that part (`mutations/praxis-mutations-s.sh`, summary in
  `mutations/praxis-mutations-s-output.txt`, runs in
  `mutations/praxis-mutation-s1.txt` to `s7.txt`).
- `tests/quantized_tool_gate.test.ts` changed too. Its test "chat skips a
  breached local primary and succeeds through the online fallback" set the
  breached model through `manager.activeModel`. Since `6f9fb79b` a local primary
  runs the local model chosen under Model Control (`primaryModel()` in
  `src/llm/manager.ts`), so that model was never used and the test failed (the
  wider run before the fix, `praxis-wider-tests-before-fixture-fix.txt`,
  472/473).
  - The fixture now makes the breached model the local model in effect
    (`config.localLlmModel = "gemma-q4"`, restored afterwards). The assertion,
    `{ localCalls: 0, googleCalls: 1 }`, is unchanged.
  - Mutation Z removes the quantized gate from `chat()`'s primary attempts in a
    scratch copy of `cad6afb2`: the test fails, 10/11. Restored: 11/11
    (`mutations/praxis-mutation-z.sh`, `praxis-mutation-z-output.txt`,
    `praxis-mutation-z.txt`, `praxis-mutation-z-restored.txt`).

The round-4 test runs on the branch below (the selection, nine-file, related and
wider runs; first log lines 14:05:12 to 14:07:43 EST) started after the last
edit to the seven committed files (14:04:38) and before the commit (14:09:43),
so each ran exactly the committed code. The exceptions are named:
`praxis-wider-tests-before-fixture-fix.txt` ran at 14:00, before the fixture
change; both `tsc` runs and the encoding check ran at the end, on the clean
branch heads; the merged-tree runs used the committed diff. Mutations s1 to s7
ran at 13:54 on `6f9fb79b` plus a patch of six files
(the four source files and the two test files), identical to
`6f9fb79b..cad6afb2` for those files; the seventh file,
`tests/quantized_tool_gate.test.ts`, is not part of their runs.

## Final results on the branch heads

Every run used guards, kept in `guards/`:
- `net-guard.mjs` refuses anything leaving the machine and every live local port
  (1234, 3000, 3777, 4000, 4199, 8100, 54322).
- `lmstudio-guard.mjs` refuses fetches to LM Studio (port 1234) and to the dead
  test port 1.
- `fake-lms` is a refusing `lms`, passed as `PRAXIS_LMS_BIN`.
- `live-port-guard.mjs` (round 4) works at `net.Socket.prototype.connect`,
  which http, https, fetch and database drivers all go through. It refuses every
  connection to a host off this machine, and every loopback connection to a port
  that was listening when the run started. A test's own server binds after that
  snapshot, so its traffic passes. Its self-test (`live-port-guard-selftest.txt`,
  63 listening ports) reaches its own server and is refused at :4000 and at
  example.com.
- `cli-shims/` (round 4) are stand-ins for `claude`, `codex`, `agy`, `lms`,
  `ollama`, `say`, `afplay` and `osascript`, first on `PATH` and named in
  `CLAUDE_CODE_BIN`, `CODEX_BIN` and `AGY_BIN`. Each records the call and exits
  1.
- `praxis-files-guarded.sh` (round 4) runs named Praxis suites under all of the
  above, keyless (`GOOGLE_API_KEY`, `YOUTUBE_API_KEY` and `PRAXIS_DATA_DIR`
  unset), with `LOCAL_LLM_URL` on port 1.
- `cortex-tests.sh` runs TheCortex's pytest with every service URL on port 1 and
  `-p offline_network_guard`; TheCortex's conftest installs `cortex_test_guard`
  as well.

The guards log to the scratch folder named in each script, deleted at the end of
the task; the logs cited below are copied here as `.txt`. Before the folder was
deleted, `guards/guard-logs-scan.py` listed every guard log in it, with its line
count and any line naming port 1234: 87 logs, no such line
(`guards/guard-logs-scan.txt`).

| File | What ran | Result |
| --- | --- | --- |
| `nexus-local-model-selection-tests.txt` | TheNexus `server/__tests__/local-model-selection.test.js` | 17/17 |
| `nexus-related-server-tests.txt` | 23 TheNexus server suites around model control, model rows, Studio, astro and the auth mounts, keyless | 268/268 |
| `dashboard-tsc.txt` | `npx tsc --noEmit` in `dashboard/`, at the end on the clean head `6e14bc87` (14:49 EST) | exit 0 |
| `dashboard-local-model-tests.txt` | `local-model-chooser`, `chat-model-control`, `fast-refresh-boundaries` | 23/23 |
| `dashboard-full-suite.txt` | dashboard `npm test` | 1460/1463 (see the failures below) |
| `dashboard-document-review-rerun.txt` | `document-review.test.mjs` alone | 21/21 |
| `dashboard-baseline-failing-tests.txt` | the two pre-existing failures on baseline `bd02642` | both fail there too |
| `praxis-local-model-selection-tests.txt` | Praxis `local_model_selection`, `local_model_primary` and `quantized_tool_gate` | 52/52 |
| `praxis-related-tests.txt` | 40 Praxis test files around the local lane, the LLM manager, autoload, the local worker, the ops routes and the route inventory | 527/527 |
| `praxis-more-related-tests.txt` | the 9 other Praxis test files that name a changed symbol (`cli-concurrency`, `LOCAL_LLM_MODEL` and the like) | 111/111 |
| `praxis-wider-tests.txt` | the 40 other Praxis test files that import the LLM manager, the local model state or the output-room wrapper (`praxis-wider-test-list.txt`, less `maintenance_review_regressions`, which makes its data dir in a shared folder); runner `praxis-wider-run.sh` | 473/473 |
| `praxis-tsc.txt` | `npx tsc --noEmit` in Praxis, at the end on the clean head `cad6afb2` (14:49 EST) | exit 0 |
| `praxis-lmstudio-guard.txt`, `praxis-fake-lms-calls.txt`, `praxis-cli-shims-related.txt` | what the guards caught in the 40-file run | 1 POST to port 1 from `member_profile_updates.test.ts` (its own dead URL, pre-existing); no call to the fake `lms` (the file is empty); 3 `--version` calls (`claude`, `codex`, `agy`); the network and live-port guards refused nothing |
| `praxis-encoding-scan.txt` | `npm run check:encoding` over the Praxis files changed | see `encoding-and-dash-scans.txt` |
| `cortex-offline-tests.txt` | 11 TheCortex test files (listed in `merged-main/merged-main-check.sh`) | 293 passed |
| `cortex-local-model-tests.txt` | TheCortex `tests/test_local_model_setting.py`, verbose | 23 passed |
| `encoding-and-dash-scans.txt`, made by `final-scans.sh` | UTF-8 scans of every file changed in each repository, and em dashes in added lines | see the file; summary at the end of this README |

In the runs behind `praxis-local-model-selection-tests.txt` (3 files, 52 tests)
and `praxis-more-related-tests.txt` (9 files, 111 tests) every guard log is
empty. In the wider run the guards caught only the pre-existing
`chat_turn_steps_legacy` calls described below (`praxis-cli-shims-wider.txt`,
`praxis-net-guard-wider.txt`).

Praxis's own test bootstrap also refuses live requests, and prints `[tests/bootstrap]
refused live fleet request` when it does:
- 20 times in `praxis-related-tests.txt`: 18 `POST :4000/api/ai/usage` and 2
  `GET :8100/api/status`. The round-3 run of the same files (519 tests, at
  `09b75ae8`) shows the same 20, so they come from suites that do not stub the
  usage report, not from this round.
- 3 times in `praxis-more-related-tests.txt` (`GET :4000/api/model-control/fable-availability`).
- 11 times in `praxis-wider-tests.txt` (`GET :8100/api/status`, `POST :4000/api/ai/usage`,
  `GET :4000/api/projects`, `GET :4000/api/model-control/claude-default`).

Nothing reached Nexus or TheCortex.

`chat_turn_steps_legacy.test.ts`, in the wider set and unchanged by this task,
spawns the `agy`, `claude` and `codex` CLIs and posts to openrouter.ai. The shims
and the network guard refused all of it: 6 CLI runs and 6 requests in the wider
run. On plain main `4d076f91` it does the same, 6 and 6, and passes there with
`quantized_tool_gate`, 13/13 (`merged-main/praxis-chat-turn-steps-and-quantized-plain-main.txt`
and its two logs). The related runs of earlier rounds had no CLI shims. The same
40 files under the shims made only the three `--version` calls listed above, so
those earlier runs started no CLI chat either; `--version` runs on this machine
and starts nothing.

## Merged with current main (`merged-main/`)

Each repository's branch diff against its baseline was applied to `git archive
main` in a scratch directory outside every repository, with the same guards. No
worktree, branch or clone was made.

### TheNexus and TheCortex

- Earlier checks, TheNexus at `f2644c44` and then `7f915704`, TheCortex at
  `0909b22`: `merged-main-check.sh` and `nexus-seed-fix-check.sh`, outputs
  beside them.
  - TheNexus first run: 269/270 (`nexus-server-tests-first-run.txt`). The
    failing test, "with no model in effect a choice is answered as waiting until
    Praxis applies it, and choosing makes no models row; the switch does",
    asserts at line 416 that no models row names Inkling 2 Mini. Main's seed,
    from the readiness task `9227d9b6`, adds that row, so the test's starting
    condition was false.
  - Fix, commit `7f915704`: the test uses a model that no seed lists
    (`acme/reasoner-12b`) and keeps every assertion. The test after it now also
    checks that a new row takes a free id (`local-gemma-4-31b-2`) when
    `local-gemma-4-31b` names another model. Mutations H2, V and W fail as they
    should (see below).
  - Dashboard: `tsc` exit 0 (`dashboard-tsc.txt`); 23/23
    (`dashboard-local-model-tests.txt`).
- After round 3, `merged-main-check-round3.sh` (output
  `merged-main-check-round3-output.txt`):
  - TheNexus main `3189bb99` plus the branch diff at `6e14bc87`, 124 files: the
    23 related server suites, 270/270 (`nexus-server-tests.txt`).
  - TheCortex main `3617672` plus the diff at `e611edc`, 12 files: 293 passed
    (`cortex-offline-tests.txt`).
  - The guards refused nothing.

### Praxis, earlier rounds

- Main `24c1abaa`, at `6f9fb79b` (`merged-main-check.sh`): `tsc` exit 0
  (`praxis-tsc.txt`).
  38 of the 40 related test files exist on main (main deleted
  `trading_reflection_local_model` and `trading_reflections` in `f8e444a2`).
  Result 507/509 (`praxis-related-tests.txt`). The two failures read git (`git
  rev-parse HEAD`, `git show 1cac649:src/webhook.ts`), and the merged tree is a
  plain directory.
  - On plain main archived the same way they fail the same way: 48/50, with 8
    "not a git repository" lines (`praxis-git-reading-tests-plain-main.txt`). On
    the branch checkout they pass, 50/50
    (`praxis-git-reading-tests-branch.txt`).
  - The route inventory test passes on the merged tree with a read-only git shim
    (`praxis-git-shim.sh`) that forwards only `git show 1cac649:src/webhook.ts`,
    4/4 (`praxis-route-inventory.txt`, shim log `praxis-git-shim-log.txt`). The
    freshness test was not shimmed: it runs many git commands against its own
    repository state, so pointing it at another repository would make its
    result meaningless.
- Main `4d076f91`, at `6f9fb79b` (`praxis-merged-main-4d076f91.sh`, output
  beside it): merge-tree clean; `tsc` exit 0; 39 files, 509/511
  (`praxis-related-tests-main-4d076f91.txt`), the same two git-reading
  failures; the route inventory passes with the shim; plain `4d076f91` fails the
  same two tests (`praxis-git-reading-tests-plain-main-4d076f91.txt`, script
  `praxis-git-checks-main-4d076f91.sh`).

### Praxis after round 4 (`cad6afb2`)

Main `4d076f91`:
- `praxis-merged-main-cad6afb2.sh` (output beside it): `git merge-tree` merges
  without conflict, 17 files applied, `tsc` exit 0
  (`praxis-tsc-main-4d076f91-cad6afb2.txt`).
- The whole suite on that merged tree: `praxis-full-suite.sh`, summary in
  `praxis-full-suite-output.txt`, extract in
  `praxis-full-suite-summary-and-failures.txt`.
  - 895 of 901 suites. Left out: the six `maintenance_*` suites, which make
    their data dir under `/Volumes/Projects/maintenance-mode-worktrees` (a
    shared folder) instead of a temp dir.
  - 10,649 tests: 10,586 pass, 47 fail, 16 skipped. 31 suites have failures
    (`praxis-full-suite-failing-suites.txt`).
- The same 31 suites on plain main `4d076f91`, and again on the merged tree:
  503 tests, 457 pass, 46 fail on each (`praxis-failing-suites-plain-main.txt`,
  `praxis-failing-suites-merged.txt`).
  - The failing test lists are identical (`praxis-failing-tests-plain-main.txt`
    and `praxis-failing-tests-merged.txt`; `diff` finds no difference).
  - The guards refused the same calls on both sides: 1 POST to this machine's
    LAN address (192.168.86.205) from a callback test, `imap.gmail.com` from
    `mail_network`, `mixed.test` from `research_web_retrieval`, one connection
    to port 54322, and 6 CLI `--version` calls. Logs:
    `praxis-failing-suites-merged-*.txt` and
    `praxis-failing-suites-plain-main-*.txt`.
  - Each of the 46 is listed under "Failures that are not this task's".
- The 47th failure of the full run is `tts_provider.test.ts` "local deadline
  covers both waiting for headers and stalled response bodies"
  (`praxis-failing-tests-full-run.txt`). It passed in the 31-suite run on the
  merged tree, and alone, 35/35 (`praxis-tts-provider-alone-merged.txt`). It is
  a timing test, and it failed under the load of the full run.
- The full run's guards also refused requests from suites outside those 31
  (`praxis-full-suite-net-guard.txt`, `-live-port-guard.txt`,
  `-lmstudio-guard.txt`, `-cli-shims.txt`):
  - 2 `GET :4000/api/tasks/background-test-19`;
  - 2 `GET openrouter.ai/api/v1/models`;
  - 1 `POST vibeshiftai.com/api/reports`;
  - 3 openrouter chat requests and 3 CLI runs from `chat_turn_steps_legacy`;
  - 4 more CLI `--version` calls;
  - 2 requests to the dead port 1 (`member_profile_updates`,
    `run_model_dispatch_state`).

  The five suites behind the network requests (`background_obligations`,
  `model_prices`, `openrouter_roster`, `stakeholders`, `chat_turn_steps_legacy`)
  make the same requests on plain main `4d076f91`: 95 pass, 2 skipped, 0 fail,
  with 2 + 2 + 1 + 6 requests and 6 CLI runs refused
  (`praxis-network-hazard-suites-plain-main.txt` and its two logs).
- `praxis-copy-identity-check.sh` (output `praxis-copy-identity-check-output.txt`)
  hashes every tracked file under `src`, `tests` and `scripts`, and
  `package.json`, in each scratch copy and compares it with the git tree the
  copy stands for:
  - the plain copies with `4d076f91` and `613f66b6`;
  - the merged copies with the tree that `git merge-tree --write-tree` writes for
    the real merge of that main with `cad6afb2`.

  All four match file for file (2213, 2217, 2227 and 2231 files), with no extra
  files.

Main `613f66b6` (moved at 14:25:54, the proof-baseline lifecycle; since
`4d076f91` the only file both it and the branch change is `src/index.ts`, in
separate hunks):
- `praxis-merged-main-613f66b6.sh` (output beside it): merge-tree clean, `tsc`
  exit 0 (`praxis-tsc-main-613f66b6.txt`).
- 92 suites: the 38 related ones that exist on main (main deleted the two
  trading suites), the nine, the 40 wider ones (`quantized_tool_gate` among
  them) and the five that main added. 1134 tests, 1132 pass
  (`praxis-tests-merged-613f66b6.txt`). The two failures are the git-reading
  tests (`code_freshness_recovery`, `webhook_routes_inventory`). The guards
  caught the known calls only: `member_profile_updates`'s POST to port 1, 6
  openrouter requests and 6 CLI runs from `chat_turn_steps_legacy`, and 3
  `--version` calls (`praxis-tests-merged-613f66b6-*.txt`).
- That script archived `main` twice, and main fast-forwarded to `3b431d2b` at
  14:31:18 between the two calls. Its plain copy was therefore `3b431d2b`, which
  changes two files the branch does not touch (`src/telemetry/step-redaction.ts`,
  `tests/run_record_redaction.test.ts`); see
  `praxis-copy-identity-check-output-before-rebuild.txt`.
  `praxis-plain-main-613f66b6-rerun.sh` (output beside it) rebuilt the plain
  copy from `613f66b6` by its full hash and checked it file by file, 0 differ.
  The two git-reading suites fail there the same way, 48/50
  (`praxis-git-reading-tests-plain-main-613f66b6.txt`).

Main `fbce5c26` (moved at 14:36:24, the research-tool fixes). Its seven changed
files since `613f66b6` (the research worker and the run-record redaction) share
none with the branch, but two modules meet across the merge: the branch's
`src/nexus/client.ts` imports `src/telemetry/step-redaction.ts`, which main
changed, and main's `src/research/deep-research-worker.ts` imports
`src/llm/manager.ts`, which the branch changed.
- `praxis-merged-main-fbce5c26.sh` (output beside it) resolves main to its full
  hash once and archives that, so a later move of main cannot change the copies.
  Merge-tree clean; the merged copy matches the merge-tree's tree file for file
  (2231 files, 0 differ, 0 extra); `tsc` exit 0 (`praxis-tsc-main-fbce5c26.txt`).
- 96 suites: the 92 of the `613f66b6` check plus the four suites that import the
  research worker or the step redaction and were not already among them
  (`executor_trace_redaction`, `model_inputs_whole`, `research_worker_outcomes`,
  `run_record_redaction`). 1179 tests, 1177 pass
  (`praxis-tests-merged-fbce5c26.txt`). The two failures are the git-reading
  tests again. They fail the same way on a plain copy of `fbce5c26` (checked
  file by file: 2227 files, 0 differ), 48/50
  (`praxis-git-reading-tests-plain-main-fbce5c26.txt`).
- The guards caught the known calls only: `member_profile_updates`'s POST to
  port 1, 6 openrouter requests and 6 CLI runs from `chat_turn_steps_legacy`, and
  3 `--version` calls. The live-port guard refused nothing
  (`praxis-tests-merged-fbce5c26-*.txt`).

## Mutations (`mutations/`)

Each mutation was applied in a scratch copy, never in a worktree, one at a time,
and restored before the next. The guards were on. In each run, the only failures
are the tests named in that run's output file, and each of those tests covers
the behaviour the mutation breaks.

| Mutation | What it breaks | Failing tests |
| --- | --- | --- |
| Praxis E | autoload's switched-away branch never releases the replaced model | 2 |
| Praxis F | the switch moment is not compared, so a request after the switch does not count | 2 |
| Praxis G | `planFrom` ignores Nexus's waiting flag, the condition before the round-1 fix | 1 |
| Praxis G2 | `planFrom` ignores the waiting flag altogether | 2 |
| Praxis T | `planFrom` goes back to "flag or differing names" | 1 |
| Praxis J | the primary keeps `LLM_PRIMARY_MODEL` instead of the Model Control setting | 3 |
| Praxis K | the worker writes the calendar entry before the job is counted | 1 |
| Praxis L | `chatVia` counts a pinned local call only while LM Studio answers | 2 |
| Praxis L2 | no counting in `chatVia`; only the provider wrapper counts | 2 |
| Praxis M | a call made inside a counted call is counted again | 1 |
| Praxis N | a call naming the waiting model reloads the model in effect on an empty slot | 1 |
| Praxis O | a call that waited for the apply and names the replaced model is sent anyway | 1 |
| Praxis P | the busy answer is logged every time Praxis asks | 1 |
| Praxis Q | an older answer from Nexus is acted on after a newer one | 1 |
| Praxis R | the read-back takes Praxis's spelling of the model, not Nexus's | 1 |
| Praxis R2 | the read-back compares names exactly | 1 |
| Praxis U | counting starts at `chatVia`'s entry, before the lane decision | 1 |
| Praxis s1 | a call that waited is refused whenever any earlier switch replaced the model it names | 1 |
| Praxis s2 | only the most recent switch away is judged for the idle period | 2 |
| Praxis s3 | a new spelling of the model in effect is recorded as a switch | 1 |
| Praxis s4 | a replaced model chosen again under another spelling stays recorded | 1 |
| Praxis s5 | `chat()` on a local primary is not counted as one local call | 1 |
| Praxis s6 | the count sits inside the output-room wrapper, so its retry is a second call | 1 |
| Praxis s7 | the streamed local primary uses the model listed when the call began | 1 |
| Praxis Z | `chat()` skips the quantized tool gate on its primary attempts | 1 |
| TheNexus H | choosing makes or reactivates the models row (round-1 behaviour) | 2 |
| TheNexus H2 | H again, on the test after the seed fix | 2 |
| TheNexus I | the alias editor's old `local_default` guard | 1 |
| TheNexus V | a new row takes the derived id even when another row has it | 1 |
| TheNexus W | the new row drops LM Studio's reasoning flag | 1 |
| TheNexus X | every made row claims reasoning | 1 |
| TheCortex A | `_generate_response` (`memory/client.py:181-185`) awaits between taking the model and sending it | 1 |
| TheCortex B | that per-call override is removed | 1 |
| TheCortex C | `local_model.py:109` `if _last_answer:` becomes `if False and _last_answer:`, so the last model Nexus named is not kept | 4 |
| TheCortex D | `memory/client.py:113` builds the client from `graphiti_local_model()`, a Nexus read, instead of the static fallback | 1 |
| TheCortex Y | the read-order guard in `local_model.py` is removed, so an older read that answers last replaces a newer answer | 1 |

Scripts: `praxis-mutations-ef.sh`, `praxis-mutation-g.sh`,
`praxis-mutations-jt.sh` (J to T and G2), `praxis-mutations-u.sh` (U and L2),
`praxis-mutations-s.sh` (s1 to s7), `praxis-mutation-z.sh`,
`nexus-mutations-hi.sh`, `../merged-main/nexus-seed-fix-check.sh` (H2, V, W),
`../nexus-round3-checks.sh` (X) and `cortex-mutation-y.sh`. The four TheCortex
edits A to D are described in the table, each a single replacement asserted to
match exactly once.

## Real-browser check (isolated stack)

- `local-model-browser-check.mjs`: the check. One process owns the whole stack:
  - a fake LM Studio;
  - saved load profiles in a temporary LMSTUDIO_HOME;
  - a Praxis stand-in with Praxis's switch rule;
  - a throwaway Nexus API on an empty temporary database;
  - `next dev` and headless Chrome.

  It never touches the live board, nexus.db, LM Studio or Praxis.
- `api-network-guard.mjs`: preloaded into the throwaway API. It refuses and logs
  every connection that would leave the machine or reach a live local port.
- Run the check in a copy of the tree, as `browser-check-final-tree-rerun.sh`
  does. It writes its screenshots into the tree it runs in, so a run in the
  worktree would rewrite the three registered screenshots (their clock times
  change). They would then no longer match registered revision `5a481277`.
- `browser-check-output.txt` and `report.json`: the round-1 run that made the
  registered screenshots. 61 CHECK_OK, 0 CHECK_FAIL, exit 0.
- `browser-check-final-tree-rerun.txt` and `report-final-tree-rerun.json`: the
  rerun on `7f915704`, in a scratch copy.
  - 61 CHECK_OK, 0 CHECK_FAIL, exit 0.
  - The fake LM Studio received 17 requests, all `GET /api/v1/models`.
  - The guard refused 2 read-only Cypher POSTs to :8100 from the existing
    knowledge-activity widget (`server/services/topic-access.js:23`).
  - There were no page exceptions.
  - The API logged two switches, each with "nothing was loaded".
- Since `7f915704`, TheNexus changed only its evidence and one test assertion
  (`6e14bc87`), and the dashboard has not changed since `e1bfcc97`, so that rerun
  still shows the final panel and API. Round 4 changed how Praxis counts local
  calls and which waits it refuses, which the panel does not show; Praxis's own
  tests cover it.
- `review-screenshots-vs-final-tree.txt`, made by `review-shots-compare.py`,
  compares the registered screenshots with the rerun's:
  - desktop list: byte-identical;
  - waiting shot: differs in three text lines only, the clock times of each run
    (10:45 AM and 10:41 AM against 12:39 PM and 12:35 PM). See
    `waiting-shot-differences-registered-above-rerun.png`;
  - phone shot: same size and same text. Its elements sit up to 1 device pixel
    (half a CSS pixel) higher or lower.
- `browser-check-run1-failed.txt` and `browser-check-run2-failed.txt`: earlier
  round-1 runs, kept for the record.
  - Run 1 (11 failures) expected LM Studio's names where the panel shows the
    registry names ending in " (local)". The check was corrected to the
    documented names. Run 1's screenshot also showed the tall alias card
    stretching the Global Local Only box, which led to the layout fix in
    `dashboard/src/app/model-control/page.tsx`.
  - Run 2 (22 failures) clicked with CDP mouse events after a separate hit test.
    The layout moved between the two, so the click missed and later steps
    failed. The check now hit-tests and clicks in one page task.
- Screenshots that are not review subjects (round 1):
  - `phone-switch-waiting.png`: the waiting state at phone width.
  - `desktop-switch-applied-after-job.png`: after the local job ended, Inkling is
    in effect, with no reload.
  - `desktop-restored-in-one-action.png`: Restore brings Gemma back and records
    it as its own switch.
  - `desktop-new-download-listed.png`: a newly downloaded model appears in the
    list.
- `document-readiness-final.json`: one read-only
  `GET /api/documents/23c8a260-f109-4585-883d-8b64b9937a0b/readiness?revision=5a481277-a8eb-43eb-b35d-f11bd9b2e508`
  at 13:19 EST (18:19:40Z). It reports ready, 3 of 3 required screens servable.
  The content hash of each screen in the response matches the file in the
  package folder (`shasum -a 256`), and that folder has no uncommitted change.

## Live state (criterion 9)

- `live-services-before-browser-check.txt`: listener PIDs and start times of LM
  Studio, the dashboard, the Nexus API, TheCortex and Praxis, taken in round 1
  before the browser check.
- `criterion-9-live-readback.txt`: the round-1 read-back (10:59 EST).
- `criterion-9-final-readback.txt`, made by `criterion-9-readback.sh`: the
  read-only read-back at the end of the task, 14:51:38 EST. Apart from its clock
  times it is line for line the same as the 13:00 and 14:39 read-backs before
  it.
  - The live `local_default` alias is still Gemma 4 31B QAT
    (`google/gemma-4-31b-qat`); the alias row was last updated 2026-06-03.
  - The live database has no `local_model_switches` table and no
    `local_model_selection` setting, since the change has not landed.
  - LM Studio's listing: no chat model is loaded. Only the embedding model is
    loaded.
  - The PIDs for LM Studio, the dashboard, the Nexus API and Praxis are the same
    as before. TheCortex has a new PID (8089, started 11:50:22 EST).
  - LM Studio logged four loads today: 04:48, 05:08, 05:27 and 10:25 EST. Each
    matches a Praxis autoload line, logged when a local call found no model
    loaded.
    - The first three fall inside the 22:00-06:00 ET local-lane window.
    - The 10:25 load is outside it. The read-back's LocalLane line names its
      grant: TheCortex's Graphiti ingestion, under Robert's standing grant with
      on-demand reload (2026-11-07).
- `criterion-9-attribution.txt`, made by `criterion-9-attribution.sh`: who
  restarted TheCortex and who unloaded Gemma.
  - At 16:46:29Z Robert asked his live Praxis chat session whether TheCortex's
    daytime graph ingestion should be stopped. At 16:49:17Z he said "stop it".
  - That session sent SIGTERM to TheCortex at 16:49:36Z. The supervisor's
    heartbeat restart then SIGKILLed and respawned TheCortex at 16:50:22Z.
  - At 16:51:58Z the same session ran `lms ps` and
    `lms unload google/gemma-4-31b-qat`. LM Studio logged the matching lms-cli
    clients at 11:51:58 and 11:51:59 EST.
  - Bridge tokens are redacted, and the agent's replies are quoted only up to
    their first findings heading.

This task loaded no model, unloaded none, called no local chat model and
restarted no service. Its only contact with LM Studio was seven listing requests
(`GET /api/v1/models`), and a listing loads nothing:
- 07:54 and 08:26 EST, to read the real listing's shape before writing the fake;
- one in each read-back, at 11:00, 12:46, 13:00, 14:39 and 14:51 EST.

In every test run the guards refused LM Studio's port, 1234: the network guard
and the LM Studio guard in the Praxis and TheNexus runs, the live-port guard as
well in round 4, and TheCortex's offline guards with every service URL on port
1. The 87 guard logs in the scratch folder, scanned before it was deleted, show
no request to port 1234 (`guards/guard-logs-scan.txt`).

## Failures that are not this task's

- Dashboard `daily-journal-tabs.test.ts:6` fails with ENOENT. It reads
  `../../nexus-shared/src/notes.ts`, the sibling repo that sits beside the main
  checkout but not beside a worktree.
- Dashboard `routing-economics.test.mjs:16` fails on a cost figure ($1.820 shown
  where it expects $2.525). This one and the ENOENT failure above also fail on
  baseline `bd02642` (`dashboard-baseline-failing-tests.txt`).
- Dashboard `document-review.test.mjs:181` failed once in the full run. It waits
  a fixed real-time interval for a delivery poll and timed out under load. It
  passed in the earlier full run and passes alone.
- Praxis `voice_prose_deadline.test.ts:29` failed once in round 1. It checks the
  HTTP close 20 ms after a rejection. It passes alone and in the final related
  run (`praxis-related-tests.txt`, 40 files, 527/527).
- Praxis `tts_provider.test.ts` "local deadline covers both waiting for headers
  and stalled response bodies" failed once in the full run, under load, and
  passes alone (35/35).
- TheNexus `studio-route.test.js` has an enrich test that fails whenever a
  GOOGLE_API_KEY is present, on baseline `bd02642` too. See
  `nexus-studio-route-dummy-key-this-branch.txt`,
  `nexus-studio-route-dummy-key-baseline.txt` and the guard logs
  `nexus-net-guard-studio-*.txt`, where YouTube requests were refused. The final
  runs are keyless.
- On the merged trees, two Praxis tests that read git cannot pass in a plain
  directory (`code_freshness_recovery`, `webhook_routes_inventory`; see the
  merged section).
- The 46 failures of the full Praxis run that fail the same way on plain main
  `4d076f91` (above). Each suite below, with the first error it shows. The
  copies have no `.git` and sit in a scratch folder with no sibling `TheNexus`,
  and the guards withhold the CLIs, hosts and ports some of these tests expect;
  whatever the cause, each fails identically on unchanged main.

| Suite | Failures | First error shown |
| --- | --- | --- |
| `agent_tool_results_whole` | 1 | `(Claude Code returned empty output)` where a completed result is expected |
| `alert_investigation` (with its `alert-investigation-audit-cases.ts`) | 3 | `inconclusive` where `reported` is expected; `undefined == true` |
| `checkpoint_end_to_end` | 1 | temp log dir must be removed after the run |
| `cli_seat_agy_startup` | 1 | temp log dir must be removed after the run |
| `cli_seat_unlimited` | 2 | `null !== 'reviewed'` |
| `code_freshness_recovery` | 1 | not a git repository |
| `consultation_memory` | 1 | Cannot find module `../../TheNexus/db/member-memory.js` |
| `dashboard_record_header` | 3 | Maximum call stack size exceeded in `src/telemetry/step-redaction.ts` |
| `email_intake_council` | 1 | `[redacted]` where a run id is expected |
| `email_intake_runtime` | 1 | `[redacted]` where a run id is expected |
| `evidence_bundle` | 1 | `[redacted]` where a run id is expected |
| `executor_discovery` | 1 | `[]` where `['process 101']` is expected |
| `followup_evidence` | 1 | the catalog check is falsy |
| `followup_evidence_review` | 1 | a finding kept for focused investigation |
| `long_task_executors` | 5 | empty output where `work completed` is expected |
| `mail_network` | 1 | the live-port guard refused `imap.gmail.com` |
| `member_conversation_eval` | 1 | a child `node` command failed |
| `member_profile_pilot` | 1 | Cannot find module |
| `model_inputs_whole` | 3 | assertions on whole sessions and few-shot blocks (main fixed these at 14:31, `289f675c`) |
| `quota_yellow_alert` | 4 | `undefined` where `acknowledged`, `claude-code` or `unknown` is expected |
| `report_intake_questions` | 1 | a child run's output does not match |
| `report_intake_slot_failure` | 1 | a child run's output does not match |
| `research_web_retrieval` | 1 | `[]` where `['mixed...']` is expected (the guard refused `mixed.test`) |
| `stakeholder-living-report` | 1 | Cannot find module |
| `tool_schema_honesty` | 2 | undeclared tool argument `search_conversations` |
| `upgrade_preflight` | 1 | HEAD must be recorded as the rollback target |
| `vault_source_delivery` | 2 | `'full' !== 'focused'` |
| `verification_protocol` | 1 | a record differs from the expected one |
| `webhook_callback_route` | 1 | `git show 1cac649:src/webhook...` failed |
| `webhook_routes_inventory` | 1 | not a git repository |

## Round-1 records kept

- `praxis-related-tests-earlier-run.txt`: 35 files, 470/470 at 09:18.
- `praxis-voice-deadline-rerun.txt`: `voice_prose_deadline.test.ts` alone, 5/5.
- `nexus-net-guard-studio-first-dummy-key-run.txt`.
- The two failed browser runs and the non-subject screenshots listed above.

## Scans

`final-scans.sh` writes `encoding-and-dash-scans.txt` and
`praxis-encoding-scan.txt`. At the end of the task:
- UTF-8 (fatal decoder, BOM, U+FFFD): no problems in 221 TheNexus files (229
  changed or added against `bd02642`, 8 PNGs skipped), 12 TheCortex files and 17
  Praxis files. Praxis's own `npm run check:encoding` passes on the same 17.
- Em dashes in added lines: 0 in Praxis, 0 in TheCortex, 0 in the TheNexus code,
  docs and scripts this task wrote. The verbatim outputs in this folder carry
  the products' own log wording.
- The dashboard has no change since `e1bfcc97`.
- The registered package: the three PNGs hash to the registered values, the
  folder has no uncommitted change, and it holds the three PNGs and
  `local-model-control.design.json`.
