/**
 * The document the signed-in app has open, for chat-directed presenting.
 *
 * The document review page publishes the exact revision it is showing
 * (document id, revision id, content hash, title) while it is mounted; the
 * chat terminal attaches it to every turn it sends as
 * `displayContext.document`. Praxis reads it only on operator-verified turns,
 * so "display this document on the Living Room TV" pins the revision on the
 * operator's screen, byte for byte, and a later "present the latest revision"
 * is validated against the newer revision's own registered hash.
 *
 * Ids and a hash only: never document content, never a URL or credential.
 * localStorage is the carrier because the chat and the review are different
 * routes of the same app; an entry goes stale after a short window and is
 * removed when the review unmounts, so a closed document is not "open".
 */
export const OPEN_DOCUMENT_STORAGE_KEY = 'nexus:open-document';
/** An entry older than this is not offered; the review page refreshes it while mounted. */
export const OPEN_DOCUMENT_TTL_MS = 30 * 60_000;
export const OPEN_DOCUMENT_REFRESH_MS = 5 * 60_000;

export interface OpenDocument { documentId: string; revisionId: string; contentHash: string; title?: string }
interface StoredOpenDocument extends OpenDocument { version: 1; observedAt: string }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const HASH = /^[a-f0-9]{64}$/;

function storage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

function exact(value: unknown): OpenDocument | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.documentId !== 'string' || !ID.test(r.documentId)) return null;
  if (typeof r.revisionId !== 'string' || !ID.test(r.revisionId)) return null;
  if (typeof r.contentHash !== 'string' || !HASH.test(r.contentHash)) return null;
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 160) : '';
  return { documentId: r.documentId, revisionId: r.revisionId, contentHash: r.contentHash, ...(title ? { title } : {}) };
}

/** Publish the revision on screen. Returns false (and stores nothing) for an inexact reference. */
export function rememberOpenDocument(document: OpenDocument, now = Date.now()): boolean {
  const clean = exact(document);
  const store = storage();
  if (!clean || !store) return false;
  const stored: StoredOpenDocument = { version: 1, ...clean, observedAt: new Date(now).toISOString() };
  try { store.setItem(OPEN_DOCUMENT_STORAGE_KEY, JSON.stringify(stored)); return true; } catch { return false; }
}

/** Forget the open document; with an id, only when that document is the one stored. */
export function forgetOpenDocument(documentId?: string): void {
  const store = storage();
  if (!store) return;
  try {
    if (documentId) {
      const raw = store.getItem(OPEN_DOCUMENT_STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw) as { documentId?: unknown }) : null;
      if (stored && stored.documentId !== documentId) return;
    }
    store.removeItem(OPEN_DOCUMENT_STORAGE_KEY);
  } catch { /* nothing to forget */ }
}

/** The document to attach to a chat turn, or null when none is open or the entry is stale or inexact. */
export function currentOpenDocument(now = Date.now()): OpenDocument | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(OPEN_DOCUMENT_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredOpenDocument>;
    if (stored.version !== 1 || typeof stored.observedAt !== 'string') return null;
    const observed = Date.parse(stored.observedAt);
    if (!Number.isFinite(observed) || observed > now + 60_000 || observed + OPEN_DOCUMENT_TTL_MS <= now) return null;
    return exact(stored);
  } catch { return null; }
}
