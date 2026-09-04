/**
 * Vault watcher configuration: vault root resolution, derived paths, the
 * generated-file set the watcher must ignore, and the shared logger.
 */

const os = require('os');
const path = require('path');
// Vault root from the fleet-wide helper (server/lib/vault-paths.js). The
// require is relative to THIS file; __tests__/memory-index.test.js copies the
// watcher (index.js + lib/) into a temp dir and requires the copy, from where
// the helper is out of reach — so fall back to the same resolution inline
// rather than crash.
const vaultRoot = (() => {
  try {
    return require('../../../server/lib/vault-paths').vaultRoot;
  } catch {
    return (env = process.env) => {
      const override = env.NEXUS_VAULT_ROOT || env.PRAXIS_VAULT_ROOT;
      return override ? path.resolve(override) : '/Volumes/Projects/shared-mind';
    };
  }
})();

const VAULT = vaultRoot();
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const SYNC_MANIFEST = path.join(CLAUDE_SKILLS_DIR, '.vault-sync-manifest.json');
const GENERATED_BASENAMES = new Set([
  'MEMORY.md',
  'AGENTS.md',
  'SKILLS.md',
  'LINKS.md',
  'shared-mind-context.md',
]);

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

module.exports = {
  vaultRoot,
  VAULT,
  CLAUDE_SKILLS_DIR,
  SYNC_MANIFEST,
  GENERATED_BASENAMES,
  log,
};
