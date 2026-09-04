/**
 * Auth — resolve PRAXIS_MIND_KEY (env, passed by the client via MCP config)
 * to a caller identity + privileges via ~/.praxis-mind/keys.json.
 */
const fs = require('fs');
const { KEYS_FILE } = require('./config');
const { log } = require('./log');

/**
 * The privilege vocabulary keys in ~/.praxis-mind/keys.json may grant. Not
 * enforced as a schema (a key can carry a subset), but the single place the
 * names are listed: every checkPrivilege() call site uses one of these.
 */
const PRIVILEGES = Object.freeze([
  // praxis-mind (services/praxis-mind-mcp/tools/*)
  'vault.read', 'vault.write', 'vault.list', 'vault.search',
  'memory.search', 'memory.recent', 'memory.cite', 'memory.write',
  'brain.chat', 'brain.deliberate',
  'identity.whoami',
  // governed board ops (lib/board-ops.js)
  'nexus.projects_list', 'nexus.tasks_read', 'nexus.task_status',
  'nexus.task_create', 'nexus.task_update', 'nexus.project_update',
  // nexus.scaffold / nexus.git_write / nexus.git_read / nexus.system_read were
  // retired with server/mcp.js (M-1, 2026-09-04); no key ever held them.
]);

let _keys = null;
function loadKeys() {
  if (_keys) return _keys;
  try {
    // The keys file IS the identity boundary: a group/world-accessible copy is
    // no longer a scoped credential, so refuse it rather than trust it.
    const mode = fs.statSync(KEYS_FILE).mode & 0o777;
    if (mode & 0o077) {
      log(`FATAL: ${KEYS_FILE} is group/world-accessible (mode ${mode.toString(8)}) — refusing to load keys. Fix: chmod 600 ${KEYS_FILE}`);
      _keys = {};
      return _keys;
    }
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    _keys = JSON.parse(raw).keys || {};
  } catch (e) {
    log(`FATAL: failed to load keys file ${KEYS_FILE}: ${e.message}`);
    _keys = {};
  }
  return _keys;
}

/**
 * Resolve the caller identity from process env. Returns null if no/invalid key.
 * Shape: { identity, namespace, privileges, rate_limits_per_hour, daily_cap_usd }
 */
function resolveCaller() {
  const key = process.env.PRAXIS_MIND_KEY;
  if (!key) {
    log('No PRAXIS_MIND_KEY in env — caller is unauthenticated');
    return null;
  }
  const keys = loadKeys();
  const meta = keys[key];
  if (!meta) {
    log('PRAXIS_MIND_KEY did not match any registered key');
    return null;
  }
  return meta;
}

/** Throw a structured error tool result if caller lacks the named privilege. */
function checkPrivilege(caller, action) {
  if (!caller) {
    return {
      content: [{ type: 'text', text: 'Error: unauthenticated. PRAXIS_MIND_KEY env var missing or invalid.' }],
      isError: true,
    };
  }
  if (!caller.privileges || !caller.privileges.includes(action)) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: caller "${caller.identity}" lacks privilege "${action}". Allowed: ${(caller.privileges || []).join(', ')}`,
        },
      ],
      isError: true,
    };
  }
  return null; // no error — caller is authorized
}

module.exports = { resolveCaller, checkPrivilege, PRIVILEGES };
