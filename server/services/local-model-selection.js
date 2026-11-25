'use strict';
/**
 * The local model, chosen under Model Control (task fa032fc0).
 *
 * One setting decides which LM Studio model every consumer calls:
 *
 *  - The model in effect is the global `local_default` alias: `model:<row>`
 *    of a provider-local row whose api_model_id is the LM Studio key. Roles
 *    resolve through it (services/model-control.js marks them
 *    followsLocalModel), Praxis reads it (GET /api/model-control/local-model/current),
 *    the Studio jobs here read it (localModelForWork) and TheCortex reads it.
 *  - Robert's latest choice is the `local_model_selection` setting. While it
 *    is waiting, it names another model than the one in effect.
 *
 * Choosing writes the selection and a row in local_model_switches, loads
 * nothing, and asks Praxis to read the setting again (Praxis POST
 * /local-model/sync). Praxis applies a waiting switch only when no local work
 * runs there, through POST /api/model-control/local-model/apply, the one place
 * `local_default` changes: it refuses a choice that is no longer the latest
 * (409 superseded) and refuses while a Studio local job here runs (409 busy).
 * When the last such job ends, Praxis is asked again.
 *
 * The options come from LM Studio's own listing (GET /api/v1/models, which
 * loads nothing): its chat models, each with the context its saved load
 * profile sets. A model without a saved context cannot be chosen, and
 * embedding models are not offered.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const LOCAL_ALIAS = 'local_default';
const SELECTION_KEY = 'local_model_selection';
/** The description the seed gives the alias (db/index.js); it names no model, so it stays true after a switch. */
const LOCAL_ALIAS_DESCRIPTION = 'Local model (LM Studio) for bulk and background roles';
/** Praxis reads LM Studio's model list with the same 3 s clock (Praxis src/llm/context-window.ts, localWindows). */
const LISTING_TIMEOUT_MS = 3_000;
/** Each read of Praxis: the 4 s Praxis gives each of its own requests for this setting (Praxis src/llm/local-model-selection.ts, NEXUS_TIMEOUT_MS). */
const PRAXIS_TIMEOUT_MS = 4_000;
/**
 * Praxis answers a sync after reading the setting and, when nothing local runs,
 * recording the switch, then reading it back if that answer was lost: up to
 * three of those requests.
 */
const PRAXIS_SYNC_TIMEOUT_MS = 3 * PRAXIS_TIMEOUT_MS;
/** Praxis reads the setting on its own this often (Praxis src/llm/local-model-selection.ts, LOCAL_MODEL_RESYNC_MS). */
const PRAXIS_RESYNC_S = 60;
/** Where a choice came from. Anything else is recorded as "api". */
const SURFACES = new Set(['model-control', 'alias-editor', 'api']);
const EVENT = 'model-control:local-model';

function nonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** An LM Studio key without a trailing `@variant`, lower-cased: Praxis's rule (src/llm/local-model-capabilities.ts, localModelKey). */
function localKey(model) {
    return String(model || '').trim().toLowerCase().replace(/@[^/]*$/, '');
}

function sameModel(a, b) {
    return !!a && !!b && localKey(a) === localKey(b);
}

function surfaceOf(value) {
    return SURFACES.has(value) ? value : 'api';
}

/**
 * The context LM Studio's saved load profile sets for a model, or null when it
 * has no readable profile or the profile sets none. The same rule as Praxis
 * (src/llm/context-window.ts, savedLoadContext): profiles are stored per model
 * key, so a `key@variant` name reads its key's file.
 */
function readSavedLoadContext(home, model) {
    if (!home || !model) return null;
    const root = path.join(home, '.internal', 'user-concrete-model-default-config');
    const file = path.resolve(root, `${String(model).split('@')[0]}.json`);
    if (!file.startsWith(`${root}${path.sep}`)) return null;
    try {
        const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
        const fields = Array.isArray(profile?.load?.fields) ? profile.load.fields : [];
        const value = fields.find(f => f && f.key === 'llm.load.contextLength')?.value;
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

function gigabytes(bytes) {
    return `${Math.round(bytes / 2 ** 30)} GB`;
}

/** What is missing when a chat model has no saved load context, and how to supply it. */
function noSavedContextReason(row, memoryBytes) {
    const max = Number(row.max_context_length);
    const memory = Number(memoryBytes) > 0 ? gigabytes(Number(memoryBytes)) : null;
    const maximum = Number.isFinite(max) && max > 0
        ? ` Its maximum is ${max.toLocaleString('en-US')} tokens, which can need more memory than ${memory ? `this machine's ${memory}` : 'this machine has'}.`
        : '';
    return `No saved load context in LM Studio, so the context it would load with is not set.${maximum} ` +
        "Save a context length for it in LM Studio's load settings to make it selectable.";
}

function listingLabel(row) {
    return nonEmpty(row.display_name) || nonEmpty(row.key);
}

function loadedContext(row) {
    const instances = Array.isArray(row.loaded_instances) ? row.loaded_instances : [];
    const lengths = instances.map(i => Number(i?.config?.context_length)).filter(n => Number.isFinite(n) && n > 0);
    return lengths.length ? lengths[0] : null;
}

/**
 * The choices the panel offers, from LM Studio's listing rows. Chat models
 * (type "llm") are options; every other row goes to `hidden` with the reason,
 * so nothing in the listing is left out without a word.
 *
 * @param {object} input
 * @param {object[]} input.listing - LM Studio GET /api/v1/models `models`
 * @param {(key: string) => number|null} input.savedContextFor
 * @param {string[]|null} input.tested - keys Praxis has tested handling for; null when Praxis could not be asked
 * @param {string|null} [input.active] - the model in effect
 * @param {string|null} [input.waiting] - the model a waiting switch names
 * @param {number} [input.memoryBytes]
 */
function buildLocalModelOptions({ listing, savedContextFor, tested, active = null, waiting = null, memoryBytes = 0 }) {
    const testedKeys = Array.isArray(tested) ? new Set(tested.map(localKey)) : null;
    const options = [];
    const hidden = [];
    for (const row of Array.isArray(listing) ? listing : []) {
        if (!row || typeof row !== 'object') continue;
        const key = nonEmpty(row.key);
        if (!key) {
            hidden.push({ key: null, label: listingLabel(row) || 'A listing row', type: nonEmpty(row.type), reason: 'LM Studio listed it without a model key.' });
            continue;
        }
        const label = listingLabel(row);
        if (row.type !== 'llm') {
            hidden.push({
                key,
                label,
                type: nonEmpty(row.type),
                reason: row.type === 'embedding'
                    ? 'Embedding model: it makes embeddings, not chat replies.'
                    : `LM Studio lists it as ${nonEmpty(row.type) ? `type "${row.type}"` : 'no type'}, not as a chat model.`,
            });
            continue;
        }
        const savedContext = savedContextFor(key);
        const size = Number(row.size_bytes);
        const max = Number(row.max_context_length);
        options.push({
            key,
            label,
            publisher: nonEmpty(row.publisher),
            sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
            params: nonEmpty(row.params_string),
            quantization: nonEmpty(row.quantization?.name),
            format: nonEmpty(row.format),
            maxContext: Number.isFinite(max) && max > 0 ? max : null,
            savedContext,
            loaded: loadedContext(row) !== null,
            loadedContext: loadedContext(row),
            handling: testedKeys === null ? 'unknown' : testedKeys.has(localKey(key)) ? 'tested' : 'conservative',
            selectable: savedContext !== null,
            unavailableReason: savedContext !== null ? null : noSavedContextReason(row, memoryBytes),
            active: sameModel(key, active),
            waiting: sameModel(key, waiting),
        });
    }
    return { options, hidden };
}

function failure(status, error, message, extra = {}) {
    return { ok: false, status, body: { error, message, ...extra } };
}

/**
 * @param {object} deps
 * @param {object} deps.db - the db facade
 * @param {object} [deps.io] - Socket.IO server; the panel refreshes on EVENT
 * @param {Function} [deps.praxisFetch] - services/praxis-client praxisFetch
 * @param {Function} [deps.fetchImpl] - fetch for the LM Studio listing
 * @param {object} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => number} [deps.totalMemBytes]
 * @param {() => string} [deps.homedir]
 * @param {{ warn: Function, info?: Function }} [deps.logger]
 */
function createLocalModelSelection({
    db,
    io = null,
    praxisFetch = null,
    fetchImpl = null,
    env = process.env,
    now = () => new Date(),
    totalMemBytes = () => os.totalmem(),
    homedir = () => os.homedir(),
    logger = console,
} = {}) {
    if (!db) throw new Error('createLocalModelSelection needs the db facade');
    const callPraxis = praxisFetch || require('./praxis-client').praxisFetch;
    /** Studio local work running now, by id. */
    const work = new Map();
    const workScope = new AsyncLocalStorage();
    let lockTail = Promise.resolve();
    let studioFallbackReported = null;

    const nowIso = () => now().toISOString();

    /** Choices, applies and the start of Studio local work take turns: each runs after every earlier one. */
    function withLock(fn) {
        const run = lockTail.then(fn, fn);
        lockTail = run.then(() => undefined, () => undefined);
        return run;
    }

    function emit(reason) {
        try {
            io?.emit?.(EVENT, { reason, at: nowIso() });
        } catch {
            /* a refresh hint for open panels, never a reason to fail */
        }
    }

    /** LM Studio's server: LMSTUDIO_API_URL, else LOCAL_LLM_URL without /v1, else the address Praxis's LOCAL_LLM_URL names. */
    function lmStudioBaseUrl() {
        const explicit = nonEmpty(env.LMSTUDIO_API_URL);
        if (explicit) return explicit.replace(/\/+$/, '');
        const local = nonEmpty(env.LOCAL_LLM_URL);
        if (local) return local.replace(/\/+$/, '').replace(/\/v1$/, '');
        return 'http://127.0.0.1:1234';
    }

    /** LM Studio's home, where its saved load profiles are: LMSTUDIO_HOME, else ~/.lmstudio as Praxis reads it. */
    function lmStudioHome() {
        return nonEmpty(env.LMSTUDIO_HOME) || path.join(homedir(), '.lmstudio');
    }

    /** LM Studio's list of downloaded models. GET /api/v1/models loads nothing. */
    async function readListing() {
        const url = `${lmStudioBaseUrl()}/api/v1/models`;
        try {
            const doFetch = fetchImpl || fetch;
            const res = await doFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(LISTING_TIMEOUT_MS) });
            if (!res.ok) return { ok: false, url, error: `LM Studio answered ${res.status}`, models: [] };
            const body = await res.json();
            if (!Array.isArray(body?.models)) return { ok: false, url, error: 'LM Studio answered without a list of models', models: [] };
            return { ok: true, url, models: body.models };
        } catch (err) {
            return { ok: false, url, error: err?.message || String(err), models: [] };
        }
    }

    async function readSelection() {
        const value = await db.getModelControlSetting(SELECTION_KEY);
        return value && typeof value === 'object' && nonEmpty(value.selectionId) && nonEmpty(value.model) ? value : null;
    }

    function waitingSelection(selection) {
        return selection && selection.status === 'waiting' ? selection : null;
    }

    /** The model in effect: the row the global local_default alias names, when it is an active local row. */
    async function activeLocalModel() {
        const aliases = (await db.getModelAliases(true)) || [];
        const alias = aliases.find(a => a.alias === LOCAL_ALIAS);
        const target = nonEmpty(alias?.target);
        if (!target || !target.startsWith('model:')) return null;
        const row = await db.getModel(target.slice('model:'.length));
        if (!row || String(row.provider || '').toLowerCase() !== 'local' || !nonEmpty(row.api_model_id)) return null;
        if (row.is_active === false || row.is_active === 0) return null;
        return { model: row.api_model_id, label: row.display_name || row.name || row.api_model_id, rowId: row.id };
    }

    /** The local models row for an LM Studio key, an active one first, else null. Reads only. */
    async function findLocalModelRow(key, rows) {
        const all = rows || (await db.getModels(false)) || [];
        const matches = all.filter(r => String(r.provider || '').toLowerCase() === 'local' && sameModel(r.api_model_id, key));
        return matches.find(r => r.is_active === true || r.is_active === 1) || matches[0] || null;
    }

    /** The name a new local row shows: LM Studio's name for the model, marked local. */
    function localRowLabel(label, key) {
        return `${label || key} (local)`;
    }

    /**
     * The models row for an LM Studio key: an existing local row (made active
     * again if it was not), else a new one. Only apply calls this, so choosing
     * changes no row; a choice replaced before it took effect leaves none behind.
     */
    async function ensureLocalModelRow({ key, label, reasoning = false }) {
        const rows = (await db.getModels(false)) || [];
        const existing = await findLocalModelRow(key, rows);
        if (existing) {
            if (existing.is_active === true || existing.is_active === 1) return existing;
            return db.upsertModel({ id: existing.id, name: existing.name, provider: existing.provider, is_active: 1, created_at: existing.created_at });
        }
        const taken = new Set(rows.map(r => r.id));
        const base = `local-${String(key).split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model'}`;
        let id = base;
        for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
        const at = nowIso();
        return db.upsertModel({
            id,
            name: label || key,
            provider: 'local',
            api_model_id: key,
            display_name: localRowLabel(label, key),
            is_active: 1,
            capabilities: { chat: true, local: true, ...(reasoning ? { reasoning: true } : {}) },
            parameters: {},
            default_parameters: {},
            availability_status: 'available',
            discovered_at: at,
            last_seen_at: at,
        });
    }

    async function setLocalDefault(rowId) {
        const aliases = (await db.getModelAliases(false)) || [];
        const existing = aliases.find(a => a.alias === LOCAL_ALIAS);
        return db.upsertModelAlias({
            alias: LOCAL_ALIAS,
            target: `model:${rowId}`,
            description: LOCAL_ALIAS_DESCRIPTION,
            is_active: 1,
            created_at: existing?.created_at,
        });
    }

    async function waitingSwitchRow(selectionId) {
        const rows = await db.getLocalModelSwitches();
        return rows.find(r => r.status === 'waiting' && (!selectionId || r.selection_id === selectionId)) || null;
    }

    /** Mark every switch still waiting as replaced by a newer choice. */
    async function replaceWaitingSwitches(at) {
        const rows = await db.getLocalModelSwitches();
        for (const row of rows.filter(r => r.status === 'waiting')) {
            await db.updateLocalModelSwitch(row.id, { status: 'replaced', replaced_at: at });
        }
    }

    function studioWork() {
        return [...work.values()].map(item => ({ ...item }));
    }

    async function askPraxis(pathname, options) {
        try {
            const res = await callPraxis(pathname, options);
            const body = await res.json().catch(() => null);
            if (!res.ok) return { ok: false, status: res.status, error: `Praxis answered ${res.status}`, body };
            return { ok: true, status: res.status, body };
        } catch (err) {
            return { ok: false, status: null, error: err?.message || String(err) };
        }
    }

    /**
     * Ask Praxis to read the setting again, so a waiting switch applies as soon
     * as nothing local runs there. Never throws; the answer says whether Praxis
     * heard it.
     */
    async function pushSync(reason) {
        const outcome = await askPraxis('/local-model/sync', {
            method: 'POST',
            body: { reason },
            headers: { Accept: 'application/json' },
            timeoutMs: PRAXIS_SYNC_TIMEOUT_MS,
        });
        if (!outcome.ok) {
            logger.warn(`[LocalModel] Praxis was not told to read the local model setting (${reason}: ${outcome.error}); it reads it on its own within ${PRAXIS_RESYNC_S} s, and at its start-up.`);
        }
        emit(`praxis-${outcome.ok ? 'told' : 'not-told'}`);
        return outcome.ok ? { ok: true, praxis: outcome.body } : { ok: false, error: outcome.error };
    }

    async function praxisSnapshot() {
        const outcome = await askPraxis('/local-model', { headers: { Accept: 'application/json' }, timeoutMs: PRAXIS_TIMEOUT_MS });
        if (!outcome.ok || !outcome.body || typeof outcome.body !== 'object') {
            return { reachable: false, error: outcome.error || 'Praxis answered without a body' };
        }
        return { reachable: true, ...outcome.body };
    }

    /**
     * Record a choice of local model. Validates it against LM Studio's listing
     * (a chat model with a saved load context), records the switch, and asks
     * Praxis to apply it when nothing local runs. Loads nothing.
     *
     * @returns {Promise<{ ok: boolean, status: number, body: object }>}
     */
    async function select({ model, surface, action = 'choose', expectSelectionId } = {}) {
        const key = nonEmpty(model);
        if (!key) return failure(400, 'model_required', 'Name the LM Studio model to use.');
        const from = surfaceOf(surface);
        const outcome = await withLock(async () => {
            const active = await activeLocalModel();
            const selection = await readSelection();
            if (expectSelectionId !== undefined && (selection?.selectionId || null) !== (expectSelectionId || null)) {
                return failure(409, 'superseded', 'Another choice was made since this panel was loaded; nothing changed.', { selectionId: selection?.selectionId || null });
            }
            const waiting = waitingSelection(selection);
            const backToActive = sameModel(key, active?.model);
            if (backToActive && !waiting) return { ok: true, status: 200, body: { result: 'unchanged', model: active.model } };
            if (waiting && sameModel(key, waiting.model)) return { ok: true, status: 200, body: { result: 'unchanged', model: waiting.model, selectionId: waiting.selectionId } };

            let target;
            if (backToActive) {
                target = { key: active.model, label: active.label, rowId: active.rowId };
            } else {
                const listing = await readListing();
                if (!listing.ok) return failure(503, 'listing_unavailable', `LM Studio's list of models could not be read (${listing.error}), so nothing changed.`);
                const row = listing.models.find(r => r && sameModel(r.key, key));
                if (!row) return failure(404, 'not_downloaded', `${key} is not in LM Studio's list of downloaded models.`);
                const label = listingLabel(row);
                if (row.type !== 'llm') return failure(422, 'not_a_chat_model', `${label} is not a chat model (LM Studio lists it as ${nonEmpty(row.type) || 'no type'}).`);
                const savedContext = readSavedLoadContext(lmStudioHome(), row.key);
                if (savedContext === null) return failure(422, 'no_saved_context', `${label}: ${noSavedContextReason(row, totalMemBytes())}`, { model: row.key });
                // Read only: apply makes or reactivates the row when the switch takes effect.
                const known = await findLocalModelRow(row.key);
                target = {
                    key: row.key,
                    label: known ? known.display_name || known.name || label : localRowLabel(label, row.key),
                    rowId: known?.id || null,
                    savedContext,
                    row: { label, reasoning: !!row.capabilities?.reasoning },
                };
            }

            const at = nowIso();
            const selectionId = randomUUID();
            // What the choice replaces: a waiting choice that never took effect, else the model in effect.
            const previous = waiting ? { model: waiting.model, label: waiting.label || waiting.model } : active ? { model: active.model, label: active.label } : null;
            await replaceWaitingSwitches(at);
            await db.recordLocalModelSwitch({
                id: randomUUID(),
                selection_id: selectionId,
                action,
                from_model: previous?.model || null,
                from_label: previous?.label || null,
                to_model: target.key,
                to_label: target.label,
                surface: from,
                requested_at: at,
                status: backToActive ? 'applied' : 'waiting',
                applied_at: backToActive ? at : null,
                details: backToActive
                    ? { note: `${target.label} was still in effect, so the waiting switch to ${previous?.label || previous?.model} was dropped and nothing changed for local calls.` }
                    : { savedContext: target.savedContext },
            });
            await db.setModelControlSetting(SELECTION_KEY, {
                selectionId,
                model: target.key,
                modelId: target.rowId,
                label: target.label,
                action,
                surface: from,
                requestedAt: at,
                status: backToActive ? 'applied' : 'waiting',
                ...(backToActive ? { appliedAt: at } : {}),
                // What apply needs to make the models row if there is none by then.
                ...(target.row ? { row: target.row } : {}),
                previous,
            });
            return { ok: true, status: 200, body: { result: backToActive ? 'applied' : 'waiting', model: target.key, selectionId } };
        });
        if (!outcome.ok || outcome.body.result === 'unchanged') return outcome;
        emit(action);
        // Outside the lock: Praxis answers this by calling apply, which takes the lock.
        const told = await pushSync(action === 'restore' ? 'restore' : 'choice');
        return { ...outcome, body: { ...outcome.body, praxisTold: told.ok, ...(told.ok ? {} : { praxisError: told.error }) } };
    }

    /** Choose the previous model again: the one the latest choice replaced. */
    async function restore({ surface, selectionId } = {}) {
        const selection = await readSelection();
        if (!selection?.previous?.model) return failure(409, 'nothing_to_restore', 'No earlier choice of local model is recorded.');
        if (selectionId !== undefined && selection.selectionId !== selectionId) {
            return failure(409, 'superseded', 'Another choice was made since this panel was loaded; nothing changed.', { selectionId: selection.selectionId });
        }
        return select({ model: selection.previous.model, surface, action: 'restore', expectSelectionId: selection.selectionId });
    }

    /**
     * Praxis's request to put a waiting switch into effect, made when nothing
     * local runs there. The one place local_default changes.
     */
    async function apply({ selectionId, model } = {}) {
        const outcome = await withLock(async () => {
            const selection = await readSelection();
            const matches = selection && selection.selectionId === selectionId && sameModel(selection.model, model);
            if (!matches) {
                return { status: 409, body: { error: 'superseded', message: 'A newer choice replaced this one.', selectionId: selection?.selectionId || null, model: selection?.model || null } };
            }
            const active = await activeLocalModel();
            if (selection.status !== 'waiting') {
                // Already in effect (a repeated request): answer as before.
                if (active && sameModel(active.model, selection.model)) return { status: 200, body: { active: active.model, selectionId, alreadyApplied: true } };
                return { status: 409, body: { error: 'superseded', message: 'This choice is no longer waiting.', selectionId: selection.selectionId, model: selection.model } };
            }
            const running = studioWork();
            if (running.length) return { status: 409, body: { error: 'busy', message: 'A Studio local job is running; the switch waits for it.', waitingFor: running } };
            const row = await ensureLocalModelRow({ key: selection.model, label: selection.row?.label || selection.model, reasoning: !!selection.row?.reasoning });
            await setLocalDefault(row.id);
            const at = nowIso();
            const record = await waitingSwitchRow(selectionId);
            if (record) await db.updateLocalModelSwitch(record.id, { status: 'applied', applied_at: at });
            await db.setModelControlSetting(SELECTION_KEY, { ...selection, modelId: row.id, status: 'applied', appliedAt: at });
            logger.info?.(`[LocalModel] ${selection.label || selection.model} is now the local model (was ${active?.label || active?.model || 'none'}); nothing was loaded.`);
            return { status: 200, body: { active: row.api_model_id, selectionId } };
        });
        if (outcome.status === 200 && !outcome.body.alreadyApplied) emit('applied');
        return outcome;
    }

    /** What Praxis and TheCortex read. */
    async function current() {
        const active = await activeLocalModel();
        const selection = await readSelection();
        const waiting = waitingSelection(selection);
        return {
            active: active?.model || null,
            activeLabel: active?.label || null,
            selected: waiting ? waiting.model : active?.model || null,
            selectionId: selection?.selectionId || null,
            requestedAt: selection?.requestedAt || null,
            surface: selection?.surface || null,
            waiting: !!waiting,
        };
    }

    /** The model for Studio local work: the one in effect, else the environment's, reported once. */
    async function modelInEffectOrFallback() {
        let active = null;
        let reason = `the ${LOCAL_ALIAS} alias does not name an active local model`;
        try {
            active = await activeLocalModel();
        } catch (err) {
            reason = `the local model setting could not be read (${err?.message || err})`;
        }
        if (active) {
            studioFallbackReported = null;
            return active.model;
        }
        const name = nonEmpty(env.LOCAL_STUDIO_MODEL) ? 'LOCAL_STUDIO_MODEL' : nonEmpty(env.LOCAL_LLM_MODEL) ? 'LOCAL_LLM_MODEL' : null;
        // 'gemma4' is the name Studio used when neither variable was set, before this task.
        const model = name ? nonEmpty(env[name]) : 'gemma4';
        if (studioFallbackReported !== reason) {
            studioFallbackReported = reason;
            logger.warn(`[LocalModel] ${reason}, so Studio's local calls use ${name ? `the environment's ${name}` : 'the built-in name'} (${model}) until one is chosen under Model Control.`);
        }
        return model;
    }

    function afterWorkEnded() {
        if (work.size > 0) return emit('studio-work');
        readSelection()
            .then(selection => {
                if (!waitingSelection(selection)) return null;
                emit('studio-work');
                return pushSync('local-work-ended');
            })
            .catch(err => logger.warn(`[LocalModel] After Studio local work ended, the waiting switch could not be checked: ${err?.message || err}`));
    }

    /**
     * Run Studio local work. While it runs a switch waits; the work keeps the
     * model it started with; when the last such work ends, Praxis is asked to
     * apply a waiting switch. Nested calls join the outer work.
     */
    async function withLocalWork(label, fn) {
        if (workScope.getStore()) return fn();
        const scope = await withLock(async () => {
            const id = randomUUID();
            work.set(id, { kind: 'studio_job', id, label: nonEmpty(label) || 'Studio local job', since: nowIso() });
            return { id, model: await modelInEffectOrFallback() };
        });
        emit('studio-work');
        try {
            return await workScope.run(scope, fn);
        } finally {
            work.delete(scope.id);
            afterWorkEnded();
        }
    }

    /** The local model a Studio call should name: its work's model, else the one in effect once no apply is running. */
    async function localModelForWork() {
        const scope = workScope.getStore();
        if (scope) return scope.model;
        await lockTail;
        return modelInEffectOrFallback();
    }

    /** Everything the Model Control panel shows. */
    async function panel() {
        const [active, selection, history, listing, praxis] = await Promise.all([
            activeLocalModel(),
            readSelection(),
            db.getLocalModelSwitches(),
            readListing(),
            praxisSnapshot(),
        ]);
        const waiting = waitingSelection(selection);
        const memoryBytes = totalMemBytes();
        const home = lmStudioHome();
        const { options, hidden } = buildLocalModelOptions({
            listing: listing.models,
            savedContextFor: key => readSavedLoadContext(home, key),
            tested: praxis.reachable && Array.isArray(praxis.tested) ? praxis.tested : null,
            active: active?.model || null,
            waiting: waiting?.model || null,
            memoryBytes,
        });
        let restoreTo = null;
        const previous = selection?.previous;
        if (previous?.model) {
            const option = options.find(o => sameModel(o.key, previous.model));
            const isActive = sameModel(previous.model, active?.model);
            restoreTo = {
                model: option?.key || previous.model,
                label: option?.label || previous.label || previous.model,
                available: isActive || !!option?.selectable,
                reason: isActive || option?.selectable
                    ? null
                    : option?.unavailableReason || (listing.ok
                        ? `${previous.label || previous.model} is not in LM Studio's list of downloaded models.`
                        : `LM Studio's list of models could not be read (${listing.error}).`),
            };
        }
        return {
            active,
            selection: selection
                ? { selectionId: selection.selectionId, model: selection.model, label: selection.label || selection.model, action: selection.action || 'choose', surface: selection.surface || null, requestedAt: selection.requestedAt || null, status: selection.status || null, appliedAt: selection.appliedAt || null }
                : null,
            waiting: waiting ? { model: waiting.model, label: waiting.label || waiting.model, requestedAt: waiting.requestedAt || null, studio: studioWork(), praxis: praxis.reachable ? praxis.pending?.waitingFor || [] : [] } : null,
            praxis,
            options,
            hidden,
            listing: { ok: listing.ok, url: listing.url, ...(listing.ok ? {} : { error: listing.error }) },
            restore: restoreTo,
            history,
            machine: { memoryBytes },
            praxisResyncSeconds: PRAXIS_RESYNC_S,
        };
    }

    return {
        select,
        restore,
        apply,
        current,
        panel,
        pushSync,
        withLocalWork,
        localModelForWork,
        studioWork,
        readListing,
    };
}

/**
 * For a Studio router built without the setting (tests): the environment's
 * model, as before this task, and no switch to wait for. server.js always
 * passes createLocalModelSelection's instance.
 */
function environmentLocalModels(env = process.env) {
    return {
        withLocalWork: (_label, fn) => fn(),
        localModelForWork: async () => nonEmpty(env.LOCAL_STUDIO_MODEL) || nonEmpty(env.LOCAL_LLM_MODEL) || 'gemma4',
    };
}

module.exports = {
    createLocalModelSelection,
    environmentLocalModels,
    buildLocalModelOptions,
    readSavedLoadContext,
    noSavedContextReason,
    localKey,
    LOCAL_ALIAS,
    SELECTION_KEY,
    LOCAL_ALIAS_DESCRIPTION,
    EVENT,
};
