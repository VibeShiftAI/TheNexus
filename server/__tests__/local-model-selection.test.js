/**
 * The local model chosen under Model Control (task fa032fc0), on a temp
 * database with a fake LM Studio listing, fake saved load profiles and a fake
 * Praxis that calls back into /current and /apply the way Praxis does
 * (Praxis src/llm/local-model-selection.ts). Nothing here reaches LM Studio,
 * Praxis or the live database: the fakes record every request, and a guard on
 * fetch fails the suite if anything else is contacted.
 */
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const LMSTUDIO = 'http://lmstudio.test:1234';
const LISTING_URL = `${LMSTUDIO}/api/v1/models`;
const GIB = 2 ** 30;

function chatModel(over) {
    return {
        type: 'llm',
        loaded_instances: [],
        format: 'gguf',
        quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
        capabilities: { vision: true, trained_for_tool_use: true },
        ...over,
    };
}

// The four chat models and the embedding model LM Studio listed on this
// machine on 2026-11-24, with their real sizes and maximum contexts.
const INKLING = chatModel({
    key: 'thinkingmachines/inkling-2-mini', display_name: 'Inkling 2 Mini', publisher: 'thinkingmachines',
    size_bytes: 18119934834, max_context_length: 1048576, params_string: '26.4B',
    capabilities: { vision: true, trained_for_tool_use: false, reasoning: { allowed_options: ['low', 'medium', 'high', 'xhigh'], default: 'high' } },
});
const QWEN = chatModel({
    key: 'qwen/qwen3.8-27b', display_name: 'Qwen3.8 27B', publisher: 'qwen',
    size_bytes: 16081678492, max_context_length: 262144, params_string: '27B', format: 'mlx', quantization: { name: '4bit', bits_per_weight: 4 },
});
const GEMMA_QAT = chatModel({
    key: 'google/gemma-4-31b-qat', display_name: 'Gemma 4 31B QAT', publisher: 'google',
    size_bytes: 18851799617, max_context_length: 262144, params_string: '31B', quantization: { name: 'Q4_0', bits_per_weight: 4 },
});
const GEMMA = chatModel({
    key: 'google/gemma-4-31b', display_name: 'Gemma 4 31B', publisher: 'google',
    size_bytes: 19887882864, max_context_length: 262144, params_string: '31B',
});
const NOMIC = {
    type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5', display_name: 'Nomic Embed Text v1.5', publisher: 'nomic-ai',
    size_bytes: 84106624, max_context_length: 2048, format: 'gguf',
    loaded_instances: [{ id: 'text-embedding-nomic-embed-text-v1.5', config: { context_length: 2048 } }],
};

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** LM Studio: answers the listing, refuses (and records) anything else. */
function fakeLmStudio(listing) {
    const state = { listing: [...listing], requests: [], down: false };
    state.fetch = async (url, init = {}) => {
        const method = init.method || 'GET';
        state.requests.push({ method, url: String(url) });
        if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
        if (method === 'GET' && String(url) === LISTING_URL) return jsonResponse(200, { models: state.listing });
        throw new Error(`fake LM Studio refuses ${method} ${url}`);
    };
    return state;
}

/** A saved LM Studio load profile, as LM Studio writes it. */
function saveProfile(home, key, contextLength) {
    const file = path.join(home, '.internal', 'user-concrete-model-default-config', `${key}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ load: { fields: [{ key: 'llm.load.contextLength', value: contextLength }] } }));
}

/**
 * Praxis, reduced to what it does with this setting: on a sync it reads
 * /current, and when a switch waits and no local work of its own runs it asks
 * /apply, the way Praxis's local-model-selection.ts does.
 */
function fakePraxis() {
    const state = {
        baseUrl: null,
        reachable: true,
        localWork: [],
        tested: ['google/gemma-4-31b-qat', 'thinkingmachines/inkling-2-mini'],
        active: null,
        pending: null,
        requests: [],
        syncs: [],
        waiters: [],
    };
    const snapshot = () => ({
        active: state.active,
        source: 'nexus',
        since: '2026-11-24T12:00:00.000Z',
        ...(state.pending ? { pending: { ...state.pending, waitingFor: [...state.localWork] } } : {}),
        tested: [...state.tested],
    });
    async function sync(reason) {
        const current = await (await fetch(`${state.baseUrl}/api/model-control/local-model/current`)).json();
        if (current.selected && current.active && current.selected !== current.active) {
            state.pending = { model: current.selected, selectionId: current.selectionId, nexusWaitingFor: [], applying: false };
            if (!state.localWork.length) {
                const res = await fetch(`${state.baseUrl}/api/model-control/local-model/apply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selectionId: current.selectionId, model: current.selected }),
                });
                const body = await res.json();
                if (res.ok) {
                    state.active = body.active;
                    state.pending = null;
                } else if (body.error === 'busy') {
                    state.pending.nexusWaitingFor = body.waitingFor;
                } else {
                    state.pending = null;
                }
            }
        } else {
            state.active = current.active || current.selected;
            state.pending = null;
        }
        state.syncs.push(reason);
        for (const waiter of state.waiters.filter(w => w.reason === reason)) waiter.resolve();
        state.waiters = state.waiters.filter(w => w.reason !== reason);
        return snapshot();
    }
    state.praxisFetch = async (pathname, options = {}) => {
        const method = options.method || 'GET';
        state.requests.push({ method, path: pathname, body: options.body });
        if (!state.reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:18789');
        if (pathname === '/local-model' && method === 'GET') return jsonResponse(200, snapshot());
        if (pathname === '/local-model/sync' && method === 'POST') return jsonResponse(200, await sync(options.body?.reason));
        throw new Error(`fake Praxis has no ${method} ${pathname}`);
    };
    /** Resolves once a sync for `reason` has finished (now or later). */
    state.waitForSync = (reason) => (state.syncs.includes(reason)
        ? Promise.resolve()
        : new Promise(resolve => state.waiters.push({ reason, resolve })));
    return state;
}

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` }));
    });
}

function close(handle) {
    for (const socket of handle.sockets) socket.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

describe('the local model chosen under Model Control', () => {
    const realFetch = global.fetch;
    let tmp;
    let home;
    let db;
    let lmStudio;
    let praxis;
    let selection;
    let io;
    let logger;
    let callAI;
    let handle;
    let strayRequests;

    async function api(method, pathname, body) {
        const res = await fetch(`${handle.baseUrl}/api${pathname}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json() };
    }

    async function switches() {
        return db.getLocalModelSwitches();
    }

    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-local-model-'));
        home = path.join(tmp, 'lmstudio');
        process.env.NEXUS_DB_PATH = path.join(tmp, 'nexus.db');
        jest.resetModules();
        db = require('../../db');
        // Saved contexts as on this machine: Gemma and Inkling at 131,072, Qwen none.
        saveProfile(home, 'google/gemma-4-31b-qat', 131072);
        saveProfile(home, 'google/gemma-4-31b', 131072);
        saveProfile(home, 'thinkingmachines/inkling-2-mini', 131072);
        lmStudio = fakeLmStudio([INKLING, QWEN, GEMMA_QAT, GEMMA, NOMIC]);
        praxis = fakePraxis();
        io = { emit: jest.fn() };
        logger = { warn: jest.fn(), info: jest.fn() };
        callAI = jest.fn(async () => ({ text: JSON.stringify([{ title: 'Idea', source: 'test', angle: 'An angle.' }]) }));

        const { createLocalModelSelection } = require('../services/local-model-selection');
        selection = createLocalModelSelection({
            db,
            io,
            praxisFetch: praxis.praxisFetch,
            fetchImpl: lmStudio.fetch,
            // Decoys: the environment must not decide the model while the setting does.
            env: { LMSTUDIO_API_URL: LMSTUDIO, LMSTUDIO_HOME: home, LOCAL_STUDIO_MODEL: 'env-decoy-studio', LOCAL_LLM_MODEL: 'env-decoy-llm' },
            totalMemBytes: () => 64 * GIB,
            logger,
        });
        const createModelControlRouter = require('../routes/model-control');
        const createStudioRouter = require('../routes/studio');
        const app = express();
        app.use(express.json());
        app.use('/api/model-control', createModelControlRouter({ db, io, localModels: selection }));
        app.use('/api/studio', createStudioRouter({ callAI, localModels: selection, referencesDir: path.join(tmp, 'refs') }));
        handle = await listen(app);
        praxis.baseUrl = handle.baseUrl;

        // Only this test's server may be reached over the network.
        strayRequests = [];
        global.fetch = (url, init) => {
            if (!String(url).startsWith(handle.baseUrl)) {
                strayRequests.push(String(url));
                return Promise.reject(new Error(`test guard: ${url} is not this test's server`));
            }
            return realFetch(url, init);
        };
    });

    afterEach(async () => {
        global.fetch = realFetch;
        if (handle) await close(handle);
        delete process.env.NEXUS_DB_PATH;
        jest.resetModules();
        fs.rmSync(tmp, { recursive: true, force: true });
        expect(strayRequests).toEqual([]);
        // Choosing never loads: LM Studio was only ever asked for its listing.
        expect(lmStudio.requests.filter(r => !(r.method === 'GET' && r.url === LISTING_URL))).toEqual([]);
    });

    test("the options are LM Studio's chat models, each with its name, size, saved context and tested handling; embedding models are not offered", async () => {
        const { status, body } = await api('GET', '/model-control/local-model');
        expect(status).toBe(200);
        expect(body.listing).toEqual({ ok: true, url: LISTING_URL });
        expect(body.active).toEqual({ model: 'google/gemma-4-31b-qat', label: 'Gemma 4 31B QAT (local)', rowId: 'local-gemma-4-31b' });
        expect(body.options.map(o => o.key)).toEqual([
            'thinkingmachines/inkling-2-mini', 'qwen/qwen3.8-27b', 'google/gemma-4-31b-qat', 'google/gemma-4-31b',
        ]);
        expect(body.hidden).toEqual([
            expect.objectContaining({ key: 'text-embedding-nomic-embed-text-v1.5', type: 'embedding', reason: expect.stringMatching(/^Embedding model/) }),
        ]);
        const byKey = Object.fromEntries(body.options.map(o => [o.key, o]));
        expect(byKey['google/gemma-4-31b-qat']).toEqual(expect.objectContaining({
            label: 'Gemma 4 31B QAT', sizeBytes: 18851799617, savedContext: 131072, maxContext: 262144,
            handling: 'tested', selectable: true, unavailableReason: null, active: true, waiting: false,
        }));
        expect(byKey['thinkingmachines/inkling-2-mini']).toEqual(expect.objectContaining({
            label: 'Inkling 2 Mini', sizeBytes: 18119934834, savedContext: 131072, maxContext: 1048576, handling: 'tested', selectable: true, active: false,
        }));
        expect(byKey['google/gemma-4-31b']).toEqual(expect.objectContaining({ label: 'Gemma 4 31B', savedContext: 131072, handling: 'conservative', selectable: true }));
        expect(byKey['qwen/qwen3.8-27b']).toEqual(expect.objectContaining({ label: 'Qwen3.8 27B', sizeBytes: 16081678492, savedContext: null, handling: 'conservative', selectable: false }));

        // A new download appears without a code change: LM Studio lists it, and
        // a saved context makes it selectable. Praxis has no tested handling for it.
        lmStudio.listing.push(chatModel({ key: 'mistralai/ministral-4-14b', display_name: 'Ministral 4 14B', publisher: 'mistralai', size_bytes: 8800000000, max_context_length: 131072, params_string: '14B' }));
        saveProfile(home, 'mistralai/ministral-4-14b', 32768);
        const after = await api('GET', '/model-control/local-model');
        expect(after.body.options.find(o => o.key === 'mistralai/ministral-4-14b')).toEqual(expect.objectContaining({
            label: 'Ministral 4 14B', sizeBytes: 8800000000, savedContext: 32768, handling: 'conservative', selectable: true,
        }));

        // Praxis out of reach: the handling is shown as unknown, never guessed.
        praxis.reachable = false;
        const unreachable = await api('GET', '/model-control/local-model');
        expect(unreachable.body.praxis).toEqual({ reachable: false, error: expect.stringMatching(/ECONNREFUSED/) });
        expect(new Set(unreachable.body.options.map(o => o.handling))).toEqual(new Set(['unknown']));
    });

    test('a model with no saved load context cannot be chosen, and the answer says what is missing', async () => {
        fs.rmSync(path.join(home, '.internal', 'user-concrete-model-default-config', 'thinkingmachines'), { recursive: true });

        const inkling = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini', surface: 'model-control' });
        expect(inkling.status).toBe(422);
        expect(inkling.body).toEqual(expect.objectContaining({ error: 'no_saved_context', model: 'thinkingmachines/inkling-2-mini' }));
        expect(inkling.body.message).toBe(
            'Inkling 2 Mini: No saved load context in LM Studio, so the context it would load with is not set. ' +
            "Its maximum is 1,048,576 tokens, which can need more memory than this machine's 64 GB. " +
            "Save a context length for it in LM Studio's load settings to make it selectable.",
        );
        const qwen = await api('PUT', '/model-control/local-model', { model: 'qwen/qwen3.8-27b' });
        expect(qwen.status).toBe(422);
        expect(qwen.body.message).toMatch(/^Qwen3\.8 27B: No saved load context in LM Studio/);

        // The panel shows the same reason on the option, which cannot be picked.
        const panel = (await api('GET', '/model-control/local-model')).body;
        const option = panel.options.find(o => o.key === 'thinkingmachines/inkling-2-mini');
        expect(option).toEqual(expect.objectContaining({ selectable: false, savedContext: null }));
        expect(option.unavailableReason).toMatch(/1,048,576 tokens, which can need more memory than this machine's 64 GB/);

        // Embedding models and models LM Studio does not list are refused too.
        expect((await api('PUT', '/model-control/local-model', { model: 'text-embedding-nomic-embed-text-v1.5' })).body.error).toBe('not_a_chat_model');
        expect((await api('PUT', '/model-control/local-model', { model: 'nobody/not-downloaded' })).status).toBe(404);
        expect((await api('PUT', '/model-control/local-model', {})).status).toBe(400);

        // Nothing was recorded and Gemma is still the model in effect.
        expect(await switches()).toEqual([]);
        expect((await api('GET', '/model-control/local-model/current')).body).toEqual(expect.objectContaining({
            active: 'google/gemma-4-31b-qat', selected: 'google/gemma-4-31b-qat', selectionId: null, waiting: false,
        }));
        expect(praxis.requests.filter(r => r.path === '/local-model/sync')).toEqual([]);
    });

    test('choosing records the switch and loads nothing; Praxis puts it into effect when nothing local runs', async () => {
        const chosen = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini', surface: 'model-control' });
        expect(chosen.status).toBe(200);
        expect(chosen.body).toEqual(expect.objectContaining({ result: 'waiting', model: 'thinkingmachines/inkling-2-mini', praxisTold: true }));
        // Praxis was told, read the setting and, with nothing local running, applied it.
        expect(praxis.requests.filter(r => r.method === 'POST')).toEqual([{ method: 'POST', path: '/local-model/sync', body: { reason: 'choice' } }]);
        expect(chosen.body.panel.active).toEqual(expect.objectContaining({ model: 'thinkingmachines/inkling-2-mini', label: 'Inkling 2 Mini (local)' }));
        expect(chosen.body.panel.waiting).toBeNull();

        const [record] = await switches();
        expect(record).toEqual(expect.objectContaining({
            action: 'choose', surface: 'model-control', status: 'applied',
            from_model: 'google/gemma-4-31b-qat', from_label: 'Gemma 4 31B QAT (local)',
            to_model: 'thinkingmachines/inkling-2-mini', to_label: 'Inkling 2 Mini (local)',
            selection_id: chosen.body.selectionId,
        }));
        expect(Date.parse(record.requested_at)).not.toBeNaN();
        expect(Date.parse(record.applied_at)).toBeGreaterThanOrEqual(Date.parse(record.requested_at));
        const aliases = await db.getModelAliases(false);
        expect(aliases.find(a => a.alias === 'local_default')).toEqual(expect.objectContaining({ target: 'model:local-inkling-2-mini', is_active: true }));
        expect(io.emit).toHaveBeenCalledWith('model-control:local-model', expect.objectContaining({ reason: 'applied' }));
    });

    test("a switch chosen during a Studio local job waits for it; the job keeps its model and the next job uses the new one", async () => {
        const gate = deferred();
        const started = deferred();
        const seen = {};
        const job = selection.withLocalWork('Studio Write script (writer + critic)', async () => {
            seen.atStart = await selection.localModelForWork();
            started.resolve();
            await gate.promise;
            seen.atEnd = await selection.localModelForWork();
        });
        await started.promise;

        const chosen = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini', surface: 'model-control' });
        expect(chosen.status).toBe(200);
        // Praxis was idle and asked to apply it; Nexus refused while the Studio job runs.
        expect(chosen.body.panel.active.model).toBe('google/gemma-4-31b-qat');
        expect(chosen.body.panel.waiting).toEqual(expect.objectContaining({
            model: 'thinkingmachines/inkling-2-mini',
            studio: [expect.objectContaining({ kind: 'studio_job', label: 'Studio Write script (writer + critic)' })],
        }));
        expect(praxis.pending.nexusWaitingFor).toEqual([expect.objectContaining({ label: 'Studio Write script (writer + critic)' })]);
        expect((await api('GET', '/model-control/local-model/current')).body).toEqual(expect.objectContaining({
            active: 'google/gemma-4-31b-qat', selected: 'thinkingmachines/inkling-2-mini', waiting: true,
        }));
        const busy = await api('POST', '/model-control/local-model/apply', { selectionId: chosen.body.selectionId, model: 'thinkingmachines/inkling-2-mini' });
        expect(busy).toEqual({ status: 409, body: expect.objectContaining({ error: 'busy', waitingFor: [expect.objectContaining({ label: 'Studio Write script (writer + critic)' })] }) });
        expect((await switches())[0].status).toBe('waiting');

        // The job ends: Praxis is asked again and the switch takes effect.
        gate.resolve();
        await job;
        await praxis.waitForSync('local-work-ended');
        expect(seen).toEqual({ atStart: 'google/gemma-4-31b-qat', atEnd: 'google/gemma-4-31b-qat' });
        expect((await api('GET', '/model-control/local-model/current')).body).toEqual(expect.objectContaining({
            active: 'thinkingmachines/inkling-2-mini', selected: 'thinkingmachines/inkling-2-mini', waiting: false,
        }));
        expect((await switches())[0]).toEqual(expect.objectContaining({ status: 'applied', to_model: 'thinkingmachines/inkling-2-mini' }));
        expect(await selection.withLocalWork('Studio next job', () => selection.localModelForWork())).toBe('thinkingmachines/inkling-2-mini');
    });

    test("Praxis's own local job holds the switch too, and the panel shows what it waits for", async () => {
        praxis.localWork = [{ kind: 'local_job', id: 'job-7', label: 'memory.synthesize', since: '2026-11-24T23:10:00.000Z' }];
        const chosen = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini', surface: 'model-control' });
        expect(chosen.body.panel.active.model).toBe('google/gemma-4-31b-qat');
        expect(chosen.body.panel.waiting).toEqual(expect.objectContaining({
            model: 'thinkingmachines/inkling-2-mini',
            label: 'Inkling 2 Mini (local)',
            studio: [],
            praxis: [expect.objectContaining({ kind: 'local_job', label: 'memory.synthesize' })],
        }));
        expect(chosen.body.panel.options.find(o => o.key === 'thinkingmachines/inkling-2-mini')).toEqual(expect.objectContaining({ waiting: true, active: false }));

        // Praxis's job ends; it reads the setting and applies the switch.
        praxis.localWork = [];
        await praxis.praxisFetch('/local-model/sync', { method: 'POST', body: { reason: 'local-job-ended' } });
        expect((await api('GET', '/model-control/local-model/current')).body.active).toBe('thinkingmachines/inkling-2-mini');
    });

    test('a choice replaced before it took effect is refused as superseded, and a repeated choice is recorded once', async () => {
        praxis.localWork = [{ kind: 'local_call', label: '1 local call', count: 1 }];
        const first = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini' });
        const again = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini' });
        expect(again.body).toEqual(expect.objectContaining({ result: 'unchanged', selectionId: first.body.selectionId }));
        expect(await switches()).toHaveLength(1);

        const second = await api('PUT', '/model-control/local-model', { model: 'google/gemma-4-31b' });
        expect(second.body.result).toBe('waiting');
        const rows = await switches();
        expect(rows.map(r => [r.to_model, r.status])).toEqual([['google/gemma-4-31b', 'waiting'], ['thinkingmachines/inkling-2-mini', 'replaced']]);
        expect(rows[1].replaced_at).toBeTruthy();

        const stale = await api('POST', '/model-control/local-model/apply', { selectionId: first.body.selectionId, model: 'thinkingmachines/inkling-2-mini' });
        expect(stale).toEqual({ status: 409, body: expect.objectContaining({ error: 'superseded', selectionId: second.body.selectionId }) });
        const applied = await api('POST', '/model-control/local-model/apply', { selectionId: second.body.selectionId, model: 'google/gemma-4-31b' });
        expect(applied).toEqual({ status: 200, body: { active: 'google/gemma-4-31b', selectionId: second.body.selectionId } });
        // A repeated apply (a lost answer) is answered the same way, not as a new switch.
        const repeat = await api('POST', '/model-control/local-model/apply', { selectionId: second.body.selectionId, model: 'google/gemma-4-31b' });
        expect(repeat.body).toEqual(expect.objectContaining({ active: 'google/gemma-4-31b', alreadyApplied: true }));
        expect((await switches()).map(r => r.status)).toEqual(['applied', 'replaced']);
        // A panel loaded before the last choice cannot overwrite it.
        const stalePanel = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini', selectionId: first.body.selectionId });
        expect(stalePanel).toEqual({ status: 409, body: expect.objectContaining({ error: 'superseded' }) });
    });

    test('choosing the model still in effect drops a waiting switch at once', async () => {
        praxis.localWork = [{ kind: 'local_job', id: 'job-9', label: 'ingestion.journal' }];
        await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini' });
        const back = await api('PUT', '/model-control/local-model', { model: 'google/gemma-4-31b-qat', surface: 'model-control' });
        expect(back.body.result).toBe('applied');
        expect(back.body.panel.waiting).toBeNull();
        const rows = await switches();
        expect(rows.map(r => [r.to_model, r.status])).toEqual([['google/gemma-4-31b-qat', 'applied'], ['thinkingmachines/inkling-2-mini', 'replaced']]);
        expect(rows[0].details.note).toMatch(/was still in effect, so the waiting switch to Inkling 2 Mini \(local\) was dropped/);
        expect((await api('GET', '/model-control/local-model/current')).body).toEqual(expect.objectContaining({
            active: 'google/gemma-4-31b-qat', selected: 'google/gemma-4-31b-qat', waiting: false,
        }));
    });

    test('each switch is recorded with what changed and when, and the previous choice restores in one action', async () => {
        const chosen = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini', surface: 'model-control' });
        expect(chosen.body.panel.restore).toEqual({ model: 'google/gemma-4-31b-qat', label: 'Gemma 4 31B QAT', available: true, reason: null });

        const restored = await api('POST', '/model-control/local-model/restore', { surface: 'model-control', selectionId: chosen.body.selectionId });
        expect(restored.status).toBe(200);
        expect(restored.body.panel.active.model).toBe('google/gemma-4-31b-qat');
        const history = restored.body.panel.history;
        expect(history.map(r => [r.action, r.from_model, r.to_model, r.status, r.surface])).toEqual([
            ['restore', 'thinkingmachines/inkling-2-mini', 'google/gemma-4-31b-qat', 'applied', 'model-control'],
            ['choose', 'google/gemma-4-31b-qat', 'thinkingmachines/inkling-2-mini', 'applied', 'model-control'],
        ]);
        for (const row of history) {
            expect(Date.parse(row.requested_at)).not.toBeNaN();
            expect(Date.parse(row.applied_at)).not.toBeNaN();
        }
        // The restore is itself undoable: the panel now offers Inkling back.
        expect(restored.body.panel.restore).toEqual(expect.objectContaining({ model: 'thinkingmachines/inkling-2-mini', available: true }));
        // A restore from a panel that missed the last choice changes nothing.
        const stale = await api('POST', '/model-control/local-model/restore', { selectionId: chosen.body.selectionId });
        expect(stale).toEqual({ status: 409, body: expect.objectContaining({ error: 'superseded' }) });
        expect(await switches()).toHaveLength(2);
    });

    test("the alias editor's local_default goes through the same choice; other targets and per-project overrides are refused", async () => {
        await db.upsertModel({ id: 'local-inkling-2-mini', name: 'Inkling 2 Mini', provider: 'local', api_model_id: 'thinkingmachines/inkling-2-mini', display_name: 'Inkling 2 Mini (local)', is_active: 1 });
        praxis.localWork = [{ kind: 'local_call', label: '1 local call', count: 1 }];

        const edited = await api('PUT', '/model-control/aliases/local_default', { target: 'model:local-inkling-2-mini', is_active: true });
        expect(edited.status).toBe(200);
        expect(edited.body.result).toBe('waiting');
        expect((await switches())[0]).toEqual(expect.objectContaining({ surface: 'alias-editor', to_model: 'thinkingmachines/inkling-2-mini', status: 'waiting' }));
        // The alias itself changes only when the switch takes effect.
        expect((await db.getModelAliases(false)).find(a => a.alias === 'local_default').target).toBe('model:local-gemma-4-31b');

        expect((await api('PUT', '/model-control/aliases/local_default', { target: 'capability_best:local' })).body.error).toBe('local_default_target');
        expect((await api('PUT', '/model-control/aliases/local_default', { target: 'model:openrouter-auto-free' })).body.error).toBe('local_default_target');
        expect((await api('PUT', '/model-control/aliases/local_default', { target: 'model:local-gemma-4-31b', is_active: false })).body.error).toBe('local_default_required');
        expect((await api('PUT', '/model-control/projects/p-1/aliases/local_default', { target: 'model:local-inkling-2-mini' })).body.error).toBe('local_default_is_global');
        // Other aliases are untouched by any of this.
        const other = await api('PUT', '/model-control/aliases/coder', { target: 'model:openrouter-auto-free' });
        expect(other.body).toEqual(expect.objectContaining({ alias: 'coder', target: 'model:openrouter-auto-free' }));
    });

    test('roles that resolve through local_default follow the setting, and say so to Praxis', async () => {
        const before = await api('POST', '/model-control/resolve', { role: 'ingestion.journal' });
        expect(before.body).toEqual(expect.objectContaining({ provider: 'local', apiModelId: 'google/gemma-4-31b-qat', followsLocalModel: true }));

        await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini' });
        const after = await api('POST', '/model-control/resolve', { role: 'ingestion.journal' });
        expect(after.body).toEqual(expect.objectContaining({ provider: 'local', apiModelId: 'thinkingmachines/inkling-2-mini', followsLocalModel: true }));

        // A role pinned to a model row keeps it and is not marked.
        await db.upsertModelRole({ role: 'test.pinned', assignment: 'model:local-gemma-4-31b' });
        const pinned = await api('POST', '/model-control/resolve', { role: 'test.pinned' });
        expect(pinned.body.apiModelId).toBe('google/gemma-4-31b-qat');
        expect(pinned.body.followsLocalModel).toBeUndefined();
    });

    test('Studio local jobs name the model in effect, with no environment edit and no restart', async () => {
        const generate = () => api('POST', '/studio/generate', { type: 'suggest_topics', mode: 'local', channelId: 'praxis-youtube' });
        expect((await generate()).status).toBe(200);
        expect(callAI.mock.calls[0][0]).toEqual({ provider: 'local', model: 'google/gemma-4-31b-qat' });

        await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini' });
        expect((await generate()).status).toBe(200);
        expect(callAI.mock.calls[1][0]).toEqual({ provider: 'local', model: 'thinkingmachines/inkling-2-mini' });

        // The ingestion extraction follows the same setting.
        const createStudioIngestion = require('../services/studio-ingestion');
        const extractCalls = [];
        const ingestion = createStudioIngestion({
            sql: { prepare: () => ({ all: () => [] }) },
            callAI: async (model) => { extractCalls.push(model); return { text: '{"objects":[]}' }; },
            uuid: () => 'id',
            now: () => '2026-11-24T00:00:00.000Z',
            helpers: { upsertSpecValues() {}, insertWonderPoints() {}, extractJSON: JSON.parse },
            listSources: () => [],
            localModels: selection,
        });
        await ingestion.runLocalExtraction({ name: 'Channel' }, { title: 'Source' }, 'Some source text about a star.');
        expect(extractCalls).toEqual([{ provider: 'local', model: 'thinkingmachines/inkling-2-mini' }]);
        expect(callAI.mock.calls.map(c => c[0].model)).not.toContain('env-decoy-studio');
    });

    test('Studio falls back to the environment only when local_default names no local model, and says so once', async () => {
        await db.upsertModelAlias({ alias: 'local_default', target: 'model:openrouter-auto-free', description: 'misconfigured' });
        expect(await selection.localModelForWork()).toBe('env-decoy-studio');
        expect(await selection.localModelForWork()).toBe('env-decoy-studio');
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toMatch(/local_default alias does not name an active local model, so Studio's local calls use the environment's LOCAL_STUDIO_MODEL \(env-decoy-studio\)/);
    });

    test('with Praxis out of reach the choice is still recorded and waits; nothing is applied behind its back', async () => {
        praxis.reachable = false;
        const chosen = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini' });
        expect(chosen.body).toEqual(expect.objectContaining({ result: 'waiting', praxisTold: false, praxisError: expect.stringMatching(/ECONNREFUSED/) }));
        expect(chosen.body.panel.praxis.reachable).toBe(false);
        expect(chosen.body.panel.waiting.model).toBe('thinkingmachines/inkling-2-mini');
        expect((await api('GET', '/model-control/local-model/current')).body).toEqual(expect.objectContaining({ active: 'google/gemma-4-31b-qat', waiting: true }));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Praxis was not told to read the local model setting \(choice: connect ECONNREFUSED/));
    });

    test("with LM Studio's listing out of reach nothing changes, and the panel says why", async () => {
        lmStudio.down = true;
        const chosen = await api('PUT', '/model-control/local-model', { model: 'thinkingmachines/inkling-2-mini' });
        expect(chosen).toEqual({ status: 503, body: expect.objectContaining({ error: 'listing_unavailable' }) });
        const panel = (await api('GET', '/model-control/local-model')).body;
        expect(panel.listing).toEqual({ ok: false, url: LISTING_URL, error: expect.stringMatching(/ECONNREFUSED/) });
        expect(panel.options).toEqual([]);
        expect(await switches()).toEqual([]);
    });
});

