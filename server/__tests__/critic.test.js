/**
 * The critic reviews on the Antigravity CLI only: no direct Gemini API call,
 * even when agy fails (Robert's 2026-08-11 rule).
 */
jest.mock('../utils/agy-client', () => ({
    runAgyPrompt: jest.fn(),
    extractJsonSlice: jest.requireActual('../utils/agy-client').extractJsonSlice,
}));
jest.mock('../utils/token-tracker', () => ({ trackUsage: jest.fn() }));

const { runAgyPrompt } = require('../utils/agy-client');
const { trackUsage } = require('../utils/token-tracker');
const { reviewCode } = require('../services/critic');

describe('critic review', () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GOOGLE_API_KEY;

    beforeEach(() => {
        global.fetch = jest.fn(async () => { throw new Error('the critic must not call any HTTP API'); });
        process.env.GOOGLE_API_KEY = 'fixture-key-that-must-not-be-used';
        runAgyPrompt.mockReset();
        trackUsage.mockReset();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = originalKey;
    });

    test('returns the agy verdict', async () => {
        runAgyPrompt.mockResolvedValue({ ok: true, text: '{"approved": true, "issues": [], "suggestions": ["name it better"]}' });
        const review = await reviewCode('/tmp/x.js', 'const a = 1;');
        expect(review).toEqual({ approved: true, issues: [], suggestions: ['name it better'] });
        expect(trackUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'antigravity', task: 'critic' }));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('agy failing rejects by default and never falls back to the Gemini API', async () => {
        runAgyPrompt.mockResolvedValue({ ok: false, error: 'quota' });
        const review = await reviewCode('/tmp/x.js', 'const a = 1;');
        expect(review).toMatchObject({ approved: false, error: 'agy_unavailable' });
        expect(review.issues[0]).toMatch(/Critic review unavailable.*quota/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a reply without a JSON verdict rejects by default', async () => {
        runAgyPrompt.mockResolvedValue({ ok: true, text: 'Looks fine to me.' });
        const review = await reviewCode('/tmp/x.js', 'const a = 1;');
        expect(review).toMatchObject({ approved: false, error: 'parse_error' });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
