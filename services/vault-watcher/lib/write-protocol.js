/**
 * The watcher's door onto the fleet write protocol (P1-17).
 *
 * The real implementation lives in server/lib/vault-write.js + vault-lock.js so
 * the watcher, the MCP server and Praxis share ONE contract. The require is
 * relative to this file; __tests__/memory-index.test.js copies the watcher
 * (index.js + lib/) into a temp dir where the helper is out of reach, so — the
 * same pattern lib/config.js already uses for vault-paths — fall back to an
 * inline stamp and a no-op lock rather than crash. The fallback keeps the
 * generated header (it is a pure string) and drops only the locking, which a
 * unit test on a temp vault does not need.
 */

const fallbackHeader = (owner) =>
  `<!-- GENERATED: ${owner}; do not edit — see workflows/Vault Single Writer Design.md -->`;
const FALLBACK_RE = /^<!--\s*GENERATED:\s*([a-z0-9-]+)\s*;/i;

let impl;
try {
  const vw = require('../../../server/lib/vault-write');
  const vl = require('../../../server/lib/vault-lock');
  impl = {
    generatedHeader: vw.generatedHeader,
    generatedOwnerOf: vw.generatedOwnerOf,
    stampGenerated: vw.stampGenerated,
    withLocks: vl.withLocks,
    withLocksAsync: vl.withLocksAsync,
    acquireLock: vl.acquireLock,
    inspectLocks: vl.inspectLocks,
    LOCK_WARN_AGE_MS: vl.LOCK_WARN_AGE_MS,
    available: true,
  };
} catch {
  impl = {
    generatedHeader: fallbackHeader,
    generatedOwnerOf: (text) => {
      const m = FALLBACK_RE.exec((text || '').slice(0, 200));
      return m ? m[1].toLowerCase() : null;
    },
    stampGenerated: (content, owner) => {
      const m = FALLBACK_RE.exec((content || '').slice(0, 200));
      if (m && m[1].toLowerCase() === owner) return content;
      return `${fallbackHeader(owner)}\n${content}`;
    },
    withLocks: (_vault, _classes, fn) => fn(),
    withLocksAsync: async (_vault, _classes, fn) => fn(),
    acquireLock: () => () => {},
    inspectLocks: () => [],
    LOCK_WARN_AGE_MS: 60_000,
    available: false,
  };
}

const OWNER = 'vault-watcher';

module.exports = { ...impl, OWNER };
