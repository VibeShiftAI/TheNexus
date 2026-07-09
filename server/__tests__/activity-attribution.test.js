/**
 * Recent Activity Feed attribution parser (task 1212d226).
 *
 * The /api/activity feed is derived from git commits, which have no first-class
 * model/token columns. deriveActivityAttribution() recovers per-commit model +
 * token attribution from commit trailers, and returns nulls (rendered as a
 * neutral "—" in the UI) when a commit carries no such data.
 */

const { deriveActivityAttribution, correlateDispatch, executorModelLabel } = require('../routes/projects');

describe('deriveActivityAttribution', () => {
    it('attributes the model from an AI Co-Authored-By trailer', () => {
        const commit = {
            message: 'Voice: warmer wording for spoken HITL alerts',
            body: 'Some detail.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>',
        };
        expect(deriveActivityAttribution(commit)).toEqual({
            model: 'Claude Fable 5',
            tokens: null,
        });
    });

    it('prefers an explicit Model: trailer over a co-author', () => {
        const commit = {
            message: 'Add feature',
            body: 'Model: Local Llama\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>',
        };
        expect(deriveActivityAttribution(commit).model).toBe('Local Llama');
    });

    it('reads a token count trailer, including k/M suffixes and commas', () => {
        expect(deriveActivityAttribution({ body: 'Tokens: 12,345' }).tokens).toBe(12345);
        expect(deriveActivityAttribution({ body: 'Tokens-Used: 12k' }).tokens).toBe(12000);
        expect(deriveActivityAttribution({ body: 'Token-Count: 2M' }).tokens).toBe(2000000);
    });

    it('ignores human co-authors', () => {
        const commit = {
            message: 'chore: EOD auto-commit',
            body: 'Co-Authored-By: Robert Washko <robert.washko@gmail.com>',
        };
        expect(deriveActivityAttribution(commit)).toEqual({ model: null, tokens: null });
    });

    it('returns nulls for a plain commit with no attribution', () => {
        expect(deriveActivityAttribution({ message: 'chore: remove retired AG bridge', body: '' }))
            .toEqual({ model: null, tokens: null });
    });

    it('does not crash on missing/empty input', () => {
        expect(deriveActivityAttribution(undefined)).toEqual({ model: null, tokens: null });
        expect(deriveActivityAttribution({})).toEqual({ model: null, tokens: null });
    });
});

describe('correlateDispatch', () => {
    // A dispatch that ran 10:00 → 10:05 and reported real model + tokens.
    const run = {
        model: 'claude-opus-4-8',
        tokens: 48200,
        started_at: '2026-07-08T10:00:00.000Z',
        completed_at: '2026-07-08T10:05:00.000Z',
    };

    it('attributes a commit made during the dispatch window', () => {
        const commit = new Date('2026-07-08T10:04:30.000Z');
        expect(correlateDispatch(commit, [run])).toEqual({ model: 'claude-opus-4-8', tokens: 48200, tokensEstimated: false, modelInferred: false });
    });

    it('attributes a commit made just after completion (within grace)', () => {
        const commit = new Date('2026-07-08T10:06:00.000Z'); // 1 min after completed_at
        expect(correlateDispatch(commit, [run])).toEqual({ model: 'claude-opus-4-8', tokens: 48200, tokensEstimated: false, modelInferred: false });
    });

    it('flags an estimated token count from the matched dispatch', () => {
        const est = { model: 'codex', tokens: 9000, tokens_estimated: 1, started_at: '2026-07-08T10:00:00.000Z', completed_at: '2026-07-08T10:05:00.000Z' };
        expect(correlateDispatch(new Date('2026-07-08T10:03:00.000Z'), [est])).toEqual({ model: 'codex', tokens: 9000, tokensEstimated: true, modelInferred: false });
    });

    it('does not attribute a commit long after the run finished', () => {
        const commit = new Date('2026-07-08T11:00:00.000Z'); // 55 min after completion
        expect(correlateDispatch(commit, [run])).toEqual({ model: null, tokens: null, tokensEstimated: false, modelInferred: false });
    });

    it('does not attribute a commit made before the run began', () => {
        const commit = new Date('2026-07-08T09:50:00.000Z');
        expect(correlateDispatch(commit, [run])).toEqual({ model: null, tokens: null, tokensEstimated: false, modelInferred: false });
    });

    it('picks the dispatch whose completion is closest to the commit', () => {
        const earlier = { model: 'gemini', tokens: 100, started_at: '2026-07-08T09:00:00.000Z', completed_at: '2026-07-08T09:10:00.000Z' };
        const commit = new Date('2026-07-08T10:04:00.000Z');
        expect(correlateDispatch(commit, [earlier, run]).model).toBe('claude-opus-4-8');
    });

    it('returns null tokens when the matched dispatch has none recorded', () => {
        const noTokens = { model: 'local-llama', tokens: null, started_at: '2026-07-08T10:00:00.000Z', completed_at: '2026-07-08T10:05:00.000Z' };
        expect(correlateDispatch(new Date('2026-07-08T10:03:00.000Z'), [noTokens])).toEqual({ model: 'local-llama', tokens: null, tokensEstimated: false, modelInferred: false });
    });

    it('derives a model label from the executor when the dispatch omits one (real Codex/AG rows)', () => {
        // Production Codex/Antigravity rows routinely ship with model = null.
        const codexRun = { executor: 'codex', model: null, tokens: 5000, started_at: '2026-07-08T10:00:00.000Z', completed_at: '2026-07-08T10:05:00.000Z' };
        expect(correlateDispatch(new Date('2026-07-08T10:03:00.000Z'), [codexRun]))
            .toEqual({ model: 'Codex', tokens: 5000, tokensEstimated: false, modelInferred: true });

        const agRun = { executor: 'antigravity', model: null, tokens: null, started_at: '2026-07-08T10:00:00.000Z', completed_at: '2026-07-08T10:05:00.000Z' };
        expect(correlateDispatch(new Date('2026-07-08T10:03:00.000Z'), [agRun]))
            .toEqual({ model: 'Gemini', tokens: null, tokensEstimated: false, modelInferred: true });
    });

    it('prefers an explicit dispatch model over the executor-derived label', () => {
        const explicit = { executor: 'codex', model: 'gpt-5-codex', tokens: 100, started_at: '2026-07-08T10:00:00.000Z', completed_at: '2026-07-08T10:05:00.000Z' };
        const out = correlateDispatch(new Date('2026-07-08T10:03:00.000Z'), [explicit]);
        expect(out.model).toBe('gpt-5-codex');
        expect(out.modelInferred).toBe(false);
    });

    it('leaves model null when neither an explicit model nor a known executor is present', () => {
        const unknown = { executor: 'mystery-runner', model: null, tokens: 10, started_at: '2026-07-08T10:00:00.000Z', completed_at: '2026-07-08T10:05:00.000Z' };
        expect(correlateDispatch(new Date('2026-07-08T10:03:00.000Z'), [unknown]))
            .toEqual({ model: null, tokens: 10, tokensEstimated: false, modelInferred: false });
    });

    it('handles empty/invalid input without throwing', () => {
        expect(correlateDispatch(new Date('2026-07-08T10:00:00.000Z'), [])).toEqual({ model: null, tokens: null, tokensEstimated: false, modelInferred: false });
        expect(correlateDispatch(new Date('invalid'), [run])).toEqual({ model: null, tokens: null, tokensEstimated: false, modelInferred: false });
    });
});

describe('executorModelLabel', () => {
    it('maps known executors to a friendly model label', () => {
        expect(executorModelLabel('claude-code')).toBe('Claude');
        expect(executorModelLabel('codex')).toBe('Codex');
        expect(executorModelLabel('antigravity')).toBe('Gemini');
    });

    it('is case/space tolerant', () => {
        expect(executorModelLabel('  Codex ')).toBe('Codex');
        expect(executorModelLabel('ANTIGRAVITY')).toBe('Gemini');
    });

    it('returns null for unknown or missing executors', () => {
        expect(executorModelLabel('mystery')).toBeNull();
        expect(executorModelLabel(null)).toBeNull();
        expect(executorModelLabel(undefined)).toBeNull();
        expect(executorModelLabel('')).toBeNull();
    });
});
