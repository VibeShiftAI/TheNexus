/** Small filesystem helpers shared by every generator. */

const fs = require('fs');
const path = require('path');
const { stampGenerated, OWNER } = require('./write-protocol');

// Generated projections must be byte-stable when their inputs are unchanged:
// MEMORY.md/AGENTS.md/etc. are injected into the first message of every CLI
// session, and any byte of drift invalidates the prompt cache of every open
// session past the system prompt (measured at ~117M re-written tokens/week
// before this guard). Hence: no timestamps in generated content, and skip
// the write entirely when the bytes match.
// Every writeIfChanged target is a watcher-generated projection, so the
// GENERATED header (P1-17 §4.3) is stamped here — BEFORE the comparison, so a
// projection whose inputs are unchanged still writes zero bytes and the prompt
// cache above stays intact. The header is what authored-mode writers (Praxis,
// the MCP server) check to refuse a file they do not own.
function writeIfChanged(target, content, owner = OWNER) {
  const final = stampGenerated(content, owner);
  if (readFileSafe(target) === final) return false;
  // Atomic: a reader (or git-sync's `git add -A`) sees the old projection or
  // the new one, never a torn one. `.<base>.<pid>.<ts>.tmp` is gitignored and
  // watcher-ignored.
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, final);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
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

module.exports = {
  writeIfChanged,
  readFileSafe,
  readJsonSafe,
  encodeFilename,
  listMarkdown,
};
