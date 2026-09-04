/**
 * CommonJS vault-write twin for the MCP server (P1-17).
 *
 * The MCP server is spawned per client with an arbitrary cwd and no
 * node_modules of its own, so — exactly like lib/config.js does for
 * vault-paths — this resolves the fleet helper RELATIVE TO THIS FILE rather
 * than re-implementing it. Same code, same lock file names, same header
 * contract as the watcher and as Praxis/src/vault-write.ts; drift is
 * impossible because there is only one implementation.
 */
module.exports = require('../../../server/lib/vault-write');
