/**
 * Transaction lifecycle for MCP write tools. Domain-specific validation stays
 * in the existing APIs; this layer captures and verifies state around them.
 */
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { appendTransition } = require('./transition-log');

class TransactionError extends Error {
  constructor(message, { transactionId, verdict, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TransactionError';
    this.transactionId = transactionId;
    this.verdict = verdict;
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

module.exports = {
  TransactionError,
  compareFields,
  executeTransaction,
};
