const fs = require('fs');
const path = require('path');
const { VAULT, CLAUDE_SKILLS_DIR, SYNC_MANIFEST, log } = require('./config');
const { readFileSafe, readJsonSafe } = require('./fs-utils');

// ── Claude Code skill installation ──────────────────────────────────────

const SYNC_MARKER = '<!-- synced-from-shared-mind-vault -->';

/**
 * Compose a Claude Code SKILL.md from a vault skill. The description
 * frontmatter is the trigger surface — summary plus tag hints. The body
 * is the vault manifest body (frontmatter stripped) so the procedure
 * travels with the trigger.
 */
function buildClaudeSkill(entry, raw) {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const tagHint = entry.tags.length
    ? ` Use when the task involves: ${entry.tags.join(', ')}.`
    : '';
  const description = `${(entry.summary || entry.id).replace(/\n/g, ' ')}${tagHint} (shared-mind vault skill — the vault copy at ${entry.relPath} is canonical.)`;
  return [
    '---',
    `name: ${entry.id}`,
    `description: ${description}`,
    '---',
    SYNC_MARKER,
    `> Synced from \`${VAULT}/${entry.relPath}\` by the vault watcher.`,
    '> Edit the vault copy — this file is overwritten on every vault change.',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * Mirror active vault skills into ~/.claude/skills/<id>/SKILL.md so
 * Claude Code can actually invoke them. One-way sync; the manifest
 * records what we installed so removals only ever touch our own dirs.
 * Candidates (skills/_candidates/) and archived skills are never synced.
 */
function syncClaudeSkills(active) {
  fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
  const manifest = readJsonSafe(SYNC_MANIFEST) || { synced: [] };
  const previouslySynced = new Set(manifest.synced);
  const nowSynced = [];

  for (const entry of active) {
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
      log(`skill-sync: removed ${id} (no longer active in vault)`);
    }
  }

  fs.writeFileSync(SYNC_MANIFEST, JSON.stringify({ synced: nowSynced, lastSync: new Date().toISOString() }, null, 2));
  return nowSynced.length;
}

module.exports = { SYNC_MARKER, buildClaudeSkill, syncClaudeSkills };
