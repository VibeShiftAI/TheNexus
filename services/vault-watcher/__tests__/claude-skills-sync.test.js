const yaml = require('js-yaml');
const { buildClaudeSkill, selectClaudeSkills, syncClaudeSkills, ALWAYS_MIRROR } = require('../lib/claude-skills-sync');

describe('Claude skill manifests', () => {
  test.each([
    ['Use when defining project endpoints.', ['endpoints', 'interview']],
    ['Use when Robert says "ready: review" or asks about #goals.', []],
  ])('emits parseable discovery metadata for %s', (summary, tags) => {
    const raw = '---\nname: interview-project-endpoints\n---\n\n## Procedure\nAsk one question.\n';
    const entry = { id: 'interview-project-endpoints', relPath: 'skills/operations/interview-project-endpoints.md', summary, tags };
    const manifest = buildClaudeSkill(entry, raw);
    const frontmatter = manifest.match(/^---\n([\s\S]*?)\n---/)[1];
    const parsed = yaml.load(frontmatter);
    expect(parsed.name).toBe(entry.id);
    expect(parsed.description).toContain(summary);
    // Provenance is in the body, not the shared description budget (2026-10-29).
    expect(parsed.description).not.toContain(entry.relPath);
    expect(parsed.description).not.toMatch(/canonical/);
    expect(manifest).toContain(entry.relPath);
    for (const tag of tags) expect(parsed.description).toContain(tag);
    expect(manifest).toContain('## Procedure\nAsk one question.');
  });
});

describe('Claude skill mirror selection', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const entry = (id) => ({ id, relPath: `skills/operations/${id}.md`, summary: id, tags: [] });
  const active = ['plan-day-yourself', 'qa-review-content', 'implement-unused-pattern', 'premortem', ...ALWAYS_MIRROR].map(entry);
  const line = (skillIds, settledAt) => JSON.stringify({ taskId: 't', skillIds, outcome: 'success', settledAt });

  test('mirrors skills used in the last 90 days plus the always-mirrored ones', () => {
    const ledgerText = [
      line(['plan-day-yourself', 'qa-review-content'], '2026-10-20T00:00:00Z'),
      line(['premortem'], '2026-06-01T00:00:00Z'), // outside the window
      'not json',
    ].join('\n');
    const { selected } = selectClaudeSkills(active, { ledgerText, now, mode: undefined });
    expect(selected.map((e) => e.id).sort()).toEqual(['plan-day-yourself', 'qa-review-content', ...ALWAYS_MIRROR].sort());
  });

  test('an empty or unreadable ledger mirrors everything instead of removing skills', () => {
    expect(selectClaudeSkills(active, { ledgerText: '', now, mode: undefined }).selected).toHaveLength(active.length);
    expect(selectClaudeSkills(active, { ledgerText: 'garbage', now, mode: undefined }).selected).toHaveLength(active.length);
  });

  test('VAULT_CLAUDE_SKILLS_MIRROR=all restores the full mirror', () => {
    const ledgerText = line(['plan-day-yourself'], '2026-10-20T00:00:00Z');
    expect(selectClaudeSkills(active, { ledgerText, now, mode: 'all' }).selected).toHaveLength(active.length);
  });

  test('the sync manifest lists skills left out on purpose as withheld', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-'));
    const vault = path.join(tmp, 'vault');
    for (const e of active) {
      fs.mkdirSync(path.dirname(path.join(vault, e.relPath)), { recursive: true });
      fs.writeFileSync(path.join(vault, e.relPath), `---\nname: ${e.id}\n---\nBody\n`);
    }
    // Explicit folders: never let this test reach the real ~/.claude/skills.
    const skillsDir = path.join(tmp, 'skills');
    const manifestPath = path.join(skillsDir, '.vault-sync-manifest.json');
    try {
      const ledgerText = line(['plan-day-yourself'], '2026-10-20T00:00:00Z');
      syncClaudeSkills(active, { ledgerText, now, mode: undefined, skillsDir, manifestPath, vault });
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.synced.sort()).toEqual(['plan-day-yourself', ...ALWAYS_MIRROR].sort());
      expect(manifest.withheld.sort()).toEqual(['implement-unused-pattern', 'premortem', 'qa-review-content']);
      expect(fs.existsSync(path.join(skillsDir, 'plan-day-yourself', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(skillsDir, 'premortem'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
