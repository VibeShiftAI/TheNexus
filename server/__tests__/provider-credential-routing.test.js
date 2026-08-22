/**
 * Key-aware routing (server/services/provider-credentials.js) + the dispatch
 * relay gate that enforces it.
 *
 * The failure this guards against: the cockpit offering — and Praxis spending a
 * CLI slot on — a route whose credential is provably out, so the 402/usage
 * limit is discovered at execution instead of before it.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const {
    classifyCredentialFailure,
    assessExecutorLanes,
    assessApiKeyLanes,
    getRoutingState,
    checkDispatchRoute,
    resetRoutingCache,
} = require('../services/provider-credentials');

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const HOUR = 3600_000;

/** Praxis's real Codex usage-limit summary (model-scoped, advertised reset). */
const CODEX_USAGE_LIMIT = [
    "⛔ PRAXIS_USAGE_LIMIT: Codex hit its usage limit before finishing.",
    "CLI message: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 5:44 PM.",
    'Model: gpt-5.6-sol',
    'Usage limit resets at 2026-08-20T21:44:00.000Z.',
    "The task will be held at 'todo' for re-dispatch once the window resets.",
].join('\n');

/** The same summary with no Model line — the whole lane is out for the window. */
const CLAUDE_USAGE_LIMIT = [
    '⛔ PRAXIS_USAGE_LIMIT: Claude Code hit its usage limit before finishing.',
    'CLI message: Claude Code rejected the run at its usage limit. Usage limit resets at 2026-08-20T16:00:00.000Z.',
    'Usage limit resets at 2026-08-20T16:00:00.000Z.',
].join('\n');

function row(overrides) {
    return {
        executor: 'claude-code',
        model: null,
        outcome: 'failure',
        error: null,
        output: null,
        started_at: new Date(NOW - HOUR).toISOString(),
        completed_at: new Date(NOW - HOUR).toISOString(),
        ...overrides,
    };
}

describe('credential failure classification', () => {
    test('reads the PRAXIS_USAGE_LIMIT marker, its model scope and its reset time', () => {
        const hit = classifyCredentialFailure(CODEX_USAGE_LIMIT);
        expect(hit).toMatchObject({ code: 'usage_limit', model: 'gpt-5.6-sol' });
        expect(hit.resetAt).toBe(Date.parse('2026-08-20T21:44:00.000Z'));
    });

    test('a marker with no Model line is lane-wide', () => {
        expect(classifyCredentialFailure(CLAUDE_USAGE_LIMIT)).toMatchObject({
            code: 'usage_limit',
            model: null,
        });
    });

    test('classifies spent credit and rejected credentials distinctly', () => {
        expect(classifyCredentialFailure('HTTP 402: your credit balance is too low').code).toBe('no_credit');
        expect(classifyCredentialFailure('401 invalid_api_key').code).toBe('unauthorized');
        expect(classifyCredentialFailure('Request failed with 429 rate limit').code).toBe('usage_limit');
    });

    test('liveness faults are NOT credential faults', () => {
        // 529 Overloaded and a plain non-zero exit are Praxis executor-health's
        // business; treating them as a dead key would ban a healthy route.
        expect(classifyCredentialFailure('Claude Code exited with code 1: API Error: 529 Overloaded.')).toBeNull();
        expect(classifyCredentialFailure('Codex exited with code 143: ...')).toBeNull();
        expect(classifyCredentialFailure('')).toBeNull();
    });
});

describe('executor lane assessment', () => {
    test('a model-scoped usage limit blocks that model, not the worker', () => {
        const lanes = assessExecutorLanes([
            row({ executor: 'codex', outcome: 'failure', output: CODEX_USAGE_LIMIT }),
        ], NOW);
        const codex = lanes.find(l => l.name === 'codex');
        expect(codex.status).toBe('ok');
        expect(codex.blockedModels).toHaveLength(1);
        expect(codex.blockedModels[0]).toMatchObject({
            model: 'gpt-5.6-sol',
            code: 'usage_limit',
            until: '2026-08-20T21:44:00.000Z',
        });
        expect(checkDispatchRoute({ executor: 'codex', model: 'gpt-5.6-sol', state: { executors: lanes } }))
            .toMatchObject({ allowed: false, code: 'usage_limit', scope: 'model' });
        expect(checkDispatchRoute({ executor: 'codex', model: 'gpt-5.6-terra', state: { executors: lanes } }))
            .toMatchObject({ allowed: true });
    });

    test('a lane-wide limit blocks the worker for every model', () => {
        const lanes = assessExecutorLanes([
            row({ executor: 'claude-code', output: CLAUDE_USAGE_LIMIT }),
        ], NOW);
        const claude = lanes.find(l => l.name === 'claude-code');
        expect(claude.status).toBe('blocked');
        expect(claude.until).toBe('2026-08-20T16:00:00.000Z');
        expect(checkDispatchRoute({ executor: 'claude-code', model: 'claude-opus-5', state: { executors: lanes } }))
            .toMatchObject({ allowed: false, scope: 'executor' });
    });

    test('a later success clears the block — the credential demonstrably spent', () => {
        const lanes = assessExecutorLanes([
            row({ executor: 'claude-code', output: CLAUDE_USAGE_LIMIT, started_at: new Date(NOW - 3 * HOUR).toISOString(), completed_at: new Date(NOW - 3 * HOUR).toISOString() }),
            row({ executor: 'claude-code', outcome: 'success', output: 'done', started_at: new Date(NOW - HOUR).toISOString(), completed_at: new Date(NOW - HOUR).toISOString() }),
        ], NOW);
        expect(lanes.find(l => l.name === 'claude-code').status).toBe('ok');
    });

    test('an expired window reopens the route with no run needed to prove it', () => {
        // Reset time is in the past relative to `now`.
        const lanes = assessExecutorLanes([
            row({ executor: 'claude-code', output: CLAUDE_USAGE_LIMIT }),
        ], Date.parse('2026-08-20T17:00:00.000Z'));
        expect(lanes.find(l => l.name === 'claude-code').status).toBe('ok');
    });

    test('a 24h-old unauthorized fault ages out even with no success since', () => {
        const stale = new Date(NOW - 30 * HOUR).toISOString();
        const lanes = assessExecutorLanes([
            row({ executor: 'codex', output: '401 invalid_api_key', started_at: stale, completed_at: stale }),
        ], NOW);
        expect(lanes.find(l => l.name === 'codex').status).toBe('ok');
    });

    test('a successful run\'s output is never scanned for credential prose', () => {
        const lanes = assessExecutorLanes([
            row({
                executor: 'claude-code',
                outcome: 'success',
                output: 'Walkthrough: added a 402 / usage limit guard to the eval harness.',
            }),
        ], NOW);
        expect(lanes.find(l => l.name === 'claude-code').status).toBe('ok');
    });
});

describe('api-key lanes', () => {
    test('a lane with no env key is missing_key; either alias satisfies google', () => {
        const lanes = assessApiKeyLanes({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: '   ' });
        const byProvider = Object.fromEntries(lanes.map(l => [l.provider, l]));
        expect(byProvider.google).toMatchObject({ status: 'ok', keyVar: 'GEMINI_API_KEY' });
        expect(byProvider.openai.status).toBe('missing_key'); // whitespace is not a key
        expect(byProvider.anthropic.status).toBe('missing_key');
        expect(byProvider.xai.status).toBe('missing_key');
    });
});

describe('present provider keys decide api_key routes', () => {
    const withKey = assessApiKeyLanes({ GOOGLE_API_KEY: 'g' });
    const withoutKey = assessApiKeyLanes({});

    test('an api_key executor lane is blocked outright when its key is absent', () => {
        const lanes = assessExecutorLanes([], NOW, withoutKey);
        const gemini = lanes.find(l => l.name === 'gemini');
        expect(gemini).toMatchObject({ kind: 'api_key', requiresApiKey: true, status: 'blocked', code: 'missing_key' });
        expect(gemini.reason).toMatch(/GOOGLE_API_KEY/);
        expect(checkDispatchRoute({ executor: 'gemini', state: { executors: lanes, providers: withoutKey } }))
            .toMatchObject({ allowed: false, code: 'missing_key', scope: 'provider' });
    });

    test('the same lane routes once the key is present', () => {
        const lanes = assessExecutorLanes([], NOW, withKey);
        expect(lanes.find(l => l.name === 'gemini')).toMatchObject({ status: 'ok', keyVar: 'GOOGLE_API_KEY' });
        expect(checkDispatchRoute({ executor: 'gemini', state: { executors: lanes, providers: withKey } }).allowed)
            .toBe(true);
    });

    test('an explicit per-token provider is gated on its key, alias included', () => {
        const state = { executors: assessExecutorLanes([], NOW, withoutKey), providers: withoutKey };
        expect(checkDispatchRoute({ executor: 'codex', provider: 'anthropic', state }))
            .toMatchObject({ allowed: false, code: 'missing_key', scope: 'provider' });
        // "gemini"/"claude"/"grok" are provider aliases and must resolve too.
        expect(checkDispatchRoute({ executor: 'codex', provider: 'gemini', state }).code).toBe('missing_key');
        const live = { executors: assessExecutorLanes([], NOW, withKey), providers: withKey };
        expect(checkDispatchRoute({ executor: 'codex', provider: 'gemini', state: live }).allowed).toBe(true);
    });

    test('subscription CLIs are NEVER gated on an API key', () => {
        // Regression guard for the 2026-07-10 fault: Praxis strips
        // ANTHROPIC_API_KEY, so key-gating claude-code would ban the default
        // worker on every correctly-configured machine.
        const lanes = assessExecutorLanes([], NOW, withoutKey);
        const state = { executors: lanes, providers: withoutKey };
        for (const executor of ['claude-code', 'codex', 'antigravity']) {
            expect(lanes.find(l => l.name === executor)).toMatchObject({ kind: 'subscription', requiresApiKey: false, status: 'ok' });
            expect(checkDispatchRoute({ executor, state }).allowed).toBe(true);
        }
    });

    test('a missing key outranks an observed fault on the same lane', () => {
        const lanes = assessExecutorLanes([
            row({ executor: 'gemini', output: '429 rate limit' }),
        ], NOW, withoutKey);
        // The certainty wins the label; the route is blocked either way.
        expect(lanes.find(l => l.name === 'gemini')).toMatchObject({ status: 'blocked', code: 'missing_key' });
    });
});

// ── The gate on the dispatch relay ────────────────────────────────────────

function listen(app) {
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, sockets, baseUrl: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

function close(handle) {
    for (const socket of handle.sockets) socket.destroy();
    return new Promise((resolve) => handle.server.close(resolve));
}

describe('dispatch relay key-aware gate', () => {
    let handle;
    let tmpDir;
    let dbPath;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-credentials-'));
        dbPath = path.join(tmpDir, 'test.db');
        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE task_dispatches (
                id TEXT PRIMARY KEY, task_id TEXT, executor TEXT, model TEXT,
                outcome TEXT, error TEXT, output TEXT,
                started_at TEXT, completed_at TEXT
            );
        `);
        const at = new Date(Date.now() - HOUR).toISOString();
        const reset = new Date(Date.now() + 4 * HOUR).toISOString();
        const insert = db.prepare(`INSERT INTO task_dispatches
            (id, task_id, executor, model, outcome, output, started_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        insert.run('d1', 't1', 'claude-code', null, 'failure', [
            '⛔ PRAXIS_USAGE_LIMIT: Claude Code hit its usage limit before finishing.',
            `Usage limit resets at ${reset}.`,
        ].join('\n'), at, at);
        // Codex lane is healthy, but ONE of its models is on a per-model cooldown.
        insert.run('d2', 't1', 'codex', 'gpt-5.6-sol', 'failure', [
            '⛔ PRAXIS_USAGE_LIMIT: Codex hit its usage limit before finishing.',
            'Model: gpt-5.6-sol',
            `Usage limit resets at ${reset}.`,
        ].join('\n'), at, at);
        db.close();
        resetRoutingCache();
        process.env.NEXUS_DB_PATH = dbPath;
    });

    afterEach(async () => {
        if (handle) await close(handle);
        handle = null;
        resetRoutingCache();
        delete process.env.NEXUS_DB_PATH;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('reads a live block out of the dispatch history', () => {
        const state = getRoutingState({ dbPath, refresh: true });
        expect(state.evidence.available).toBe(true);
        expect(state.executors.find(e => e.name === 'claude-code').status).toBe('blocked');
        // Untouched lanes stay routable — one dead credential is not an outage,
        // and a per-model cooldown does not close the whole worker.
        const codex = state.executors.find(e => e.name === 'codex');
        expect(codex.status).toBe('ok');
        expect(codex.blockedModels.map(m => m.model)).toEqual(['gpt-5.6-sol']);
        // antigravity has no history at all — absence of evidence is not a block.
        expect(state.executors.find(e => e.name === 'antigravity').status).toBe('ok');
    });

    test('an unreadable board degrades to unknown and still allows dispatch', () => {
        const missing = getRoutingState({ dbPath: path.join(tmpDir, 'nope.db'), refresh: true });
        expect(missing.evidence.available).toBe(false);
        // Subscription lanes are inferred from history, so they go unknown…
        expect(missing.executors.filter(e => e.kind === 'subscription').every(e => e.status === 'unknown')).toBe(true);
        // …but key presence needs no history, so api_key lanes stay decided.
        expect(missing.executors.filter(e => e.requiresApiKey).every(e => e.status !== 'unknown')).toBe(true);
        // Fail-open: a broken reader must not become an invisible dispatch ban.
        expect(checkDispatchRoute({ executor: 'claude-code', state: missing }).allowed).toBe(true);
        // …and the cached handle follows the path back, rather than staying stuck
        // on the failure.
        expect(getRoutingState({ dbPath, refresh: true }).evidence.available).toBe(true);
    });

    test('refuses a blocked route with 409, and lets force through', async () => {
        // Warm the cache off the temp DB so the router's default path sees it.
        getRoutingState({ dbPath, refresh: true });

        let proxied = 0;
        const praxis = express();
        praxis.use(express.json());
        // The relay opens its SSE upstream at construction — answer it so the
        // test isn't narrated by reconnect warnings.
        praxis.get('/stream', (_req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(': connected\n\n');
        });
        praxis.post('/api/dispatch/task', (_req, res) => { proxied += 1; res.json({ ok: true, reply: 'Dispatched.' }); });
        const praxisHandle = await listen(praxis);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;

        // constants captures PRAXIS_URL at require time, so load the relay fresh.
        jest.resetModules();
        const createPraxisStreamRouter = require('../routes/praxis-stream');
        const app = express();
        app.use(express.json());
        // Most dispatches pin no model and ride the operator-set default, so the
        // gate resolves it — otherwise per-model cooldowns would slip past.
        const db = {
            getModelControlSetting: async (key) =>
                (key === 'codex_default_model' ? { model: 'gpt-5.6-sol' } : { model: '' }),
        };
        app.use('/api/praxis', createPraxisStreamRouter({ db }));
        handle = await listen(app);

        const post = (body) => fetch(`${handle.baseUrl}/api/praxis/dispatch/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        const blocked = await post({ taskId: 't1', executor: 'claude-code' });
        const blockedBody = await blocked.json();
        expect(blocked.status).toBe(409);
        expect(blockedBody).toMatchObject({ ok: false, refused: true, reason: 'usage_limit' });
        expect(blockedBody.reply).toMatch(/key-aware routing/i);
        expect(proxied).toBe(0); // never reached Praxis — no CLI slot spent

        // No model pinned: the gate resolves codex's default (gpt-5.6-sol),
        // which is the model actually on cooldown.
        const impliedModel = await post({ taskId: 't1', executor: 'codex' });
        expect(impliedModel.status).toBe(409);
        expect((await impliedModel.json()).reply).toMatch(/gpt-5\.6-sol/);
        expect(proxied).toBe(0);

        // A healthy sibling model on the same worker still routes.
        const healthy = await post({ taskId: 't1', executor: 'codex', model: 'gpt-5.6-terra' });
        expect(healthy.status).toBe(200);
        expect(proxied).toBe(1);

        const forced = await post({ taskId: 't1', executor: 'claude-code', force: true });
        expect(forced.status).toBe(200);
        expect(proxied).toBe(2);

        await close(praxisHandle);
        delete process.env.PRAXIS_URL;
    });

    test('a missing provider key refuses the dispatch before it is proxied', async () => {
        // Control the key environment: the gate must decide from present keys,
        // not from whatever this machine happens to export.
        const savedEnv = { ...process.env };
        delete process.env.GOOGLE_API_KEY;
        delete process.env.GEMINI_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;

        let proxied = 0;
        const praxis = express();
        praxis.use(express.json());
        praxis.get('/stream', (_req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.write(': connected\n\n');
        });
        praxis.post('/api/dispatch/task', (_req, res) => { proxied += 1; res.json({ ok: true, reply: 'Dispatched.' }); });
        const praxisHandle = await listen(praxis);
        process.env.PRAXIS_URL = praxisHandle.baseUrl;

        jest.resetModules();
        const createPraxisStreamRouter = require('../routes/praxis-stream');
        const app = express();
        app.use(express.json());
        app.use('/api/praxis', createPraxisStreamRouter({ db: { getModelControlSetting: async () => ({ model: '' }) } }));
        handle = await listen(app);

        const post = (body) => fetch(`${handle.baseUrl}/api/praxis/dispatch/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        // The per-token executor has no GOOGLE_API_KEY/GEMINI_API_KEY.
        const noKey = await post({ taskId: 't1', executor: 'gemini' });
        const noKeyBody = await noKey.json();
        expect(noKey.status).toBe(409);
        expect(noKeyBody).toMatchObject({ ok: false, refused: true, reason: 'missing_key' });
        expect(noKeyBody.reply).toMatch(/GOOGLE_API_KEY/);
        expect(proxied).toBe(0); // refused BEFORE proxying — the whole point

        // An explicit per-token provider on a healthy worker is gated too.
        const noProviderKey = await post({ taskId: 't1', executor: 'antigravity', provider: 'anthropic' });
        expect(noProviderKey.status).toBe(409);
        expect((await noProviderKey.json()).reason).toBe('missing_key');
        expect(proxied).toBe(0);

        // Same worker without the per-token provider spends its subscription
        // and routes normally — a missing key must not ban the CLI lanes.
        const subscription = await post({ taskId: 't1', executor: 'antigravity' });
        expect(subscription.status).toBe(200);
        expect(proxied).toBe(1);

        // Force still overrides, same as every other refusal.
        const forced = await post({ taskId: 't1', executor: 'gemini', force: true });
        expect(forced.status).toBe(200);
        expect(proxied).toBe(2);

        await close(praxisHandle);
        process.env = savedEnv;
    });
});
