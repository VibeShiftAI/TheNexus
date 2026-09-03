/**
 * Vault watcher — regenerates MEMORY.md, AGENTS.md, SKILLS.md,
 * shared-mind-context.md on every change to /Volumes/Projects/shared-mind/.
 * Long-lived daemon under launchd (com.thenexus.vault-watcher). Uses
 * Nexus's chokidar. Run with --once to regenerate and exit (no watch).
 *
 * Also owns vault git sync (./git-sync.js — hourly commit, 6-hourly push)
 * since the 2026-07-06 consolidation; the separate
 * com.thenexus.vault-git-sync launchd job is retired.
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
 *
 * MEMORY.md is emitted under a HARD load budget (200 lines / 25,000 bytes —
 * what Claude Code actually injects) and ordered by value, not alphabet:
 * reference → feedback → project → directory pointers → dated notes. Only
 * the dated-note section degrades when the budget bites. Files carrying
 * `status: superseded` / `superseded_by:` frontmatter are excluded from both
 * MEMORY.md and the search chunks. See the MEMORY.md budget block below.
 */

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

// Generated projections must be byte-stable when their inputs are unchanged:
// MEMORY.md/AGENTS.md/etc. are injected into the first message of every CLI
// session, and any byte of drift invalidates the prompt cache of every open
// session past the system prompt (measured at ~117M re-written tokens/week
// before this guard). Hence: no timestamps in generated content, and skip
// the write entirely when the bytes match.
function writeIfChanged(target, content) {
  if (readFileSafe(target) === content) return false;
  fs.writeFileSync(target, content);
  return true;
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

// ── Supersession frontmatter ─────────────────────────────────────
//
// Field names agreed with the Praxis task "Living STATE.md replaces the March
// CONTEXT.md" (e524649b-4ed2-4c7a-be13-09563b226f44, PART 3), which specifies
// `supersedes: [name]` and `status: superseded` + `superseded_by: name`:
//   - a replacement file lists what it retired:  supersedes: [old_a, old_b]
//   - a retired file is marked:                  status: superseded
//                                                superseded_by: new_name
// A file marked either way is dropped from MEMORY.md AND from the hybrid-search
// chunk index, so recall can never hand an agent a fact the vault has retired.
// Marking `status: superseded` alone is enough; `superseded_by` alone also
// counts, so a writer that forgets one of the two still gets the exclusion.

/** The raw text between the leading `---` fences, or '' when there is none. */
function frontmatterBlock(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  return m ? m[1] : '';
}

function unquote(v) {
  return v.trim().replace(/^["']|["']$/g, '').replace(/^\[\[|\]\]$/g, '').trim();
}

/**
 * Values for a frontmatter key in either YAML shape agents actually write:
 * inline `key: [a, b]` / `key: a`, or a block list of `- a` lines beneath it.
 */
function frontmatterList(fmText, key) {
  const lines = fmText.split('\n');
  const re = new RegExp('^' + key + ':\\s*(.*)$');
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(unquote)
        .filter(Boolean);
    }
    const out = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = /^\s*-\s*(.+)$/.exec(lines[j]);
      if (!item) break;
      const v = unquote(item[1]);
      if (v) out.push(v);
    }
    return out;
  }
  return [];
}

/** { superseded, supersedes } for one file body. Never throws. */
function readSupersession(raw) {
  const fm = frontmatterBlock(raw || '');
  if (!fm) return { superseded: false, supersedes: 0 };
  const status = /^status:\s*(.+)$/m.exec(fm);
  const supersededBy = frontmatterList(fm, 'superseded_by');
  return {
    superseded:
      (status ? unquote(status[1]).toLowerCase() === 'superseded' : false) || supersededBy.length > 0,
    supersedes: frontmatterList(fm, 'supersedes').length,
  };
}

/**
 * Index-ready entries for a vault directory: every non-superseded .md file,
 * carrying how many files it supersedes so its line can say so.
 */
function collectMemoryEntries(dir) {
  return listMarkdown(dir)
    .map((file) => {
      const s = readSupersession(readFileSafe(path.join(dir, file)));
      return { file, name: file.replace(/\.md$/, ''), superseded: s.superseded, supersedes: s.supersedes };
    })
    .filter((e) => !e.superseded);
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
      // Only `_candidates/` holds skills awaiting approval. Other underscore
      // dirs are NOT skills: `_knowledge/` is the skill wiki's per-skill
      // knowledge pages (one per active skill), and listing them here used to
      // label 100+ pages "pending approval — not installed" and push ~19 KB
      // of them into SKILLS.md and AGENTS.md on every regen.
      if (sub === '_candidates') candidates.push(entry);
      else if (sub.startsWith('_')) continue;
      else if (entry.state !== 'archived') active.push(entry);
    }
  }
  return { active, candidates };
}

// ── Dated-series collapsing ─────────────────────────────────────────────
//
// Many vault notes arrive as periodic series (captain's logs, code-change
// digests, knowledge-council notes). Listing every file one-per-line grew
// MEMORY.md past the point where a session loads it whole, so the tail of
// the index was silently invisible. Collapsing each series to a single
// ranged entry makes the index both smaller AND more complete.
//
// Detection is STRUCTURAL — a shared stem followed by a separator and an
// ISO date (optionally with a -HH-MM stamp) — not a hardcoded list of
// prefixes, so future series collapse on their own with no code change.

const DATED_SERIES_RE = /^(.+)([-_])(\d{4}-\d{2}-\d{2})((?:-\d{2}){2})?$/;
// Below this many dated siblings a stem is treated as incidental, not a
// series, and its files keep their individual lines.
const SERIES_MIN_MEMBERS = 3;
// How many of the newest members stay listed individually under the
// collapsed entry. Claude Code truncates MEMORY.md's loaded context at 200
// lines (confirmed via `strings` on the installed binary: `Une=200` behind
// "lines after ${Une} will be truncated"), so this stays 0 — the summary
// line alone already carries count, range, and pattern (criterion 2).
const SERIES_RECENT_KEPT = 0;

/**
 * Key a matched filename by stem, separator AND date shape. The shape is
 * part of the key on purpose: a stem with both `_2026-09-01` and
 * `_2026-09-01-08-30` siblings is two differently-named series, and
 * merging them would advertise one pattern that only fits some members.
 */
function seriesKey(m) {
  return `${m[1]}${m[2]}${m[4] ? 'T' : 'D'}`;
}

/**
 * Group a section's files into dated series. Returns a Map keyed by
 * seriesKey() holding only groups large enough to collapse.
 */
function collectDatedSeries(files) {
  const groups = new Map();
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    const m = DATED_SERIES_RE.exec(name);
    if (!m) continue;
    const [, stem, sep, date, time] = m;
    const key = seriesKey(m);
    let g = groups.get(key);
    if (!g) {
      g = { stem, sep, members: [], hasTime: Boolean(time) };
      groups.set(key, g);
    }
    g.members.push({ file: f, name, date });
  }
  const series = new Map();
  for (const [key, g] of groups) {
    if (g.members.length < SERIES_MIN_MEMBERS) continue;
    g.members.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date.localeCompare(b.date)));
    series.set(key, g);
  }
  return series;
}

/** The one collapsed line that stands in for a whole dated series. */
function seriesSummaryLine(section, g) {
  const first = g.members[0].date;
  const last = g.members[g.members.length - 1].date;
  const stamp = g.hasTime ? '<YYYY-MM-DD-HH-MM>' : '<YYYY-MM-DD>';
  const span = first === last ? first : `${first} to ${last}`;
  return (
    `- \`${g.stem}${g.sep}*\` — ${g.members.length} dated entries, ${span}` +
    ` · open one directly as \`${section}/${g.stem}${g.sep}${stamp}.md\``
  );
}

/** One linked line for a single file, annotated when it retired others. */
function entryLine(section, file, supersedes = 0) {
  const name = file.replace(/\.md$/, '');
  const note = supersedes > 0 ? ` (supersedes ${supersedes})` : '';
  return `- [\`${name}\`](${section}/${encodeFilename(file)})${note}`;
}

// ── Projections ─────────────────────────────────────────────────────────

// MEMORY.md load budget. Claude Code injects only the HEAD of this file into
// a session: 200 lines / 25,000 bytes (`strings` on the installed binary
// shows `Une=200` behind "lines after ${Une} will be truncated"). Until
// 2026-09-02 the index emitted every memory in one alphabetical run with no
// budget at all, so at 227 lines the tail fell off the end — 22 of the 33
// `reference_*` standing facts (including reference_vault_hybrid_search, the
// doc that explains how to search the vault) plus every directory pointer
// were invisible to the session that loads them. So: order by VALUE, not by
// alphabet, and degrade the DATED-NOTE section until the file fits. A
// standing fact never loses its line to a dated note.
const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25000;

// Standing-fact groups, emitted in this order ahead of the directory
// pointers and then the dated notes.
const MEMORY_GROUPS = [
  { prefix: 'reference_', heading: '## memories/reference — how the system actually works' },
  { prefix: 'feedback_', heading: "## memories/feedback — Robert's standing guidance" },
  { prefix: 'project_', heading: '## memories/project — standing project facts' },
];
// Anything matching none of the prefixes above (and not `note_`) is still a
// standing entry: an unrecognised prefix must never be the thing that
// silently disappears.
const MEMORY_OTHER_HEADING = '## memories/ — other standing entries';
const MEMORY_POINTER_HEADING = '## directories';
const MEMORY_NOTE_HEADING = '## memories/note — dated notes, newest first';

// Degradation ladder for the dated-note section, tried in order until the
// whole file fits: keep today's per-series collapse, else one line per
// stem-month, else per stem-quarter, else a single pointer line.
const NOTE_STAGES = ['series', 'month', 'quarter', 'pointer'];

function renderMemoryIndex(lines) {
  return lines.join('\n') + '\n';
}

function memoryIndexSize(lines) {
  return { lines: lines.length, bytes: Buffer.byteLength(renderMemoryIndex(lines), 'utf8') };
}

function withinMemoryBudget(lines) {
  const size = memoryIndexSize(lines);
  return size.lines <= MEMORY_MAX_LINES && size.bytes <= MEMORY_MAX_BYTES;
}

/** Parsed dated-filename parts for one entry name, or null when undated. */
function datedInfo(name) {
  const m = DATED_SERIES_RE.exec(name);
  if (!m) return null;
  return { stem: m[1], sep: m[2], date: m[3], hasTime: Boolean(m[4]), key: seriesKey(m) };
}

/** `2026-08` for the month stage, `2026-Q3` for the quarter stage. */
function noteBucket(date, stage) {
  const [year, month] = date.split('-');
  if (stage === 'quarter') return `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`;
  return `${year}-${month}`;
}

/**
 * Newest date first; ties fall back to line order.
 *
 * Each item carries its whole BLOCK of lines — a series summary plus any
 * `  - newest:` sub-bullets — and the block is the unit that sorts. Sorting
 * individual lines would orphan those children: they begin with spaces,
 * which collate ahead of the `- ` that starts their own parent, so any two
 * series sharing a newest date would interleave children under the wrong
 * summary. Adjacency is by construction here, not by comparator luck.
 */
function sortNewestFirst(items) {
  return items
    .slice()
    .sort((a, b) => (a.date === b.date ? a.lines[0].localeCompare(b.lines[0]) : b.date.localeCompare(a.date)))
    .flatMap((i) => i.lines);
}

/**
 * Render the dated-note section at one rung of the degradation ladder.
 * `entries` are { file, name, supersedes } records. Undated notes always
 * keep their own line — there are only a handful and they behave like
 * standing facts; the ladder exists for the hundreds of dated ones.
 *
 * `promoteNewest` lifts that many of the newest dated notes back out of
 * their collapsed buckets onto their own lines (month/quarter rungs only).
 * The ladder alone lands well under the ceiling — 123 of 200 lines against
 * the live vault — and leaving the rest of the budget empty would throw
 * away exactly the recall Robert asked for ("memory must be the most up to
 * date"). The caller grows this until the next line would breach the
 * budget, so the guarantee is unchanged: the file always fits.
 */
function buildNoteLines(section, entries, stage, promoteNewest = 0) {
  const dated = [];
  const undated = [];
  for (const e of entries) {
    const info = datedInfo(e.name);
    if (info) dated.push(Object.assign({}, e, info));
    else undated.push(e);
  }
  const undatedLines = undated.map((e) => entryLine(section, e.file, e.supersedes)).sort();
  if (dated.length === 0) return undatedLines;

  if (stage === 'series') {
    const series = collectDatedSeries(dated.map((e) => e.file));
    const items = [];
    const emitted = new Set();
    for (const e of dated) {
      const g = series.get(e.key);
      if (!g) {
        items.push({ date: e.date, lines: [entryLine(section, e.file, e.supersedes)] });
        continue;
      }
      if (emitted.has(e.key)) continue;
      emitted.add(e.key);
      const block = [seriesSummaryLine(section, g)];
      // Guard the slice: slice(-0) is slice(0), which would list the whole
      // series and re-inflate the very index this collapsing exists to shrink.
      const keep = Math.min(Math.max(SERIES_RECENT_KEPT, 0), g.members.length);
      for (const recent of keep ? g.members.slice(-keep) : []) {
        block.push(`  - newest: [\`${recent.name}\`](${section}/${encodeFilename(recent.file)})`);
      }
      items.push({ date: g.members[g.members.length - 1].date, lines: block });
    }
    return sortNewestFirst(items).concat(undatedLines);
  }

  const dates = dated.map((e) => e.date).sort();
  if (stage === 'pointer') {
    const span = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
    return [
      `- ${dated.length} dated notes, ${span} — not listed individually;` +
        ` search the vault (\`vault_search\`) or browse \`${section}/\`.`,
    ].concat(undatedLines);
  }

  // month / quarter: a real series (>= SERIES_MIN_MEMBERS siblings sharing a
  // stem) gets one line per bucket so its pattern stays reconstructable; the
  // long tail of one-off stems is pooled into a single count line per bucket.
  const newestFirst = dated
    .slice()
    .sort((a, b) => (a.date === b.date ? b.name.localeCompare(a.name) : b.date.localeCompare(a.date)));
  const promoted = newestFirst.slice(0, Math.max(0, Math.min(promoteNewest, newestFirst.length)));
  const promotedFiles = new Set(promoted.map((e) => e.file));
  const collapsed = newestFirst.filter((e) => !promotedFiles.has(e.file));
  const promotedLines = promoted.map((e) => entryLine(section, e.file, e.supersedes));
  if (collapsed.length === 0) return promotedLines.concat(undatedLines);

  const perStem = new Map();
  for (const e of collapsed) perStem.set(e.stem, (perStem.get(e.stem) || 0) + 1);

  const buckets = new Map();
  for (const e of collapsed) {
    const b = noteBucket(e.date, stage);
    if (!buckets.has(b)) buckets.set(b, { stems: new Map(), oneOffs: 0 });
    const bucket = buckets.get(b);
    if (perStem.get(e.stem) >= SERIES_MIN_MEMBERS) {
      const cur = bucket.stems.get(e.stem) || { count: 0, sep: e.sep, hasTime: e.hasTime };
      cur.count += 1;
      bucket.stems.set(e.stem, cur);
    } else {
      bucket.oneOffs += 1;
    }
  }

  const lines = [];
  for (const b of [...buckets.keys()].sort().reverse()) {
    const { stems, oneOffs } = buckets.get(b);
    const ordered = [...stems.entries()].sort((a, c) => c[1].count - a[1].count || a[0].localeCompare(c[0]));
    for (const [stem, s] of ordered) {
      const stamp = s.hasTime ? '<YYYY-MM-DD-HH-MM>' : '<YYYY-MM-DD>';
      lines.push(
        `- \`${stem}${s.sep}*\` — ${s.count} note${s.count === 1 ? '' : 's'} in ${b}` +
          ` · open one directly as \`${section}/${stem}${s.sep}${stamp}.md\``
      );
    }
    if (oneOffs > 0) {
      lines.push(
        `- ${oneOffs} one-off dated note${oneOffs === 1 ? '' : 's'} in ${b}` +
          ' — not listed individually; search the vault.'
      );
    }
  }
  return promotedLines.concat(lines, undatedLines);
}

/**
 * Assemble the whole MEMORY.md line list from already-collected input:
 *   { memories: [{ file, name, supersedes }], pointers: [string] }
 * Standing sections are emitted whole and are never shortened. Only the
 * dated-note section degrades, and only as far as the budget demands.
 * Returns { lines, stage, truncated, overBudget }.
 */
function buildMemoryIndexLines(input) {
  const memories = input.memories || [];
  const standing = [
    '# MEMORY — shared-mind vault index',
    '> Auto-generated by the vault watcher — do not edit by hand, it is overwritten on every vault change.',
  ];

  const knownPrefixes = MEMORY_GROUPS.map((g) => g.prefix).concat('note_');
  for (const group of MEMORY_GROUPS) {
    const entries = memories.filter((e) => e.name.startsWith(group.prefix));
    if (entries.length === 0) continue;
    standing.push(group.heading);
    for (const e of entries) standing.push(entryLine('memories', e.file, e.supersedes));
  }
  const other = memories.filter((e) => !knownPrefixes.some((p) => e.name.startsWith(p)));
  if (other.length > 0) {
    standing.push(MEMORY_OTHER_HEADING);
    for (const e of other) standing.push(entryLine('memories', e.file, e.supersedes));
  }
  const pointers = input.pointers || [];
  if (pointers.length > 0) {
    standing.push(MEMORY_POINTER_HEADING, ...pointers);
  }

  const notes = memories.filter((e) => e.name.startsWith('note_'));
  if (notes.length === 0) {
    return { lines: standing, stage: 'series', truncated: 0, overBudget: !withinMemoryBudget(standing) };
  }

  let stage = NOTE_STAGES[NOTE_STAGES.length - 1];
  let noteLines = [];
  let lines = standing;
  for (const candidate of NOTE_STAGES) {
    stage = candidate;
    noteLines = buildNoteLines('memories', notes, candidate);
    lines = standing.concat(MEMORY_NOTE_HEADING, noteLines);
    if (!withinMemoryBudget(lines)) continue;
    // This rung fits. Spend whatever budget is left listing the newest
    // dated notes individually again, one at a time, keeping the last
    // arrangement that still fits. `series` is already fully individual and
    // `pointer` is deliberately a single line, so only month/quarter grow.
    if (candidate === 'month' || candidate === 'quarter') {
      for (let promote = 1; promote <= notes.length; promote += 1) {
        const grown = buildNoteLines('memories', notes, candidate, promote);
        const grownLines = standing.concat(MEMORY_NOTE_HEADING, grown);
        if (!withinMemoryBudget(grownLines)) break;
        noteLines = grown;
        lines = grownLines;
      }
    }
    return { lines, stage, truncated: 0, overBudget: false };
  }

  // Last resort: even the single-pointer note section does not fit, which
  // means the standing sections are at the ceiling on their own. Drop note
  // lines from the tail — never a standing line — and say so in the file.
  let truncated = 0;
  const withMarker = () => {
    const marker =
      `- …${truncated} note line${truncated === 1 ? '' : 's'} dropped to fit the` +
      ` ${MEMORY_MAX_LINES}-line / ${MEMORY_MAX_BYTES}-byte load budget — search the vault.`;
    return noteLines.length > 0
      ? standing.concat(MEMORY_NOTE_HEADING, noteLines, marker)
      : standing.concat(marker);
  };
  while (noteLines.length > 0 && !withinMemoryBudget(lines)) {
    noteLines.pop();
    truncated += 1;
    lines = withMarker();
  }
  return { lines, stage, truncated, overBudget: !withinMemoryBudget(lines) };
}

/**
 * The `skills/` pointer line: a count plus a link to SKILLS.md, which holds
 * the one-line summaries and trigger hints. Archived skills are excluded
 * whether the index row or only the file frontmatter says so.
 */
function buildSkillsPointer(vaultDir) {
  const skillsRoot = path.join(vaultDir, 'skills');
  if (!fs.existsSync(skillsRoot)) return null;
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
  let skillCount = listMarkdown(skillsRoot).filter((f) => !isArchived(skillsRoot, f)).length;
  // Category dirs only: `_candidates/` (staging) and `_knowledge/` (wiki
  // pages) are neither active skills nor categories.
  const subdirs = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
  for (const sub of subdirs) {
    const subDir = path.join(skillsRoot, sub);
    skillCount += listMarkdown(subDir).filter((f) => !isArchived(subDir, f)).length;
  }
  return (
    `- \`skills/\` — ${skillCount} active skill${skillCount === 1 ? '' : 's'} across ${subdirs.length} categories;` +
    ' full one-line summaries and trigger hints: [SKILLS.md](SKILLS.md)'
  );
}

function regenerateMemoryIndex(vaultDir = VAULT) {
  const memories = collectMemoryEntries(path.join(vaultDir, 'memories'));

  const pointers = [];
  for (const section of ['projects', 'workflows', 'incidents']) {
    const count = collectMemoryEntries(path.join(vaultDir, section)).length;
    if (count === 0) continue;
    pointers.push(`- \`${section}/\` — ${count} file${count === 1 ? '' : 's'}, browse the directory directly`);
  }
  const skillsPointer = buildSkillsPointer(vaultDir);
  if (skillsPointer) pointers.push(skillsPointer);

  const built = buildMemoryIndexLines({ memories, pointers });
  const text = renderMemoryIndex(built.lines);
  const size = memoryIndexSize(built.lines);
  if (built.overBudget) {
    log(
      `WARNING: MEMORY.md standing sections alone exceed the load budget ` +
        `(${size.lines} lines / ${size.bytes} bytes vs ${MEMORY_MAX_LINES}/${MEMORY_MAX_BYTES}) — ` +
        'the session will not see the tail. Retire or supersede standing memories.'
    );
  } else if (built.truncated > 0) {
    log(
      `WARNING: MEMORY.md dropped ${built.truncated} dated-note line(s) to fit the load budget ` +
        `(${size.lines} lines / ${size.bytes} bytes).`
    );
  }
  writeIfChanged(path.join(vaultDir, 'MEMORY.md'), text);
  return { lines: size.lines, bytes: size.bytes, stage: built.stage, truncated: built.truncated };
}

function regenerateSkillsIndexFile() {
  const { active, candidates } = collectSkills();
  const lines = [
    '# SKILLS — shared-mind skill bus',
    '',
    '> Auto-generated by the vault watcher. **Do not edit by hand.**',
    '> Canonical skill library for all agents (Praxis, Claude Code, Codex, Antigravity).',
    '> Check here before nontrivial or repeated-shape work; follow the linked manifest.',
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

  writeIfChanged(path.join(VAULT, 'SKILLS.md'), lines.join('\n') + '\n');
  return { active, candidates };
}

/**
 * AGENTS.md — SOUL + USER + STATE + CONTEXT + retrieval protocol + SKILLS.
 *
 * STATE.md is Praxis's living current-state document (generated on a
 * heartbeat from code and live state — chat backend/model, router ladder,
 * executor defaults, CLI versions, active Nexus projects; task e524649b,
 * PART 1). It is spliced in where the March 2026 CONTEXT.md used to be:
 * CONTEXT.md is now a pointer plus the seed facts that never change, and it
 * follows STATE.md so Codex reads the current truth first. A vault without
 * STATE.md (Praxis not yet booted, or a test fixture) degrades to the old
 * CONTEXT-only projection — no gap, no crash.
 *
 * Praxis rewrites STATE.md only when a fact changes (its generated-at line
 * is excluded from the change hash), so this projection stays byte-stable
 * between real changes (commit 6a99e00's prompt-cache rule still holds).
 */
function regenerateAgentsProjection(vaultDir = VAULT) {
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
  const state = readFileSafe(path.join(vaultDir, 'STATE.md'));
  const context = readFileSafe(path.join(vaultDir, 'CONTEXT.md'));
  const stateBlock = state
    ? [state, '', '---', '', context]
    : [context];
  const parts = [
    `<!-- AUTO-GENERATED by the vault watcher. Do not edit. SOUL + USER + ${state ? 'STATE + ' : ''}CONTEXT + retrieval protocol + SKILLS for Codex consumption. -->`,
    '',
    readFileSafe(path.join(vaultDir, 'SOUL.md')),
    '',
    '---',
    '',
    readFileSafe(path.join(vaultDir, 'USER.md')),
    '',
    '---',
    '',
    ...stateBlock,
    '',
    '---',
    '',
    retrievalNote,
    '',
    '---',
    '',
    readFileSafe(path.join(vaultDir, 'SKILLS.md')),
  ];
  const text = parts.join('\n');
  writeIfChanged(path.join(vaultDir, 'AGENTS.md'), text);
  return { includesState: Boolean(state), text };
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
  writeIfChanged(path.join(VAULT, 'shared-mind-context.md'), parts.join('\n'));
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
  writeIfChanged(path.join(VAULT, 'LINKS.md'), lines.join('\n') + '\n');
  return { linkedCount: linked.length, backlinksByRel };
}

// ── Hybrid-search chunk index (GBrain pattern, consumed by Cortex) ──────

const INDEX_DIR = path.join(VAULT, '.index');
const INDEX_FILE = path.join(INDEX_DIR, 'vault-search.json');
// Root docs worth retrieving that aren't watcher-generated. STATE.md is
// Praxis-generated (not watcher-generated) and is the current-state doc
// searches should land on before the pointer that CONTEXT.md became.
const INDEX_ROOT_DOCS = ['SOUL.md', 'USER.md', 'STATE.md', 'CONTEXT.md', 'CLAUDE.md', 'README.md'];
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
 * Build the .index/vault-search.json payload consumed by the Cortex
 * gateway's hybrid vault search (BM25 + embeddings + reciprocal-rank
 * fusion; backlink counts boost fused scores).
 *
 * Superseded docs are dropped here as well as from MEMORY.md: a retired
 * fact that still answers a search is worse than one nobody can find,
 * because the agent has no way to tell it has been replaced.
 */
function buildSearchIndexPayload(docs, backlinksByRel) {
  const out = { version: 1, generated: new Date().toISOString(), docs: [] };
  let chunkCount = 0;
  let supersededCount = 0;
  for (const doc of docs) {
    if (readSupersession(doc.body).superseded) {
      supersededCount += 1;
      continue;
    }
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
  return { payload: out, docCount: out.docs.length, chunkCount, supersededCount };
}

/**
 * Write the search index atomically so Cortex never reads a half-written
 * file. Gitignored — vault-git-sync must not commit it.
 */
function regenerateSearchIndex(docs, backlinksByRel) {
  const { payload, docCount, chunkCount, supersededCount } = buildSearchIndexPayload(docs, backlinksByRel);
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, INDEX_FILE);
  return { docCount, chunkCount, supersededCount };
}

function regenerateAll(reason = 'initial') {
  try {
    const memory = regenerateMemoryIndex();
    const { active } = regenerateSkillsIndexFile();
    regenerateAgentsProjection();
    regenerateAntigravityContext();
    const installed = syncClaudeSkills(active);
    const linkDocs = collectDocs(LINK_SECTIONS);
    const { linkedCount, backlinksByRel } = regenerateLinkGraph(linkDocs);
    // Search index covers the link-graph sections plus personas + root docs.
    const indexDocs = linkDocs.concat(collectDocs(['personas']), collectRootDocs());
    const { docCount, chunkCount, supersededCount } = regenerateSearchIndex(indexDocs, backlinksByRel);
    log(`Regenerated projections (${reason}); MEMORY.md ${memory.lines} lines / ${memory.bytes} bytes (notes: ${memory.stage}), ${active.length} active skills indexed, ${installed} installed to ~/.claude/skills, ${linkedCount} docs in link graph, search index ${docCount} docs / ${chunkCount} chunks, ${supersededCount} superseded docs excluded`);
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

// Pure helpers are exported for unit tests. Everything below this point is
// daemon startup, guarded by require.main so `require()`ing this file (from a
// test, or any tooling) never spawns a watcher or touches the vault.
module.exports = {
  collectSkills,
  DATED_SERIES_RE,
  SERIES_MIN_MEMBERS,
  SERIES_RECENT_KEPT,
  seriesKey,
  collectDatedSeries,
  // Supersession contract (shared with the Praxis STATE.md/supersession task)
  readSupersession,
  collectMemoryEntries,
  // AGENTS.md projection — STATE.md (Praxis-generated) in place of the March CONTEXT.md
  regenerateAgentsProjection,
  INDEX_ROOT_DOCS,
  // MEMORY.md budget + priority ordering
  MEMORY_MAX_LINES,
  MEMORY_MAX_BYTES,
  MEMORY_GROUPS,
  NOTE_STAGES,
  buildNoteLines,
  buildMemoryIndexLines,
  regenerateMemoryIndex,
  // Hybrid-search chunk index
  buildSearchIndexPayload,
};

if (require.main === module) {
  if (process.argv.includes('--once')) {
    regenerateAll('once');
    process.exit(0);
  }

  // Required here, not at module scope: chokidar is ESM-only and is needed
  // only by the daemon, so the pure helpers stay requirable from a CJS test.
  const chokidar = require('chokidar');

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

  // ── Git sync (hourly commit, 6-hourly push) ──
  const { runGitSync } = require('./git-sync');
  const GIT_SYNC_INTERVAL_MS = 60 * 60 * 1000;

  async function gitSyncTick() {
    try {
      await runGitSync(VAULT, log);
    } catch (e) {
      log(`[GitSync] ERROR: ${e.stack || e.message}`);
    }
  }

  // First pass shortly after boot (matches the old job's RunAtLoad), then hourly.
  const gitSyncInitialTimer = setTimeout(gitSyncTick, 30_000);
  const gitSyncTimer = setInterval(gitSyncTick, GIT_SYNC_INTERVAL_MS);

  function shutdown(signal) {
    log(`${signal} received, shutting down`);
    clearTimeout(gitSyncInitialTimer);
    clearInterval(gitSyncTimer);
    watcher.close().then(() => process.exit(0));
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
