/**
 * Context windows for The Nexus's model calls (2026-10-31 size cap survey,
 * items 6.13 to 6.15), and one rule for fitting a large text to them.
 *
 * The Nexus does not choose models: callAI relays to Praxis, which resolves a
 * model-control role or a provider/model pin. So the window of the model a
 * call will reach is asked of Praxis, GET /v1/llm/context-window, for the same
 * role or pin callAI will send (resolveCallTarget in ai-service.js). Praxis
 * reads each figure from the model's own source (Codex's models cache, Claude
 * Code run reports, LM Studio's loaded context, OpenRouter's catalog).
 *
 * Anything that goes wrong (a Praxis that has not restarted onto the route
 * answers 404, a timeout, an error, a null window) means "unknown", and an
 * unknown window is never replaced by a guess: the text goes whole and the
 * provider's own refusal is the bound.
 *
 * fitToWindow() mirrors Praxis's llm/context-window.ts: a text stays whole when
 * it fits the share of the window its caller gives it (or the window is
 * unknown). When it does not, the whole text is written under the data
 * directory (data/model-inputs, or NEXUS_MODEL_INPUTS_DIR), the part that fits
 * is sent, and a note says how much was left out and where the whole text is.
 * Each caller states its own share and why.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { praxisFetch } = require('./praxis-client');

/** Praxis caches its own sources for five minutes; a minute here spares a lookup per call. */
const CACHE_MS = 60_000;
/** A clock on the metadata lookup, not on any model input: past it the window is unknown. */
const LOOKUP_TIMEOUT_MS = 5_000;

const cache = new Map();

/** The Praxis query for a call target: its role, else its provider/model pin. */
function windowQuery(target) {
    if (target.role) return `role=${encodeURIComponent(target.role)}`;
    if (!target.provider) return null;
    const model = target.modelId ? `&model=${encodeURIComponent(target.modelId)}` : '';
    return `provider=${encodeURIComponent(target.provider)}${model}`;
}

function normalizeWindow(body) {
    const w = body && body.window;
    const tokens = Number(w && w.tokens);
    const charsPerToken = Number(body && body.charsPerToken);
    // Without Praxis's own characters-per-token figure there is no honest way
    // to turn tokens into a text budget, so the window counts as unknown.
    if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(charsPerToken) || charsPerToken <= 0) return null;
    const out = Number(w.maxOutputTokens);
    return {
        tokens,
        ...(Number.isFinite(out) && out > 0 ? { maxOutputTokens: out } : {}),
        source: typeof w.source === 'string' && w.source ? w.source : 'Praxis',
        charsPerToken,
    };
}

/**
 * The context window of the model a callAI(taskOrConfig, ...) call will reach,
 * or null when it is unknown.
 *
 * @param {string|Object} taskOrConfig - exactly what the caller passes to callAI
 * @param {{ resolveCallTarget?: Function, fetchImpl?: Function, now?: () => number }} [deps]
 * @returns {Promise<{ tokens: number, maxOutputTokens?: number, source: string, charsPerToken: number } | null>}
 */
async function contextWindowFor(taskOrConfig, deps = {}) {
    let target;
    try {
        const resolve = deps.resolveCallTarget || require('./ai-service').resolveCallTarget;
        target = await resolve(taskOrConfig);
    } catch (err) {
        console.warn(`[ContextWindow] could not tell which model this call reaches, so its window is unknown: ${err.message}`);
        return null;
    }
    const query = windowQuery(target || {});
    if (!query) return null;
    const now = deps.now ? deps.now() : Date.now();
    const hit = cache.get(query);
    if (hit && now - hit.at < CACHE_MS) return hit.value;

    let value = null;
    try {
        const res = await praxisFetch(`/v1/llm/context-window?${query}`, {
            headers: { Accept: 'application/json' },
            timeoutMs: LOOKUP_TIMEOUT_MS,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        if (res.ok) {
            value = normalizeWindow(await res.json());
        } else {
            console.warn(`[ContextWindow] Praxis answered ${res.status} for ${query}; the window is unknown, so texts go whole`);
        }
    } catch (err) {
        console.warn(`[ContextWindow] Praxis lookup for ${query} failed (${err.message}); the window is unknown, so texts go whole`);
    }
    cache.set(query, { at: now, value });
    return value;
}

/** Characters a text may take: its share of the window, or null when the window is unknown. */
function budgetChars(window, share) {
    if (!window || !(share > 0)) return null;
    return Math.floor(window.tokens * Math.min(share, 1) * window.charsPerToken);
}

/** Where cut inputs keep their whole text. */
function modelInputsDir() {
    const configured = process.env.NEXUS_MODEL_INPUTS_DIR;
    if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim());
    return path.join(__dirname, '..', '..', 'data', 'model-inputs');
}

/**
 * Keep a whole text on disk under its hash (a retry costs nothing).
 * @returns {{ path: string|null, error?: string }}
 */
function keepWholeText(text, label) {
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    const slug = String(label || 'input').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'input';
    const file = path.join(modelInputsDir(), `${slug}-${hash}.txt`);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, text);
        return { path: file };
    } catch (err) {
        console.warn(`[ContextWindow] could not keep the whole ${label}: ${err.message}`);
        return { path: null, error: err.message };
    }
}

/** The sentence that says where the whole text is, or that it could not be kept. */
function wholeTextWhere(kept) {
    return kept.path ? `the whole text is in ${kept.path}` : `the whole text could not be kept on disk (${kept.error})`;
}

/**
 * The text whole when it fits its share of the window (or the window is
 * unknown); otherwise the part that fits, a note naming what was left out,
 * and the whole text on disk.
 *
 * @param {string} text
 * @param {{ window: object|null|undefined, share: number, label: string }} opts
 *   share: the part of the window (0 to 1) this one text may take, leaving
 *   the rest for the other parts of the prompt and the answer.
 * @returns {{ text: string, whole: boolean, originalChars: number, shownChars: number, fullTextPath?: string|null, note?: string }}
 */
function fitToWindow(text, { window, share, label }) {
    const value = typeof text === 'string' ? text : String(text ?? '');
    const originalChars = value.length;
    const budget = budgetChars(window, share);
    if (budget === null || originalChars <= budget) return { text: value, whole: true, originalChars, shownChars: originalChars };
    const kept = keepWholeText(value, label);
    const note = (shown) =>
        `\n\n[${label}: ${originalChars.toLocaleString('en-US')} characters, too large for this model's context window ` +
        `(${window.tokens.toLocaleString('en-US')} tokens, ${window.source}) alongside the rest of the request. ` +
        `The first ${shown.toLocaleString('en-US')} are above; ${wholeTextWhere(kept)}.]`;
    const shownChars = Math.max(0, budget - note(budget).length);
    console.log(`[ContextWindow] ${label}: ${originalChars} characters cut to ${shownChars} for ${window.source}; ${wholeTextWhere(kept)}`);
    const tail = note(shownChars);
    return { text: value.slice(0, shownChars) + tail, whole: false, originalChars, shownChars, fullTextPath: kept.path, note: tail.trim() };
}

/** Tests: forget cached windows. */
function clearContextWindowCache() {
    cache.clear();
}

module.exports = {
    contextWindowFor,
    fitToWindow,
    budgetChars,
    keepWholeText,
    wholeTextWhere,
    modelInputsDir,
    clearContextWindowCache,
};
