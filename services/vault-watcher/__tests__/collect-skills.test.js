/**
 * collectSkills() must never treat the skill wiki's `_knowledge/` pages (or
 * any other underscore dir except `_candidates/`) as skills: before the
 * 2026-09-02 fix they were listed as "candidates (pending approval — not
 * installed)" and pushed ~19 KB into SKILLS.md and AGENTS.md on every regen.
 *
 * Runs with Jest against a temporary vault, including indexed wiki pages.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let vault;
let collectSkills;

beforeAll(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-skills-'));
  for (const [dir, id, state] of [
    ['operations', 'active-skill', 'active'],
    ['operations', 'retired-skill', 'archived'],
    ['_candidates', 'candidate-skill', 'active'],
    ['_knowledge', 'active-skill', 'active'],
    ['_knowledge', 'wiki-only', 'active'],
    ['_failed_eval', 'failed-skill', 'active'],
  ]) {
    const target = path.join(vault, 'skills', dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${id}.md`),
      `---\nname: ${id}\nstate: ${state}\n---\n\n## Summary\nFixture skill.\n`);
  }
  fs.writeFileSync(path.join(vault, 'skills', '_index.json'), JSON.stringify({
    skills: [{ id: 'active-skill', category: 'operations', state: 'active', summary: 'Indexed skill', tags: [] }],
  }));
  jest.doMock('../lib/config', () => ({
    ...jest.requireActual('../lib/config'),
    VAULT: vault,
  }));
  ({ collectSkills } = require('../lib/skills-index'));
});

afterAll(() => {
  if (vault) fs.rmSync(vault, { recursive: true, force: true });
  jest.dontMock('../lib/config');
});

describe('collectSkills', () => {
  it('only lists `_candidates/` entries as candidates', () => {
    const { candidates } = collectSkills();
    expect(candidates.map((entry) => entry.relPath)).toEqual([
      'skills/_candidates/candidate-skill.md',
    ]);
  });

  it('never lists a `_knowledge/` page as active or candidate', () => {
    const { active, candidates } = collectSkills();
    for (const e of [...active, ...candidates]) {
      expect(e.relPath).not.toMatch(/^skills\/_knowledge\//);
    }
  });

  it('excludes archived skills and other underscore directories from active skills', () => {
    const { active } = collectSkills();
    expect(active.map((entry) => entry.relPath)).toEqual([
      'skills/operations/active-skill.md',
    ]);
  });
});
