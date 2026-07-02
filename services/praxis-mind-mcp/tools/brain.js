/**
 * brain.* tools — Praxis LLM cascade.
 * External callers FORCED to tier:reasoning and stripped of tool access
 * (design Δ5 — three-layer defense against infinite loops).
 */
const { z } = require('zod');
const { checkPrivilege } = require('../lib/auth');
const { checkAndIncrement } = require('../lib/ratelimit');
const backends = require('../lib/backends');
const ledger = require('../lib/ledger');
const cfg = require('../lib/config');

const TOOL_CALL_PATTERNS = [/<function_calls>/i, /<tool_use\b/i, /mcp__[a-zA-Z_]+/i, /"tool_choice"\s*:/i, /"tools"\s*:\s*\[/i];

function looksLikeToolCallInjection(text) {
  return TOOL_CALL_PATTERNS.some((re) => re.test(text));
}

function register(server, ctx) {
  server.tool(
    'brain_chat',
    'Call Praxis\'s LLM cascade for plain-text reasoning. External callers are forced to tier=reasoning (Gemini Pro or stronger; bypasses local Gemma) and all tool access is stripped — this is for pure reasoning offload only. USE FOR: drafting a summary, classifying text, generating prose. DO NOT USE as a substitute for your own thinking on the user\'s primary task.',
    {
      messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).describe('OpenAI-style chat messages.'),
      system: z.string().optional().describe('Optional system prompt prepended to messages.'),
      max_tokens: z.number().int().min(1).max(8192).default(2048),
    },
    async ({ messages, system, max_tokens }) => {
      const auth = checkPrivilege(ctx.caller, 'brain.chat');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'brain_chat', ctx.caller.rate_limits_per_hour?.['brain.chat']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for brain_chat: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      // Loop prevention: reject prompts that look like attempts to invoke MCP tools.
      const combined = (system || '') + '\n' + messages.map((m) => m.content).join('\n');
      if (looksLikeToolCallInjection(combined)) {
        return { content: [{ type: 'text', text: 'brain_chat rejected: prompt contains tool-call patterns. brain_chat is for plain-text reasoning only.' }], isError: true };
      }
      const started = Date.now();
      try {
        const data = await backends.praxisChat({ messages, system, max_tokens, depth: 1, caller: ctx.caller.identity });
        const text = data?.choices?.[0]?.message?.content || JSON.stringify(data);
        const usage = data?.usage || {};
        ledger.record({
          caller: ctx.caller.identity,
          tool: 'brain_chat',
          upstream_provider: data?.model || 'praxis-cascade',
          prompt_tokens: usage.prompt_tokens || null,
          completion_tokens: usage.completion_tokens || null,
          latency_ms: Date.now() - started,
          success: true,
        });
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'brain_chat', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `brain_chat failed: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'brain_deliberate',
    'Ask Praxis\'s council / System-2 deliberation for a careful answer to a high-stakes question. Heavier (slower, more tokens) than brain_chat. Deliberations are automatically grounded with top-ranked shared-mind vault hits for the question (disable with vault_grounding: false). NOTE: v0 routes to brain_chat with a deliberation system prompt until the Cortex council HTTP endpoint exists.',
    {
      question: z.string().describe('The question to deliberate on.'),
      depth: z.enum(['shallow', 'deep']).default('shallow'),
      context: z.array(z.string()).optional().describe('Optional context snippets to ground the deliberation.'),
      vault_grounding: z.boolean().default(true).describe('Prepend top-ranked shared-mind vault hits for the question.'),
    },
    async ({ question, depth, context, vault_grounding = true }) => {
      const auth = checkPrivilege(ctx.caller, 'brain.deliberate');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'brain_deliberate', ctx.caller.rate_limits_per_hour?.['brain.deliberate']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for brain_deliberate: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      const started = Date.now();
      try {
        // Retrieval-grounded deliberation: top vault hits ride along as a
        // context message. Best-effort — Cortex being down never blocks the
        // deliberation itself.
        let vaultBlock = null;
        if (vault_grounding) {
          try {
            const hits = await backends.cortexVaultSearch({ query: question, k: 3 });
            if (hits?.results?.length) {
              vaultBlock = 'Shared-mind vault context (ranked):\n' + hits.results
                .map((r) => `- [${r.path}${r.heading ? ` › ${r.heading}` : ''}] ${(r.text || '').replace(/\s+/g, ' ').slice(0, 250)}`)
                .join('\n');
            }
          } catch (_) { /* vault index unavailable — deliberate without it */ }
        }
        const system = `You are Praxis's deliberation mode. Think step by step. Surface counterexamples. State your confidence. ${depth === 'deep' ? 'Be exhaustive; consider failure modes.' : 'Be concise.'}`;
        const messages = [
          ...(vaultBlock ? [{ role: 'user', content: vaultBlock }] : []),
          ...(context && context.length ? [{ role: 'user', content: `Context:\n${context.join('\n---\n')}` }] : []),
          { role: 'user', content: question },
        ];
        const data = await backends.praxisChat({ messages, system, max_tokens: depth === 'deep' ? 6000 : 3000, depth: 1, caller: ctx.caller.identity });
        const text = data?.choices?.[0]?.message?.content || JSON.stringify(data);
        const usage = data?.usage || {};
        ledger.record({
          caller: ctx.caller.identity,
          tool: 'brain_deliberate',
          upstream_provider: data?.model || 'praxis-cascade',
          prompt_tokens: usage.prompt_tokens || null,
          completion_tokens: usage.completion_tokens || null,
          latency_ms: Date.now() - started,
          success: true,
        });
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'brain_deliberate', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `brain_deliberate failed: ${e.message}` }], isError: true };
      }
    },
  );
}

module.exports = { register };
