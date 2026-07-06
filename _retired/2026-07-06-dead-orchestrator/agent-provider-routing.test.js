describe('agent provider routing', () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock('@google/genai');
        jest.dontMock('../services/ai-service');
    });

    test('non-google agent runs through shared AI caller instead of Gemini client', async () => {
        const GoogleGenAI = jest.fn();
        const callAI = jest.fn(async () => ({ text: 'anthropic response', usage: { totalTokens: 1 } }));
        jest.doMock('@google/genai', () => ({ GoogleGenAI }));
        jest.doMock('../services/ai-service', () => ({ callAI }));

        const { runAgent } = require('../agent');
        const result = await runAgent({
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            task: 'Do the thing',
            systemPrompt: 'You are useful.'
        });

        expect(GoogleGenAI).not.toHaveBeenCalled();
        expect(callAI).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'anthropic',
            apiModelId: 'claude-sonnet-4-6'
        }), 'Do the thing', 'You are useful.', [], { returnFullResult: true });
        expect(result).toEqual(expect.objectContaining({ success: true, response: 'anthropic response' }));
    });
});
