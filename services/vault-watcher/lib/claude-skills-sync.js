const fs = require('fs');
const path = require('path');
const { VAULT, CLAUDE_SKILLS_DIR, SYNC_MANIFEST, SKILL_USAGE_LEDGER, log } = require('./config');
const { readFileSafe, readJsonSafe } = require('./fs-utils');

// ── Claude Code skill installation ──────────────────────────────────────

const SYNC_MARKER = '<!-- synced-from-shared-mind-vault -->';

/**
 * Compose a Claude Code SKILL.md from a vault skill. The description
 * frontmatter is the trigger surface — summary plus tag hints. The body
 * is the vault manifest body (frontmatter stripped) so the procedure
 * travels with the trigger. Provenance lives in the body's "Synced from"
 * line, not the description: a per-skill canonical-source suffix cost about
 * 115 characters of Claude Code's shared description budget per skill.
 */
function buildClaudeSkill(entry, raw) {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const tagHint = entry.tags.length
    ? ` Use when the task involves: ${entry.tags.join(', ')}.`
    : '';
  const description = `${(entry.summary || entry.id).replace(/\n/g, ' ')}${tagHint}`;
  return [
    '---',
    `name: ${entry.id}`,
    // Descriptions include colon-separated tag hints; quote them as YAML
    // strings so discovery does not interpret their text as another mapping.
    `description: ${JSON.stringify(description)}`,
    '---',
    SYNC_MARKER,
    `> Synced from \`${VAULT}/${entry.relPath}\` by the vault watcher.`,
    '> Edit the vault copy — this file is overwritten on every vault change.',
    '',
    body,
    '',
  ].join('\n');
}

/** Interactively invoked skills that Praxis's ledger cannot see (Claude Code Skill tool calls, 2026-09/10). */
const ALWAYS_MIRROR = ['restart-praxis', 'system-self-upgrade-routine', 'vibeshiftai-site-standards'];
const USAGE_WINDOW_DAYS = 90;

/**
 * Choose which active skills to mirror. Claude Code shows full descriptions
 * only up to a fixed total budget: on 2026-10-29 a fresh session described
 * 36 of the 139 mirrored vault skills (about 15,700 characters) and listed the
 * other 103 as bare names, while the Skill tool invoked vault skills 5 times
 * in 60 days. Mirroring the skills with recorded use keeps every mirrored
 * description visible; the rest stay in the vault, SKILLS.md and vault_search.
 * An unreadable or empty ledger mirrors everything rather than silently
 * removing skills. VAULT_CLAUDE_SKILLS_MIRROR=all restores the full mirror.
 */
function selectClaudeSkills(active, { ledgerText = '', now = Date.now(), mode = process.env.VAULT_CLAUDE_SKILLS_MIRROR, always = ALWAYS_MIRROR } = {}) {
  if (mode === 'all') return { selected: active, reason: 'all skills (VAULT_CLAUDE_SKILLS_MIRROR=all)' };
  const since = now - USAGE_WINDOW_DAYS * 86_400_000;
  const used = new Set();
  for (const line of String(ledgerText || '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(rec.settledAt || rec.recordedAt || '');
    if (Number.isFinite(ts) && ts < since) continue;
    for (const id of rec.skillIds || []) if (typeof id === 'string') used.add(id);
  }
  if (used.size === 0) return { selected: active, reason: 'all skills (no usage ledger entries found)' };
  const keep = new Set([...used, ...always]);
  const selected = active.filter((entry) => keep.has(entry.id));
  return { selected, reason: `${selected.length} of ${active.length} skills with recorded use in ${USAGE_WINDOW_DAYS} days or always mirrored` };
}

/**
 * Mirror active vault skills into ~/.claude/skills/<id>/SKILL.md so
 * Claude Code can actually invoke them. One-way sync; the manifest
 * records what we installed so removals only ever touch our own dirs.
 * Candidates (skills/_candidates/) and archived skills are never synced.
 */
function syncClaudeSkills(active, options = {}) {
  fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
  const ledgerText = options.ledgerText !== undefined ? options.ledgerText : readFileSafe(SKILL_USAGE_LEDGER);
  const { selected, reason } = selectClaudeSkills(active, { ...options, ledgerText });
  log(`skill-sync: mirroring ${reason}`);
  const manifest = readJsonSafe(SYNC_MANIFEST) || { synced: [] };
  const previouslySynced = new Set(manifest.synced);
  const nowSynced = [];

  for (const entry of selected) {
    const raw = readFileSafe(path.join(VAULT, entry.relPath));
    if (!raw) continue;
    const dir = path.join(CLAUDE_SKILLS_DIR, entry.id);
    const target = path.join(dir, 'SKILL.md');
    // Never overwrite a user-authored skill that we didn't install.
    if (fs.existsSync(target) && !previouslySynced.has(entry.id)) {
      const existing = readFileSafe(target);
      if (!existing.includes(SYNC_MARKER)) {
        log(`skill-sync: skipping ${entry.id} (user-authored skill exists at ${target})`);
        continue;
      }
    }
    const content = buildClaudeSkill(entry, raw);
    fs.mkdirSync(dir, { recursive: true });
    // Only write on change to avoid pointless mtime churn.
    if (readFileSafe(target) !== content) fs.writeFileSync(target, content);
    nowSynced.push(entry.id);
  }

  // Remove installs whose vault source is gone (archived or deleted) —
  // but only dirs we created, and only if they still carry our marker.
  const nowSyncedSet = new Set(nowSynced);
  for (const id of previouslySynced) {
    if (nowSyncedSet.has(id)) continue;
    const target = path.join(CLAUDE_SKILLS_DIR, id, 'SKILL.md');
    if (fs.existsSync(target) && readFileSafe(target).includes(SYNC_MARKER)) {
      fs.rmSync(path.join(CLAUDE_SKILLS_DIR, id), { recursive: true, force: true });
      log(`skill-sync: removed ${id} (not active or not selected for the mirror)`);
    }
  }

  fs.writeFileSync(SYNC_MANIFEST, JSON.stringify({ synced: nowSynced, lastSync: new Date().toISOString() }, null, 2));
  return nowSynced.length;
}

module.exports = { SYNC_MARKER, ALWAYS_MIRROR, buildClaudeSkill, selectClaudeSkills, syncClaudeSkills };
