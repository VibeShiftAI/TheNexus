function jsonResponse(body) {
    return {
        ok: true,
        json: jest.fn(async () => body)
    };
}

function brainCompletion({ content, reasoning_content, model = 'claude-sonnet-4-6' } = {}) {
    return {
        model,
        choices: [{ message: { content, reasoning_content } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    };
}

describe('AI service Praxis relay', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv, PRAXIS_URL: 'http://praxis.test' };
        global.fetch = jest.fn();
    });

    afterEach(() => {
        process.env = originalEnv;
        global.fetch = originalFetch;
    });

    test('relays direct config through Praxis /v1/brain/chat with a model pin', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse(brainCompletion({ content: 'from claude' })));
        const { callAI } = require('../services/ai-service');

        const result = await callAI(
            { provider: 'anthropic', api_model_id: 'claude-sonnet-4-6' },
            'hello',
            'system prompt',
            [],
            { returnFullResult: true }
        );

        expect(global.fetch.mock.calls[0][0]).toBe('http://praxis.test/v1/brain/chat');
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.provider).toBe('anthropic');
        expect(body.model).toBe('claude-sonnet-4-6');
        expect(body.system).toBe('system prompt');
        expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
        expect(result).toEqual(expect.objectContaining({
            text: 'from claude',
            provider: 'anthropic',
            model: 'claude-sonnet-4-6'
        }));
        expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    });

    test('normalizes provider aliases and gemini-style history roles', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse(brainCompletion({ content: 'ok' })));
        const { callAI } = require('../services/ai-service');

        await callAI(
            { provider: 'gemini', api_model_id: 'gemini-3.5-flash' },
            'follow-up',
            null,
            [
                { role: 'user', content: 'earlier question' },
                { role: 'model', content: 'earlier answer' }
            ]
        );

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.provider).toBe('google');
        expect(body.messages).toEqual([
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
            { role: 'user', content: 'follow-up' }
        ]);
    });

    test('salvages reasoning_content when content is empty (local Gemma)', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse(brainCompletion({
            content: '',
            reasoning_content: 'answer via reasoning channel',
            model: 'google/gemma-4-31b-qat'
        })));
        const { callAI } = require('../services/ai-service');

        const text = await callAI(
            { provider: 'local', api_model_id: 'google/gemma-4-31b-qat' },
            'hello',
            'system'
        );

        expect(text).toBe('answer via reasoning channel');
    });

    test('surfaces relay failures with status and body excerpt', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            text: jest.fn(async () => 'praxis down'),
        });
        const { callAI } = require('../services/ai-service');

        await expect(
            callAI({ provider: 'openai', api_model_id: 'gpt-5.5' }, 'hello', 'system')
        ).rejects.toThrow(/503.*praxis down/s);
    });
});
