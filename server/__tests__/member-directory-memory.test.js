const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { MemberMemoryEventSchema } = require('@praxis/contract');

let db;
let raw;

function directoryEvents(memberId) {
    return raw.prepare("SELECT * FROM member_memory_events WHERE member_id = ? AND source = 'member_directory' ORDER BY seq")
        .all(memberId);
}

function sourcePayload(events) {
    // Numbered observations contain consecutive pieces of the original JSON.
    return JSON.parse(events.map(event => event.text.split('\n\n').slice(1).join('\n\n')).join(''));
}

beforeEach(() => {
    process.env.NEXUS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-directory-memory-')), 'nexus.db');
    jest.resetModules();
    db = require('../../db');
    raw = new Database(process.env.NEXUS_DB_PATH);
});

afterEach(() => {
    raw.close();
    delete process.env.NEXUS_DB_PATH;
    jest.restoreAllMocks();
    jest.resetModules();
});

test('creation records the canonical nonempty profile as observed general evidence without a compatibility log', async () => {
    const member = await db.createContact({
        name: '  Canonical Person  ', email: ' person@example.com ', phone: '555-0100',
        relationship: 'adviser', birthday: '1984-07-09', notes: 'Source notes',
        preferences: { tone: 'brief', requireApproval: false }, expertise: ['pricing'],
        interests: ['games'], claims: [{ domain: 'strategy', source: 'self', note: 'Member says so' }],
        source: 'import', kind: 'human', status: 'dormant',
    });
    const events = directoryEvents(member.id);
    expect(events).toHaveLength(1);
    const payload = sourcePayload(events);
    expect(payload).toEqual({
        action: 'created', member_id: member.id,
        changes: Object.fromEntries(['name', 'email', 'phone', 'relationship', 'birthday', 'notes',
            'preferences', 'expertise', 'interests', 'claims', 'source', 'kind', 'seat_id', 'status']
            .map(field => [field, { after: member[field] }])),
    });
    expect(events[0]).toMatchObject({ kind: 'observation', evidence: 'observed', project_id: null });
    expect(events[0].text).toMatch(/^Observed member directory created \(part 1\/1\)/);
    expect(events[0].text).toContain('not independently verified');
    expect(events[0].source_ref).toContain(member.id);
    expect(events[0].idempotency_key).toBe(`${events[0].source_ref}:part:1`);
    expect(member.interaction_log).toEqual([]);
    expect(member.last_contact_at).toBeNull();
    expect((await db.getMemberMemory(member.id)).current_facts).toEqual([]);

    const sparse = await db.createContact({ name: 'Sparse', kind: 'ai', preferences: {}, expertise: [] });
    expect(sourcePayload(directoryEvents(sparse.id)).changes).toEqual({
        name: { after: 'Sparse' }, kind: { after: 'ai' }, status: { after: 'active' }, source: { after: 'operator' },
    });
});

test('updates record only actual changed canonical fields with their before and after values', async () => {
    const member = await db.createContact({ name: 'Original', notes: 'Keep this', expertise: ['pricing'] });
    const project = await db.upsertProject({ name: 'Directory scope', path: '/tmp/directory-memory-scope', type: 'app' });
    await db.linkContactToProject(project.id, member.id, {});
    const patch = {
        name: 'Updated', email: 'new@example.com', phone: '555-0123', relationship: 'colleague',
        birthday: '1980', notes: 'Keep this', preferences: { tone: 'brief' }, expertise: ['pricing', 'research'],
        interests: ['coding'], claims: [{ domain: 'design' }], status: 'dormant', kind: 'ai', seat_id: 'cli:directory-test',
        last_contact_at: '2026-09-07T12:00:00.000Z',
    };
    const updated = await db.updateContact(member.id, patch);
    const events = directoryEvents(member.id);
    expect(events).toHaveLength(2);
    expect(sourcePayload([events[1]])).toEqual({
        action: 'updated', member_id: member.id,
        changes: Object.fromEntries(Object.keys(patch).filter(key => !['notes', 'last_contact_at'].includes(key))
            .map(key => [key, { before: member[key], after: updated[key] }])),
    });
    expect(events[1].source_ref).not.toBe(events[0].source_ref);
    expect(events[1].project_id).toBeNull();
    expect((await db.getMemberMemory(member.id, { project_id: project.id })).total_events).toBe(0);
    expect(updated.interaction_log).toEqual([]);
});

test('explicit clears preserve nulls, empty strings, empty objects, and empty arrays', async () => {
    const member = await db.createContact({ name: 'Clear Person', notes: 'Private note', email: 'clear@example.com',
        phone: '555', preferences: { tone: 'brief' }, expertise: ['pricing'], interests: ['games'], claims: [{ domain: 'design' }] });
    const updated = await db.updateContact(member.id, { notes: '', email: null, phone: null,
        preferences: null, expertise: [], interests: null, claims: [] });
    const events = directoryEvents(member.id);
    expect(events).toHaveLength(2);
    expect(sourcePayload([events[1]]).changes).toEqual(Object.fromEntries(
        ['notes', 'email', 'phone', 'preferences', 'expertise', 'interests', 'claims']
            .map(key => [key, { before: member[key], after: updated[key] }])));
    expect(updated).toMatchObject({ notes: '', email: null, phone: null, preferences: {}, expertise: [], interests: [], claims: [] });
});

test('identical and structurally equal replay, timestamps, and compatibility logs add no directory evidence', async () => {
    const member = await db.createContact({ name: 'Replay Person', preferences: { nested: { a: 1, b: false }, tone: 'brief' },
        claims: [{ domain: 'design', note: 'Unverified' }] });
    const initial = directoryEvents(member.id);
    expect(initial).toHaveLength(1);
    await db.updateContact(member.id, { preferences: { tone: 'brief', nested: { b: false, a: 1 } },
        claims: [{ note: 'Unverified', domain: 'design' }], name: member.name });
    await db.updateContact(member.id, { last_contact_at: '2026-09-07T10:00:00.000Z' });
    await db.updateContact(member.id, { interaction_log: [{ note: 'Ignored' }] });
    await db.appendContactLog(member.id, { note: 'Actual interaction', touchContact: true });
    expect(directoryEvents(member.id)).toEqual(initial);
    const patch = { notes: 'New note' };
    await db.updateContact(member.id, patch);
    const changed = directoryEvents(member.id);
    expect(changed).toHaveLength(2);
    jest.resetModules();
    db = require('../../db');
    await db.updateContact(member.id, patch);
    expect(directoryEvents(member.id)).toEqual(changed);
    // A later genuine return to a previous value is a distinct source change.
    await db.updateContact(member.id, { notes: null });
    await db.updateContact(member.id, patch);
    const final = directoryEvents(member.id);
    expect(final).toHaveLength(4);
    expect(new Set(final.map(event => event.source_ref)).size).toBe(4);
});

test('long source text survives numbered schema-valid observations and replay byte-for-byte', async () => {
    const notes = '🧭\n\t "source" \\ '.repeat(4500) + '  trailing spaces  ';
    const member = await db.createContact({ name: 'Long Person', notes });
    const created = directoryEvents(member.id);
    expect(created.length).toBeGreaterThan(1);
    expect(sourcePayload(created).changes.notes.after).toBe(notes);
    const nextNotes = '  updated 🧩 '.repeat(5000) + '\n';
    await db.updateContact(member.id, { notes: nextNotes });
    const events = directoryEvents(member.id);
    const updated = events.slice(created.length);
    expect(updated.length).toBeGreaterThan(1);
    expect(sourcePayload(updated).changes).toEqual({ notes: { before: notes, after: nextNotes } });
    for (const group of [created, updated]) {
        expect(new Set(group.map(event => event.source_ref)).size).toBe(1);
        expect(new Set(group.map(event => event.idempotency_key)).size).toBe(group.length);
        group.forEach((event, index) => {
            expect(event.text.length).toBeLessThanOrEqual(20000);
            expect(event.text).toContain(`(part ${index + 1}/${group.length})`);
            expect(event.idempotency_key).toBe(`${event.source_ref}:part:${index + 1}`);
        });
    }
    const snapshot = await db.getMemberMemory(member.id, { limit: 100 });
    expect(snapshot.timeline.every(event => MemberMemoryEventSchema.safeParse(event).success)).toBe(true);
    await db.updateContact(member.id, { notes: nextNotes });
    expect(directoryEvents(member.id)).toEqual(events);
    expect((await db.getContact(member.id)).notes).toBe(nextNotes);
});

test('a failed later evidence part rolls back creation and every earlier part', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    raw.exec(`CREATE TRIGGER reject_directory_part BEFORE INSERT ON member_memory_events
        WHEN NEW.source = 'member_directory' AND NEW.idempotency_key LIKE '%:part:2'
        BEGIN SELECT RAISE(ABORT, 'injected directory evidence failure'); END`);
    const input = { name: 'Atomic Create', notes: 'x'.repeat(50000) };
    expect(await db.createContact(input)).toBeNull();
    expect(errors).toHaveBeenCalledWith('[Database] Error creating contact:', 'injected directory evidence failure');
    expect(raw.prepare('SELECT count(*) AS n FROM contacts').get().n).toBe(0);
    expect(raw.prepare('SELECT count(*) AS n FROM member_memory_events').get().n).toBe(0);
    raw.exec('DROP TRIGGER reject_directory_part');
    const member = await db.createContact(input);
    expect(member.notes).toBe(input.notes);
    expect(directoryEvents(member.id).length).toBeGreaterThan(1);
});

test('a failed later evidence part rolls back the complete update and retains earlier history', async () => {
    const member = await db.createContact({ name: 'Atomic Update', notes: 'Original' });
    const initial = directoryEvents(member.id);
    expect(initial).toHaveLength(1);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    raw.exec(`CREATE TRIGGER reject_directory_part BEFORE INSERT ON member_memory_events
        WHEN NEW.source = 'member_directory' AND NEW.idempotency_key LIKE '%:part:2'
        BEGIN SELECT RAISE(ABORT, 'injected directory evidence failure'); END`);
    expect(await db.updateContact(member.id, { name: 'Changed', notes: 'x'.repeat(50000) })).toBeNull();
    expect(await db.getContact(member.id)).toEqual(member);
    expect(directoryEvents(member.id)).toEqual(initial);
    raw.exec('DROP TRIGGER reject_directory_part');
    expect(await db.updateContact(member.id, { name: 'Changed', notes: 'x'.repeat(50000) }))
        .toMatchObject({ name: 'Changed', notes: 'x'.repeat(50000) });
});

test('startup leaves existing directory rows uncaptured until a real profile change', async () => {
    const id = randomUUID();
    raw.prepare('INSERT INTO contacts (id, name, notes) VALUES (?, ?, ?)').run(id, 'Existing Person', 'Old notes');
    jest.resetModules();
    db = require('../../db');
    expect(directoryEvents(id)).toEqual([]);
    await db.updateContact(id, { notes: 'Old notes', last_contact_at: '2026-09-07T10:00:00.000Z' });
    expect(directoryEvents(id)).toEqual([]);
    await db.updateContact(id, { notes: 'New notes' });
    expect(directoryEvents(id)).toHaveLength(1);
    expect(sourcePayload(directoryEvents(id)).changes).toEqual({ notes: { before: 'Old notes', after: 'New notes' } });
});

test('whole-member deletion cascades all directory observations without erasing another member', async () => {
    const member = await db.createContact({ name: 'Erase Directory', notes: 'x'.repeat(50000) });
    const other = await db.createContact({ name: 'Keep Directory' });
    const kept = directoryEvents(other.id);
    expect(directoryEvents(member.id).length).toBeGreaterThan(1);
    await db.updateContact(member.id, { notes: null });
    expect(await db.deleteContact(member.id)).toBe(true);
    expect(raw.prepare('SELECT * FROM member_memory_events WHERE member_id = ?').all(member.id)).toEqual([]);
    expect(directoryEvents(other.id)).toEqual(kept);
});
