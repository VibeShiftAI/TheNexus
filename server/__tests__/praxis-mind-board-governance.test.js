/**
 * Governed board write path — praxis-mind surface (ported from
 * mcp-board-governance.test.js when server/mcp.js was retired, M-1 2026-09-04;
 * the original lives in /Volumes/Projects/Backup/TheNexus-server-mcp-2026-09-04/).
 *
 * P1-15 made services/praxis-mind-mcp/lib/board-ops.js the ONE write path onto
 * the board. With the "Local Nexus" surface gone, praxis-mind
 * (services/praxis-mind-mcp/tools/nexus.js) is its only caller, and this suite
 * pins the governance the threat model (docs/architecture/
 * mcp-boundary-threat-model.md MG-5, AZ-2, AU-1) asks of that live surface:
 *
 *   ONE QUOTA   The hourly rate limit is one counter per identity per
 *               operation (real sqlite, not a mock), and the cost ledger
 *               attributes each call to the tool actually invoked.
 *   ONE AUDIT   Writes land in the transition log under the canonical
 *               operation name with the caller stamped; a multi-task create
 *               through board-ops (batch: true) is one record carrying every
 *               created id, with a compensation per task.
 *   ONE BACKEND Reads and misses go through lib/backends (the Nexus HTTP API),
 *               and a 404 still reads as not found.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SVC = '../../services/praxis-mind-mcp';

const READ_PRIVILEGES = ['nexus.projects_list', 'nexus.tasks_read', 'nexus.task_status'];
const WRITE_PRIVILEGES = ['nexus.task_create', 'nexus.task_update', 'nexus.project_update'];

const READONLY = { identity: 'readonly', namespace: 'coding-agents-readonly', privileges: [...READ_PRIVILEGES] };
const writer = (identity, rate_limits_per_hour = {}) => ({
  identity,
  namespace: `coding-agents-${identity}`,
  privileges: [...READ_PRIVILEGES, ...WRITE_PRIVILEGES],
  rate_limits_per_hour,
});

const textOf = (result) => result.content.map((c) => c.text).join('\n');
const jsonOf = (result) => JSON.parse(textOf(result));

function makeRegistry() {
  const tools = new Map();
  return {
    tools,
    server: {
      tool(...args) {
        tools.set(args[0], { handler: args[args.length - 1], schema: args[args.length - 2] });
      },
      resource() {},
      async connect() {},
    },
  };
}

// A small in-memory Nexus behind the lib/backends seam, shaped like the HTTP
// API responses the real backends return.
function fakeNexus() {
  const projects = new Map([['p1', { id: 'p1', name: 'Fixture', status: 'active', priority: 0, needs: [] }]]);
  const tasks = new Map([['t1', { id: 't1', project_id: 'p1', name: 'Seed', status: 'idea', description: 'seed', source: 'nexus-dashboard' }]]);
  let seq = 0;
  const notFound = (what) => Object.assign(new Error(`HTTP 404: {"error":"${what} not found"}`), { status: 404 });
  const backends = {
    nexusProjects: jest.fn(async () => [...projects.values()].map((p) => ({ ...p }))),
    nexusBoardState: jest.fn(async (projectId) => [...projects.values()]
      .filter((p) => !projectId || p.id === projectId)
      .map((p) => ({ ...p, tasks: [...tasks.values()].filter((t) => t.project_id === p.id).map((t) => ({ ...t })) }))),
    nexusProjectById: jest.fn(async (id) => {
      if (!projects.has(id)) throw notFound('Project');
      return { ...projects.get(id) };
    }),
    nexusProjectUpdate: jest.fn(async (id, patch) => {
      const clean = { ...patch };
      delete clean.end_state_source;
      delete clean.end_state_reason;
      projects.set(id, { ...projects.get(id), ...clean });
      return { ...projects.get(id) };
    }),
    nexusTasksByProject: jest.fn(async (projectId) => ({ tasks: [...tasks.values()].filter((t) => t.project_id === projectId) })),
    nexusTaskById: jest.fn(async (id) => {
      if (!tasks.has(id)) throw notFound('Task');
      return { ...tasks.get(id) };
    }),
    nexusTaskUpdate: jest.fn(async (id, patch) => {
      tasks.set(id, { ...tasks.get(id), ...patch });
      return { success: true, task: { ...tasks.get(id) } };
    }),
    nexusTaskCreate: jest.fn(async (body) => {
      const id = `task-${++seq}`;
      tasks.set(id, {
        id, project_id: body.project_id, name: body.name, description: body.description, priority: body.priority,
        dependencies: body.dependencies, successor_id: body.successor_id || null, source: body.source, status: body.status || 'idea',
      });
      return { tasks: [{ id }] };
    }),
    nexusTasksBatchCreate: jest.fn(async ({ project_id, tasks: batch }) => {
      if (!projects.has(project_id)) throw notFound('Project');
      const stable = new Map();
      const created = batch.map((t) => {
        const id = `task-${++seq}`;
        if (t.stable_id) stable.set(t.stable_id, id);
        const row = { ...t, id, project_id, status: t.status || 'idea' };
        delete row.stable_id;
        return row;
      });
      for (const row of created) {
        if (row.dependencies?.length) row.dependencies = row.dependencies.map((d) => stable.get(d) || d);
        tasks.set(row.id, row);
      }
      return {
        success: true, project: projects.get(project_id).name, created_count: created.length,
        tasks: created.map((t) => ({ id: t.id, name: t.name, status: t.status, has_payload: !!t.antigravity_payload, dependencies: t.dependencies || [] })),
      };
    }),
  };
  return { backends, projects, tasks };
}

let tmp;
let config;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-board-governance-'));
  config = {
    VAULT: tmp,
    KEYS_FILE: path.join(tmp, 'keys.json'),
    LEDGER_DB: path.join(tmp, 'ledger.sqlite'),
    TRANSITION_LOG: path.join(tmp, 'transitions.jsonl'),
    NEXUS: 'http://127.0.0.1:9',
    HTTP_TIMEOUT_MS: 500,
  };
});

afterEach(() => {
  jest.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const transitions = () => (fs.existsSync(config.TRANSITION_LOG)
  ? fs.readFileSync(config.TRANSITION_LOG, 'utf8').trim().split('\n').map(JSON.parse)
  : []);

/**
 * Load the praxis-mind nexus tools behind one module registry (so every
 * caller shares the lib/board-ops, lib/ledger and lib/ratelimit instances)
 * and return a per-caller tool factory plus direct access to board-ops.
 */
function loadSurface({ backends, realLedger = false }) {
  jest.resetModules();
  jest.doMock(`${SVC}/lib/log`, () => ({ log: () => {} }));
  jest.doMock(`${SVC}/lib/config`, () => config);
  jest.doMock(`${SVC}/lib/backends`, () => backends);
  if (realLedger) {
    jest.dontMock(`${SVC}/lib/ledger`);
    jest.dontMock(`${SVC}/lib/ratelimit`);
    jest.dontMock(`${SVC}/lib/lock-health`);
  } else {
    jest.doMock(`${SVC}/lib/ledger`, () => ({ record: jest.fn(), costSince: () => 0, recent: () => [], getDb: () => ({ close() {} }) }));
    jest.doMock(`${SVC}/lib/ratelimit`, () => ({ checkAndIncrement: () => ({ allowed: true, count: 0, limit: Infinity }) }));
    jest.doMock(`${SVC}/lib/lock-health`, () => ({ record: jest.fn(), gauge: () => null, formatGauge: () => '(gauge disabled)' }));
  }
  const praxisMind = (caller) => {
    const registry = makeRegistry();
    require(`${SVC}/tools/nexus`).register(registry.server, { caller });
    return registry;
  };
  return { praxisMind, boardOps: require(`${SVC}/lib/board-ops`), ledger: require(`${SVC}/lib/ledger`) };
}

describe('ONE QUOTA — the per-identity hourly counter is real and tool-attributed', () => {
  test('nexus.task_create limit is consumed per identity, and the ledger names the invoked tool', async () => {
    const { backends } = fakeNexus();
    const agent = writer('agent-a', { 'nexus.task_create': 2 });
    const { praxisMind, boardOps, ledger } = loadSurface({ backends, realLedger: true });
    const mind = praxisMind(agent).tools;

    const first = await mind.get('nexus_task_create').handler({ project_id: 'p1', title: 'one', description: '', priority: 1, dependencies: [] });
    expect(first.isError).toBeUndefined();
    // A batch create through board-ops is the same operation (OPS.TASK_CREATE)
    // and therefore draws on the same counter as the single-task tool.
    const second = await boardOps.createTasks({ caller: agent }, {
      tool: 'nexus_batch_create_tasks', project_id: 'p1', batch: true, tasks: [{ name: 'two', dependencies: [] }],
    });
    expect(second.ok).toBe(true);

    // Third create by EITHER path is over quota: one counter, one identity.
    const third = await mind.get('nexus_task_create').handler({ project_id: 'p1', title: 'three', description: '', priority: 1, dependencies: [] });
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/Rate limit exceeded for nexus_task_create: 3\/2/);
    const fourth = await boardOps.createTasks({ caller: agent }, {
      tool: 'nexus_batch_create_tasks', project_id: 'p1', batch: true, tasks: [{ name: 'four', dependencies: [] }],
    });
    expect(fourth.ok).toBe(false);
    expect(textOf(fourth.result)).toMatch(/Rate limit exceeded for nexus_task_create: 4\/2/);

    expect(backends.nexusTaskCreate).toHaveBeenCalledTimes(1);
    expect(backends.nexusTasksBatchCreate).toHaveBeenCalledTimes(1);

    // The ledger attributes each call to the tool the client actually invoked.
    const rows = ledger.recent('agent-a', 10).map((r) => r.tool);
    expect(rows).toEqual(expect.arrayContaining(['nexus_task_create', 'nexus_batch_create_tasks']));
    ledger.getDb().close();
  });
});

describe('ONE AUDIT — writes land in the transition log under the canonical vocabulary', () => {
  test('a task update is a nexus_task_update record stamped with the caller, with before/after images', async () => {
    const { backends, tasks } = fakeNexus();
    const agent = writer('agent-a');
    const { praxisMind } = loadSurface({ backends });
    const mind = praxisMind(agent).tools;

    const r1 = await mind.get('nexus_task_update').handler({ task_id: 't1', status: 'todo' });
    expect(r1.isError).toBeUndefined();
    expect(jsonOf(r1)).toMatchObject({ success: true, transaction_id: expect.any(String) });

    const r2 = await mind.get('nexus_task_update').handler({ task_id: 't1', status: 'in_progress', description: 'picked up' });
    expect(r2.isError).toBeUndefined();
    expect(tasks.get('t1')).toMatchObject({ status: 'in_progress', description: 'picked up' });

    const records = transitions();
    expect(records.map((r) => [r.tool, r.verdict, r.caller.identity])).toEqual([
      ['nexus_task_update', 'committed', 'agent-a'],
      ['nexus_task_update', 'committed', 'agent-a'],
    ]);
    expect(records[1].intent).toMatchObject({ patch: { status: 'in_progress', description: 'picked up' } });
    expect(records[1].before.status).toBe('todo');
    expect(records[1].after.status).toBe('in_progress');
  });

  test('a batch create through board-ops is one nexus_task_create record carrying every created id, with a compensation per task', async () => {
    const { backends, tasks } = fakeNexus();
    const agent = writer('agent-a');
    const { boardOps } = loadSurface({ backends });

    const deps = Object.freeze(['first']);
    const batch = Object.freeze([
      Object.freeze({ name: 'A', stable_id: 'first', dependencies: Object.freeze([]) }),
      Object.freeze({ name: 'B', dependencies: deps }),
    ]);
    const r = await boardOps.createTasks({ caller: agent }, { project_id: 'p1', batch: true, tasks: batch });
    expect(r.ok).toBe(true);
    // `after` is the read-back of every created row; `result` is the batch
    // response the surface would format.
    const created = r.value.after;
    expect(r.value.result).toMatchObject({ success: true, project: 'Fixture', created_count: 2 });
    expect(created.map((t) => t.name)).toEqual(['A', 'B']);
    // The placeholder resolved server-side to A's real id; caller args untouched.
    expect(created[1].dependencies).toEqual([created[0].id]);
    expect(deps).toEqual(['first']);
    expect(tasks.get(created[1].id).source).toBe('coding-agents-agent-a');

    const [record] = transitions();
    expect(record).toMatchObject({ tool: 'nexus_task_create', verdict: 'committed', caller: { identity: 'agent-a' } });
    expect(record.target).toEqual({ project_id: 'p1', task_ids: created.map((t) => t.id) });

    const { buildCompensation } = require(`${SVC}/lib/transition-log`);
    const plan = buildCompensation(record);
    expect(plan.compensation.kind).toBe('api_requests');
    expect(plan.compensation.requests.map((x) => x.path)).toEqual(
      created.map((t) => `/api/tasks/p1/tasks/${t.id}`),
    );
  });

  test('a project update is a nexus_project_update record stamped with the caller, and a readonly caller never reaches the backend', async () => {
    const { backends, projects } = fakeNexus();
    const agent = writer('agent-a');
    const { praxisMind } = loadSurface({ backends });
    const mind = praxisMind(agent).tools;

    // Status values are schema-enforced (z.enum) by the SDK before the handler
    // runs; what the handler itself must refuse is a caller without the privilege.
    const bad = await praxisMind(READONLY).tools.get('nexus_project_update').handler({ project_id: 'p1', status: 'paused' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/lacks privilege/);
    expect(backends.nexusProjectUpdate).not.toHaveBeenCalled();

    const ok = await mind.get('nexus_project_update').handler({ project_id: 'p1', status: 'paused', end_state: 'shipped' });
    expect(ok.isError).toBeUndefined();
    expect(projects.get('p1')).toMatchObject({ status: 'paused', end_state: 'shipped' });
    expect(backends.nexusProjectUpdate).toHaveBeenCalledWith('p1', expect.objectContaining({
      status: 'paused', end_state: 'shipped', end_state_source: 'coding-agents-agent-a',
    }));

    const [record] = transitions();
    expect(record).toMatchObject({ tool: 'nexus_project_update', verdict: 'committed', caller: { identity: 'agent-a' }, target: { project_id: 'p1' } });
  });
});

describe('ONE BACKEND — board reads go through lib/backends, and a 404 still reads as not found', () => {
  test('reads and a miss for a readonly caller', async () => {
    const { backends } = fakeNexus();
    const { praxisMind, boardOps } = loadSurface({ backends });
    const { tools } = praxisMind(READONLY);

    const status = await tools.get('nexus_task_status').handler({ task_id: 't1' });
    expect(status.isError).toBeUndefined();
    // The read is rendered under a provenance header, then the JSON row.
    expect(textOf(status)).toMatch(/"id": "t1"/);
    expect(backends.nexusTaskById).toHaveBeenCalledWith('t1');

    const miss = await tools.get('nexus_task_status').handler({ task_id: 'nope' });
    expect(miss.isError).toBe(true);
    expect(textOf(miss)).toMatch(/not found/i);

    const board = await boardOps.boardState({ caller: READONLY }, { project_id: 'p1' });
    expect(board.ok).toBe(true);
    expect(backends.nexusBoardState).toHaveBeenCalledWith('p1');
  });
});
