/**
 * The standard run-trace field list: the schema the attribution surface
 * reports a production agent run against.
 *
 * WHY A FIXED LIST. The cockpit already answers "which model ran this, and
 * what did it cost" (projects.js deriveActivityAttribution, dispatch-insight
 * usageRollup). It has never answered "is this run's trace good enough to
 * audit", because there was no agreed list of what a trace must contain.
 * A run with a model name and nothing else looked exactly as attributed as a
 * run with a verdict, an error record and a retry count behind it.
 *
 * The field list below is adopted verbatim from the production-trace guidance
 * captured in the 2026-09-10 ingestion report (report:2026-09-10.md, sha256
 * ca03174f3e9d7764c26f422d379b430f94e28b4fbc20a31761371d6bff6bdc84, char
 * offset 243244) quoting
 * https://plane.so/blog/how-enterprises-run-ai-agents-in-self-hosted-project-management:
 *
 *   "The surrounding agent runtime still needs its own execution trace for
 *    details such as the run ID, agent or workflow version, model calls, tool
 *    calls, retries, approvals, errors, and final outcome."
 *
 * The same passage sets the scope rule this module obeys ("preserve
 * observable execution evidence such as tool calls, approvals, state changes,
 * and outcomes rather than attempting to retain hidden model reasoning"), so
 * nothing here reaches for prompt or chain-of-thought text.
 *
 * HONESTY RULES (the same ones dispatch-insight's cost figures follow):
 *   1. Every field is either OBSERVED (`known: true` + a value) or UNKNOWN
 *      (`known: false` + a machine-readable reason). There is no third state
 *      and no default value. A field Nexus cannot see never renders as 0,
 *      false or "none", because "no retries" and "no retry telemetry" are
 *      different facts and collapsing them is the defect this exists to stop.
 *   2. A MEASURED ZERO is an observation. A run whose error channel was
 *      readable and empty scores `errors` as observed with an empty list; it
 *      is only unknown when the channel itself could not be read.
 *   3. Completeness is computed over TERMINAL runs only. A run still in
 *      flight has no final outcome yet, and scoring it against a list that
 *      demands one would report a live run as a badly-traced one.
 *
 * WHAT THIS MODULE IS NOT. It reads nothing: no DB handle, no Praxis call, no
 * filesystem. Callers pass in what they already loaded and get back the
 * standard shape, so the same contract can serve the activity feed (git
 * commits correlated to dispatches) and the dispatch console (full run rows +
 * Praxis's run-events spine) without either learning the other's storage.
 */

/** Bump when a field is added, removed, or its meaning changes. */
const RUN_TRACE_VERSION = 1;

/**
 * Why a field carries no value. Kept as codes so a surface can group and
 * count them; the prose is for the reader.
 */
const UNKNOWN_REASONS = {
    not_instrumented:
        'Nothing in the fleet records this today: neither the Nexus dispatch row nor the Praxis run-events spine carries it.',
    not_recorded:
        'This run left no record of it, though the field is one the fleet can record.',
    spine_unavailable:
        "Praxis's run-events spine could not be read, so this run's record of it is unseen rather than absent.",
    run_in_flight:
        'The run has not finished, so this is not determined yet.',
    no_dispatch_match:
        'This activity could not be correlated to any dispatch, so there is no run behind it to trace.',
    not_queried:
        'This surface does not read the channel that carries it; the dispatch console for the same run does.',
};

/**
 * The adopted field list, in the order the source names them.
 *
 * `required: true` means the field counts toward audit-trace completeness.
 * Every one of the eight is required, because a list whose hard fields are
 * optional measures nothing. `instrumented: false` marks the fields the fleet cannot
 * observe at all today; they are still required, which is precisely why the
 * completeness figure is currently capped below 1 and says so out loud
 * instead of quietly redefining "complete" as "complete for what we happen
 * to store".
 */
const RUN_TRACE_FIELDS = [
    {
        key: 'runId',
        label: 'Run ID',
        required: true,
        instrumented: true,
        description: 'Identity of the run: the Nexus dispatch row id, plus the Praxis attempt id when the spine names one.',
    },
    {
        key: 'agentVersion',
        label: 'Agent or workflow version',
        required: true,
        instrumented: true,
        description: 'The versioned identifier of what ran. The resolved model id (claude-opus-5) is a version; the executor name alone is an identity, not one, and the CLI harness build is not recorded anywhere in the fleet.',
    },
    {
        key: 'modelCalls',
        label: 'Model calls',
        required: true,
        instrumented: false,
        description: 'Per-call model invocations. The dispatch row carries one blended token TOTAL for the whole run, which is not a call count and is never presented as one.',
    },
    {
        key: 'toolCalls',
        label: 'Tool calls',
        required: true,
        instrumented: false,
        description: 'Tool invocations and their outcomes. The executor CLI does not report them back to Nexus or to the run-events spine.',
    },
    {
        key: 'retries',
        label: 'Retries',
        required: true,
        instrumented: true,
        description: "This run's position in the task's dispatch history, and how many attempts preceded it. Requires the COMPLETE history, because counting within a display page would report a late attempt as the first.",
    },
    {
        key: 'approvals',
        label: 'Approvals',
        required: true,
        instrumented: true,
        description: 'Adjudication decisions recorded against the run: QA verdicts from the run-events spine, and holds where autonomy withheld a correction.',
    },
    {
        key: 'errors',
        label: 'Errors',
        required: true,
        instrumented: true,
        description: 'The dispatch row\'s error text plus the guardrail events (executor incidents, boot reconciliations) that landed in the run\'s window.',
    },
    {
        key: 'finalOutcome',
        label: 'Final outcome',
        required: true,
        instrumented: true,
        description: 'The terminal outcome of the run (success / failure / timeout / needs_input / cancelled). Undetermined while the run is in flight.',
    },
];

const REQUIRED_FIELD_KEYS = RUN_TRACE_FIELDS.filter((f) => f.required).map((f) => f.key);

/** Dispatch outcomes that mean the run is over. Anything else is in flight. */
const TERMINAL_OUTCOMES = new Set(['success', 'failure', 'timeout', 'needs_input', 'cancelled']);

function isTerminalOutcome(outcome) {
    return TERMINAL_OUTCOMES.has(String(outcome || '').trim().toLowerCase());
}

/** An observed field. `extra` carries field-specific detail alongside the value. */
function observed(value, extra = null) {
    return extra ? { known: true, value, ...extra } : { known: true, value };
}

/**
 * An unobserved field. `evidence` is for the near-miss case: telemetry that
 * exists and is related but is NOT the field (a token total is not a model
 * call count). Attaching it under the unknown keeps the surface from
 * presenting the near-miss as the thing itself.
 */
function unknown(reason, evidence = null) {
    const out = { known: false, reason, detail: UNKNOWN_REASONS[reason] || null };
    if (evidence) out.evidence = evidence;
    return out;
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Audit-trace completeness for one trace: the control-effectiveness measure
 * the source names ("Permission or approval violations, stale-state failures,
 * audit or trace completeness").
 *
 * Returns `ratio: null` with `pending: true` for a run still in flight: the
 * completeness of a trace that is still being written is not a measurement,
 * and averaging in-flight runs would make the fleet look worse the busier it
 * is. `missing` names every required field that carries no value and why, so
 * the number is always accompanied by the reason it is not 1.
 */
function traceCompleteness(fields, { terminal = true } = {}) {
    const missing = [];
    let observedCount = 0;
    for (const key of REQUIRED_FIELD_KEYS) {
        const field = fields?.[key];
        if (field?.known) {
            observedCount += 1;
        } else {
            missing.push({ field: key, reason: field?.reason || 'not_recorded' });
        }
    }
    return {
        requiredFields: REQUIRED_FIELD_KEYS.length,
        observedFields: observedCount,
        ratio: terminal ? Math.round((observedCount / REQUIRED_FIELD_KEYS.length) * 1000) / 1000 : null,
        pending: !terminal,
        missing,
    };
}

/**
 * Build the standard trace for ONE run.
 *
 * @param {object} input
 * @param {string|null} input.dispatchId   task_dispatches.id, the run id.
 * @param {string|null} input.attemptId    Praxis attempt id from the spine, when known.
 * @param {string|null} input.executor     Executor that ran it (identity, not a version).
 * @param {string|null} input.model        Resolved model id, the versioned identifier.
 * @param {string|null} input.outcome      Dispatch outcome ('running' while in flight).
 * @param {number|null} input.tokens       Blended token TOTAL, attached as near-miss evidence only.
 * @param {boolean} input.tokensEstimated  Whether that total is an estimate.
 * @param {{attempt:number,priorAttempts:number}|null} input.attempts
 *        This run's place in the task's COMPLETE dispatch history, or null
 *        when the caller only holds a page of it.
 * @param {Array|null} input.approvals     Adjudication records for the run; [] is a
 *        measurement, null means the approval channel could not be read.
 * @param {boolean} input.approvalChannelReadable  False, the channel was not read.
 * @param {string|null} input.approvalChannelReason   Which unknown reason applies.
 * @param {boolean} input.dispatchMatched  False, the activity has no run behind it at all.
 * @param {string|null} input.error        task_dispatches.error text.
 * @param {Array} input.guardrails         Incident / reconciliation events in the run's window.
 * @param {boolean} input.errorChannelReadable  False → the Nexus row itself was unavailable.
 */
function buildRunTrace(input = {}) {
    // An activity with no run behind it (a hand-authored commit, a commit
    // outside every dispatch window) has no trace to be incomplete: every
    // field is unknown for the SAME reason, and saying so once beats eight
    // separate "not recorded" verdicts that imply a run went unlogged.
    if (input.dispatchMatched === false) {
        const fields = {};
        for (const key of REQUIRED_FIELD_KEYS) fields[key] = unknown('no_dispatch_match');
        return {
            version: RUN_TRACE_VERSION,
            terminal: false,
            fields,
            completeness: traceCompleteness(fields, { terminal: false }),
        };
    }

    const dispatchId = nonEmptyString(input.dispatchId);
    const attemptId = nonEmptyString(input.attemptId);
    const executor = nonEmptyString(input.executor);
    const model = nonEmptyString(input.model);
    const outcome = nonEmptyString(input.outcome);
    const terminal = isTerminalOutcome(outcome);

    const fields = {};

    // ── Run ID ──────────────────────────────────────────────────────────
    // The dispatch row id is the run's identity in this cockpit; the Praxis
    // attempt id is the same run's identity on the orchestration side. Either
    // one identifies the run, so the field is observed when either exists.
    // (The no-run case never reaches here: it short-circuits above.)
    fields.runId = (dispatchId || attemptId)
        ? observed({ dispatchId, attemptId })
        : unknown('not_recorded');

    // ── Agent or workflow version ───────────────────────────────────────
    // Deliberately strict: only a resolved model id counts. "claude-code"
    // names WHICH agent, not WHICH VERSION of it, and the harness build the
    // run actually used is recorded nowhere in the fleet, so a run with an
    // executor and no model scores this unknown rather than borrowing the
    // executor name to look better. `harnessVersion` is carried as an
    // explicit null so the gap is visible in the payload, not just here.
    fields.agentVersion = model
        ? observed({ model, executor, harnessVersion: null })
        : unknown('not_recorded', executor ? { executor } : null);

    // ── Model calls ─────────────────────────────────────────────────────
    // A single blended total for the whole run is NOT a call count. It rides
    // along as evidence so the surface can show what it does have without
    // claiming the field.
    fields.modelCalls = unknown(
        'not_instrumented',
        typeof input.tokens === 'number' && Number.isFinite(input.tokens) && input.tokens >= 0
            ? { tokensTotal: input.tokens, tokensEstimated: input.tokensEstimated === true }
            : null,
    );

    // ── Tool calls ──────────────────────────────────────────────────────
    fields.toolCalls = unknown('not_instrumented');

    // ── Retries ─────────────────────────────────────────────────────────
    // Observed only against the task's COMPLETE dispatch history. A caller
    // holding one display page cannot tell attempt 1 from attempt 9, and a
    // wrong "first attempt" is worse than an honest unknown.
    const attempts = input.attempts;
    fields.retries = attempts && Number.isFinite(attempts.attempt) && Number.isFinite(attempts.priorAttempts)
        ? observed({ attempt: attempts.attempt, priorAttempts: attempts.priorAttempts })
        : unknown('not_recorded');

    // ── Approvals ───────────────────────────────────────────────────────
    // An empty list from a channel that WAS readable is a real measurement
    // ("no adjudication recorded for this run"); an unreadable channel is not.
    // The caller has to hand over an actual list to claim the observation:
    // defaulting a missing argument to an empty array would manufacture a
    // measurement out of a caller that never looked.
    if (input.approvalChannelReadable === false) {
        fields.approvals = unknown(input.approvalChannelReason || 'spine_unavailable');
    } else if (Array.isArray(input.approvals)) {
        fields.approvals = observed(input.approvals);
    } else {
        fields.approvals = unknown('not_recorded');
    }

    // ── Errors ──────────────────────────────────────────────────────────
    // The Nexus error column and the guardrail feed are both readable
    // whenever the row itself is, so this is observed by default and empty
    // when the run recorded nothing to report.
    if (input.errorChannelReadable === false) {
        fields.errors = unknown('not_recorded');
    } else {
        const message = nonEmptyString(input.error);
        const guardrails = Array.isArray(input.guardrails) ? input.guardrails : [];
        fields.errors = observed({ message, guardrails });
    }

    // ── Final outcome ───────────────────────────────────────────────────
    fields.finalOutcome = terminal
        ? observed(outcome)
        : unknown(outcome ? 'run_in_flight' : 'not_recorded');

    return {
        version: RUN_TRACE_VERSION,
        terminal,
        fields,
        completeness: traceCompleteness(fields, { terminal }),
    };
}

function rate(numerator, denominator) {
    if (!Number.isFinite(denominator) || denominator <= 0) return null;
    return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Roll the measurement areas up over a set of traces.
 *
 * The areas and their measures are the source's own table (same passage as
 * the field list):
 *
 *   | Decision quality      | Task success, incorrect-action rate, human
 *                             rejection rate, human correction rate |
 *   | Execution reliability | Tool-call success, workflow completion,
 *                             duplicate or retry rate, escalation rate |
 *   | Control effectiveness | Permission or approval violations,
 *                             stale-state failures, audit or trace
 *                             completeness |
 *
 * Two deliberate departures, both stated in the payload rather than hidden:
 *
 *   - HUMAN vs REVIEWER. The source measures "human rejection rate" and
 *     "human correction rate". In this fleet the adjudicator is a
 *     different-model QA agent, not a person: Robert sees the result. So the
 *     human measures report `not_instrumented` and name the reviewer measure
 *     that stands nearest to them, instead of relabelling machine
 *     adjudication as human judgement.
 *   - OPERATIONAL PERFORMANCE (the source's fourth area: latency and cost
 *     per successful workflow) is not recomputed here. The dispatch console
 *     already reports it with its own coverage (dispatch-insight
 *     summarizeRunUsage + per-run elapsedMs); a second, differently-derived
 *     cost figure on the same screen would be a contradiction waiting to
 *     happen.
 *
 * Every rate carries its own denominator, and in-flight runs are counted
 * separately rather than folded into either side.
 *
 * @param {Array} traces  Traces from buildRunTrace().
 * @param {object} signals Task-level counts the traces cannot carry:
 *   @param {number|null} signals.reviewerRejections  QA verdicts that failed the run.
 *   @param {number|null} signals.reviewerCorrections Correction re-dispatches issued.
 *   @param {number|null} signals.adjudicatedRuns     Runs that reached an adjudicator.
 *   @param {number|null} signals.staleStateFailures  Boot reconciliations / stall reconciliations.
 *   @param {number|null} signals.escalations         Runs that stopped for human input.
 */
function summarizeTraceQuality(traces, signals = {}) {
    const list = Array.isArray(traces) ? traces : [];
    const terminal = list.filter((t) => t?.terminal);
    const inFlight = list.length - terminal.length;

    const successes = terminal.filter((t) => t.fields?.finalOutcome?.value === 'success').length;
    const needsInput = terminal.filter((t) => t.fields?.finalOutcome?.value === 'needs_input').length;
    const retried = terminal.filter((t) => {
        const r = t.fields?.retries;
        return r?.known === true && r.value.priorAttempts > 0;
    }).length;
    const retriesMeasured = terminal.filter((t) => t.fields?.retries?.known === true).length;

    // Audit-trace completeness over terminal runs only (see traceCompleteness).
    const completenessRatios = terminal
        .map((t) => t.completeness?.ratio)
        .filter((r) => typeof r === 'number');
    const meanCompleteness = completenessRatios.length > 0
        ? Math.round((completenessRatios.reduce((a, b) => a + b, 0) / completenessRatios.length) * 1000) / 1000
        : null;

    // Which required fields go missing most often: the actionable half of
    // the completeness number.
    const missingByField = {};
    for (const t of terminal) {
        for (const m of t.completeness?.missing || []) {
            missingByField[m.field] = (missingByField[m.field] || 0) + 1;
        }
    }

    const num = (v) => (Number.isFinite(v) ? v : null);
    const reviewerRejections = num(signals.reviewerRejections);
    const reviewerCorrections = num(signals.reviewerCorrections);
    const adjudicatedRuns = num(signals.adjudicatedRuns);
    const staleStateFailures = num(signals.staleStateFailures);
    const escalations = num(signals.escalations) ?? needsInput;

    return {
        version: RUN_TRACE_VERSION,
        runs: list.length,
        terminalRuns: terminal.length,
        inFlightRuns: inFlight,
        decisionQuality: {
            taskSuccess: { successes, terminalRuns: terminal.length, rate: rate(successes, terminal.length) },
            incorrectAction: { rate: null, known: false, reason: 'not_instrumented', detail: UNKNOWN_REASONS.not_instrumented },
            humanRejection: {
                rate: null,
                known: false,
                reason: 'not_instrumented',
                detail: 'Adjudication in this fleet is performed by a different-model QA agent, not a person; the nearest observed measure is reviewerRejection.',
                nearest: 'reviewerRejection',
            },
            humanCorrection: {
                rate: null,
                known: false,
                reason: 'not_instrumented',
                detail: 'Corrections are issued by the QA loop rather than by Robert directly; the nearest observed measure is reviewerCorrection.',
                nearest: 'reviewerCorrection',
            },
            reviewerRejection: reviewerRejections != null && adjudicatedRuns != null
                ? { rejections: reviewerRejections, adjudicatedRuns, rate: rate(reviewerRejections, adjudicatedRuns) }
                : { rate: null, known: false, reason: 'not_recorded', detail: UNKNOWN_REASONS.not_recorded },
            reviewerCorrection: reviewerCorrections != null && terminal.length > 0
                ? { corrections: reviewerCorrections, terminalRuns: terminal.length, rate: rate(reviewerCorrections, terminal.length) }
                : { rate: null, known: false, reason: 'not_recorded', detail: UNKNOWN_REASONS.not_recorded },
        },
        executionReliability: {
            toolCallSuccess: { rate: null, known: false, reason: 'not_instrumented', detail: UNKNOWN_REASONS.not_instrumented },
            workflowCompletion: { completed: terminal.length, runs: list.length, rate: rate(terminal.length, list.length) },
            retryRate: retriesMeasured > 0
                ? { retriedRuns: retried, measuredRuns: retriesMeasured, rate: rate(retried, retriesMeasured) }
                : { rate: null, known: false, reason: 'not_recorded', detail: UNKNOWN_REASONS.not_recorded },
            escalationRate: { escalations, terminalRuns: terminal.length, rate: rate(escalations, terminal.length) },
        },
        controlEffectiveness: {
            approvalViolations: { count: null, known: false, reason: 'not_instrumented', detail: 'Nothing in the fleet records an action taken against a withheld or denied approval, so a count of zero would be an assumption rather than a measurement.' },
            staleStateFailures: staleStateFailures != null
                ? { count: staleStateFailures, terminalRuns: terminal.length, rate: rate(staleStateFailures, terminal.length) }
                : { count: null, known: false, reason: 'not_recorded', detail: UNKNOWN_REASONS.not_recorded },
            auditTraceCompleteness: {
                mean: meanCompleteness,
                scoredRuns: completenessRatios.length,
                requiredFields: REQUIRED_FIELD_KEYS.length,
                // The two fields nothing in the fleet records, named so the
                // ceiling on this number is never mistaken for a per-run fault.
                uninstrumentedFields: RUN_TRACE_FIELDS.filter((f) => f.required && !f.instrumented).map((f) => f.key),
                missingByField,
            },
        },
        // Named, not computed: see the note above summarizeTraceQuality.
        operationalPerformance: {
            known: false,
            reason: 'reported_elsewhere',
            detail: 'Latency and cost per run are reported by the dispatch console usage roll-up (elapsedMs, usageRollup), which carries its own coverage; they are not recomputed here.',
        },
    };
}

module.exports = {
    RUN_TRACE_VERSION,
    RUN_TRACE_FIELDS,
    REQUIRED_FIELD_KEYS,
    UNKNOWN_REASONS,
    isTerminalOutcome,
    buildRunTrace,
    traceCompleteness,
    summarizeTraceQuality,
};
