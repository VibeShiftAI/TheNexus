# Slate lifecycle: contract v3

The day's slate is shown on the task board as four stages:
**drafted → approved → attempted → verified**, so a slate stuck at one of
them is visible without reading preflight or asking Praxis in chat.

Implementation: `server/services/slate-lifecycle.js` (projection),
`server/services/slate-qa-evidence.js` (the QA half of the evidence),
`server/routes/slate.js` (`GET /api/slate/lifecycle`),
`dashboard/src/lib/slate-lifecycle.ts` and
`dashboard/src/components/slate-lifecycle-strip.tsx` (surface).

## Why this exists

On 2026-08-24 the slate was built, reached the `[MORNING PLAN]` approval card,
and sat there. Nothing dispatched. The cockpit showed its usual todo tasks and
said nothing, because the only record of the real state was
`approval.status === "pending"` inside Praxis's schedule file. The knowledge
council's reading the next morning
(`shared-mind/memories/note_knowledge_council_2026-08-25.md`, section 1) is the
requirement this contract implements:

> Name last night's quiet correctly: the slate was never approved, not
> "dispatch broke." … Approval-gated silence is by design — silence that
> nobody notices is not.

So the surface's job is not "show the schedule" (Praxis already narrates that).
It is: **which stage is the slate sitting in, and for how long.**

## Where the data comes from

Praxis owns scheduling. The cockpit reads, never writes.

Praxis has no HTTP endpoint that returns the schedule as data. Its agent-tool
bridge exposes `get_day_schedule`, but that answers with a rendered markdown
table meant for a person, which is why `server/routes/dispatch-insight.js`
(`probeDaySchedule`) can only use it as a liveness sentinel. Driving a status
surface by parsing that table would be the wrong contract.

This reads `PRAXIS_DATA_DIR/schedule.json` directly, read-only, the same way
the cockpit already reads Praxis's usage-limit ledger
(`server/services/focus-usage-waits.js`) and its local-evidence directory
(`server/services/local-evidence-work.js`). Overrides:
`PRAXIS_SCHEDULE_FILE`, then `PRAXIS_DATA_DIR`, then
`/Volumes/Projects/Praxis/data/schedule.json`.

The fields read are Praxis's own, defined in
`Praxis/src/scheduler/plan-model.ts` (`DaySchedule`, `ScheduledSlot`) and
`Praxis/src/executors/dispatch-provenance.ts` (`SlotProvenanceStamp`).

## The four stages

| Stage | Reached when | Timestamp |
|---|---|---|
| `drafted` | the slate has a `createdAt` | `schedule.createdAt` |
| `approved` | `approval.status === "approved"` | `approval.resolvedAt` |
| `attempted` | ≥ 1 non-withdrawn slot carries dispatch proof | earliest attempted slot's provenance stamp (else its planned start) |
| `verified` | ≥ 1 non-withdrawn slot is `completed` AND carries dispatch proof AND carries a QA pass in Praxis's verification ledger | latest verified slot's QA verdict (else its provenance stamp) |

`skipped` and `deferred` slots are **withdrawn**: they were taken out of the
plan and never dispatched, so they are excluded from every denominator.
Counting them as attempts is how a slate with twelve skipped slots would read
as a working day.

`verified.complete` is true only when every live slot is QA-passed.

## Dispatch evidence (v2, QA 2026-09-18)

**A `completed` status is not proof the dispatch plane ran the slot, and not
proof QA passed it.** Praxis promotes board-completed work into that status
from paths that never touched the plane: `healSuspendedSlotsCompletedOnBoard`
(`scheduler/calendar-sync.ts`) heals a suspended slot whose Nexus task the
board already calls done, including work Robert finished by hand, and the
pre-dispatch reconciliation pass consumes already-done slots `out-of-band`,
which `executors/dispatch-provenance.ts` defines as "the task was already done
on the board, no plane run".

The evidence test is Praxis's own, lifted from the reconciliation canary in
`dispatch-provenance.ts`, which had to answer this exact question after the
2026-08-07/08 incident ("nine completed slots alongside zero recorded attempts
means the control plane cannot currently prove what executed"):

| Slot state | Reads as |
|---|---|
| status `dispatched` | dispatch proven (it is in the plane right now) |
| `advance-callback` **with** an `attemptId` | dispatch proven |
| `advance-callback` with no `attemptId` | **unproven** |
| `usage-limit-suspension`, `dispatch-failure`, `operator-accept` | dispatch proven (a run existed) |
| `out-of-band` | **out of band**: landed, but the plane did not run it |
| no stamp at all | **unproven** |

Per slot, `attempted` and `dispatchProven` answer different questions.
`attempted` is "does this slot count as an attempt in the plan", so a withdrawn
slot is never one. `dispatchProven` is the raw evidence, "did the plane run
it", which stays true for a slot cancelled mid-flight.

Unproven and out-of-band completions are terminal but are neither dispatches
nor QA passes. They are reported as themselves, in their own counts
(`counts.unproven`, `counts.outOfBand`) and in the stage detail
("0 of 1 slot QA-passed; 1 landed out of band, not QA-passed"), never rounded
up into `attempted`/`verified` and never silently dropped.

## QA evidence, which is a SECOND source (v3, QA 2026-09-18)

**Dispatch proof is not verification proof.** The schedule file cannot answer
"did this pass QA" at all: `ScheduledSlot` has no QA field, and `provenance` is
dispatch evidence by its own definition. Worse, `reconcileTerminalTask`
(`scheduler/terminal-reconciliation.ts`) flips a slot to `completed` when the
board says the task is done and writes `candidate.status` only, leaving the
existing stamp untouched. So a slot suspended at a usage limit, one that failed
to dispatch, or one carrying an older correlated `advance-callback` stamp
becomes `completed` with its attempt evidence intact the moment somebody
finishes the task by hand. Reading that as a QA pass is the QA finding this
version answers: an earlier failed or suspended attempt could become a claimed
QA pass. Restricting the rule to `advance-callback` stamps would not have fixed
it, because a retained correlated stamp is one.

The affirmative record lives in the run-events spine. `finalizeTaskComplete`
(`orchestrator/qa-dispatch.ts`) calls `recordCompletionVerification`
(`orchestrator/verification-protocol.ts`), which appends exactly one
`type: "verification"` row per finalization. Nothing in the reconciliation path
writes one. `server/services/slate-qa-evidence.js` reads those rows read-only
from `PRAXIS_EXECUTION_LOG_DB` (default `~/.praxis-mind/cost_ledger.sqlite`),
the same spine and the same `db/raw.js` read-only handle
`server/routes/dispatch-insight.js` already uses.

| `data.qa.outcome` | Reads as |
|---|---|
| `pass` | QA pass: a reviewer passed the work |
| `exempt` | audit waived, **not** a pass |
| `none` | no audit happened, **not** a pass |
| `deferred` | audit still owed; verification-protocol.ts grades it exactly like `none` |

`data.verdict` (`verified` / `uncertain` / `partial` / `unverified`) is Praxis's
grade of the evidence behind that pass. It is carried through as `qaVerdict`
for display and is never used to manufacture or withdraw a pass: most real
passes today are graded `uncertain`, and requiring `verified` would have
under-reported genuinely reviewed work.

Two floors keep an old verdict from laundering a new completion:

1. Rows are queried with `ts >= schedule.createdAt` (falling back to the
   earliest slot's planned start when a slate carries no `createdAt`), so a
   verdict recorded before this slate existed belongs to an earlier run of the
   same task.
2. The newest row per task wins (`ORDER BY seq ASC`, last write kept), so a
   later `none` supersedes an earlier `pass`.

The SQLite integration test pins the inclusive `ts >= since` boundary and newest-verdict selection by append `seq`, not by `ts`.

A completion with dispatch proof and no covering verdict is **`qaUnverified`**:
the attempt evidence stands, the QA claim does not. It is counted in
`counts.qaUnverified`, named in the stage detail ("1 completed with no QA
verdict") and labelled on the slot row, never folded into `verified` and never
into `unproven` (the plane really did run it).

If the ledger cannot be read, the answer is **unknown**, not zero passes. The
response carries `qaEvidence: { available: false, reason }`, the stage detail
says so ("QA ledger unavailable (…)"), and every affected row reads "completed
(QA evidence unreadable)". The verified stage sets `unknown: true`, with
`counts.verified` and `counts.qaUnverified` set to `null` (not zero).
`counts.qaUnknown` counts completed, dispatch-proven slots whose review cannot
be read. The chip uses the unknown tone, omits the pass fraction, and labels
those completions "QA unknown". Its tooltip makes no zero-pass or missing-review
claim. A verification stall says "verification unknown", including when nothing
is left to run, and never warns or displays a waiting clock. Dispatch counts
and provenance remain intact.

## Carryover, which is Praxis's rule (v2, QA 2026-09-18)

Staleness is a property of the **work**, not of the clock, and the rule belongs
to Praxis. `isScheduleStale` (`plan-model.ts`) is mirrored exactly:

1. `schedule.date` is today (America/New_York, Praxis's `etDateString`) →
   never stale.
2. Otherwise, no live slots (`pending` or `dispatched`, Praxis's
   `scheduleLiveSlotCount`) → stale. The day this plan belongs to is over.
3. Otherwise, stale only once `now - scheduleEnd > CARRYOVER_GRACE_MS` (12h),
   where `scheduleEnd` is `getScheduleEndTime`: the **last** slot's
   `startTime + (estimatedMinutes + BUFFER_MINUTES)`, buffer 15 minutes.

`carriedOver` is the narrower complement: dated **before** today, not stale, so
live work remains inside the grace window. That, and only that, is "running
past midnight". A plan dated ahead of today is neither stale nor carried over.

`liveSlots` is on the response so the surface can say why: a slate with no live
work cannot advance, so its stall reports `stalled: false` and never warns.

`server/__tests__/slate-lifecycle.test.js` asserts each branch, and
`docs/verification-protocol.md`-style differential evidence for it comes from
running Praxis's own extracted functions over identical fixtures.

## Honesty rules

1. **A stage is reached only on positive evidence.** Absent evidence is
   `reached: false` with a reason, never an optimistic default.
2. **A missing `approval` record reads `unknown`, not `approved`.** A plan
   built before the gate existed and a plan Robert approved are different
   facts, and collapsing them is exactly the failure this surface exists for.
3. **A rejected slate is `blocked`, not late.** It carries no stall clock: it
   is finished and will not run.
4. **Completion is not evidence, and a dispatch is not a review.** A
   `completed` slot claims a dispatch only with affirmative provenance
   ("Dispatch evidence" above) and claims a QA pass only with a covering
   verdict in Praxis's verification ledger ("QA evidence" above). Absent the
   first it is out-of-band or unproven; absent the second it is `qaUnverified`.
   All three are real outcomes, reported as themselves rather than as an
   absence to be hidden.
5. **`operator-accepted` is attempted but never verified.** Praxis stamps it
   when Robert overrides a QA rejection from the escalation card; its own
   contract says "The work did NOT pass QA, and every report must render it as
   operator-accepted, never as done/QA-passed". It is counted and reported
   beside the verified count, never inside it.
6. **Only the CURRENT stall reads as waiting.** Stages after it are
   `upcoming`. A slate stuck at approval has not failed to dispatch; it has
   not got there yet, and painting three stages red for one stall is how a
   reader stops believing the strip.
7. **A slate from another day says which day it is.** `stale: true` once it is
   past Praxis's 12h carryover window (`CARRYOVER_GRACE_MS` in
   `plan-model.ts`); `carriedOver: true` while a spilled-over slate is still
   plausibly the live one. Neither is headlined as today's slate.
8. **Unreadable is not absent.** A missing, oversized or malformed schedule
   answers `available: false` with the reason, and the strip says the slate's
   stage is unknown. It never says there is no slate.
9. **An unreadable QA ledger is unknown, not a failure.** `qaEvidence.available:
   false` with its reason, and the affected completions say the evidence could
   not be read. Answering "no passes" from a file the cockpit could not open
   would be the same lie as claiming a pass it never saw.
10. **A spine gap is surfaced, not smoothed.** A slot whose provenance stamp
   carries `spineRecorded: false` is counted in `spineUnrecorded` and flagged
   in the slot list: the run-events spine rejected the write, and the slot
   holds the only surviving evidence it ran (the 2026-08-07/08 class).

## The stall

`stall` is the first stage not reached, plus how long the slate has been
sitting there. `since` is the timestamp of the stage that DID complete (or,
for a pending approval, `approval.requestedAt`), because that is the moment the
slate started waiting. `warn` is true once that wait passes
`STALL_WARN_MS` (45 minutes) and the stage can still advance; a blocked stage
never warns, and neither does a slate with no live slots left (`stalled:
false`): a slate whose work all landed out of band is not late, it is finished
by another route. A slate whose last stage is reached has `stall: null`.

## Response shape

```jsonc
GET /api/slate/lifecycle → 200
{
  "at": "2026-09-18T01:02:03.456Z",   // when the cockpit read it
  "available": true,
  "date": "2026-09-17",
  "scheduleId": "morning-2026-09-17-run-2026-09-17-gp2r4j2z",
  "morningRunId": "run-2026-09-17-gp2r4j2z",
  "createdAt": "2026-09-17T19:28:06.286Z",
  "stale": false,
  "carriedOver": false,
  "liveSlots": 2,                      // pending + dispatched, Praxis's own count
  "qaEvidence": { "available": true }, // or { "available": false, "reason": "…" }
  "stages": [
    { "stage": "drafted", "reached": true, "at": "…", "detail": "12 slots planned", "counts": { "slots": 12 } },
    { "stage": "verified", "reached": true, "complete": false, "at": "…",
      "detail": "1 of 5 slots QA-passed; 1 operator-accepted over a QA rejection; 1 landed out of band, not QA-passed; 1 completed with no QA verdict",
      "counts": { "verified": 1, "live": 5, "operatorAccepted": 1, "outOfBand": 1, "unproven": 0, "qaUnverified": 1 },
      "qaEvidence": true }
  ],
  "stall": null,                       // or { stage, since, waitingMs, blocked, unknown, stalled, warn }
  "slots": [ { "slotNumber": 1, "taskId": "…", "title": "…", "status": "completed",
               "attempted": true, "dispatchProven": true, "verified": true,
               "outOfBand": false, "unprovenCompletion": false, "qaUnverified": false,
               "qaPassed": true, "qaOutcome": "pass", "qaVerdict": "uncertain",
               "qaReviewer": "codex", "qaAt": "…", … } ]
}
```

The route always answers 200. An unreadable schedule is `available: false`
with a `reason`, because a 500 here would take the board's strip down with it.

## On screen

The stage chips carry their own counts, not only a tooltip: `Verified 1/5` plus
a label per qualifying outcome (`1 operator-accepted`, `1 out of band`,
`1 unproven`, `1 not QA-reviewed`, `1 withdrawn`). A reached-but-unfinished stage renders in the
distinct `partial` tone rather than the finished `done` green, so a slate with
one of five slots QA-passed is never mistaken for a finished one, including on
a touch device with no hover. The expanded slot list names each slot's real
outcome: "done out of band (no plane run)", "completed (no dispatch evidence)",
"completed (not QA-reviewed)", "operator-accepted (not QA-passed)"; the passing
rows carry the reviewer and Praxis's grade in their title. A settled slate (no
live slots left) wears a neutral chip with no elapsed clock, because "waiting
2h" beside "Nothing left to run" tells two stories at once.

## What it deliberately does not do

- **No actions.** Approving a slate stays on the `[MORNING PLAN]` card, where
  Robert already does it. This surface is read-only.
- **No execution input.** Slot `instructions`, `objective`, `taskDescription`
  and reconciliation evidence are dispatch payload, not status, and never
  leave the server.
- **No re-derivation of the slate.** The slate itself comes from the one file
  Praxis writes; nothing here rebuilds it from the board or from dispatch rows.
  The verification ledger is a second *evidence* source, not a second slate: it
  answers only "did a reviewer pass this completion", a question the schedule
  file does not contain (see "QA evidence" above), and it is read read-only.

## Tests

- `server/__tests__/slate-lifecycle.test.js`: the projection and the route.
- `dashboard/src/components/__tests__/slate-lifecycle-surface.test.mjs`: the
  tone and sentence rules above, against captured server output including a
  reconciled completion and an unreadable ledger.
