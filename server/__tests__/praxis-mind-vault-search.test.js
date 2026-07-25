describe('praxis-mind vault_search dependency validation', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.dontMock('child_process');
    jest.dontMock('../../services/praxis-mind-mcp/lib/ledger');
  });

  function loadVaultSearchHandler() {
    const { register } = require('../../services/praxis-mind-mcp/tools/vault');
    const handlers = {};
    const server = {
      tool(name, _description, _schema, handler) {
        handlers[name] = handler;
      },
    };

    register(server, {
      caller: {
        identity: 'jest',
        privileges: ['vault.read'],
      },
    });

    return handlers.vault_search;
  }

  test('returns a clear error when ripgrep is not installed', async () => {
    jest.doMock('child_process', () => ({
      spawnSync: jest.fn(() => ({
        error: Object.assign(new Error('spawnSync rg ENOENT'), { code: 'ENOENT' }),
      })),
    }));
    jest.doMock('../../services/praxis-mind-mcp/lib/ledger', () => ({ record: jest.fn() }));

    const handler = loadVaultSearchHandler();
    const result = await handler({ query: 'needle-with-no-fixture-match', mode: 'grep' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ripgrep not installed/i);
    expect(result.content[0].text).toMatch(/install ripgrep/i);
  });

  test('returns ripgrep matches when ripgrep is installed', async () => {
    const spawnSync = jest
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'ripgrep 14.1.1\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: './skills/maintenance/example.md:12:Recover stale tasks with a restart.\n',
        stderr: '',
      });
    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('../../services/praxis-mind-mcp/lib/ledger', () => ({ record: jest.fn() }));

    const handler = loadVaultSearchHandler();
    const result = await handler({ query: 'stale tasks', mode: 'grep' });

    expect(result.isError).toBeUndefined();
    // Results ride inside the provenance envelope (server/lib/provenance.js —
    // mixed-provenance result sets are quoted advisory material), so assert the
    // match is present rather than that it is the entire payload.
    expect(result.content[0].text).toContain('skills/maintenance/example.md:12:Recover stale tasks with a restart.');
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'rg', ['--version'], { encoding: 'utf8' });
    expect(spawnSync.mock.calls[1][0]).toBe('rg');
    expect(spawnSync.mock.calls[1][1]).toContain('--max-count');
    expect(spawnSync.mock.calls[1][2]).toMatchObject({ cwd: '/Volumes/Projects/shared-mind' });
  });
});
