/**
 * Vault supersession — the frontmatter contract shared with the vault watcher
 * (services/vault-watcher/index.js `readSupersession`) and Praxis
 * (Praxis/src/memory/vault-supersession.ts). Agreed under Praxis task
 * e524649b ("Living STATE.md replaces the March CONTEXT.md", PART 3):
 *
 *   status: superseded          — this file is retired
 *   superseded_by: <name>       — the memory (file stem, no .md) that replaced it
 *   supersedes: [<name>, ...]   — on the replacement: what it retired
 *
 * A file marked either way is dropped from MEMORY.md, from the hybrid-search
 * chunk index and from the chat session's recall. Files stay on disk.
 *
 * Line-based YAML over TOP-LEVEL keys only — the same shape the watcher
 * parses, so a file this module writes is a file the watcher retires.
 */
const fs = require('fs');
const path = require('path');

const FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function splitFrontmatter(raw) {
  const m = FENCE_RE.exec(raw || '');
  if (!m) return { fm: null, body: raw || '' };
  return { fm: m[1], body: raw.slice(m[0].length) };
}

function joinFrontmatter(fm, body) {
  return `---\n${fm.replace(/\s+$/, '')}\n---\n${body}`;
}

function unquote(v) {
  return String(v).trim().replace(/^["']|["']$/g, '').replace(/^\[\[|\]\]$/g, '').trim();
}

/** Bare memory name: no path, no `.md`, no quotes or `[[ ]]`. */
function memoryName(v) {
  const base = unquote(v).split('/').pop() || '';
  return base.replace(/\.md$/i, '');
}

function frontmatterList(fm, key) {
  if (!fm) return [];
  const lines = fm.split('\n');
  const re = new RegExp('^' + key + ':\\s*(.*)$');
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) {
      return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
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

function frontmatterScalar(fm, key) {
  if (!fm) return undefined;
  const m = new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(fm);
  if (!m) return undefined;
  const v = unquote(m[1]);
  return v || undefined;
}

/** { superseded, supersededBy[], supersedes[] } for one file body. Never throws. */
function readSupersession(raw) {
  const { fm } = splitFrontmatter(raw || '');
  if (!fm) return { superseded: false, supersededBy: [], supersedes: [] };
  const status = frontmatterScalar(fm, 'status');
  const supersededBy = frontmatterList(fm, 'superseded_by').map(memoryName);
  return {
    superseded: (status ? status.toLowerCase() === 'superseded' : false) || supersededBy.length > 0,
    supersededBy,
    supersedes: frontmatterList(fm, 'supersedes').map(memoryName),
  };
}

/** Replace or append a top-level key; a list is written inline `[a, b]`. */
function setFrontmatterField(raw, key, value) {
  const rendered = Array.isArray(value)
    ? `${key}: [${value.map((v) => String(v).trim()).filter(Boolean).join(', ')}]`
    : `${key}: ${value}`;
  const { fm, body } = splitFrontmatter(raw || '');
  if (fm === null) return joinFrontmatter(rendered, body);
  const lines = fm.split('\n');
  const re = new RegExp('^' + key + ':');
  const out = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!replaced && re.test(lines[i])) {
      out.push(rendered);
      replaced = true;
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) i += 1;
      continue;
    }
    out.push(lines[i]);
  }
  if (!replaced) out.push(rendered);
  return joinFrontmatter(out.join('\n'), body);
}

function stampSuperseded(raw, by, at = new Date().toISOString()) {
  let next = setFrontmatterField(raw, 'status', 'superseded');
  next = setFrontmatterField(next, 'superseded_by', memoryName(by));
  const existingAt = frontmatterScalar(splitFrontmatter(raw || '').fm, 'superseded_at');
  return setFrontmatterField(next, 'superseded_at', existingAt || at);
}

function withSupersedes(raw, names) {
  const current = readSupersession(raw).supersedes;
  const merged = [...current];
  for (const n of names.map(memoryName).filter(Boolean)) if (!merged.includes(n)) merged.push(n);
  if (merged.length === 0) return raw;
  return setFrontmatterField(raw, 'supersedes', merged);
}

/**
 * Plan a superseding write: the replacement content with `supersedes:`
 * merged in, and the absolute paths of the old files to stamp. Pure —
 * nothing is written. Throws when a named old file does not exist or is the
 * replacement itself, so a typo cannot silently retire nothing.
 */
function planSupersession(vaultRoot, rel, content, supersedes) {
  const names = (supersedes || []).map(memoryName).filter(Boolean);
  const self = memoryName(rel);
  const dir = path.dirname(path.resolve(vaultRoot, rel));
  const targets = [];
  for (const name of names) {
    if (name === self) throw new Error(`supersedes cannot name the file being written (${name})`);
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) throw new Error(`supersedes names "${name}" but ${path.relative(vaultRoot, file)} does not exist`);
    targets.push({ name, file });
  }
  return { content: names.length ? withSupersedes(content, names) : content, targets, self };
}

/** Stamp every planned old file. Returns the names stamped. */
function applySupersession(plan, at = new Date().toISOString()) {
  const stamped = [];
  for (const t of plan.targets) {
    const raw = fs.readFileSync(t.file, 'utf8');
    const next = stampSuperseded(raw, plan.self, at);
    if (next !== raw) fs.writeFileSync(t.file, next, 'utf8');
    stamped.push(t.name);
  }
  return stamped;
}

module.exports = {
  splitFrontmatter,
  frontmatterList,
  frontmatterScalar,
  memoryName,
  readSupersession,
  setFrontmatterField,
  stampSuperseded,
  withSupersedes,
  planSupersession,
  applySupersession,
};
