/**
 * vault.* tools — filesystem operations against the shared-mind vault root
 * (config.VAULT, resolved by server/lib/vault-paths.js).
 * All paths are jailed to the vault root; traversal blocked.
 * Path-based authority enforcement on writes per design Δ4.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { z } = require('zod');
const { VAULT } = require('../lib/config');
const { cortexVaultSearch } = require('../lib/backends');
const { checkPrivilege } = require('../lib/auth');
const { checkAndIncrement } = require('../lib/ratelimit');
const ledger = require('../lib/ledger');
const { executeTransaction, compareFields } = require('../lib/transactions');
const { classifyVaultPath, formatRetrieved } = require('../lib/provenance');
const { planSupersession, applySupersession } = require('../lib/supersession');

const WATCHER_ONLY = new Set(['MEMORY.md', 'AGENTS.md', 'shared-mind-context.md']);
const ROBERT_ONLY = new Set(['SOUL.md', 'USER.md', 'CONTEXT.md']);
const STATIC_ROOT = new Set(['CLAUDE.md', 'README.md']);
const RIPGREP_MISSING_MESSAGE = 'ripgrep not installed: vault_search grep mode requires the `rg` binary. Install ripgrep and ensure `rg` is on PATH.';
let ripgrepValidated = false;

function resolveVaultPath(rel) {
  // Reject absolute paths and parent traversal.
  if (path.isAbsolute(rel)) throw new Error(`Path must be relative to vault root: ${rel}`);
  const resolved = path.resolve(VAULT, rel);
  if (!resolved.startsWith(VAULT + path.sep) && resolved !== VAULT) {
    throw new Error(`Path escapes vault: ${rel}`);
  }
  return resolved;
}

function isWriteAllowed(rel) {
  // Normalize
  rel = rel.replace(/^\/+/, '');
  const top = rel.split('/')[0];
  const base = path.basename(rel);
  // Root-level identity files — Robert only.
  if (rel === base && ROBERT_ONLY.has(base)) return { allowed: false, reason: 'identity file — Robert-only' };
  // Generated projections — watcher only.
  if (rel === base && WATCHER_ONLY.has(base)) return { allowed: false, reason: 'watcher-generated — do not edit (your edits would be overwritten anyway)' };
  // Static root docs — read-only via this tool.
  if (rel === base && STATIC_ROOT.has(base)) return { allowed: false, reason: 'root static doc — edit via the file system, not via vault_write' };
  // Archive — read only.
  if (top === '_archive') return { allowed: false, reason: '_archive is preservation; writes rejected' };
  // Allowed top-level dirs
  if (['memories', 'projects', 'workflows', 'incidents', 'skills', 'personas'].includes(top)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `unrecognized vault path "${rel}"; allowed top-level dirs: memories/, projects/, workflows/, incidents/, skills/, personas/` };
}

function register(server, ctx) {
  server.tool(
    'vault_read',
    'Read a markdown file from the shared-mind vault. Pass a path relative to the vault root, e.g. "SOUL.md" or "projects/YouTube Channel.md". Returns the raw file contents.',
    { path: z.string().describe('Relative path inside the vault, e.g. "memories/feedback_pragmatic_commits.md"') },
    async ({ path: rel }) => {
      const auth = checkPrivilege(ctx.caller, 'vault.read');
      if (auth) return auth;
      try {
        const abs = resolveVaultPath(rel);
        const content = fs.readFileSync(abs, 'utf8');
        // Provenance boundary: vault files range from Robert-authored identity
        // docs to skills synthesised from external articles. Label the tier and
        // quote untrusted bodies so retrieved text cannot read as a directive.
        const { tier, sourceUrl } = classifyVaultPath(rel, content);
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_read', success: true });
        return {
          content: [{
            type: 'text',
            text: formatRetrieved({ origin: `vault:${rel}`, tier, sourceUrl }, content),
          }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_read', success: false, error: e.message });
        return { content: [{ type: 'text', text: `Error reading ${rel}: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'vault_write',
    'Write a markdown file into the shared-mind vault. USE FOR: durable, reusable content — skills (skills/), identity facts (memories/), project state (projects/), workflows (workflows/), incidents (incidents/). DO NOT USE for ephemeral observations — those go to memory_write. Vault writes are committed to git and visible to all four agents. SOUL.md / USER.md / CONTEXT.md / MEMORY.md / AGENTS.md are forbidden — they are Robert-authored or auto-generated.',
    {
      path: z.string().describe('Relative path inside the vault. Must live under memories/, projects/, workflows/, incidents/, skills/, or personas/.'),
      content: z.string().describe('Full file content (markdown).'),
      mode: z.enum(['replace', 'append']).default('replace').describe('replace overwrites; append concatenates.'),
      expected_exists: z.boolean().optional()
        .describe('Optimistic concurrency guard: reject unless file existence matches.'),
      expected_content: z.string().optional()
        .describe('Optimistic concurrency guard: reject unless the current full file content exactly matches.'),
      supersedes: z.array(z.string()).optional()
        .describe('Memory names (file stems, no .md) in the SAME directory that this file REPLACES. Each is stamped `status: superseded` + `superseded_by: <this file>` and this file gains `supersedes: [...]`, so MEMORY.md, hybrid search and chat recall drop the retired facts. Use this instead of overwriting a reference_*/feedback_* memory with contradicting content — the vault retires facts, it does not argue with itself.'),
    },
    async ({ path: rel, content, mode, expected_exists, expected_content, supersedes }) => {
      const auth = checkPrivilege(ctx.caller, 'vault.write');
      if (auth) return auth;
      const rl = checkAndIncrement(ctx.caller.identity, 'vault_write', ctx.caller.rate_limits_per_hour?.['vault.write']);
      if (!rl.allowed) {
        return { content: [{ type: 'text', text: `Rate limit exceeded for vault_write: ${rl.count}/${rl.limit} this hour.` }], isError: true };
      }
      const allow = isWriteAllowed(rel);
      if (!allow.allowed) {
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_write', success: false, error: allow.reason });
        return { content: [{ type: 'text', text: `vault_write rejected: ${allow.reason}` }], isError: true };
      }
      if (supersedes && supersedes.length && mode === 'append') {
        const reason = 'supersedes requires mode "replace" — a replacement is a whole file, not an appended paragraph';
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_write', success: false, error: reason });
        return { content: [{ type: 'text', text: `vault_write rejected: ${reason}` }], isError: true };
      }
      try {
        const abs = resolveVaultPath(rel);
        // Supersession (Praxis task e524649b, PART 3): the replacement carries
        // `supersedes:` and every named old file is retired in the SAME apply,
        // so the vault never holds a retired fact with no successor. The plan
        // is built before the transaction so a bad name fails before any write.
        const plan = planSupersession(VAULT, rel, content, supersedes || []);
        const finalContent = plan.content;
        const expected = {};
        if (expected_exists !== undefined) expected.exists = expected_exists;
        if (expected_content !== undefined) expected.content = expected_content;
        let stamped = [];
        const tx = await executeTransaction({
          tool: 'vault_write',
          caller: ctx.caller,
          target: { path: rel },
          intent: { mode, content: finalContent, expected, supersedes: plan.targets.map((t) => t.name) },
          captureBefore: async () => {
            const exists = fs.existsSync(abs);
            return { exists, content: exists ? fs.readFileSync(abs, 'utf8') : null };
          },
          validatePreconditions: ({ before }) => compareFields(before, expected),
          apply: async () => {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            if (mode === 'append') fs.appendFileSync(abs, finalContent);
            else fs.writeFileSync(abs, finalContent);
            stamped = applySupersession(plan);
            return { bytes_written: Buffer.byteLength(finalContent), path: rel, mode, superseded: stamped };
          },
          readAfter: async () => {
            const exists = fs.existsSync(abs);
            return { exists, content: exists ? fs.readFileSync(abs, 'utf8') : null };
          },
          verify: ({ before, after }) => {
            const expectedAfter = mode === 'append' ? `${before.content || ''}${finalContent}` : finalContent;
            const mismatches = compareFields(after, { exists: true, content: expectedAfter });
            return { ok: mismatches.length === 0, mismatches };
          },
        });
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_write', success: true });
        const supersededNote = stamped.length ? `; superseded ${stamped.join(', ')}` : '';
        return { content: [{ type: 'text', text: `Wrote ${Buffer.byteLength(finalContent)} bytes to ${rel} (transaction ${tx.transactionId})${supersededNote}` }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_write', success: false, error: e.message });
        const suffix = e.transactionId ? ` (transaction ${e.transactionId})` : '';
        return { content: [{ type: 'text', text: `Error writing ${rel}${suffix}: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'vault_list',
    'List files in the vault matching an optional glob pattern. Returns paths + sizes + mtimes. USE THIS before vault_read if you need to find files. Glob examples: "**/*.md", "projects/*", "skills/maintenance/*".',
    { glob: z.string().optional().describe('Optional glob pattern relative to vault root. Default: top-level + one level deep.') },
    async ({ glob: pattern }) => {
      const auth = checkPrivilege(ctx.caller, 'vault.read');
      if (auth) return auth;
      try {
        // Simple walker (no glob lib to keep deps light)
        const results = [];
        const skip = new Set(['.git', '.obsidian', '_archive', 'node_modules']);
        function walk(dir, depth = 0) {
          if (depth > 4) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('._')) continue;
            if (skip.has(entry.name)) continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(abs, depth + 1);
            } else if (entry.isFile()) {
              const rel = path.relative(VAULT, abs);
              const st = fs.statSync(abs);
              if (!pattern || rel.includes(pattern.replace(/\*\*\/?/g, '').replace(/\*/g, ''))) {
                results.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
              }
            }
          }
        }
        walk(VAULT);
        results.sort((a, b) => a.path.localeCompare(b.path));
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_list', success: true });
        return { content: [{ type: 'text', text: JSON.stringify({ count: results.length, files: results }, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_list', success: false, error: e.message });
        return { content: [{ type: 'text', text: `Error listing vault: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'vault_search',
    'Search the shared-mind vault with ranked hybrid retrieval — BM25 keyword + embedding vector + reciprocal-rank fusion, boosted by the LINKS.md backlink graph (GBrain pattern, served by the Cortex vault index). Best for concept/topic queries ("how do we recover stale tasks"). Set mode:"grep" for exact substring/regex matching via ripgrep (identifiers, exact strings). Hybrid falls back to grep automatically when Cortex is unreachable.',
    {
      query: z.string().describe('Natural-language query (hybrid mode) or substring/regex (grep mode).'),
      k: z.number().int().min(1).max(25).default(8).describe('Max results in hybrid mode.'),
      mode: z.enum(['hybrid', 'grep']).default('hybrid').describe('hybrid = ranked retrieval; grep = exact ripgrep match.'),
    },
    async ({ query, k = 8, mode = 'hybrid' }) => {
      const auth = checkPrivilege(ctx.caller, 'vault.read');
      if (auth) return auth;
      let grepNote = '';
      if (mode !== 'grep') {
        try {
          const res = await cortexVaultSearch({ query, k });
          ledger.record({ caller: ctx.caller.identity, tool: 'vault_search', success: true });
          // Result sets mix files of differing provenance, so the block floors
          // to advisory. Read a specific path with vault_read for its own tier.
          return {
            content: [{
              type: 'text',
              text: formatRetrieved(
                { origin: 'vault:search', tier: 'external', note: 'Mixed-provenance result set — vault_read a specific path for its own trust tier.' },
                formatHybridResults(res),
              ),
            }],
          };
        } catch (e) {
          grepNote = `[Cortex vault index unavailable (${e.message}) — fell back to grep scan]\n`;
        }
      }
      try {
        const lines = grepVault(query);
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_search', success: true });
        return {
          content: [{
            type: 'text',
            text: formatRetrieved(
              { origin: 'vault:search', tier: 'external', note: 'Mixed-provenance result set — vault_read a specific path for its own trust tier.' },
              grepNote + (lines.length === 0 ? 'No matches.' : lines.join('\n')),
            ),
          }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_search', success: false, error: e.message });
        return { content: [{ type: 'text', text: `Error searching vault: ${e.message}` }], isError: true };
      }
    },
  );
}

/**
 * Case-insensitive regex scan over vault markdown via ripgrep. Validate the
 * dependency before the search so missing runtimes get a readable tool error
 * instead of leaking spawnSync ENOENT.
 */
function grepVault(query) {
  ensureRipgrepAvailable();

  const result = runRipgrep(query, false);
  if (result.error) throw result.error;
  if (result.status === 2) {
    const literalResult = runRipgrep(query, true);
    if (literalResult.error) throw literalResult.error;
    return parseRipgrepOutput(literalResult.stdout);
  }
  if (result.status && result.status !== 1) {
    throw new Error((result.stderr || `ripgrep exited with status ${result.status}`).trim());
  }
  return parseRipgrepOutput(result.stdout);
}

function ensureRipgrepAvailable() {
  if (ripgrepValidated) return;
  const result = spawnSync('rg', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(RIPGREP_MISSING_MESSAGE);
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || 'ripgrep availability check failed').trim());
  }
  ripgrepValidated = true;
}

function runRipgrep(query, fixedStrings) {
  return spawnSync(
    'rg',
    [
      '--ignore-case',
      '--line-number',
      '--with-filename',
      '--no-heading',
      '--max-count',
      '5',
      '--glob',
      '*.md',
      '--glob',
      '!_archive/**',
      '--glob',
      '!node_modules/**',
      '--color',
      'never',
      ...(fixedStrings ? ['--fixed-strings'] : []),
      query,
      '.',
    ],
    {
      cwd: VAULT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
}

function parseRipgrepOutput(stdout) {
  return (stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => line.replace(/^\.\//, '').trim());
}

/** Render /api/vault/search results as compact ranked text for agents. */
function formatHybridResults(res) {
  const results = res.results || [];
  const lines = [
    `Vault hybrid search — mode: ${res.mode}${res.generated ? `, index generated ${res.generated}` : ''}`,
  ];
  results.forEach((r, i) => {
    const loc = r.heading && r.heading !== r.title ? `${r.path} › ${r.heading}` : r.path;
    const backlinks = r.backlinks ? `, ${r.backlinks} backlinks` : '';
    lines.push('', `${i + 1}. ${loc}  (score ${r.score}${backlinks})`);
    lines.push(`   ${(r.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  });
  if (results.length === 0) lines.push('', 'No results.');
  return lines.join('\n');
}

module.exports = { register };
