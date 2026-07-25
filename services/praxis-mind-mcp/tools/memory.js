/**
 * memory.* tools — Cortex backends (Pinecone semantic + Neo4j graph).
 * memory_write reuses Praxis's existing Cortex ingestAtoms entrypoint
 * (POST /api/memory/ingest_atoms) per the design — no parallel write path.
 */
const crypto = require('crypto');
const { z } = require('zod');
const { checkPrivilege } = require('../lib/auth');
const { checkAndIncrement } = require('../lib/ratelimit');
const backends = require('../lib/backends');
const ledger = require('../lib/ledger');
const { executeTransaction, compareFields } = require('../lib/transactions');
const { classifyNamespace, formatRetrieved } = require('../lib/provenance');

const READ_ONLY_CYPHER_RE = /\b(CREATE|DELETE|MERGE|SET|REMOVE|DROP|CALL\s+apoc\.create)\b/i;

function register(server, ctx) {
  server.tool(
    'memory_search',
    'Search Cortex semantic memory (Pinecone vectors). USE FOR: looking up factoids, observations, prior research. Returns ranked hits with text and metadata.',
    {
      query: z.string().describe('Natural-language query.'),
      k: z.number().int().min(1).max(50).default(10).describe('How many results to return.'),
      namespace: z.string().optional().describe('Pinecone namespace. Default "ai-research" (Praxis Path B corpus). Other valid namespaces: "coding-agents-claude", "coding-agents-codex", "identity".'),
    },
    async ({ query, k, namespace }) => {
      const auth = checkPrivilege(ctx.caller, 'memory.search');
      if (auth) return auth;
      const started = Date.now();
      try {
        const ns = namespace || 'ai-research';
        const data = await backends.cortexSearch({ query, k, namespace: ns });
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_search', success: true, latency_ms: Date.now() - started });
        // The research corpus is externally ingested (papers, articles) — the
        // exact material the authority-laundering finding is about.
        return {
          content: [{
            type: 'text',
            text: formatRetrieved(
              { origin: `cortex:search:${ns}`, tier: classifyNamespace(ns) },
              JSON.stringify(data, null, 2),
            ),
          }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_search', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `memory_search failed: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_recent',
    'Recent activity from Cortex graph (Neo4j). USE FOR: "what has Praxis been working on lately", "what happened in the last N hours". Returns recent Episodic / Synthesis nodes.',
    {
      hours: z.number().int().min(1).max(168).default(24).describe('Trailing window in hours.'),
      limit: z.number().int().min(1).max(200).default(50),
      types: z.array(z.string()).optional().describe('Optional node-type filter, e.g. ["Episodic", "Synthesis"].'),
    },
    async ({ hours, limit, types }) => {
      const auth = checkPrivilege(ctx.caller, 'memory.recent');
      if (auth) return auth;
      const started = Date.now();
      try {
        const data = await backends.cortexRecent({ hours, limit, types: types || null });
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_recent', success: true, latency_ms: Date.now() - started });
        // Graph nodes span our own episodes and ingested material — floor to advisory.
        return {
          content: [{
            type: 'text',
            text: formatRetrieved(
              { origin: 'cortex:recent', tier: 'external', note: 'Mixed-provenance graph nodes.' },
              JSON.stringify(data, null, 2),
            ),
          }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_recent', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `memory_recent failed: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_cite',
    'Run a READ-ONLY Cypher query against Cortex graph (Neo4j). Mutations (CREATE/DELETE/MERGE/SET/REMOVE/DROP) are rejected syntactically. USE FOR: graph traversal — citation graph, derivation chains, fact provenance.',
    {
      query: z.string().describe('Cypher MATCH query. Must be read-only.'),
      params: z.record(z.string(), z.any()).optional().describe('Cypher parameters.'),
    },
    async ({ query, params }) => {
      const auth = checkPrivilege(ctx.caller, 'memory.cite');
      if (auth) return auth;
      if (READ_ONLY_CYPHER_RE.test(query)) {
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_cite', success: false, error: 'mutation rejected' });
        return { content: [{ type: 'text', text: 'memory_cite is read-only. Use memory_write to add factoids.' }], isError: true };
      }
      const started = Date.now();
      try {
        const data = await backends.cortexCypher({ query, params: params || {} });
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_cite', success: true, latency_ms: Date.now() - started });
        return {
          content: [{
            type: 'text',
            text: formatRetrieved(
              { origin: 'cortex:cypher', tier: 'external', note: 'Mixed-provenance graph nodes.' },
              JSON.stringify(data, null, 2),
            ),
          }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_cite', success: false, latency_ms: Date.now() - started, error: e.message });
        return { content: [{ type: 'text', text: `memory_cite failed: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'memory_write',
    'Write a transient observation to Cortex (vector + graph). USE FOR: ephemeral facts that may become irrelevant — "Robert is in NYC today", "port 5432 in use as of 3am", "build X failed with error Y". Subject to compaction. DO NOT USE for reusable procedures, durable identity facts, or anything you would want to find by browsing in a year. For durable content, use vault_write to skills/, memories/, or projects/.',
    {
      text: z.string().describe('The factual observation. Will become the Episodic node content.'),
      kind: z.string().default('observation').describe('Free-form tag, e.g. "observation", "decision", "build-status".'),
      entities: z.array(z.object({ name: z.string(), type: z.string().default('Concept'), summary: z.string().optional() })).default([]).describe('Optional entities to extract.'),
      factoids: z.array(z.string()).default([]).describe('Optional standalone factoids derived from the observation.'),
    },
    async ({ text, kind, entities, factoids }) => {
      const auth = checkPrivilege(ctx.caller, 'memory.write');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'memory_write', ctx.caller.rate_limits_per_hour?.['memory.write']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for memory_write: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      const started = Date.now();
      try {
        const uuid = `coding-${ctx.caller.identity}_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
        const source = `coding-agents-${ctx.caller.identity}`;
        const target = { episode_uuid: uuid, namespace: ctx.caller.namespace };
        const tx = await executeTransaction({
          tool: 'memory_write',
          caller: ctx.caller,
          target,
          intent: { text, kind, entities, factoids },
          captureBefore: () => backends.cortexEpisodeById(uuid),
          validatePreconditions: ({ before }) => before === null
            ? []
            : [{ field: 'episode_uuid', expected: null, actual: before.name || uuid }],
          apply: () => backends.cortexIngestAtoms({
            episode_uuid: uuid,
            episode_text: text,
            entities,
            relations: [],
            factoids,
            source,
            namespace: ctx.caller.namespace,
          }),
          readAfter: () => backends.cortexEpisodeById(uuid),
          verify: ({ after }) => {
            const mismatches = compareFields(after, {
              name: uuid,
              content: text.slice(0, 8000),
              source,
              factoids,
            });
            return { ok: mismatches.length === 0, mismatches };
          },
        });
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_write', success: true, latency_ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify({ episode_uuid: uuid, kind, ...tx.result, transaction_id: tx.transactionId }, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'memory_write', success: false, latency_ms: Date.now() - started, error: e.message });
        const suffix = e.transactionId ? ` (transaction ${e.transactionId})` : '';
        return { content: [{ type: 'text', text: `memory_write failed${suffix}: ${e.message}` }], isError: true };
      }
    },
  );
}

module.exports = { register };
