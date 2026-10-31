function jsonResponse(body) {
    return {
        ok: true,
        json: jest.fn(async () => body)
    };
}

function brainCompletion({ content, reasoning_content, model = 'claude-sonnet-4-6', finish_reason } = {}) {
    return {
        model,
        choices: [{ message: { content, reasoning_content }, ...(finish_reason ? { finish_reason } : {}) }],
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

    test('relays direct config through Praxis /v1/llm/chat/completions with a model pin', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse(brainCompletion({ content: 'from claude' })));
        const { callAI } = require('../services/ai-service');

        const result = await callAI(
            { provider: 'anthropic', api_model_id: 'claude-sonnet-4-6' },
            'hello',
            'system prompt',
            [],
            { returnFullResult: true }
        );

        expect(global.fetch.mock.calls[0][0]).toBe('http://praxis.test/v1/llm/chat/completions');
        expect(global.fetch.mock.calls[0][1].headers['X-MCP-Caller']).toBe('nexus.ai-service');
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

    test('omits max_tokens unless the caller passes maxTokens', async () => {
        global.fetch
            .mockResolvedValueOnce(jsonResponse(brainCompletion({ content: 'one', finish_reason: 'stop' })))
            .mockResolvedValueOnce(jsonResponse(brainCompletion({ content: 'two', finish_reason: 'stop' })));
        const { callAI } = require('../services/ai-service');

        const result = await callAI({ provider: 'anthropic', api_model_id: 'claude-sonnet-4-6' }, 'hello', 'system', [], { returnFullResult: true });
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body).not.toHaveProperty('max_tokens');
        expect(result).toEqual(expect.objectContaining({ text: 'one', finishReason: 'stop', truncated: false }));

        await callAI({ provider: 'anthropic', api_model_id: 'claude-sonnet-4-6' }, 'hello', 'system', [], { maxTokens: 300 });
        expect(JSON.parse(global.fetch.mock.calls[1][1].body).max_tokens).toBe(300);
    });

    test('task-type calls omit max_tokens too', async () => {
        jest.doMock('../../db', () => ({
            getDefaultModelForTask: jest.fn(async () => ({ provider: 'anthropic', id: 'claude-sonnet-4-6', api_model_id: 'claude-sonnet-4-6' })),
            isDatabaseEnabled: () => false
        }));
        global.fetch.mockResolvedValueOnce(jsonResponse(brainCompletion({ content: 'feat: a thing', finish_reason: 'stop' })));
        const { callAI } = require('../services/ai-service');

        await expect(callAI('quick', 'diff', 'system')).resolves.toBe('feat: a thing');
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.role).toBe('brain.chat');
        expect(body).not.toHaveProperty('max_tokens');
        jest.dontMock('../../db');
    });

    test('a "length" stop is surfaced: flagged in the full result, thrown for plain text', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        global.fetch
            .mockResolvedValueOnce(jsonResponse(brainCompletion({ content: '{"script": "half a scr', finish_reason: 'length' })))
            .mockResolvedValueOnce(jsonResponse(brainCompletion({ content: 'half an answ', finish_reason: 'length' })));
        const { callAI } = require('../services/ai-service');

        const full = await callAI({ provider: 'anthropic', api_model_id: 'claude-sonnet-4-6' }, 'hello', 'system', [], { returnFullResult: true });
        expect(full).toEqual(expect.objectContaining({ text: '{"script": "half a scr', finishReason: 'length', truncated: true }));

        await expect(callAI({ provider: 'anthropic', api_model_id: 'claude-sonnet-4-6' }, 'hello', 'system'))
            .rejects.toMatchObject({ code: 'output_truncated', finishReason: 'length', partialText: 'half an answ', message: expect.stringMatching(/output limit/) });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stopped at its output limit/));
        warn.mockRestore();
    });

    test('a reasoning_content salvage that stopped for length stays flagged', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        global.fetch.mockResolvedValueOnce(jsonResponse(brainCompletion({
            content: '', reasoning_content: 'still thinking about', model: 'google/gemma-4-31b-qat', finish_reason: 'length'
        })));
        const { callAI } = require('../services/ai-service');

        const full = await callAI({ provider: 'local', api_model_id: 'google/gemma-4-31b-qat' }, 'hello', 'system', [], { returnFullResult: true });
        expect(full).toEqual(expect.objectContaining({ text: 'still thinking about', truncated: true, finishReason: 'length' }));
        warn.mockRestore();
    });

    test('surfaces relay failures with status and the whole body', async () => {
        const longBody = `praxis down: ${'x'.repeat(400)} end of body`;
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            text: jest.fn(async () => longBody),
        });
        const { callAI } = require('../services/ai-service');

        await expect(
            callAI({ provider: 'openai', api_model_id: 'gpt-5.5' }, 'hello', 'system')
        ).rejects.toThrow(/503.*praxis down.*end of body/s);
    });
});
