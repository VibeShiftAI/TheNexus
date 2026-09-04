/** Frontmatter parsing: supersession contract and skill metadata. */

const path = require('path');
const { readFileSafe, listMarkdown } = require('./fs-utils');

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

module.exports = {
  frontmatterBlock,
  unquote,
  frontmatterList,
  readSupersession,
  collectMemoryEntries,
  parseSkillFrontmatter,
};
