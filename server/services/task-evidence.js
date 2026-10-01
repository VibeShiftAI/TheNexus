/**
 * Completion evidence dossier: one per-task answer to "what proves this
 * completion", gathered from the records that already exist.
 *
 * ── The four pieces and where each one lives ────────────────────────────────
 *   walkthrough   tasks.walkthrough (JSON {content, generatedAt, executor,
 *                 source}); its log is the executor dispatch run that wrote it
 *                 (task_dispatches row, kind 'dispatch', with log_path).
 *   verify        Praxis's run-events spine (~/.praxis-mind/cost_ledger.sqlite,
 *   code_review   table run_events), the `type = 'verification'` row that
 *                 finalizeTaskComplete appends once per finalization:
 *                 data.gates.declared / data.gates.missing / data.gates.detail
 *                 carry the executor's PRAXIS_QUALITY_GATES declaration. Its
 *                 log is the executor run that made the declaration.
 *   qa            The same verification row: data.qa.outcome / reviewer.
 *                 Only `pass` is a QA pass (see slate-qa-evidence.js for why
 *                 exempt/none/deferred are not). Its log is the reviewer's run,
 *                 a task_dispatches row under the shadow id `qa--<taskId>`.
 * All four join on the Nexus task id (run_events.task_id, task_dispatches
 * .task_id, and the `qa--` prefix for the reviewer's runs).
 *
 * ── Honesty rules ───────────────────────────────────────────────────────────
 *   1. A completed task is `verified` only when all four pieces are present
 *      AND the QA verdict is a pass. Anything else is `unverified`, and the
 *      response names every missing gate. There is no "probably fine".
 *   2. An unreadable spine is not an empty spine. The pieces it would have
 *      carried are reported absent WITH that reason, and the task stays
 *      unverified: the cockpit never paints green over evidence it could
 *      not read.
 *   3. A verification row written before the latest executor run started
 *      belongs to an earlier attempt and does not vouch for this completion.
 *   4. Fallback sources are labelled. Without a usable verification row the
 *      gates may still be read from the executor's own PRAXIS_QUALITY_GATES
 *      line, and the QA verdict from the reviewer's PRAXIS_QA_VERDICT line;
 *      each piece says which source it came from.
 *   5. Every piece is bound to the completion attempt under review: the
 *      newest executor run, and only when that run succeeded. A gate line
 *      from an older success, or a QA verdict from a reviewer run that
 *      started before this attempt, belongs to an earlier attempt and does
 *      not count.
 *   6. A piece is only `present` with both a timestamp and a log path. A
 *      record missing either is `incomplete`, names what it lacks, and
 *      counts as missing: evidence nobody can date or open is not evidence.
 *
 * Read-only: nothing here writes to the board, the spine, or a task status.
 * The builder is pure (callers pass in what they loaded) so the Jest suite can
 * drive every case from fixtures.
 */

/** The four pieces, in the order the cockpit lists them. */
const EVIDENCE_PIECES = [
    { key: 'walkthrough', label: 'Walkthrough' },
    { key: 'verify', label: 'Verify gate' },
    { key: 'code_review', label: 'Code-review gate' },
    { key: 'qa', label: 'QA verdict' },
];

const COMPLETE_STATUSES = new Set(['done', 'complete', 'completed']);

/** Shadow task id the QA reviewer's runs are recorded under. */
function qaTaskId(taskId) {
    return `qa--${taskId}`;
}

function isCompletedStatus(status) {
    return COMPLETE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function toTime(value) {
    if (typeof value !== 'string' || value === '') return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || value === '') return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_err) {
        return fallback;
    }
}

/** tasks.walkthrough is JSON in practice, but some historical rows are bare text. */
function parseWalkthrough(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    const parsed = parseJson(raw, null);
    if (parsed) return parsed;
    return { content: String(raw) };
}

function newestFirst(runs) {
    return [...(runs || [])].sort((a, b) => (toTime(b.started_at) ?? 0) - (toTime(a.started_at) ?? 0));
}

/** The reference a piece's log link is built from. */
function logRef(run, taskId) {
    if (!run) return null;
    return {
        dispatchId: run.id,
        taskId: run.task_id,
        executor: run.executor || null,
        path: run.log_path || null,
        startedAt: run.started_at || null,
        completedAt: run.completed_at || null,
        // Bounded tail of the transcript, served by routes/task-evidence.js.
        href: run.log_path
            ? `/api/task-evidence/${encodeURIComponent(taskId)}/log/${encodeURIComponent(run.id)}`
            : null,
    };
}

/**
 * Split a PRAXIS_QUALITY_GATES detail ("verify=...; code-review=...") into its
 * two clauses. The executor prose may itself contain semicolons, so a clause
 * runs from its own key to the next gate key rather than to the next ';'.
 */
function splitGateDetail(detail) {
    const out = { verify: null, code_review: null };
    if (typeof detail !== 'string' || detail.trim() === '') return out;
    const re = /(^|[;\s])(verify|code-review)\s*=/gi;
    const marks = [];
    let m;
    while ((m = re.exec(detail)) !== null) {
        marks.push({ key: m[2].toLowerCase(), valueStart: m.index + m[0].length, keyStart: m.index + m[1].length });
    }
    marks.forEach((mark, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].keyStart : detail.length;
        const value = detail.slice(mark.valueStart, end).trim().replace(/[;\s]+$/, '').trim();
        const key = mark.key === 'verify' ? 'verify' : 'code_review';
        if (value && out[key] == null) out[key] = value;
    });
    return out;
}

/** The executor's own `PRAXIS_QUALITY_GATES:` line, read from its run output. */
function parseQualityGatesLine(output) {
    if (typeof output !== 'string') return null;
    const match = output.match(/^[ \t>*_`]*PRAXIS_QUALITY_GATES:\s*(.+)$/m);
    if (!match) return null;
    const detail = match[1].trim();
    const clauses = splitGateDetail(detail);
    return { detail, ...clauses };
}

/** The reviewer's `PRAXIS_QA_VERDICT:` line, read from its run output. */
function parseQaVerdictLine(output) {
    if (typeof output !== 'string') return null;
    const match = output.match(/^[ \t>*_`]*PRAXIS_QA_VERDICT:\s*([a-z_-]+)/im);
    return match ? match[1].toLowerCase() : null;
}

/** Why a QA outcome other than `pass` does not count as a verdict that passed. */
const QA_OUTCOME_REASONS = {
    exempt: 'QA was waived (exempt): no independent reviewer passed this completion.',
    none: 'No independent QA audit ran for this completion.',
    deferred: 'The QA audit is still owed (deferred); the completion is not verified until it runs.',
};

function piece(key, fields) {
    const def = EVIDENCE_PIECES.find((p) => p.key === key);
    return {
        key,
        label: def ? def.label : key,
        status: 'absent',
        at: null,
        source: null,
        detail: null,
        reason: null,
        log: null,
        ...fields,
    };
}

/**
 * A present piece needs a timestamp and a log path to count. Without either
 * it becomes `incomplete`, naming what is missing, and counts as missing.
 */
function requireMetadata(p) {
    if (p.status !== 'present') return p;
    const gaps = [];
    if (!p.at || toTime(p.at) == null) gaps.push('timestamp');
    if (!p.log || !p.log.path) gaps.push('log reference');
    if (gaps.length === 0) return p;
    return {
        ...p,
        status: 'incomplete',
        metadataMissing: gaps,
        reason: `Recorded, but its ${gaps.join(' and ')} ${gaps.length > 1 ? 'are' : 'is'} missing, so it cannot count as evidence for this completion.`,
    };
}

/**
 * Build the dossier.
 *
 * @param {object} input
 * @param {object} input.task        { id, status, walkthrough, updated_at }
 * @param {Array}  input.runs        task_dispatches rows for task.id
 * @param {Array}  input.qaRuns      task_dispatches rows for qa--<task.id>
 * @param {object} input.spine       { available, reason?, path?, record?, firstVerificationAt? }
 *                                   record = newest verification row { seq, ts, phase, data }
 */
function buildEvidenceDossier({ task, runs = [], qaRuns = [], spine = { available: false } }) {
    const taskId = task.id;
    const completed = isCompletedStatus(task.status);
    const runsDesc = newestFirst(runs);
    const executorRuns = runsDesc.filter((r) => (r.kind || 'dispatch') === 'dispatch');
    const qaRunsDesc = newestFirst(qaRuns);
    const latestExecutorRun = executorRuns[0] || null;
    // The completion attempt under review. A completion whose newest run did
    // not succeed has no executor attempt to bind fallback evidence to.
    const attemptRun = latestExecutorRun && latestExecutorRun.outcome === 'success' ? latestExecutorRun : null;
    const attemptStart = latestExecutorRun ? toTime(latestExecutorRun.started_at) : null;
    /** A reviewer run counts for this attempt only if it started at or after it. */
    function qaRunInAttempt(r) {
        const s = toTime(r.started_at);
        return s != null && attemptStart != null && s >= attemptStart;
    }

    // ── The verification row, if it vouches for THIS completion ──────────
    const record = spine && spine.available ? spine.record || null : null;
    const recordData = record ? parseJson(record.data, {}) : {};
    const recordTime = record ? toTime(record.ts) : null;
    const latestStart = latestExecutorRun ? toTime(latestExecutorRun.started_at) : null;
    const recordStale = Boolean(record && recordTime != null && latestStart != null && recordTime < latestStart);
    const usableRecord = record && !recordStale ? record : null;
    // The executor run that made the declaration the record carries: the
    // newest executor run that started before the record was written.
    const recordRun = usableRecord
        ? executorRuns.find((r) => {
            const s = toTime(r.started_at);
            return s != null && recordTime != null && s <= recordTime;
        }) || null
        : null;
    const recordQaRun = usableRecord
        ? qaRunsDesc.find((r) => {
            const s = toTime(r.started_at);
            return s != null && recordTime != null && s <= recordTime
                && (attemptStart == null || s >= attemptStart);
        }) || null
        : null;
    const spineRef = usableRecord
        ? { source: 'praxis-run-events', seq: usableRecord.seq ?? null, ts: usableRecord.ts, path: spine.path || null }
        : null;

    /** Why the spine could not answer, for pieces that depend on it. */
    function spineGapReason() {
        if (!spine || !spine.available) {
            return `Praxis's run-events spine could not be read (${(spine && spine.reason) || 'unavailable'}), so this gate is unseen rather than proven absent.`;
        }
        if (recordStale) {
            return `The newest verification record (${record.ts}) predates the latest executor run (${latestExecutorRun.started_at}), so it vouches for an earlier attempt, not this completion.`;
        }
        return 'No verification record exists for this task in Praxis\'s run-events spine.';
    }

    // ── Walkthrough ───────────────────────────────────────────────────────
    const wt = parseWalkthrough(task.walkthrough);
    const wtContent = wt && typeof wt.content === 'string' ? wt.content : '';
    const walkthroughRun = attemptRun;
    const walkthrough = wtContent.trim()
        ? piece('walkthrough', {
            status: 'present',
            at: (typeof wt.generatedAt === 'string' && wt.generatedAt) || walkthroughRun?.completed_at || null,
            source: 'nexus-task',
            detail: `${wtContent.trim().length} characters${wt.executor ? ` · by ${wt.executor}` : ''}`,
            log: logRef(walkthroughRun, taskId),
        })
        : piece('walkthrough', {
            reason: 'No walkthrough is stored on the task.',
            log: logRef(walkthroughRun, taskId),
        });

    // ── Verify + code-review gates ────────────────────────────────────────
    let gateSource = null;
    let gateClauses = { verify: null, code_review: null };
    let gateDeclared = new Set();
    let gateAt = null;
    let gateRun = null;
    if (usableRecord && recordData.gates && typeof recordData.gates === 'object') {
        const declared = Array.isArray(recordData.gates.declared) ? recordData.gates.declared : [];
        const missing = new Set(Array.isArray(recordData.gates.missing) ? recordData.gates.missing : []);
        gateDeclared = new Set(declared.filter((g) => !missing.has(g)).map((g) => (g === 'code-review' ? 'code_review' : g)));
        gateClauses = splitGateDetail(recordData.gates.detail);
        gateSource = 'praxis-verification';
        gateAt = usableRecord.ts;
        gateRun = recordRun;
    } else if (attemptRun) {
        // Fallback: the executor's own declaration, read only from the
        // attempt under review, never from an older success.
        const parsed = parseQualityGatesLine(attemptRun.output);
        if (parsed) {
            gateClauses = { verify: parsed.verify, code_review: parsed.code_review };
            gateDeclared = new Set(['verify', 'code_review'].filter((k) => parsed[k]));
            gateSource = 'executor-report';
            gateAt = attemptRun.completed_at || null;
            gateRun = attemptRun;
        }
    }
    const noAttemptReason = latestExecutorRun
        ? ` The newest executor run ended "${latestExecutorRun.outcome}", so there is no successful completion attempt to read evidence from; an older attempt's evidence does not count.`
        : ' No executor run is recorded for this task.';
    function gatePiece(key, label) {
        if (gateDeclared.has(key)) {
            return piece(key, {
                status: 'present',
                at: gateAt,
                source: gateSource,
                detail: gateClauses[key] || `${label} declared`,
                log: logRef(gateRun, taskId),
                ref: gateSource === 'praxis-verification' ? spineRef : null,
            });
        }
        const reason = gateSource
            ? `The executor's quality-gate declaration does not include a ${label.toLowerCase()} pass.`
            : spineGapReason() + (attemptRun
                ? ' The completion attempt under review did not report a PRAXIS_QUALITY_GATES line either.'
                : noAttemptReason);
        return piece(key, {
            reason,
            source: gateSource,
            log: logRef(gateRun || latestExecutorRun, taskId),
            ref: gateSource === 'praxis-verification' ? spineRef : null,
        });
    }
    const verify = gatePiece('verify', 'Verify');
    const codeReview = gatePiece('code_review', 'Code-review');

    // ── QA verdict ────────────────────────────────────────────────────────
    let qa;
    const recordQa = usableRecord && recordData.qa && typeof recordData.qa === 'object' ? recordData.qa : null;
    if (recordQa && typeof recordQa.outcome === 'string') {
        const outcome = recordQa.outcome;
        const reviewer = typeof recordQa.reviewer === 'string' ? recordQa.reviewer : null;
        qa = outcome === 'pass'
            ? piece('qa', {
                status: 'present',
                verdict: 'pass',
                reviewer,
                at: usableRecord.ts,
                source: 'praxis-verification',
                detail: recordQa.detail || `QA passed${reviewer ? ` (${reviewer})` : ''}`,
                log: logRef(recordQaRun, taskId),
                ref: spineRef,
            })
            : piece('qa', {
                status: 'absent',
                verdict: outcome,
                reviewer,
                at: usableRecord.ts,
                source: 'praxis-verification',
                detail: recordQa.detail || null,
                reason: QA_OUTCOME_REASONS[outcome] || `QA outcome "${outcome}" is not a pass.`,
                log: logRef(recordQaRun, taskId),
                ref: spineRef,
            });
    } else {
        // Fallback: the reviewer's own verdict line on its newest run, among
        // reviewer runs that started at or after the attempt under review.
        const attemptQaRuns = attemptRun ? qaRunsDesc.filter(qaRunInAttempt) : [];
        const qaRun = attemptQaRuns.find((r) => parseQaVerdictLine(r.output)) || null;
        const verdict = qaRun ? parseQaVerdictLine(qaRun.output) : null;
        if (verdict === 'pass') {
            qa = piece('qa', {
                status: 'present',
                verdict: 'pass',
                reviewer: qaRun.executor || null,
                at: qaRun.completed_at || null,
                source: 'qa-run',
                detail: `PRAXIS_QA_VERDICT: pass (${qaRun.executor || 'reviewer'})`,
                log: logRef(qaRun, taskId),
            });
        } else if (verdict) {
            qa = piece('qa', {
                status: 'failed',
                verdict,
                reviewer: qaRun.executor || null,
                at: qaRun.completed_at || null,
                source: 'qa-run',
                detail: `PRAXIS_QA_VERDICT: ${verdict} (${qaRun.executor || 'reviewer'})`,
                reason: `The newest QA verdict is "${verdict}", not a pass.`,
                log: logRef(qaRun, taskId),
            });
        } else {
            let why;
            if (!attemptRun) why = noAttemptReason;
            else if (attemptQaRuns.length) why = ' The reviewer runs for this attempt carry no PRAXIS_QA_VERDICT line.';
            else if (qaRunsDesc.length) why = ' Every reviewer run on record started before the completion attempt under review, so its verdict belongs to an earlier attempt.';
            else why = ' No QA reviewer run is recorded for this task.';
            qa = piece('qa', {
                reason: spineGapReason() + why,
                log: logRef(attemptQaRuns[0] || null, taskId),
            });
        }
    }

    const pieces = [walkthrough, verify, codeReview, qa].map(requireMetadata);
    const missing = pieces.filter((p) => p.status !== 'present').map((p) => p.key);

    let state;
    if (!completed) state = 'not_completed';
    else state = missing.length === 0 ? 'verified' : 'unverified';

    // A completion older than the spine's first verification record could not
    // have been recorded by it. Flagged for the reader; never turns green.
    const completedAt = latestExecutorRun?.completed_at || task.updated_at || null;
    const firstCapture = spine && spine.available ? spine.firstVerificationAt || null : null;
    const predatesEvidenceCapture = state === 'unverified' && !usableRecord && firstCapture && completedAt
        ? (toTime(completedAt) ?? Infinity) < (toTime(firstCapture) ?? -Infinity)
        : false;

    const absentLabels = pieces.filter((p) => p.status !== 'present' && p.status !== 'incomplete').map((p) => p.label);
    const incompleteLabels = pieces.filter((p) => p.status === 'incomplete').map((p) => p.label);
    let summary;
    if (state === 'verified') summary = 'Verified: walkthrough, verify gate, code-review gate and QA pass all on record.';
    else if (state === 'unverified') {
        const parts = [];
        if (absentLabels.length) parts.push(`missing ${absentLabels.join(', ')}`);
        if (incompleteLabels.length) parts.push(`no timestamp or log for ${incompleteLabels.join(', ')}`);
        summary = `Unverified: ${parts.join('; ')}.`;
    }
    else summary = `Not completed (status "${task.status || 'unknown'}"); evidence is gathered as it lands.`;

    return {
        taskId,
        taskStatus: task.status || null,
        completed,
        state,
        missing,
        summary,
        predatesEvidenceCapture,
        pieces,
        // Praxis's own grade of the evidence behind the pass. Informational:
        // it never manufactures or withdraws a piece.
        verification: usableRecord
            ? { ts: usableRecord.ts, seq: usableRecord.seq ?? null, verdict: recordData.verdict || usableRecord.phase || null }
            : null,
        sources: {
            spine: {
                available: Boolean(spine && spine.available),
                reason: spine && !spine.available ? spine.reason || null : null,
                path: (spine && spine.path) || null,
                staleRecord: recordStale ? { ts: record.ts, seq: record.seq ?? null } : null,
            },
        },
    };
}

/** The compact form the board badge needs. */
function summarizeDossier(dossier) {
    return {
        taskId: dossier.taskId,
        state: dossier.state,
        missing: dossier.missing,
        summary: dossier.summary,
        predatesEvidenceCapture: dossier.predatesEvidenceCapture,
    };
}

module.exports = {
    EVIDENCE_PIECES,
    buildEvidenceDossier,
    summarizeDossier,
    isCompletedStatus,
    qaTaskId,
    splitGateDetail,
    parseQualityGatesLine,
    parseQaVerdictLine,
};
