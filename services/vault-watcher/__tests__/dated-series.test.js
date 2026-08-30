/**
 * Unit coverage for MEMORY.md dated-series collapsing.
 *
 * These are pure functions: they take a sorted list of ".md" basenames and
 * return the markdown lines the vault index renders. Requiring index.js is
 * safe — its daemon startup is behind a require.main guard.
 */

const {
  collectDatedSeries,
  pushSectionEntries,
  seriesKey,
  DATED_SERIES_RE,
  SERIES_MIN_MEMBERS,
} = require('../index.js');

/** Render a section the way regenerateMemoryIndex() does. */
function render(files) {
  const lines = [];
  pushSectionEntries(lines, 'memories', [...files].sort());
  return lines;
}

/** The single collapsed-summary line for a stem, or undefined. */
function summaryFor(lines, stemPrefix) {
  return lines.find((l) => l.startsWith(`- \`${stemPrefix}`) && l.includes('dated entries'));
}

describe('DATED_SERIES_RE', () => {
  it('matches an underscore-separated ISO date', () => {
    expect(DATED_SERIES_RE.exec('note_captains_log_2026-07-07').slice(1, 4))
      .toEqual(['note_captains_log', '_', '2026-07-07']);
  });

  it('matches a hyphen-separated ISO date', () => {
    expect(DATED_SERIES_RE.exec('digest-2026-09-01').slice(1, 4))
      .toEqual(['digest', '-', '2026-09-01']);
  });

  it('captures the -HH-MM stamp as a separate group', () => {
    const m = DATED_SERIES_RE.exec('run_log_2026-09-01-08-30');
    expect(m[1]).toBe('run_log');
    expect(m[3]).toBe('2026-09-01');
    expect(m[4]).toBe('-08-30');
  });

  it('prefers the longest stem so a stem may itself end in digits', () => {
    expect(DATED_SERIES_RE.exec('note_q3_2026-09-01')[1]).toBe('note_q3');
  });

  it('does not match an undated name', () => {
    expect(DATED_SERIES_RE.exec('reference_thing')).toBeNull();
  });

  it('does not match a partial or malformed date', () => {
    expect(DATED_SERIES_RE.exec('note_foo_2026-09')).toBeNull();
    expect(DATED_SERIES_RE.exec('note_foo_26-09-01')).toBeNull();
  });
});

describe('collectDatedSeries', () => {
  const dated = (stem, dates) => dates.map((d) => `${stem}${d}.md`);

  it('collapses a stem at exactly the threshold', () => {
    const files = dated('note_retro_', ['2026-09-01', '2026-09-08', '2026-09-15']);
    expect(files).toHaveLength(SERIES_MIN_MEMBERS);
    const series = collectDatedSeries(files);
    expect(series.size).toBe(1);
    expect([...series.values()][0].members).toHaveLength(3);
  });

  it('leaves a stem one below the threshold uncollapsed', () => {
    const series = collectDatedSeries(dated('note_pairwise_', ['2026-09-01', '2026-09-02']));
    expect(series.size).toBe(0);
  });

  it('orders members chronologically regardless of input order', () => {
    const series = collectDatedSeries(dated('note_retro_', ['2026-09-15', '2026-09-01', '2026-09-08']));
    const g = [...series.values()][0];
    expect(g.members.map((m) => m.date)).toEqual(['2026-09-01', '2026-09-08', '2026-09-15']);
  });

  it('keeps sibling stems separate when one is a prefix of the other', () => {
    const series = collectDatedSeries([
      ...dated('note_reflect_praxis_', ['2026-09-01', '2026-09-02', '2026-09-03']),
      ...dated('note_reflect_praxis_ipad_', ['2026-09-01', '2026-09-02', '2026-09-03']),
    ]);
    expect(series.size).toBe(2);
    for (const g of series.values()) expect(g.members).toHaveLength(3);
  });

  it('ignores undated files entirely', () => {
    expect(collectDatedSeries(['reference_thing.md', 'note_retro.md']).size).toBe(0);
  });
});

describe('pushSectionEntries', () => {
  it('renders count, date range and reconstructable pattern for a series', () => {
    const lines = render([
      'note_retro_2026-09-01.md', 'note_retro_2026-09-08.md', 'note_retro_2026-09-15.md',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('3 dated entries');
    expect(lines[0]).toContain('2026-09-01 to 2026-09-15');
    expect(lines[0]).toContain('`memories/note_retro_<YYYY-MM-DD>.md`');
  });

  it('advertises the timestamp pattern for a -HH-MM series', () => {
    const lines = render([
      'run_log_2026-09-01-08-30.md', 'run_log_2026-09-01-17-45.md', 'run_log_2026-09-02-09-00.md',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('`memories/run_log_<YYYY-MM-DD-HH-MM>.md`');
  });

  it('handles a hyphen separator without mangling the stem', () => {
    const lines = render([
      'digest-2026-09-01.md', 'digest-2026-09-02.md', 'digest-2026-09-03.md',
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('- `digest-*`');
    expect(lines[0]).toContain('`memories/digest-<YYYY-MM-DD>.md`');
  });

  it('collapses to a single date when every member shares one', () => {
    const lines = render([
      'note_burst_2026-09-01-01-00.md',
      'note_burst_2026-09-01-02-00.md',
      'note_burst_2026-09-01-03-00.md',
    ]);
    expect(lines[0]).toContain('2026-09-01 ·');
    expect(lines[0]).not.toContain('2026-09-01 to 2026-09-01');
  });

  it('links sub-threshold dated files individually', () => {
    const lines = render(['note_pairwise_2026-09-01.md', 'note_pairwise_2026-09-02.md']);
    expect(lines).toEqual([
      '- [`note_pairwise_2026-09-01`](memories/note_pairwise_2026-09-01.md)',
      '- [`note_pairwise_2026-09-02`](memories/note_pairwise_2026-09-02.md)',
    ]);
  });

  it('keeps an undated sibling of a collapsed stem as its own entry', () => {
    const lines = render([
      'note_retro.md',
      'note_retro_2026-09-01.md', 'note_retro_2026-09-08.md', 'note_retro_2026-09-15.md',
    ]);
    expect(lines).toContain('- [`note_retro`](memories/note_retro.md)');
    expect(summaryFor(lines, 'note_retro_*')).toBeDefined();
    expect(lines).toHaveLength(2);
  });

  it('percent-encodes characters that are unsafe in a markdown link', () => {
    const lines = render(['reference tracked repos.md']);
    expect(lines[0]).toBe('- [`reference tracked repos`](memories/reference%20tracked%20repos.md)');
  });

  it('emits one summary per series and preserves alphabetical placement', () => {
    const lines = render([
      'aaa_first.md',
      'note_retro_2026-09-01.md', 'note_retro_2026-09-08.md', 'note_retro_2026-09-15.md',
      'zzz_last.md',
    ]);
    expect(lines[0]).toBe('- [`aaa_first`](memories/aaa_first.md)');
    expect(lines[1]).toContain('3 dated entries');
    expect(lines[2]).toBe('- [`zzz_last`](memories/zzz_last.md)');
  });
});

describe('mixed date-only and date-time siblings', () => {
  // Regression: a single group-level hasTime flag advertised only the
  // timestamp pattern, so the date-only members could not be reconstructed
  // from the summary line. Shapes are keyed separately instead.
  const files = [
    'note_mixed_2026-09-01.md', 'note_mixed_2026-09-02.md', 'note_mixed_2026-09-03.md',
    'note_mixed_2026-09-04-08-30.md', 'note_mixed_2026-09-05-09-15.md', 'note_mixed_2026-09-06-10-00.md',
  ];

  it('keys the two shapes as separate series', () => {
    expect(seriesKey(DATED_SERIES_RE.exec('note_mixed_2026-09-01')))
      .not.toBe(seriesKey(DATED_SERIES_RE.exec('note_mixed_2026-09-04-08-30')));
    expect(collectDatedSeries(files).size).toBe(2);
  });

  it('advertises both patterns, each with its own count and range', () => {
    const lines = render(files);
    const dateOnly = lines.find((l) => l.includes('<YYYY-MM-DD>.md'));
    const withTime = lines.find((l) => l.includes('<YYYY-MM-DD-HH-MM>.md'));

    expect(dateOnly).toBeDefined();
    expect(dateOnly).toContain('3 dated entries');
    expect(dateOnly).toContain('2026-09-01 to 2026-09-03');

    expect(withTime).toBeDefined();
    expect(withTime).toContain('3 dated entries');
    expect(withTime).toContain('2026-09-04 to 2026-09-06');
  });

  it('does not let a mixed stem hide date-only members behind a timestamp pattern', () => {
    const lines = render(files);
    const summaries = lines.filter((l) => l.includes('dated entries'));
    expect(summaries).toHaveLength(2);
    // Every one of the six files is reachable: 3 + 3 accounted for.
    const total = summaries.reduce((n, l) => n + Number(l.match(/(\d+) dated entries/)[1]), 0);
    expect(total).toBe(files.length);
  });

  it('falls back to individual links when neither shape reaches the threshold', () => {
    const lines = render([
      'note_thin_2026-09-01.md', 'note_thin_2026-09-02.md',
      'note_thin_2026-09-03-08-00.md', 'note_thin_2026-09-04-09-00.md',
    ]);
    expect(lines.filter((l) => l.includes('dated entries'))).toHaveLength(0);
    expect(lines).toHaveLength(4);
  });
});
