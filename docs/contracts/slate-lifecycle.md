# Slate lifecycle: contract v1

The day's slate is shown on the task board as four stages:
**drafted → approved → attempted → verified**, so a slate stuck at one of
them is visible without reading preflight or asking Praxis in chat.

Implementation: `server/services/slate-lifecycle.js` (projection),
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
| `attempted` | ≥ 1 non-withdrawn slot left `pending` | earliest attempted slot's provenance stamp (else its planned start) |
| `verified` | ≥ 1 non-withdrawn slot reached `completed` | latest verified slot's provenance stamp |

A slot counts as **attempted** when its status is one of `dispatched`,
`completed`, `suspended`, `operator-accepted`, `cancelled`, or when it carries
a provenance stamp. `skipped` and `deferred` slots are **withdrawn**: they were
taken out of the plan and never dispatched, so they are excluded from every
denominator. Counting them as attempts is how a slate with twelve skipped slots
would read as a working day.

`verified.complete` is true only when every live slot is terminal
(`completed` + `operator-accepted` = live slots).

## Honesty rules

1. **A stage is reached only on positive evidence.** Absent evidence is
   `reached: false` with a reason, never an optimistic default.
2. **A missing `approval` record reads `unknown`, not `approved`.** A plan
   built before the gate existed and a plan Robert approved are different
   facts, and collapsing them is exactly the failure this surface exists for.
3. **A rejected slate is `blocked`, not late.** It carries no stall clock: it
   is finished and will not run.
4. **`operator-accepted` is attempted but never verified.** Praxis stamps it
   when Robert overrides a QA rejection from the escalation card; its own
   contract says "The work did NOT pass QA, and every report must render it as
   operator-accepted, never as done/QA-passed". It is counted and reported
   beside the verified count, never inside it.
5. **Only the CURRENT stall reads as waiting.** Stages after it are
   `upcoming`. A slate stuck at approval has not failed to dispatch; it has
   not got there yet, and painting three stages red for one stall is how a
   reader stops believing the strip.
6. **A slate from another day says which day it is.** `stale: true` once it is
   past Praxis's 12h carryover window (`CARRYOVER_GRACE_MS` in
   `plan-model.ts`); `carriedOver: true` while a spilled-over slate is still
   plausibly the live one. Neither is headlined as today's slate.
7. **Unreadable is not absent.** A missing, oversized or malformed schedule
   answers `available: false` with the reason, and the strip says the slate's
   stage is unknown. It never says there is no slate.
8. **A spine gap is surfaced, not smoothed.** A slot whose provenance stamp
   carries `spineRecorded: false` is counted in `spineUnrecorded` and flagged
   in the slot list: the run-events spine rejected the write, and the slot
   holds the only surviving evidence it ran (the 2026-08-07/08 class).

## The stall

`stall` is the first stage not reached, plus how long the slate has been
sitting there. `since` is the timestamp of the stage that DID complete (or,
for a pending approval, `approval.requestedAt`), because that is the moment the
slate started waiting. `warn` is true once that wait passes
`STALL_WARN_MS` (45 minutes) and the stage can still advance; a blocked stage
never warns. A slate whose last stage is reached has `stall: null`.

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
  "stages": [ { "stage": "drafted", "reached": true, "at": "…", "detail": "12 slots planned", "counts": { "slots": 12 } }, … ],
  "stall": null,                       // or { stage, since, waitingMs, blocked, unknown, warn }
  "slots": [ { "slotNumber": 1, "taskId": "…", "title": "…", "status": "completed", … } ]
}
```

The route always answers 200. An unreadable schedule is `available: false`
with a `reason`, because a 500 here would take the board's strip down with it.

## What it deliberately does not do

- **No actions.** Approving a slate stays on the `[MORNING PLAN]` card, where
  Robert already does it. This surface is read-only.
- **No execution input.** Slot `instructions`, `objective`, `taskDescription`
  and reconciliation evidence are dispatch payload, not status, and never
  leave the server.
- **No second source of truth.** Nothing here re-derives the slate from the
  board or from dispatch rows; it projects the one file Praxis writes.

## Tests

- `server/__tests__/slate-lifecycle.test.js`: the projection and the route.
- `dashboard/src/components/__tests__/slate-lifecycle-surface.test.mjs`: the
  tone and sentence rules above.
