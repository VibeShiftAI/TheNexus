/**
 * Raw better-sqlite3 connections for route/service code that needs SQL the
 * facade in db/index.js does not expose (the facade deliberately hides its
 * handle — see CLAUDE.md: never call db.exec / db.prepare on the facade).
 *
 * This is the ONE place that resolves the board DB path and opens raw
 * handles, so every module opening its own connection agrees on the file,
 * the WAL setting, and the readonly semantics:
 *
 *   openRaw(dbPath)                          — writer, WAL (dispatches, studio)
 *   openRaw(dbPath, { readonly: true })      — reader; never sets WAL, the
 *                                              writers own the journal mode
 *                                              (project-pulse, Praxis spine)
 *   openRaw(dbPath, { fileMustExist: true }) — refuse to create an empty DB
 *                                              on a wrong path
 *
 * Handles are cached per (resolved path, readonly, fileMustExist) so several
 * routers pointed at the same file share one connection instead of each
 * holding its own; pass `cache: false` for a caller that manages its own
 * handle lifecycle (close/backoff), e.g. provider-credentials.
 *
 * Errors propagate: each call site already has its own fail-soft handling
 * (503 route, "unknown" lane, "spine unavailable") and the messages differ.
 */
const Database = require('better-sqlite3');
const path = require('path');

/** NEXUS_DB_PATH or ../nexus.db — identical resolution to db/index.js. */
function resolveNexusDbPath() {
    return process.env.NEXUS_DB_PATH || path.resolve(__dirname, '../nexus.db');
}

const handles = new Map();

function cacheKey(resolved, readonly, fileMustExist) {
    return `${resolved}|ro=${readonly ? 1 : 0}|fme=${fileMustExist ? 1 : 0}`;
}

function openRaw(dbPath, { readonly = false, fileMustExist = false, cache = true } = {}) {
    if (!dbPath) throw new Error('openRaw: dbPath is required');
    const resolved = path.resolve(dbPath);
    const key = cacheKey(resolved, readonly, fileMustExist);
    if (cache) {
        const existing = handles.get(key);
        if (existing && existing.open) return existing;
        if (existing) handles.delete(key);
    }
    const handle = new Database(resolved, { readonly, fileMustExist });
    if (!readonly) {
        // A readonly handle cannot change the journal mode and does not need
        // to — it simply follows whatever the writers set.
        handle.pragma('journal_mode = WAL');
    }
    if (cache) handles.set(key, handle);
    return handle;
}

/** Close and forget a cached handle (test seams / shutdown). No-op if absent. */
function closeRaw(dbPath, { readonly = false, fileMustExist = false } = {}) {
    const key = cacheKey(path.resolve(dbPath), readonly, fileMustExist);
    const handle = handles.get(key);
    if (!handle) return;
    handles.delete(key);
    try { handle.close(); } catch (_err) { /* already closed */ }
}

module.exports = { resolveNexusDbPath, openRaw, closeRaw };
