const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const configPath = path.resolve(__dirname, '../../services/praxis-mind-mcp/lib/config');

describe('MCP credential precedence', () => {
  let home;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-env-')); fs.mkdirSync(path.join(home, '.praxis-mind')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  function config({ explicit, fleet = 'fleet-key', legacy = 'legacy-key' } = {}) {
    const fleetPath = path.join(home, 'fleet-env');
    if (fleet !== null) fs.writeFileSync(fleetPath, `CORTEX_GATEWAY_KEY=${fleet}\n`);
    if (legacy !== null) fs.writeFileSync(path.join(home, '.praxis-mind/.env'), `CORTEX_GATEWAY_KEY=${legacy}\n`);
    const env = { ...process.env, HOME: home, FLEET_ENV_PATH: fleetPath };
    delete env.CORTEX_GATEWAY_KEY;
    if (explicit !== undefined) env.CORTEX_GATEWAY_KEY = explicit;
    return JSON.parse(execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(configPath)}); console.log(JSON.stringify({key:c.CORTEX_GATEWAY_KEY,source:c.CORTEX_GATEWAY_KEY_SOURCE}))`], { env, encoding: 'utf8' }));
  }
  test.each([
    [{}, { key: 'fleet-key', source: 'fleet_env' }],
    [{ explicit: 'client-key' }, { key: 'client-key', source: 'process_env' }],
    [{ explicit: '' }, { key: '', source: 'process_env' }],
    [{ fleet: null }, { key: 'legacy-key', source: 'legacy_env' }],
    [{ fleet: '' }, { key: '', source: 'fleet_env' }],
    [{ fleet: null, legacy: null }, { key: '', source: 'unset' }],
  ])('resolves %j without overriding explicit empty values', (input, expected) => expect(config(input)).toEqual(expected));
});

describe('MCP retrieval health', () => {
  let vault;
  beforeEach(() => {
    jest.resetModules();
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vault-'));
    fs.writeFileSync(path.join(vault, 'fixture.md'), 'needle content\n');
    jest.doMock('../../services/praxis-mind-mcp/lib/config', () => ({ VAULT: vault, CORTEX_GATEWAY: 'http://fixture', CORTEX_GATEWAY_KEY: '', HTTP_TIMEOUT_MS: 1000 }));
    jest.doMock('../../services/praxis-mind-mcp/lib/ledger', () => ({ record: jest.fn() }));
  });
  afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); jest.dontMock('child_process'); jest.dontMock('../../services/praxis-mind-mcp/lib/config'); jest.dontMock('../../services/praxis-mind-mcp/lib/ledger'); jest.restoreAllMocks(); jest.resetModules(); });
  function handler() {
    const handlers = {};
    require('../../services/praxis-mind-mcp/tools/vault').register({ tool: (name, _description, _schema, fn) => { handlers[name] = fn; } }, { caller: { identity: 'jest', privileges: ['vault.read'] } });
    return handlers.vault_search;
  }
  test.each(['', 'wrong-key'])('auth failure with key %j is degraded even when grep has no matches', async (key) => {
    require('../../services/praxis-mind-mcp/lib/config').CORTEX_GATEWAY_KEY = key;
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ detail: 'sensitive upstream body' }) });
    const result = await handler()({ query: 'absent' });
    expect(result.structuredContent).toMatchObject({ mode: 'grep', status: 'degraded', degraded_reason: 'authentication_failed', source_generated_at: null, results: [] });
    expect(result.structuredContent.fallback_notice).toContain('grep');
    expect(result.content[0].text).toContain('No matches.');
    expect(result.content[0].text).not.toContain('sensitive upstream body');
  });
  test('preserves hybrid source metadata and healthy empty results', async () => {
    const source = { mode: 'hybrid', generated: '2026-09-07T10:00:00Z', results: [], index_version: 3 };
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => JSON.stringify(source) });
    const result = await handler()({ query: 'absent' });
    expect(result.structuredContent).toMatchObject({ mode: 'hybrid', status: 'ok', degraded_reason: null, fallback_notice: null, source_generated_at: source.generated, source });
    expect(result.content[0].text).toContain('No results.');
  });
  test('grep fallback preserves matches', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await handler()({ query: 'needle' });
    expect(result.structuredContent).toMatchObject({ status: 'degraded', degraded_reason: 'backend_unavailable', results: ['fixture.md:1:needle content'] });
  });
  test('retains upstream degradation and per-result source metadata', async () => {
    const source = { mode: 'bm25', status: 'degraded', degraded_reason: 'embedding_unavailable', source_generated_at: '2026-09-07T10:00:00Z', fallback_notice: 'keyword search only', results: [{ path: 'fixture.md', score: 1, text: 'needle', source_url: 'https://example.test/source' }] };
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => JSON.stringify(source) });
    const result = await handler()({ query: 'needle' });
    expect(result.structuredContent).toMatchObject({ ...source, source });
  });
  test('reports failed fallback separately from an empty successful search', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 403, text: async () => '{}' });
    fs.rmSync(vault, { recursive: true });
    const result = await handler()({ query: 'needle' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ mode: 'grep', status: 'error', degraded_reason: 'authentication_failed', source_generated_at: null, results: [] });
    expect(result.structuredContent.fallback_notice).toContain('grep');
  });
  test('option-like query is searched as content', async () => {
    fs.writeFileSync(path.join(vault, 'option.md'), '--not-a-real-rg-option\n');
    const result = await handler()({ query: '--not-a-real-rg-option', mode: 'grep' });
    expect(result.structuredContent).toMatchObject({ status: 'ok', results: ['option.md:1:--not-a-real-rg-option'] });
  });
  test.each([
    [{ status: 2 }, { status: 2, stderr: 'private-secret', stdout: 'partial-secret' }],
    [{ status: 3, stderr: 'private-secret' }],
    [{ status: null, signal: 'SIGTERM', stderr: 'private-secret' }],
    [{ error: new Error('private-secret') }],
  ])('failed scan never becomes a healthy empty result or exposes raw errors: %j', async (...attempts) => {
    const spawnSync = jest.fn().mockReturnValueOnce({ status: 0 });
    for (const attempt of attempts) spawnSync.mockReturnValueOnce(attempt);
    jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), spawnSync }));
    const result = await handler()({ query: 'needle', mode: 'grep' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'error', results: [] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  test('literal retry exit 1 remains a valid empty scan', async () => {
    const spawnSync = jest.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 2 }).mockReturnValueOnce({ status: 1, stdout: '' });
    jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), spawnSync }));
    const result = await handler()({ query: '[', mode: 'grep' });
    expect(result.structuredContent).toMatchObject({ status: 'ok', results: [] });
    expect(spawnSync.mock.calls[2][1]).toContain('--fixed-strings');
  });
  test('explicit grep is healthy', async () => {
    const result = await handler()({ query: 'needle', mode: 'grep' });
    expect(result.structuredContent).toMatchObject({ mode: 'grep', status: 'ok', degraded_reason: null, fallback_notice: null });
  });
});
