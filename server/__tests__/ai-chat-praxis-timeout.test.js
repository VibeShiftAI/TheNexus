const express = require('express');
const createAIChatRouter = require('../routes/ai-chat');

describe('AI chat Praxis proxy timeout', () => {
  const originalFetch = global.fetch;
  const originalAbortSignal = global.AbortSignal;
  const originalTimeoutEnv = process.env.PRAXIS_CHAT_TIMEOUT_MS;

  afterEach(() => {
    global.fetch = originalFetch;
    global.AbortSignal = originalAbortSignal;
    if (originalTimeoutEnv === undefined) {
      delete process.env.PRAXIS_CHAT_TIMEOUT_MS;
    } else {
      process.env.PRAXIS_CHAT_TIMEOUT_MS = originalTimeoutEnv;
    }
    jest.clearAllMocks();
  });

  function appWithPraxisRoute() {
    const app = express();
    app.use(express.json());
    app.use('/api/ai/chat', createAIChatRouter({
      db: { getActiveConversation: jest.fn().mockResolvedValue(null) },
      callAI: jest.fn(),
      pushService: {},
      io: null,
    }));
    return app;
  }

  it('gives local Praxis runs a 20-minute default response budget', async () => {
    delete process.env.PRAXIS_CHAT_TIMEOUT_MS;
    const timeout = jest.fn(() => 'praxis-signal');
    global.AbortSignal = { timeout };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'systems nominal' }),
    });

    const app = appWithPraxisRoute();
    const res = await new Promise((resolve) => {
      app.handle({
        method: 'POST',
        url: '/api/ai/chat',
        headers: { 'content-type': 'application/json' },
        body: {
          message: 'systems check please',
          mode: 'praxis',
          history: [],
        },
      }, {
        statusCode: 200,
        headers: {},
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        getHeader(name) { return this.headers[name.toLowerCase()]; },
        end(body) { resolve({ statusCode: this.statusCode, body }); },
        json(body) {
          this.setHeader('content-type', 'application/json');
          this.end(JSON.stringify(body));
        },
        status(code) { this.statusCode = code; return this; },
      });
    });

    expect(res.statusCode).toBe(200);
    expect(timeout).toHaveBeenCalledWith(20 * 60 * 1000);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:54322/api/chat',
      expect.objectContaining({ signal: 'praxis-signal' }),
    );
  });
});
