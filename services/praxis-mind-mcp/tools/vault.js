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
const { writeVaultFile } = require('../lib/vault-write');

// Kept in sync with the ownership matrix in server/lib/vault-write.js
// (P1-17 §3). vault-write.js refuses these again at write time; this list is
// the early, readable rejection so the agent gets a reason, not a stack.
const WATCHER_ONLY = new Set(['MEMORY.md', 'AGENTS.md', 'SKILLS.md', 'LINKS.md', 'shared-mind-context.md', 'STATE.md']);
const ROBERT_ONLY = new Set(['SOUL.md', 'USER.md', 'CONTEXT.md']);
const STATIC_ROOT = new Set(['CLAUDE.md', 'README.md']);
const RIPGREP_MISSING_MESSAGE = 'ripgrep not installed: vault_search grep mode requires the `rg` binary. Install ripgrep and ensure `rg` is on PATH.';
let ripgrepValidated = false;
// Grep mode returns every match, a page at a time. This is a page size, not a
// cap: a page that leaves matches out says how many remain (matches and
// files) and gives the offset of the next page, so every match is reachable.
// 200 is the number the old silent cut used; callers can pass page_size.
const GREP_PAGE_SIZE = 200;
// vault_list does not descend into these. The result names them, so a reader
// never mistakes an excluded tree for an empty one.
const LIST_SKIP_DIRS = ['.git', '.obsidian', '_archive', 'node_modules'];
const LIST_EXCLUSION_NOTE = 'Not listed: .git/, .obsidian/ and node_modules/ (tooling), _archive/ (preserved, read-only; vault_read still opens a known _archive path), ._* AppleDouble files, and symbolic links (not followed, so the walk stays inside the vault; any found are named in skipped_links).';
const SEARCH_NOTE = 'Mixed-provenance result set: vault_read a specific path for its own trust tier.';

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
            // P1-17: authored-mode write through the fleet helper — atomic
            // temp+rename under the `authored` (or `skills`) lock, and a hard
            // refusal if the target carries the watcher's GENERATED header.
            // The supersession stamps run inside the same lock (re-entrant),
            // so a replacement and the retirement of what it replaces are one
            // critical section, exactly as the transaction envelope promises.
            writeVaultFile(abs, finalContent, { mode, vault: VAULT, by: `mcp:${ctx.caller.identity}` });
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
    'List files in the vault matching an optional glob pattern. Returns paths + sizes + mtimes for every matching file at any depth, plus a note naming the trees the walk does not enter (.git, .obsidian, node_modules, _archive, ._* files, symbolic links). USE THIS before vault_read if you need to find files. Glob examples: "**/*.md", "projects/*", "skills/maintenance/*".',
    { glob: z.string().optional().describe('Optional glob pattern relative to vault root. Default: every file in the vault, at any depth.') },
    async ({ glob: pattern }) => {
      const auth = checkPrivilege(ctx.caller, 'vault.read');
      if (auth) return auth;
      try {
        // Simple walker (no glob lib to keep deps light). It walks the whole
        // tree: the vault itself is the boundary. Dirent.isDirectory() is
        // false for a symbolic link, so links are never followed and the walk
        // cannot cycle; links are reported instead of silently dropped.
        const results = [];
        const skippedLinks = [];
        const skip = new Set(LIST_SKIP_DIRS);
        function walk(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('._')) continue;
            if (skip.has(entry.name)) continue;
            const abs = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
              skippedLinks.push(path.relative(VAULT, abs));
            } else if (entry.isDirectory()) {
              walk(abs);
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
        skippedLinks.sort();
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_list', success: true });
        const listing = {
          count: results.length,
          not_listed: LIST_EXCLUSION_NOTE,
          ...(skippedLinks.length ? { skipped_links: skippedLinks } : {}),
          files: results,
        };
        return { content: [{ type: 'text', text: JSON.stringify(listing, null, 2) }] };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_list', success: false, error: e.message });
        return { content: [{ type: 'text', text: `Error listing vault: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'vault_search',
    'Search the shared-mind vault with ranked hybrid retrieval: BM25 keyword + embedding vector + reciprocal-rank fusion, boosted by the LINKS.md backlink graph (GBrain pattern, served by the Cortex vault index). Hybrid returns the top k ranked chunks, each chunk whole. Best for concept/topic queries ("how do we recover stale tasks"). Set mode:"grep" for exact substring/regex matching via ripgrep (identifiers, exact strings): grep returns every match, paged; a page that leaves matches out says how many remain and the offset of the next page. Hybrid falls back to grep automatically when Cortex is unreachable.',
    {
      query: z.string().describe('Natural-language query (hybrid mode) or substring/regex (grep mode).'),
      k: z.number().int().min(1).max(25).default(8).describe('Hybrid mode: how many ranked chunks to return (the Cortex endpoint accepts 1 to 25). Each chunk comes back whole.'),
      mode: z.enum(['hybrid', 'grep']).default('hybrid').describe('hybrid = ranked retrieval; grep = exact ripgrep match.'),
      offset: z.number().int().min(0).default(0).describe('Grep mode (and the grep fallback): index of the first match to return, from a previous page\'s next_offset. Matches are sorted by path, then line.'),
      page_size: z.number().int().min(1).default(GREP_PAGE_SIZE).describe(`Grep mode: matches per page (default ${GREP_PAGE_SIZE}). Not a cap: every match is reachable by paging, and each page reports what remains.`),
    },
    async ({ query, k = 8, mode = 'hybrid', offset = 0, page_size: pageSize = GREP_PAGE_SIZE }) => {
      const auth = checkPrivilege(ctx.caller, 'vault.read');
      if (auth) return auth;
      let grepNote = '';
      let degradedReason = null;
      if (mode !== 'grep') {
        try {
          const res = await cortexVaultSearch({ query, k });
          ledger.record({ caller: ctx.caller.identity, tool: 'vault_search', success: true });
          // Result sets mix files of differing provenance, so the block floors
          // to advisory. Read a specific path with vault_read for its own tier.
          return {
            structuredContent: {
              mode: res.mode || 'hybrid',
              status: res.status || (res.degraded_reason ? 'degraded' : 'ok'),
              degraded_reason: res.degraded_reason || null,
              source_generated_at: res.source_generated_at || res.generated || null,
              fallback_notice: res.fallback_notice || null,
              results: res.results || [],
              source: res,
            },
            content: [{
              type: 'text',
              text: formatRetrieved(
                { origin: 'vault:search', tier: 'external', note: SEARCH_NOTE },
                formatHybridResults(res, k),
              ),
            }],
          };
        } catch (e) {
          degradedReason = [401, 403].includes(e.status) ? 'authentication_failed' : 'backend_unavailable';
          // Do not echo upstream response bodies: they may contain credentials.
          const reason = degradedReason === 'authentication_failed' ? `authentication failed (HTTP ${e.status})` : 'backend unavailable';
          grepNote = `[Cortex vault index ${reason}: fell back to grep scan]\n`;
        }
      }
      try {
        const matches = grepVault(query);
        const { page, info } = pageGrepMatches(matches, offset, pageSize);
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_search', success: true });
        return {
          structuredContent: {
            mode: 'grep',
            status: degradedReason ? 'degraded' : 'ok',
            degraded_reason: degradedReason,
            source_generated_at: null,
            fallback_notice: grepNote.trim() || null,
            results: page.map((m) => m.line),
            page: info,
          },
          content: [{
            type: 'text',
            text: formatRetrieved(
              { origin: 'vault:search', tier: 'external', note: SEARCH_NOTE },
              grepNote + formatGrepPage(page, info),
            ),
          }],
        };
      } catch (e) {
        ledger.record({ caller: ctx.caller.identity, tool: 'vault_search', success: false, error: e.message });
        return {
          structuredContent: {
            mode: 'grep', status: 'error',
            degraded_reason: degradedReason || 'grep_failed',
            source_generated_at: null,
            fallback_notice: grepNote.trim() || null,
            results: [],
          },
          content: [{ type: 'text', text: `${grepNote}Error searching vault: ${e.message}` }],
          isError: true,
        };
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

  let result = runRipgrep(query, false);
  if (!result.error && result.status === 2) result = runRipgrep(query, true);
  // Only 0 (matches) and 1 (no matches) are valid, including after the literal
  // retry. Never include stderr/spawn errors: they may echo sensitive queries.
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error('ripgrep scan failed');
  }
  return parseRipgrepOutput(result.stdout);
}

function ensureRipgrepAvailable() {
  if (ripgrepValidated) return;
  const result = spawnSync('rg', ['--version'], { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(RIPGREP_MISSING_MESSAGE);
    throw new Error('ripgrep availability check failed');
  }
  if (result.status !== 0) {
    throw new Error('ripgrep availability check failed');
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
      // A NUL after the path, so a path containing ':' still parses, and the
      // file count on a page is exact.
      '--null',
      // Stable order (path, then line) so an offset names the same match on
      // the next call. No --max-count: every matching line is returned.
      '--sort',
      'path',
      '--glob',
      '*.md',
      '--glob',
      '!_archive/**',
      '--glob',
      '!node_modules/**',
      '--color',
      'never',
      ...(fixedStrings ? ['--fixed-strings'] : []),
      '--',
      query,
      '.',
    ],
    {
      cwd: VAULT,
      encoding: 'utf8',
      // Every match comes back (the tool pages them), so the output is bounded
      // by the vault itself, not by a number here. A fixed buffer would turn a
      // broad query into a failed scan (a 1 MiB buffer did, at about 4,000
      // matching lines).
      maxBuffer: Infinity,
    },
  );
}

/** Parse `rg --null` output into whole match lines with their file. */
function parseRipgrepOutput(stdout) {
  return (stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((raw) => {
      const nul = raw.indexOf('\0');
      let file;
      let rest;
      if (nul >= 0) {
        file = raw.slice(0, nul);
        rest = raw.slice(nul + 1);
      } else {
        // Output without --null (older callers, test doubles): path:line:text.
        const m = /^(.*?):(\d+):/.exec(raw);
        file = m ? m[1] : raw;
        rest = m ? raw.slice(m[1].length + 1) : '';
      }
      file = file.replace(/^\.\//, '');
      return { file, line: `${file}:${rest}`.trim() };
    });
}

/**
 * One page of grep matches plus an honest account of the rest: totals,
 * what remains after this page (matches and files) and the next offset.
 */
function pageGrepMatches(matches, offset, pageSize) {
  const start = Math.max(0, offset || 0);
  const size = Math.max(1, pageSize || GREP_PAGE_SIZE);
  const page = matches.slice(start, start + size);
  const rest = matches.slice(start + page.length);
  const remainingMatches = rest.length;
  return {
    page,
    info: {
      offset: start,
      page_size: size,
      returned: page.length,
      total_matches: matches.length,
      total_files: new Set(matches.map((m) => m.file)).size,
      remaining_matches: remainingMatches,
      remaining_files: new Set(rest.map((m) => m.file)).size,
      next_offset: remainingMatches ? start + page.length : null,
    },
  };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 'es'}`;
}

function files(n) {
  return `${n} file${n === 1 ? '' : 's'}`;
}

function formatGrepPage(page, info) {
  if (info.total_matches === 0) return 'No matches.';
  if (page.length === 0) {
    return `No matches at offset ${info.offset}: this search has ${plural(info.total_matches, 'match')} in ${files(info.total_files)} (offsets 0 to ${info.total_matches - 1}).`;
  }
  const header = `Grep matches ${info.offset + 1} to ${info.offset + page.length} of ${info.total_matches} (${files(info.total_files)}), sorted by path and line.`;
  const lines = [header];
  if (info.offset > 0) lines.push(`${plural(info.offset, 'match')} ${info.offset === 1 ? 'comes' : 'come'} before this page (offset 0 starts the list).`);
  lines.push('', ...page.map((m) => m.line));
  if (info.remaining_matches) {
    lines.push('', `[${plural(info.remaining_matches, 'match')} more in ${files(info.remaining_files)} not shown on this page: call vault_search again with mode "grep", the same query and offset ${info.next_offset}.]`);
  } else {
    lines.push('', '[End of matches: nothing left out.]');
  }
  return lines.join('\n');
}

/**
 * Render /api/vault/search results for agents: every chunk whole. The
 * request asks Cortex for `include_content`; a gateway that predates it
 * returns only a discovery snippet, and the snippet then says so.
 */
function formatHybridResults(res, k) {
  const results = res.results || [];
  const lines = [
    `Vault hybrid search, mode: ${res.mode}${res.generated ? `, index generated ${res.generated}` : ''}`,
  ];
  if (results.length) {
    const n = results.length;
    const chunks = `${n} ranked chunk${n === 1 ? '' : 's'}`;
    lines.push(n >= k
      ? `The top ${chunks} (k=${k}), each whole. Lower-ranked chunks are not listed: raise k (up to 25) or use mode "grep" for every exact match. A chunk is one section of its file; vault_read the path for the whole file.`
      : `${chunks} (the index returned ${n} for k=${k}), each whole. A chunk is one section of its file; vault_read the path for the whole file.`);
  }
  results.forEach((r, i) => {
    const loc = r.heading && r.heading !== r.title ? `${r.path} › ${r.heading}` : r.path;
    const backlinks = r.backlinks ? `, ${r.backlinks} backlinks` : '';
    lines.push('', `${i + 1}. ${loc}  (score ${r.score}${backlinks})`);
    lines.push(chunkText(r));
  });
  if (results.length === 0) lines.push('', 'No results.');
  return lines.join('\n');
}

/**
 * The whole text of one Cortex vault chunk. Cortex's `text` is a discovery
 * snippet and `content` the whole chunk (sent when the request carries
 * include_content). Without `content`, a cut snippet announces itself.
 */
function chunkText(r) {
  if (typeof r.content === 'string') return r.content;
  const text = r.text || '';
  if (r.text_truncated) {
    const of = Number.isFinite(r.content_chars) ? ` of ${r.content_chars}` : '';
    return `${text}\n[Snippet only: the first ${text.length}${of} characters of this chunk; this Cortex gateway did not return the whole chunk. vault_read ${r.path} for the full text.]`;
  }
  return text;
}

module.exports = { register, formatHybridResults, chunkText, GREP_PAGE_SIZE };
