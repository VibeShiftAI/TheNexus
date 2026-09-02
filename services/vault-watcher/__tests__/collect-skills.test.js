/**
 * collectSkills() must never treat the skill wiki's `_knowledge/` pages (or
 * any other underscore dir except `_candidates/`) as skills: before the
 * 2026-09-02 fix they were listed as "candidates (pending approval — not
 * installed)" and pushed ~19 KB into SKILLS.md and AGENTS.md on every regen.
 *
 * Runs against the live vault (index.js pins VAULT); skipped when it is absent.
 */

const fs = require('node:fs');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { collectSkills } = require('../index.js');

const vaultPresent = fs.existsSync('/Volumes/Projects/shared-mind/skills');

describe('collectSkills', { skip: !vaultPresent && 'vault not mounted' }, () => {
  it('only lists `_candidates/` entries as candidates', () => {
    const { candidates } = collectSkills();
    for (const c of candidates) {
      assert.match(c.relPath, /^skills\/_candidates\//, c.relPath);
    }
  });

  it('never lists a `_knowledge/` page as active or candidate', () => {
    const { active, candidates } = collectSkills();
    for (const e of [...active, ...candidates]) {
      assert.doesNotMatch(e.relPath, /^skills\/_knowledge\//, e.relPath);
    }
  });

  it('keeps every active skill inside a category dir (no underscore dirs)', () => {
    const { active } = collectSkills();
    assert.ok(active.length > 0);
    for (const e of active) {
      assert.doesNotMatch(e.relPath, /^skills\/_/, e.relPath);
    }
  });
});
