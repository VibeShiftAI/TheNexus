const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGitSync } = require('../git-sync');

test('interrupted amendment waits for Praxis recovery before broad vault Git sync', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'interrupted-vault-sync-'));
  const git = (...args) => execFileSync('git', args, { cwd: vault, encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.name', 'sync-test'); git('config', 'user.email', 'test@example.org');
    fs.writeFileSync(path.join(vault, '.gitignore'), '.index/\n');
    git('add', '.gitignore'); git('commit', '-qm', 'initial');
    const before = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(vault, '.git', 'last-push.timestamp'), String(Date.now()));
    fs.writeFileSync(path.join(vault, 'edited'), 'incomplete target');
    fs.writeFileSync(path.join(vault, 'unrelated'), 'staged'); git('add', 'unrelated');
    const journals = path.join(vault, '.index', 'skill-amendments');
    fs.mkdirSync(journals, { recursive: true });
    fs.writeFileSync(path.join(journals, 'test.pending'), '{}');
    expect(await runGitSync(vault, () => {})).toBe('skipped-amendment');
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(git('diff', '--cached', '--name-only').trim()).toBe('unrelated');
    fs.unlinkSync(path.join(journals, 'test.pending'));
    expect(await runGitSync(vault, () => {})).toBe('committed');
    expect(git('rev-parse', 'HEAD')).not.toBe(before);
  } finally { fs.rmSync(vault, { recursive: true, force: true }); }
});
