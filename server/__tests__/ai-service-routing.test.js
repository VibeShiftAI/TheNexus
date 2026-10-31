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

describe('context window lookup (services/context-window.js)', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;

    function windowResponse(body, status = 200) {
        return { ok: status >= 200 && status < 300, status, json: jest.fn(async () => body), text: jest.fn(async () => JSON.stringify(body)) };
    }

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv, PRAXIS_URL: 'http://praxis.test' };
        global.fetch = jest.fn();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = originalEnv;
        global.fetch = originalFetch;
        console.warn.mockRestore();
        jest.dontMock('../../db');
    });

    test('asks Praxis for the role a task-type call rides, and for the pin of a direct call', async () => {
        jest.doMock('../../db', () => ({
            getDefaultModelForTask: jest.fn(async () => ({ provider: 'anthropic', id: 'claude-sonnet-4-6', api_model_id: 'claude-sonnet-4-6' })),
            isDatabaseEnabled: () => false
        }));
        global.fetch.mockResolvedValue(windowResponse({ window: { tokens: 200000, maxOutputTokens: 64000, source: 'claude-code claude-sonnet-4-6 run report' }, charsPerToken: 3 }));
        const { contextWindowFor } = require('../services/context-window');

        await expect(contextWindowFor('quick')).resolves.toEqual({ tokens: 200000, maxOutputTokens: 64000, source: 'claude-code claude-sonnet-4-6 run report', charsPerToken: 3 });
        expect(global.fetch.mock.calls[0][0]).toBe('http://praxis.test/v1/llm/context-window?role=brain.chat');

        await contextWindowFor({ provider: 'local', model: 'gemma4' });
        expect(global.fetch.mock.calls[1][0]).toBe('http://praxis.test/v1/llm/context-window?provider=local&model=gemma4');

        // Cached briefly: the same target does not ask again.
        await contextWindowFor({ provider: 'local', model: 'gemma4' });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('a Praxis 404 (not restarted onto the route), a null window, an error or a missing charsPerToken is unknown', async () => {
        const { contextWindowFor } = require('../services/context-window');
        global.fetch.mockResolvedValueOnce(windowResponse({ error: 'not found' }, 404));
        await expect(contextWindowFor({ provider: 'local', model: 'a' })).resolves.toBeNull();

        global.fetch.mockResolvedValueOnce(windowResponse({ window: null, charsPerToken: 3 }));
        await expect(contextWindowFor({ provider: 'local', model: 'b' })).resolves.toBeNull();

        global.fetch.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
        await expect(contextWindowFor({ provider: 'local', model: 'c' })).resolves.toBeNull();

        global.fetch.mockResolvedValueOnce(windowResponse({ window: { tokens: 8192, source: 'LM Studio d loaded context' } }));
        await expect(contextWindowFor({ provider: 'local', model: 'd' })).resolves.toBeNull();
    });

    test('a call target that cannot be resolved is unknown, not an error', async () => {
        const { contextWindowFor } = require('../services/context-window');
        const resolveCallTarget = jest.fn(async () => { throw new Error('No model configuration found'); });
        await expect(contextWindowFor('quick', { resolveCallTarget })).resolves.toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('fitToWindow keeps a text whole when it fits or the window is unknown, and cuts it with a note and the whole text on disk when not', () => {
        const fs = require('fs');
        const { fitToWindow } = require('../services/context-window');
        const text = 'a'.repeat(5000) + 'TAIL';

        expect(fitToWindow(text, { window: null, share: 0.5, label: 'Thing' })).toEqual(expect.objectContaining({ text, whole: true }));
        expect(fitToWindow(text, { window: { tokens: 10000, source: 's', charsPerToken: 3 }, share: 0.5, label: 'Thing' })).toEqual(expect.objectContaining({ text, whole: true }));

        const cut = fitToWindow(text, { window: { tokens: 1000, source: 'LM Studio test loaded context', charsPerToken: 3 }, share: 0.5, label: 'Thing' });
        expect(cut.whole).toBe(false);
        expect(cut.text.length).toBeLessThanOrEqual(1500);
        expect(cut.text).not.toContain('TAIL');
        expect(cut.text).toMatch(/\[Thing: 5,004 characters, too large for this model's context window \(1,000 tokens, LM Studio test loaded context\) alongside the rest of the request\. The first [\d,]+ are above; the whole text is in .+\.\]$/);
        expect(cut.fullTextPath.startsWith(process.env.NEXUS_MODEL_INPUTS_DIR)).toBe(true);
        expect(fs.readFileSync(cut.fullTextPath, 'utf8')).toBe(text);
        expect(cut.text).toContain(cut.fullTextPath);
    });
});
