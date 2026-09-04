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
/**
 * Hard cap on a lock's age. Past `stale` a lock is only reclaimed when its
 * recorded holder pid is provably dead; past the hard cap it is reclaimed
 * regardless (the holder is wedged, or its pid is unknowable — another host,
 * or an owner.json that never got written). A LIVE holder between 30s and
 * 10min keeps its lock: reclaiming under a slow-but-alive writer is exactly
 * the torn-write the lock exists to prevent (P1-17 review).
 */
const DEFAULT_HARD_CAP_MS = 600_000;
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

/** Age from the recorded acquiredAt when present, else the directory mtime. */
function lockAgeMs(dir, owner) {
  if (owner && Number.isFinite(owner.acquiredAt)) return Date.now() - owner.acquiredAt;
  try {
    return Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * True unless the recorded holder is provably dead: same host, a pid, and
 * `kill(pid, 0)` says ESRCH. Unknowable (other host, no owner.json) → alive,
 * so only the hard cap can reclaim it.
 */
function processAlive(owner) {
  if (!owner || owner.host !== os.hostname() || !owner.pid) return true; // unknowable → assume alive
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

/**
 * The reclaim rule: a dead holder's lock is reclaimable at any age (nothing
 * can release it); a live or unknowable holder's lock only past the hard cap.
 * `stale` is where a live holder starts being reported (onStale/inspect), NOT
 * where it gets reclaimed.
 */
function reclaimable({ age, owner, hardCap }) {
  if (!processAlive(owner)) return true;
  return age > hardCap;
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
  const hardCap = Math.max(opts.hardCap ?? DEFAULT_HARD_CAP_MS, stale);
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
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          acquiredAt: Date.now(),
          at: new Date().toISOString(),
          by: opts.by || 'unknown',
        }),
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
      const owner = readOwner(dir);
      const age = lockAgeMs(dir, owner);
      const alive = processAlive(owner);
      const willReclaim = reclaimable({ age, owner, hardCap }) && reclaims < 3;
      // Report a reclaim, and (once per acquire) a live holder past `stale`
      // that we are deliberately NOT reclaiming.
      if (onStale && (willReclaim || (age > stale && attempt === 0))) {
        onStale({ className, age, owner, alive, reclaimed: willReclaim });
      }
      if (willReclaim) {
        reclaims += 1;
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
    const owner = readOwner(dir);
    return { class: className, held: true, ageMs: lockAgeMs(dir, owner), owner, alive: processAlive(owner) };
  });
}

module.exports = {
  LOCK_CLASSES,
  DEFAULT_STALE_MS,
  DEFAULT_HARD_CAP_MS,
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
