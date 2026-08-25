/**
 * Read a credential Praxis already owns, instead of asking for a second copy.
 *
 * Robert keeps API keys in ONE place — usually `Praxis/.env` — and finds
 * duplicating them into `TheNexus/.env` painful (feedback_reuse_praxis_creds:
 * "Praxis already has X access, use that"). Centralising an ADAPTER in Nexus is
 * worth doing; centralising the SECRET is not, so the value stays where it
 * lives and is read from both sides.
 *
 * Process env always wins — an explicit Nexus-side override must be able to
 * shadow the Praxis file (deployments, tests, key rotation). The file is read
 * lazily and cached briefly so a rotated key is picked up without a restart,
 * and an unreadable file degrades to "not present" rather than throwing: a
 * missing key must read as `missing_key`, never as a 500 on the model-control
 * options payload that every dispatch surface depends on.
 *
 * Only the key NAME is ever logged. Values are returned to the caller and
 * never printed.
 */
const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 60_000;

let cache = null; // { at, values: Map<string,string> }

function praxisEnvPath() {
    const root = process.env.PROJECT_ROOT || path.resolve(__dirname, '../../..');
    return path.join(root, 'Praxis', '.env');
}

/**
 * Minimal dotenv parse — `KEY=value`, `#` comments, optional surrounding
 * quotes. Deliberately not the dotenv package: this reads someone else's file
 * and must never expand, execute, or mutate `process.env` as a side effect.
 */
function parseEnvFile(text) {
    const values = new Map();
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
            (value.startsWith("'") && value.endsWith("'") && value.length > 1)
        ) {
            value = value.slice(1, -1);
        }
        values.set(key, value);
    }
    return values;
}

function loadPraxisEnv(now = Date.now()) {
    if (cache && now - cache.at < CACHE_TTL_MS) return cache.values;
    let values = new Map();
    try {
        values = parseEnvFile(fs.readFileSync(praxisEnvPath(), 'utf8'));
    } catch (_err) {
        // Absent or unreadable is a legitimate state (a Nexus running without a
        // Praxis checkout beside it). Callers treat it as "key not present".
        values = new Map();
    }
    cache = { at: now, values };
    return values;
}

/**
 * Resolve one credential: process env first, then `Praxis/.env`.
 * Returns `null` when neither carries a non-empty value.
 */
function resolveSharedCredential(name) {
    const own = process.env[name];
    if (typeof own === 'string' && own.trim()) return own.trim();
    const shared = loadPraxisEnv().get(name);
    return typeof shared === 'string' && shared.trim() ? shared.trim() : null;
}

/** Where a credential resolved from — for honest "why is this lane live" copy. */
function credentialSource(name) {
    const own = process.env[name];
    if (typeof own === 'string' && own.trim()) return 'env';
    const shared = loadPraxisEnv().get(name);
    return typeof shared === 'string' && shared.trim() ? 'praxis-env' : null;
}

/** Test seam — drop the cached file read. */
function resetPraxisEnvCache() {
    cache = null;
}

module.exports = {
    resolveSharedCredential,
    credentialSource,
    resetPraxisEnvCache,
    praxisEnvPath,
    parseEnvFile,
};
