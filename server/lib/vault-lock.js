/**
 * Vault advisory locks (P1-17, workflows/Vault Single Writer Design.md §4.2).
 *
 * One lock per FILE CLASS, not per file: `authored`, `skills`, `projections`,
 * `git`. A writer holds the lock for the duration of one read-modify-write so
 * two processes can never interleave inside the same class, and git-sync can
 * take `git`+`authored`+`skills` to guarantee it never snapshots a half-written
 * tree.
 *
 * Implementation note — why not `proper-lockfile`: the design named it "or
 * equivalent". Neither Praxis, TheNexus nor the MCP server had it installed,
 * and adding a runtime dependency to three live processes (one of them spawned
 * per MCP client with no node_modules of its own) is a bigger risk than the
 * 60 lines below. `mkdir(2)` is atomic and fails with EEXIST on every POSIX
 * filesystem, which is exactly the primitive proper-lockfile itself uses. The
 * lock NAMES and semantics (stale 30s, 10 retries at 50ms) are the design's,
 * so the TS twin in Praxis/src/vault-write.ts interoperates byte-for-byte.
 *
 * Locks live under `<vault>/.index/locks/` — already gitignored and already
 * ignored by the watcher, so taking one never triggers a regeneration.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_CLASSES = ['authored', 'skills', 'projections', 'git'];
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRIES = 10;
const DEFAULT_MIN_TIMEOUT_MS = 50;
/** The watcher logs any lock older than this (design §5 risks). */
const LOCK_WARN_AGE_MS = 60_000;

function locksDir(vault) {
  return path.join(vault, '.index', 'locks');
}

function lockPath(vault, className) {
  if (!LOCK_CLASSES.includes(className)) {
    throw new Error(`unknown vault lock class "${className}" (expected one of ${LOCK_CLASSES.join(', ')})`);
  }
  return path.join(locksDir(vault), `${className}.lock`);
}

/** Block the current thread without spinning. Sync on purpose: every vault writer is sync. */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function lockAgeMs(dir) {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function processAlive(owner) {
  if (!owner || owner.host !== os.hostname() || !owner.pid) return true; // unknowable → assume alive
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function removeLock(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* another process reclaimed it first — fine */
  }
}

/**
 * Take `className` once. Returns a release() function, or null when the lock
 * could not be taken inside the retry budget (callers decide: skip, or throw).
 */
/**
 * Locks held by THIS process, keyed by lock dir → depth. A vault write often
 * nests (vault_write takes `authored`, then applySupersession stamps the files
 * it retires under the same class); without re-entrancy the second acquire
 * would spin against our own lock and then reclaim it as stale. Re-entrant
 * acquires are counted, and the directory is removed only when the count
 * returns to zero.
 */
const held = new Map();

function acquireLock(vault, className, opts = {}) {
  const dir = lockPath(vault, className);
  if (held.has(dir)) {
    held.set(dir, held.get(dir) + 1);
    let released = false;
    return function releaseReentrant() {
      if (released) return;
      released = true;
      const next = held.get(dir) - 1;
      if (next > 0) held.set(dir, next);
      else {
        held.delete(dir);
        removeLock(dir);
      }
    };
  }
  const stale = opts.stale ?? DEFAULT_STALE_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const minTimeout = opts.minTimeout ?? DEFAULT_MIN_TIMEOUT_MS;
  const onStale = opts.onStale;

  fs.mkdirSync(locksDir(vault), { recursive: true });

  // Reclaiming a stale lock does not consume the retry budget: the budget is
  // for waiting on a LIVE writer, and a reclaim means there was none.
  let reclaims = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'owner.json'),
        JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), by: opts.by || 'unknown' }),
      );
      held.set(dir, 1);
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        const next = (held.get(dir) || 1) - 1;
        if (next > 0) held.set(dir, next);
        else {
          held.delete(dir);
          removeLock(dir);
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const age = lockAgeMs(dir);
      const owner = readOwner(dir);
      if ((age > stale || !processAlive(owner)) && reclaims < 3) {
        reclaims += 1;
        if (onStale) onStale({ className, age, owner });
        removeLock(dir);
        attempt -= 1;
        continue;
      }
      if (attempt < retries) sleepSync(minTimeout);
    }
  }
  return null;
}

/** Run `fn` under one or more class locks, releasing in reverse order. */
function withLocks(vault, classNames, fn, opts = {}) {
  const releases = [];
  try {
    for (const className of classNames) {
      const release = acquireLock(vault, className, opts);
      if (!release) {
        const err = new Error(`could not acquire vault lock "${className}" within the retry budget`);
        err.code = 'ELOCKED';
        err.lockClass = className;
        throw err;
      }
      releases.push(release);
    }
    return fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

function withLock(vault, className, fn, opts = {}) {
  return withLocks(vault, [className], fn, opts);
}

/**
 * Async twin of withLocks: `fn` returns a promise and the locks are released
 * when it SETTLES, not when it returns. withLocks() would release on return,
 * which for an async fn is immediately — hence two functions rather than one.
 */
async function withLocksAsync(vault, classNames, fn, opts = {}) {
  const releases = [];
  try {
    for (const className of classNames) {
      const release = acquireLock(vault, className, opts);
      if (!release) {
        const err = new Error(`could not acquire vault lock "${className}" within the retry budget`);
        err.code = 'ELOCKED';
        err.lockClass = className;
        throw err;
      }
      releases.push(release);
    }
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** Diagnostics: every currently held lock with its age and owner. */
function inspectLocks(vault) {
  return LOCK_CLASSES.map((className) => {
    const dir = lockPath(vault, className);
    if (!fs.existsSync(dir)) return { class: className, held: false };
    return { class: className, held: true, ageMs: lockAgeMs(dir), owner: readOwner(dir) };
  });
}

module.exports = {
  LOCK_CLASSES,
  DEFAULT_STALE_MS,
  LOCK_WARN_AGE_MS,
  locksDir,
  lockPath,
  acquireLock,
  withLock,
  withLocks,
  withLocksAsync,
  inspectLocks,
  sleepSync,
};
