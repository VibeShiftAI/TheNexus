/**
 * server/mcp.js non-board tools are identity- and privilege-gated (H-1).
 *
 * P1-15 put the five board tools behind praxis-mind's governed board-ops
 * (mcp-board-governance.test.js). The other six tools — scaffold_new_vibe,
 * init_git, add_remote, commit_and_push, git_get_diff,
 * nexus_get_system_resources — were still ungated, which is what the threat
 * model's G11 / MG-5 called out. This suite pins the gate on each of them:
 *
 *   REFUSED   an unauthenticated spawn (no/invalid PRAXIS_MIND_KEY) and a
 *             caller lacking the specific privilege are refused before the
 *             handler touches the filesystem, git, npm or the database.
 *   ALLOWED   a caller holding the privilege runs the real handler body
 *             (git/npm stubbed) and gets the tool's normal result.
 *   UNCHANGED tool names and schema fields are what clients already see.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SVC = '../../services/praxis-mind-mcp';

// Tool -> the privilege it must be gated on, plus arguments that would have a
// side effect if the gate were missing.
const NON_BOARD_TOOLS = {
  scaffold_new_vibe: { privilege: 'nexus.scaffold', args: { name: 'Gated', type: 'tool' } },
  init_git: { privilege: 'nexus.git_write', args: { project_name: 'p1' } },
  add_remote: { privilege: 'nexus.git_write', args: { project_name: 'p1', remote_url: 'git@github.com:u/r.git' } },
  commit_and_push: { privilege: 'nexus.git_write', args: { project_name: 'p1', message: 'm', force: true } },
  git_get_diff: { privilege: 'nexus.git_read', args: { project_path: '/set-per-test' } },
  nexus_get_system_resources: { privilege: 'nexus.system_read', args: {} },
};
const ALL_PRIVILEGES = [...new Set(Object.values(NON_BOARD_TOOLS).map((t) => t.privilege))];

const textOf = (result) => result.content.map((c) => c.text).join('\n');

let tmp;
let projectDir;
let db;
let git;
let execSync;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tool-gating-'));
  projectDir = path.join(tmp, 'p1');
  fs.mkdirSync(projectDir, { recursive: true });
  process.env.PROJECT_ROOT = path.join(tmp, 'root');

  db = {
    getProject: jest.fn(async (id) => (id === 'p1' ? { id: 'p1', name: 'P1', path: projectDir } : null)),
    getTasks: jest.fn(async () => []),
    isDatabaseEnabled: jest.fn(() => true),
    upsertProject: jest.fn(async () => ({})),
    getUsageStats: jest.fn(async () => [{ model: 'm', source: 'praxis', total_tokens: 10, input_tokens: 4, output_tokens: 6, request_count: 1 }]),
    getQuota: jest.fn(async () => null),
    getModels: jest.fn(async () => []),
    getProjects: jest.fn(async () => []),
  };
  git = {
    init: jest.fn(async () => {}),
    getRemotes: jest.fn(async () => []),
    addRemote: jest.fn(async () => {}),
    remote: jest.fn(async () => {}),
    add: jest.fn(async () => {}),
    status: jest.fn(async () => ({ files: [{ path: 'a.txt' }], current: 'main' })),
    commit: jest.fn(async () => {}),
    push: jest.fn(async () => {}),
  };
  execSync = jest.fn((cmd) => (cmd.startsWith('git diff') ? 'diff --git a/x b/x\n+line\n' : ''));
});

afterEach(() => {
  delete process.env.PRAXIS_MIND_KEY;
  delete process.env.PROJECT_ROOT;
  jest.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Load server/mcp.js as a fresh script instance for one caller. Identity goes
 * through the real lib/auth against a 0600 keys file, exactly as a spawn does;
 * the SDK, `db`, simple-git and child_process are stubbed so an ALLOWED call
 * exercises the handler body without touching a real repo.
 */
function loadLocalNexus(caller) {
  jest.resetModules();
  const keysFile = path.join(tmp, 'keys.json');
  const keys = caller ? { [`key-${caller.identity}`]: caller } : {};
  fs.writeFileSync(keysFile, JSON.stringify({ keys }), { mode: 0o600 });
  process.env.PRAXIS_MIND_KEY = caller ? `key-${caller.identity}` : '';

  const tools = new Map();
  const registry = {
    tool(...args) { tools.set(args[0], { handler: args[args.length - 1], schema: args[args.length - 2] }); },
    resource() {},
    async connect() {},
  };
  jest.doMock(`${SVC}/lib/log`, () => ({ log: () => {} }));
  jest.doMock(`${SVC}/lib/config`, () => ({
    VAULT: tmp, KEYS_FILE: keysFile, LEDGER_DB: ':memory:', TRANSITION_LOG: path.join(tmp, 't.jsonl'), NEXUS: 'http://127.0.0.1:9',
  }));
  jest.doMock(`${SVC}/lib/ledger`, () => ({ record: jest.fn(), costSince: () => 0, recent: () => [] }));
  jest.doMock(`${SVC}/lib/ratelimit`, () => ({ checkAndIncrement: () => ({ allowed: true, count: 0, limit: Infinity }) }));
  jest.doMock(`${SVC}/lib/lock-health`, () => ({ record: jest.fn(), gauge: () => null, formatGauge: () => '' }));
  jest.doMock('dotenv', () => ({ config: () => ({ parsed: {} }) }));
  jest.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: function T() { return {}; } }));
  jest.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: function M() { return registry; } }));
  jest.doMock('../../db', () => db);
  jest.doMock('simple-git', () => jest.fn(() => git));
  jest.doMock('child_process', () => ({ execSync }));

  const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    require('../mcp');
  } finally {
    errSpy.mockRestore();
  }
  return tools;
}

const argsFor = (name) => {
  const args = { ...NON_BOARD_TOOLS[name].args };
  if (name === 'git_get_diff') args.project_path = projectDir;
  return args;
};

function expectNoSideEffects() {
  for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
  for (const fn of Object.values(git)) expect(fn).not.toHaveBeenCalled();
  expect(execSync).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(process.env.PROJECT_ROOT, 'Gated'))).toBe(false);
}

describe('REFUSED — every non-board tool refuses before any side effect', () => {
  test('an unauthenticated spawn is refused by all six tools', async () => {
    const tools = loadLocalNexus(null);
    fs.mkdirSync(path.join(projectDir, '.git'));
    for (const name of Object.keys(NON_BOARD_TOOLS)) {
      const result = await tools.get(name).handler(argsFor(name));
      expect({ tool: name, isError: result.isError }).toEqual({ tool: name, isError: true });
      expect(textOf(result)).toMatch(/unauthenticated/i);
    }
    expectNoSideEffects();
  });

  test('a registered caller without the privilege is refused per tool, naming the privilege', async () => {
    // Full board-writer rights, none of the non-board privileges: the board
    // privileges must not leak into the filesystem/git tools.
    const boardOnly = {
      identity: 'board-only',
      namespace: 'coding-agents-board-only',
      privileges: ['nexus.projects_list', 'nexus.tasks_read', 'nexus.task_status', 'nexus.task_create', 'nexus.task_update', 'nexus.project_update'],
    };
    const tools = loadLocalNexus(boardOnly);
    fs.mkdirSync(path.join(projectDir, '.git'));
    for (const [name, spec] of Object.entries(NON_BOARD_TOOLS)) {
      const result = await tools.get(name).handler(argsFor(name));
      expect({ tool: name, isError: result.isError }).toEqual({ tool: name, isError: true });
      expect(textOf(result)).toMatch(new RegExp(`lacks privilege "${spec.privilege}"`));
    }
    expectNoSideEffects();
  });

  test('each privilege unlocks only its own tools', async () => {
    fs.mkdirSync(path.join(projectDir, '.git'));
    for (const privilege of ALL_PRIVILEGES) {
      const tools = loadLocalNexus({ identity: `only-${privilege}`, namespace: 'x', privileges: [privilege] });
      for (const [name, spec] of Object.entries(NON_BOARD_TOOLS)) {
        const result = await tools.get(name).handler(argsFor(name));
        const refused = result.isError === true && /lacks privilege/.test(textOf(result));
        expect({ privilege, tool: name, refused }).toEqual({ privilege, tool: name, refused: spec.privilege !== privilege });
      }
    }
  });
});

describe('ALLOWED — a caller holding the privilege runs the real handler', () => {
  const operator = { identity: 'operator', namespace: 'coding-agents-operator', privileges: ALL_PRIVILEGES };

  test('scaffold_new_vibe creates the directory, the DB row, and runs npm + git init', async () => {
    const tools = loadLocalNexus(operator);
    const result = await tools.get('scaffold_new_vibe').handler({ name: 'Gated', type: 'tool' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/Successfully created project 'Gated' \(tool\)/);
    expect(fs.existsSync(path.join(process.env.PROJECT_ROOT, 'Gated'))).toBe(true);
    expect(db.upsertProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gated', type: 'tool' }));
    expect(execSync).toHaveBeenCalledWith('npm init -y', expect.objectContaining({ cwd: path.join(process.env.PROJECT_ROOT, 'Gated') }));
    expect(git.init).toHaveBeenCalledTimes(1);
  });

  test('init_git initialises git in the project', async () => {
    const tools = loadLocalNexus(operator);
    const result = await tools.get('init_git').handler({ project_name: 'p1' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/Successfully initialized git in 'P1'/);
    expect(git.init).toHaveBeenCalledTimes(1);
  });

  test('add_remote adds origin', async () => {
    fs.mkdirSync(path.join(projectDir, '.git'));
    const tools = loadLocalNexus(operator);
    const result = await tools.get('add_remote').handler({ project_name: 'p1', remote_url: 'git@github.com:u/r.git' });
    expect(result.isError).toBeUndefined();
    expect(git.addRemote).toHaveBeenCalledWith('origin', 'git@github.com:u/r.git');
  });

  test('commit_and_push stages and commits', async () => {
    fs.mkdirSync(path.join(projectDir, '.git'));
    const tools = loadLocalNexus(operator);
    const result = await tools.get('commit_and_push').handler({ project_name: 'p1', message: 'gated commit', force: true });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toMatch(/Committed 1 file\(s\) in 'P1', but no remote configured/);
    expect(git.add).toHaveBeenCalledWith('.');
    expect(git.commit).toHaveBeenCalledWith('gated commit');
  });

  test('git_get_diff returns the workspace diff', async () => {
    fs.mkdirSync(path.join(projectDir, '.git'));
    const tools = loadLocalNexus(operator);
    const result = await tools.get('git_get_diff').handler({ project_path: projectDir });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/=== MODIFIED FILES \(git diff HEAD\) ===/);
    expect(execSync).toHaveBeenCalledWith('git diff HEAD', expect.objectContaining({ cwd: projectDir }));
  });

  test('nexus_get_system_resources reports the budget', async () => {
    const tools = loadLocalNexus(operator);
    const result = await tools.get('nexus_get_system_resources').handler({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({ praxis_tokens_today: 10, tokens_used_today: 10, budget_status: 'safe' });
  });
});

describe('UNCHANGED — names, schemas and the privilege vocabulary', () => {
  test('the six tool names and their schema fields are what clients already see', () => {
    const tools = loadLocalNexus(null);
    const fields = (name) => Object.keys(tools.get(name).schema).sort();
    expect(fields('scaffold_new_vibe')).toEqual(['name', 'type']);
    expect(fields('init_git')).toEqual(['project_name']);
    expect(fields('add_remote')).toEqual(['project_name', 'remote_url']);
    expect(fields('commit_and_push')).toEqual(['force', 'message', 'project_name']);
    expect(fields('git_get_diff')).toEqual(['project_path']);
    expect(fields('nexus_get_system_resources')).toEqual([]);
  });

  test('every privilege the gates use is in lib/auth PRIVILEGES, and every checkPrivilege() in mcp.js uses a listed name', () => {
    jest.resetModules();
    const { PRIVILEGES } = require(`${SVC}/lib/auth`);
    for (const p of ALL_PRIVILEGES) expect(PRIVILEGES).toContain(p);
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'mcp.js'), 'utf8');
    const used = [...source.matchAll(/denied\('([^']+)'\)/g)].map((m) => m[1]);
    expect(used.sort()).toEqual([...ALL_PRIVILEGES].sort().flatMap((p) => used.filter((u) => u === p)));
    for (const u of used) expect(PRIVILEGES).toContain(u);
  });
});
