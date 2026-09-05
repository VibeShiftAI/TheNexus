describe('MCP task version wire contract', () => {
  let originalFetch;
  beforeEach(() => { jest.resetModules(); originalFetch = global.fetch; global.fetch = jest.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })); });
  afterEach(() => { global.fetch = originalFetch; });
  test('sends the captured revision without adding an omitted status', async () => {
    const { nexusTaskUpdate } = require('../../services/praxis-mind-mcp/lib/backends');
    await nexusTaskUpdate('task-1', { expected_version: 7, antigravity_payload: { prompt: 'verify' } });
    const wire = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(wire).toEqual({ expected_version: 7, antigravity_payload: { prompt: 'verify' } });
  });
  test('refuses a versionless write instead of silently losing CAS on older servers', async () => {
    const { nexusTaskUpdate } = require('../../services/praxis-mind-mcp/lib/backends');
    await expect(nexusTaskUpdate('task-1', { description: 'edit' })).rejects.toThrow(/version/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
