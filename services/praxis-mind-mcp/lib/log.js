/**
 * Logging helper — ALWAYS to stderr. stdout is the JSON-RPC protocol channel
 * for stdio-mode MCP. Any stray stdout write breaks the client.
 */
function log(...args) {
  const ts = new Date().toISOString();
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stderr.write(`[${ts}] ${line}\n`);
}

module.exports = { log };
