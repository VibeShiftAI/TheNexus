const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('praxis-mind transaction envelope', () => {
  let tempDir;
  let logPath;

  beforeEach(() => {
    jest.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-transactions-'));
    logPath = path.join(tempDir, 'transitions.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('logs caller identity and before/after images after verified commit', async () => {
    const { executeTransaction } = require('../../services/praxis-mind-mcp/lib/transactions');
    const { readTransitions } = require('../../services/praxis-mind-mcp/lib/transition-log');
    let state = { id: 'task-1', status: 'todo' };

    const result = await executeTransaction({
      tool: 'nexus_task_update',
      caller: { identity: 'codex', namespace: 'coding-agents-codex' },
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' } },
      captureBefore: async () => ({ ...state }),
      apply: async () => {
        state = { ...state, status: 'completed' };
        return { success: true };
      },
      readAfter: async () => ({ ...state }),
      verify: ({ after }) => ({ ok: after.status === 'completed' }),
      logPath,
    });

    expect(result.verdict).toBe('committed');
    expect(result.before).toEqual({ id: 'task-1', status: 'todo' });
    expect(result.after).toEqual({ id: 'task-1', status: 'completed' });
    const [record] = readTransitions(logPath);
    expect(record).toMatchObject({
      transaction_id: result.transactionId,
      tool: 'nexus_task_update',
      caller: { identity: 'codex', namespace: 'coding-agents-codex' },
      before: { id: 'task-1', status: 'todo' },
      after: { id: 'task-1', status: 'completed' },
      verdict: 'committed',
    });
  });

  test('rejects stale expected state before apply and logs the mismatch', async () => {
    const { executeTransaction, TransactionError } = require('../../services/praxis-mind-mcp/lib/transactions');
    const { readTransitions } = require('../../services/praxis-mind-mcp/lib/transition-log');
    const apply = jest.fn();

    await expect(executeTransaction({
      tool: 'nexus_task_update',
      caller: { identity: 'claude', namespace: 'coding-agents-claude' },
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' }, expected: { status: 'todo' } },
      captureBefore: async () => ({ id: 'task-1', status: 'in-progress' }),
      validatePreconditions: ({ before }) => (
        before.status === 'todo' ? [] : [{ field: 'status', expected: 'todo', actual: before.status }]
      ),
      apply,
      readAfter: async () => null,
      verify: () => ({ ok: true }),
      logPath,
    })).rejects.toEqual(expect.objectContaining({
      constructor: TransactionError,
      verdict: 'stale_precondition',
      message: expect.stringMatching(/expected status.*todo.*in-progress/i),
    }));

    expect(apply).not.toHaveBeenCalled();
    expect(readTransitions(logPath)[0]).toMatchObject({
      verdict: 'stale_precondition',
      after: { id: 'task-1', status: 'in-progress' },
      precondition_mismatches: [{ field: 'status', expected: 'todo', actual: 'in-progress' }],
    });
  });

  test('detects and logs a postcondition mismatch after an API write', async () => {
    const { executeTransaction } = require('../../services/praxis-mind-mcp/lib/transactions');
    const { readTransitions } = require('../../services/praxis-mind-mcp/lib/transition-log');

    await expect(executeTransaction({
      tool: 'nexus_task_update',
      caller: { identity: 'codex' },
      target: { task_id: 'task-1' },
      intent: { patch: { status: 'completed' } },
      captureBefore: async () => ({ id: 'task-1', status: 'todo' }),
      apply: async () => ({ success: true }),
      readAfter: async () => ({ id: 'task-1', status: 'todo' }),
      verify: ({ after }) => ({
        ok: false,
        mismatches: [{ field: 'status', expected: 'completed', actual: after.status }],
      }),
      logPath,
    })).rejects.toMatchObject({ verdict: 'postcondition_mismatch' });

    expect(readTransitions(logPath)[0]).toMatchObject({
      verdict: 'postcondition_mismatch',
      after: { id: 'task-1', status: 'todo' },
      postcondition_mismatches: [{ field: 'status', expected: 'completed', actual: 'todo' }],
    });
  });

  test('captures best-effort after-image when apply throws', async () => {
    const { executeTransaction } = require('../../services/praxis-mind-mcp/lib/transactions');
    const { readTransitions } = require('../../services/praxis-mind-mcp/lib/transition-log');

    await expect(executeTransaction({
      tool: 'nexus_project_update',
      caller: { identity: 'codex' },
      target: { project_id: 'project-1' },
      intent: { patch: { status: 'parked' } },
      captureBefore: async () => ({ id: 'project-1', status: 'active' }),
      apply: async () => { throw new Error('connection reset'); },
      readAfter: async () => ({ id: 'project-1', status: 'parked' }),
      verify: () => ({ ok: true }),
      logPath,
    })).rejects.toMatchObject({ verdict: 'apply_failed' });

    expect(readTransitions(logPath)[0]).toMatchObject({
      verdict: 'apply_failed',
      before: { id: 'project-1', status: 'active' },
      after: { id: 'project-1', status: 'parked' },
      error: 'connection reset',
    });
  });
});

describe('praxis-mind compensation payloads', () => {
  const base = {
    transaction_id: 'tx-1',
    verdict: 'committed',
    caller: { identity: 'codex' },
  };

  test.each([
    {
      name: 'task update',
      record: {
        ...base,
        tool: 'nexus_task_update',
        target: { task_id: 'task-1' },
        intent: { patch: { status: 'completed', priority: 2 } },
        before: { id: 'task-1', status: 'todo', priority: 1 },
        after: { id: 'task-1', status: 'completed', priority: 2 },
      },
      expected: { kind: 'mcp_tool', tool: 'nexus_task_update', arguments: { task_id: 'task-1', status: 'todo', priority: 1 } },
    },
    {
      name: 'project update',
      record: {
        ...base,
        tool: 'nexus_project_update',
        target: { project_id: 'project-1' },
        intent: { patch: { status: 'parked' }, add_need: { kind: 'decision', description: 'Choose' } },
        before: { id: 'project-1', status: 'active', needs: [] },
        after: { id: 'project-1', status: 'parked', needs: [{ id: 'need-1', status: 'open' }] },
      },
      expected: { kind: 'api_request', method: 'PATCH', path: '/api/projects/project-1', body: { status: 'active', needs: [] } },
    },
    {
      name: 'task create',
      record: {
        ...base,
        tool: 'nexus_task_create',
        target: { project_id: 'project-1', task_id: 'task-new' },
        intent: { title: 'New task' },
        before: null,
        after: { id: 'task-new', project_id: 'project-1' },
      },
      expected: { kind: 'api_request', method: 'DELETE', path: '/api/tasks/project-1/tasks/task-new' },
    },
    {
      name: 'existing vault file',
      record: {
        ...base,
        tool: 'vault_write',
        target: { path: 'projects/Praxis.md' },
        intent: { mode: 'replace' },
        before: { exists: true, content: 'old' },
        after: { exists: true, content: 'new' },
      },
      expected: { kind: 'mcp_tool', tool: 'vault_write', arguments: { path: 'projects/Praxis.md', content: 'old', mode: 'replace' } },
    },
    {
      name: 'new vault file',
      record: {
        ...base,
        tool: 'vault_write',
        target: { path: 'incidents/new.md' },
        intent: { mode: 'replace' },
        before: { exists: false, content: null },
        after: { exists: true, content: 'new' },
      },
      expected: { kind: 'filesystem_delete', path: '/Volumes/Projects/shared-mind/incidents/new.md' },
    },
    {
      name: 'memory create',
      record: {
        ...base,
        tool: 'memory_write',
        target: { episode_uuid: 'episode-1', namespace: 'coding-agents-codex' },
        intent: { text: 'Observation' },
        before: null,
        after: { name: 'episode-1', content: 'Observation' },
      },
      expected: {
        kind: 'cortex_cleanup',
        episode_uuid: 'episode-1',
        namespace: 'coding-agents-codex',
        operations: [
          {
            method: 'POST',
            path: '/api/graph/cypher',
            body: expect.objectContaining({ params: { episode_uuid: 'episode-1' } }),
          },
          {
            method: 'DELETE',
            path: '/api/memory/vectors',
            body: { ids: ['episode-1'], namespace: 'coding-agents-codex' },
          },
        ],
      },
    },
  ])('generates one-step compensation for $name', ({ record, expected }) => {
    const { buildCompensation } = require('../../services/praxis-mind-mcp/lib/transition-log');
    expect(buildCompensation(record)).toMatchObject({
      source_transaction_id: 'tx-1',
      compensation: expected,
    });
  });
});

describe('praxis-mind transition log CLI', () => {
  test('shows a record and emits its compensation payload', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-cli-'));
    const logPath = path.join(tempDir, 'transitions.jsonl');
    const cli = path.join(__dirname, '../../services/praxis-mind-mcp/bin/transition-log.js');
    fs.writeFileSync(logPath, `${JSON.stringify({
      transaction_id: 'tx-cli',
      tool: 'nexus_task_create',
      verdict: 'committed',
      target: { project_id: 'project-1', task_id: 'task-new' },
      before: null,
      after: { id: 'task-new' },
    })}\n`);

    try {
      const show = spawnSync(process.execPath, [cli, 'show', 'tx-cli', '--log', logPath], { encoding: 'utf8' });
      expect(show.status).toBe(0);
      expect(JSON.parse(show.stdout)).toMatchObject({ transaction_id: 'tx-cli', verdict: 'committed' });

      const compensate = spawnSync(process.execPath, [cli, 'compensate', 'tx-cli', '--log', logPath], { encoding: 'utf8' });
      expect(compensate.status).toBe(0);
      expect(JSON.parse(compensate.stdout)).toMatchObject({
        source_transaction_id: 'tx-cli',
        auto_apply: false,
        compensation: { kind: 'api_request', method: 'DELETE', path: '/api/tasks/project-1/tasks/task-new' },
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
