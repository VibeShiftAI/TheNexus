/**
 * Transaction lifecycle for MCP write tools. Domain-specific validation stays
 * in the existing APIs; this layer captures and verifies state around them.
 */
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { appendTransition } = require('./transition-log');

class TransactionError extends Error {
  constructor(message, { transactionId, verdict, cause, mismatches, current } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TransactionError';
    this.transactionId = transactionId;
    this.verdict = verdict;
    // Populated for `stale_precondition` so an optimistic-lock retry can decide
    // whether the conflict is refreshable without re-reading the row itself.
    if (mismatches) this.mismatches = mismatches;
    if (current !== undefined) this.current = current;
  }
}

function compareFields(actual, expected) {
  const mismatches = [];
  for (const [field, expectedValue] of Object.entries(expected || {})) {
    const actualValue = actual?.[field];
    if (!isDeepStrictEqual(actualValue, expectedValue)) {
      mismatches.push({ field, expected: expectedValue, actual: actualValue });
    }
  }
  return mismatches;
}

function mismatchMessage(prefix, mismatches) {
  const details = mismatches.map(({ field, expected, actual }) => (
    `expected ${field}=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`
  )).join('; ');
  return `${prefix}: ${details}`;
}

function callerImage(caller) {
  return {
    identity: caller?.identity || 'unknown',
    ...(caller?.namespace ? { namespace: caller.namespace } : {}),
  };
}

async function executeTransaction({
  tool,
  caller,
  target,
  intent,
  captureBefore,
  validatePreconditions = () => [],
  apply,
  readAfter,
  verify,
  logPath,
}) {
  const transactionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let before;
  let after;
  let applyResult;

  const finish = (verdict, extra = {}) => {
    const record = {
      schema_version: 1,
      transaction_id: transactionId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      tool,
      caller: callerImage(caller),
      target,
      intent,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
      verdict,
      ...extra,
    };
    appendTransition(record, logPath);
    return record;
  };

  try {
    before = await captureBefore();
  } catch (error) {
    finish('capture_failed', { error: error.message });
    throw new TransactionError(`Before-image capture failed: ${error.message}`, {
      transactionId, verdict: 'capture_failed', cause: error,
    });
  }

  let preconditionMismatches;
  try {
    preconditionMismatches = await validatePreconditions({ before, target, intent });
  } catch (error) {
    finish('precondition_check_failed', { error: error.message });
    throw new TransactionError(`Precondition check failed: ${error.message}`, {
      transactionId, verdict: 'precondition_check_failed', cause: error,
    });
  }
  if (preconditionMismatches?.length) {
    after = before;
    finish('stale_precondition', { precondition_mismatches: preconditionMismatches });
    throw new TransactionError(mismatchMessage('Stale expected state', preconditionMismatches), {
      transactionId, verdict: 'stale_precondition',
      mismatches: preconditionMismatches, current: before,
    });
  }

  try {
    applyResult = await apply({ before, target, intent });
  } catch (error) {
    try {
      after = await readAfter({ before, target, intent, applyResult: undefined });
    } catch (_) {
      after = null;
    }
    finish('apply_failed', { error: error.message });
    throw new TransactionError(`Write apply failed: ${error.message}`, {
      transactionId, verdict: 'apply_failed', cause: error,
    });
  }

  try {
    after = await readAfter({ before, target, intent, applyResult });
  } catch (error) {
    finish('verification_failed', { error: `Read-back failed: ${error.message}` });
    throw new TransactionError(`Postcondition read-back failed: ${error.message}`, {
      transactionId, verdict: 'verification_failed', cause: error,
    });
  }

  let verification;
  try {
    verification = await verify({ before, after, target, intent, applyResult });
  } catch (error) {
    finish('verification_failed', { error: error.message });
    throw new TransactionError(`Postcondition verification failed: ${error.message}`, {
      transactionId, verdict: 'verification_failed', cause: error,
    });
  }
  if (verification === false || verification?.ok === false) {
    const mismatches = verification?.mismatches || [];
    finish('postcondition_mismatch', { postcondition_mismatches: mismatches });
    throw new TransactionError(mismatchMessage('Postcondition mismatch', mismatches), {
      transactionId, verdict: 'postcondition_mismatch',
    });
  }

  finish('committed');
  return {
    transactionId,
    verdict: 'committed',
    before,
    after,
    result: applyResult,
  };
}

// ───────────────── optimistic-lock retry ─────────────────

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 40;

// Fields whose drift is pure freshness, not meaning: a bumped row timestamp
// says "somebody wrote", never "your intent is void". Everything else the
// caller asserted (status, …) stays a hard guard and is NEVER auto-refreshed.
const DEFAULT_REFRESHABLE_FIELDS = ['updated_at'];

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Wraps {@link executeTransaction} in a bounded compare-and-set retry loop.
 *
 * The failure this exists for: a caller reads a task, thinks, then writes with
 * `expected_updated_at` from its own read. Any unrelated writer in that window
 * bumps `updated_at` and the write dies with "Stale expected state" even though
 * nothing about the caller's intent became wrong. Unattended lifecycle flows
 * then strand the task mid-status.
 *
 * The loop only ever resolves conflicts it can resolve honestly:
 *
 * - **refreshable drift** — every mismatched field is in `refreshableFields`
 *   (timestamps). Re-anchor the expectation to the row we just read and retry.
 * - **already converged** — the fresh row already satisfies the whole patch, so
 *   a concurrent writer did our work. Return a no-op success instead of an
 *   error; applying it again would be a write for no reason.
 * - **anything else** — a semantic guard the caller set (`expected_status`) no
 *   longer holds. NOT retried, NOT relaxed: rethrown with the lock trace
 *   attached, because the caller's premise really is void.
 *
 * @param {object} spec              passed through to executeTransaction
 * @param {object}   [options]
 * @param {number}   [options.maxAttempts]        total attempts, including the first
 * @param {number}   [options.baseDelayMs]        linear backoff step between attempts
 * @param {string[]} [options.refreshableFields]  mismatches safe to re-anchor
 * @param {Function} [options.refreshExpected]    (expected, current) => next expected
 * @param {Function} [options.isSatisfied]        (current) => patch already applied?
 * @param {Function} [options.delay]              injectable sleep (tests)
 * @returns {Promise<object>} the transaction result plus a `lock` trace
 */
async function executeOptimisticTransaction(spec, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  refreshableFields = DEFAULT_REFRESHABLE_FIELDS,
  refreshExpected = defaultRefreshExpected,
  isSatisfied = () => false,
  delay = wait,
} = {}) {
  const attemptCap = Math.max(1, maxAttempts);
  const conflicts = [];
  let expected = { ...(spec.intent?.expected || {}) };
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const intent = { ...spec.intent, expected };
    try {
      const tx = await executeTransaction({ ...spec, intent });
      return {
        ...tx,
        lock: {
          attempts,
          outcome: attempts === 1 ? 'committed' : 'committed_after_retry',
          conflicts,
        },
      };
    } catch (error) {
      if (error.verdict !== 'stale_precondition') throw error;

      const mismatches = error.mismatches || [];
      const current = error.current;
      conflicts.push({ attempt: attempts, fields: mismatches.map((m) => m.field) });

      // A semantic guard (e.g. expected_status) is never waived by convergence:
      // the caller's premise is gone regardless of what the row now contains.
      // Only refreshable (freshness) mismatches are eligible to converge.
      const blocking = mismatches.filter((m) => !refreshableFields.includes(m.field));

      // A concurrent writer already produced the state we were asking for —
      // but only once every guard that matters (the blocking ones) still holds.
      if (blocking.length === 0 && safeIsSatisfied(isSatisfied, current)) {
        return convergedNoop({ spec, intent, current, attempts, conflicts, mismatches });
      }

      if (blocking.length || attempts >= attemptCap) {
        error.lock = {
          attempts,
          outcome: blocking.length ? 'conflict_unresolved' : 'retries_exhausted',
          conflicts,
          blocking_fields: blocking.map((m) => m.field),
        };
        throw error;
      }

      expected = refreshExpected(expected, current);
      if (baseDelayMs > 0) await delay(baseDelayMs * attempts);
    }
  }
}

/** Re-anchor every expectation we still hold to the row we just read. */
function defaultRefreshExpected(expected, current) {
  const next = {};
  for (const field of Object.keys(expected || {})) {
    next[field] = current?.[field];
  }
  return next;
}

function safeIsSatisfied(isSatisfied, current) {
  if (current === undefined || current === null) return false;
  try {
    return isSatisfied(current) === true;
  } catch (_) {
    return false;
  }
}

/**
 * Record and return a no-op commit. Auditable exactly like a real one — the
 * transition log gets a `converged_noop` verdict carrying the mismatches that
 * were waived, so "why did this succeed against its own guard?" is answerable.
 */
function convergedNoop({ spec, intent, current, attempts, conflicts, mismatches }) {
  const transactionId = crypto.randomUUID();
  const now = new Date().toISOString();
  appendTransition({
    schema_version: 1,
    transaction_id: transactionId,
    started_at: now,
    completed_at: now,
    tool: spec.tool,
    caller: callerImage(spec.caller),
    target: spec.target,
    intent,
    before: current,
    after: current,
    verdict: 'converged_noop',
    precondition_mismatches: mismatches,
  }, spec.logPath);
  return {
    transactionId,
    verdict: 'converged_noop',
    before: current,
    after: current,
    result: { success: true, applied: false, reason: 'already in the requested state' },
    lock: { attempts, outcome: 'converged_noop', conflicts },
  };
}

module.exports = {
  TransactionError,
  compareFields,
  executeTransaction,
  executeOptimisticTransaction,
};
