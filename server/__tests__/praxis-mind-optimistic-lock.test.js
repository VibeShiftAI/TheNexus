const fs = require('fs');
const os = require('os');
const path = require('path');

function serverHarness() {
  const handlers = {};
  const schemas = {};
  return {
    handlers,
    schemas,
    server: {
      tool(name, _description, schema, handler) {
        handlers[name] = handler;
        schemas[name] = schema;
      },
    },
  };
}

const caller = {
  identity: 'jest-agent',
  namespace: 'coding-agents-jest',
  privileges: ['nexus.task_update'],
};

describe('optimistic-lock retry', () => {
  let tempDir;
  let logPath;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-lock-'));
    logPath = path.join(tempDir, 'transitions.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('a writer between capture and PATCH cannot overwrite cancellation', async () => {
    let row = { id: 'task-1', status: 'todo', version: 4, description: 'base' };
    const backends = {
      nexusTaskById: jest.fn(async () => ({ ...row })),
      nexusTaskUpdate: jest.fn(async (_id, patch) => {
        row = { ...row, status: 'cancelled', description: 'base\nconcurrent note', version: 5 };
        if (patch.expected_version !== row.version) {
          const err = new Error('Task changed since it was read');
          err.status = 409;
          err.body = { code: 'task_version_conflict' };
          throw err;
        }
        row = { ...row, ...patch };
        return { success: true };
      }),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
    const { handlers, server } = serverHarness();
    register(server, { caller });
    const result = await handlers.nexus_task_update({ task_id: 'task-1', status: 'completed', expected_status: 'todo' });
    expect(backends.nexusTaskUpdate.mock.calls[0][1].expected_version).toBe(4);
    expect(result.isError).toBe(true);
    expect(row.status).toBe('cancelled');
    expect(row.description).toBe('base\nconcurrent note');
  });

  test('a CAS conflict re-reads description before retrying an appended note', async () => {
    let row = { id: 'task-1', status: 'todo', version: 1, description: 'base' };
    let writes = 0;
    const backends = {
      nexusTaskById: jest.fn(async () => ({ ...row })),
      nexusTaskUpdate: jest.fn(async (_id, patch) => {
        if (++writes === 1) row = { ...row, version: 2, description: 'base\nother writer' };
        if (patch.expected_version !== row.version) {
          const err = new Error('Conflict');
          err.status = 409;
          err.body = { code: 'task_version_conflict' };
          throw err;
        }
        const { expected_version, ...fields } = patch;
        row = { ...row, ...fields, version: row.version + 1 };
        return { success: true, task: row };
      }),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { updateTask } = require('../../services/praxis-mind-mcp/lib/board-ops');
    const result = await updateTask({ caller }, { task_id: 'task-1', patch: { status: 'todo' }, appendNote: 'my note', expected: { status: 'todo' } });
    expect(result.value.tx.lock.outcome).toBe('committed_after_retry');
    expect(row.description).toMatch(/base\nother writer/);
    expect(row.description).toContain('my note');
    expect(row.version).toBe(3);
    expect(writes).toBe(2);
  });

  /** A row an unrelated writer bumps on every single read. */
  function driftingRow() {
    let reads = 0;
    return async () => ({ id: 'task-1', status: 'todo', updated_at: `t${reads++}` });
  }

  test('re-anchors a timestamp-only conflict and commits on the retry', async () => {
    const { executeOptimisticTransaction, compareFields } = require('../../services/praxis-mind-mcp/lib/transactions');
    const { readTransitions } = require('../../services/praxis-mind-mcp/lib/transition-log');
    // First read shows t1 (the caller's t0 is already stale); after that it settles.
    const reads = ['t1', 't1'];
    let index = 0;
    let state = { id: 'task-1', status: 'todo', updated_at: 't0' };
    const apply = jest.fn(async () => {
      state = { ...state, status: 'completed' };
      return { success: true };
    });

    const result = await executeOptimisticTransaction({
      tool: 'nexus_task_update',
      caller,
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' }, expected: { updated_at: 't0' } },
      captureBefore: async () => ({ ...state, updated_at: reads[Math.min(index++, reads.length - 1)] }),
      validatePreconditions: ({ before, intent }) => compareFields(before, intent.expected),
      apply,
      readAfter: async () => ({ ...state }),
      verify: ({ after }) => ({ ok: after.status === 'completed' }),
      logPath,
    }, { baseDelayMs: 0, isSatisfied: (current) => current.status === 'completed' });

    expect(result.verdict).toBe('committed');
    expect(result.lock).toMatchObject({
      attempts: 2,
      outcome: 'committed_after_retry',
      conflicts: [{ attempt: 1, fields: ['updated_at'] }],
    });
    expect(apply).toHaveBeenCalledTimes(1);
    // Both the rejected attempt and the commit are on the audit trail.
    expect(readTransitions(logPath).map((r) => r.verdict))
      .toEqual(['stale_precondition', 'committed']);
  });

  test('never retries past a semantic guard — expected_status mismatch fails hard', async () => {
    const { executeOptimisticTransaction, compareFields } = require('../../services/praxis-mind-mcp/lib/transactions');
    const apply = jest.fn();

    await expect(executeOptimisticTransaction({
      tool: 'nexus_task_update',
      caller,
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' }, expected: { status: 'todo', updated_at: 't0' } },
      captureBefore: async () => ({ id: 'task-1', status: 'cancelled', updated_at: 't9' }),
      validatePreconditions: ({ before, intent }) => compareFields(before, intent.expected),
      apply,
      readAfter: async () => null,
      verify: () => ({ ok: true }),
      logPath,
    }, { baseDelayMs: 0 })).rejects.toMatchObject({
      verdict: 'stale_precondition',
      lock: { attempts: 1, outcome: 'conflict_unresolved', blocking_fields: ['status'] },
    });

    expect(apply).not.toHaveBeenCalled();
  });

  test('converges to a no-op when a concurrent writer already applied the patch', async () => {
    const { executeOptimisticTransaction, compareFields } = require('../../services/praxis-mind-mcp/lib/transactions');
    const { readTransitions } = require('../../services/praxis-mind-mcp/lib/transition-log');
    const apply = jest.fn();

    const result = await executeOptimisticTransaction({
      tool: 'nexus_task_update',
      caller,
      target: { task_id: 'task-1' },
      // Only a refreshable (freshness) guard is set — no semantic guard to waive.
      intent: { patch: { status: 'completed' }, expected: { updated_at: 't0' } },
      // Somebody else completed it. Our freshness guard is stale, but our goal is met.
      captureBefore: async () => ({ id: 'task-1', status: 'completed', updated_at: 't5' }),
      validatePreconditions: ({ before, intent }) => compareFields(before, intent.expected),
      apply,
      readAfter: async () => null,
      verify: () => ({ ok: true }),
      logPath,
    }, { baseDelayMs: 0, isSatisfied: (current) => current.status === 'completed' });

    expect(result.verdict).toBe('converged_noop');
    expect(result.result).toMatchObject({ success: true, applied: false });
    expect(result.lock.outcome).toBe('converged_noop');
    expect(apply).not.toHaveBeenCalled();
    const noop = readTransitions(logPath).find((r) => r.verdict === 'converged_noop');
    expect(noop).toMatchObject({
      tool: 'nexus_task_update',
      caller: { identity: 'jest-agent' },
      precondition_mismatches: [{ field: 'updated_at', expected: 't0', actual: 't5' }],
    });
  });

  test('a blocking (non-refreshable) mismatch is never waived by convergence', async () => {
    // QA regression (2026-09-01, attempt 1): isSatisfied used to be checked
    // BEFORE the blocking-field filter, so a semantic guard mismatch could be
    // silently converged away whenever the row happened to already match the
    // patch. The blocking check must run first and win regardless.
    const { executeOptimisticTransaction, compareFields } = require('../../services/praxis-mind-mcp/lib/transactions');
    const apply = jest.fn();

    await expect(executeOptimisticTransaction({
      tool: 'nexus_task_update',
      caller,
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' }, expected: { status: 'in-progress' } },
      // The row already holds the patch's target status — but NOT what the
      // caller's own guard demanded. isSatisfied would say "yes, converge";
      // the blocking status mismatch must override that and fail instead.
      captureBefore: async () => ({ id: 'task-1', status: 'completed', updated_at: 't9' }),
      validatePreconditions: ({ before, intent }) => compareFields(before, intent.expected),
      apply,
      readAfter: async () => null,
      verify: () => ({ ok: true }),
      logPath,
    }, { baseDelayMs: 0, isSatisfied: (current) => current.status === 'completed' }))
      .rejects.toMatchObject({
        verdict: 'stale_precondition',
        lock: { outcome: 'conflict_unresolved', blocking_fields: ['status'] },
      });

    expect(apply).not.toHaveBeenCalled();
  });

  test('gives up after maxAttempts when the row keeps moving, without writing', async () => {
    const { executeOptimisticTransaction, compareFields } = require('../../services/praxis-mind-mcp/lib/transactions');
    const apply = jest.fn();
    const captureBefore = jest.fn(driftingRow());

    await expect(executeOptimisticTransaction({
      tool: 'nexus_task_update',
      caller,
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' }, expected: { updated_at: 'never-matches' } },
      captureBefore,
      validatePreconditions: ({ before, intent }) => compareFields(before, intent.expected),
      apply,
      readAfter: async () => null,
      verify: () => ({ ok: true }),
      logPath,
    }, { baseDelayMs: 0, maxAttempts: 3 })).rejects.toMatchObject({
      verdict: 'stale_precondition',
      lock: { attempts: 3, outcome: 'retries_exhausted' },
    });

    expect(captureBefore).toHaveBeenCalledTimes(3);
    expect(apply).not.toHaveBeenCalled();
  });

  test('a non-stale failure is not retried', async () => {
    const { executeOptimisticTransaction } = require('../../services/praxis-mind-mcp/lib/transactions');
    const apply = jest.fn(async () => { throw new Error('backend exploded'); });

    await expect(executeOptimisticTransaction({
      tool: 'nexus_task_update',
      caller,
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' }, expected: {} },
      captureBefore: async () => ({ id: 'task-1', status: 'todo' }),
      apply,
      readAfter: async () => null,
      verify: () => ({ ok: true }),
      logPath,
    }, { baseDelayMs: 0 })).rejects.toMatchObject({ verdict: 'apply_failed' });

    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('nexus_task_update lock behaviour', () => {
  let tempDir;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-lock-tool-'));
    process.env.PRAXIS_MIND_TRANSITION_LOG = path.join(tempDir, 'transitions.jsonl');
    process.env.PRAXIS_MIND_LEDGER_DB = path.join(tempDir, 'ledger.sqlite');
  });

  afterEach(() => {
    delete process.env.PRAXIS_MIND_TRANSITION_LOG;
    delete process.env.PRAXIS_MIND_LEDGER_DB;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('survives an unrelated writer bumping updated_at, and reports the gauge', async () => {
    // The caller read the row at t0; an unrelated writer bumped it to t1 before
    // the update landed. Nothing about priority=2 became wrong.
    let row = { id: 'task-1', status: 'todo', priority: 1, updated_at: 't1' };
    const backends = {
      nexusTaskById: jest.fn(async () => ({ ...row })),
      nexusTaskUpdate: jest.fn(async (_id, patch) => {
        row = { ...row, ...patch, updated_at: 't2' };
        return { success: true };
      }),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
    const { handlers, server } = serverHarness();
    register(server, { caller });

    const result = await handlers.nexus_task_update({
      task_id: 'task-1',
      priority: 2,
      expected_updated_at: 't0',
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.optimistic_lock).toMatchObject({ attempts: 2, outcome: 'committed_after_retry' });
    expect(backends.nexusTaskUpdate).toHaveBeenCalledWith('task-1', { priority: 2 });
    expect(payload.lock_health).toMatchObject({
      tool: 'nexus_task_update',
      writes: 1,
      contended: 1,
      conflict_rate: 1,
      auto_resolved: 1,
      unresolved: 0,
    });
  });

  test('on_conflict="fail" keeps the strict compare-and-set behaviour', async () => {
    const backends = {
      nexusTaskById: jest.fn(async () => ({ id: 'task-1', status: 'todo', updated_at: 't1' })),
      nexusTaskUpdate: jest.fn(),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
    const { handlers, server } = serverHarness();
    register(server, { caller });

    const result = await handlers.nexus_task_update({
      task_id: 'task-1',
      priority: 2,
      expected_updated_at: 't0',
      on_conflict: 'fail',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/stale expected state/i);
    expect(result.content[0].text).toMatch(/Lock health —/);
    expect(backends.nexusTaskById).toHaveBeenCalledTimes(1);
    expect(backends.nexusTaskUpdate).not.toHaveBeenCalled();

    // QA regression (2026-09-01, attempt 1): executeTransaction (the strict
    // path) has no lock trace of its own, so this used to be recorded with no
    // conflict_fields — contended:0 alongside unresolved:1, a contradiction.
    const { gauge } = require('../../services/praxis-mind-mcp/lib/lock-health');
    const summary = gauge('nexus_task_update', 24);
    expect(summary).toMatchObject({ writes: 1, contended: 1, unresolved: 1, blocked_on: ['updated_at×1'] });
  });

  test('a timestamp-only conflict that already landed the exact patch converges', async () => {
    // A concurrent writer applied our patch under our nose. Only the
    // freshness guard (updated_at) is stale — status was never asserted —
    // so this is safe to report as success without writing again.
    const backends = {
      nexusTaskById: jest.fn(async () => ({ id: 'task-1', status: 'completed', updated_at: 't9' })),
      nexusTaskUpdate: jest.fn(),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
    const { handlers, server } = serverHarness();
    register(server, { caller });

    const result = await handlers.nexus_task_update({
      task_id: 'task-1',
      status: 'completed',
      expected_updated_at: 't0',
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.verdict).toBe('converged_noop');
    expect(backends.nexusTaskUpdate).not.toHaveBeenCalled();
  });

  test('expected_status is NEVER waived by convergence, even when the row already matches the patch', async () => {
    // QA regression (2026-09-01, attempt 1): the row already holds the patch's
    // target status, but the caller's OWN expected_status guard does not match
    // reality (someone else moved it through a path the caller didn't expect).
    // That must fail hard — it must not read the coincidental end-state as
    // permission to skip the guard the caller explicitly asked for.
    const backends = {
      nexusTaskById: jest.fn(async () => ({ id: 'task-1', status: 'completed', updated_at: 't9' })),
      nexusTaskUpdate: jest.fn(),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
    const { handlers, server } = serverHarness();
    register(server, { caller });

    const result = await handlers.nexus_task_update({
      task_id: 'task-1',
      status: 'completed',
      expected_status: 'in-progress',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/stale expected state/i);
    expect(result.content[0].text).toMatch(/expected status.*in-progress.*completed/i);
    expect(backends.nexusTaskUpdate).not.toHaveBeenCalled();
  });

  test('an unresolvable conflict is counted as unresolved in the gauge', async () => {
    const backends = {
      nexusTaskById: jest.fn(async () => ({ id: 'task-1', status: 'cancelled', updated_at: 't9' })),
      nexusTaskUpdate: jest.fn(),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
    const { handlers, server } = serverHarness();
    register(server, { caller });

    const result = await handlers.nexus_task_update({
      task_id: 'task-1',
      status: 'completed',
      expected_status: 'todo',
    });

    expect(result.isError).toBe(true);
    expect(backends.nexusTaskUpdate).not.toHaveBeenCalled();

    const { gauge, formatGauge } = require('../../services/praxis-mind-mcp/lib/lock-health');
    const summary = gauge('nexus_task_update', 24);
    expect(summary).toMatchObject({ writes: 1, unresolved: 1, auto_resolved: 0, blocked_on: ['status×1'] });
    expect(formatGauge(summary)).toMatch(/1 unresolved/);
  });
});

describe('lock health gauge', () => {
  let tempDir;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-gauge-'));
    process.env.PRAXIS_MIND_LEDGER_DB = path.join(tempDir, 'ledger.sqlite');
  });

  afterEach(() => {
    delete process.env.PRAXIS_MIND_LEDGER_DB;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('splits contention into auto-resolved and unresolved, and counts ledger stale errors', () => {
    const lockHealth = require('../../services/praxis-mind-mcp/lib/lock-health');
    const ledger = require('../../services/praxis-mind-mcp/lib/ledger');

    lockHealth.record({ tool: 'nexus_task_update', outcome: 'committed', lock: { attempts: 1, conflicts: [] } });
    lockHealth.record({
      tool: 'nexus_task_update',
      outcome: 'committed_after_retry',
      lock: { attempts: 2, conflicts: [{ attempt: 1, fields: ['updated_at'] }] },
    });
    lockHealth.record({
      tool: 'nexus_task_update',
      outcome: 'conflict_unresolved',
      lock: { attempts: 1, conflicts: [{ attempt: 1, fields: ['status'] }], blocking_fields: ['status'] },
    });
    // A different tool must not bleed into the gauge.
    lockHealth.record({ tool: 'nexus_project_update', outcome: 'committed', lock: { attempts: 1, conflicts: [] } });
    ledger.record({
      caller: 'jest-agent',
      tool: 'nexus_task_update',
      success: false,
      error: 'Stale expected state: expected updated_at="t0", actual="t1"',
    });

    const summary = lockHealth.gauge('nexus_task_update', 24);
    expect(summary).toMatchObject({
      tool: 'nexus_task_update',
      writes: 3,
      contended: 2,
      auto_resolved: 1,
      unresolved: 1,
      stale_errors: 1,
      blocked_on: ['status×1'],
    });
    expect(summary.conflict_rate).toBeCloseTo(0.667, 3);
    expect(lockHealth.formatGauge(summary)).toMatch(/3 write\(s\) in 24h, 2 contended \(67%\)/);
  });

  test('reports an empty window without inventing a rate', () => {
    const lockHealth = require('../../services/praxis-mind-mcp/lib/lock-health');
    const summary = lockHealth.gauge('nexus_task_update', 24);
    expect(summary).toMatchObject({ writes: 0, contended: 0, conflict_rate: 0, stale_errors: 0 });
    expect(lockHealth.formatGauge(summary)).toMatch(/no guarded writes/);
  });

  test('the CLI prints the gauge as json without writing anything', () => {
    const { main } = require('../../services/praxis-mind-mcp/bin/lock-health');
    const lockHealth = require('../../services/praxis-mind-mcp/lib/lock-health');
    lockHealth.record({ tool: 'nexus_task_update', outcome: 'committed', lock: { attempts: 1, conflicts: [] } });

    let out = '';
    const code = main(['--json', '--hours', '6'], { stdout: { write: (s) => { out += s; } } });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ tool: 'nexus_task_update', window_hours: 6, writes: 1 });
  });

  test('the CLI rejects partially numeric --hours instead of silently truncating', () => {
    // QA improvement (2026-09-01, attempt 2): Number.parseInt stops at the
    // first non-digit, so "1.5" silently became 1, "6hours" became 6 and
    // "24abc" became 24 — a window the caller never asked for, reported back
    // as if it were theirs. The whole argument must be digits.
    const { main } = require('../../services/praxis-mind-mcp/bin/lock-health');
    const swallow = { stdout: { write: () => {} } };

    for (const bad of ['1.5', '6hours', '24abc', '0x10', '-3', '0', '', '   ']) {
      expect(() => main(['--json', '--hours', bad], swallow))
        .toThrow('--hours must be a positive integer');
    }

    // Well-formed values (including surrounding whitespace) still work.
    for (const good of ['12', ' 12 ']) {
      let out = '';
      expect(main(['--json', '--hours', good], { stdout: { write: (s) => { out += s; } } })).toBe(0);
      expect(JSON.parse(out).window_hours).toBe(12);
    }
  });

  test('a valueless --hours errors instead of quietly falling back to the default', () => {
    // Improvement follow-up (2026-09-01): `--hours` with nothing after it, or
    // followed by the next flag, used to slide into the 24h default — the same
    // quiet substitution the digit check exists to stop. Only the flag's
    // ABSENCE may select the default.
    const { main } = require('../../services/praxis-mind-mcp/bin/lock-health');
    const swallow = { stdout: { write: () => {} } };

    expect(() => main(['--json', '--hours'], swallow))
      .toThrow('--hours must be a positive integer');
    expect(() => main(['--hours'], swallow))
      .toThrow('--hours must be a positive integer');
    expect(() => main(['--json', '--hours', '--tool', 'nexus_task_update'], swallow))
      .toThrow('--hours must be a positive integer');

    // Omitting the flag entirely still means "24 hours".
    let out = '';
    expect(main(['--json'], { stdout: { write: (s) => { out += s; } } })).toBe(0);
    expect(JSON.parse(out).window_hours).toBe(24);
  });
});
