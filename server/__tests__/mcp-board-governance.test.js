/**
 * One governed board write path (ticket P1-15).
 *
 * Two MCP surfaces expose board writes — praxis-mind
 * (services/praxis-mind-mcp/tools/nexus.js, live) and "Local Nexus"
 * (server/mcp.js, latent). Both now delegate to
 * services/praxis-mind-mcp/lib/board-ops.js. This suite is the evidence the
 * threat model asks for before the latent surface may ever be wired to a
 * client (docs/architecture/mcp-boundary-threat-model.md MG-5: identity +
 * privilege + audit), and it pins the consolidation itself:
 *
 *   GATED       server/mcp.js's five board tools refuse an unauthenticated or
 *               under-privileged caller before any backend call.
 *   ONE QUOTA   The hourly rate limit is one counter per identity per
 *               operation, drawn on by BOTH surfaces (real sqlite, not a mock).
 *   ONE AUDIT   Writes from either surface land in the transition log under
 *               the canonical operation name with the caller stamped, and the
 *               cost ledger attributes each call to the tool actually invoked.
 *   ONE BACKEND Every board tool on server/mcp.js reaches the board through
 *               lib/backends (the Nexus HTTP API), never through `db`.
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

// server/mcp.js board tools -> the privilege each must be gated on, plus
// arguments that would mutate state if the gate were missing.
const LOCAL_NEXUS_BOARD_TOOLS = {
  nexus_get_board_state: { kind: 'read', privilege: 'nexus.projects_list', args: {} },
  nexus_get_task: { kind: 'read', privilege: 'nexus.task_status', args: { task_id: 't1' } },
  nexus_batch_create_tasks: { kind: 'write', privilege: 'nexus.task_create', args: { project_id: 'p1', tasks: [{ name: 'T', dependencies: [] }] } },
  nexus_update_task_status: { kind: 'write', privilege: 'nexus.task_update', args: { task_id: 't1', status: 'todo' } },
  nexus_update_project: { kind: 'write', privilege: 'nexus.task_update', args: { project_id: 'p1', status: 'paused' } },
};

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

const MUTATING = ['nexusProjectUpdate', 'nexusTaskCreate', 'nexusTasksBatchCreate', 'nexusTaskUpdate'];

let tmp;
let config;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-board-governance-'));
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
  delete process.env.PRAXIS_MIND_KEY;
  jest.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const transitions = () => (fs.existsSync(config.TRANSITION_LOG)
  ? fs.readFileSync(config.TRANSITION_LOG, 'utf8').trim().split('\n').map(JSON.parse)
  : []);

/**
 * Load both surfaces behind one module registry (so they share lib/board-ops,
 * lib/ledger and lib/ratelimit instances) and return factories per caller.
 * server/mcp.js resolves its caller at require() from PRAXIS_MIND_KEY, so it
 * is loaded once per caller through the real lib/auth and a 0600 keys file.
 */
function loadSurfaces({ backends, callers, realLedger = false }) {
  jest.resetModules();
  const keys = {};
  for (const caller of callers) keys[`key-${caller.identity}`] = caller;
  fs.writeFileSync(config.KEYS_FILE, JSON.stringify({ keys }), { mode: 0o600 });

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
  // server/mcp.js is a script that self-connects: stub the SDK and `db`.
  const db = new Proxy({}, { get: (_, prop) => jest.fn(() => { throw new Error(`server/mcp.js board tool reached db.${String(prop)} directly`); }) });
  jest.doMock('dotenv', () => ({ config: () => ({ parsed: {} }) }));
  jest.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: function T() { return {}; } }));
  jest.doMock('../../db', () => db);

  const praxisMind = (caller) => {
    const registry = makeRegistry();
    require(`${SVC}/tools/nexus`).register(registry.server, { caller });
    return registry;
  };
  const localNexus = (caller) => {
    const registry = makeRegistry();
    jest.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: function M() { return registry.server; } }));
    process.env.PRAXIS_MIND_KEY = caller ? `key-${caller.identity}` : '';
    // Fresh script instance per caller; the shared libs stay in the registry.
    delete require.cache[require.resolve('../mcp')];
    delete require.cache[require.resolve(`${SVC}/lib/auth`)];
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      require('../mcp');
    } finally {
      errSpy.mockRestore();
    }
    return registry;
  };
  return { praxisMind, localNexus, ledger: require(`${SVC}/lib/ledger`) };
}

describe('GATED — server/mcp.js board tools are identity- and privilege-gated', () => {
  test('an unauthenticated spawn is refused by all five board tools before any backend call', async () => {
    const { backends } = fakeNexus();
    const { localNexus } = loadSurfaces({ backends, callers: [] });
    const { tools } = localNexus(null);

    for (const [name, spec] of Object.entries(LOCAL_NEXUS_BOARD_TOOLS)) {
      const result = await tools.get(name).handler(spec.args);
      expect({ tool: name, isError: result.isError }).toEqual({ tool: name, isError: true });
      expect(textOf(result)).toMatch(/unauthenticated/i);
    }
    for (const fn of Object.keys(backends)) expect(backends[fn]).not.toHaveBeenCalled();
    expect(transitions()).toEqual([]);
  });

  test('a readonly credential reads but every write is refused with zero side effects', async () => {
    const { backends } = fakeNexus();
    const { localNexus } = loadSurfaces({ backends, callers: [READONLY] });
    const { tools } = localNexus(READONLY);

    for (const [name, spec] of Object.entries(LOCAL_NEXUS_BOARD_TOOLS)) {
      const result = await tools.get(name).handler(spec.args);
      if (spec.kind === 'read') {
        expect({ tool: name, isError: result.isError }).toEqual({ tool: name, isError: undefined });
      } else {
        expect({ tool: name, isError: result.isError }).toEqual({ tool: name, isError: true });
        expect(textOf(result)).toMatch(new RegExp(`lacks privilege "${spec.privilege}"`));
      }
    }
    for (const fn of MUTATING) expect(backends[fn]).not.toHaveBeenCalled();
    expect(transitions()).toEqual([]);
  });

  test('the five tool names and their schema fields are unchanged for clients', () => {
    const { backends } = fakeNexus();
    const { localNexus, praxisMind } = loadSurfaces({ backends, callers: [READONLY] });
    const local = localNexus(READONLY).tools;
    const mind = praxisMind(READONLY).tools;

    const fields = (tools, name) => Object.keys(tools.get(name).schema).sort();
    expect(fields(local, 'nexus_get_board_state')).toEqual(['project_id']);
    expect(fields(local, 'nexus_batch_create_tasks')).toEqual(['project_id', 'tasks']);
    expect(fields(local, 'nexus_update_project')).toEqual(['description', 'end_state', 'priority', 'project_id', 'status']);
    expect(fields(local, 'nexus_update_task_status')).toEqual(['note', 'status', 'task_id']);
    expect(fields(local, 'nexus_get_task')).toEqual(['task_id']);

    expect(fields(mind, 'nexus_projects_list')).toEqual([]);
    expect(fields(mind, 'nexus_tasks_read')).toEqual(['project_id', 'status']);
    expect(fields(mind, 'nexus_task_create')).toEqual(['antigravity_payload', 'dependencies', 'description', 'priority', 'project_id', 'successor_id', 'title']);
    expect(fields(mind, 'nexus_task_update')).toEqual(['antigravity_payload', 'dependencies', 'description', 'expected_status', 'expected_updated_at', 'on_conflict', 'priority', 'status', 'successor_id', 'task_id']);
    expect(fields(mind, 'nexus_project_update')).toEqual(['add_need', 'description', 'end_state', 'end_state_reason', 'expected_end_state_updated_at', 'expected_status', 'priority', 'project_id', 'resolve_need', 'status', 'upgrade_posture']);
    expect(fields(mind, 'nexus_task_status')).toEqual(['task_id']);
  });
});

describe('ONE QUOTA — both surfaces draw on the same per-identity hourly counter', () => {
  test('nexus.task_create limit is consumed by praxis-mind and Local Nexus alike', async () => {
    const { backends } = fakeNexus();
    const agent = writer('agent-a', { 'nexus.task_create': 2 });
    const { praxisMind, localNexus, ledger } = loadSurfaces({ backends, callers: [agent], realLedger: true });
    const mind = praxisMind(agent).tools;
    const local = localNexus(agent).tools;

    const viaMind = await mind.get('nexus_task_create').handler({ project_id: 'p1', title: 'one', description: '', priority: 1, dependencies: [] });
    expect(viaMind.isError).toBeUndefined();
    const viaLocal = await local.get('nexus_batch_create_tasks').handler({ project_id: 'p1', tasks: [{ name: 'two', dependencies: [] }] });
    expect(viaLocal.isError).toBeUndefined();

    // Third create on EITHER surface is over quota: one counter, one identity.
    const third = await local.get('nexus_batch_create_tasks').handler({ project_id: 'p1', tasks: [{ name: 'three', dependencies: [] }] });
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/Rate limit exceeded for nexus_task_create: 3\/2/);
    const fourth = await mind.get('nexus_task_create').handler({ project_id: 'p1', title: 'four', description: '', priority: 1, dependencies: [] });
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toMatch(/Rate limit exceeded for nexus_task_create: 4\/2/);

    expect(backends.nexusTaskCreate).toHaveBeenCalledTimes(1);
    expect(backends.nexusTasksBatchCreate).toHaveBeenCalledTimes(1);

    // The ledger attributes each call to the tool the client actually invoked.
    const rows = ledger.recent('agent-a', 10).map((r) => r.tool);
    expect(rows).toEqual(expect.arrayContaining(['nexus_task_create', 'nexus_batch_create_tasks']));
    ledger.getDb().close();
  });
});

describe('ONE AUDIT — writes from either surface share the transition log vocabulary', () => {
  test('task updates from both surfaces land as nexus_task_update records stamped with the caller', async () => {
    const { backends, tasks } = fakeNexus();
    const agent = writer('agent-a');
    const { praxisMind, localNexus } = loadSurfaces({ backends, callers: [agent] });

    const mind = praxisMind(agent).tools;
    const r1 = await mind.get('nexus_task_update').handler({ task_id: 't1', status: 'todo' });
    expect(r1.isError).toBeUndefined();
    expect(jsonOf(r1)).toMatchObject({ success: true, transaction_id: expect.any(String) });

    const local = localNexus(agent).tools;
    const r2 = await local.get('nexus_update_task_status').handler({ task_id: 't1', status: 'in_progress', note: 'picked up' });
    expect(r2.isError).toBeUndefined();
    expect(jsonOf(r2)).toMatchObject({
      success: true, task_id: 't1', previous_status: 'todo', new_status: 'in_progress', project_id: 'p1', transaction_id: expect.any(String),
    });
    // The note rides on the description, appended to what was there.
    expect(tasks.get('t1').description).toMatch(/^seed\n\n---\n\*\*\[.*\]\*\* Status → in_progress: picked up$/);

    const records = transitions();
    expect(records.map((r) => [r.tool, r.verdict, r.caller.identity])).toEqual([
      ['nexus_task_update', 'committed', 'agent-a'],
      ['nexus_task_update', 'committed', 'agent-a'],
    ]);
    expect(records[1].intent).toMatchObject({ patch: { status: 'in_progress' }, note: 'picked up' });
    expect(records[1].before.status).toBe('todo');
    expect(records[1].after.status).toBe('in_progress');
  });

  test('a batch create is one nexus_task_create record carrying every created id, with a compensation per task', async () => {
    const { backends, tasks } = fakeNexus();
    const agent = writer('agent-a');
    const { localNexus } = loadSurfaces({ backends, callers: [agent] });
    const local = localNexus(agent).tools;

    const deps = Object.freeze(['first']);
    const args = Object.freeze({
      project_id: 'p1',
      tasks: Object.freeze([
        Object.freeze({ name: 'A', stable_id: 'first', dependencies: Object.freeze([]) }),
        Object.freeze({ name: 'B', dependencies: deps }),
      ]),
    });
    const result = await local.get('nexus_batch_create_tasks').handler(args);
    expect(result.isError).toBeUndefined();
    const body = jsonOf(result);
    expect(body).toMatchObject({ success: true, project: 'Fixture', created_count: 2, transaction_id: expect.any(String) });
    expect(body.tasks.map((t) => t.name)).toEqual(['A', 'B']);
    // The placeholder resolved server-side to A's real id; caller args untouched.
    expect(body.tasks[1].dependencies).toEqual([body.tasks[0].id]);
    expect(deps).toEqual(['first']);
    expect(tasks.get(body.tasks[1].id).source).toBe('coding-agents-agent-a');

    const [record] = transitions();
    expect(record).toMatchObject({ tool: 'nexus_task_create', verdict: 'committed', caller: { identity: 'agent-a' } });
    expect(record.target).toEqual({ project_id: 'p1', task_ids: body.tasks.map((t) => t.id) });

    const { buildCompensation } = require(`${SVC}/lib/transition-log`);
    const plan = buildCompensation(record);
    expect(plan.compensation.kind).toBe('api_requests');
    expect(plan.compensation.requests.map((r) => r.path)).toEqual(
      body.tasks.map((t) => `/api/tasks/p1/tasks/${t.id}`),
    );
  });

  test('a project update from Local Nexus is a nexus_project_update record stamped with the caller', async () => {
    const { backends, projects } = fakeNexus();
    const agent = writer('agent-a');
    const { localNexus } = loadSurfaces({ backends, callers: [agent] });
    const local = localNexus(agent).tools;

    const bad = await local.get('nexus_update_project').handler({ project_id: 'p1', status: 'parked' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Invalid status 'parked'/);
    expect(backends.nexusProjectUpdate).not.toHaveBeenCalled();

    const ok = await local.get('nexus_update_project').handler({ project_id: 'p1', status: 'paused', end_state: 'shipped' });
    expect(ok.isError).toBeUndefined();
    expect(jsonOf(ok)).toMatchObject({ success: true, project: { id: 'p1', status: 'paused', end_state: 'shipped' } });
    expect(projects.get('p1')).toMatchObject({ status: 'paused', end_state: 'shipped' });
    expect(backends.nexusProjectUpdate).toHaveBeenCalledWith('p1', {
      status: 'paused', end_state: 'shipped', end_state_source: 'coding-agents-agent-a',
    });

    const [record] = transitions();
    expect(record).toMatchObject({ tool: 'nexus_project_update', verdict: 'committed', caller: { identity: 'agent-a' }, target: { project_id: 'p1' } });
  });
});

describe('ONE BACKEND — Local Nexus board tools never reach the database directly', () => {
  test('reads and a miss go through lib/backends, and a 404 still reads as not found', async () => {
    const { backends } = fakeNexus();
    const { localNexus } = loadSurfaces({ backends, callers: [READONLY] });
    const { tools } = localNexus(READONLY);

    const board = await tools.get('nexus_get_board_state').handler({ project_id: 'p1' });
    expect(jsonOf(board)[0].tasks.map((t) => t.id)).toEqual(['t1']);
    expect(backends.nexusBoardState).toHaveBeenCalledWith('p1');

    const task = await tools.get('nexus_get_task').handler({ task_id: 't1' });
    expect(jsonOf(task).id).toBe('t1');

    const miss = await tools.get('nexus_get_task').handler({ task_id: 'nope' });
    expect(miss.isError).toBe(true);
    expect(textOf(miss)).toBe("Task 'nope' not found.");

    const empty = await tools.get('nexus_get_board_state').handler({ project_id: 'nope' });
    expect(empty.isError).toBe(false);
    expect(textOf(empty)).toBe("No project found with ID 'nope'.");
  });

  test('server/mcp.js board handlers reference boardOps, not db', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'mcp.js'), 'utf8');
    const start = source.indexOf('// EXECUTIVE PLANNING TOOLS');
    const end = source.indexOf('* git_get_diff');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const boardSection = source.slice(start, end);
    expect(boardSection).not.toMatch(/\bdb\./);
    for (const op of ['boardState', 'createTasks', 'updateProject', 'updateTask', 'getTask']) {
      expect(boardSection).toMatch(new RegExp(`boardOps\\.${op}\\(boardCtx`));
    }
  });
});
