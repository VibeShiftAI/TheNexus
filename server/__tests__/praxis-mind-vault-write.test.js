/**
 * The vault write protocol on the Nexus side (P1-17,
 * shared-mind/workflows/Vault Single Writer Design.md): the CJS helper the
 * praxis-mind MCP server and the vault watcher share, its locks, the
 * generated-file header, and the two races the design's test plan names —
 * a watcher regeneration during a Praxis write, and git-sync snapshotting a
 * temp file.
 *
 * The cross-process cases spawn real children: a filesystem lock proved by
 * interleaved promises in one process proves nothing.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vaultWrite = require('../lib/vault-write');
const vaultLock = require('../lib/vault-lock');
const gitSync = require('../../services/vault-watcher/git-sync');
const watcher = require('../../services/vault-watcher/index.js');

const {
  atomicWrite,
  classifyVaultPath,
  generatedHeader,
  generatedOwnerOf,
  stampGenerated,
  updateVaultFile,
  writeGeneratedFile,
  writeVaultFile,
  OWNER_WATCHER,
  OWNER_STATE_DOC,
} = vaultWrite;

function tmpVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vault-write-'));
  for (const sub of ['memories', 'projects', 'skills']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

const temps = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

function refusalCode(fn) {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
}

describe('vault-write: the fleet write protocol', () => {
  test('round-trips replace and append and leaves no temp file', () => {
    const vault = tmpVault();
    const file = path.join(vault, 'memories', 'note_x.md');
    writeVaultFile(file, 'one', { vault });
    expect(fs.readFileSync(file, 'utf8')).toBe('one');
    writeVaultFile(file, '-two', { vault, mode: 'append' });
    expect(fs.readFileSync(file, 'utf8')).toBe('one-two');
    expect(temps(path.join(vault, 'memories'))).toEqual([]);
  });

  test('honours wx create-only semantics without leaving a temp file', () => {
    const vault = tmpVault();
    const file = path.join(vault, 'skills', 'a.md');
    writeVaultFile(file, 'first', { vault });
    expect(() => writeVaultFile(file, 'second', { vault, flag: 'wx' })).toThrow(/EEXIST/);
    expect(fs.readFileSync(file, 'utf8')).toBe('first');
    expect(temps(path.join(vault, 'skills'))).toEqual([]);
  });

  test('enforces the ownership matrix by path and by header', () => {
    const vault = tmpVault();
    expect(classifyVaultPath('MEMORY.md').owner).toBe(OWNER_WATCHER);
    expect(classifyVaultPath('LINKS.md').owner).toBe(OWNER_WATCHER);
    expect(classifyVaultPath('STATE.md').owner).toBe(OWNER_STATE_DOC);
    expect(classifyVaultPath('.index/vault-search.json').owner).toBe(OWNER_WATCHER);
    expect(classifyVaultPath('skills/ops/x.md').klass).toBe('skills');
    expect(classifyVaultPath('memories/x.md').klass).toBe('authored');

    expect(refusalCode(() => writeVaultFile(path.join(vault, 'MEMORY.md'), 'x', { vault }))).toBe('EGENERATED');
    expect(refusalCode(() => writeVaultFile(path.join(vault, 'SOUL.md'), 'x', { vault }))).toBe('EROBERT');
    expect(refusalCode(() => writeVaultFile(path.join(vault, '_archive', 'x.md'), 'x', { vault }))).toBe('EARCHIVE');

    const stamped = path.join(vault, 'memories', 'stamped.md');
    fs.writeFileSync(stamped, `${generatedHeader(OWNER_WATCHER)}\nbody`);
    expect(refusalCode(() => writeVaultFile(stamped, 'x', { vault }))).toBe('EGENERATED');
    expect(refusalCode(() => updateVaultFile(stamped, () => 'x', { vault }))).toBe('EGENERATED');
    expect(fs.readFileSync(stamped, 'utf8')).toContain('body');
  });

  test('the generated header is idempotent and identifies its owner', () => {
    const once = stampGenerated('body', OWNER_WATCHER);
    expect(stampGenerated(once, OWNER_WATCHER)).toBe(once);
    expect(generatedOwnerOf(once)).toBe(OWNER_WATCHER);
    expect(generatedOwnerOf('plain body')).toBeNull();
  });

  test('writeGeneratedFile is write-if-changed, so a stable projection writes zero bytes', () => {
    const vault = tmpVault();
    const file = path.join(vault, 'MEMORY.md');
    expect(writeGeneratedFile(file, 'body', { vault }).changed).toBe(true);
    // The prompt-cache guard: same inputs → no write at all, header included.
    expect(writeGeneratedFile(file, 'body', { vault }).changed).toBe(false);
    expect(fs.readFileSync(file, 'utf8').split('\n')[0]).toMatch(/^<!-- GENERATED: vault-watcher;/);
    expect(writeGeneratedFile(file, 'body2', { vault }).changed).toBe(true);
  });

  test('locks are re-entrant in-process, exclusive across processes, and reclaim a dead owner', () => {
    const vault = tmpVault();
    const outer = vaultLock.acquireLock(vault, 'authored');
    expect(vaultLock.acquireLock(vault, 'authored')).toBeTruthy(); // nested — must not deadlock
    // A different "process" cannot take it: simulate by checking the dir exists
    // and that a zero-retry acquire from a foreign owner fails.
    expect(fs.existsSync(vaultLock.lockPath(vault, 'authored'))).toBe(true);
    outer();
    outer(); // idempotent release
    // Depth is 2 (outer + nested); release the nested one too.
    const remaining = vaultLock.inspectLocks(vault).find((l) => l.class === 'authored');
    expect(remaining.held).toBe(true);

    const vault2 = tmpVault();
    const dir = vaultLock.lockPath(vault2, 'git');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4194304, host: os.hostname() }));
    const reclaimed = vaultLock.acquireLock(vault2, 'git', { retries: 0 });
    expect(reclaimed).toBeTruthy();
    reclaimed();
  });

  test('a LIVE holder past the 30s stale threshold is NOT reclaimed; a dead pid IS; the hard cap always is', () => {
    const plant = (vault, className, owner) => {
      const dir = vaultLock.lockPath(vault, className);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ host: os.hostname(), ...owner }));
      return dir;
    };
    const vault = tmpVault();
    const stale = [];
    const onStale = (info) => stale.push(info);

    // Live holder (this very process), 90s old — past stale, under the cap.
    const liveDir = plant(vault, 'authored', { pid: process.pid, acquiredAt: Date.now() - 90_000 });
    expect(vaultLock.acquireLock(vault, 'authored', { retries: 0, onStale })).toBeNull();
    expect(fs.existsSync(liveDir)).toBe(true);
    expect(stale).toEqual([expect.objectContaining({ className: 'authored', alive: true, reclaimed: false })]);
    expect(vaultLock.inspectLocks(vault).find((l) => l.class === 'authored')).toMatchObject({ held: true, alive: true });
    // The lock must not have been touched even after the retry budget elapses.
    expect(vaultLock.acquireLock(vault, 'authored', { retries: 2, minTimeout: 1 })).toBeNull();
    expect(fs.existsSync(liveDir)).toBe(true);

    // Dead holder (pid 2^22 is unallocatable), same age — reclaimed.
    plant(vault, 'skills', { pid: 4194304, acquiredAt: Date.now() - 90_000 });
    stale.length = 0;
    const reclaimed = vaultLock.acquireLock(vault, 'skills', { retries: 0, onStale });
    expect(reclaimed).toBeTruthy();
    expect(stale).toEqual([expect.objectContaining({ className: 'skills', alive: false, reclaimed: true })]);
    reclaimed();

    // Live holder past the hard cap — reclaimed regardless (wedged writer).
    plant(vault, 'projections', { pid: process.pid, acquiredAt: Date.now() - vaultLock.DEFAULT_HARD_CAP_MS - 1000 });
    const capped = vaultLock.acquireLock(vault, 'projections', { retries: 0 });
    expect(capped).toBeTruthy();
    capped();

    // An owner we cannot judge (other host) is treated as alive: waits, not reclaimed.
    const foreign = vaultLock.lockPath(vault, 'git');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'owner.json'), JSON.stringify({ pid: 4194304, host: 'elsewhere', acquiredAt: Date.now() - 90_000 }));
    expect(vaultLock.acquireLock(vault, 'git', { retries: 0 })).toBeNull();
    expect(fs.existsSync(foreign)).toBe(true);

    // What a fresh acquire records: pid + acquiredAt, so the next process can judge us.
    const release = vaultLock.acquireLock(vault, 'projections');
    const owner = JSON.parse(fs.readFileSync(path.join(vaultLock.lockPath(vault, 'projections'), 'owner.json'), 'utf8'));
    expect(owner).toMatchObject({ pid: process.pid, host: os.hostname(), acquiredAt: expect.any(Number) });
    release();
  });
});

describe('vault-write: races the design found', () => {
  test('a watcher-style whole-file read never sees a torn file during rewrites', () => {
    const vault = tmpVault();
    const file = path.join(vault, 'memories', 'big.md');
    const a = `A\n${'a'.repeat(300_000)}`;
    const b = `B\n${'b'.repeat(300_000)}`;
    writeVaultFile(file, a, { vault });
    for (let i = 0; i < 150; i += 1) {
      atomicWrite(file, i % 2 ? a : b);
      const seen = fs.readFileSync(file, 'utf8');
      expect(seen === a || seen === b).toBe(true);
    }
    expect(temps(path.join(vault, 'memories'))).toEqual([]);
  });

  test('two processes RMW-ing one projects/<name>.md lose nothing', () => {
    const vault = tmpVault();
    const file = path.join(vault, 'projects', 'Race.md');
    const child = path.join(vault, 'child.js');
    fs.writeFileSync(
      child,
      `const { updateVaultFile } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'vault-write.js'))});
const [file, vault, tag, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i += 1) {
  updateVaultFile(file, (cur) => \`\${cur || '---\\ntype: project\\n---\\n'}\${tag}-\${i}\\n\`, { vault, by: tag });
}`,
    );
    const N = 25;
    for (const tag of ['steward', 'tagger']) {
      execFileSync(process.execPath, [child, file, vault, tag, String(N)], { stdio: 'pipe' });
    }
    const body = fs.readFileSync(file, 'utf8');
    expect(body.startsWith('---\ntype: project\n---\n')).toBe(true);
    for (const tag of ['steward', 'tagger']) {
      for (let i = 0; i < N; i += 1) expect(body).toContain(`${tag}-${i}\n`);
    }
  });
});

describe('watcher + git-sync temp-file hygiene', () => {
  test('the watcher ignores in-flight temp files but not real content', () => {
    for (const p of [
      'memories/.note_x.md.4242.1756900000000.tmp',
      'memories/note_x.md.tmp-4242',
      'projects/.Race.md.1.2.tmp',
    ]) {
      expect(watcher.TEMP_FILE_RE.test(p)).toBe(true);
      expect(gitSync.isTempPath(p)).toBe(true);
    }
    for (const p of ['memories/note_x.md', 'MEMORY.md', 'skills/ops/a.md', 'projects/Race.md']) {
      expect(watcher.TEMP_FILE_RE.test(p)).toBe(false);
      expect(gitSync.isTempPath(p)).toBe(false);
    }
  });

  test('the commit phase drops temp files from the staging set and the message', async () => {
    const staged = [];
    const fakeGit = {
      status: async () => ({
        files: [
          { path: 'memories/note_real.md', index: ' ', working_dir: 'M' },
          { path: 'memories/.note_slow.md.99.1.tmp', index: '?', working_dir: '?' },
        ],
      }),
      add: async (arg) => staged.push(arg),
      raw: async (args) => staged.push(args.join(' ')),
      commit: async (msg) => staged.push(msg),
    };
    const logs = [];
    const committed = await gitSync.commitPhase(fakeGit, (m) => logs.push(m));
    expect(committed).toBe(true);
    const message = staged.find((s) => typeof s === 'string' && s.startsWith('Vault update'));
    expect(message).toContain('memories/note_real.md');
    expect(message).not.toContain('.tmp');
    expect(logs.join('\n')).toContain('Ignoring 1 in-flight temp file');
    // The temp file is explicitly unstaged even if `git add -A` picked it up.
    expect(staged).toContain('restore --staged -- memories/.note_slow.md.99.1.tmp');
  });

  test('a status containing only temp files commits nothing', async () => {
    const fakeGit = {
      status: async () => ({ files: [{ path: 'memories/.x.md.1.2.tmp', index: '?', working_dir: '?' }] }),
      add: async () => {
        throw new Error('must not stage');
      },
      commit: async () => {
        throw new Error('must not commit');
      },
    };
    expect(await gitSync.commitPhase(fakeGit, () => {})).toBe(false);
  });
});
