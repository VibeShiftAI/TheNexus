/**
 * vault_write supersession (Praxis task e524649b, PART 3): a replacement
 * written with `supersedes: [...]` gains the `supersedes` frontmatter and
 * every named old memory is stamped `status: superseded` +
 * `superseded_by: <replacement>` — in the shape the vault watcher's
 * readSupersession() honours, so MEMORY.md and the search index drop them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function serverHarness() {
  const handlers = {};
  return {
    handlers,
    server: {
      tool(name, _description, _schema, handler) {
        handlers[name] = handler;
      },
    },
  };
}

const caller = {
  identity: 'jest-agent',
  namespace: 'coding-agents-jest',
  privileges: ['vault.write', 'vault.read'],
};

const OLD = `---
name: feedback_fable_out_routing_2026-07-20
description: "QA rounds go to Opus 4.8"
metadata:
  type: feedback
---

Robert's rule (2026-07-20): QA rounds go to Opus 4.8.
`;

describe('praxis-mind vault_write supersession', () => {
  let vault;
  let handlers;

  beforeEach(() => {
    jest.resetModules();
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-mind-supersede-'));
    fs.mkdirSync(path.join(vault, 'memories'));
    fs.writeFileSync(path.join(vault, 'memories', 'feedback_fable_out_routing_2026-07-20.md'), OLD, 'utf8');
    fs.writeFileSync(path.join(vault, 'memories', 'reference_other.md'), '---\nname: reference_other\n---\n\nunrelated\n', 'utf8');
    process.env.PRAXIS_MIND_TRANSITION_LOG = path.join(vault, 'transitions.jsonl');

    const realConfig = jest.requireActual('../../services/praxis-mind-mcp/lib/config');
    jest.doMock('../../services/praxis-mind-mcp/lib/config', () => ({ ...realConfig, VAULT: vault }));
    jest.doMock('../../services/praxis-mind-mcp/lib/ledger', () => ({ record: jest.fn() }));
    jest.doMock('../../services/praxis-mind-mcp/lib/lock-health', () => ({
      record: jest.fn(),
      gauge: jest.fn(() => null),
      formatGauge: jest.fn(() => 'gauge disabled in test'),
    }));
    jest.doMock('../../services/praxis-mind-mcp/lib/backends', () => ({}));
    jest.doMock('../../services/praxis-mind-mcp/lib/ratelimit', () => ({
      checkAndIncrement: () => ({ allowed: true, count: 1, limit: 100 }),
    }));

    const harness = serverHarness();
    require('../../services/praxis-mind-mcp/tools/vault').register(harness.server, { caller });
    handlers = harness.handlers;
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    delete process.env.PRAXIS_MIND_TRANSITION_LOG;
  });

  test('writes the replacement with supersedes: and retires each named old memory', async () => {
    const res = await handlers.vault_write({
      path: 'memories/reference_fable_out_routing.md',
      content: '---\nname: reference_fable_out_routing\nmetadata:\n  type: reference\n---\n\nThe current rule.\n',
      mode: 'replace',
      supersedes: ['feedback_fable_out_routing_2026-07-20'],
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/superseded feedback_fable_out_routing_2026-07-20/);

    const replacement = fs.readFileSync(path.join(vault, 'memories', 'reference_fable_out_routing.md'), 'utf8');
    expect(replacement).toMatch(/^supersedes: \[feedback_fable_out_routing_2026-07-20\]$/m);
    expect(replacement).toMatch(/The current rule\./);

    const old = fs.readFileSync(path.join(vault, 'memories', 'feedback_fable_out_routing_2026-07-20.md'), 'utf8');
    expect(old).toMatch(/^status: superseded$/m);
    expect(old).toMatch(/^superseded_by: reference_fable_out_routing$/m);
    expect(old).toMatch(/^superseded_at: \d{4}-\d{2}-\d{2}T/m);
    expect(old).toMatch(/Robert's rule \(2026-07-20\): QA rounds go to Opus 4.8\./);
    expect(old).toMatch(/^description: "QA rounds go to Opus 4.8"$/m);

    // The watcher's own parser agrees — this is the contract sr-g honours.
    const { readSupersession, collectMemoryEntries } = require('../../services/vault-watcher/index.js');
    expect(readSupersession(old)).toEqual({ superseded: true, supersedes: 0 });
    expect(readSupersession(replacement)).toEqual({ superseded: false, supersedes: 1 });
    const indexed = collectMemoryEntries(path.join(vault, 'memories')).map((e) => e.name);
    expect(indexed).toEqual(['reference_fable_out_routing', 'reference_other']);
  });

  test('rejects a supersedes name that does not exist, before any write', async () => {
    const res = await handlers.vault_write({
      path: 'memories/reference_new.md',
      content: '---\nname: reference_new\n---\n\nx\n',
      mode: 'replace',
      supersedes: ['reference_never_existed'],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/does not exist/);
    expect(fs.existsSync(path.join(vault, 'memories', 'reference_new.md'))).toBe(false);
  });

  test('rejects supersedes with mode append', async () => {
    const res = await handlers.vault_write({
      path: 'memories/reference_other.md',
      content: '\nmore\n',
      mode: 'append',
      supersedes: ['feedback_fable_out_routing_2026-07-20'],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/requires mode "replace"/);
  });

  test('a write without supersedes is unchanged behaviour', async () => {
    const res = await handlers.vault_write({ path: 'memories/reference_plain.md', content: 'plain', mode: 'replace' });
    expect(res.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(vault, 'memories', 'reference_plain.md'), 'utf8')).toBe('plain');
    expect(res.content[0].text).not.toMatch(/superseded/);
  });
});
