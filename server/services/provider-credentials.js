/**
 * Key-aware routing: which dispatch routes actually have a live credential.
 *
 * The cockpit used to discover a dead credential the way everything else did —
 * at execution, as a 402/429 that burned a CLI slot and a task's turn. This
 * module makes the same fact knowable BEFORE dispatch, from evidence the Nexus
 * already owns:
 *
 *   1. API-key lanes (anthropic / openai / google / xai) — presence of the
 *      provider's env key. A lane with no key cannot route, full stop.
 *   2. Executor lanes (claude-code / codex / antigravity) — these are
 *      SUBSCRIPTION-authed CLIs, NOT API-key authed (Praxis deliberately
 *      strips ANTHROPIC_API_KEY from the Claude env; see
 *      services/model-control.js providerHasCredentials). There is no key to
 *      test, so their liveness is read from OBSERVED credential failures in
 *      task_dispatches: Praxis stamps a `PRAXIS_USAGE_LIMIT` marker (often
 *      with an exact "Usage limit resets at <ISO>" line and sometimes a
 *      "Model: <id>" scope line) into the failure summary it writes back.
 *
 * Deliberate non-rule: an Anthropic/OpenAI registry model offered in the
 * dispatch console's Model dropdown is NEVER gated on ANTHROPIC_API_KEY /
 * OPENAI_API_KEY. Those models run over the CLI's subscription. Gating them on
 * an API key is the exact 2026-07-10 regression that made every per-task Claude
 * selection resolve "unavailable" and silently fall back to local Gemma.
 *
 * Honesty rules: unreadable evidence is reported as `unknown`, never as ok and
 * never as blocked — a broken reader must not become an invisible dispatch ban.
 */
const { openRaw, resolveNexusDbPath } = require('../../db/raw');
const { resolveSharedCredential } = require('./praxis-env');

const DEFAULT_DB_PATH = resolveNexusDbPath();

/**
 * Executor → the credential it actually spends, and HOW it authenticates.
 *
 * `kind` is the load-bearing field. A `subscription` lane has no key to test,
 * so its liveness can only come from observed failures. An `api_key` lane
 * cannot route AT ALL without its provider key present, so key absence blocks
 * it outright — that is the "route dispatch by present provider keys" rule.
 *
 * Getting `kind` wrong in either direction is expensive: marking a CLI lane
 * `api_key` would ban the default worker on a machine that has no
 * ANTHROPIC_API_KEY (Praxis strips it deliberately — buildClaudeEnv), which is
 * the 2026-07-10 regression all over again; marking an API lane `subscription`
 * would let a keyless route reach the provider and 401 mid-run.
 */
const EXECUTOR_LANES = {
    'claude-code': { provider: 'anthropic', label: 'Claude subscription', kind: 'subscription' },
    codex: { provider: 'openai', label: 'ChatGPT subscription', kind: 'subscription' },
    antigravity: { provider: 'google', label: 'Google subscription', kind: 'subscription' },
    // Praxis's per-token backend (AGENT_BACKENDS in routes/model-control.js
    // labels it "Gemini API (per-token)"). Unlike the three CLIs this one
    // genuinely authenticates with a provider key, so a missing key excludes it
    // before execution instead of at the provider's 401.
    gemini: { provider: 'google', label: 'Gemini API key', kind: 'api_key' },
    // The OpenRouter FREE lane (2026-08-25). Also key-authed, and its key may
    // live in Praxis/.env — API_KEY_LANES.openrouter is marked `shared`, so the
    // lane reads live from there without a duplicate copy in this repo.
    openrouter: { provider: 'openrouter', label: 'OpenRouter (free lane)', kind: 'api_key' },
};

/**
 * API-key lanes — per-token routes that genuinely need an env key present.
 *
 * `shared: true` means the key is allowed to live in `Praxis/.env` rather than
 * this process's environment. Robert keeps credentials in one place
 * (feedback_reuse_praxis_creds), so requiring a second copy in TheNexus/.env
 * would report a live lane as `missing_key` and ban it before dispatch.
 */
const API_KEY_LANES = {
    anthropic: { label: 'Anthropic API', envVars: ['ANTHROPIC_API_KEY'] },
    openai: { label: 'OpenAI API', envVars: ['OPENAI_API_KEY'] },
    google: { label: 'Google AI API', envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
    xai: { label: 'xAI API', envVars: ['XAI_API_KEY'] },
    // The FREE lane (2026-08-25): $0 models the subscription CLIs cannot offer.
    // It is an api_key lane because the key genuinely gates it — unlike the
    // three CLI executors, which are subscription-authed and have no key to test.
    openrouter: { label: 'OpenRouter (free lane)', envVars: ['OPENROUTER_API_KEY'], shared: true },
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Credential failure classes, in priority order. `ttlMs` is how long the class
 * blocks when the provider didn't advertise its own reset time.
 *
 * Note what is NOT here: 5xx (529 Overloaded), exit codes, and timeouts. Those
 * are liveness faults, not credential faults — Praxis's executor-health circuit
 * owns them, and treating them as a dead key would ban a healthy route.
 */
const FAILURE_CLASSES = [
    // Praxis already classified this one; its marker is authoritative and wins
    // over the raw provider prose (a Codex usage-limit blurb also talks credits).
    { code: 'usage_limit', ttlMs: 5 * HOUR_MS, pattern: /PRAXIS_USAGE_LIMIT/ },
    {
        code: 'unauthorized',
        ttlMs: 24 * HOUR_MS,
        pattern: /\b(?:401|403)\b|invalid[_ -]?api[_ -]?key|authentication_error|permission_error|oauth token (?:has )?expired|(?:not|no longer) (?:logged|signed) in|please run [^\n]{0,24}login/i,
    },
    {
        code: 'no_credit',
        ttlMs: 24 * HOUR_MS,
        pattern: /\b402\b|credit balance is too low|requires more credits|insufficient (?:credits|quota|balance|funds)|out of (?:extra )?(?:usage|credits)/i,
    },
    {
        code: 'usage_limit',
        ttlMs: 5 * HOUR_MS,
        pattern: /\b429\b|rate[ _-]?limit(?:ed|s)?\b|usage limit|session limit|weekly limit|quota exceeded|usagelimitexceeded/i,
        // …unless the 429 is OpenRouter's free-lane shared-pool cooldown. See
        // SHARED_POOL_COOLDOWN_RE.
        skipWhen: text => SHARED_POOL_COOLDOWN_RE.test(text),
    },
];

/**
 * OpenRouter's free endpoints ride shared upstream pools and answer a throttled
 * call with HTTP 429 plus its own explanation:
 *
 *   { code: 429, metadata: { limit_source: "upstream_provider_shared_pool",
 *                            retry_after_seconds: 5, provider_name: "Stealth" } }
 *
 * That is a SECONDS-scale cooldown, so it belongs with the exclusions named in
 * this module's header (5xx, exit codes, timeouts) rather than with credential
 * faults: blocking the lane for the usage_limit class's five hours would ban a
 * healthy route over a five-second wait, and Praxis already rotates past it
 * to another vendor's free model (src/llm/openrouter-free.ts).
 *
 * Only the 429 class is suppressed. A row that ALSO carries a real 402 or an
 * auth failure still classifies — those classes are tested first.
 */
const SHARED_POOL_COOLDOWN_RE =
    /upstream_provider_shared_pool|temporarily rate-limited upstream|retry_after_seconds/i;

/** Outcomes that prove the lane routed successfully (credential was live). */
const RECOVERY_OUTCOMES = new Set(['success', 'needs_input']);
/** Outcomes whose text may carry a credential failure. */
const FAILED_OUTCOMES = new Set(['failure', 'timeout']);

/**
 * How much of a failed row's output is credential evidence. Praxis's failure
 * summaries lead with the cause; scanning the whole body would let a run's
 * prose ABOUT rate limits (a walkthrough, a test name) read as a dead key.
 * The PRAXIS_USAGE_LIMIT marker is exempt — it is unambiguous wherever it sits.
 */
const EVIDENCE_HEAD_CHARS = 800;

function credentialEvidenceText(row) {
    const error = typeof row.error === 'string' ? row.error : '';
    const output = typeof row.output === 'string' ? row.output : '';
    const marker = /PRAXIS_USAGE_LIMIT/.test(error) || /PRAXIS_USAGE_LIMIT/.test(output);
    if (marker) return `${error}\n${output}`;
    return `${error.slice(0, EVIDENCE_HEAD_CHARS)}\n${output.slice(0, EVIDENCE_HEAD_CHARS)}`;
}

/** "Usage limit resets at 2026-08-20T09:44:00.000Z." → epoch ms, when present. */
function parseAdvertisedReset(text) {
    const match = /resets? at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(text);
    if (!match) return null;
    const ms = Date.parse(match[1]);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * "Model: gpt-5.6-sol" scopes the block to ONE model (Praxis's per-model
 * cooldown). No Model line means the whole lane is out for the window.
 */
function parseScopedModel(text) {
    const match = /^\s*Model:\s*([^\s]+)\s*$/m.exec(text);
    return match ? match[1] : null;
}

/** Classify a dispatch's failure text as a credential fault, or null. */
function classifyCredentialFailure(text) {
    if (!text || !text.trim()) return null;
    for (const { code, ttlMs, pattern, skipWhen } of FAILURE_CLASSES) {
        if (!pattern.test(text)) continue;
        if (skipWhen && skipWhen(text)) continue;
        const detailLine = text.split('\n').map(l => l.trim()).find(l => l && pattern.test(l)) || null;
        return {
            code,
            ttlMs,
            detail: detailLine ? detailLine.replace(/^⛔\s*/, '').slice(0, 240) : null,
            resetAt: parseAdvertisedReset(text),
            model: parseScopedModel(text),
        };
    }
    return null;
}

function rowTime(row) {
    const value = row.completed_at || row.started_at;
    const ms = value ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : 0;
}

function humanUntil(untilMs) {
    if (!untilMs) return null;
    return new Date(untilMs).toISOString();
}

/**
 * Fold dispatch history into per-executor credential blocks.
 *
 * Rows may arrive in any order; they are sorted oldest-first so a later success
 * clears an earlier block. A lane-wide success clears the lane-wide block and
 * (when the row names one) that model's block — a success is direct proof the
 * credential spent.
 *
 * Pure: no DB, no clock of its own. `now` is injected so this is testable.
 */
function assessExecutorLanes(rows, now = Date.now(), providerLanes = assessApiKeyLanes()) {
    const blocks = new Map(); // `${executor}::${model|*}` → block
    const ordered = [...(rows || [])].sort((a, b) => rowTime(a) - rowTime(b));

    for (const row of ordered) {
        const executor = typeof row.executor === 'string' ? row.executor.trim() : '';
        if (!executor || !EXECUTOR_LANES[executor]) continue;

        if (RECOVERY_OUTCOMES.has(row.outcome)) {
            blocks.delete(`${executor}::*`);
            if (row.model) blocks.delete(`${executor}::${row.model}`);
            continue;
        }
        if (!FAILED_OUTCOMES.has(row.outcome)) continue;

        const hit = classifyCredentialFailure(credentialEvidenceText(row));
        if (!hit) continue;
        const at = rowTime(row);
        const until = hit.resetAt || at + hit.ttlMs;
        const scope = hit.model || '*';
        blocks.set(`${executor}::${scope}`, {
            executor,
            model: hit.model,
            code: hit.code,
            detail: hit.detail,
            observedAt: new Date(at).toISOString(),
            until: humanUntil(until),
            untilMs: until,
        });
    }

    const lanes = Object.entries(EXECUTOR_LANES).map(([name, lane]) => {
        // An api_key lane starts from its key: no key present, no route. This
        // is checked BEFORE dispatch history, because a missing key is a
        // certainty while observed failures are inference.
        const key = lane.kind === 'api_key' ? providerLaneFor(providerLanes, lane.provider) : null;
        const keyMissing = key && key.status === 'missing_key';
        return {
            name,
            provider: lane.provider,
            credential: lane.label,
            kind: lane.kind,
            requiresApiKey: lane.kind === 'api_key',
            keyVar: key ? key.keyVar : null,
            status: keyMissing ? 'blocked' : 'ok',
            code: keyMissing ? 'missing_key' : null,
            reason: keyMissing ? `${lane.label} cannot route — ${key.reason}` : null,
            until: null,
            observedAt: null,
            blockedModels: [],
        };
    });
    const byName = new Map(lanes.map(l => [l.name, l]));

    for (const block of blocks.values()) {
        if (block.untilMs <= now) continue; // window already reset — route is live again
        const lane = byName.get(block.executor);
        if (!lane) continue;
        const summary = {
            code: block.code,
            reason: describeBlock(lane, block),
            until: block.until,
            observedAt: block.observedAt,
        };
        if (block.model) {
            lane.blockedModels.push({ model: block.model, ...summary });
        } else if (lane.code !== 'missing_key') {
            // A missing key is a certainty and outranks an inferred fault —
            // don't let a stale usage-limit row relabel "there is no key".
            lane.status = 'blocked';
            Object.assign(lane, summary);
        }
    }
    return lanes;
}

function describeBlock(lane, block) {
    const what = block.model ? `${lane.credential} · ${block.model}` : lane.credential;
    const when = block.until ? ` until ${block.until}` : '';
    const why = {
        usage_limit: 'is out of usage',
        no_credit: 'is out of credit',
        unauthorized: 'was rejected (credential invalid or expired)',
    }[block.code] || 'is unavailable';
    const detail = block.detail ? ` — ${block.detail}` : '';
    return `${what} ${why}${when}${detail}`;
}

/** One provider's API-key lane out of an assessed list. */
function providerLaneFor(providerLanes, provider) {
    return (providerLanes || []).find(lane => lane.provider === provider) || null;
}

/** API-key lanes: present env key or not. Nothing to infer, nothing to guess. */
function assessApiKeyLanes(env = process.env, opts = {}) {
    // Injectable so a test can assert the missing-key path without depending on
    // whether a Praxis checkout happens to sit beside this one.
    const resolveShared = opts.resolveShared || resolveSharedCredential;
    return Object.entries(API_KEY_LANES).map(([provider, lane]) => {
        const present = lane.envVars.filter(name => {
            const value = env[name];
            if (typeof value === 'string' && value.trim().length > 0) return true;
            return lane.shared ? !!resolveShared(name) : false;
        });
        const where = lane.shared ? 'the API environment or Praxis/.env' : 'the API environment';
        return {
            provider,
            credential: lane.label,
            kind: 'api_key',
            envVars: lane.envVars,
            keyVar: present[0] || null,
            status: present.length ? 'ok' : 'missing_key',
            reason: present.length ? null : `No ${lane.envVars.join(' / ')} in ${where}`,
        };
    });
}

// ── DB-backed state ───────────────────────────────────────────────────────

// Only rows this recent can block: an unauthorized fault ages out after 24h
// even with no successful run since, so a lane can never be banned forever by
// one stale row. Bounded so the read stays a millisecond-scale index scan.
const EVIDENCE_WINDOW_HOURS = 48;
const EVIDENCE_ROW_LIMIT = 400;
// Dispatch rows carry whole transcripts (64k chars each). Only failed rows have
// credential evidence, and the cause always leads the failure summary — so the
// read pulls a bounded head of those two columns instead of megabytes of
// walkthroughs on every poll.
const EVIDENCE_TEXT_CHARS = 4_000;
// The console polls; the evidence changes at dispatch speed. 10s is fresh
// enough to catch a limit the moment Praxis writes it, cheap enough to poll.
const CACHE_TTL_MS = 10_000;

// A failed open is remembered only briefly: a board DB that was missing at boot
// (restore in progress, wrong path fixed since) must be able to come back
// without a server restart.
const OPEN_RETRY_MS = 60_000;

let handle = null;
let handlePath = null;
let openFailure = null; // { path, at } — backoff is per-path, never global
let cache = null;

function openDb(dbPath) {
    if (handle && handlePath === dbPath) return handle;
    if (handle) { try { handle.close(); } catch (_err) { /* already closed */ } handle = null; }
    if (openFailure && openFailure.path === dbPath && Date.now() - openFailure.at < OPEN_RETRY_MS) {
        return null;
    }
    try {
        // Raw connection via db/raw.js — the injected db facade has no raw
        // SQL. `fileMustExist` so a wrong path degrades to "unknown" instead
        // of quietly creating an empty board DB. Not opened readonly: a
        // read-only handle can't set journal_mode, and this file is WAL.
        // `cache: false` — this module owns the handle lifecycle (close on
        // path change, per-path open backoff, resetRoutingCache test seam).
        handle = openRaw(dbPath, { fileMustExist: true, cache: false });
        handlePath = dbPath;
        openFailure = null;
    } catch (err) {
        handle = null;
        handlePath = null;
        openFailure = { path: dbPath, at: Date.now() };
        console.warn(`[Provider Credentials] dispatch evidence unavailable (${err.message}) — executor lanes report unknown`);
    }
    return handle;
}

function readEvidenceRows(dbPath, now) {
    const db = openDb(dbPath);
    if (!db) return null;
    const since = new Date(now - EVIDENCE_WINDOW_HOURS * HOUR_MS).toISOString();
    try {
        return db.prepare(`
            SELECT executor, model, outcome, started_at, completed_at,
                   CASE WHEN outcome IN ('failure', 'timeout') THEN substr(error, 1, @chars) END AS error,
                   CASE WHEN outcome IN ('failure', 'timeout') THEN substr(output, 1, @chars) END AS output
            FROM task_dispatches
            WHERE started_at >= @since
            ORDER BY started_at DESC
            LIMIT @limit
        `).all({ since, chars: EVIDENCE_TEXT_CHARS, limit: EVIDENCE_ROW_LIMIT });
    } catch (err) {
        console.warn('[Provider Credentials] evidence read failed:', err.message);
        return null;
    }
}

/**
 * The whole key-aware routing picture: which executor lanes and which API-key
 * lanes can actually route right now. Never throws — an unreadable evidence
 * store degrades every executor lane to `unknown`, which the callers treat as
 * "allow, but say we don't know".
 */
function getRoutingState({ dbPath = DEFAULT_DB_PATH, now = Date.now(), env = process.env, refresh = false } = {}) {
    if (!refresh && cache && cache.expiresAt > now && cache.dbPath === dbPath) return cache.state;

    const rows = readEvidenceRows(dbPath, now);
    const providers = assessApiKeyLanes(env);
    // Key presence does not depend on dispatch history, so an unreadable board
    // still yields a definite answer for api_key lanes — only the evidence-based
    // subscription lanes fall back to `unknown`.
    const executors = rows
        ? assessExecutorLanes(rows, now, providers)
        : assessExecutorLanes([], now, providers).map(lane => (
            // An api_key lane's verdict comes from key PRESENCE, which needs no
            // history — so it survives an unreadable board whatever it says,
            // `ok` included. Until 2026-08-25 only `blocked` was preserved, and
            // that passed for as long as the sole api_key executor (gemini) had
            // no key present in any environment that exercised this path. The
            // OpenRouter lane, whose key resolves from Praxis/.env, is the first
            // one to read `ok` here and it was being degraded to `unknown`
            // against this block's own stated rule.
            lane.kind === 'api_key' || lane.status === 'blocked'
                ? lane
                : {
                    ...lane,
                    status: 'unknown',
                    reason: 'Dispatch history is unreadable — credential state unknown, not verified',
                }
        ));

    const state = {
        checkedAt: new Date(now).toISOString(),
        executors,
        providers,
        evidence: {
            source: 'task_dispatches',
            available: !!rows,
            windowHours: EVIDENCE_WINDOW_HOURS,
            rowsScanned: rows ? rows.length : 0,
        },
    };
    cache = { state, expiresAt: now + CACHE_TTL_MS, dbPath };
    return state;
}

/**
 * Which API-key lane a route must have present in order to run at all.
 *
 * An explicit `provider` (a per-token model route) always requires its key. An
 * executor requires one only when its lane authenticates that way — the three
 * subscription CLIs return null here, and MUST, or the gate would ban the
 * default worker on a machine that legitimately holds no API keys.
 */
function requiredKeyLane(routing, { executor, provider }) {
    const providers = routing.providers || [];
    if (provider) return providerLaneFor(providers, normalizeProviderName(provider));
    const lane = (routing.executors || []).find(e => e.name === executor);
    if (!lane || lane.kind !== 'api_key') return null;
    return providerLaneFor(providers, lane.provider);
}

function normalizeProviderName(provider) {
    const value = String(provider || '').toLowerCase().trim();
    if (value === 'gemini') return 'google';
    if (value === 'claude') return 'anthropic';
    if (value === 'grok') return 'xai';
    return value;
}

/**
 * The gate itself: may this executor+model+provider dispatch spend a credential?
 *
 * Two independent reasons to refuse, checked in order of certainty:
 *   1. `missing_key` — the route authenticates with a provider key and there
 *      is no key. This is a fact, not an inference, so it is checked first.
 *   2. An observed credential fault on the lane or on that specific model.
 *
 * `allowed:false` is only ever returned on one of those; unknown state allows.
 */
function checkDispatchRoute({ executor, model, provider, state }) {
    const routing = state || getRoutingState();
    const keyLane = requiredKeyLane(routing, { executor, provider });
    if (keyLane && keyLane.status === 'missing_key') {
        return {
            allowed: false,
            code: 'missing_key',
            reason: `${keyLane.credential} has no key present — ${keyLane.reason}`,
            until: null,
            scope: 'provider',
        };
    }
    const lane = (routing.executors || []).find(e => e.name === executor);
    if (!lane) return { allowed: true, code: null, reason: null, until: null };
    if (lane.status === 'blocked') {
        return { allowed: false, code: lane.code, reason: lane.reason, until: lane.until, scope: 'executor' };
    }
    const blockedModel = model ? lane.blockedModels.find(m => m.model === model) : null;
    if (blockedModel) {
        return { allowed: false, code: blockedModel.code, reason: blockedModel.reason, until: blockedModel.until, scope: 'model' };
    }
    return { allowed: true, code: null, reason: null, until: null };
}

/** Test seam — drops the cached state and the DB handle. */
function resetRoutingCache() {
    cache = null;
    if (handle) { try { handle.close(); } catch (_err) { /* already closed */ } }
    handle = null;
    handlePath = null;
    openFailure = null;
}

module.exports = {
    classifyCredentialFailure,
    isSharedPoolCooldown: text => SHARED_POOL_COOLDOWN_RE.test(String(text || '')),
    assessExecutorLanes,
    assessApiKeyLanes,
    getRoutingState,
    checkDispatchRoute,
    resetRoutingCache,
};
