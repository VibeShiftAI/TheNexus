# Attribution source markers: criteria 1 to 4 scored, with a baseline diff

Follow-up task 056f9213 (QA improvement for task 50e55c47, "Audit attribution
surfaces so token estimates are always visibly labelled as estimates"). The
adversarial critic objected that the QA pass (a) never proved criterion 4
("npm test stays green") against a baseline and (b) never scored criteria 1 to 3
by number. This folder answers both objections with commands run on 2026-11-17.

Parent task commits: `bc94b986`, `37f30117`, `25f939be`, `58ffc186`.

## Files in this folder

- `server-jest-baseline-vs-post.json`: full server jest counts, failing suites
  and failing test names at the baseline, after the parent task, at current
  `main` and in this worktree. Failure messages are left out on purpose: the
  pre-existing `openrouter-free-lane` failure prints part of a real API key
  from the environment.
- `dashboard-test-baseline-vs-post.json`: full dashboard `npm test` counts and
  failing test names at the baseline and after the parent task.
- `mutate.mjs`: the mutation harness used for criterion 3 (copy it outside the
  repo and run `node mutate.mjs <worktree> <out.json>`).
- `mutations-before.json`, `mutations-after.json`: its results at current
  `main` (`ec37922a`) with the attribution test as it was, and with the two
  assertions this task added.

## Which baseline

The critic named `02356ec1` as the baseline. That object is not in this
repository (`git cat-file -t 02356ec1` prints `fatal: Not a valid object name
02356ec1`); it was a dispatch-time snapshot that was never kept. The baseline
used here is `f19199e4`, the parent commit of the first task commit
(`git log -1 --format='%h %p' bc94b986` prints `bc94b986 f19199e4`). The
post-change revision is `58ffc186`, the last task commit. Each was checked out
as a detached worktree under `/tmp`, sharing the same `node_modules`, so the
only thing that differs between the two runs is the task's diff.

## Criterion 4: "npm test stays green"

Read as "the task adds no failing test" (the full suites were already red at
the baseline, so "green" in the literal sense was never available to the task).

Server, `npx jest --json`, each revision run twice with identical results:

| revision | failed suites | failed tests | total tests |
|---|---|---|---|
| baseline `f19199e4` | 7 of 145 | 42 | 1809 |
| post-change `58ffc186` | 7 of 146 | 42 | 1825 |

The failing suite set is identical (client-access, local-operator-flows,
openrouter-free-lane, praxis-stream, studio-route, task-canonical-deltas,
work-admission-operator-answers), and so is the set of 42 failing test names:
set difference in both directions is empty. The extra suite and the 16 extra
tests after the change are the new `attribution-source-markers.test.js`, which
passes. `local-operator-flows` fails at the baseline with
`Cannot find module '../routes/mail-draft-review'`, a file not yet committed at
`f19199e4`; this is probably why the parent run, made against a working tree,
reported 6 failing suites rather than 7.

Dashboard, `cd dashboard && npm test`:

| revision | tests | pass | fail |
|---|---|---|---|
| baseline `f19199e4` | 1097 | 1086 | 11 |
| post-change `58ffc186` | 1110 | 1099 | 11 |

The 11 failing test names are identical (`diff` of the sorted lists prints
nothing): 9 in `src/lib/__tests__/voice-command-bar.test.ts` (lines 507, 704,
802, 853 and five cases at 741), the `ai-terminal.tsx` line budget
(`ai-terminal-shape.test.ts:19`) and the Praxis journal tabs test
(`daily-journal-tabs.test.ts:6`). None touches an attribution surface. The 13 extra passing tests are the parent task's new
`attribution-source-labels.test.mjs` cases. The parent run reported 5 dashboard
failures on 2026-10-25; today both revisions show the same 11 under the current
shared `node_modules`, so the extra 6 come from the environment, not the task.

**Verdict: met.** The parent task introduced no new server or dashboard failure.

Current `main` and this worktree: server jest at `ec37922a` fails 3 of 173
suites (openrouter-free-lane, praxis-stream, studio-route; 2313 of 2317 tests
pass), and this worktree, with the strengthened test, fails the same 3 suites
and the same 3 tests.

## Criterion 1: every server attribution figure carries a source marker

Markers come from `server/services/usage-source.js` (`tokenSource`,
`aggregateTokenSource`, `costSource`; values measured, estimated, unavailable,
unknown). Emission sites at `ec37922a`:

- Now strip `/api/dispatches/active`: `server/routes/dispatches.js:308`
  `tokensSource: aggregateTokenSource({`.
- Task dispatch rows `/api/dispatches?task_id=`: `server/routes/dispatches.js:349`
  `row.tokens_source = tokenSource(row.tokens, row.tokens_estimated)`.
- Activity feed `/api/activity`: `server/routes/projects.js:150` (no match,
  `tokensSource: 'unavailable'`), `:196` (dispatch match), `:1024` and `:1036`
  (pushed with each commit).
- Dispatch insight `/api/dispatch-insight/task/:id`:
  `server/routes/dispatch-insight.js:1285` (cost object `source`), `:1289`
  (`costSource`), `:1295` (`tokensSource`).
- Run trace: `server/services/run-trace.js:281` `tokensTotalSource`.
- Run cost roll-up: `server/services/run-cost.js:116` `source: costSource(...)`.
- Routing economics: `server/services/routing-economics.js:71` (tokens) and
  `:78` (cost).
- Project pulse: `server/routes/project-pulse.js:182`, `:239`, `:240` (7d and
  24h sums), `:214` and `:334` (ops log dispatch rows).

`server/__tests__/attribution-source-markers.test.js:253` boots all seven
routes listed at `:242` against one seeded board and walks every response; it
passes 16 of 16, and `:262` proves the seeded runs reach all four marker values.

**Verdict: met.**

## Criterion 2: every dashboard surface renders estimates as estimates and missing as "unavailable"

The visible estimate marker is the tag "est" (with a `~` prefix and an
"ESTIMATED ..." tooltip), from `USAGE_SOURCE_TAG` in
`dashboard/src/lib/usage-source.ts`. Render sites at `ec37922a`:

- Recent Activity: `dashboard/src/components/activity-feed.tsx:286` tag,
  `:294` "unavailable".
- Now strip: `dashboard/src/components/bridge/now-strip.tsx:126` tag, `:150`
  "unavailable".
- Ops log: `dashboard/src/components/project-brief/activity-report.tsx:55` tag,
  `:50` "tok unavailable".
- Mission brief: `dashboard/src/components/project-brief/mission-brief.tsx:42`
  tag, `:218` "unavailable".
- Routing economics: `dashboard/src/components/routing-economics-panel.tsx:50`
  tag, `:48` "Unavailable".
- Task detail: `dashboard/src/components/task-view/dispatch-console.tsx:994`
  tag, `:1003` "tokens unavailable", `:1019` "cost unavailable".

Each surface is rendered in jsdom by
`dashboard/src/components/__tests__/attribution-source-labels.test.mjs`
(activity feed `:58`, Now strip `:78` and `:91`, mission brief `:113` and
`:136`, ops log `:146`, routing economics `:170`) and
`usage-missing-attribution.test.mjs` (task detail `:87`, `:103`, `:181`,
`:205`). Both files pass 30 of 30 at `ec37922a`. The mutation run below
has 12 dashboard mutants (6 remove an "est" tag, 6 turn an "unavailable"
into `0`, one of each on the six surfaces above); all 12 fail these tests.

**Verdict: met.** (Caveat: the marker reads "est", not the full word
"estimate", on compact chips; the tooltip says "ESTIMATED".)

## Criterion 3: a test fails if any figure is returned without a marker

`mutate.mjs` makes one change at a time to current `main`, runs the attribution
tests and restores the file byte for byte. A mutant that only fails because a
test file no longer loads is reported as `LOAD`, and a test run whose child
process fails to spawn or exceeds Node's default `spawnSync` output limit is
reported as `ERR`; neither counts as killed (none occurred in the final runs).
The 29 mutants are 17 server (12 drop a marker, 4 show a missing figure as
`0`, 1 counts unknown-source usage as measured) and 12 dashboard (above);
counts are taken from the `side` field of the JSON files.

- **Before this task** (`mutations-before.json`): 27 of 29 mutants killed. All
  12 server "drop a marker" mutants (seven routes, run-trace and run-cost),
  the unknown-as-measured mutant and all 12 dashboard mutants were killed.
  Two of the 4 "missing figure shown as 0" mutants survived:
  - `activity feed: unavailable dressed as 0` (`projects.js:150`, the
    no-dispatch fallback): no seeded project had commits without a dispatch,
    so this branch never ran.
  - `dispatch-insight run-trace input: missing tokens dressed as 0`
    (`dispatch-insight.js:1235`): a run with no usage record got a run-trace
    total of 0 marked measured, which is self-consistent, so the walker could
    not see it.
- **Fix in this task**: two assertions added to
  `server/__tests__/attribution-source-markers.test.js`: a second repo with no
  dispatch rows whose commit must return `tokens: null`, source unavailable
  (`:288`), and `d-missing` must carry no run-trace token evidence (`:279`).
- **After** (`mutations-after.json`): 29 of 29 killed, with both controls
  passing (server 16 of 16, dashboard 30 of 30).

**Verdict: met** with the strengthened test. The walker recognises the figure
keys listed in `FIGURE_KEYS`; a future surface that adds a figure under a new
key name has to add the key there to be covered.

## Disposition of the critic's objections

1. Criterion 4 unproven without a baseline: **implemented**. Baseline and
   post-change full suites above, with identical failure sets.
2. Criteria 1 to 3 not scored by number, and no proof the test fails on a
   missing marker: **implemented**. Scored above with file:line evidence; the
   mutation run found two real gaps in criterion 3 coverage, which this task
   closes.
