#!/usr/bin/env node
/**
 * MCP boundary runtime probe (Nexus task e608e40f — QA evidence).
 *
 * Spawns the REAL praxis-mind stdio server twice against a throwaway HOME and
 * flips exactly one variable between the phases — the keys-file mode — so
 * every claim is discriminating, every claim is corroborated by a second
 * channel beyond the tool's own return value, and every claim NAMES its log
 * or trace source. All raw evidence is persisted to an artifacts directory so
 * QA can corroborate the report against the sources after the run:
 *
 *   logs/mcp-boundary-probe/<run>/report.json         every check: name, pass, source, evidence
 *   logs/mcp-boundary-probe/<run>/phase-{a,b}.stderr.log   full server stderr captures
 *   logs/mcp-boundary-probe/<run>/phase-{a,b}.rpc.jsonl    full JSON-RPC transcripts
 *   logs/mcp-boundary-probe/<run>/cost-ledger.sqlite  the probe ledger DB itself
 *   logs/mcp-boundary-probe/<run>/ledger-rows.json    its `calls` rows, dumped
 *   logs/mcp-boundary-probe/<run>/praxis-mind-listing.json  probe-HOME file listing (absence claims)
 *   logs/mcp-boundary-probe/latest -> <run>           symlink to the newest run
 *
 * The claims:
 *   Phase A (keys.json 0600, scoped probe credential):
 *     - stderr logs the caller binding for the spawn
 *     - identity_whoami succeeds AND leaves an attributed cost-ledger row
 *     - nexus_task_create / vault_write are refused, leave NO ledger row and
 *       NO transition-log record (rejection before any side effect)
 *   Phase B (same file chmod 0644):
 *     - stderr logs the FATAL group/world-accessible refusal
 *     - the same previously-valid key now resolves unauthenticated
 *     - no new ledger rows appear
 *
 * Hermetic: HOME points at a temp dir, so keys, ledger, and transition log are
 * all probe-local; the live ~/.praxis-mind is never read or written. Exit 0 =
 * all checks pass; exit 1 = at least one failed.
 *
 * Run from the repo root:  node scripts/mcp-boundary-probe.js
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'services', 'praxis-mind-mcp', 'stdio.js');

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const ARTIFACTS = path.join(REPO, 'logs', 'mcp-boundary-probe', RUN_ID);
fs.mkdirSync(ARTIFACTS, { recursive: true });

const checks = [];
function check(name, pass, source, evidence) {
  checks.push({ name, pass, source, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}`);
  console.log(`       source:   ${source}`);
  console.log(`       evidence: ${evidence}`);
}

function spawnServer(phase, home, key) {
  const env = { ...process.env, HOME: home, PRAXIS_MIND_KEY: key };
  delete env.PRAXIS_MIND_TRANSITION_LOG; // must derive from the probe HOME
  const child = spawn('node', [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const stderrFile = path.join(ARTIFACTS, `phase-${phase}.stderr.log`);
  const rpcFile = path.join(ARTIFACTS, `phase-${phase}.rpc.jsonl`);
  const stderrLines = [];
  child.stderr.on('data', (d) => {
    fs.appendFileSync(stderrFile, d);
    for (const line of d.toString().split('\n')) if (line.trim()) stderrLines.push(line);
  });

  const transcript = (direction, payload) => {
    fs.appendFileSync(rpcFile, `${JSON.stringify({ direction, payload })}\n`);
  };

  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      transcript('recv', msg);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 0;
  const send = (payload) => {
    transcript('send', payload);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method) => send({ jsonrpc: '2.0', method });

  const call = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return { result: res.result, requestId: res.id };
  };

  const stop = () => new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });

  const rel = (p) => path.relative(REPO, p);
  return {
    rpc,
    notify,
    call,
    stop,
    stderrLines,
    stderrSource: (line) => `stderr of \`node ${rel(SERVER)}\` (phase ${phase.toUpperCase()} spawn), captured to ${rel(stderrFile)}${line ? ` — matched line: ${JSON.stringify(line)}` : ''}`,
    rpcSource: (requestId, tool) => `jsonrpc response id=${requestId} to tools/call ${tool}, transcribed to ${rel(rpcFile)}`,
  };
}

const textOf = (result) => result.content.map((c) => c.text).join('\n');
const rel = (p) => path.relative(REPO, p);

function ledgerRows(dbPath) {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    return db.prepare('SELECT caller, tool, success FROM calls ORDER BY id').all();
  } finally {
    db.close();
  }
}

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, mode: `0${(st.mode & 0o777).toString(8)}`, size: st.size };
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-probe-home-'));
  const keysDir = path.join(home, '.praxis-mind');
  const keysFile = path.join(keysDir, 'keys.json');
  const ledgerDb = path.join(keysDir, 'cost_ledger.sqlite');
  const transitionLog = path.join(keysDir, 'transition-log.jsonl');
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });

  const probeKey = `probe-${crypto.randomBytes(16).toString('hex')}`;
  fs.writeFileSync(keysFile, JSON.stringify({
    keys: {
      [probeKey]: {
        identity: 'probe-readonly',
        namespace: 'coding-agents-probe',
        privileges: ['identity.whoami'],
      },
    },
  }), { mode: 0o600 });

  const ledgerRowsFile = path.join(ARTIFACTS, 'ledger-rows.json');
  const listingFile = path.join(ARTIFACTS, 'praxis-mind-listing.json');
  const ledgerSource = `sqlite table \`calls\` in the probe cost ledger, copied to ${rel(path.join(ARTIFACTS, 'cost-ledger.sqlite'))}, rows dumped to ${rel(ledgerRowsFile)}`;

  try {
    // ── Phase A: scoped credential, keys file 0600 ────────────────────────
    console.log(`\nartifacts: ${rel(ARTIFACTS)}`);
    console.log('\nPhase A — keys.json mode 0600, credential scoped to identity.whoami\n');
    const a = spawnServer('a', home, probeKey);
    await a.rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boundary-probe', version: '2' },
    });
    a.notify('notifications/initialized');

    const who = await a.call('identity_whoami', {});
    const identity = who.result.isError ? null : JSON.parse(textOf(who.result));
    check('scoped credential resolves and whoami succeeds',
      identity?.identity === 'probe-readonly',
      a.rpcSource(who.requestId, 'identity_whoami'),
      who.result.isError ? textOf(who.result).slice(0, 120) : `whoami returned identity=${identity.identity}`);

    const create = await a.call('nexus_task_create', {
      project_id: 'probe', title: 'must be refused - qa-probe-e608e40f-7ff5-4872-ab53-de7d4ccf7dba-f9295ac3-dc79-4501-9d60-5ab0b9899996', description: '', priority: 1, dependencies: [],
    });
    check('nexus_task_create refused for the scoped credential',
      create.result.isError === true && /lacks privilege "nexus\.task_create"/.test(textOf(create.result)),
      a.rpcSource(create.requestId, 'nexus_task_create'),
      textOf(create.result).slice(0, 120));

    const vaultWrite = await a.call('vault_write', {
      path: 'memories/probe-must-not-exist.md', content: 'x', mode: 'replace',
    });
    check('vault_write refused for the scoped credential',
      vaultWrite.result.isError === true && /lacks privilege "vault\.write"/.test(textOf(vaultWrite.result)),
      a.rpcSource(vaultWrite.requestId, 'vault_write'),
      textOf(vaultWrite.result).slice(0, 120));

    await a.stop();

    const spawnLine = a.stderrLines.find((l) => l.includes('spawned for caller='));
    check('stderr log corroborates the caller binding for the spawn',
      Boolean(spawnLine && spawnLine.includes('caller=probe-readonly')),
      a.stderrSource(spawnLine),
      spawnLine || '(no spawn line on stderr)');

    const rowsA = ledgerRows(ledgerDb);
    const whoRow = rowsA.find((r) => r.tool === 'identity_whoami');
    check('cost-ledger row corroborates the whoami invocation, attributed to the probe identity',
      Boolean(whoRow && whoRow.caller === 'probe-readonly' && whoRow.success === 1),
      ledgerSource,
      whoRow ? JSON.stringify(whoRow) : '(no ledger row found)');

    const refusedRows = rowsA.filter((r) => r.tool === 'nexus_task_create' || r.tool === 'vault_write');
    check('refused mutations left no ledger trace (rejected before any side effect)',
      refusedRows.length === 0,
      ledgerSource,
      `ledger rows for refused tools: ${JSON.stringify(refusedRows)}`);

    check('refused mutations opened no write transaction (transition log absent)',
      !fs.existsSync(transitionLog),
      `probe-HOME file listing of .praxis-mind/, snapshotted to ${rel(listingFile)}`,
      fs.existsSync(transitionLog)
        ? `transition-log.jsonl EXISTS: ${fs.readFileSync(transitionLog, 'utf8').slice(0, 200)}`
        : 'transition-log.jsonl is not present in the probe HOME');

    // ── Phase B: identical setup, keys file flipped to 0644 ───────────────
    console.log('\nPhase B — same keys.json chmod 0644 (the only variable changed)\n');
    fs.chmodSync(keysFile, 0o644);

    const b = spawnServer('b', home, probeKey);
    await b.rpc('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boundary-probe', version: '2' },
    });
    b.notify('notifications/initialized');

    const whoB = await b.call('identity_whoami', {});
    check('the same previously-valid key now resolves unauthenticated',
      whoB.result.isError === true && /unauthenticated/i.test(textOf(whoB.result)),
      b.rpcSource(whoB.requestId, 'identity_whoami'),
      textOf(whoB.result).slice(0, 120));

    await b.stop();

    const fatalLine = b.stderrLines.find((l) => l.includes('group/world-accessible'));
    check('stderr FATAL log corroborates the loose-keys refusal',
      Boolean(fatalLine && fatalLine.includes('refusing to load keys')),
      b.stderrSource(fatalLine),
      fatalLine || '(no FATAL line on stderr)');

    const unauthLine = b.stderrLines.find((l) => l.includes('UNAUTHENTICATED'));
    check('stderr log corroborates the unauthenticated spawn',
      Boolean(unauthLine),
      b.stderrSource(unauthLine),
      unauthLine || '(no UNAUTHENTICATED line on stderr)');

    const rowsB = ledgerRows(ledgerDb);
    check('the unauthenticated refusal left no new ledger rows',
      rowsB.length === rowsA.length,
      ledgerSource,
      `ledger rows before=${rowsA.length} after=${rowsB.length}`);

    // ── Persist the trace sources before the probe HOME is destroyed ──────
    fs.writeFileSync(ledgerRowsFile, `${JSON.stringify(rowsB, null, 2)}\n`);
    if (fs.existsSync(ledgerDb)) fs.copyFileSync(ledgerDb, path.join(ARTIFACTS, 'cost-ledger.sqlite'));
    fs.writeFileSync(listingFile, `${JSON.stringify(listDir(keysDir), null, 2)}\n`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  const report = {
    task: 'e608e40f — Harden stateless MCP boundaries',
    run_id: RUN_ID,
    started_at: RUN_ID,
    server: rel(SERVER),
    node: process.version,
    discriminating_variable: 'keys.json mode: 0600 (phase A) vs 0644 (phase B); all else identical',
    artifacts: rel(ARTIFACTS),
    checks,
  };
  fs.writeFileSync(path.join(ARTIFACTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const latest = path.join(REPO, 'logs', 'mcp-boundary-probe', 'latest');
  fs.rmSync(latest, { force: true });
  fs.symlinkSync(ARTIFACTS, latest);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`report: ${rel(path.join(ARTIFACTS, 'report.json'))} (also: logs/mcp-boundary-probe/latest/report.json)`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(`PROBE ERROR: ${e.stack || e.message}`);
  process.exit(1);
});
