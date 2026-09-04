const fs = require('fs');
const path = require('path');
const { VAULT } = require('./config');
const { readFileSafe } = require('./fs-utils');
const { readSupersession } = require('./frontmatter');

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

module.exports = {
  INDEX_DIR,
  INDEX_FILE,
  INDEX_ROOT_DOCS,
  collectRootDocs,
  chunkMarkdown,
  buildSearchIndexPayload,
  regenerateSearchIndex,
};
