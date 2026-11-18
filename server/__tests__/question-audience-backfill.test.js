const Database = require('better-sqlite3');
const { backfillQuestionAudience } = require('../../db/question-audience-backfill');

test('the board backfill inventories each open need and keeps corrections and answer history on rerun', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE projects (id TEXT, name TEXT, status TEXT, needs TEXT, updated_at TEXT)');
    db.exec(`CREATE TABLE contacts (id TEXT, name TEXT, kind TEXT);
        CREATE TABLE project_contacts (project_id TEXT, contact_id TEXT);
        INSERT INTO contacts VALUES ('clay','Clay','human');
        INSERT INTO project_contacts VALUES ('a','clay')`);
    const add = db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)');
    const need = (id, owner, extra = {}) => ({
        id, status: 'open', kind: 'information', description: id,
        knowledge: { question: 'What time?', satisfaction_test: 'Time recorded', evidence: [],
            resolution: { method: 'human', owner }, revision: 4, ...extra },
    });
    const source = [need('client', 'Clay (via Robert-reviewed email)'), need('operator', 'Robert'),
        need('held', 'respondent'), need('corrected', 'Clay', { client_facing: false }),
        { ...need('closed', 'Clay'), status: 'met' }];
    add.run('a', 'Active', 'active', JSON.stringify(source), '2026-03-01T00:00:00Z');
    add.run('b', 'Archived', 'archived', JSON.stringify([need('research', 'Praxis', { resolution: { method: 'research' } })]), '2026-03-01T00:00:00Z');
    const rows = backfillQuestionAudience(db);
    expect(rows.map(r => [r.id, r.client_facing])).toEqual([
        ['client', true], ['operator', false], ['held', null], ['corrected', false], ['research', false],
    ]);
    const read = () => db.prepare('SELECT needs, updated_at FROM projects ORDER BY id').all();
    const stored = read();
    const needs = JSON.parse(stored[0].needs);
    expect(needs[0].knowledge.history).toEqual([expect.objectContaining({ revision: 4, audience_changed_to: true })]);
    expect(needs[0].knowledge.revision).toBe(4);
    expect(needs.slice(2)).toEqual(source.slice(2));
    expect(backfillQuestionAudience(db)).toEqual([]);
    expect(read()).toEqual(stored);
    db.close();
});
