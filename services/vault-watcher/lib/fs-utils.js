/** Small filesystem helpers shared by every generator. */

const fs = require('fs');

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

module.exports = {
  writeIfChanged,
  readFileSafe,
  readJsonSafe,
  encodeFilename,
  listMarkdown,
};
