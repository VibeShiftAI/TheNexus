const { z } = require('zod');

const SVC = '../../services/praxis-mind-mcp';

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    server: {
      tool(name, _description, schema, handler) {
        tools.set(name, {
          schema,
          invoke: (args) => handler(z.object(schema).parse(args)),
        });
      },
    },
  };
}

describe('praxis-mind memory_search contract', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock(`${SVC}/lib/config`, () => ({
      CORTEX_GATEWAY: 'http://cortex.test',
      CORTEX_GATEWAY_KEY: 'gateway-key',
      HTTP_TIMEOUT_MS: 1000,
    }));
    jest.doMock(`${SVC}/lib/ledger`, () => ({ record: jest.fn() }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  function register(privileges = ['memory.search']) {
    const registry = fakeServer();
    require(`${SVC}/tools/memory`).register(registry.server, {
      caller: { identity: 'jest', namespace: 'coding-agents-jest', privileges },
    });
    return registry.tools.get('memory_search');
  }

  test('sends gateway field names and applies public defaults', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ matches: [] }),
    });

    await register().invoke({ query: 'bounded retrieval' });

    const [url, request] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://cortex.test/api/memory/search');
    expect(request.headers).toMatchObject({ 'X-Gateway-Key': 'gateway-key' });
    expect(JSON.parse(request.body)).toEqual({
      query: 'bounded retrieval',
      max_results: 10,
      namespace: 'ai-research',
      evidence_only: false,
      include_query_expansion: true,
    });
  });

  test('forwards bounds and explicit false boolean options', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ matches: [] }),
    });

    await register().invoke({
      query: 'exact query',
      k: 50,
      namespace: 'identity',
      evidence_only: true,
      include_query_expansion: false,
    });

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      query: 'exact query',
      max_results: 50,
      namespace: 'identity',
      evidence_only: true,
      include_query_expansion: false,
    });
    expect(() => register().invoke({ query: 'too many', k: 51 })).toThrow();
  });

  test('rejects missing privilege before calling Cortex', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const result = await register([]).invoke({ query: 'secret' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('memory.search');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('preserves the retrieval provenance envelope', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ matches: [{ text: 'fixture' }] }),
    });

    const result = await register().invoke({ query: 'fixture', namespace: 'identity' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('cortex:search:identity');
    expect(result.content[0].text).toContain('fixture');
  });

  test('returns a tool error when Cortex rejects the request', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ detail: 'invalid request' }),
    });

    const result = await register().invoke({ query: 'fixture' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('memory_search failed: HTTP 422');
  });
});
