# Evidence: local model chosen under Model Control (task fa032fc0, 2026-11-24)

The review package in `../2026-11-23-local-model-control/` holds only the three
review screenshots (registered revision `5a481277`). Everything else that backs
the task is here. Test and log outputs are copied verbatim, so they can contain
the products' own wording (including dashes in their log messages).

Three repositories changed, each on its own task branch:

| Repository | Baseline | Branch head | Main at the merged check |
| --- | --- | --- | --- |
| TheNexus | `bd02642` | `7f915704`, plus the commit that adds this update | `3189bb99` |
| Praxis | `1fcf4b59` | `6f9fb79b` | `24c1abaa` |
| TheCortex | `5fdb76a` | `0909b22` | `3617672` |

## Final results on the branch heads

Every run used guards, kept in `guards/`:
- `net-guard.mjs` refuses anything leaving the machine and every live local port
  (1234, 3000, 3777, 4000, 4199, 8100, 54322).
- `lmstudio-guard.mjs` refuses fetches to LM Studio (port 1234) and to the dead
  test port 1.
- `fake-lms` is a refusing `lms`, passed as `PRAXIS_LMS_BIN`.
- `cortex-tests.sh` runs TheCortex's pytest with every service URL on port 1 and
  `-p offline_network_guard`; TheCortex's conftest installs `cortex_test_guard`
  as well.

The guards log to the scratch folder named in each script, since deleted.

| File | What ran | Result |
| --- | --- | --- |
| `nexus-local-model-selection-tests.txt` | TheNexus `server/__tests__/local-model-selection.test.js` | 17/17 |
| `nexus-related-server-tests.txt` | 23 TheNexus server suites around model control, model rows, Studio, astro and the auth mounts, keyless | 268/268 |
| `dashboard-tsc.txt` | `npx tsc --noEmit` in `dashboard/` | exit 0 |
| `dashboard-local-model-tests.txt` | `local-model-chooser`, `chat-model-control`, `fast-refresh-boundaries` | 23/23 |
| `dashboard-full-suite.txt` | dashboard `npm test` | 1460/1463 (see the failures below) |
| `dashboard-document-review-rerun.txt` | `document-review.test.mjs` alone | 21/21 |
| `dashboard-baseline-failing-tests.txt` | the two pre-existing failures on baseline `bd02642` | both fail there too |
| `praxis-local-model-selection-tests.txt` | Praxis `tests/local_model_selection.test.ts` and `tests/local_model_primary.test.ts` | 33/33 |
| `praxis-related-tests.txt` | 40 Praxis test files around the local lane, the LLM manager, autoload, the local worker, the ops routes and the route inventory | 519/519 |
| `praxis-tsc.txt` | `npx tsc --noEmit` in Praxis | exit 0 |
| `praxis-lmstudio-guard.txt`, `praxis-fake-lms-calls.txt` | what the guards refused in the 40-file run | 1 POST to port 1 from `member_profile_updates.test.ts` (its own dead URL, pre-existing); 1 `lms ls --json` refused by the fake; the network guard refused nothing |
| `praxis-encoding-scan.txt` | `npm run check:encoding` over the 16 Praxis files changed | passed, 16 text files |
| `cortex-offline-tests.txt` | 11 TheCortex test files (listed in `merged-main/merged-main-check.sh`) | 292 passed |
| `cortex-local-model-tests.txt` | TheCortex `tests/test_local_model_setting.py`, verbose | 22 passed |
| `encoding-and-dash-scans.txt`, made by `final-scans.sh` | UTF-8 scans of every file changed in each repository, and em dashes in added lines | no problems in 116 TheNexus, 12 TheCortex and 16 Praxis files (PNGs skipped); 0 em dashes in lines this task wrote (the verbatim outputs carry the products' own) |

The dashboard has not changed since the round-1 evidence commit `e1bfcc97`, so
the dashboard runs above still describe the final tree. In
`praxis-related-tests.txt` at lines 3084 and 3177, Praxis's own test bootstrap
refuses a live `GET :8100/api/status` from the identity loader; nothing reached
TheCortex.

## Merged with current main (`merged-main/`)

Each repository's branch diff against its baseline was applied to `git archive
main` in a scratch directory outside every repository, with the same guards. No
worktree, branch or clone was made. The scripts are `merged-main-check.sh` and
`nexus-seed-fix-check.sh`, with their outputs beside them.

- TheNexus:
  - First run: 269/270 (`nexus-server-tests-first-run.txt`). The failing test,
    "with no model in effect a choice is answered as waiting until Praxis applies
    it, and choosing makes no models row; the switch does", asserts at line 416
    that no models row names Inkling 2 Mini. Main's seed, from the readiness task
    `9227d9b6`, adds that row, so the test's starting condition was false.
  - Fix, commit `7f915704`: the test uses a model that no seed lists
    (`acme/reasoner-12b`) and keeps every assertion. The test after it now also
    checks that a new row takes a free id (`local-gemma-4-31b-2`) when
    `local-gemma-4-31b` names another model.
  - After the fix: 17/17 on the branch and 270/270 merged
    (`nexus-server-tests.txt`). Mutations H2, V and W fail as they should (see
    below).
- Dashboard: `tsc` exit 0 (`dashboard-tsc.txt`); 23/23
  (`dashboard-local-model-tests.txt`).
- Praxis:
  - `tsc` exit 0 (`praxis-tsc.txt`).
  - 38 of the 40 test files exist on main. Main deleted
    `trading_reflection_local_model` and `trading_reflections` in `f8e444a2`.
  - Result 507/509 (`praxis-related-tests.txt`). The two failures read git
    (`git rev-parse HEAD`, `git show 1cac649:src/webhook.ts`), and the merged
    tree is a plain directory.
  - On plain main archived the same way they fail the same way: 48/50, with 8
    "not a git repository" lines (`praxis-git-reading-tests-plain-main.txt`). On
    the branch checkout they pass, 50/50
    (`praxis-git-reading-tests-branch.txt`).
  - The route inventory test also passes on the merged tree, 4/4
    (`praxis-route-inventory.txt`). It ran with a read-only git shim
    (`praxis-git-shim.sh`) that forwards only `git show 1cac649:src/webhook.ts`;
    its log shows that one command forwarded and nothing refused.
  - The freshness test was not shimmed. It runs many git commands against its
    own repository state, so pointing it at another repository would make its
    result meaningless.
- TheCortex: 292 passed (`cortex-offline-tests.txt`).

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
| TheNexus H | choosing makes or reactivates the models row (round-1 behaviour) | 2 |
| TheNexus H2 | H again, on the test after the seed fix | 2 |
| TheNexus I | the alias editor's old `local_default` guard | 1 |
| TheNexus V | a new row takes the derived id even when another row has it | 1 |
| TheNexus W | the new row drops LM Studio's reasoning flag | 1 |
| TheCortex A | `_generate_response` (`memory/client.py:181-185`) awaits between taking the model and sending it | 1 |
| TheCortex B | that per-call override is removed | 1 |
| TheCortex C | `local_model.py:109` `if _last_answer:` becomes `if False and _last_answer:`, so the last model Nexus named is not kept | 4 |
| TheCortex D | `memory/client.py:113` builds the client from `graphiti_local_model()`, a Nexus read, instead of the static fallback | 1 |

Scripts: `praxis-mutations-ef.sh`, `praxis-mutation-g.sh`,
`praxis-mutations-jt.sh` (J to T and G2), `praxis-mutations-u.sh` (U and L2),
`nexus-mutations-hi.sh` and `../merged-main/nexus-seed-fix-check.sh` (H2, V, W).
The four TheCortex edits are described in the table, each a single replacement
asserted to match exactly once.

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
  rerun on the final tree `7f915704`, in a scratch copy.
  - 61 CHECK_OK, 0 CHECK_FAIL, exit 0.
  - The fake LM Studio received 17 requests, all `GET /api/v1/models`.
  - The guard refused 2 read-only Cypher POSTs to :8100 from the existing
    knowledge-activity widget (`server/services/topic-access.js:23`).
  - There were no page exceptions.
  - The API logged two switches, each with "nothing was loaded".
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

## Live state (criterion 9)

- `live-services-before-browser-check.txt`: listener PIDs and start times of LM
  Studio, the dashboard, the Nexus API, TheCortex and Praxis, taken in round 1
  before the browser check.
- `criterion-9-live-readback.txt`: the round-1 read-back (10:59 EST).
- `criterion-9-final-readback.txt`, made by `criterion-9-readback.sh`: the
  read-only read-back at the end of the task.
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
restarted no service. Its only contact with LM Studio was five listing requests
(`GET /api/v1/models`), and a listing loads nothing:
- 07:54 and 08:26 EST, to read the real listing's shape before writing the fake;
- one in each read-back, at 11:00, 12:46 and 13:00 EST.

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
  HTTP close 20 ms after a rejection. It passes alone and in the final 40-file
  run.
- TheNexus `studio-route.test.js` has an enrich test that fails whenever a
  GOOGLE_API_KEY is present, on baseline `bd02642` too. See
  `nexus-studio-route-dummy-key-this-branch.txt`,
  `nexus-studio-route-dummy-key-baseline.txt` and the guard logs
  `nexus-net-guard-studio-*.txt`, where YouTube requests were refused. The final
  runs are keyless.
- On the merged tree, two Praxis tests that read git cannot pass in a plain
  directory (see the merged section above).

## Round-1 records kept

- `praxis-related-tests-earlier-run.txt`: 35 files, 470/470 at 09:18.
- `praxis-voice-deadline-rerun.txt`: `voice_prose_deadline.test.ts` alone, 5/5.
- `nexus-net-guard-studio-first-dummy-key-run.txt`.
- The two failed browser runs and the non-subject screenshots listed above.
