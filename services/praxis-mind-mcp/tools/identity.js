/**
 * identity.* tools — introspection.
 */
const { z } = require('zod');
const { checkPrivilege } = require('../lib/auth');
const ledger = require('../lib/ledger');
const { log } = require('../lib/log');

function register(server, ctx) {
  server.tool(
    'identity_whoami',
    'Return the caller identity, namespace, privileges, and recent usage (last 24h cost + recent calls). Use this when you want to know who you are to praxis-mind, what you can and cannot do, or how much you have spent.',
    {},
    async () => {
      const auth = checkPrivilege(ctx.caller, 'identity.whoami');
      if (auth) return auth;

      const since = ledger.costSince(ctx.caller.identity, 24);
      const recent = ledger.recent(ctx.caller.identity, 10);

      const out = {
        identity: ctx.caller.identity,
        namespace: ctx.caller.namespace,
        privileges: ctx.caller.privileges,
        rate_limits_per_hour: ctx.caller.rate_limits_per_hour,
        daily_cap_usd: ctx.caller.daily_cap_usd,
        cost_last_24h_usd: Math.round(since * 100) / 100,
        recent_calls: recent,
      };
      ledger.record({ caller: ctx.caller.identity, tool: 'identity_whoami', success: true });
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  );
}

module.exports = { register };
