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
  privileges: [
    'nexus.project_update',
    'nexus.task_create',
    'nexus.task_update',
    'vault.write',
    'memory.write',
  ],
};

describe('praxis-mind write tool transaction integration', () => {
  let tempDir;
  let logPath;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-write-tools-'));
    logPath = path.join(tempDir, 'transitions.jsonl');
    process.env.PRAXIS_MIND_TRANSITION_LOG = logPath;
    jest.doMock('../../services/praxis-mind-mcp/lib/ledger', () => ({ record: jest.fn() }));
    // Telemetry sidecar — it owns its own sqlite handle, which these tests
    // neither provide nor assert on.
    jest.doMock('../../services/praxis-mind-mcp/lib/lock-health', () => ({
      record: jest.fn(),
      gauge: jest.fn(() => null),
      formatGauge: jest.fn(() => 'gauge disabled in test'),
    }));
  });

  afterEach(() => {
    delete process.env.PRAXIS_MIND_TRANSITION_LOG;
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.dontMock('fs');
  });

  test('rejects a stale expected_status before calling the task update API', async () => {
    const backends = {
      nexusTaskById: jest.fn(async () => ({ id: 'task-1', status: 'in-progress', updated_at: 't2' })),
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
    expect(result.content[0].text).toMatch(/stale expected state/i);
    expect(result.content[0].text).toMatch(/expected status.*todo.*in-progress/i);
    expect(backends.nexusTaskUpdate).not.toHaveBeenCalled();
    const [record] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    expect(record).toMatchObject({
      tool: 'nexus_task_update',
      caller: { identity: 'jest-agent', namespace: 'coding-agents-jest' },
      verdict: 'stale_precondition',
    });
  });

  test('returns an honest error and logs when task read-back does not match the patch', async () => {
    const backends = {
      nexusTaskById: jest.fn()
        .mockResolvedValueOnce({ id: 'task-1', status: 'todo' })
        .mockResolvedValueOnce({ id: 'task-1', status: 'todo' }),
      nexusTaskUpdate: jest.fn(async () => ({ success: true, task: { id: 'task-1', status: 'completed' } })),
    };
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
    const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
    const { handlers, server } = serverHarness();
    register(server, { caller });

    const result = await handlers.nexus_task_update({ task_id: 'task-1', status: 'completed' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/postcondition mismatch/i);
    expect(backends.nexusTaskUpdate).toHaveBeenCalledWith('task-1', { status: 'completed' });
    const [record] = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    expect(record).toMatchObject({
      tool: 'nexus_task_update',
      verdict: 'postcondition_mismatch',
      before: { status: 'todo' },
      after: { status: 'todo' },
    });
  });

  test('routes all five MCP write handlers through executeTransaction', async () => {
    const executeTransaction = jest.fn(async ({ tool, target }) => ({
      transactionId: `tx-${tool}`,
      verdict: 'committed',
      result: tool === 'nexus_task_create' ? { tasks: [{ id: 'task-new' }] } : {},
      after: tool === 'memory_write'
        ? { name: target.episode_uuid, content: 'observation' }
        : { exists: true, content: 'content' },
    }));
    jest.doMock('../../services/praxis-mind-mcp/lib/transactions', () => ({
      executeTransaction,
      // nexus_task_update wraps the envelope in the optimistic-lock retry loop;
      // uncontended, that is still exactly one executeTransaction call.
      executeOptimisticTransaction: (spec) => executeTransaction(spec),
      compareFields: jest.fn(() => []),
    }));
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => ({}));

    const nexusHarness = serverHarness();
    require('../../services/praxis-mind-mcp/tools/nexus').register(nexusHarness.server, { caller });
    await nexusHarness.handlers.nexus_project_update({ project_id: 'project-1', status: 'parked' });
    await nexusHarness.handlers.nexus_task_create({
      project_id: 'project-1', title: 'Task', description: '', priority: 1, dependencies: [],
    });
    await nexusHarness.handlers.nexus_task_update({ task_id: 'task-1', status: 'completed' });

    const actualFs = jest.requireActual('fs');
    jest.doMock('fs', () => ({
      ...actualFs,
      existsSync: jest.fn(() => false),
      mkdirSync: jest.fn(),
      writeFileSync: jest.fn(),
      appendFileSync: jest.fn(),
      readFileSync: jest.fn(),
    }));
    const vaultHarness = serverHarness();
    require('../../services/praxis-mind-mcp/tools/vault').register(vaultHarness.server, { caller });
    await vaultHarness.handlers.vault_write({ path: 'incidents/test.md', content: 'content', mode: 'replace' });

    const memoryHarness = serverHarness();
    require('../../services/praxis-mind-mcp/tools/memory').register(memoryHarness.server, { caller });
    await memoryHarness.handlers.memory_write({ text: 'observation', kind: 'observation', entities: [], factoids: [] });

    expect(executeTransaction.mock.calls.map(([spec]) => spec.tool)).toEqual([
      'nexus_project_update',
      'nexus_task_create',
      'nexus_task_update',
      'vault_write',
      'memory_write',
    ]);
  });

  test('task update accepts null to compensate a previously absent machine payload', () => {
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => ({}));
    const harness = serverHarness();
    require('../../services/praxis-mind-mcp/tools/nexus').register(harness.server, { caller });

    expect(harness.schemas.nexus_task_update.antigravity_payload.safeParse(null).success).toBe(true);
  });
});
