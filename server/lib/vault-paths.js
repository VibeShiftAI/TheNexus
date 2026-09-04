/**
 * Central shared-mind vault path resolution for TheNexus (ticket P1-16).
 *
 * One home for the vault root instead of `/Volumes/Projects/shared-mind`
 * spelled out per service. Resolution: NEXUS_VAULT_ROOT → PRAXIS_VAULT_ROOT
 * (so a relocated vault configured once for Praxis is honoured here too) →
 * DEFAULT_VAULT_ROOT. Read per call, never captured at module load, so a
 * test can point the vault at a temp dir before requiring a consumer.
 *
 * CommonJS on purpose: server/, services/vault-watcher and
 * services/praxis-mind-mcp are all `require()` modules, and praxis-mind-mcp
 * is spawned per MCP client with its own cwd — consumers must reach this
 * file by a path relative to their own location, never via cwd.
 */

const path = require('path');

const DEFAULT_VAULT_ROOT = '/Volumes/Projects/shared-mind';

/** The vault root, overridable for tests and relocations. */
function vaultRoot(env = process.env) {
  const override = env.NEXUS_VAULT_ROOT || env.PRAXIS_VAULT_ROOT;
  return override ? path.resolve(override) : DEFAULT_VAULT_ROOT;
}

/** Join path segments under the resolved vault root. */
function vaultPath(...segments) {
  return path.join(vaultRoot(), ...segments);
}

function vaultMemoriesDir(env = process.env) { return path.join(vaultRoot(env), 'memories'); }
function vaultSkillsDir(env = process.env) { return path.join(vaultRoot(env), 'skills'); }
function vaultProjectsDir(env = process.env) { return path.join(vaultRoot(env), 'projects'); }
function vaultIncidentsDir(env = process.env) { return path.join(vaultRoot(env), 'incidents'); }
/** `.index/` — the watcher-built search index consumed by the Cortex gateway. */
function vaultIndexDir(env = process.env) { return path.join(vaultRoot(env), '.index'); }

module.exports = {
  DEFAULT_VAULT_ROOT,
  vaultRoot,
  vaultPath,
  vaultMemoriesDir,
  vaultSkillsDir,
  vaultProjectsDir,
  vaultIncidentsDir,
  vaultIndexDir,
};
