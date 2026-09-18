/**
 * QA evidence for slate slots: Praxis's verification ledger, read read-only.
 *
 * ── Why this is a SEPARATE source from the slot ─────────────────────────────
 * The schedule file cannot answer "did this pass QA". Its `provenance` stamp
 * is DISPATCH evidence by its own definition (executors/dispatch-provenance.ts:
 * "How a slot reached its terminal state"), and Praxis's terminal
 * reconciliation flips a slot to `completed` when the BOARD says the task is
 * done while leaving whatever stamp was already there untouched
 * (scheduler/terminal-reconciliation.ts: `candidate.status = target` with no
 * write to `candidate.provenance`). So a slot suspended at a usage limit, or
 * one that failed to dispatch, or one carrying an older correlated
 * advance-callback stamp, becomes `completed` with its old attempt evidence
 * intact the moment somebody finishes the task by hand. Reading that as a QA
 * pass is the 2026-09-18 QA finding.
 *
 * The affirmative record lives elsewhere. `finalizeTaskComplete`
 * (orchestrator/qa-dispatch.ts) calls `recordCompletionVerification`
 * (orchestrator/verification-protocol.ts), which appends ONE verdict per
 * finalization to the run-events spine as `type: "verification"`. That row is
 * the only thing in the system that says a completion went through the QA
 * gate, and nothing in the reconciliation path writes one.
 *
 * ── What the row carries ────────────────────────────────────────────────────
 *   data.qa.outcome  "pass" | "exempt" | "none" | "deferred"  ← the audit leg
 *   data.verdict     "verified" | "uncertain" | "partial" | "unverified"
 *   data.qa.reviewer / data.qa.author  (the invariant: reviewer !== author)
 *
 * Only `pass` is a QA pass. `exempt` is a waived audit, `none` is no audit at
 * all, and `deferred` is one still owed (verification-protocol.ts: it "grades
 * exactly like none — the completion is NOT verified"). The overall `verdict`
 * is Praxis's grade of the EVIDENCE behind that pass, carried through so the
 * cockpit can show it, never used to manufacture or withdraw a pass.
 *
 * Same spine, same resolution and the same read-only handle as
 * routes/dispatch-insight.js, which already reads these rows for the task
 * screen. Nothing here writes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openRaw } = require('../../db/raw');

/** Praxis's run-lifecycle spine. Filename is historical; it holds no cost column. */
const DEFAULT_SPINE_PATH = process.env.PRAXIS_EXECUTION_LOG_DB
    || path.join(os.homedir(), '.praxis-mind', 'cost_ledger.sqlite');

/** The one audit outcome that means a reviewer passed the work. */
const QA_PASS_OUTCOME = 'pass';

/** Sanity bound on one slate's worth of task ids, so the IN list stays small. */
const MAX_TASK_IDS = 200;

function parseJson(value, fallback) {
    if (typeof value !== 'string') return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_err) {
        return fallback;
    }
}

/**
 * The verdict rows for these tasks, newest per task.
 *
 * `since` is the slate's own start (its `createdAt`): a verdict recorded
 * BEFORE the slate was written belongs to an earlier run of the same task and
 * says nothing about this slate's completion. Without that floor a task
 * QA-passed last week would launder today's manual completion into a pass.
 *
 * Fail-soft in the same shape as every other reader of this file: a missing,
 * locked or malformed spine answers `available: false` with a reason, and the
 * caller reports QA as unknown. It never answers "no passes" from a file it
 * could not read.
 */
function readQaEvidence({
    taskIds = [],
    since = null,
    file = DEFAULT_SPINE_PATH,
    openDb = (dbPath) => openRaw(dbPath, { readonly: true, fileMustExist: true }),
    existsSync = fs.existsSync,
} = {}) {
    const ids = [...new Set(taskIds.filter((id) => typeof id === 'string' && id !== ''))].slice(0, MAX_TASK_IDS);
    const empty = { available: true, source: file, records: new Map() };
    if (ids.length === 0) return empty;

    let db;
    try {
        if (!existsSync(file)) {
            return { available: false, reason: 'Praxis verification ledger not found', source: file, records: new Map() };
        }
        db = openDb(file);
    } catch (err) {
        return { available: false, reason: err.message, source: file, records: new Map() };
    }

    try {
        const placeholders = ids.map(() => '?').join(',');
        const params = [...ids];
        let sql = `SELECT task_id, ts, phase, data FROM run_events
                   WHERE type = 'verification' AND task_id IN (${placeholders})`;
        if (typeof since === 'string' && since !== '') {
            sql += ' AND ts >= ?';
            params.push(since);
        }
        // seq is the append order, so the last row wins per task.
        sql += ' ORDER BY seq ASC';
        const records = new Map();
        for (const row of db.prepare(sql).all(...params)) {
            const data = parseJson(row.data, {});
            const qa = data.qa && typeof data.qa === 'object' ? data.qa : {};
            const outcome = typeof qa.outcome === 'string' ? qa.outcome : null;
            records.set(row.task_id, {
                // A pass, and only a pass. Everything else is an audit that did
                // not happen, was waived, or is still owed.
                passed: outcome === QA_PASS_OUTCOME,
                outcome,
                verdict: typeof data.verdict === 'string' ? data.verdict : (row.phase || null),
                reviewer: typeof qa.reviewer === 'string' ? qa.reviewer : null,
                author: typeof qa.author === 'string' ? qa.author : null,
                at: typeof row.ts === 'string' ? row.ts : null,
            });
        }
        return { available: true, source: file, records };
    } catch (err) {
        return { available: false, reason: err.message, source: file, records: new Map() };
    }
}

/** What `buildSlateLifecycle` assumes when no evidence source was supplied. */
function noQaEvidence(reason = 'No QA evidence source supplied') {
    return { available: false, reason, records: new Map() };
}

module.exports = { DEFAULT_SPINE_PATH, QA_PASS_OUTCOME, readQaEvidence, noQaEvidence };
