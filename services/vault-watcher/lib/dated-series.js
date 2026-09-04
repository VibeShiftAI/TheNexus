const { encodeFilename } = require('./fs-utils');

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

module.exports = {
  DATED_SERIES_RE,
  SERIES_MIN_MEMBERS,
  SERIES_RECENT_KEPT,
  seriesKey,
  collectDatedSeries,
  seriesSummaryLine,
  entryLine,
};
