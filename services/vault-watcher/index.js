/**
 * Vault watcher — regenerates MEMORY.md, AGENTS.md, SKILLS.md,
 * shared-mind-context.md on every change to /Volumes/Projects/shared-mind/.
 * Long-lived daemon under launchd (com.thenexus.vault-watcher). Uses
 * Nexus's chokidar. Run with --once to regenerate and exit (no watch).
 *
 * Also owns vault git sync (./git-sync.js — hourly commit, 6-hourly push)
 * since the 2026-07-06 consolidation; the separate
 * com.thenexus.vault-git-sync launchd job is retired.
 *
 * v1 of the regeneration logic — pure concatenation of identity files
 * + filesystem-walk for the index, plus the skill bus:
 *   - SKILLS.md: per-skill one-line summaries + trigger tags so agents
 *     know *when* to reach for a skill, not just that it exists.
 *   - ~/.claude/skills mirror: active vault skills installed as invocable
 *     Claude Code skills (SKILL.md format). One-way vault → home; a
 *     manifest guards against ever deleting user-authored skills.
 *   - AGENTS.md now inlines SKILLS.md so Codex sees summaries too.
 *   - .index/vault-search.json: heading-aware chunk index + per-doc
 *     backlink counts (from the LINKS.md graph pass) consumed by the
 *     Cortex gateway's hybrid vault search (BM25 + vector + RRF —
 *     GBrain pattern). Zero LLM calls here; embeddings are Cortex's job.
 * Frontmatter auto-fill + Cortex mirror come in later waves.
 *
 * MEMORY.md is emitted under a HARD load budget (200 lines / 25,000 bytes —
 * what Claude Code actually injects) and ordered by value, not alphabet:
 * reference → feedback → project → directory pointers → dated notes. Only
 * the dated-note section degrades when the budget bites. Files carrying
 * `status: superseded` / `superseded_by:` frontmatter are excluded from both
 * MEMORY.md and the search chunks. See the MEMORY.md budget block in lib/memory-index.js.
 */

const path = require('path');
const { VAULT, GENERATED_BASENAMES, log } = require('./lib/config');
const { collectDatedSeries, DATED_SERIES_RE, SERIES_MIN_MEMBERS, SERIES_RECENT_KEPT, seriesKey } = require('./lib/dated-series');
const { readSupersession, collectMemoryEntries } = require('./lib/frontmatter');
const {
  MEMORY_MAX_LINES,
  MEMORY_MAX_BYTES,
  MEMORY_GROUPS,
  NOTE_STAGES,
  buildNoteLines,
  buildMemoryIndexLines,
  regenerateMemoryIndex,
} = require('./lib/memory-index');
const { collectSkills, regenerateSkillsIndexFile } = require('./lib/skills-index');
const { regenerateAgentsProjection } = require('./lib/agents-projection');
const { regenerateAntigravityContext } = require('./lib/antigravity-context');
const { syncClaudeSkills } = require('./lib/claude-skills-sync');
const { LINK_SECTIONS, collectDocs, regenerateLinkGraph } = require('./lib/link-graph');
const { INDEX_ROOT_DOCS, collectRootDocs, buildSearchIndexPayload, regenerateSearchIndex } = require('./lib/search-index');
const { withLocks, inspectLocks, LOCK_WARN_AGE_MS } = require('./lib/write-protocol');

const DEBOUNCE_MS = 500;
let debounceTimer = null;

/**
 * P1-17: the watcher OWNS the projections, so one regeneration pass is one
 * critical section under the `projections` lock. Nothing else in the fleet
 * writes MEMORY/SKILLS/AGENTS/LINKS/shared-mind-context — the lock is what
 * stops a second watcher instance (a stray `--once` during a debounced pass)
 * from interleaving two passes over the same five files.
 */
function regenerateAll(reason = 'initial') {
  try {
    return withLocks(VAULT, ['projections'], () => regenerateAllLocked(reason), {
      by: `vault-watcher:${reason}`,
      onStale: ({ className, age }) => log(`WARN reclaimed stale ${className} lock (${Math.round(age / 1000)}s old)`),
    });
  } catch (e) {
    log(`ERROR regenerating: ${e.stack || e.message}`);
    return undefined;
  }
}

function regenerateAllLocked(reason) {
  try {
    const memory = regenerateMemoryIndex();
    const { active } = regenerateSkillsIndexFile();
    regenerateAgentsProjection();
    regenerateAntigravityContext();
    const installed = syncClaudeSkills(active);
    const linkDocs = collectDocs(LINK_SECTIONS);
    const { linkedCount, backlinksByRel } = regenerateLinkGraph(linkDocs);
    // Search index covers the link-graph sections plus personas + root docs.
    const indexDocs = linkDocs.concat(collectDocs(['personas']), collectRootDocs());
    const { docCount, chunkCount, supersededCount } = regenerateSearchIndex(indexDocs, backlinksByRel);
    log(`Regenerated projections (${reason}); MEMORY.md ${memory.lines} lines / ${memory.bytes} bytes (notes: ${memory.stage}), ${active.length} active skills indexed, ${installed} installed to ~/.claude/skills, ${linkedCount} docs in link graph, search index ${docCount} docs / ${chunkCount} chunks, ${supersededCount} superseded docs excluded`);
  } catch (e) {
    log(`ERROR regenerating: ${e.stack || e.message}`);
  }
}

/**
 * In-flight temp files from the atomic write protocol (`.<base>.<pid>.<ts>.tmp`)
 * and the older `.tmp-<pid>` form. They exist for microseconds and are renamed
 * over their target, which fires its own event — regenerating on the temp file
 * itself is pure waste (an add+unlink pair used to cost two debounced passes).
 */
const TEMP_FILE_RE = /(^|[\/\\])\.?[^\/\\]*\.(?:\d+\.\d+\.tmp|tmp)$|\.tmp-\d+$/;

function shouldIgnore(filepath) {
  const rel = path.relative(VAULT, filepath);
  if (TEMP_FILE_RE.test(rel)) return true;
  if (rel.startsWith('.git')) return true;
  if (rel.startsWith('.obsidian')) return true;
  if (rel.startsWith('.index')) return true;
  if (rel.startsWith('_archive')) return true;
  if (path.basename(rel).startsWith('._')) return true;
  // Skip changes to our own generated files (prevent feedback loop)
  const base = path.basename(rel);
  if (GENERATED_BASENAMES.has(base) && !rel.includes('/')) return true;
  return false;
}

function onChange(event, filepath) {
  if (shouldIgnore(filepath)) return;
  const rel = path.relative(VAULT, filepath);
  log(`${event}: ${rel}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => regenerateAll(`debounced ${event}`), DEBOUNCE_MS);
}

// Pure helpers are re-exported from lib/ for unit tests. Everything below this point is
// daemon startup, guarded by require.main so `require()`ing this file (from a
// test, or any tooling) never spawns a watcher or touches the vault.
module.exports = {
  collectSkills,
  DATED_SERIES_RE,
  SERIES_MIN_MEMBERS,
  SERIES_RECENT_KEPT,
  seriesKey,
  collectDatedSeries,
  // Supersession contract (shared with the Praxis STATE.md/supersession task)
  readSupersession,
  collectMemoryEntries,
  // AGENTS.md projection — STATE.md (Praxis-generated) in place of the March CONTEXT.md
  regenerateAgentsProjection,
  INDEX_ROOT_DOCS,
  // MEMORY.md budget + priority ordering
  MEMORY_MAX_LINES,
  MEMORY_MAX_BYTES,
  MEMORY_GROUPS,
  NOTE_STAGES,
  buildNoteLines,
  buildMemoryIndexLines,
  regenerateMemoryIndex,
  // Hybrid-search chunk index
  buildSearchIndexPayload,
  // P1-17 single-writer protocol
  TEMP_FILE_RE,
  shouldIgnore,
};

if (require.main === module) {
  if (process.argv.includes('--once')) {
    regenerateAll('once');
    process.exit(0);
  }

  // Required here, not at module scope: chokidar is ESM-only and is needed
  // only by the daemon, so the pure helpers stay requirable from a CJS test.
  const chokidar = require('chokidar');

  log(`Watching ${VAULT}`);
  log(`Node ${process.version} pid ${process.pid}`);

  const watcher = chokidar.watch(VAULT, {
    ignored: [
      /(^|[\/\\])\.git/,
      /(^|[\/\\])\.obsidian/,
      /(^|[\/\\])\.index/,
      /(^|[\/\\])\._/,
      /(^|[\/\\])_archive/,
      TEMP_FILE_RE,
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('add', (p) => onChange('add', p));
  watcher.on('change', (p) => onChange('change', p));
  watcher.on('unlink', (p) => onChange('unlink', p));
  watcher.on('error', (e) => log(`watcher error: ${e.message}`));
  watcher.on('ready', () => log('Watcher ready'));

  // Initial regen on startup so files reflect current vault state.
  regenerateAll('startup');

  // ── Git sync (hourly commit, 6-hourly push) ──
  const { runGitSync } = require('./git-sync');
  const GIT_SYNC_INTERVAL_MS = 60 * 60 * 1000;

  async function gitSyncTick() {
    try {
      // P1-17 §5: a lock left by a crashed process reclaims itself at 30s, but
      // say so out loud if one is still held after 60s.
      for (const l of inspectLocks(VAULT)) {
        if (l.held && l.ageMs > LOCK_WARN_AGE_MS) {
          log(`WARN vault lock "${l.class}" held ${Math.round(l.ageMs / 1000)}s by ${JSON.stringify(l.owner)}`);
        }
      }
      await runGitSync(VAULT, log);
    } catch (e) {
      log(`[GitSync] ERROR: ${e.stack || e.message}`);
    }
  }

  // First pass shortly after boot (matches the old job's RunAtLoad), then hourly.
  const gitSyncInitialTimer = setTimeout(gitSyncTick, 30_000);
  const gitSyncTimer = setInterval(gitSyncTick, GIT_SYNC_INTERVAL_MS);

  function shutdown(signal) {
    log(`${signal} received, shutting down`);
    clearTimeout(gitSyncInitialTimer);
    clearInterval(gitSyncTimer);
    watcher.close().then(() => process.exit(0));
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
