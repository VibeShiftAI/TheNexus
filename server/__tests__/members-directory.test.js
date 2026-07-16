/**
 * Members directory (2026-07-16 unification): contacts rows carry the full
 * member profile — kind (human/ai), minted seat ids, birthday, claims,
 * interaction log, status — while staying backward-compatible with the
 * original contacts shape and project links.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadFreshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-members-'));
    process.env.NEXUS_DB_PATH = path.join(dir, 'nexus.db');
    jest.resetModules();
    return require('../../db');
}

describe('unified members directory', () => {
    afterEach(() => {
        delete process.env.NEXUS_DB_PATH;
        jest.resetModules();
    });

    test('creates human members with minted unique seat ids and profile fields', async () => {
        const db = loadFreshDb();
        const lars = await db.createContact({
            name: 'Lars Jensen',
            email: 'lars@example.com',
            birthday: '1990-01-15',
            claims: [{ domain: 'revenue-strategy', note: 'pricing', claimedAt: 't', source: 'robert' }],
            preferences: { tone: 'brief', requireApproval: true },
        });
        expect(lars.kind).toBe('human');
        expect(lars.seat_id).toBe('human:lars-jensen');
        expect(lars.birthday).toBe('1990-01-15');
        expect(lars.status).toBe('active');
        expect(lars.claims).toEqual([
            { domain: 'revenue-strategy', note: 'pricing', claimedAt: 't', source: 'robert' },
        ]);
        expect(lars.interaction_log).toEqual([]);

        // Same name → suffixed seat id, never a collision.
        const lars2 = await db.createContact({ name: 'Lars Jensen' });
        expect(lars2.seat_id).toBe('human:lars-jensen-2');

        // Seat lookup finds the right row.
        const found = await db.findContactBySeat('human:lars-jensen');
        expect(found.id).toBe(lars.id);
    });

    test('creates AI members under their council seat id', async () => {
        const db = loadFreshDb();
        const codex = await db.createContact({ name: 'Codex', kind: 'ai', seat_id: 'cli:codex', source: 'praxis' });
        expect(codex.kind).toBe('ai');
        expect(codex.seat_id).toBe('cli:codex');
        expect(codex.email).toBeNull();
    });

    test('updates member fields and appends bounded interaction log entries', async () => {
        const db = loadFreshDb();
        const member = await db.createContact({ name: 'Query Quinn', email: 'quinn@example.com' });

        const updated = await db.updateContact(member.id, {
            birthday: '1985',
            status: 'dormant',
            claims: [{ domain: 'llm-ops', claimedAt: 't', source: 'self' }],
        });
        expect(updated.birthday).toBe('1985');
        expect(updated.status).toBe('dormant');
        expect(updated.claims).toHaveLength(1);

        const logged = await db.appendContactLog(member.id, {
            note: 'Answered consultation consult-x in ~3h',
            source: 'consultation',
            touchContact: true,
        });
        expect(logged.interaction_log).toHaveLength(1);
        expect(logged.interaction_log[0].note).toMatch(/Answered consultation/);
        expect(logged.last_contact_at).toBeTruthy();

        // Appends without touchContact leave last_contact_at alone.
        const before = logged.last_contact_at;
        const again = await db.appendContactLog(member.id, { note: 'Robert says June birthday' });
        expect(again.interaction_log).toHaveLength(2);
        expect(again.last_contact_at).toBe(before);

        // Unknown member → null, no throw.
        expect(await db.appendContactLog('nope', { note: 'x' })).toBeNull();
    });

    test('existing contacts behavior is unchanged: email lookup, project links, observe', async () => {
        const db = loadFreshDb();
        const project = await db.upsertProject({ name: 'MembersTest', path: '/tmp/members-test', type: 'app' });
        const member = await db.createContact({ name: 'Sister', email: 'sis@example.com' });

        expect((await db.findContactByEmail('SIS@example.com')).id).toBe(member.id);

        expect(await db.linkContactToProject(project.id, member.id, { role: 'Tester' })).toBe(true);
        const linked = await db.listProjectContacts(project.id);
        expect(linked).toHaveLength(1);
        expect(linked[0].role).toBe('Tester');
        expect(linked[0].seat_id).toMatch(/^human:sister/);

        const observed = await db.observeContact({ email: 'new@example.com', name: 'Newcomer' });
        expect(observed.last_contact_at).toBeTruthy();
        expect(observed.kind).toBe('human');
        expect(observed.seat_id).toMatch(/^human:newcomer/);
    });
});
