/**
 * The OpenRouter free lane's Nexus-side surface: a key that lives in
 * Praxis/.env still lights the lane, and a shared-pool cooldown never reads as
 * a dead credential.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    assessApiKeyLanes,
    classifyCredentialFailure,
    isSharedPoolCooldown,
} = require('../services/provider-credentials');
const { parseEnvFile, resetPraxisEnvCache } = require('../services/praxis-env');
const { calculateCost } = require('../utils/token-tracker');

/** The payload OpenRouter really returns for a throttled free endpoint. */
const SHARED_POOL_429 =
    'Provider returned error {"code":429,"metadata":{"raw":"stealth/ox-alpha is temporarily ' +
    'rate-limited upstream. Please retry shortly.","provider_name":"Stealth",' +
    '"limit_source":"upstream_provider_shared_pool","retry_after_seconds":5}}';

describe('OpenRouter key lane', () => {
    afterEach(() => resetPraxisEnvCache());

    test('lights up from a key in the process environment', () => {
        const lanes = assessApiKeyLanes(
            { OPENROUTER_API_KEY: 'sk-or-v1-test' },
            { resolveShared: () => null },
        );
        const lane = lanes.find(l => l.provider === 'openrouter');
        expect(lane).toBeDefined();
        expect(lane.status).toBe('ok');
        expect(lane.keyVar).toBe('OPENROUTER_API_KEY');
        expect(lane.kind).toBe('api_key');
    });

    test('lights up from Praxis/.env when this process has no copy', () => {
        // feedback_reuse_praxis_creds: Robert keeps the key in one place.
        // Demanding a duplicate in TheNexus/.env would report a live lane as
        // missing_key and silently fall the assignment back to local Gemma.
        const lanes = assessApiKeyLanes({}, { resolveShared: name =>
            name === 'OPENROUTER_API_KEY' ? 'sk-or-v1-from-praxis' : null });
        const lane = lanes.find(l => l.provider === 'openrouter');
        expect(lane.status).toBe('ok');
    });

    test('reports missing_key, naming both places it looked', () => {
        const lanes = assessApiKeyLanes({}, { resolveShared: () => null });
        const lane = lanes.find(l => l.provider === 'openrouter');
        expect(lane.status).toBe('missing_key');
        expect(lane.reason).toMatch(/Praxis\/\.env/);
    });

    test('non-shared lanes never read Praxis/.env', () => {
        // Only lanes marked `shared` may resolve out of another repo's file;
        // a resolver that answered for everything would light every lane.
        const resolveShared = jest.fn(() => 'sk-anything');
        const lanes = assessApiKeyLanes({}, { resolveShared });
        expect(lanes.find(l => l.provider === 'anthropic').status).toBe('missing_key');
        expect(lanes.find(l => l.provider === 'openrouter').status).toBe('ok');
        expect(resolveShared).toHaveBeenCalledWith('OPENROUTER_API_KEY');
        expect(resolveShared).not.toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    });
});

describe('shared-pool cooldown is not a credential fault', () => {
    test('a throttled free endpoint does not block the lane', () => {
        // The usage_limit class blocks for five hours. OpenRouter said five
        // SECONDS. Blocking here would ban a healthy route over a wait that
        // Praxis already rotates past.
        expect(isSharedPoolCooldown(SHARED_POOL_429)).toBe(true);
        expect(classifyCredentialFailure(SHARED_POOL_429)).toBeNull();
    });

    test('a genuine usage limit still blocks', () => {
        const hit = classifyCredentialFailure('429 You have no credits remaining');
        expect(hit).not.toBeNull();
        expect(hit.code).toBe('usage_limit');
    });

    test('a real 402 wins even when a cooldown is in the same text', () => {
        const hit = classifyCredentialFailure(`402 requires more credits\n${SHARED_POOL_429}`);
        expect(hit).not.toBeNull();
        expect(hit.code).toBe('no_credit');
    });

    test("Praxis's own usage-limit marker is still authoritative", () => {
        const hit = classifyCredentialFailure(`PRAXIS_USAGE_LIMIT\n${SHARED_POOL_429}`);
        expect(hit).not.toBeNull();
        expect(hit.code).toBe('usage_limit');
    });
});

describe('free-lane cost accounting', () => {
    test('free slugs cost zero rather than falling through to the default rate', () => {
        // A missing PRICING row bills a $0 call at the $1/$4 default, which
        // would inflate every ledger and budget gate that reads this table.
        expect(calculateCost('stealth/ox-alpha', 1_000_000, 1_000_000)).toBe(0);
        expect(calculateCost('z-ai/glm-5.2:free', 500_000, 500_000)).toBe(0);
        expect(calculateCost('minimax/minimax-m3:free', 1_000_000, 1_000_000)).toBe(0);
        // An unknown model still falls through to the default, as before.
        expect(calculateCost('mystery/model', 1_000_000, 1_000_000)).toBeGreaterThan(0);
    });
});

describe('praxis-env parsing', () => {
    test('reads plain, quoted and commented lines without touching process.env', () => {
        const values = parseEnvFile(
            [
                '# a comment',
                '',
                'OPENROUTER_API_KEY=sk-or-v1-plain',
                'QUOTED="quoted-value"',
                "SINGLE='single-value'",
                'WITH_EQUALS=a=b=c',
                'not a key line',
                '  SPACED = spaced  ',
            ].join('\n'),
        );
        expect(values.get('OPENROUTER_API_KEY')).toBe('sk-or-v1-plain');
        expect(values.get('QUOTED')).toBe('quoted-value');
        expect(values.get('SINGLE')).toBe('single-value');
        expect(values.get('WITH_EQUALS')).toBe('a=b=c');
        expect(values.get('SPACED')).toBe('spaced');
        expect(values.has('not a key line')).toBe(false);
        expect(process.env.QUOTED).toBeUndefined();
    });

    test('an unreadable file degrades to no values rather than throwing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-praxis-env-'));
        const prevRoot = process.env.PROJECT_ROOT;
        process.env.PROJECT_ROOT = dir; // no Praxis/.env under it
        resetPraxisEnvCache();
        try {
            const { resolveSharedCredential } = require('../services/praxis-env');
            expect(resolveSharedCredential('OPENROUTER_API_KEY')).toBeNull();
        } finally {
            if (prevRoot === undefined) delete process.env.PROJECT_ROOT;
            else process.env.PROJECT_ROOT = prevRoot;
            resetPraxisEnvCache();
        }
    });
});
