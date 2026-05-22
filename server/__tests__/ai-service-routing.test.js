function jsonResponse(body) {
    return {
        ok: true,
        json: jest.fn(async () => body)
    };
}

describe('AI service provider routing', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.resetModules();
        process.env = {
            ...originalEnv,
            ANTHROPIC_API_KEY: 'anthropic-key',
            OPENAI_API_KEY: 'openai-key',
            LOCAL_AI_URL: 'http://127.0.0.1:11434/v1'
        };
        global.fetch = jest.fn();
    });

    afterEach(() => {
        process.env = originalEnv;
        global.fetch = originalFetch;
    });

    test('routes anthropic config to Anthropic messages API and reports model metadata', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse({
            content: [{ type: 'text', text: 'from claude' }],
            usage: { input_tokens: 3, output_tokens: 4 }
        }));
        const { callAI } = require('../services/ai-service');

        const result = await callAI(
            { provider: 'anthropic', api_model_id: 'claude-sonnet-4-6' },
            'hello',
            'system',
            [],
            { returnFullResult: true }
        );

        expect(global.fetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('claude-sonnet-4-6');
        expect(result).toEqual(expect.objectContaining({
            text: 'from claude',
            provider: 'anthropic',
            model: 'claude-sonnet-4-6'
        }));
    });

    test('routes openai config to OpenAI chat completions API', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse({
            choices: [{ message: { content: 'from openai' } }],
            usage: { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 }
        }));
        const { callAI } = require('../services/ai-service');

        await callAI(
            { provider: 'openai', api_model_id: 'gpt-5' },
            'hello',
            'system',
            [],
            { returnFullResult: true }
        );

        expect(global.fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('gpt-5');
    });

    test('routes local config to configured local OpenAI-compatible endpoint', async () => {
        global.fetch.mockResolvedValueOnce(jsonResponse({
            choices: [{ message: { content: 'from local' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
        const { callAI } = require('../services/ai-service');

        await callAI(
            { provider: 'local', api_model_id: 'llama3.2' },
            'hello',
            'system',
            [],
            { returnFullResult: true }
        );

        expect(global.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('llama3.2');
    });
});
