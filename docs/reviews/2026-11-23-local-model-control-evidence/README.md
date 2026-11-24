# Evidence: local model chosen under Model Control (task fa032fc0, 2026-11-24)

The review package in `../2026-11-23-local-model-control/` holds only the three
review screenshots. Everything else that backs the task is here. Test and log
outputs are copied verbatim, so they can contain the products' own wording
(including dashes in their log messages).

## Real-browser check (isolated stack)

- `local-model-browser-check.mjs`: the check. One process owns the whole stack: a
  fake LM Studio, saved load profiles in a temporary LMSTUDIO_HOME, a Praxis
  stand-in with Praxis's switch rule, a throwaway Nexus API on an empty temporary
  database, `next dev`, and headless Chrome. It never touches the live board,
  nexus.db, LM Studio or Praxis. Run it with
  `node docs/reviews/2026-11-23-local-model-control-evidence/local-model-browser-check.mjs`.
- `api-network-guard.mjs`: preloaded into the throwaway API. It refuses and logs
  every connection that would leave the machine or reach a live local port (1234,
  3000, 3777, 4000, 4199, 8100, 54322).
- `browser-check-output.txt`: the final run. 61 CHECK_OK, 0 CHECK_FAIL, exit 0.
- `report.json`: from that run.
  - Every request the fake LM Studio received: 17, all `GET /api/v1/models`.
  - The stand-in's log, showing no apply until the job ended.
  - Every guard refusal: 2 read-only Cypher POSTs to Cortex from the existing
    knowledge-activity widget (`server/services/topic-access.js:23`).
  - The ports of every browser response: only the stack's own.
  - Page exceptions: none.
  - The API's `[LocalModel]` log lines.
- `browser-check-run1-failed.txt` and `browser-check-run2-failed.txt`: earlier runs
  of the same check, kept for the record.
  - Run 1 (11 failures) expected LM Studio's names where the panel shows the
    registry names ending in " (local)". The check was corrected to the
    documented names. Run 1's screenshot also showed the tall alias card
    stretching the Global Local Only box, which led to the layout fix in
    `dashboard/src/app/model-control/page.tsx`.
  - Run 2 (22 failures) clicked with CDP mouse events after a separate hit test.
    The layout moved between the two, so the click missed and later steps
    failed. The check now hit-tests and clicks in one page task.
- Screenshots that are not review subjects:
  - `phone-switch-waiting.png`: the waiting state at phone width.
  - `desktop-switch-applied-after-job.png`: after the local job ended, Inkling is
    in effect, with no reload.
  - `desktop-restored-in-one-action.png`: Restore brings Gemma back and records
    it as its own switch.
  - `desktop-new-download-listed.png`: a newly downloaded model appears in the
    list.

## Tests

All were run with the guards described in each file's command line:
- the network guard;
- the LM Studio guard on ports 1234 and 1;
- a refusing fake `lms`;
- for TheCortex, every service URL pointed at port 1 and pytest's
  `offline_network_guard`.

| File | What ran | Result |
| --- | --- | --- |
| `nexus-local-model-selection-tests.txt` | TheNexus `server/__tests__/local-model-selection.test.js` | 14/14 |
| `nexus-related-server-tests.txt` | 23 TheNexus server suites around model control, Studio and astro, final tree, keyless | 265/265 |
| `nexus-studio-route-dummy-key-this-branch.txt`, `nexus-studio-route-dummy-key-baseline.txt` | `studio-route.test.js` with a dummy GOOGLE_API_KEY, this branch and baseline `bd02642` | the same 1 failure on both (pre-existing, key-dependent) |
| `nexus-net-guard-studio-*.txt` | what the guard refused in those runs | YouTube search requests refused, nothing left the machine |
| `dashboard-local-model-tests.txt` | `local-model-chooser`, `chat-model-control`, `fast-refresh-boundaries` | 23/23 |
| `dashboard-full-suite.txt` | dashboard `npm test`, final tree | 1460/1463 (see below) |
| `dashboard-document-review-rerun.txt` | `document-review.test.mjs` alone | 21/21 |
| `dashboard-baseline-failing-tests.txt` | the two pre-existing failures on baseline `bd02642` | both fail there too |
| `praxis-local-model-selection-tests.txt` | Praxis `tests/local_model_selection.test.ts` | 16/16 |
| `praxis-related-tests.txt` | 35 Praxis test files around the local lane, final tree | 469/470 (see below) |
| `praxis-related-tests-earlier-run.txt` | the same 35 files at 09:18, same providers/manager code | 470/470 |
| `praxis-voice-deadline-rerun.txt` | `tests/voice_prose_deadline.test.ts` alone | 5/5 |
| `praxis-fake-lms-calls.txt`, `praxis-lmstudio-guard.txt` | what the fakes refused in the final Praxis run | 1 `lms ls --json` refused; 1 POST to port 1 from `member_profile_updates` (pre-existing test behaviour) |
| `praxis-encoding-scan.txt` | `npm run check:encoding` over the 16 Praxis files changed | passed |
| `cortex-offline-tests.txt` | 11 TheCortex test files, final tree | 289 passed |
| `cortex-local-model-tests.txt` | `tests/test_local_model_setting.py` verbose | 19 passed |
| `cortex-mutation-a.txt`, `cortex-mutation-b.txt` | two deliberate breakages in a scratch copy of TheCortex, not the worktree | each fails its test, as it should |

Failures that are not this task's:

- Dashboard `daily-journal-tabs.test.ts:6` fails with ENOENT. It reads
  `../../nexus-shared/src/notes.ts`, the sibling repo that sits beside the main
  checkout but not beside a worktree. `routing-economics.test.mjs:16` fails on a
  cost figure ($1.820 shown where it expects $2.525). Both also fail on baseline
  `bd02642` (`dashboard-baseline-failing-tests.txt`).
- Dashboard `document-review.test.mjs:181` failed once in the full run. It waits
  a fixed real-time interval for a delivery poll and timed out under load. It
  passed in the earlier full run and passes alone.
- Praxis `voice_prose_deadline.test.ts:29` failed once in the final run. It
  checks the HTTP close 20 ms after a rejection. It passed in the earlier run of
  the same code and passes alone.

## Live state (criterion 9)

- `live-services-before-browser-check.txt`: listener PIDs and start times of LM
  Studio, the dashboard, the Nexus API, TheCortex and Praxis, taken before the
  browser check.
- `criterion-9-live-readback.txt`: the read-only read-back at the end.
  - The live `local_default` alias is still Gemma 4 31B QAT
    (`google/gemma-4-31b-qat`); the alias row was last updated 2026-06-03.
  - LM Studio's own listing.
  - The same PIDs and start times as before.
  - Why Gemma 4 31B QAT shows loaded: the live Praxis reloaded the model already
    in effect at 10:25 ET for TheCortex's Graphiti ingestion, under Robert's
    on-demand grant of 2026-11-07. This is the same cycle LM Studio logged at
    04:48, 05:08 and 05:27 today. Nothing from this task reached LM Studio.
