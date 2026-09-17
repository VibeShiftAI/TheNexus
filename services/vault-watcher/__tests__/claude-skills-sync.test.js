const yaml = require('js-yaml');
const { buildClaudeSkill } = require('../lib/claude-skills-sync');

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
    expect(parsed.description).toContain(entry.relPath);
    for (const tag of tags) expect(parsed.description).toContain(tag);
    expect(manifest).toContain('## Procedure\nAsk one question.');
  });
});
