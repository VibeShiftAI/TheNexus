# Today's Schedule shows chat-dispatched work and its queue (2026-10-04)

Task: "Show chat-dispatched work and its queue in Today's Schedule" (TheNexus).
Robert, 2026-10-04: "when you add tasks like this, they should appear in
'today's schedule' so I know they are in the queue".

## Symptom

Today's Schedule (home panel `ScheduleTimeline` and the `/calendar` page) read
only `calendar_events`. Chat-dispatched (ad hoc) work has no day-plan slot, and
its `[Ad-hoc] <name>` event is written by Praxis's completion reconciler only
AFTER the task finishes. While a task was queued behind the CLI slot or running,
neither surface showed it at all.

Reproduced from live data at 21:33 on 2026-10-04 (read-only):

- Praxis `GET /api/dispatch/state`: one active implementation run
  (`dade9c64`, phase testing) and `cliQueue` with two entries
  (`a2553798` #1, `9021f20d` #2).
- Nexus `GET /api/calendar?start=<today>&end=<tomorrow>`: only local LLM events
  and two `[Ad-hoc]` completed events (`a1cc8616`, `b07f64ad`). Nothing for the
  running or queued tasks.

## Cause

There was no read surface that joined runtime truth (runs, queue, reviewer
runs) with board links (`dependencies`, `successor_id`) for the schedule, and
both schedule surfaces fetched the calendar once (the calendar page only on
mount) with no refresh on dispatch changes.

## Change

Server (read projection, writes nothing):

- `server/routes/dispatch-insight.js`: `projectLiveWork(state, boardRows)`
  (pure, exported on the factory) and `GET /api/dispatch-insight/live-work`.
  Lanes: `running` (active kind=task run), `qa` (implementation finished and a
  `qa--<id>` reviewer run is active), `queued` (cliQueue in Praxis's order with
  position, length, enqueuedAt, `correction` for continuation/repair queues),
  `finished` (latest finished implementation run with board status and the
  board's own `status_message`), `waiting` (board tasks that are the
  `successor_id` of live work or list live work in `dependencies`, followed
  along the chain, with `autoStart` from `TASK_AUTO_START_STATUSES`; each
  waiting task names EVERY unfinished predecessor, resolved after membership
  closes so the list does not depend on board row order).
  Unlinked board ideas are never listed. A failed Praxis read answers
  `{ praxis: { reachable: false, error }, items: [] }` so the client can say
  the queue is unavailable instead of "nothing queued". `Cache-Control:
  no-store`. Tolerates a board without `successor_id` (fixtures, old copies).

Dashboard:

- `dashboard/src/lib/nexus/dispatch-insight.ts`: `getLiveWork()` and the
  `LiveWork*` types. (The `lib/nexus` barrel is unchanged; its exact-surface
  test guards it.)
- `dashboard/src/lib/schedule-live-work.ts` (new, pure): `mergeLiveWork`
  dedupes by `task_id` (a task on the calendar AND live gets a badge on its
  event, never a second row), places only real clocks (running at startedAt,
  qa/finished at the implementation's finish), keeps queued and waiting rows
  timeless (they carry across midnight; no invented start), keeps a review
  still running whatever day its implementation finished, drops finished
  rows outside the schedule window, reports the whole queue (`queue`,
  badged entries included) and `workCount` (rows + badged tasks) so "up
  next" and the empty state are decided from everything the runtime said; `liveItemLabel` never writes
  "implementation finished" as passed; `applyLiveWorkRead` /
  `liveWorkAvailability` fold reads into live, stale (last rows kept) or
  unavailable.
- `dashboard/src/components/schedule-timeline.tsx`: reads calendar and live
  work together (`Promise.allSettled`, one failing never blanks the other),
  `useLiveRefetch(["schedule", "dispatch", "board"], ...)` for refresh on
  task.started/completed, executor.progress, schedule.updated and task.updated
  with the 60s fallback poll and reconnect recovery; live rows on the rail
  (`data-live-row`, titles link via `taskHref`), the queue block right after
  NOW ("queue · N queued · M linked"), badges on calendar rows, header
  "N queued" chip, `data-live-availability` note, "up next" prefers the queue
  head ("starts when the slot frees"), running rows on the day track.
- `dashboard/src/app/calendar/page.tsx` + new
  `dashboard/src/components/schedule-live-work-strip.tsx`: the same merge
  renders a "Runtime work" strip above the grid, badges on grid blocks, the
  same refetch domains; day bounds are taken per read so the first refetch
  after local midnight shows the new day.

Nothing on either surface dispatches, re-orders, approves or touches gates:
the only requests are `GET /api/calendar` and
`GET /api/dispatch-insight/live-work`.

## Evidence

Tests (failing before the component change, passing after):

- `server/__tests__/dispatch-insight-live-work.test.js` (5): no plan + queue
  lanes/positions/correction/QA/waiting/autoStart and exclusions; transitions;
  Praxis unreachable; board without `successor_id`; read-only (board snapshot
  unchanged, fake Praxis saw only `GET /api/dispatch/state`).
  `npx jest server/__tests__/dispatch-insight` → 3 suites, 41 tests passed.
- `dashboard/src/lib/__tests__/schedule-live-work.test.ts` (8): no plan +
  queue, queue order from positions, mixed dedupe, finished ≠ passed,
  queued → running → QA → done transitions, local midnight window,
  unavailable/stale/live folding, malformed items ignored.
- `dashboard/src/components/__tests__/schedule-timeline-live-work.test.mjs`
  (5): before the component change 0/5 passed (4 assertion failures, 1
  cancelled); after, 5/5. Covers rows + links + order, dedupe (badge on the
  slot, `[Ad-hoc]` completion not doubled), unavailable with calendar intact,
  explicit empty state, fallback-poll transition then stale.
- `dashboard/src/components/__tests__/calendar-page-live-work.test.mjs` (4):
  the same contract on `/calendar`, plus the explicit "nothing running or
  queued" note on a live empty read.
- `cd dashboard && npm test` → 826 tests, 826 pass.
  `dashboard/node_modules/.bin/tsc --noEmit -p dashboard` → clean.

Browser (isolated stack, real Chrome, nothing live touched):
`dashboard/scripts/schedule-live-work-check-api.cjs` (temp SQLite seeded with
synthetic ids, the REAL `dispatch-insight` and `calendar` routes, a fake
Praxis with switchable scenarios) + a verify build
(`NEXT_DIST_DIR=.next-live-work-verify NEXT_PUBLIC_API_URL=http://127.0.0.1:4299`)
served by `next start -p 3299`, driven by
`dashboard/scripts/schedule-live-work-browser-check.mjs`. Result: ALL CHECKS
PASSED. Report: `docs/reviews/2026-10-04-schedule-live-work-browser-check.json`;
screenshots: `docs/reviews/2026-10-04-schedule-live-work-browser-check/`.

| step | what the browser showed |
| --- | --- |
| 01-home-queue | rows running / queued #1 / waiting, each title an `a[href="/task/<id>"]`; queue head "queued #1 of 2 · waiting since … · correction round", clock column "#1"; waiting row "waiting on “…” (queued #2) · starts automatically"; the day-plan slot for queued #2 carries the badge "queued #2 of 2" and is not a second row; the `[Ad-hoc]` completion is neither badged nor doubled; the board idea is absent; header "1/3 done" + "2 queued"; footer "up next: … queued #1, starts when the slot frees" |
| 02-calendar-queue | `/calendar` strip lists the identical rows; the slot block carries the badge |
| 03-slot-freed | after the fake Praxis moved the queue head into the slot the home panel followed WITHOUT a reload; the finished task reads "implementation finished · QA pending"; slot badge "queued #1 of 1"; waiting row "(queued #1)"; `/calendar` agrees |
| 04-qa | "implementation finished · QA running (Codex)", nothing says completed or passed |
| 05-unreachable | "Runtime queue stale · last read 06:13 PM · Praxis dispatch-state HTTP 503" with the last rows kept; after reload "Runtime queue unavailable · … · queued and running work cannot be shown", no rows, calendar rows intact, no queue count; `/calendar` never says "nothing queued" |
| 06-empty | no rows, badges or notes; "1/3 done"; `/calendar` says "Nothing running or queued in the runtime right now" |

Network: every API request the pages made was a GET (`GET /api/calendar`,
`GET /api/dispatch-insight/live-work`, plus other panels' reads); the
throwaway API and the fake Praxis received no write; the pages never talked to
Praxis directly. The home page's other panels also contacted
`http://localhost:4000` (the live Nexus socket/stream, read-only, as on every
isolated run). The red "Nexus unreachable" / 404 banners in the screenshots are
those other panels against the throwaway API, not part of this change.

Live, read-only: the new route over a `sqlite3 .backup` copy of `nexus.db`
against the real Praxis (throwaway express on :4301, exited after one read):

```
HTTP 200 at=2026-10-04T22:05:38.929Z praxis={"reachable":true,"error":null}
running  dade9c64 Show chat-dispatched work and its queue in Today’s Schedule | claude-code testing since 2026-10-04T21:32:34.763Z
queued   a2553798 Enable executor-recorded document approvals for Robert’s Approve with  | #1 of 2 correction
queued   9021f20d Honor Robert-originated task contract changes without repeat approval | #2 of 2 correction
finished …(7 completed runs of today, each with its board status)…
waiting  b7708e44 Carry Robert’s contract decisions through dispatch and clear obsolete  | waits on 9021f20d (queued #2) autoStart=true
```

## Activation

- `:3000` is `next dev` on the working tree, so the component changes are
  live on save. `:4000` is the Praxis-supervised Nexus API process and does
  not reload route modules: `curl -H "Authorization: Bearer local-dev-token"
  http://127.0.0.1:4000/api/dispatch-insight/live-work` → HTTP 404 at the time
  of this report. Until that process restarts, the live panel renders the
  explicit "Runtime queue unavailable · Live work unavailable (404) · queued
  and running work cannot be shown" state (by design: never "nothing queued").
- No Praxis restart was authorized for this task and none was performed.
  Activation = restart the Nexus API child (:4000); no Praxis change is needed.

## QA round 1 repair (2026-10-04, codex review)

Four findings, each reproduced with a failing test before the change:

| finding | reproduction (failing before) | fix |
| --- | --- | --- |
| 1. queue head and task links: a deduplicated calendar-backed queue head was skipped for "up next" (the next entry was announced) and calendar-backed rows had no task link | `schedule-timeline-live-work.test.mjs` "queue head on the calendar" (`[data-live-up-next]` null); `calendar-page-live-work.test.mjs` "queued work shown only as a badge" (no `a[href="/task/<id>"]` in the block) | `mergeLiveWork` returns `queue` (whole CLI queue in Praxis order); the home footer uses `live.queue[0]`; task-bound calendar rows render the title as a `Link` (`taskHref`) with the chevron as the expand control (events without a task keep the click-anywhere button); the `/calendar` grid block title is a `Link` that stops propagation so the rest of the block still opens the editor |
| 2. incomplete dependency names: for A queued, B deps [A], C deps [A, B], board order A/C/B omitted B from C's list; an authorized successor's blocked prerequisite was omitted | `dispatch-insight-live-work.test.js` "a chained dependency list is complete whatever order the board rows arrive in" and "an authorized successor names its blocked prerequisite" (both `Expected - 1 / Received + 0`) | `projectLiveWork` resolves waiting in two phases: membership closure first (loop until a pass adds nothing), then each waiting task names every unfinished `dependencies` entry (board not done, not archived) plus the live/waiting task naming it as `successor_id` |
| 3. active QA lost at midnight: a reviewer still running on an implementation that finished yesterday was dropped as history | `schedule-live-work.test.ts` midnight test now expects `["visibility", "late-qa"]` (was `["visibility"]`) | the `qa` lane is kept regardless of the window, like an active run |
| 4. false Calendar empty state: "Nothing running or queued" beside "0 running · 1 queued" when the only queued task was badged on a grid block | `calendar-page-live-work.test.mjs` "queued work shown only as a badge" (`Nothing running or queued` present) | the strip judges emptiness on `merged.workCount`; when rows are empty but work is badged it says so (`[data-live-badged-only]`) |

Improvement taken: `boardSaysDone` delegates to the contract's `isTaskDone`
(legacy spellings included) instead of a local status list.

Verification after the repair:

- `npx jest server/__tests__/dispatch-insight --runInBand` → 3 suites,
  43 tests passed (live-work suite 7).
- `cd dashboard && node --import ./test/register.mjs --test
  src/lib/__tests__/schedule-live-work.test.ts
  src/components/__tests__/schedule-timeline-live-work.test.mjs
  src/components/__tests__/calendar-page-live-work.test.mjs` → 20/20
  (16/20 before the fix: the four reproductions failed).
- `cd dashboard && npm test` → 832 tests, 832 pass.
  `dashboard/node_modules/.bin/tsc --noEmit -p .` → clean.
- Browser check rerun on a fresh verify build with three added assertions:
  the badged day-plan slot's title links to its task (home), the badged grid
  block's title links to its task (`/calendar`), and after the slot frees the
  queue head that sits on the day-plan slot is announced
  "up next: … · queued #1, starts when the slot frees". Result: ALL CHECKS
  PASSED; the report and screenshots above were replaced by this run.
- Criterion 5 (PASS with note, source-only activation of `:4000`) was not
  reopened; `GET /api/dispatch-insight/live-work` on the live `:4000` still
  returns 404 until that Praxis-supervised child restarts. No restart was
  performed.
