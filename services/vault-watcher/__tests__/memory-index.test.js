/**
 * Coverage for the MEMORY.md load budget, its value-ordering, and the
 * supersession contract shared with the Praxis "Living STATE.md" task
 * (e524649b, PART 3: `supersedes` / `status: superseded` / `superseded_by`).
 *
 * Claude Code injects only the head of MEMORY.md into a session — 200 lines
 * and 25,000 bytes. Before this suite existed the generator knew the limit
 * and enforced nothing, so at 227 lines the alphabetical tail (22 of 33
 * `reference_*` standing facts, plus every directory pointer) was invisible.
 * These tests are the guard against that regressing.
 *
 * Requiring index.js is safe: its daemon startup is behind require.main.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MEMORY_MAX_LINES,
  MEMORY_MAX_BYTES,
  MEMORY_GROUPS,
  NOTE_STAGES,
  readSupersession,
  collectMemoryEntries,
  buildNoteLines,
  buildMemoryIndexLines,
  regenerateMemoryIndex,
  buildSearchIndexPayload,
} = require('../index.js');

// ── helpers ─────────────────────────────────────────────────────────────

/** { file, name, supersedes } records the index builder consumes. */
function entries(names, supersedesByName = {}) {
  return names.map((name) => ({
    file: `${name}.md`,
    name,
    supersedes: supersedesByName[name] || 0,
  }));
}

/**
 * Dated note names spread evenly over `months` (YYYY-MM strings).
 * `stemFor(month, i)` must return a stem that is either deliberately shared
 * (to make a real series) or globally unique — a stem that merely repeats
 * once per month is a 12-member series, not a one-off.
 */
function datedNotes(stemFor, months, perMonth) {
  const out = [];
  for (const month of months) {
    for (let i = 0; i < perMonth; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      out.push(`${stemFor(month, i)}_${month}-${day}`);
    }
  }
  return out;
}

function sizeOf(lines) {
  return { lines: lines.length, bytes: Buffer.byteLength(lines.join('\n') + '\n', 'utf8') };
}

function firstIndexMatching(lines, re) {
  return lines.findIndex((l) => re.test(l));
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-index-test-'));
  fs.mkdirSync(path.join(root, 'memories'), { recursive: true });
  return root;
}

function writeMemory(root, name, body) {
  fs.writeFileSync(path.join(root, 'memories', `${name}.md`), body, 'utf8');
}

// ── supersession frontmatter ────────────────────────────────────────────

describe('readSupersession', () => {
  it('reads status: superseded', () => {
    expect(readSupersession('---\nname: a\nstatus: superseded\n---\nbody').superseded).toBe(true);
  });

  it('reads superseded_by on its own, without a status line', () => {
    expect(readSupersession('---\nsuperseded_by: reference_new\n---\n').superseded).toBe(true);
  });

  it('treats any other status as live', () => {
    expect(readSupersession('---\nstatus: active\n---\n').superseded).toBe(false);
    expect(readSupersession('# no frontmatter at all\n').superseded).toBe(false);
  });

  it('counts an inline supersedes list', () => {
    expect(readSupersession('---\nsupersedes: [old_a, old_b, old_c]\n---\n').supersedes).toBe(3);
  });

  it('counts a block supersedes list and strips wiki brackets and quotes', () => {
    const raw = '---\nsupersedes:\n  - "[[old_a]]"\n  - old_b\nstatus: active\n---\n';
    expect(readSupersession(raw).supersedes).toBe(2);
  });

  it('counts a single scalar supersedes value', () => {
    expect(readSupersession('---\nsupersedes: old_a\n---\n').supersedes).toBe(1);
  });
});

// ── ordering ────────────────────────────────────────────────────────────

describe('MEMORY.md ordering', () => {
  const built = buildMemoryIndexLines({
    memories: entries([
      'note_zulu_2026-08-01',
      'project_alpha',
      'reference_alpha',
      'feedback_alpha',
      'oddball_entry',
    ]),
    pointers: ['- `projects/` — 39 files, browse the directory directly'],
  });

  it('emits reference → feedback → project → other → pointers → note', () => {
    const l = built.lines;
    const ref = firstIndexMatching(l, /reference_alpha/);
    const fb = firstIndexMatching(l, /feedback_alpha/);
    const proj = firstIndexMatching(l, /project_alpha/);
    const other = firstIndexMatching(l, /oddball_entry/);
    const ptr = firstIndexMatching(l, /`projects\/`/);
    const note = firstIndexMatching(l, /note_zulu/);
    expect(ref).toBeGreaterThan(-1);
    expect(ref).toBeLessThan(fb);
    expect(fb).toBeLessThan(proj);
    expect(proj).toBeLessThan(other);
    expect(other).toBeLessThan(ptr);
    expect(ptr).toBeLessThan(note);
  });

  it('declares the standing-fact groups in reference → feedback → project order', () => {
    expect(MEMORY_GROUPS.map((g) => g.prefix)).toEqual(['reference_', 'feedback_', 'project_']);
  });

  it('keeps the two-line do-not-edit header first', () => {
    expect(built.lines[0]).toBe('# MEMORY — shared-mind vault index');
    expect(built.lines[1]).toMatch(/do not edit by hand/);
  });

  it('annotates a line that supersedes other files', () => {
    const { lines } = buildMemoryIndexLines({
      memories: entries(['reference_new'], { reference_new: 2 }),
      pointers: [],
    });
    expect(lines.some((l) => l.includes('reference_new') && l.includes('(supersedes 2)'))).toBe(true);
  });

  it('orders dated notes newest first', () => {
    const { lines } = buildMemoryIndexLines({
      memories: entries(['note_a_2026-07-01', 'note_b_2026-09-01', 'note_c_2026-08-01']),
      pointers: [],
    });
    const seq = lines.filter((l) => /note_[abc]_/.test(l));
    expect(seq.map((l) => l.match(/note_([abc])_/)[1])).toEqual(['b', 'c', 'a']);
  });
});

// ── the hard budget ─────────────────────────────────────────────────────

describe('MEMORY.md budget', () => {
  // 33 reference + 36 feedback + 15 project standing facts (the live vault's
  // shape on 2026-09-02) against 400 dated notes — well past the ceiling if
  // nothing degrades.
  const standingNames = []
    .concat(Array.from({ length: 33 }, (_, i) => `reference_fact_${String(i).padStart(2, '0')}`))
    .concat(Array.from({ length: 36 }, (_, i) => `feedback_rule_${String(i).padStart(2, '0')}`))
    .concat(Array.from({ length: 15 }, (_, i) => `project_state_${String(i).padStart(2, '0')}`));
  const notes = datedNotes(
    (month, i) => (i % 5 === 0 ? 'note_captains_log' : `note_oneoff_${month}_${i}`),
    ['2026-05', '2026-06', '2026-07', '2026-08'],
    100
  );
  const pointers = [
    '- `projects/` — 39 files, browse the directory directly',
    '- `workflows/` — 5 files, browse the directory directly',
    '- `incidents/` — 7 files, browse the directory directly',
    '- `skills/` — 123 active skills across 5 categories; full one-line summaries and trigger hints: [SKILLS.md](SKILLS.md)',
  ];
  const built = buildMemoryIndexLines({ memories: entries(standingNames.concat(notes)), pointers });
  const size = sizeOf(built.lines);

  it('fits 200 lines and 25,000 bytes on input that is far over budget', () => {
    // 84 standing memories + 400 notes + 4 pointers is far past the ceiling
    // before anything degrades; what lands must still fit.
    expect(notes).toHaveLength(400);
    expect(size.lines).toBeLessThanOrEqual(MEMORY_MAX_LINES);
    expect(size.bytes).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    expect(built.truncated).toBe(0);
    expect(built.overBudget).toBe(false);
  });

  it('keeps every reference_ entry, and keeps them inside the loaded head', () => {
    const refLines = built.lines
      .map((l, i) => ({ l, line: i + 1 }))
      .filter(({ l }) => l.includes('reference_fact_'));
    expect(refLines).toHaveLength(33);
    expect(Math.max(...refLines.map((r) => r.line))).toBeLessThanOrEqual(MEMORY_MAX_LINES);
  });

  it('keeps every feedback_ and project_ standing line too', () => {
    expect(built.lines.filter((l) => l.includes('feedback_rule_'))).toHaveLength(36);
    expect(built.lines.filter((l) => l.includes('project_state_'))).toHaveLength(15);
  });

  it('degrades the dated notes, not the standing facts', () => {
    expect(built.stage).not.toBe('series');
    expect(NOTE_STAGES).toContain(built.stage);
    // Collapsed bucket lines exist, so notes really were folded.
    expect(built.lines.some((l) => /one-off dated notes? in \d{4}-/.test(l))).toBe(true);
  });

  it('still lists the newest notes individually when budget is left over', () => {
    const noteHead = built.lines[firstIndexMatching(built.lines, /^## memories\/note/) + 1];
    expect(noteHead).toMatch(/2026-08-/);
  });
});

describe('note degradation ladder', () => {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];
  const notes = entries(
    datedNotes((month, i) => (i % 2 === 0 ? 'note_series' : `note_solo_${month}_${i}`), months, 6)
  );

  it('month buckets one line per stem-month and pools one-off stems', () => {
    const lines = buildNoteLines('memories', notes, 'month');
    expect(lines.some((l) => l.includes('`note_series_*`') && l.includes('in 2026-12'))).toBe(true);
    expect(lines.some((l) => /one-off dated notes in 2026-12/.test(l))).toBe(true);
    // One bucket per month, never per file.
    expect(lines.length).toBeLessThan(notes.length);
  });

  it('quarter buckets are strictly coarser than month buckets', () => {
    const month = buildNoteLines('memories', notes, 'month');
    const quarter = buildNoteLines('memories', notes, 'quarter');
    expect(quarter.length).toBeLessThan(month.length);
    expect(quarter.some((l) => l.includes('2026-Q4'))).toBe(true);
  });

  it('pointer collapses every dated note to a single searchable line', () => {
    const lines = buildNoteLines('memories', notes, 'pointer');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^- ${notes.length} dated notes, 2026-01-01 to 2026-12-`));
    expect(lines[0]).toMatch(/search the vault/);
  });

  it('walks month → quarter → pointer as the standing sections grow', () => {
    const stageFor = (standingCount) =>
      buildMemoryIndexLines({
        memories: entries(
          Array.from({ length: standingCount }, (_, i) => `reference_f_${String(i).padStart(3, '0')}`)
        ).concat(notes),
        pointers: [],
      }).stage;
    // 72 notes: one 36-member series + 36 one-off stems. Per rung the note
    // section costs 37 lines (series), 24 (month), 8 (quarter), 1 (pointer),
    // so growing the standing sections walks the ladder down.
    expect(stageFor(120)).toBe('series');
    expect(stageFor(165)).toBe('month');
    expect(stageFor(178)).toBe('quarter');
    expect(stageFor(192)).toBe('pointer');
  });

  it('truncates note lines — never standing lines — when even the pointer will not fit', () => {
    const standing = Array.from({ length: 210 }, (_, i) => `reference_f_${String(i).padStart(3, '0')}`);
    const built = buildMemoryIndexLines({
      memories: entries(standing).concat(notes),
      pointers: [],
    });
    expect(built.lines.filter((l) => l.includes('reference_f_'))).toHaveLength(210);
    expect(built.lines.some((l) => /note_/.test(l))).toBe(false);
    expect(built.truncated).toBeGreaterThan(0);
    expect(built.overBudget).toBe(true);
    expect(built.lines[built.lines.length - 1]).toMatch(/dropped to fit the 200-line/);
  });
});

// ── series sub-bullets stay attached to their parent ────────────────────

/**
 * `SERIES_RECENT_KEPT` ships as 0, so the `  - newest:` sub-bullet branch in
 * buildNoteLines() is unreachable in production and cannot be driven from a
 * normal test. Load a copy of the module with the constant flipped to 1 so
 * the branch is exercised for real.
 */
function loadWithRecentKept(n) {
  // The constant lives in lib/dated-series.js; the copy carries index.js plus
  // the whole lib/ directory so the copied index.js resolves its own requires.
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-kept-'));
  fs.copyFileSync(path.join(root, 'index.js'), path.join(tmp, 'index.js'));
  fs.mkdirSync(path.join(tmp, 'lib'));
  for (const name of fs.readdirSync(path.join(root, 'lib'))) {
    fs.copyFileSync(path.join(root, 'lib', name), path.join(tmp, 'lib', name));
  }
  const target = path.join(tmp, 'lib', 'dated-series.js');
  const source = fs.readFileSync(target, 'utf8');
  const patched = source.replace('const SERIES_RECENT_KEPT = 0;', `const SERIES_RECENT_KEPT = ${n};`);
  expect(patched).not.toBe(source); // the constant was renamed — fix this test
  fs.writeFileSync(target, patched, 'utf8');
  return require(path.join(tmp, 'index.js'));
}

describe('series sub-bullets', () => {
  // Regression: sub-bullets used to be pushed as independent sort items
  // carrying their parent's date. They begin with spaces, which collate
  // ahead of the `- ` starting their own parent, so two series sharing a
  // newest date sorted every child above every summary — orphaning them.
  const files = [
    'note_alpha_2026-09-01.md', 'note_alpha_2026-09-02.md', 'note_alpha_2026-09-03.md',
    'note_beta_2026-08-30.md', 'note_beta_2026-08-31.md', 'note_beta_2026-09-03.md',
  ];
  const entries = files
    .slice()
    .sort()
    .map((file) => ({ file, name: file.replace(/\.md$/, ''), supersedes: 0 }));

  it('keeps each `newest:` child directly under its own series summary on a date tie', () => {
    const mod = loadWithRecentKept(1);
    const lines = mod.buildNoteLines('memories', entries, 'series');

    // Guard: if the branch did not run there is nothing to assert about.
    const children = lines.filter((l) => l.startsWith('  - newest:'));
    expect(children).toHaveLength(2);

    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('  - newest:')) continue;
      const stem = lines[i].match(/note_(\w+?)_\d{4}-/)[1];
      expect(lines[i - 1]).toContain(`\`note_${stem}_*\``);
    }
    // Both series' newest member is 2026-09-03 — the tie the bug needed.
    expect(lines[0]).toContain('`note_alpha_*`');
    expect(lines[2]).toContain('`note_beta_*`');
  });
});

// ── superseded files are excluded, end to end ───────────────────────────

describe('supersession excludes files from MEMORY.md', () => {
  let root;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('drops a superseded memory and keeps its replacement, annotated', () => {
    root = makeVault();
    writeMemory(root, 'reference_old_router', '---\nstatus: superseded\nsuperseded_by: reference_router\n---\nold\n');
    writeMemory(root, 'reference_stale_slug', '---\nsuperseded_by: reference_router\n---\nold\n');
    writeMemory(root, 'reference_router', '---\nsupersedes: [reference_old_router, reference_stale_slug]\n---\nnew\n');
    writeMemory(root, 'feedback_live', '---\nstatus: active\n---\nlive\n');

    const stats = regenerateMemoryIndex(root);
    const out = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8');

    expect(out).not.toMatch(/reference_old_router/);
    expect(out).not.toMatch(/reference_stale_slug/);
    expect(out).toMatch(/reference_router.*\(supersedes 2\)/);
    expect(out).toMatch(/feedback_live/);
    expect(stats.lines).toBeLessThanOrEqual(MEMORY_MAX_LINES);
    expect(stats.bytes).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
  });

  it('excludes superseded files from collectMemoryEntries', () => {
    root = makeVault();
    writeMemory(root, 'reference_a', 'no frontmatter\n');
    writeMemory(root, 'reference_b', '---\nstatus: superseded\n---\n');
    const found = collectMemoryEntries(path.join(root, 'memories')).map((e) => e.name);
    expect(found).toEqual(['reference_a']);
  });
});

describe('supersession excludes files from the vault-search chunks', () => {
  const docs = [
    { rel: 'memories/reference_router.md', slug: 'reference_router', body: '---\nsupersedes: [reference_old_router]\n---\n# Router\n\ncurrent ladder\n' },
    { rel: 'memories/reference_old_router.md', slug: 'reference_old_router', body: '---\nstatus: superseded\nsuperseded_by: reference_router\n---\n# Router\n\nold ladder\n' },
    { rel: 'memories/reference_stale.md', slug: 'reference_stale', body: '---\nsuperseded_by: reference_router\n---\n# Stale\n\nold\n' },
  ];

  it('keeps the live doc and drops both superseded ones', () => {
    const { payload, docCount, supersededCount } = buildSearchIndexPayload(docs, new Map());
    expect(docCount).toBe(1);
    expect(supersededCount).toBe(2);
    expect(payload.docs.map((d) => d.path)).toEqual(['memories/reference_router.md']);
    expect(JSON.stringify(payload)).not.toMatch(/old ladder/);
  });
});
