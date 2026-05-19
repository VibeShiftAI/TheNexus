/**
 * Auth — resolve PRAXIS_MIND_KEY (env, passed by the client via MCP config)
 * to a caller identity + privileges via ~/.praxis-mind/keys.json.
 */
const fs = require('fs');
const { KEYS_FILE } = require('./config');
const { log } = require('./log');

let _keys = null;
function loadKeys() {
  if (_keys) return _keys;
  try {
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

module.exports = { resolveCaller, checkPrivilege };
