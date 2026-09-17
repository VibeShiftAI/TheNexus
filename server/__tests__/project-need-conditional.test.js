const fs = require('fs');
const os = require('os');
const path = require('path');

describe('atomic project need projection', () => {
  let directory, db, raw;
  const need = { id: 'n', status: 'open', notes: '', description: 'Choose a policy', kind: 'decision' };
  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-need-cas-'));
    process.env.NEXUS_DB_PATH = path.join(directory, 'test.db');
    jest.resetModules(); db = require('../../db');
    raw = new (require('better-sqlite3'))(process.env.NEXUS_DB_PATH);
    raw.prepare("INSERT INTO projects (id,name,path) VALUES ('p','Praxis','/praxis')").run();
  });
  beforeEach(() => raw.prepare('UPDATE projects SET needs=? WHERE id=?').run(JSON.stringify([need, { ...need, id: 'sibling', notes: 'A newer sibling edit' }]), 'p'));
  afterAll(() => { raw.close(); delete process.env.NEXUS_DB_PATH; fs.rmSync(directory, { recursive: true, force: true }); });
  test('projects an answer against the current snapshot and preserves concurrent sibling data', () => {
    const result = db.updateProjectNeed('p', 'n', { notes: 'Robert answered', expected: need });
    expect(result.success).toBe(true);
    expect(result.need.status).toBe('open');
    expect(result.needs[1].notes).toBe('A newer sibling edit');
  });
  test('a stale answer cannot overwrite a newer manual edit or terminal decision', () => {
    for (const changed of [{ ...need, notes: 'Manual edit' }, { ...need, status: 'dropped' }]) {
      raw.prepare('UPDATE projects SET needs=? WHERE id=?').run(JSON.stringify([changed]), 'p');
      expect(db.updateProjectNeed('p', 'n', { notes: 'Old answer', expected: need }).conflict).toBe(true);
      expect(JSON.parse(raw.prepare('SELECT needs FROM projects WHERE id=?').get('p').needs)).toEqual([changed]);
    }
  });
  test('ordinary explicit updates still work and malformed stored data fails closed', () => {
    expect(db.updateProjectNeed('p', 'n', { status: 'met' }).need.status).toBe('met');
    raw.prepare('UPDATE projects SET needs=? WHERE id=?').run('{bad', 'p');
    expect(db.updateProjectNeed('p', 'n', { notes: 'Answer' })).toBeNull();
    expect(raw.prepare('SELECT needs FROM projects WHERE id=?').get('p').needs).toBe('{bad');
  });
});
