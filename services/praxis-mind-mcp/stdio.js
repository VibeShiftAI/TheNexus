#!/usr/bin/env node
/**
 * praxis-mind MCP server (stdio mode).
 *
 * Ephemeral spawn per MCP client (Claude Code, Codex). Shared state (cost
 * ledger, rate limits) lives in WAL-mode sqlite at ~/.praxis-mind/.
 *
 * Caller identity comes from PRAXIS_MIND_KEY env (passed by the client
 * via its MCP config). Resolved against ~/.praxis-mind/keys.json (chmod 600)
 * on every tool call, not once per spawn, so revocation is not deferred to
 * the next respawn.
 *
 * IMPORTANT: never write to stdout from anything other than the SDK —
 * stdout is the JSON-RPC channel. All diagnostics go to stderr.
 */

// Silence anything that might log to stdout from libraries.
process.env.DOTENV_CONFIG_QUIET = 'true';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const { log } = require('./lib/log');
const { resolveCaller, perInvocationAuth } = require('./lib/auth');

const identityTool = require('./tools/identity');
const vaultTool = require('./tools/vault');
const memoryTool = require('./tools/memory');
const brainTool = require('./tools/brain');
const nexusTool = require('./tools/nexus');

async function main() {
  const caller = resolveCaller();
  if (caller) {
    log(`praxis-mind spawned for caller=${caller.identity} namespace=${caller.namespace}`);
  } else {
    log('praxis-mind spawned UNAUTHENTICATED — tools will refuse');
  }

  const server = new McpServer({
    name: 'praxis-mind',
    version: '0.1.0',
  });

  // The spawn-time resolution above is for the log only. Every tool call
  // re-resolves its caller (lib/auth.js perInvocationAuth), so a key revoked
  // or narrowed in keys.json applies to this session's next call.
  const scoped = perInvocationAuth(server);

  identityTool.register(scoped.server, scoped.ctx);
  vaultTool.register(scoped.server, scoped.ctx);
  memoryTool.register(scoped.server, scoped.ctx);
  brainTool.register(scoped.server, scoped.ctx);
  nexusTool.register(scoped.server, scoped.ctx);

  log('All tools registered. Connecting transport.');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Transport connected — awaiting MCP requests.');
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
