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

const PUSH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

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

  // Commit phase
  const status = await git.status();
  if (status.files.length === 0) {
    log('[GitSync] No changes to commit.');
  } else {
    log(`[GitSync] ${status.files.length} files changed — committing.`);
    await git.add('-A');
    const summary = summarize(status.files);
    const detail = status.files
      .slice(0, 50)
      .map((f) => `  ${f.index || ' '}${f.working_dir || ' '} ${f.path}`)
      .join('\n');
    const message = `${summary}\n\n${detail}`;
    await git.commit(message);
    log(`[GitSync] Committed: ${summary}`);
  }

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

module.exports = { runGitSync, summarize };
