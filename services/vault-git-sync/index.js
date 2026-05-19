/**
 * Vault git sync — commits hourly (if changes), pushes every 6 hours.
 * Runs on launchd's StartInterval=3600 (once per hour). Stateless except
 * for .git/last-push.timestamp inside the vault repo itself.
 *
 * v0 commit messages are heuristic (file-count + categories). Wave 4 will
 * swap in praxis brain.chat with tier:fast for prose summaries.
 */

const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');

const VAULT = '/Volumes/Projects/shared-mind';
const PUSH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LAST_PUSH_FILE = path.join(VAULT, '.git', 'last-push.timestamp');

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function readLastPush() {
  try {
    return parseInt(fs.readFileSync(LAST_PUSH_FILE, 'utf8'), 10) || 0;
  } catch (e) {
    return 0;
  }
}

function writeLastPush(ts) {
  fs.writeFileSync(LAST_PUSH_FILE, String(ts));
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

async function main() {
  if (!fs.existsSync(path.join(VAULT, '.git'))) {
    log(`ERROR: ${VAULT} is not a git repo`);
    process.exit(1);
  }

  const git = simpleGit(VAULT);

  // Commit phase
  const status = await git.status();
  if (status.files.length === 0) {
    log('No changes to commit.');
  } else {
    log(`${status.files.length} files changed — committing.`);
    await git.add('-A');
    const summary = summarize(status.files);
    const detail = status.files
      .slice(0, 50)
      .map((f) => `  ${f.index || ' '}${f.working_dir || ' '} ${f.path}`)
      .join('\n');
    const message = `${summary}\n\n${detail}`;
    await git.commit(message);
    log(`Committed: ${summary}`);
  }

  // Push phase (every 6h)
  const now = Date.now();
  const lastPush = readLastPush();
  const elapsedMs = now - lastPush;

  if (elapsedMs >= PUSH_INTERVAL_MS) {
    log(`Push interval elapsed (${Math.round(elapsedMs / 60000)} min since last push). Pushing.`);
    try {
      await git.push('origin', 'main');
      writeLastPush(now);
      log('Push complete.');
    } catch (e) {
      log(`Push FAILED: ${e.message}`);
      // Don't update last-push timestamp — retry next hour.
      process.exit(1);
    }
  } else {
    const remainingMin = Math.ceil((PUSH_INTERVAL_MS - elapsedMs) / 60000);
    log(`Skipping push (next in ~${remainingMin} min).`);
  }
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
