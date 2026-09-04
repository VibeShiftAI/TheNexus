/**
 * Vault git sync — commits hourly (if changes), pushes every 6 hours.
 * Folded into the vault-watcher daemon (2026-07-06 consolidation) — the
 * watcher schedules runGitSync() on an hourly interval; the standalone
 * com.thenexus.vault-git-sync launchd job is retired. Stateless except
 * for .git/last-push.timestamp inside the vault repo itself.
 *
 * v0 commit messages are heuristic (file-count + categories). Wave 4 will
 * swap in praxis brain.chat with tier:fast for prose summaries.
 */

const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const { withLocksAsync } = require('./lib/write-protocol');

const PUSH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * P1-17: `git add -A` used to snapshot whatever was on disk at the top of the
 * hour — including a half-written memory and any in-flight temp file. Two
 * defences now: (a) the commit phase runs under the `authored` + `skills`
 * locks, so no non-interactive writer is mid-RMW while we stage; (b) temp
 * files are excluded belt-and-braces even though .gitignore now covers them,
 * because a file created before the ignore rule shipped would still be tracked.
 */
const TEMP_FILE_RE = /(^|\/)\.?[^/]*\.(?:\d+\.\d+\.tmp|tmp)$|\.tmp-\d+$/;

/** How long the commit phase waits for the authored/skills locks before giving up. */
const LOCK_WAIT_MS = 5_000;

function isTempPath(p) {
  return TEMP_FILE_RE.test(String(p));
}

function readLastPush(lastPushFile) {
  try {
    return parseInt(fs.readFileSync(lastPushFile, 'utf8'), 10) || 0;
  } catch (e) {
    return 0;
  }
}

function writeLastPush(lastPushFile, ts) {
  fs.writeFileSync(lastPushFile, String(ts));
}

function summarize(files) {
  const byKind = {
    identity: 0,
    memory: 0,
    project: 0,
    workflow: 0,
    incident: 0,
    skill: 0,
    generated: 0,
    other: 0,
  };
  for (const f of files) {
    const p = f.path;
    if (['SOUL.md', 'USER.md', 'CONTEXT.md', 'README.md', 'CLAUDE.md'].includes(p)) byKind.identity++;
    else if (['MEMORY.md', 'AGENTS.md', 'shared-mind-context.md'].includes(p)) byKind.generated++;
    else if (p.startsWith('memories/')) byKind.memory++;
    else if (p.startsWith('projects/')) byKind.project++;
    else if (p.startsWith('workflows/')) byKind.workflow++;
    else if (p.startsWith('incidents/')) byKind.incident++;
    else if (p.startsWith('skills/')) byKind.skill++;
    else byKind.other++;
  }
  const parts = [];
  for (const [k, v] of Object.entries(byKind)) {
    if (v > 0) parts.push(`${v} ${k}${v > 1 ? 's' : ''}`);
  }
  return `Vault update: ${parts.join(', ') || 'misc'}`;
}

/**
 * One sync pass: commit pending vault changes, push if the 6h interval
 * elapsed. Never throws on push failure — the timestamp isn't advanced,
 * so the next hourly pass retries. Returns a status string for the log.
 */
async function runGitSync(vault, log = console.log) {
  if (!fs.existsSync(path.join(vault, '.git'))) {
    throw new Error(`${vault} is not a git repo`);
  }

  const git = simpleGit(vault);
  const lastPushFile = path.join(vault, '.git', 'last-push.timestamp');

  // ── Commit phase, under the authored + skills locks (P1-17 §4.2) ──
  // The locks are released before the push: a push takes seconds on the
  // network and must never block a memory write.
  let committed;
  try {
    committed = await withLocksAsync(
      vault,
      ['git', 'authored', 'skills'],
      async () => commitPhase(git, log),
      { by: 'vault-git-sync', retries: Math.ceil(LOCK_WAIT_MS / 50), minTimeout: 50 },
    );
  } catch (e) {
    if (e.code === 'ELOCKED') {
      // A writer is mid-RMW. Skipping costs at most one hour of latency;
      // committing anyway costs a torn file in history.
      log(`[GitSync] Skipping commit — "${e.lockClass}" lock held >${LOCK_WAIT_MS}ms. Retrying next tick.`);
      return 'skipped-locked';
    }
    throw e;
  }
  void committed;

  // Push phase (every 6h)
  const now = Date.now();
  const lastPush = readLastPush(lastPushFile);
  const elapsedMs = now - lastPush;

  if (elapsedMs >= PUSH_INTERVAL_MS) {
    log(`[GitSync] Push interval elapsed (${Math.round(elapsedMs / 60000)} min since last push). Pushing.`);
    try {
      await git.push('origin', 'main');
      writeLastPush(lastPushFile, now);
      log('[GitSync] Push complete.');
      return 'committed+pushed';
    } catch (e) {
      // Don't update last-push timestamp — retry next hour.
      log(`[GitSync] Push FAILED: ${e.message}`);
      return 'push-failed';
    }
  }
  const remainingMin = Math.ceil((PUSH_INTERVAL_MS - elapsedMs) / 60000);
  log(`[GitSync] Skipping push (next in ~${remainingMin} min).`);
  return 'committed';
}

/**
 * status → add → commit. Runs inside the lock so nothing on disk is mid-write.
 * Temp files are filtered out of both the staging set and the message.
 */
async function commitPhase(git, log) {
  const status = await git.status();
  const files = status.files.filter((f) => !isTempPath(f.path));
  const skippedTemp = status.files.length - files.length;
  if (skippedTemp > 0) log(`[GitSync] Ignoring ${skippedTemp} in-flight temp file(s).`);
  if (files.length === 0) {
    log('[GitSync] No changes to commit.');
    return false;
  }
  log(`[GitSync] ${files.length} files changed — committing.`);
  await git.add('-A');
  // Belt and braces: unstage anything temp-shaped that `-A` picked up (a temp
  // file already tracked from before .gitignore covered the pattern).
  for (const f of status.files.filter((x) => isTempPath(x.path))) {
    try {
      await git.raw(['restore', '--staged', '--', f.path]);
    } catch {
      /* untracked temp file — nothing staged to restore */
    }
  }
  const summary = summarize(files);
  const detail = files
    .slice(0, 50)
    .map((f) => `  ${f.index || ' '}${f.working_dir || ' '} ${f.path}`)
    .join('\n');
  // Attribution trailers for the Recent Activity Feed: this is automated
  // bookkeeping by the watcher daemon — no LLM ran, so zero tokens is exact.
  const trailers = 'Model: vault-watcher\nTokens: 0';
  const message = `${summary}\n\n${detail}\n\n${trailers}`;
  await git.commit(message);
  log(`[GitSync] Committed: ${summary}`);
  return true;
}

module.exports = { runGitSync, summarize, commitPhase, isTempPath, TEMP_FILE_RE };
