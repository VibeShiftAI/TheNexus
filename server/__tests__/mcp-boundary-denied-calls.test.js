/**
 * Denied calls are verified against server-side effects (Nexus task 973f4c51,
 * extending the boundary-security work of 3ea04ca2 / e608e40f).
 *
 * mcp-boundary-security.test.js calls tool handlers directly. That proves the
 * privilege gate, but it cannot exercise the two orderings the protocol leaves
 * open, because a direct handler call has no discovery step and no session:
 *
 *   NO DISCOVERY   Nothing in tools/call requires a prior tools/list, so a
 *                  client can invoke a tool it never discovered. The server
 *                  must authorize at invocation; discovery is not a gate.
 *   REVOCATION     Discovery responses are not durable authorization
 *                  decisions, and policy can change between discovery and
 *                  invocation. A grant withdrawn from keys.json while a
 *                  session is open must stop the next invocation in that
 *                  same session, not only the next spawn.
 *
 * So every case here spawns the REAL praxis-mind stdio server
 * (services/praxis-mind-mcp/stdio.js) and speaks JSON-RPC to it. A denial
 * only counts when the server shows no side effect: each case snapshots every
 * place a tool can leave state (the vault tree, the Nexus backend, the cost
 * ledger, the transition log) before and after the denied call and requires
 * the two snapshots to be identical, with the fake Nexus also receiving zero
 * requests. Each denial is paired with an authorized positive control that
 * runs the same call through the same harness and DOES change that state, so
 * the "no change" reading cannot come from a harness that never writes.
 *
 * Hermetic: HOME, the vault, the ledger and the transition log all live in a
 * per-test temp dir, the Nexus backend is an in-process recording fake, and
 * Cortex/Praxis point at a closed port. The live ~/.praxis-mind, the live
 * vault and the live :4000 are never touched.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const SERVER = path.resolve(__dirname, '../../services/praxis-mind-mcp/stdio.js');
const CLOSED_PORT = 'http://127.0.0.1:9';

const READ_PRIVILEGES = ['identity.whoami', 'vault.read', 'nexus.tasks_read', 'nexus.task_status'];
const WRITE_PRIVILEGES = ['vault.write', 'nexus.task_create'];

jest.setTimeout(30000);

// ─── Fake Nexus backend: records every request, keeps just enough task state
// for nexus_task_create's apply → read-back → verify cycle to commit. ────────

function startFakeNexus() {
  const requests = [];
  const tasks = new Map();
  let seq = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed });
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && req.url === '/api/tasks/batch') {
        const created = parsed.tasks.map((t) => {
          const id = `fake-task-${++seq}`;
          tasks.set(id, {
            id,
            project_id: parsed.project_id,
            name: t.name,
            description: t.description,
            status: t.status,
            priority: t.priority,
            dependencies: t.dependencies,
            successor_id: t.successor_id || null,
            source: t.source,
          });
          return { id };
        });
        return send(201, { tasks: created });
      }
      const match = req.method === 'GET' && req.url.match(/^\/api\/tasks\/([^/?]+)$/);
      if (match && tasks.has(decodeURIComponent(match[1]))) {
        return send(200, tasks.get(decodeURIComponent(match[1])));
      }
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        tasks,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ─── Hermetic fixture: temp HOME + vault + keys.json ────────────────────────

function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-denied-calls-')));
  const home = path.join(root, 'home');
  const stateDir = path.join(home, '.praxis-mind');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(vault, 'memories'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'memories', 'seed.md'), '# Seed\nDenied-call fixture.\n');
  return {
    root,
    home,
    vault,
    keysFile: path.join(stateDir, 'keys.json'),
    ledgerDb: path.join(stateDir, 'cost_ledger.sqlite'),
    transitionLog: path.join(stateDir, 'transition-log.jsonl'),
  };
}

/** Write keys.json the way an operator edit lands: temp file, 0600, rename. */
function writeKeys(fixture, keys) {
  const tmp = `${fixture.keysFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ keys }), { mode: 0o600 });
  fs.renameSync(tmp, fixture.keysFile);
}

const newKey = (label) => `${label}-${crypto.randomBytes(12).toString('hex')}`;

// ─── Real stdio server over JSON-RPC ────────────────────────────────────────

async function spawnServer(fixture, nexus, key) {
  const env = {
    ...process.env,
    HOME: fixture.home,
    PRAXIS_MIND_KEY: key,
    NEXUS_URL: nexus.url,
    NEXUS_VAULT_ROOT: fixture.vault,
    CORTEX_GATEWAY_URL: CLOSED_PORT,
    PRAXIS_URL: CLOSED_PORT,
    FLEET_ENV_PATH: path.join(fixture.root, 'no-fleet-env'),
  };
  // Must derive from the temp HOME, never from the developer's environment.
  for (const name of ['PRAXIS_MIND_TRANSITION_LOG', 'PRAXIS_MIND_LEDGER_DB', 'PRAXIS_VAULT_ROOT']) delete env[name];

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const sent = [];
  const stderr = [];
  const pending = new Map();
  let buf = '';
  child.stderr.on('data', (d) => stderr.push(...d.toString().split('\n').filter((l) => l.trim())));
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  let nextId = 0;
  const send = (payload) => {
    sent.push(payload);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}; stderr:\n${stderr.join('\n')}`));
    }, 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });

  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'denied-calls-test', version: '1' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    sent,
    stderr,
    listTools: async () => (await rpc('tools/list', {})).result.tools.map((t) => t.name),
    call: async (name, args) => {
      const msg = await rpc('tools/call', { name, arguments: args });
      if (msg.error) throw new Error(`JSON-RPC error for ${name}: ${JSON.stringify(msg.error)}`);
      return msg.result;
    },
    stop: async () => { child.kill(); await exited; },
  };
}

// ─── Server-side state: every place a tool call can leave an effect ─────────

function vaultTree(dir, base = dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, vaultTree(abs, base));
    else out[path.relative(base, abs)] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
  return out;
}

function ledgerRows(fixture) {
  if (!fs.existsSync(fixture.ledgerDb)) return [];
  const db = new Database(fixture.ledgerDb, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT id, caller, tool, success FROM calls ORDER BY id').all();
  } finally {
    db.close();
  }
}

function transitions(fixture) {
  return fs.existsSync(fixture.transitionLog)
    ? fs.readFileSync(fixture.transitionLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}

function serverState(fixture, nexus) {
  return {
    vault: vaultTree(fixture.vault),
    nexusRequests: nexus.requests.length,
    nexusTasks: [...nexus.tasks.keys()],
    ledger: ledgerRows(fixture),
    transitions: transitions(fixture),
  };
}

const textOf = (result) => result.content.map((c) => c.text).join('\n');

const VAULT_ARGS = (name) => ({ path: `memories/${name}.md`, content: `${name}\n`, mode: 'replace' });
const CREATE_ARGS = (title) => ({ project_id: 'p-fixture', title, description: '', priority: 1, dependencies: [] });

let fixture;
let nexus;
let sessions;

beforeEach(async () => {
  fixture = makeFixture();
  nexus = await startFakeNexus();
  sessions = [];
});

afterEach(async () => {
  await Promise.all(sessions.map((s) => s.stop()));
  await nexus.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

async function open(key) {
  const session = await spawnServer(fixture, nexus, key);
  sessions.push(session);
  return session;
}

// ─── Invocation without discovery ───────────────────────────────────────────

describe('invocation without discovery: tools/call is authorized at invocation, not by tools/list', () => {
  test('an under-privileged caller that never listed tools is refused, and the server state is unchanged', async () => {
    const key = newKey('reader');
    writeKeys(fixture, { [key]: { identity: 'reader', namespace: 'ns-reader', privileges: [...READ_PRIVILEGES] } });
    const session = await open(key);

    const before = serverState(fixture, nexus);
    const write = await session.call('vault_write', VAULT_ARGS('undiscovered-write'));
    const create = await session.call('nexus_task_create', CREATE_ARGS('undiscovered create'));

    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/caller "reader" lacks privilege "vault\.write"/);
    expect(create.isError).toBe(true);
    expect(textOf(create)).toMatch(/caller "reader" lacks privilege "nexus\.task_create"/);

    // The session really skipped discovery: initialize, initialized, then calls.
    expect(session.sent.map((m) => m.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/call', 'tools/call',
    ]);
    // No side effect anywhere: vault bytes, Nexus backend, ledger, transition log.
    expect(serverState(fixture, nexus)).toEqual(before);
    expect(nexus.requests).toEqual([]);
    expect(fs.existsSync(path.join(fixture.vault, 'memories', 'undiscovered-write.md'))).toBe(false);
  });

  test('positive control: an authorized caller that never listed tools writes, and the state changes', async () => {
    const key = newKey('writer');
    writeKeys(fixture, {
      [key]: { identity: 'writer', namespace: 'ns-writer', privileges: [...READ_PRIVILEGES, ...WRITE_PRIVILEGES] },
    });
    const session = await open(key);

    const before = serverState(fixture, nexus);
    const write = await session.call('vault_write', VAULT_ARGS('undiscovered-write'));
    const create = await session.call('nexus_task_create', CREATE_ARGS('undiscovered create'));

    expect(write.isError).toBeUndefined();
    expect(create.isError).toBeUndefined();
    expect(session.sent.map((m) => m.method)).not.toContain('tools/list');

    const after = serverState(fixture, nexus);
    expect(after).not.toEqual(before);
    expect(fs.readFileSync(path.join(fixture.vault, 'memories', 'undiscovered-write.md'), 'utf8'))
      .toBe('undiscovered-write\n');
    expect(nexus.requests.filter((r) => r.method === 'POST').map((r) => r.url)).toEqual(['/api/tasks/batch']);
    expect([...nexus.tasks.values()].map((t) => [t.name, t.source]))
      .toEqual([['undiscovered create', 'coding-agents-writer']]);
    expect(after.transitions.map((r) => [r.tool, r.verdict, r.caller.identity])).toEqual([
      ['vault_write', 'committed', 'writer'],
      ['nexus_task_create', 'committed', 'writer'],
    ]);
    expect(after.ledger.map((r) => [r.caller, r.tool, r.success])).toEqual([
      ['writer', 'vault_write', 1],
      ['writer', 'nexus_task_create', 1],
    ]);
  });

  test('discovery grants nothing: tools/list advertises write tools to a reader that is still refused', async () => {
    const key = newKey('reader');
    writeKeys(fixture, { [key]: { identity: 'reader', namespace: 'ns-reader', privileges: [...READ_PRIVILEGES] } });
    const session = await open(key);

    const listed = await session.listTools();
    expect(listed).toEqual(expect.arrayContaining(['vault_write', 'nexus_task_create']));

    const before = serverState(fixture, nexus);
    const write = await session.call('vault_write', VAULT_ARGS('discovered-write'));
    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/lacks privilege "vault\.write"/);
    expect(serverState(fixture, nexus)).toEqual(before);
  });
});

// ─── Invocation after authorization revocation ──────────────────────────────

describe('invocation after revocation: a grant withdrawn mid-session stops the next call in that session', () => {
  test('privileges removed from the key are refused on the next call, with no side effect; what remains still works', async () => {
    const key = newKey('writer');
    const grant = { identity: 'writer', namespace: 'ns-writer', privileges: [...READ_PRIVILEGES, ...WRITE_PRIVILEGES] };
    writeKeys(fixture, { [key]: grant });
    const session = await open(key);

    // Discovery while authorized, then an authorized positive control that
    // changes state, all in the session that will outlive the revocation.
    expect(await session.listTools()).toEqual(expect.arrayContaining(['vault_write', 'nexus_task_create']));
    const control = await session.call('vault_write', VAULT_ARGS('before-revocation'));
    expect(control.isError).toBeUndefined();
    const controlCreate = await session.call('nexus_task_create', CREATE_ARGS('before revocation'));
    expect(controlCreate.isError).toBeUndefined();
    expect(transitions(fixture)).toHaveLength(2);

    // Revoke the write privileges. The session is NOT respawned.
    writeKeys(fixture, { [key]: { ...grant, privileges: [...READ_PRIVILEGES] } });

    const before = serverState(fixture, nexus);
    const requestsBefore = nexus.requests.length;
    const write = await session.call('vault_write', VAULT_ARGS('after-revocation'));
    const create = await session.call('nexus_task_create', CREATE_ARGS('after revocation'));

    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/caller "writer" lacks privilege "vault\.write"/);
    expect(create.isError).toBe(true);
    expect(textOf(create)).toMatch(/caller "writer" lacks privilege "nexus\.task_create"/);
    expect(serverState(fixture, nexus)).toEqual(before);
    expect(nexus.requests.length).toBe(requestsBefore);
    expect(fs.existsSync(path.join(fixture.vault, 'memories', 'after-revocation.md'))).toBe(false);

    // The same session still authorizes what the key still grants, and the
    // server reports the narrowed privilege set: the refusal is the
    // revocation, not a broken session.
    const who = await session.call('identity_whoami', {});
    expect(who.isError).toBeUndefined();
    expect(JSON.parse(textOf(who)).privileges).toEqual(READ_PRIVILEGES);
    // Second channel: the server logged that it re-read the changed keys file.
    expect(session.stderr.some((l) => /keys file .* changed since it was last read/.test(l))).toBe(true);
  });

  test('a key deleted mid-session resolves unauthenticated on the next call, with no side effect', async () => {
    const key = newKey('writer');
    const other = newKey('other');
    const grant = { identity: 'writer', namespace: 'ns-writer', privileges: [...READ_PRIVILEGES, ...WRITE_PRIVILEGES] };
    const otherGrant = { identity: 'other', namespace: 'ns-other', privileges: ['identity.whoami'] };
    writeKeys(fixture, { [key]: grant, [other]: otherGrant });
    const session = await open(key);

    const control = await session.call('vault_write', VAULT_ARGS('before-deletion'));
    expect(control.isError).toBeUndefined();

    writeKeys(fixture, { [other]: otherGrant });

    const before = serverState(fixture, nexus);
    const write = await session.call('vault_write', VAULT_ARGS('after-deletion'));
    const create = await session.call('nexus_task_create', CREATE_ARGS('after deletion'));
    const who = await session.call('identity_whoami', {});

    for (const result of [write, create, who]) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/unauthenticated/i);
    }
    expect(serverState(fixture, nexus)).toEqual(before);
    expect(nexus.requests).toEqual([]);
  });

  test('positive control: a key re-granted mid-session is honored on the next call without a respawn', async () => {
    const key = newKey('grantee');
    const grant = { identity: 'grantee', namespace: 'ns-grantee', privileges: [...READ_PRIVILEGES] };
    writeKeys(fixture, { [key]: grant });
    const session = await open(key);

    const refused = await session.call('vault_write', VAULT_ARGS('regrant'));
    expect(refused.isError).toBe(true);
    const before = serverState(fixture, nexus);

    writeKeys(fixture, { [key]: { ...grant, privileges: [...READ_PRIVILEGES, 'vault.write'] } });

    const ok = await session.call('vault_write', VAULT_ARGS('regrant'));
    expect(ok.isError).toBeUndefined();
    const after = serverState(fixture, nexus);
    expect(after).not.toEqual(before);
    expect(after.vault['memories/regrant.md']).toBeDefined();
    expect(after.transitions.map((r) => [r.tool, r.verdict, r.caller.identity]))
      .toEqual([['vault_write', 'committed', 'grantee']]);
  });
});
