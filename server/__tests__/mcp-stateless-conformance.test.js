/**
 * Stateless MCP conformance suite (Nexus task 72cfe3f1).
 *
 * The Upgrade Council's 2026-08-10 slate routed one architectural rule at
 * The Nexus: "keep handlers request-scoped while durable dispatch state
 * remains service-owned". This file turns that sentence into enforceable
 * invariants over the two MCP servers this repo actually ships:
 *
 *   - server/mcp.js                     — the "Local Nexus" stdio MCP server
 *   - services/praxis-mind-mcp/tools/*  — the praxis-mind MCP server
 *
 * The invariants, each with a test below:
 *
 *   C1 REGISTRATION   Every tool has a unique, protocol-legal name, an object
 *                     input schema, and an async handler.
 *   C2 REPEATABLE     Same request + same store => same response. Handlers
 *                     accumulate nothing between calls.
 *   C3 NO-CROSSTALK   Interleaving other tools between two identical requests
 *                     does not change the second response.
 *   C4 CONCURRENT     N in-flight requests each get the response for their own
 *                     arguments — no shared per-request scratch space.
 *   C5 STORE-OWNED    Reads always re-read the store (a live instance never
 *                     serves a cached row), and writes land in the store, where
 *                     a fresh module instance can see them.
 *   C6 ERROR-BOUNDARY A backend failure becomes an MCP error result, not a
 *                     throw, and does not poison the next request.
 *   C7 ARGS-IMMUTABLE Handlers do not mutate caller-owned request arguments.
 *   C8 NO-MODULE-STATE No module-scope mutable containers in the request-
 *                     handling surfaces.
 *   C9 PER-CALLER     praxis-mind authorization is decided from the per-request
 *                     caller context, never from ambient/module state, and an
 *                     unauthorized request never reaches a backend.
 *
 * Plus one KNOWN GAP characterization test (server/routes/mcp-inline.js) that
 * pins the one surface which is *not* conformant today, so the fix has a test
 * to flip rather than a comment to find.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

// MCP tool-name rule (spec: tool names are opaque but clients key on them;
// the SDK and every shipping client accept this character class).
const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// ─── Tool registry harness ────────────────────────────────────────────────
// Stands in for McpServer. Accepts both registration arities used in this
// repo: tool(name, schema, handler) and tool(name, description, schema, handler).

function makeRegistry() {
  const tools = new Map();
  const duplicates = [];
  const resources = new Map();
  const server = {
    tool(...args) {
      // Schema and handler are always the last two arguments, which absorbs
      // both the 3-arity and the described 4-arity form.
      const name = args[0];
      const handler = args[args.length - 1];
      const schema = args[args.length - 2];
      if (tools.has(name)) duplicates.push(name);
      tools.set(name, { name, schema, handler });
    },
    resource(name, uri, handler) {
      resources.set(name, { name, uri, handler });
    },
    async connect() {},
  };
  return { tools, resources, duplicates, server };
}

// ─── The store: everything server/mcp.js is allowed to remember ───────────
// Deliberately injected, so "did the handler cache this?" is answerable by
// swapping the store underneath a fresh module instance.

function makeStore(seed = {}) {
  const projects = new Map(Object.entries(seed.projects || {}));
  const tasks = new Map(Object.entries(seed.tasks || {}));
  // One-shot fault injection for C6, keyed by db method.
  const hooks = { getTask: null };

  return {
    __projects: projects,
    __tasks: tasks,
    __hooks: hooks,

    getProjects: async () => [...projects.values()],
    getProject: async (id) => {
      const p = projects.get(id);
      return p ? { ...p } : null;
    },
    getTask: async (id) => {
      if (hooks.getTask) {
        const hook = hooks.getTask;
        hooks.getTask = null;
        await hook(id);
      }
      const t = tasks.get(id);
      return t ? { ...t } : null;
    },
    updateTask: async (id, updates) => {
      const cur = tasks.get(id) || { id };
      const next = { ...cur, ...updates };
      tasks.set(id, next);
      return { ...next };
    },
    batchCreateTasks: async (batch) => {
      for (const t of batch) tasks.set(t.id, { ...t });
      return batch.map((t) => ({ ...t }));
    },
    getBoardState: async (projectId) => {
      const list = [...projects.values()].filter((p) => !projectId || p.id === projectId);
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        tasks: [...tasks.values()].filter((t) => t.project_id === p.id).map((t) => ({ ...t })),
      }));
    },
    getUsageStats: async () => [
      { model: 'test-model', source: 'praxis', total_tokens: 100, input_tokens: 60, output_tokens: 40, request_count: 2 },
    ],
    getQuota: async () => null,
    getModels: async () => [{ id: 'test-model', name: 'Test', provider: 'test', is_default: true }],
  };
}

// ─── Loader: server/mcp.js under a stubbed SDK + stubbed store ────────────
// mcp.js is a script (it self-invokes main()), so the SDK transport is stubbed
// out and registration is captured as it happens during require().

function loadNexusMcp(store) {
  jest.resetModules();
  const registry = makeRegistry();
  jest.doMock('dotenv', () => ({ config: () => ({ parsed: {} }) }));
  jest.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: function McpServer() {
      return registry.server;
    },
  }));
  jest.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: function StdioServerTransport() {
      return {};
    },
  }));
  jest.doMock('../../db', () => store);
  require('../mcp');
  return registry;
}

function textOf(result) {
  return result.content.map((c) => c.text).join('\n');
}

function jsonOf(result) {
  return JSON.parse(textOf(result));
}

const SEED = () => ({
  projects: {
    'proj-1': { id: 'proj-1', name: 'Praxis', status: 'active', priority: 2, path: '/tmp/praxis' },
  },
  tasks: {
    'task-1': { id: 'task-1', project_id: 'proj-1', name: 'Seeded task', status: 'todo', description: 'seed' },
    'task-2': { id: 'task-2', project_id: 'proj-1', name: 'Other task', status: 'idea', description: 'seed' },
  },
});

describe('Local Nexus MCP server (server/mcp.js) — stateless request boundary', () => {
  let errSpy;

  beforeEach(() => {
    // main() logs "running on stdio" to stderr after require() resolves.
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    jest.resetModules();
  });

  test('C1 every tool registers with a unique, protocol-legal name, an object schema and an async handler', () => {
    const { tools, duplicates } = loadNexusMcp(makeStore(SEED()));

    expect(duplicates).toEqual([]);
    expect(tools.size).toBeGreaterThan(0);

    for (const [name, tool] of tools) {
      expect(name).toMatch(MCP_TOOL_NAME);
      expect(typeof tool.handler).toBe('function');
      // House rule: handlers are `async`, so a thrown error inside one always
      // becomes a rejected promise the SDK can turn into an MCP error result
      // rather than an exception that escapes the request boundary.
      expect(tool.handler.constructor.name).toBe('AsyncFunction');
      expect(tool.schema).toBeInstanceOf(Object);
      expect(Array.isArray(tool.schema)).toBe(false);
      // Every declared field must be a zod schema, so the SDK can build a
      // per-request JSON Schema instead of trusting the caller's shape.
      for (const field of Object.values(tool.schema)) {
        expect(typeof field.parse).toBe('function');
      }
    }
  });

  test('C1 resources are addressed by URI and answered by a request-scoped handler', async () => {
    const store = makeStore(SEED());
    const { resources } = loadNexusMcp(store);

    expect(resources.size).toBeGreaterThan(0);
    for (const [, resource] of resources) {
      expect(typeof resource.uri).toBe('string');
      expect(resource.uri).toMatch(/^[a-z][a-z0-9+.-]*:\/\//);
      expect(resource.handler.constructor.name).toBe('AsyncFunction');
    }

    // The resource reads through the store on every request, like the tools do.
    const uri = new URL(resources.get('projects').uri);
    const before = await resources.get('projects').handler(uri);
    store.__projects.set('proj-2', { id: 'proj-2', name: 'Second', status: 'active' });
    const after = await resources.get('projects').handler(uri);

    expect(JSON.parse(before.contents[0].text)).toHaveLength(1);
    expect(JSON.parse(after.contents[0].text)).toHaveLength(2);
  });

  test('C2 identical requests against an unchanged store return identical responses', async () => {
    const { tools } = loadNexusMcp(makeStore(SEED()));

    const first = await tools.get('nexus_get_board_state').handler({});
    const second = await tools.get('nexus_get_board_state').handler({});
    expect(second).toEqual(first);

    const t1 = await tools.get('nexus_get_task').handler({ task_id: 'task-1' });
    const t2 = await tools.get('nexus_get_task').handler({ task_id: 'task-1' });
    expect(t2).toEqual(t1);
  });

  test('C3 interleaving other tools does not change a repeated response', async () => {
    const { tools } = loadNexusMcp(makeStore(SEED()));

    const before = await tools.get('nexus_get_board_state').handler({ project_id: 'proj-1' });
    // A hit, a miss, and a tool that touches an entirely different table.
    // (nexus_get_system_resources stamps assessed_at, so it is used as an
    // interleaver here rather than compared across calls.)
    await tools.get('nexus_get_task').handler({ task_id: 'task-2' });
    await tools.get('nexus_get_task').handler({ task_id: 'does-not-exist' });
    await tools.get('nexus_get_system_resources').handler({});
    const after = await tools.get('nexus_get_board_state').handler({ project_id: 'proj-1' });

    expect(after).toEqual(before);
  });

  test('C4 concurrent requests each receive the response for their own arguments', async () => {
    const store = makeStore(SEED());
    // Resolve out of order: task-1 is slowest, so a shared scratch buffer would
    // hand task-1's caller task-2's row.
    const delays = { 'task-1': 30, 'task-2': 5 };
    const inner = store.getTask;
    store.getTask = async (id) => {
      await new Promise((r) => setTimeout(r, delays[id] ?? 0));
      return inner(id);
    };

    const { tools } = loadNexusMcp(store);
    const getTask = tools.get('nexus_get_task').handler;

    const [a, b, c] = await Promise.all([
      getTask({ task_id: 'task-1' }),
      getTask({ task_id: 'task-2' }),
      getTask({ task_id: 'task-1' }),
    ]);

    expect(jsonOf(a).id).toBe('task-1');
    expect(jsonOf(b).id).toBe('task-2');
    expect(jsonOf(c).id).toBe('task-1');
    expect(a).toEqual(c);
  });

  test('C5 every read re-reads the store — a live instance never serves a cached row', async () => {
    const store = makeStore(SEED());
    const { tools } = loadNexusMcp(store);
    const getTask = tools.get('nexus_get_task').handler;

    expect(jsonOf(await getTask({ task_id: 'task-1' })).status).toBe('todo');

    // Another writer (another MCP spawn, the HTTP API, Robert) changes the row
    // out from under this instance. The *same live instance* must observe it:
    // an in-process cache would still answer "todo" here.
    store.__tasks.set('task-1', { ...store.__tasks.get('task-1'), status: 'completed' });
    expect(jsonOf(await getTask({ task_id: 'task-1' })).status).toBe('completed');

    // ...and a deletion must surface as a miss, not as a warm cache hit.
    store.__tasks.delete('task-1');
    const miss = await getTask({ task_id: 'task-1' });
    expect(miss.isError).toBe(true);
    expect(textOf(miss)).toMatch(/not found/i);
  });

  test('C5 a write is owned by the store and visible to a fresh module instance', async () => {
    const store = makeStore(SEED());
    const writer = loadNexusMcp(store);

    const write = await writer.tools.get('nexus_update_task_status').handler({
      task_id: 'task-1',
      status: 'completed',
    });
    expect(jsonOf(write)).toMatchObject({
      success: true,
      previous_status: 'todo',
      new_status: 'completed',
    });
    // The effect landed in the store, not in the handler.
    expect(store.__tasks.get('task-1').status).toBe('completed');

    // A brand-new module instance (a new MCP spawn) pointed at the same store
    // sees the write; pointed at an empty store it sees nothing. Together these
    // rule out state parked outside the module registry (globals, process env).
    const reader = loadNexusMcp(store);
    expect(jsonOf(await reader.tools.get('nexus_get_task').handler({ task_id: 'task-1' })).status)
      .toBe('completed');

    const cold = loadNexusMcp(makeStore());
    const coldMiss = await cold.tools.get('nexus_get_task').handler({ task_id: 'task-1' });
    expect(coldMiss.isError).toBe(true);
  });

  test('C6 a backend failure returns an MCP error result and does not poison the next request', async () => {
    const store = makeStore(SEED());
    const { tools } = loadNexusMcp(store);
    const getTask = tools.get('nexus_get_task').handler;

    store.__hooks.getTask = async () => {
      throw new Error('sqlite is busy');
    };

    const failed = await getTask({ task_id: 'task-1' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/sqlite is busy/);

    const recovered = await getTask({ task_id: 'task-1' });
    expect(recovered.isError).toBeUndefined();
    expect(jsonOf(recovered).id).toBe('task-1');
  });

  test('C7 handlers do not mutate caller-owned request arguments', async () => {
    const store = makeStore(SEED());
    const { tools } = loadNexusMcp(store);

    const dependencies = Object.freeze(['task-1']);
    const taskArg = Object.freeze({
      name: 'Child task',
      stable_id: 'batch-a',
      dependencies,
    });
    const args = Object.freeze({ project_id: 'proj-1', tasks: Object.freeze([taskArg]) });

    const result = await tools.get('nexus_batch_create_tasks').handler(args);

    expect(result.isError).toBeUndefined();
    expect(jsonOf(result).created_count).toBe(1);
    // The caller's objects came back untouched: no stripped stable_id, no
    // rewritten dependency array.
    expect(taskArg.stable_id).toBe('batch-a');
    expect(taskArg.dependencies).toBe(dependencies);
    expect(dependencies).toEqual(['task-1']);
  });
});

describe('MCP request surfaces — no module-scope mutable state (C8)', () => {
  // lib/ modules are excluded on purpose: they hold deliberate process-lifetime
  // config/connection caches (e.g. lib/auth's keys-file memo). What must stay
  // clean is the request-handling surface — the files that answer MCP calls.
  const REPO = path.resolve(__dirname, '..', '..');
  const SURFACES = [
    path.join(REPO, 'server', 'mcp.js'),
    ...fs.readdirSync(path.join(REPO, 'services', 'praxis-mind-mcp', 'tools'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(REPO, 'services', 'praxis-mind-mcp', 'tools', f)),
  ];

  // Ratchet, not amnesty. Each entry is a module-scope binding that is mutable
  // but provably not request- or caller-derived; anything new fails until it is
  // either made request-scoped or added here with a reason.
  const ALLOWED_MODULE_STATE = {
    'services/praxis-mind-mcp/tools/vault.js': {
      // Process-lifetime probe of whether the `rg` binary exists. Carries no
      // request or caller data; the worst cross-request effect is skipping a
      // repeat PATH lookup.
      ripgrepValidated: 'environment capability probe, memoized once per spawn',
    },
  };

  const relLabel = (f) => path.relative(REPO, f).split(path.sep).join('/');

  test.each(SURFACES.map((f) => [relLabel(f), f]))(
    '%s declares no module-scope mutable state',
    (label, file) => {
      const source = fs.readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const allowed = ALLOWED_MODULE_STATE[label] || {};
      const offenders = [];

      const mutates = (name) => new RegExp(
        `\\b${name}\\.(set|add|delete|clear|push|pop|shift|unshift|splice|sort|reverse|fill)\\s*\\(`,
      ).test(source) || new RegExp(`^\\s*${name}\\s*(=|\\+\\+|--|\\+=|-=)`, 'm').test(source);

      lines.forEach((line, i) => {
        // Column 0 => module scope. Indented declarations live inside a
        // function, i.e. they are already request-scoped.
        const rebindable = /^(?:let|var)\s+(\w+)/.exec(line);
        if (rebindable && !(rebindable[1] in allowed)) {
          offenders.push(`${i + 1}: ${line.trim()}`);
          return;
        }
        // A `const` container is only state if the module actually mutates it;
        // frozen-by-convention lookup tables (Set of allowed filenames, etc.)
        // are configuration, not state.
        const container = /^const\s+(\w+)\s*=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(|\[|\{)/.exec(line);
        if (container && !(container[1] in allowed) && mutates(container[1])) {
          offenders.push(`${i + 1}: ${line.trim()}`);
        }
      });

      expect(offenders).toEqual([]);
    },
  );

  test('the suite actually scans both MCP servers', () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(2);
    expect(SURFACES.some((f) => f.endsWith(path.join('server', 'mcp.js')))).toBe(true);
    expect(SURFACES.some((f) => f.includes('praxis-mind-mcp'))).toBe(true);
  });

  test('the allowlist only names bindings that still exist', () => {
    // Keeps the ratchet honest: once a memo is removed, its entry must go too.
    for (const [label, bindings] of Object.entries(ALLOWED_MODULE_STATE)) {
      const source = fs.readFileSync(path.join(REPO, label), 'utf8');
      for (const name of Object.keys(bindings)) {
        expect(source).toMatch(new RegExp(`^(?:let|var|const)\\s+${name}\\b`, 'm'));
      }
    }
  });
});

// ─── praxis-mind MCP server: per-request caller identity ──────────────────

// Returns the tool module's `register` so a single module instance can serve
// several callers — the only way to prove identity is not module-level.
function loadPraxisMindNexusTools(backends) {
  jest.resetModules();
  jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => backends);
  jest.doMock('../../services/praxis-mind-mcp/lib/ledger', () => ({ record: jest.fn() }));
  const { register } = require('../../services/praxis-mind-mcp/tools/nexus');
  return (ctx) => {
    const registry = makeRegistry();
    register(registry.server, ctx);
    return registry;
  };
}

describe('praxis-mind MCP server — authorization is per-request, never ambient (C9)', () => {
  const PRIVILEGED = { identity: 'agent-a', namespace: 'ns-a', privileges: ['nexus.projects_list'] };
  const UNPRIVILEGED = { identity: 'agent-b', namespace: 'ns-b', privileges: [] };

  afterEach(() => {
    jest.resetModules();
    delete process.env.PRAXIS_MIND_KEY;
  });

  test('two servers registered with different callers do not share privileges', async () => {
    const backends = { nexusProjects: jest.fn(async () => [{ id: 'p1', name: 'Praxis' }]) };
    const serverFor = loadPraxisMindNexusTools(backends);

    const allowed = serverFor({ caller: PRIVILEGED });
    const denied = serverFor({ caller: UNPRIVILEGED });

    // Interleave so a module-level "current caller" would leak between them.
    const ok1 = await allowed.tools.get('nexus_projects_list').handler({});
    const no1 = await denied.tools.get('nexus_projects_list').handler({});
    const ok2 = await allowed.tools.get('nexus_projects_list').handler({});

    expect(ok1.isError).toBeUndefined();
    expect(ok2).toEqual(ok1);
    expect(no1.isError).toBe(true);
    expect(textOf(no1)).toMatch(/agent-b.*lacks privilege.*nexus\.projects_list/);
    // The refused request never reached the backend.
    expect(backends.nexusProjects).toHaveBeenCalledTimes(2);
  });

  test('an unauthenticated context is refused before any backend call', async () => {
    const backends = { nexusProjects: jest.fn(async () => []) };
    const { tools } = loadPraxisMindNexusTools(backends)({ caller: null });

    const result = await tools.get('nexus_projects_list').handler({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unauthenticated/i);
    expect(backends.nexusProjects).not.toHaveBeenCalled();
  });

  test('resolveCaller reads identity from the request environment, with no sticky caller', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-conformance-keys-'));
    const keysFile = path.join(dir, 'keys.json');
    fs.writeFileSync(keysFile, JSON.stringify({
      keys: {
        'key-a': { identity: 'agent-a', namespace: 'ns-a', privileges: ['identity.whoami'] },
        'key-b': { identity: 'agent-b', namespace: 'ns-b', privileges: [] },
      },
    }));

    try {
      jest.resetModules();
      jest.doMock('../../services/praxis-mind-mcp/lib/config', () => ({ KEYS_FILE: keysFile }));
      jest.doMock('../../services/praxis-mind-mcp/lib/log', () => ({ log: () => {} }));
      const { resolveCaller } = require('../../services/praxis-mind-mcp/lib/auth');

      process.env.PRAXIS_MIND_KEY = 'key-a';
      expect(resolveCaller().identity).toBe('agent-a');

      process.env.PRAXIS_MIND_KEY = 'key-b';
      expect(resolveCaller().identity).toBe('agent-b');

      process.env.PRAXIS_MIND_KEY = 'not-a-key';
      expect(resolveCaller()).toBeNull();

      delete process.env.PRAXIS_MIND_KEY;
      expect(resolveCaller()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── The one non-conformant surface ───────────────────────────────────────

function listen(app) {
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(handle) {
  for (const s of handle.sockets) s.destroy();
  return new Promise((resolve) => handle.server.close(resolve));
}

function mountMcpInline() {
  const router = require('../routes/mcp-inline');
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', router);
  return app;
}

describe('KNOWN GAP — /api/mcp/servers registry is process-local, not service-owned', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.resetModules();
  });

  // server/routes/mcp-inline.js stores registered MCP servers in a module-level
  // Map ("In-memory storage (production will use database)"). That violates the
  // "durable state stays service-owned" half of the boundary: a Nexus restart
  // silently drops every registration. This test pins the current behaviour so
  // the durability fix has a red test to flip, rather than a comment to find.
  test('registrations survive within a process but are lost when the module is reloaded', async () => {
    jest.resetModules();
    const first = await listen(mountMcpInline());
    try {
      const created = await fetch(`${first.baseUrl}/api/mcp/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'conformance-probe' }),
      });
      expect(created.status).toBe(201);

      const listed = await (await fetch(`${first.baseUrl}/api/mcp/servers`)).json();
      expect(listed.servers.map((s) => s.name)).toContain('conformance-probe');
    } finally {
      await close(first);
    }

    // Simulate a restart: fresh module registry, same route code.
    jest.resetModules();
    const second = await listen(mountMcpInline());
    try {
      const listed = await (await fetch(`${second.baseUrl}/api/mcp/servers`)).json();
      // Durable, service-owned state would still list the probe here.
      expect(listed.servers).toEqual([]);
    } finally {
      await close(second);
    }
  });
});
