/**
 * brain.* tools — Praxis LLM cascade.
 * External callers FORCED to tier:reasoning and stripped of tool access
 * (design Δ5 — three-layer defense against infinite loops).
 *
 * No invented output budgets: max_tokens is sent only when the MCP caller
 * passes one, so the model's own output limit applies otherwise. Every result
 * carries the upstream finish_reason, and a cut answer ("length") says so in
 * its text.
 */
const { z } = require('zod');
const { checkPrivilege } = require('../lib/auth');
const { checkAndIncrement } = require('../lib/ratelimit');
const backends = require('../lib/backends');
const ledger = require('../lib/ledger');
const cfg = require('../lib/config');
const { AUTHORITY_BOUNDARY } = require('../lib/provenance');
const { chunkText } = require('./vault');

const TOOL_CALL_PATTERNS = [/<function_calls>/i, /<tool_use\b/i, /mcp__[a-zA-Z_]+/i, /"tool_choice"\s*:/i, /"tools"\s*:\s*\[/i];

// Same ranked depth vault_search uses by default (and the Cortex endpoint's
// own default), so grounding introduces no second retrieval number.
const DEFAULT_VAULT_K = 8;

function looksLikeToolCallInjection(text) {
  return TOOL_CALL_PATTERNS.some((re) => re.test(text));
}

function finishReasonOf(data) {
  const reason = data?.choices?.[0]?.finish_reason;
  return typeof reason === 'string' && reason ? reason : null;
}

/**
 * A line for the tool text when the answer may not be whole. "stop" needs no
 * line; the structured result carries finish_reason either way.
 */
function finishNote(finishReason, maxTokens) {
  if (finishReason === 'length') {
    const budget = Number.isInteger(maxTokens)
      ? ` This call passed max_tokens=${maxTokens}; raise it or omit it so the model's own output limit applies.`
      : '';
    return `[Incomplete answer: the model stopped at its output limit (finish_reason: length), so the text above is cut.${budget}]`;
  }
  if (finishReason === null) return '[finish_reason not reported by Praxis: whether this answer is complete is unknown.]';
  if (finishReason !== 'stop') return `[finish_reason: ${finishReason}]`;
  return null;
}

function withFinish(text, finishReason, maxTokens) {
  const note = finishNote(finishReason, maxTokens);
  return note ? `${text}\n\n${note}` : text;
}

/**
 * The grounding message for brain_deliberate: every returned chunk whole,
 * with a header that says how many ranked chunks it holds and how to see the
 * ones below them.
 */
function vaultGroundingBlock(results, k) {
  const shown = results.length;
  const chunks = `${shown} ranked chunk${shown === 1 ? '' : 's'}`;
  const header = shown >= k
    ? `Shared-mind vault context: the top ${chunks} the vault index returned for this question (k=${k}), each whole. Lower-ranked chunks were not included; vault_search with the same question and a larger k lists them.`
    : `Shared-mind vault context: the ${chunks} the vault index returned for this question (k=${k} asked), each whole.`;
  const body = results.map((r, i) => {
    const loc = `${r.path}${r.heading ? ` › ${r.heading}` : ''}`;
    return `[${i + 1}] ${loc}\n${chunkText(r)}`;
  });
  return [header, AUTHORITY_BOUNDARY, '', body.join('\n\n')].join('\n');
}

function register(server, ctx) {
  server.tool(
    'brain_chat',
    'Call Praxis\'s LLM cascade for plain-text reasoning. External callers are forced to tier=reasoning (Gemini Pro or stronger; bypasses local Gemma) and all tool access is stripped: this is for pure reasoning offload only. USE FOR: drafting a summary, classifying text, generating prose. DO NOT USE as a substitute for your own thinking on the user\'s primary task. The result reports the model\'s finish_reason; an answer cut at the output limit says so.',
    {
      messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).describe('OpenAI-style chat messages.'),
      system: z.string().optional().describe('Optional system prompt prepended to messages.'),
      max_tokens: z.number().int().min(1).optional().describe('Optional output-token budget. Omit it (the default) and the model\'s own output limit applies.'),
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
        const data = await backends.praxisChat({
          messages,
          system,
          ...(Number.isInteger(max_tokens) ? { max_tokens } : {}),
          depth: 1,
          caller: ctx.caller.identity,
        });
        const text = data?.choices?.[0]?.message?.content || JSON.stringify(data);
        const usage = data?.usage || {};
        const finishReason = finishReasonOf(data);
        ledger.record({
          caller: ctx.caller.identity,
          tool: 'brain_chat',
          upstream_provider: data?.model || 'praxis-cascade',
          prompt_tokens: usage.prompt_tokens || null,
          completion_tokens: usage.completion_tokens || null,
          latency_ms: Date.now() - started,
          success: true,
        });
        return {
          structuredContent: { finish_reason: finishReason, model: data?.model || null, usage },
          content: [{ type: 'text', text: withFinish(text, finishReason, max_tokens) }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'brain_chat', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `brain_chat failed: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'brain_deliberate',
    'Ask Praxis\'s council / System-2 deliberation for a careful answer to a high-stakes question. Heavier (slower, more tokens) than brain_chat. Deliberations are automatically grounded with the top-ranked shared-mind vault chunks for the question, each chunk whole (vault_k sets how many; disable with vault_grounding: false). The result reports the model\'s finish_reason and what grounding was used. NOTE: v0 routes to brain_chat with a deliberation system prompt until the Cortex council HTTP endpoint exists.',
    {
      question: z.string().describe('The question to deliberate on.'),
      depth: z.enum(['shallow', 'deep']).default('shallow'),
      context: z.array(z.string()).optional().describe('Optional context snippets to ground the deliberation.'),
      vault_grounding: z.boolean().default(true).describe('Prepend top-ranked shared-mind vault chunks for the question.'),
      vault_k: z.number().int().min(1).max(25).default(DEFAULT_VAULT_K).describe(`How many ranked vault chunks ground the deliberation (default ${DEFAULT_VAULT_K}, the vault_search default; the Cortex endpoint accepts 1 to 25).`),
    },
    async ({ question, depth, context, vault_grounding = true, vault_k: vaultK = DEFAULT_VAULT_K }) => {
      const auth = checkPrivilege(ctx.caller, 'brain.deliberate');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'brain_deliberate', ctx.caller.rate_limits_per_hour?.['brain.deliberate']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for brain_deliberate: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      const started = Date.now();
      try {
        // Retrieval-grounded deliberation: the ranked vault chunks ride along
        // whole as a context message. Best-effort: Cortex being down never
        // blocks the deliberation, but the result says it ran ungrounded.
        let vaultBlock = null;
        let grounding = { status: 'disabled' };
        if (vault_grounding) {
          try {
            const hits = await backends.cortexVaultSearch({ query: question, k: vaultK });
            const results = hits?.results || [];
            if (results.length) {
              vaultBlock = vaultGroundingBlock(results, vaultK);
              grounding = {
                status: 'used',
                k: vaultK,
                chunks: results.map((r) => ({ path: r.path, heading: r.heading || null })),
              };
            } else {
              grounding = { status: 'empty', k: vaultK };
            }
          } catch (e) {
            // Do not echo upstream response bodies: they may contain credentials.
            const reason = [401, 403].includes(e.status) ? `authentication failed (HTTP ${e.status})` : 'backend unavailable';
            grounding = { status: 'unavailable', k: vaultK, reason };
          }
        }
        const system = `You are Praxis's deliberation mode. Think step by step. Surface counterexamples. State your confidence. ${depth === 'deep' ? 'Be exhaustive; consider failure modes.' : 'Be concise.'}`;
        const messages = [
          ...(vaultBlock ? [{ role: 'user', content: vaultBlock }] : []),
          ...(context && context.length ? [{ role: 'user', content: `Context:\n${context.join('\n---\n')}` }] : []),
          { role: 'user', content: question },
        ];
        const data = await backends.praxisChat({ messages, system, depth: 1, caller: ctx.caller.identity });
        const text = data?.choices?.[0]?.message?.content || JSON.stringify(data);
        const usage = data?.usage || {};
        const finishReason = finishReasonOf(data);
        ledger.record({
          caller: ctx.caller.identity,
          tool: 'brain_deliberate',
          upstream_provider: data?.model || 'praxis-cascade',
          prompt_tokens: usage.prompt_tokens || null,
          completion_tokens: usage.completion_tokens || null,
          latency_ms: Date.now() - started,
          success: true,
        });
        let answer = withFinish(text, finishReason, undefined);
        if (grounding.status === 'unavailable') {
          answer += `\n\n[Vault grounding unavailable (${grounding.reason}): this deliberation ran without shared-mind vault context.]`;
        }
        return {
          structuredContent: { finish_reason: finishReason, model: data?.model || null, usage, vault_grounding: grounding },
          content: [{ type: 'text', text: answer }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'brain_deliberate', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `brain_deliberate failed: ${e.message}` }], isError: true };
      }
    },
  );
}

module.exports = { register, finishNote, vaultGroundingBlock };
