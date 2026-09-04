/**
 * Static configuration: backend endpoints, file paths, defaults.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
// Relative to this file (NOT cwd): the MCP server is spawned per client with
// an arbitrary cwd, so the require must resolve from services/praxis-mind-mcp/.
const { vaultRoot } = require('../../../server/lib/vault-paths');

// Load ~/.praxis-mind/.env into process.env BEFORE reading values below.
// Tiny inline parser (we don't want a dotenv dep for an ephemeral MCP server).
(() => {
  const envFile = path.join(os.homedir(), '.praxis-mind', '.env');
  if (!fs.existsSync(envFile)) return;
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // Don't clobber an explicitly-set env (client-provided takes precedence).
    if (!(k in process.env)) process.env[k] = v;
  }
})();

module.exports = {
  // Backends
  CORTEX_GATEWAY: process.env.CORTEX_GATEWAY_URL || 'http://localhost:8100',
  CORTEX_GATEWAY_KEY: process.env.CORTEX_GATEWAY_KEY || '',
  PRAXIS: process.env.PRAXIS_URL || 'http://localhost:54322',
  NEXUS: process.env.NEXUS_URL || 'http://localhost:4000',

  // Vault root (also the Praxis-priority canonical content store)
  // Resolved AFTER the ~/.praxis-mind/.env load above, so NEXUS_VAULT_ROOT /
  // PRAXIS_VAULT_ROOT set there are honoured.
  VAULT: vaultRoot(),

  // State files (shared across ephemeral MCP spawns — must be WAL/atomic)
  KEYS_FILE: path.join(os.homedir(), '.praxis-mind', 'keys.json'),
  // Overridable so tests (and a throwaway probe) never write into the real
  // ledger — same escape hatch TRANSITION_LOG already has.
  LEDGER_DB: process.env.PRAXIS_MIND_LEDGER_DB
    || path.join(os.homedir(), '.praxis-mind', 'cost_ledger.sqlite'),
  TRANSITION_LOG: process.env.PRAXIS_MIND_TRANSITION_LOG
    || path.join(os.homedir(), '.praxis-mind', 'transition-log.jsonl'),

  // Defaults
  HTTP_TIMEOUT_MS: 30000,
  BRAIN_TIMEOUT_MS: 180000, // brain.chat can be slow (Praxis cascade)

  // Forced overrides for external callers (per design Δ5 / Δ3)
  BRAIN_FORCE_TIER: 'reasoning', // external callers always force reasoning tier
  BRAIN_FORCE_NO_TOOLS: true,    // strip tool support from brain calls (loop prevention)
  BRAIN_MAX_DEPTH: 2,            // X-Brain-Depth header cap
};
