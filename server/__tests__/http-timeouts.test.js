const { configureLongRunningRequestTimeouts } = require('../utils/http-timeouts');

describe('HTTP server long-running request timeouts', () => {
  it('keeps the server request timeout above the Praxis chat budget', () => {
    const server = {};

    configureLongRunningRequestTimeouts(server, {
      praxisChatTimeoutMs: 20 * 60 * 1000,
    });

    expect(server.requestTimeout).toBe(21 * 60 * 1000);
    expect(server.headersTimeout).toBeGreaterThanOrEqual(65 * 1000);
  });
});
