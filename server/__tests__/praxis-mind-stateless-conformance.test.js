/**
 * Stateless MCP conformance — praxis-mind surface (ported from
 * mcp-stateless-conformance.test.js when server/mcp.js was retired, M-1
 * 2026-09-04; the original, including its C1-C7 invariants over the retired
 * "Local Nexus" server, lives in
 * /Volumes/Projects/Backup/TheNexus-server-mcp-2026-09-04/).
 *
 * The Upgrade Council's 2026-08-10 rule for The Nexus — "keep handlers
 * request-scoped while durable dispatch state remains service-owned" — now
 * has one MCP server to hold to: services/praxis-mind-mcp/tools/*. The
 * invariants kept here are the ones that were about that surface:
 *
 *   C8 NO-MODULE-STATE No module-scope mutable containers in the request-
 *                     handling surfaces.
 *   C9 PER-CALLER     Authorization is decided from the per-request caller
 *                     context, never from ambient/module state, and an
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

const SVC = '../../services/praxis-mind-mcp';

function makeRegistry() {
  const tools = new Map();
  const server = {
    tool(...args) {
      tools.set(args[0], { name: args[0], schema: args[args.length - 2], handler: args[args.length - 1] });
    },
    resource() {},
    async connect() {},
  };
  return { tools, server };
}

function textOf(result) {
  return result.content.map((c) => c.text).join('\n');
}

describe('MCP request surfaces — no module-scope mutable state (C8)', () => {
  // lib/ modules are excluded on purpose: they hold deliberate process-lifetime
  // config/connection caches (e.g. lib/auth's keys-file memo). What must stay
  // clean is the request-handling surface — the files that answer MCP calls.
  const REPO = path.resolve(__dirname, '..', '..');
  const TOOLS_DIR = path.join(REPO, 'services', 'praxis-mind-mcp', 'tools');
  const SURFACES = fs.readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(TOOLS_DIR, f));

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

  test('the suite actually scans every praxis-mind tool module', () => {
    const labels = SURFACES.map(relLabel);
    for (const group of ['identity', 'vault', 'memory', 'brain', 'nexus']) {
      expect(labels).toContain(`services/praxis-mind-mcp/tools/${group}.js`);
    }
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
  jest.doMock(`${SVC}/lib/backends`, () => backends);
  jest.doMock(`${SVC}/lib/ledger`, () => ({ record: jest.fn() }));
  const { register } = require(`${SVC}/tools/nexus`);
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
    // 0600, or lib/auth's scoped-credential self-check refuses the file.
    fs.writeFileSync(keysFile, JSON.stringify({
      keys: {
        'key-a': { identity: 'agent-a', namespace: 'ns-a', privileges: ['identity.whoami'] },
        'key-b': { identity: 'agent-b', namespace: 'ns-b', privileges: [] },
      },
    }), { mode: 0o600 });

    try {
      jest.resetModules();
      jest.doMock(`${SVC}/lib/config`, () => ({ KEYS_FILE: keysFile }));
      jest.doMock(`${SVC}/lib/log`, () => ({ log: () => {} }));
      const { resolveCaller } = require(`${SVC}/lib/auth`);

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
