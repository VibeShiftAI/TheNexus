const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const contract = require('@praxis/contract');
const observation = (text, extra = {}) => ({ kind: 'observation', text, evidence: 'observed', source: 'operator', ...extra });
const fact = (text, extra = {}) => observation(text, { kind: 'fact', fact_key: 'tone', ...extra });
let raw;
let now;
let ledger;
let member;
let second;
let project;
let otherProject;

function setup() {
    expect(() => require('../../db/member-memory')).not.toThrow();
    const { initializeMemberMemory, createMemberMemoryLedger } = require('../../db/member-memory');
    raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, interaction_log TEXT); CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE project_contacts (project_id TEXT, contact_id TEXT, PRIMARY KEY(project_id, contact_id))');
    member = randomUUID(); second = randomUUID(); project = randomUUID(); otherProject = randomUUID();
    raw.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run(member, 'Same Name', '[]');
    raw.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run(second, 'Same Name', '[]');
    for (const id of [project, otherProject]) {
        raw.prepare('INSERT INTO projects VALUES (?)').run(id);
        raw.prepare('INSERT INTO project_contacts VALUES (?, ?)').run(id, member);
    }
    now = '2026-09-07T12:00:00.000Z';
    initializeMemberMemory(raw);
    ledger = createMemberMemoryLedger(raw, { now: () => now });
}

describe('member memory ledger', () => {
    beforeEach(setup);
    afterEach(() => { raw?.close(); raw = null; });

    test('persists full text beyond 200 events and paginates without overlap', () => {
        for (let i = 0; i < 205; i++) ledger.append(member, observation(`${i}:` + 'a'.repeat(4000)));
        const first = ledger.snapshot(member, { limit: 100 });
        expect(first.total_events).toBe(205);
        expect(first.timeline).toHaveLength(100);
        const next = ledger.snapshot(member, { limit: 100, before_seq: first.next_before_seq });
        const last = ledger.snapshot(member, { limit: 100, before_seq: next.next_before_seq });
        expect(last.timeline).toHaveLength(5);
        expect(last.next_before_seq).toBeNull();
        const entries = [...first.timeline, ...next.timeline, ...last.timeline];
        expect(new Set(entries.map(e => e.id)).size).toBe(205);
        expect(entries.at(-1).text).toBe('0:' + 'a'.repeat(4000));
        expect(contract.MemberMemorySnapshotSchema.safeParse(first).success).toBe(true);
        expect(ledger.snapshot(second).total_events).toBe(0);
        expect(() => raw.prepare('UPDATE member_memory_events SET text = ?').run('tampered')).toThrow(/append.only/i);
        expect(() => raw.exec('DELETE FROM member_memory_events')).toThrow(/append.only/i);
    });

    test('paging and correcting do not materialize the full observation history', () => {
        const original = ledger.append(member, fact('Keep current across pages'));
        for (let i = 0; i < 250; i++) ledger.append(member, observation(`${i}:` + 'x'.repeat(4000)));
        // Measure records crossing the SQLite boundary, independent of SQL syntax.
        // A growing observation archive must not grow the materialized read page.
        const prepare = raw.prepare.bind(raw);
        let loadedObservations = 0;
        const spy = jest.spyOn(raw, 'prepare').mockImplementation(sql => {
            const statement = prepare(sql);
            const all = statement.all.bind(statement);
            statement.all = (...args) => {
                const rows = all(...args);
                loadedObservations += rows.filter(row => row.kind === 'observation' && typeof row.text === 'string').length;
                return rows;
            };
            return statement;
        });
        try {
            const page = ledger.snapshot(member, { limit: 7 });
            expect(page.total_events).toBe(251);
            expect(page.timeline).toHaveLength(7);
            expect(page.current_facts.map(event => event.id)).toEqual([original.id]);
            expect(loadedObservations).toBeLessThanOrEqual(8);
            loadedObservations = 0;
            const next = ledger.snapshot(member, { limit: 7, before_seq: page.next_before_seq });
            expect(next.timeline[0].seq).toBeLessThan(page.next_before_seq);
            expect(loadedObservations).toBeLessThanOrEqual(8);
            loadedObservations = 0;
            ledger.append(member, fact('Corrected', { supersedes_id: original.id }));
            expect(loadedObservations).toBe(0);
        } finally { spy.mockRestore(); }
    });

    test('reads exact scope after unlink, requires membership for writes, and rejects cross targets', () => {
        const general = ledger.append(member, fact('General'));
        const scoped = ledger.append(member, fact('Project', { project_id: project }));
        ledger.append(member, fact('Other', { project_id: otherProject }));
        expect(ledger.snapshot(member).timeline.map(e => e.id)).toEqual([general.id]);
        expect(ledger.snapshot(member, { project_id: project }).timeline.map(e => e.id)).toEqual([scoped.id]);
        expect(() => ledger.append(member, fact('Wrong scope', { project_id: project, supersedes_id: general.id }))).toThrow(expect.objectContaining({ status: 409 }));
        expect(() => ledger.append(second, fact('Wrong person', { supersedes_id: general.id }))).toThrow(expect.objectContaining({ status: 409 }));
        raw.prepare('DELETE FROM project_contacts WHERE project_id = ?').run(project);
        expect(ledger.snapshot(member, { project_id: project }).total_events).toBe(1);
        expect(() => ledger.append(member, observation('Unlinked', { project_id: project }))).toThrow(expect.objectContaining({ status: 409 }));
    });

    test('surfaces conflicting values and preserves inferred evidence without recency wins', () => {
        const a = ledger.append(member, fact('Brief', { evidence: 'operator_confirmed' }));
        const b = ledger.append(member, fact('Detailed', { evidence: 'inferred' }));
        const c = ledger.append(member, fact('Brief', { evidence: 'self_reported' }));
        const snapshot = ledger.snapshot(member);
        expect(new Set(snapshot.current_facts.map(e => e.id))).toEqual(new Set([a.id, b.id, c.id]));
        expect(snapshot.conflicts).toHaveLength(1);
        expect(snapshot.conflicts[0].events.find(e => e.id === b.id).evidence).toBe('inferred');
        ledger.append(member, observation('Retract inference', { kind: 'retraction', target_id: b.id }));
        expect(ledger.snapshot(member).conflicts).toEqual([]);
    });

    test('correction transitions reject stale and wrong-key targets atomically', () => {
        const original = ledger.append(member, fact('Original'));
        expect(() => ledger.append(member, fact('Wrong key', { fact_key: 'availability', supersedes_id: original.id }))).toThrow(expect.objectContaining({ status: 409 }));
        const correction = ledger.append(member, fact('Corrected', { supersedes_id: original.id }));
        expect(ledger.snapshot(member).current_facts.map(e => e.id)).toEqual([correction.id]);
        expect(() => ledger.append(member, fact('Stale', { supersedes_id: original.id }))).toThrow(expect.objectContaining({ status: 409 }));
        expect(() => ledger.append(member, observation('Stale retract', { kind: 'retraction', target_id: original.id }))).toThrow(expect.objectContaining({ status: 409 }));
        expect(ledger.snapshot(member).total_events).toBe(2);
    });

    test('future correction starts at its effective time and an expired replacement never resurrects old facts', () => {
        const original = ledger.append(member, fact('Original'));
        const correction = ledger.append(member, fact('Future', { supersedes_id: original.id, valid_from: '2026-09-08T00:00:00Z', valid_until: '2026-09-09T00:00:00Z' }));
        expect(ledger.snapshot(member).current_facts.map(e => e.id)).toEqual([original.id]);
        expect(() => ledger.append(member, fact('Racing', { supersedes_id: original.id }))).toThrow(expect.objectContaining({ status: 409 }));
        now = '2026-09-08T12:00:00.000Z';
        expect(ledger.snapshot(member).current_facts.map(e => e.id)).toEqual([correction.id]);
        now = '2026-09-10T12:00:00.000Z';
        expect(ledger.snapshot(member).current_facts).toEqual([]);
        expect(ledger.snapshot(member).timeline).toHaveLength(2);
    });

    test('retracting a scheduled correction preserves its predecessor and releases the reservation', () => {
        const original = ledger.append(member, fact('Original'));
        const scheduled = ledger.append(member, fact('Mistaken future', { supersedes_id: original.id, valid_from: '2026-09-08T00:00:00Z' }));
        ledger.append(member, observation('Cancel scheduled mistake', { kind: 'retraction', target_id: scheduled.id }));
        expect(ledger.snapshot(member).current_facts.map(e => e.id)).toEqual([original.id]);
        now = '2026-09-09T12:00:00.000Z';
        expect(ledger.snapshot(member).current_facts.map(e => e.id)).toEqual([original.id]);
        const fixed = ledger.append(member, fact('Correct replacement', { supersedes_id: original.id }));
        expect(ledger.snapshot(member).current_facts.map(e => e.id)).toEqual([fixed.id]);
        ledger.append(member, observation('Withdraw effective replacement', { kind: 'retraction', target_id: fixed.id }));
        expect(ledger.snapshot(member).current_facts).toEqual([]);
    });

    test('unknown projects fail unless exact historical scope remains after project deletion', () => {
        expect(() => ledger.snapshot(member, { project_id: randomUUID() })).toThrow(expect.objectContaining({ status: 404 }));
        expect(() => ledger.append(member, observation('Missing project', { project_id: randomUUID() }))).toThrow(expect.objectContaining({ status: 404 }));
        ledger.append(member, observation('Historical', { project_id: project }));
        raw.prepare('DELETE FROM project_contacts WHERE project_id = ?').run(project);
        raw.prepare('DELETE FROM projects WHERE id = ?').run(project);
        expect(ledger.snapshot(member, { project_id: project }).total_events).toBe(1);
        expect(() => ledger.snapshot(second, { project_id: project })).toThrow(expect.objectContaining({ status: 404 }));
    });

    test('future/expired standalone facts are history, not current correction targets', () => {
        const future = ledger.append(member, fact('Future', { valid_from: '2027-01-01T00:00:00Z' }));
        const expired = ledger.append(member, fact('Expired', { valid_until: '2025-01-01T00:00:00Z' }));
        expect(ledger.snapshot(member).current_facts).toEqual([]);
        for (const target of [future, expired]) expect(() => ledger.append(member, fact('Invalid', { supersedes_id: target.id }))).toThrow(expect.objectContaining({ status: 409 }));
    });

    test('resolves open commitments once with matching member and exact scope', () => {
        const commitment = ledger.append(member, observation('Send notes', { kind: 'commitment', owner: 'praxis', due_at: '2026-09-08T00:00:00Z' }));
        expect(ledger.snapshot(member).open_commitments.map(e => e.id)).toEqual([commitment.id]);
        expect(() => ledger.append(member, observation('Wrong kind', { kind: 'retraction', target_id: commitment.id }))).toThrow(expect.objectContaining({ status: 409 }));
        ledger.append(member, observation('Sent', { kind: 'resolution', target_id: commitment.id, outcome: 'completed' }));
        expect(ledger.snapshot(member).open_commitments).toEqual([]);
        expect(() => ledger.append(member, observation('Twice', { kind: 'resolution', target_id: commitment.id, outcome: 'cancelled' }))).toThrow(expect.objectContaining({ status: 409 }));
    });

    test('idempotent retries use normalized payload and changed or cross-scope reuse fails', () => {
        const input = observation('Logged once', { idempotency_key: 'message-1', occurred_at: '2026-09-07T08:00:00-04:00' });
        const event = ledger.append(member, input);
        const retry = ledger.append(member, { ...input, project_id: null, occurred_at: now });
        expect(retry).toEqual(event);
        expect(() => ledger.append(member, { ...input, text: 'Changed' })).toThrow(expect.objectContaining({ status: 409 }));
        expect(() => ledger.append(member, { ...input, project_id: project })).toThrow(expect.objectContaining({ status: 409 }));
        expect(ledger.snapshot(member).total_events).toBe(1);
        expect(ledger.append(second, input).id).not.toBe(event.id);
    });

    test('migration preserves old unusual source values and full text without breaking output validation', () => {
        const { initializeMemberMemory } = require('../../db/member-memory');
        raw.prepare("DELETE FROM member_memory_migrations WHERE name = 'interaction_log_v1'").run();
        const sources = ['s'.repeat(201), '   ', { channel: 'mail' }, null, ' feedback '];
        raw.prepare('UPDATE contacts SET interaction_log = ? WHERE id = ?').run(JSON.stringify(sources.map((source, i) => ({
            at: i === 0 ? 'invalid original date' : '2026-01-01T00:00:00Z', source, note: i === 0 ? 'n'.repeat(20001) : `note ${i}`,
        }))), member);
        expect(() => initializeMemberMemory(raw)).not.toThrow();
        const snapshot = ledger.snapshot(member);
        expect(contract.MemberMemorySnapshotSchema.safeParse(snapshot).success).toBe(true);
        expect(snapshot.total_events).toBe(sources.length);
        for (const [i, source] of sources.entries()) {
            const event = snapshot.timeline.find(event => event.text === (i === 0 ? 'n'.repeat(20001) : `note ${i}`));
            expect(event.legacy_source).toBe(typeof source === 'string' ? source : JSON.stringify(source));
            expect(event.source).toBe(i === 4 ? 'feedback' : 'legacy');
        }
        initializeMemberMemory(raw);
        expect(ledger.snapshot(member).timeline).toEqual(snapshot.timeline);
    });

    test('backfills only surviving legacy entries exactly once with stable ids and original dates', () => {
        const { initializeMemberMemory } = require('../../db/member-memory');
        raw.prepare("DELETE FROM member_memory_migrations WHERE name = 'interaction_log_v1'").run();
        raw.prepare('UPDATE contacts SET interaction_log = ? WHERE id = ?').run(JSON.stringify([
            { at: 'not a date', note: 'Old private note', source: 'praxis' },
            { at: '2025-01-02T03:04:05Z', note: 'An exchange' },
        ]), member);
        initializeMemberMemory(raw);
        const before = ledger.snapshot(member);
        expect(before.timeline).toHaveLength(2);
        expect(before.timeline.every(e => e.evidence === 'legacy' && e.project_id === null)).toBe(true);
        const invalid = before.timeline.find(e => e.text === 'Old private note');
        expect(invalid.legacy_at).toBe('not a date');
        expect(invalid.occurred_at).toBeUndefined();
        expect(before.timeline.find(e => e.text === 'An exchange').occurred_at).toBe('2025-01-02T03:04:05.000Z');
        initializeMemberMemory(raw);
        expect(ledger.snapshot(member).timeline).toEqual(before.timeline);
        expect(ledger.snapshot(member, { project_id: project }).timeline).toEqual([]);
        const restored = new Database(':memory:');
        try {
            restored.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, interaction_log TEXT)');
            restored.prepare('INSERT INTO contacts VALUES (?, ?)').run(member, raw.prepare('SELECT interaction_log FROM contacts WHERE id = ?').get(member).interaction_log);
            initializeMemberMemory(restored);
            expect(restored.prepare('SELECT id FROM member_memory_events ORDER BY seq DESC').all().map(row => row.id)).toEqual(before.timeline.map(event => event.id));
        } finally { restored.close(); }
    });
});

describe('member memory facade and compatibility log', () => {
    let facade;
    beforeEach(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-memory-test-'));
        process.env.NEXUS_DB_PATH = path.join(dir, 'nexus.db');
        jest.resetModules();
        facade = require('../../db');
    });
    afterEach(() => { delete process.env.NEXUS_DB_PATH; jest.resetModules(); });

    test('legacy log dual-writes full durable text while compatibility stays bounded and private memory stays absent', async () => {
        expect(typeof facade.getMemberMemory).toBe('function');
        const person = await facade.createContact({ name: 'Archive Person' });
        for (let i = 0; i < 205; i++) await facade.appendContactLog(person.id, { note: `${i}:` + 'x'.repeat(4000) });
        let contact = await facade.getContact(person.id);
        expect(contact.interaction_log).toHaveLength(200);
        expect(contact.interaction_log.every(e => e.note.length === 2000)).toBe(true);
        const memory = await facade.getMemberMemory(person.id, { limit: 100 });
        expect(memory.total_events).toBe(206); // Creation observation plus 205 interactions.
        expect(memory.timeline[0].text.length).toBe(4004);
        await facade.appendMemberMemory(person.id, observation('PRIVATE inference', { evidence: 'inferred' }));
        contact = await facade.getContact(person.id);
        expect(JSON.stringify(contact.interaction_log)).not.toContain('PRIVATE');
        expect(contact.interaction_log).toHaveLength(200);
        jest.resetModules();
        facade = require('../../db');
        expect((await facade.getMemberMemory(person.id)).total_events).toBe(207);
    });

    test('whole-member deletion erases ledger history and keeps other members intact', async () => {
        const person = await facade.createContact({ name: 'Erase me' });
        const other = await facade.createContact({ name: 'Keep me' });
        const first = await facade.appendMemberMemory(person.id, fact('Personal'));
        await facade.appendMemberMemory(person.id, fact('Corrected', { supersedes_id: first.id }));
        await facade.appendMemberMemory(other.id, observation('Keep this'));
        expect(await facade.deleteContact(person.id)).toBe(true);
        const connection = new Database(process.env.NEXUS_DB_PATH);
        try { expect(connection.prepare('SELECT count(*) AS n FROM member_memory_events WHERE member_id = ?').get(person.id).n).toBe(0); }
        finally { connection.close(); }
        expect((await facade.getMemberMemory(other.id)).total_events).toBe(2);
    });

    test('two concurrent SQLite writers cannot correct the same fact twice', async () => {
        const { Worker } = require('worker_threads');
        const person = await facade.createContact({ name: 'Race Person' });
        const first = await facade.appendMemberMemory(person.id, fact('Original'));
        const lock = new SharedArrayBuffer(4);
        const source = `const { parentPort, workerData } = require('worker_threads');
            const Database = require(workerData.databaseModule);
            const { createMemberMemoryLedger } = require(workerData.ledgerModule);
            const connection = new Database(workerData.dbPath);
            const ledger = createMemberMemoryLedger(connection);
            parentPort.postMessage({ ready: true });
            Atomics.wait(new Int32Array(workerData.lock), 0, 0);
            try { parentPort.postMessage({ status: 201, event: ledger.append(workerData.member, workerData.input) }); }
            catch (error) { parentPort.postMessage({ status: error.status, message: error.message }); }
            finally { connection.close(); }`;
        let ready = 0;
        const results = await Promise.all(['First', 'Second'].map(text => new Promise((resolve, reject) => {
            const worker = new Worker(source, { eval: true, workerData: {
                databaseModule: require.resolve('better-sqlite3'), ledgerModule: require.resolve('../../db/member-memory'),
                dbPath: process.env.NEXUS_DB_PATH, member: person.id, lock,
                input: fact(text, { supersedes_id: first.id }),
            } });
            worker.on('error', reject);
            worker.on('message', message => {
                if (message.ready) {
                    if (++ready === 2) { Atomics.store(new Int32Array(lock), 0, 1); Atomics.notify(new Int32Array(lock), 0); }
                } else resolve(message);
            });
        })));
        expect(results.map(result => result.status).sort()).toEqual([201, 409]);
        expect((await facade.getMemberMemory(person.id)).total_events).toBe(3);
    });

    test('compatibility failure rolls back the durable append, and retry does not duplicate compatibility', async () => {
        expect(typeof facade.getMemberMemory).toBe('function');
        const person = await facade.createContact({ name: 'Atomic Person' });
        const connection = new Database(process.env.NEXUS_DB_PATH);
        try {
            connection.exec("CREATE TRIGGER reject_compat BEFORE UPDATE OF interaction_log ON contacts BEGIN SELECT RAISE(ABORT, 'compat failure'); END");
            await expect(facade.appendContactLog(person.id, { note: 'Fails' })).rejects.toMatchObject({ message: 'compat failure' });
            expect((await facade.getMemberMemory(person.id)).total_events).toBe(1);
            connection.exec('DROP TRIGGER reject_compat');
            await facade.appendContactLog(person.id, { note: 'One time', idempotency_key: 'legacy-1', touchContact: true });
            await facade.appendContactLog(person.id, { note: 'One time', idempotency_key: 'legacy-1', touchContact: true });
            expect((await facade.getContact(person.id)).interaction_log).toHaveLength(1);
            expect((await facade.getMemberMemory(person.id)).total_events).toBe(2);
        } finally { connection.close(); }
    });
});
