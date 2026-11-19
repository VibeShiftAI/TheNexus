/**
 * Auth — resolve PRAXIS_MIND_KEY (env, passed by the client via MCP config)
 * to a caller identity + privileges via ~/.praxis-mind/keys.json.
 */
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
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

// Cache of the parsed keys file, keyed by a stat signature. The file is
// re-read whenever the signature changes, so an operator edit (a revoked key,
// a withdrawn privilege, a chmod) reaches the NEXT invocation of an already
// running spawn instead of waiting for the client to respawn the server.
let _keys = null;
let _keysSignature = null;

function keysSignature() {
  try {
    const st = fs.statSync(KEYS_FILE);
    return [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode].join(':');
  } catch (e) {
    return `unreadable:${e.code || e.message}`;
  }
}

function loadKeys() {
  const signature = keysSignature();
  if (_keys && signature === _keysSignature) return _keys;
  const reloading = _keysSignature !== null;
  _keysSignature = signature;
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
    if (reloading) log(`keys file ${KEYS_FILE} changed since it was last read; reloaded ${Object.keys(_keys).length} key(s)`);
  } catch (e) {
    // Fail closed: an unreadable or half-written file authorizes nobody. The
    // signature changes again when the write completes, which re-reads it.
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

/**
 * Authorize each invocation, not the spawn. Returns a `server` facade whose
 * `tool()` registers every handler wrapped so the caller is resolved from
 * PRAXIS_MIND_KEY + keys.json at the moment of the call, and a `ctx` whose
 * `caller` reads that per-invocation snapshot (one consistent caller for the
 * whole call, null outside any call so nothing can act on a stale grant).
 *
 * Why: tools/call does not require a prior tools/list, and a discovery
 * response is not a durable authorization decision; policy can change between
 * discovery and invocation. A stdio spawn lives as long as the client session
 * (hours), so a caller resolved once at spawn kept a revoked grant alive for
 * the rest of that session. server/__tests__/mcp-boundary-denied-calls.test.js
 * drives the real stdio server through both orderings.
 */
function perInvocationAuth(server, resolve = resolveCaller) {
  const invocation = new AsyncLocalStorage();
  const ctx = {
    get caller() {
      const store = invocation.getStore();
      return store ? store.caller : null;
    },
  };
  const scopedServer = {
    tool(...args) {
      const handler = args[args.length - 1];
      return server.tool(
        ...args.slice(0, -1),
        (...callArgs) => invocation.run({ caller: resolve() }, () => handler(...callArgs)),
      );
    },
  };
  return { server: scopedServer, ctx };
}

module.exports = { resolveCaller, checkPrivilege, perInvocationAuth, PRIVILEGES };
