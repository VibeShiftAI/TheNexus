/** MEMORY.md — the budgeted, value-ordered vault index. */

const fs = require('fs');
const path = require('path');
const { VAULT, log } = require('./config');
const { writeIfChanged, readFileSafe, readJsonSafe, encodeFilename, listMarkdown } = require('./fs-utils');
const { collectMemoryEntries, parseSkillFrontmatter } = require('./frontmatter');
const {
  DATED_SERIES_RE,
  SERIES_MIN_MEMBERS,
  SERIES_RECENT_KEPT,
  seriesKey,
  collectDatedSeries,
  seriesSummaryLine,
  entryLine,
} = require('./dated-series');

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

module.exports = {
  MEMORY_MAX_LINES,
  MEMORY_MAX_BYTES,
  MEMORY_GROUPS,
  MEMORY_OTHER_HEADING,
  MEMORY_POINTER_HEADING,
  MEMORY_NOTE_HEADING,
  NOTE_STAGES,
  buildNoteLines,
  buildMemoryIndexLines,
  buildSkillsPointer,
  regenerateMemoryIndex,
};
