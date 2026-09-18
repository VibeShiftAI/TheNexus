# Standard run-trace field list: contract v1

Every production agent run the cockpit shows is reported against one fixed
list of fields. This document is the contract: what the fields are, where each
one comes from, what "unknown" means, and how audit-trace completeness is
computed. Implementation: `server/services/run-trace.js` (server) and
`dashboard/src/lib/run-trace.ts` (client).

## Provenance of the list

The field list is adopted verbatim from production-trace guidance captured in
the 2026-09-10 overnight ingestion report, quoting
<https://plane.so/blog/how-enterprises-run-ai-agents-in-self-hosted-project-management>
(published 2026-09-10T02:01:44.424Z).

Evidence read for this contract, through the read-only Praxis bridge
(`cortex_memory` action=find then action=read), checked 2026-09-17:

- `report:2026-09-10.md`, sha256
  `ca03174f3e9d7764c26f422d379b430f94e28b4fbc20a31761371d6bff6bdc84`,
  match at character offset 243244 (line 3429), read span from offset 242844.

The three passages that set this contract, quoted from that span:

> The surrounding agent runtime still needs its own execution trace for
> details such as the run ID, agent or workflow version, model calls, tool
> calls, retries, approvals, errors, and final outcome. Together, these
> records can connect an agent run to the resulting change in Plane.

> For debugging and governance, preserve observable execution evidence such as
> tool calls, approvals, state changes, and outcomes rather than attempting to
> retain hidden model reasoning.

> | Area | What to measure |
> | Decision quality | Task success, incorrect-action rate, human rejection rate, human correction rate |
> | Execution reliability | Tool-call success, workflow completion, duplicate or retry rate, escalation rate |
> | Control effectiveness | Permission or approval violations, stale-state failures, audit or trace completeness |
> | Operational performance | Latency and model or compute cost per successful workflow |

**Limits of this evidence.** What was read is the ingestion report's captured
excerpt of the page, not the live page: the report elides text with `[...]`
markers, so the passages are contiguous within the excerpt but not necessarily
within the original article. The guidance is vendor engineering advice about
running agents alongside Plane, not a standard or a measured result; it is
adopted here because the field list is concrete and observable, not because
the source is authoritative. The second passage is load-bearing in the other
direction: it is why nothing in this contract reaches for prompt or
chain-of-thought text. An unchanged sha256 means the same report bytes, not
that the underlying page still says this.

## The eight fields

All eight are REQUIRED, meaning all eight count toward completeness. Two of
them are not instrumented anywhere in the fleet today, which is exactly why
they stay on the required list: dropping them would redefine "complete" as
"complete for what we happen to store".

| Field | Source when observed | Status |
|---|---|---|
| `runId` | `task_dispatches.id`, plus the Praxis attempt id when the run-events spine names one | instrumented |
| `agentVersion` | The resolved model id (`claude-opus-5`), or the precise model name off the commit's own `Model:` / `Co-Authored-By:` trailer on the activity feed. The executor name rides along as `executor` but does not by itself satisfy the field; `harnessVersion` is always null | instrumented |
| `modelCalls` | none | **not instrumented** |
| `toolCalls` | none | **not instrumented** |
| `retries` | This run's 1-based position in the task's COMPLETE dispatch history | instrumented |
| `approvals` | Verification verdicts from Praxis's run-events spine | instrumented |
| `errors` | `task_dispatches.error` plus guardrail events (executor incidents, boot reconciliations) in the run's window | instrumented |
| `finalOutcome` | `task_dispatches.outcome`, once terminal | instrumented |

### Why `agentVersion` is strict

`claude-code` names WHICH agent ran, not WHICH VERSION of it, and the CLI
harness build a run actually used is recorded nowhere in the fleet. The
executor-derived display label the feed falls back to for its model chip
(`Codex`, `Gemini`) is excluded for the same reason. A run with
an executor and no model therefore scores this field unknown rather than
borrowing the executor name to look better. `harnessVersion: null` is carried
in the payload so the gap is visible on the wire, not only in this document.

### Why `modelCalls` is not satisfied by the token count

A dispatch row carries one blended token TOTAL for the whole run. That is not
a call count and is never presented as one. The total rides along under the
unknown as `evidence`, so a surface can show what it does have without
claiming the field.

## Known or unknown, never a default

Each field is exactly one of:

- `{ known: true, value }`
- `{ known: false, reason, detail }` (with an optional `evidence` near-miss)

There is no third state and no default value. A field the fleet cannot see
never renders as `0`, `false` or `none`, because "no retries" and "no retry
telemetry" are different facts and collapsing them is the defect this contract
exists to prevent. This is the same rule the dispatch console's cost figures
already follow (`usageUnknownReason` in `server/routes/dispatch-insight.js`).

A **measured zero is an observation**. A run whose error channel was readable
and empty scores `errors` as observed with an empty list; it is only unknown
when the channel itself could not be read.

Reason codes: `not_instrumented`, `not_recorded`, `spine_unavailable`,
`run_in_flight`, `no_dispatch_match`, `not_queried`.

## Audit-trace completeness

`completeness.ratio` = observed required fields / required fields, per run.

- **Terminal runs only.** A run still in flight has no final outcome yet, so
  its ratio is `null` with `pending: true`. Scoring live runs against a list
  that demands a terminal outcome would make the fleet look worse the busier
  it is.
- **The ceiling is 6/8 = 0.75 today**, because `modelCalls` and `toolCalls`
  are not instrumented. Every surface that shows the number also names that
  ceiling, so a reader does not take 75% as a fault in the run.
- **`missing` always accompanies the number**, naming each absent field and
  its reason.

## Measurement areas

`summarizeTraceQuality()` rolls the source's areas up over a task's runs.
Two deliberate departures, both stated in the payload rather than hidden:

1. **Human vs reviewer.** The source measures "human rejection rate" and
   "human correction rate". In this fleet the adjudicator is a
   different-model QA agent and Robert sees the result, so the human measures
   report `not_instrumented` and name the reviewer measure that stands nearest
   to them. `reviewerRejection` counts `qa_improvement_requested` events over
   the rounds that actually produced a verdict (`task_qa_passed` +
   `qa_improvement_requested`); `reviewerCorrection` counts
   `task_correction_redispatch`. Relabelling machine adjudication as human
   judgement would be the easy lie here.
2. **Operational performance is not recomputed.** The source's fourth area
   (latency and cost per successful workflow) is already reported by the
   dispatch console with its own coverage (`usageRollup`, per-run
   `elapsedMs`). A second, differently-derived cost figure on the same screen
   is a contradiction waiting to happen, so this roll-up names where the
   figure lives instead of producing a rival one.

`approvalViolations` reports `not_instrumented`: nothing in the fleet records
an action taken against a withheld or denied approval, so a count of zero
would be an assumption rather than a measurement. `staleStateFailures` counts
boot reconciliations from the spine plus
`cli_gate_stall_requires_reconciliation` events.

Every rate carries its own denominator, and a denominator that does not exist
produces `null`, not `0`: a task no reviewer ever saw has no rejection rate.

## Surfaces that adopt it

| Surface | Endpoint | What it reports |
|---|---|---|
| Recent Activity Feed | `GET /api/activity` | `runTrace` per activity row |
| Dispatch console | `GET /api/dispatch-insight/task/:taskId` | `runTrace` per run, `traceQuality` per task |

The feed sees less than the console and says so rather than leaving fields
blank. Two fields are deliberately unknown there:

- `retries` is `not_recorded`, because retry depth is a claim about a task's
  COMPLETE dispatch history and the feed holds a rolling window of recent rows
  across every project. Counting attempts inside that window would report
  attempt 9 as attempt 2 whenever older rows have aged out.
- `approvals` is `not_queried`, because the feed never opens the run-events
  spine. The code names where the answer lives instead of implying none
  exists.

An activity with no dispatch behind it (a hand-authored commit, a commit
outside every dispatch window) gets a trace whose every field is
`no_dispatch_match`, and the UI renders it as "no run to trace" rather than as
a zero score.

## Not yet adopted

The Evidence surface (document review, evidence ledgers) is a named consumer
of this schema in the task that produced it but is not wired to it here. When
it is, it should take the same module rather than growing a parallel field
list.
