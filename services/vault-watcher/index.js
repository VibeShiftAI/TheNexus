/**
 * Vault watcher — regenerates MEMORY.md, AGENTS.md, SKILLS.md,
 * shared-mind-context.md on every change to /Volumes/Projects/shared-mind/.
 * Long-lived daemon under launchd (com.thenexus.vault-watcher). Uses
 * Nexus's chokidar. Run with --once to regenerate and exit (no watch).
 *
 * v1 of the regeneration logic — pure concatenation of identity files
 * + filesystem-walk for the index, plus the skill bus:
 *   - SKILLS.md: per-skill one-line summaries + trigger tags so agents
 *     know *when* to reach for a skill, not just that it exists.
 *   - ~/.claude/skills mirror: active vault skills installed as invocable
 *     Claude Code skills (SKILL.md format). One-way vault → home; a
 *     manifest guards against ever deleting user-authored skills.
 *   - AGENTS.md now inlines SKILLS.md so Codex sees summaries too.
 *   - .index/vault-search.json: heading-aware chunk index + per-doc
 *     backlink counts (from the LINKS.md graph pass) consumed by the
 *     Cortex gateway's hybrid vault search (BM25 + vector + RRF —
 *     GBrain pattern). Zero LLM calls here; embeddings are Cortex's job.
 * Frontmatter auto-fill + Cortex mirror come in later waves.
 */

const chokidar = require('chokidar');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT = '/Volumes/Projects/shared-mind';
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const SYNC_MANIFEST = path.join(CLAUDE_SKILLS_DIR, '.vault-sync-manifest.json');
const GENERATED_BASENAMES = new Set([
  'MEMORY.md',
  'AGENTS.md',
  'SKILLS.md',
  'LINKS.md',
  'shared-mind-context.md',
]);

const DEBOUNCE_MS = 500;
let debounceTimer = null;

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return '';
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function encodeFilename(name) {
  // Encode spaces and other URI-unsafe chars for markdown links, but
  // leave path separators as plain slashes.
  return encodeURIComponent(name).replace(/%2F/g, '/');
}

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

// ── Skill collection ────────────────────────────────────────────────────

/**
 * Minimal frontmatter parse for skill files not present in _index.json
 * (e.g. hand-authored skills the SkillsManager hasn't indexed yet).
 * Extracts name/category/tags plus the first paragraph under ## Summary.
 */
function parseSkillFrontmatter(raw) {
  const out = { name: '', category: '', tags: [], summary: '', state: '' };
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!m) continue;
      const [, key, value] = m;
      if (key === 'name') out.name = value.trim();
      else if (key === 'category') out.category = value.trim();
      else if (key === 'state') out.state = value.trim();
      else if (key === 'tags') {
        out.tags = value
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
  }
  const summary = raw.match(/## Summary\s*\n+([^\n#]+)/);
  if (summary) out.summary = summary[1].trim();
  return out;
}

/**
 * Walk the vault skills tree and merge filesystem state with _index.json
 * metadata (summary, state, tags). Returns { active, candidates } where
 * each entry is { id, relPath, category, summary, tags, state }.
 * Directories starting with "_" (e.g. _candidates staging from the
 * nightly skill harvest) are collected separately and never installed.
 */
function collectSkills() {
  const skillsRoot = path.join(VAULT, 'skills');
  const index = readJsonSafe(path.join(skillsRoot, '_index.json'));
  const byId = new Map();
  if (index && Array.isArray(index.skills)) {
    for (const s of index.skills) byId.set(s.id, s);
  }

  const active = [];
  const candidates = [];
  if (!fs.existsSync(skillsRoot)) return { active, candidates };

  const subdirs = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const locations = [{ sub: '', dir: skillsRoot }].concat(
    subdirs.map((sub) => ({ sub, dir: path.join(skillsRoot, sub) })),
  );

  for (const { sub, dir } of locations) {
    for (const f of listMarkdown(dir)) {
      const id = f.replace(/\.md$/, '');
      const relPath = sub ? `skills/${sub}/${f}` : `skills/${f}`;
      const indexed = byId.get(id);
      let entry;
      if (indexed) {
        entry = {
          id,
          relPath,
          category: indexed.category || sub || 'general',
          summary: indexed.summary || '',
          tags: indexed.tags || [],
          state: indexed.state || 'active',
        };
      } else {
        const parsed = parseSkillFrontmatter(readFileSafe(path.join(dir, f)));
        entry = {
          id,
          relPath,
          category: parsed.category || sub || 'general',
          summary: parsed.summary,
          tags: parsed.tags,
          // Unindexed files can still carry frontmatter state (stamped by
          // the SkillsManager on archive) — respect it so an archived skill
          // whose index row was lost never re-enters the active bus.
          state: parsed.state === 'archived' ? 'archived' : 'active',
        };
      }
      if (sub.startsWith('_')) candidates.push(entry);
      else if (entry.state !== 'archived') active.push(entry);
    }
  }
  return { active, candidates };
}

// ── Projections ─────────────────────────────────────────────────────────

function regenerateMemoryIndex() {
  const lines = [
    '# MEMORY — shared-mind vault index',
    '',
    '> Auto-generated by the vault watcher. **Do not edit by hand** — your changes will be overwritten on the next file change in the vault.',
    '>',
    `> Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const section of ['memories', 'projects', 'workflows', 'incidents']) {
    const dir = path.join(VAULT, section);
    const files = listMarkdown(dir);
    if (files.length === 0) continue;
    lines.push(`## ${section}/`, '');
    for (const f of files) {
      const name = f.replace(/\.md$/, '');
      lines.push(`- [\`${name}\`](${section}/${encodeFilename(f)})`);
    }
    lines.push('');
  }

  // Skills (root + nested subdirs) — names only; summaries + trigger
  // hints live in SKILLS.md to keep this session-loaded index lean.
  // Archived skills are omitted so sessions only see the live library
  // (they remain on disk + in skills/_index.json for history).
  lines.push('## skills/', '');
  lines.push('> One-line summaries and trigger hints for every skill: [SKILLS.md](SKILLS.md)', '');
  lines.push('> Archived skills are omitted; full inventory lives in skills/_index.json.', '');
  const skillsRoot = path.join(VAULT, 'skills');
  if (fs.existsSync(skillsRoot)) {
    const skillsIndex = readJsonSafe(path.join(skillsRoot, '_index.json'));
    const archivedIds = new Set();
    if (skillsIndex && Array.isArray(skillsIndex.skills)) {
      for (const s of skillsIndex.skills) {
        if (s.state === 'archived') archivedIds.add(s.id);
      }
    }
    const isArchived = (dir, f) => {
      const id = f.replace(/\.md$/, '');
      if (archivedIds.has(id)) return true;
      return parseSkillFrontmatter(readFileSafe(path.join(dir, f))).state === 'archived';
    };
    // Root-level files (e.g. lars-protocol.md)
    const rootFiles = listMarkdown(skillsRoot).filter((f) => !isArchived(skillsRoot, f));
    for (const f of rootFiles) {
      const name = f.replace(/\.md$/, '');
      lines.push(`- [\`${name}\`](skills/${encodeFilename(f)})`);
    }
    // Subdirs
    const subdirs = fs
      .readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const sub of subdirs) {
      const subDir = path.join(skillsRoot, sub);
      const files = listMarkdown(subDir).filter((f) => !isArchived(subDir, f));
      if (files.length === 0) continue;
      lines.push('', `### skills/${sub}/`, '');
      for (const f of files) {
        const name = f.replace(/\.md$/, '');
        lines.push(`- [\`${name}\`](skills/${sub}/${encodeFilename(f)})`);
      }
    }
  }

  const out = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(VAULT, 'MEMORY.md'), out);
}

function regenerateSkillsIndexFile() {
  const { active, candidates } = collectSkills();
  const lines = [
    '# SKILLS — shared-mind skill bus',
    '',
    '> Auto-generated by the vault watcher. **Do not edit by hand.**',
    '> Canonical skill library for all agents (Praxis, Claude Code, Codex, Antigravity).',
    '> Check here before nontrivial or repeated-shape work; follow the linked manifest.',
    '>',
    `> Generated: ${new Date().toISOString()}`,
    '',
  ];

  const byCategory = new Map();
  for (const s of active) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(s);
  }
  for (const category of [...byCategory.keys()].sort()) {
    lines.push(`## ${category}`, '');
    for (const s of byCategory.get(category)) {
      const tags = s.tags.length ? ` _[${s.tags.join(', ')}]_` : '';
      const summary = s.summary ? ` — ${s.summary}` : '';
      lines.push(`- [\`${s.id}\`](${encodeFilename(s.relPath)})${summary}${tags}`);
    }
    lines.push('');
  }

  if (candidates.length > 0) {
    lines.push('## candidates (pending approval — not installed)', '');
    for (const s of candidates) {
      const summary = s.summary ? ` — ${s.summary}` : '';
      lines.push(`- [\`${s.id}\`](${encodeFilename(s.relPath)})${summary}`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(VAULT, 'SKILLS.md'), lines.join('\n') + '\n');
  return { active, candidates };
}

function regenerateAgentsProjection() {
  // MEMORY.md is no longer inlined (token economy): agents retrieve vault
  // content via ranked hybrid search or read the index on demand. SKILLS.md
  // stays inline — trigger hints must be visible without a lookup (WS5).
  const retrievalNote = [
    '## Finding vault content (retrieval protocol)',
    '',
    'The per-file memory index is NOT inlined here. To find vault content:',
    '- **Ranked hybrid search** (BM25 + embeddings + reciprocal-rank fusion, backlink-boosted): `POST http://localhost:8100/api/vault/search` with `{"query": "...", "k": 5}` and header `X-Gateway-Key` (key: `CORTEX_GATEWAY_KEY` in `/Volumes/Projects/TheCortex/TheCortex/.env`). Via MCP: the praxis-mind `vault_search` tool.',
    '- **Browse on demand**: read `MEMORY.md` (full per-file index) or `LINKS.md` (backlink graph) in the vault root.',
    '- Details: `memories/reference_vault_hybrid_search.md`.',
  ].join('\n');
  const parts = [
    '<!-- AUTO-GENERATED by the vault watcher. Do not edit. SOUL + USER + CONTEXT + retrieval protocol + SKILLS for Codex consumption. -->',
    '',
    readFileSafe(path.join(VAULT, 'SOUL.md')),
    '',
    '---',
    '',
    readFileSafe(path.join(VAULT, 'USER.md')),
    '',
    '---',
    '',
    readFileSafe(path.join(VAULT, 'CONTEXT.md')),
    '',
    '---',
    '',
    retrievalNote,
    '',
    '---',
    '',
    readFileSafe(path.join(VAULT, 'SKILLS.md')),
  ];
  fs.writeFileSync(path.join(VAULT, 'AGENTS.md'), parts.join('\n'));
}

function regenerateAntigravityContext() {
  const parts = [
    '<!-- AUTO-GENERATED by the vault watcher. Symlinked into ~/.gemini/antigravity/prompting/. Compact SOUL+USER for context injection. -->',
    '',
    readFileSafe(path.join(VAULT, 'SOUL.md')),
    '',
    '---',
    '',
    readFileSafe(path.join(VAULT, 'USER.md')),
  ];
  fs.writeFileSync(path.join(VAULT, 'shared-mind-context.md'), parts.join('\n'));
}

// ── Claude Code skill installation ──────────────────────────────────────

const SYNC_MARKER = '<!-- synced-from-shared-mind-vault -->';

/**
 * Compose a Claude Code SKILL.md from a vault skill. The description
 * frontmatter is the trigger surface — summary plus tag hints. The body
 * is the vault manifest body (frontmatter stripped) so the procedure
 * travels with the trigger.
 */
function buildClaudeSkill(entry, raw) {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const tagHint = entry.tags.length
    ? ` Use when the task involves: ${entry.tags.join(', ')}.`
    : '';
  const description = `${(entry.summary || entry.id).replace(/\n/g, ' ')}${tagHint} (shared-mind vault skill — the vault copy at ${entry.relPath} is canonical.)`;
  return [
    '---',
    `name: ${entry.id}`,
    `description: ${description}`,
    '---',
    SYNC_MARKER,
    `> Synced from \`/Volumes/Projects/shared-mind/${entry.relPath}\` by the vault watcher.`,
    '> Edit the vault copy — this file is overwritten on every vault change.',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * Mirror active vault skills into ~/.claude/skills/<id>/SKILL.md so
 * Claude Code can actually invoke them. One-way sync; the manifest
 * records what we installed so removals only ever touch our own dirs.
 * Candidates (skills/_candidates/) and archived skills are never synced.
 */
function syncClaudeSkills(active) {
  fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
  const manifest = readJsonSafe(SYNC_MANIFEST) || { synced: [] };
  const previouslySynced = new Set(manifest.synced);
  const nowSynced = [];

  for (const entry of active) {
    const raw = readFileSafe(path.join(VAULT, entry.relPath));
    if (!raw) continue;
    const dir = path.join(CLAUDE_SKILLS_DIR, entry.id);
    const target = path.join(dir, 'SKILL.md');
    // Never overwrite a user-authored skill that we didn't install.
    if (fs.existsSync(target) && !previouslySynced.has(entry.id)) {
      const existing = readFileSafe(target);
      if (!existing.includes(SYNC_MARKER)) {
        log(`skill-sync: skipping ${entry.id} (user-authored skill exists at ${target})`);
        continue;
      }
    }
    const content = buildClaudeSkill(entry, raw);
    fs.mkdirSync(dir, { recursive: true });
    // Only write on change to avoid pointless mtime churn.
    if (readFileSafe(target) !== content) fs.writeFileSync(target, content);
    nowSynced.push(entry.id);
  }

  // Remove installs whose vault source is gone (archived or deleted) —
  // but only dirs we created, and only if they still carry our marker.
  const nowSyncedSet = new Set(nowSynced);
  for (const id of previouslySynced) {
    if (nowSyncedSet.has(id)) continue;
    const target = path.join(CLAUDE_SKILLS_DIR, id, 'SKILL.md');
    if (fs.existsSync(target) && readFileSafe(target).includes(SYNC_MARKER)) {
      fs.rmSync(path.join(CLAUDE_SKILLS_DIR, id), { recursive: true, force: true });
      log(`skill-sync: removed ${id} (no longer active in vault)`);
    }
  }

  fs.writeFileSync(SYNC_MANIFEST, JSON.stringify({ synced: nowSynced, lastSync: new Date().toISOString() }, null, 2));
  return nowSynced.length;
}

// ── Self-wiring link graph (GBrain pattern, zero LLM calls) ─────────────

const LINK_SECTIONS = ['memories', 'projects', 'workflows', 'incidents', 'skills'];

/** Walk section dirs and collect { rel, slug, body } for every .md file. */
function collectDocs(sections) {
  const docs = [];
  for (const section of sections) {
    const dir = path.join(VAULT, section);
    if (!fs.existsSync(dir)) continue;
    const walk = [dir];
    while (walk.length) {
      const current = walk.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('_') && !entry.name.startsWith('.')) walk.push(path.join(current, entry.name));
          continue;
        }
        if (!entry.name.endsWith('.md') || entry.name.startsWith('._')) continue;
        const full = path.join(current, entry.name);
        docs.push({
          rel: path.relative(VAULT, full),
          slug: entry.name.replace(/\.md$/, ''),
          body: readFileSafe(full),
        });
      }
    }
  }
  return docs;
}

/**
 * Build LINKS.md — a backlink/mention graph across the vault. Two edge
 * sources, both extracted at index time with zero LLM calls:
 *   - explicit [[wiki-links]] already present in file bodies
 *   - implicit mentions: another vault file's name/slug appearing in the text
 * Projection-only (GBrain inserts links into source files; here source
 * files are never mutated — no churn, no watcher feedback, no fighting
 * an author mid-edit).
 * Returns { linkedCount, backlinksByRel } — the per-doc inbound counts
 * feed the hybrid-search index as a ranking boost.
 */
function regenerateLinkGraph(docs) {
  // slug → set of referrers (rel paths)
  const inbound = new Map();
  const addEdge = (targetSlug, fromRel) => {
    if (!inbound.has(targetSlug)) inbound.set(targetSlug, new Set());
    inbound.get(targetSlug).add(fromRel);
  };
  const bySlug = new Map(docs.map((d) => [d.slug.toLowerCase(), d]));

  for (const doc of docs) {
    // Explicit [[wiki-links]]
    for (const m of doc.body.matchAll(/\[\[([^\]|#]+)/g)) {
      const target = m[1].trim().toLowerCase();
      if (target && target !== doc.slug.toLowerCase()) addEdge(target, doc.rel);
    }
    // Implicit mentions of other docs' slugs/titles (≥ 6 chars to avoid noise)
    const bodyLower = doc.body.toLowerCase();
    for (const [slug, target] of bySlug) {
      if (target.rel === doc.rel || slug.length < 6) continue;
      if (bodyLower.includes(slug) || bodyLower.includes(slug.replace(/[-_]/g, ' '))) {
        addEdge(slug, doc.rel);
      }
    }
  }

  const lines = [
    '# LINKS — vault backlink graph',
    '',
    '> Auto-generated by the vault watcher (self-wiring, zero LLM calls). **Do not edit by hand.**',
    '> Inbound references per document: explicit [[wiki-links]] + implicit name mentions.',
    '>',
    `> Generated: ${new Date().toISOString()}`,
    '',
  ];
  const linked = [...inbound.entries()]
    .filter(([slug]) => bySlug.has(slug))
    .sort((a, b) => b[1].size - a[1].size);
  const backlinksByRel = new Map();
  for (const [slug, referrers] of linked) {
    const target = bySlug.get(slug);
    lines.push(`## ${slug}`, `- target: [${target.rel}](${encodeFilename(target.rel)})`);
    for (const from of [...referrers].sort()) {
      lines.push(`- ← [${from}](${encodeFilename(from)})`);
    }
    lines.push('');
    backlinksByRel.set(target.rel, (backlinksByRel.get(target.rel) || 0) + referrers.size);
  }
  fs.writeFileSync(path.join(VAULT, 'LINKS.md'), lines.join('\n') + '\n');
  return { linkedCount: linked.length, backlinksByRel };
}

// ── Hybrid-search chunk index (GBrain pattern, consumed by Cortex) ──────

const INDEX_DIR = path.join(VAULT, '.index');
const INDEX_FILE = path.join(INDEX_DIR, 'vault-search.json');
// Root docs worth retrieving that aren't watcher-generated.
const INDEX_ROOT_DOCS = ['SOUL.md', 'USER.md', 'CONTEXT.md', 'CLAUDE.md', 'README.md'];
const CHUNK_TARGET = 1200; // greedy-pack adjacent sections up to this size
const CHUNK_MAX = 1600; // oversized sections split on paragraph boundaries

function collectRootDocs() {
  const docs = [];
  for (const name of INDEX_ROOT_DOCS) {
    const body = readFileSafe(path.join(VAULT, name));
    if (body) docs.push({ rel: name, slug: name.replace(/\.md$/, ''), body });
  }
  return docs;
}

/**
 * Split a markdown body into retrieval chunks: heading-delimited sections
 * (h1–h3), oversized ones split on paragraph boundaries, then adjacent
 * small pieces greedy-packed so tiny sections don't become noise chunks.
 */
function chunkMarkdown(body) {
  const sections = [];
  let current = { heading: '', text: '' };
  for (const line of body.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.+)/);
    if (h) {
      if (current.text.trim()) sections.push(current);
      current = { heading: h[1].trim(), text: '' };
    }
    current.text += line + '\n';
  }
  if (current.text.trim()) sections.push(current);

  const pieces = [];
  for (const s of sections) {
    const text = s.text.trim();
    if (text.length <= CHUNK_MAX) {
      pieces.push({ heading: s.heading, text });
      continue;
    }
    let buf = '';
    for (const para of text.split(/\n{2,}/)) {
      if (buf && buf.length + para.length > CHUNK_MAX) {
        pieces.push({ heading: s.heading, text: buf.trim() });
        buf = '';
      }
      if (para.length > CHUNK_MAX) {
        for (let i = 0; i < para.length; i += CHUNK_MAX) {
          pieces.push({ heading: s.heading, text: para.slice(i, i + CHUNK_MAX).trim() });
        }
      } else {
        buf += para + '\n\n';
      }
    }
    if (buf.trim()) pieces.push({ heading: s.heading, text: buf.trim() });
  }

  const chunks = [];
  for (const p of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && last.text.length + p.text.length + 2 <= CHUNK_TARGET) {
      last.text += '\n\n' + p.text;
    } else {
      chunks.push({ heading: p.heading, text: p.text });
    }
  }
  return chunks;
}

/**
 * Emit .index/vault-search.json for the Cortex gateway's hybrid vault
 * search (BM25 + embeddings + reciprocal-rank fusion; backlink counts
 * boost fused scores). Written atomically so Cortex never reads a
 * half-written index. Gitignored — vault-git-sync must not commit it.
 */
function regenerateSearchIndex(docs, backlinksByRel) {
  const out = { version: 1, generated: new Date().toISOString(), docs: [] };
  let chunkCount = 0;
  for (const doc of docs) {
    const chunks = chunkMarkdown(doc.body);
    if (chunks.length === 0) continue;
    const titleMatch = doc.body.match(/^#\s+(.+)$/m);
    out.docs.push({
      path: doc.rel,
      slug: doc.slug,
      section: doc.rel.includes('/') ? doc.rel.split('/')[0] : 'root',
      title: titleMatch ? titleMatch[1].trim() : doc.slug,
      backlinks: backlinksByRel.get(doc.rel) || 0,
      chunks: chunks.map((c, i) => ({ id: `${doc.rel}#${i}`, heading: c.heading, text: c.text })),
    });
    chunkCount += chunks.length;
  }
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, INDEX_FILE);
  return { docCount: out.docs.length, chunkCount };
}

function regenerateAll(reason = 'initial') {
  try {
    regenerateMemoryIndex();
    const { active } = regenerateSkillsIndexFile();
    regenerateAgentsProjection();
    regenerateAntigravityContext();
    const installed = syncClaudeSkills(active);
    const linkDocs = collectDocs(LINK_SECTIONS);
    const { linkedCount, backlinksByRel } = regenerateLinkGraph(linkDocs);
    // Search index covers the link-graph sections plus personas + root docs.
    const indexDocs = linkDocs.concat(collectDocs(['personas']), collectRootDocs());
    const { docCount, chunkCount } = regenerateSearchIndex(indexDocs, backlinksByRel);
    log(`Regenerated projections (${reason}); ${active.length} active skills indexed, ${installed} installed to ~/.claude/skills, ${linkedCount} docs in link graph, search index ${docCount} docs / ${chunkCount} chunks`);
  } catch (e) {
    log(`ERROR regenerating: ${e.stack || e.message}`);
  }
}

function shouldIgnore(filepath) {
  const rel = path.relative(VAULT, filepath);
  if (rel.startsWith('.git')) return true;
  if (rel.startsWith('.obsidian')) return true;
  if (rel.startsWith('.index')) return true;
  if (rel.startsWith('_archive')) return true;
  if (path.basename(rel).startsWith('._')) return true;
  // Skip changes to our own generated files (prevent feedback loop)
  const base = path.basename(rel);
  if (GENERATED_BASENAMES.has(base) && !rel.includes('/')) return true;
  return false;
}

function onChange(event, filepath) {
  if (shouldIgnore(filepath)) return;
  const rel = path.relative(VAULT, filepath);
  log(`${event}: ${rel}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => regenerateAll(`debounced ${event}`), DEBOUNCE_MS);
}

if (process.argv.includes('--once')) {
  regenerateAll('once');
  process.exit(0);
}

log(`Watching ${VAULT}`);
log(`Node ${process.version} pid ${process.pid}`);

const watcher = chokidar.watch(VAULT, {
  ignored: [
    /(^|[\/\\])\.git/,
    /(^|[\/\\])\.obsidian/,
    /(^|[\/\\])\.index/,
    /(^|[\/\\])\._/,
    /(^|[\/\\])_archive/,
  ],
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
});

watcher.on('add', (p) => onChange('add', p));
watcher.on('change', (p) => onChange('change', p));
watcher.on('unlink', (p) => onChange('unlink', p));
watcher.on('error', (e) => log(`watcher error: ${e.message}`));
watcher.on('ready', () => log('Watcher ready'));

// Initial regen on startup so files reflect current vault state.
regenerateAll('startup');

function shutdown(signal) {
  log(`${signal} received, shutting down`);
  watcher.close().then(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
