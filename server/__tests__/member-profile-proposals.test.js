const Database = require('better-sqlite3');
const { randomUUID, createHash } = require('crypto');
const { initializeMemberMemory, createMemberMemoryLedger } = require('../../db/member-memory');
const hash = value => createHash('sha256').update(value).digest('hex');
let raw, ledger, proposals, member, second, project, otherProject;
const now = '2026-09-08T12:00:00.000Z';
const occurred = '2026-09-07T10:00:00.000Z';

function source(responseText = 'I prefer email.', options = {}) {
    const captureId = options.captureId || randomUUID();
    const snapshot = { consultationId: randomUUID(), memberId: member, projectId: null,
        responseText, responseOrigin: 'member_reply', status: 'answered', question: 'How can we work together?', ...options.snapshot };
    const serialized = options.serialized ?? JSON.stringify(snapshot);
    const chunks = options.chunks || Array.from({ length: Math.ceil(serialized.length / 16000) }, (_, i) => serialized.slice(i * 16000, (i + 1) * 16000));
    const events = chunks.map((chunk, i) => ledger.append(options.memberId || member, {
        project_id: Object.hasOwn(options, 'projectId') ? options.projectId : snapshot.projectId, kind: 'observation', evidence: 'self_reported',
        source: snapshot.responseOrigin === 'operator_relay' ? 'consultation:operator_relay' : 'consultation',
        text: `Consultation ${snapshot.consultationId}, ${snapshot.status}, source part ${i + 1}/${chunks.length}\n${chunk}`,
        source_ref: snapshot.email ? `consultation:${snapshot.consultationId}:email:${hash(`${snapshot.consultationId}\0${snapshot.email.messageId}`)}:part:${i + 1}/${chunks.length}`
            : `consultation:${snapshot.consultationId}:revision:${captureId}:part:${i + 1}/${chunks.length}`,
        occurred_at: occurred, ...options.event,
    }));
    return { capture_id: captureId, source_hash: hash(serialized), source_event_ids: events.map(event => event.id),
        extractor_version: 'member-profile-v1', candidates: [{ category: 'preference', quote: responseText }], ...options.input };
}
function version(projectId = null) { return proposals.list(member, { project_id: projectId }).memory_version; }
function expectStatus(fn, status) { expect(fn).toThrow(expect.objectContaining({ status })); }
function pending(response = 'I want to learn piano.', options = {}) {
    const input = source(response, { ...options, input: { candidates: [{ category: 'goal', quote: response }], ...options.input } });
    return { input, proposal: proposals.submit(member, input).proposals[0] };
}

beforeEach(() => {
    raw = new Database(':memory:'); raw.pragma('foreign_keys = ON');
    raw.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, interaction_log TEXT); CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE project_contacts (project_id TEXT, contact_id TEXT, PRIMARY KEY(project_id, contact_id))');
    member = randomUUID(); second = randomUUID(); project = randomUUID(); otherProject = randomUUID();
    for (const id of [member, second]) raw.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run(id, 'Member', '[]');
    for (const id of [project, otherProject]) {
        raw.prepare('INSERT INTO projects VALUES (?)').run(id);
        raw.prepare('INSERT INTO project_contacts VALUES (?, ?)').run(id, member);
    }
    initializeMemberMemory(raw); ledger = createMemberMemoryLedger(raw, { now: () => now });
    expect(() => require('../../db/member-profile-proposals')).not.toThrow();
    const { initializeMemberProfileProposals, createMemberProfileProposals } = require('../../db/member-profile-proposals');
    initializeMemberProfileProposals(raw); proposals = createMemberProfileProposals(raw, ledger, { now: () => now });
});
afterEach(() => raw?.close());

test('automatically applies only a whole direct preference and keeps immutable provenance', () => {
    const input = source('I prefer email.');
    const batch = proposals.submit(member, input);
    expect(batch).toMatchObject({ member_id: member, project_id: null, capture_id: input.capture_id, proposals: [{
        id: expect.any(String), created_seq: expect.any(Number), category: 'preference', quote: 'I prefer email.',
        fact_key: 'profile.preference.contact_channel', source_event_ids: input.source_event_ids,
        source_response: 'I prefer email.', source_question: 'How can we work together?', source_origin: 'member_reply',
        source_occurred_at: occurred, status: 'applied', reason: 'explicit_preference', event_id: expect.any(String),
        created_at: now, reviewed_at: now,
    }] });
    const event = ledger.snapshot(member).current_facts[0];
    expect(event).toMatchObject({ text: 'I prefer email.', evidence: 'self_reported', source: 'member_profile:auto', occurred_at: occurred });
    expect(event.source_ref).toContain(batch.proposals[0].id);
    expect(event.source_ref).toContain(input.source_event_ids[0]);
    expect(event.supersedes_id).toBeUndefined();
    expect(raw.prepare('SELECT interaction_log FROM contacts WHERE id = ?').get(member).interaction_log).toBe('[]');
    expect(proposals.submit(member, input)).toEqual(batch);
    expect(ledger.snapshot(member).current_facts).toHaveLength(1);
});

test.each(['i prefer phone', 'I PREFER THE PORTAL.', 'I prefer email'])('recognizes whole direct preference %s', text => {
    expect(proposals.submit(member, source(text)).proposals[0].status).toBe('applied');
});

test.each([
    ['My colleague says I prefer email.', 'I prefer email.', {}, 'needs_review'],
    ['I prefer email. Also call me.', 'I prefer email.', {}, 'needs_review'],
    ['I prefer email.', 'I prefer email.', { responseOrigin: 'operator_relay' }, 'operator_relay'],
    ['I prefer email.', 'I prefer email.', { responseOrigin: null }, 'unknown_origin'],
    ['I prefer email.', 'I prefer email.', { responseOrigin: 'untrusted' }, 'unknown_origin'],
])('queues ambiguous or relayed preference: %s / %j', (response, quote, snapshot, reason) => {
    const input = source(response, { snapshot, input: { candidates: [{ category: 'preference', quote }] } });
    expect(proposals.submit(member, input).proposals[0]).toMatchObject({ status: 'pending', reason });
    expect(ledger.snapshot(member).current_facts).toEqual([]);
});

test('does not auto-apply when source metadata falsely claims member origin on a relay event', () => {
    const input = source('I prefer email.', { event: { source: 'consultation:operator_relay' } });
    const result = proposals.submit(member, input).proposals[0];
    expect(result).toMatchObject({ status: 'pending', reason: 'operator_relay', source_origin: 'operator_relay' });
    const accepted = proposals.review(member, result.id, { decision: 'accept', expected_memory_version: version() }).proposal;
    expect(ledger.snapshot(member).current_facts.find(e => e.id === accepted.event_id).evidence).toBe('inferred');
});

test.each(['active', 'retracted', 'corrected'])('any %s fact history prevents auto application, even operator facts', state => {
    const original = ledger.append(member, { kind: 'fact', fact_key: 'operator.contact', text: 'Use phone', evidence: 'operator_confirmed', source: 'operator' });
    if (state === 'retracted') ledger.append(member, { kind: 'retraction', target_id: original.id, text: 'Outdated', evidence: 'operator_confirmed', source: 'operator' });
    if (state === 'corrected') ledger.append(member, { kind: 'fact', fact_key: original.fact_key, supersedes_id: original.id, text: 'Use portal', evidence: 'operator_confirmed', source: 'operator' });
    expect(proposals.submit(member, source()).proposals[0]).toMatchObject({ status: 'pending', reason: 'existing_memory' });
});

test('fact history in foreign scopes does not block a new scoped preference', () => {
    ledger.append(member, { kind: 'fact', fact_key: 'tone', text: 'Friendly', evidence: 'observed', source: 'operator' });
    expect(proposals.submit(member, source('I prefer email.', { snapshot: { projectId: project } })).proposals[0].status).toBe('applied');
    expect(proposals.list(member).proposals).toEqual([]);
    expect(proposals.list(member, { project_id: project, status: 'applied' }).total).toBe(1);
});

test('exact quotes are persisted verbatim, deduplicated, and accepted without paraphrases', () => {
    const response = 'I know Rust. I want to learn piano. I will send a demo.';
    const input = source(response, { input: { candidates: [
        { category: 'expertise', quote: 'I know Rust.' }, { category: 'expertise', quote: 'I know Rust.' },
        { category: 'goal', quote: 'I want to learn piano.' }, { category: 'commitment', quote: 'I will send a demo.' },
    ] } });
    const batch = proposals.submit(member, input);
    expect(batch.proposals).toHaveLength(3);
    expect(batch.proposals[0]).toMatchObject({ quote: 'I know Rust.', fact_key: `profile.expertise.${hash('i know rust.').slice(0, 24)}` });
    for (const proposal of batch.proposals) proposals.review(member, proposal.id, { decision: 'accept', expected_memory_version: version() });
    const memory = ledger.snapshot(member);
    expect(memory.current_facts.map(e => e.text)).toEqual(expect.arrayContaining(['I know Rust.', 'I want to learn piano.']));
    expect(memory.current_facts.every(e => e.evidence === 'self_reported' && !e.supersedes_id)).toBe(true);
    expect(memory.open_commitments[0]).toMatchObject({ text: 'I will send a demo.', owner: 'member', evidence: 'self_reported' });
    expect(memory.open_commitments[0].due_at).toBeUndefined();
    expect(batch.proposals[2].fact_key).toBeUndefined();
});

test('reconstructs full ordered multipart sources', () => {
    const snapshot = { consultationId: randomUUID(), memberId: member, projectId: project, responseText: 'I want piano lessons.',
        responseOrigin: 'member_reply', status: 'answered', question: 'Plans?' };
    const serialized = JSON.stringify(snapshot);
    const input = source(snapshot.responseText, { snapshot, chunks: [serialized.slice(0, 100), serialized.slice(100)], input: { candidates: [{ category: 'goal', quote: snapshot.responseText }] } });
    expect(proposals.submit(member, input).proposals[0].source_event_ids).toEqual(input.source_event_ids);
});

test('email source uses original body and verifies the email reference identity', () => {
    const input = source('A later mutable reply.', { snapshot: { email: { messageId: '<reply@member>', bodyText: 'I prefer email.' } }, input: { candidates: [{ category: 'preference', quote: 'I prefer email.' }] } });
    expect(proposals.submit(member, input).proposals[0]).toMatchObject({ source_response: 'I prefer email.', status: 'applied' });
    const bad = source('A later mutable reply.', { snapshot: { email: { messageId: '<second@member>', bodyText: 'I prefer phone.' } }, input: { candidates: [{ category: 'goal', quote: 'A later mutable reply.' }] } });
    expectStatus(() => proposals.submit(member, bad), 400);
    const wrongRef = source('I prefer phone.', { snapshot: { email: { messageId: '<third@member>', bodyText: 'I prefer phone.' } }, event: { source_ref: `consultation:wrong:email:${'a'.repeat(64)}:part:1/1` } });
    expectStatus(() => proposals.submit(member, wrongRef), 400);
});

test('empty batches are durable and the first valid candidate batch wins after restart', () => {
    const input = source('I know Rust.'); input.candidates = [];
    const initial = proposals.submit(member, input);
    const { initializeMemberProfileProposals, createMemberProfileProposals } = require('../../db/member-profile-proposals');
    initializeMemberProfileProposals(raw); proposals = createMemberProfileProposals(raw, ledger);
    expect(proposals.submit(member, { ...input, candidates: [{ category: 'expertise', quote: 'I know Rust.' }] })).toEqual(initial);
    expect(initial.proposals).toEqual([]);
    expectStatus(() => proposals.submit(member, { ...input, source_hash: '0'.repeat(64) }), 409);
    expectStatus(() => proposals.submit(member, { ...input, source_event_ids: [randomUUID()] }), 409);
});

test('valid retries with changed candidates return the first batch and invalid quotes still fail', () => {
    const input = source('I know Rust. I like piano.', { input: { candidates: [{ category: 'expertise', quote: 'I know Rust.' }] } });
    const first = proposals.submit(member, input);
    expect(proposals.submit(member, { ...input, candidates: [{ category: 'preference', quote: 'I like piano.' }] })).toEqual(first);
    expectStatus(() => proposals.submit(member, { ...input, candidates: [{ category: 'goal', quote: 'invented' }] }), 400);
});

test.each([
    ['hash', input => ({ ...input, source_hash: '0'.repeat(64) })],
    ['missing event', input => ({ ...input, source_event_ids: [randomUUID()] })],
    ['duplicate event', input => ({ ...input, source_event_ids: [input.source_event_ids[0], input.source_event_ids[0]] })],
    ['wrong capture', input => ({ ...input, capture_id: randomUUID() })],
    ['invented quote', input => ({ ...input, candidates: [{ category: 'preference', quote: 'I prefer phone.' }] })],
])('rejects invalid source binding: %s', (_, mutate) => {
    const input = source(); expectStatus(() => proposals.submit(member, mutate(input)), 400);
    expect(proposals.list(member).total).toBe(0); expect(ledger.snapshot(member).current_facts).toEqual([]);
});

test.each([
    { event: { kind: 'fact', fact_key: 'fake' } }, { event: { evidence: 'observed' } },
    { event: { source: 'operator' } }, { event: { text: 'Consultation invalid source part 1/1\n{}' } },
    { event: { source_ref: 'consultation:wrong:revision:wrong:part:1/1' } },
    { snapshot: { status: 'draft' } }, { snapshot: { memberId: 'untrusted' } },
    { snapshot: { projectId: 'untrusted' }, projectId: null },
    { snapshot: { responseText: ' ' } }, { snapshot: { responseText: 'x'.repeat(24001) }, input: { candidates: [] } },
    { snapshot: { question: {} } }, { serialized: 'not json' },
])('rejects unsafe immutable source %#', options => {
    const input = source('I prefer email.', options); expectStatus(() => proposals.submit(member, input), 400);
});

test('rejects missing, reversed, foreign-member and mixed-scope parts', () => {
    const a = source(); const b = source();
    expectStatus(() => proposals.submit(second, a), 400);
    const snapshot = { consultationId: randomUUID(), memberId: member, projectId: null, responseText: 'I prefer email.', responseOrigin: 'member_reply', status: 'answered', question: 'Preferences?' };
    const serialized = JSON.stringify(snapshot);
    const input = source(snapshot.responseText, { snapshot, chunks: [serialized.slice(0, 100), serialized.slice(100)] });
    for (const ids of [[input.source_event_ids[0]], [...input.source_event_ids].reverse(), [input.source_event_ids[0], b.source_event_ids[0]]]) {
        expectStatus(() => proposals.submit(member, { ...input, source_event_ids: ids }), 400);
    }
    const foreign = source('I prefer email.', { snapshot: { projectId: project } });
    expectStatus(() => proposals.submit(member, { ...input, source_event_ids: [input.source_event_ids[0], foreign.source_event_ids[0]] }), 400);
});

test('requires current member and project links for new writes but permits historical reads and successful retries', () => {
    const { input, proposal } = pending('I want piano lessons.', { snapshot: { projectId: project } });
    const next = source('I prefer phone.', { snapshot: { projectId: project } });
    raw.prepare('DELETE FROM project_contacts WHERE project_id = ?').run(project);
    expect(proposals.list(member, { project_id: project }).total).toBe(1);
    expect(proposals.submit(member, input).proposals[0].id).toBe(proposal.id);
    expectStatus(() => proposals.submit(member, next), 409);
    expectStatus(() => proposals.review(member, proposal.id, { decision: 'accept', expected_memory_version: version(project) }), 409);
    expectStatus(() => proposals.review(member, proposal.id, { decision: 'dismiss', expected_memory_version: version(project) }), 409);
    expectStatus(() => proposals.submit(randomUUID(), input), 404);
});

test('acceptance guards exact-scope memory version and is idempotent after later memory', () => {
    const { proposal } = pending(); const expected = version();
    ledger.append(member, { project_id: project, kind: 'observation', text: 'Foreign', evidence: 'observed', source: 'operator' });
    const accepted = proposals.review(member, proposal.id, { decision: 'accept', expected_memory_version: expected });
    ledger.append(member, { kind: 'observation', text: 'Later', evidence: 'observed', source: 'operator' });
    expect(proposals.review(member, proposal.id, { decision: 'accept', expected_memory_version: expected })).toEqual(accepted);
    expectStatus(() => proposals.review(member, proposal.id, { decision: 'dismiss', expected_memory_version: version() }), 409);
    expectStatus(() => proposals.review(second, proposal.id, { decision: 'accept', expected_memory_version: 0 }), 404);
    const next = pending('I want to sing.').proposal; const stale = version();
    ledger.append(member, { kind: 'observation', text: 'New context', evidence: 'observed', source: 'operator' });
    expectStatus(() => proposals.review(member, next.id, { decision: 'accept', expected_memory_version: stale }), 409);
    expect(proposals.list(member).proposals[0].status).toBe('pending');
});

test('dismissal appends nothing, needs no current version, and repeats idempotently', () => {
    const { proposal } = pending(); const before = version();
    const dismissed = proposals.review(member, proposal.id, { decision: 'dismiss', expected_memory_version: 0 });
    expect(dismissed.proposal).toMatchObject({ status: 'dismissed', reviewed_at: now });
    expect(version()).toBe(before);
    expect(proposals.review(member, proposal.id, { decision: 'dismiss', expected_memory_version: 0 })).toEqual(dismissed);
    expect(proposals.list(member, { status: 'dismissed' }).total).toBe(1);
});

test('proposal submission rolls back batches, proposals and auto memory when a later insert fails', () => {
    raw.exec("CREATE TRIGGER reject_profile_goal BEFORE INSERT ON member_profile_proposals WHEN NEW.category = 'goal' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const input = source(); input.candidates.push({ category: 'goal', quote: 'I prefer email.' });
    expect(() => proposals.submit(member, input)).toThrow('test failure');
    expect(ledger.snapshot(member).current_facts).toEqual([]);
    expect(proposals.list(member).total).toBe(0);
    raw.exec('DROP TRIGGER reject_profile_goal');
    expect(proposals.submit(member, input).proposals).toHaveLength(2);
});

test('review rolls back nested ledger append when proposal state cannot update', () => {
    const { proposal } = pending(); const before = version();
    raw.exec("CREATE TRIGGER reject_profile_review BEFORE UPDATE ON member_profile_proposals BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect(() => proposals.review(member, proposal.id, { decision: 'accept', expected_memory_version: before })).toThrow('test failure');
    expect(version()).toBe(before); expect(ledger.snapshot(member).current_facts).toEqual([]);
    expect(proposals.list(member).proposals[0].status).toBe('pending');
});

test('paginates deterministically with filtered totals and contact deletion erases batches and proposals', () => {
    for (let i = 0; i < 5; i++) pending(`I want lesson ${i}.`);
    const first = proposals.list(member, { limit: 2 });
    const secondPage = proposals.list(member, { limit: 2, before_created_seq: first.next_before_created_seq });
    const third = proposals.list(member, { limit: 2, before_created_seq: secondPage.next_before_created_seq });
    expect(first.total).toBe(5); expect(secondPage.total).toBe(5); expect(third.next_before_created_seq).toBeNull();
    expect(new Set([...first.proposals, ...secondPage.proposals, ...third.proposals].map(p => p.id)).size).toBe(5);
    proposals.review(member, first.proposals[0].id, { decision: 'dismiss', expected_memory_version: 0 });
    expect(proposals.list(member).total).toBe(4); expect(proposals.list(member, { status: 'dismissed' }).total).toBe(1);
    raw.prepare('DELETE FROM contacts WHERE id = ?').run(member);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM member_profile_proposals').get().n).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM member_profile_proposal_batches').get().n).toBe(0);
});

test('immutable email sources cannot be replayed with a different capture ID', () => {
    const input = source('I will send a demo.', { snapshot: { email: { messageId: '<commitment@member>', bodyText: 'I will send a demo.' } },
        input: { candidates: [{ category: 'commitment', quote: 'I will send a demo.' }] } });
    const initial = proposals.submit(member, input);
    proposals.review(member, initial.proposals[0].id, { decision: 'accept', expected_memory_version: version() });
    expectStatus(() => proposals.submit(member, { ...input, capture_id: randomUUID() }), 409);
    expect(ledger.snapshot(member).open_commitments).toHaveLength(1);
});

test('canonical members must have UUID identifiers even when an invalid legacy directory row exists', () => {
    raw.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run('legacy-name', 'Legacy', '[]');
    const input = source('I prefer email.', { memberId: 'legacy-name', snapshot: { memberId: 'legacy-name' } });
    expectStatus(() => proposals.submit('legacy-name', input), 404);
    expectStatus(() => proposals.list('legacy-name'), 404);
});

test('source provenance and candidate text cannot be rewritten or separately erased', () => {
    const { proposal } = pending();
    expect(() => raw.prepare('UPDATE member_profile_proposals SET quote = ? WHERE id = ?').run('Forged', proposal.id)).toThrow(/immutable/);
    expect(() => raw.exec("UPDATE member_profile_proposal_batches SET source_origin = 'member_reply'")).toThrow(/immutable/);
    expect(() => raw.exec('DELETE FROM member_profile_proposals')).toThrow(/durable/);
    expect(() => raw.exec('DELETE FROM member_profile_proposal_batches')).toThrow(/immutable/);
});


test('quotes with invented boundary whitespace fail even when trimming would match', () => {
    const input = source('I know Rust.', { input: { candidates: [{ category: 'expertise', quote: ' I know Rust. ' }] } });
    expectStatus(() => proposals.submit(member, input), 400);
    expect(proposals.list(member).total).toBe(0);
});

test('literal source whitespace is preserved in accepted proposal text', () => {
    const quote = ' I know Rust. ';
    const input = source(quote, { input: { candidates: [{ category: 'expertise', quote }] } });
    const proposal = proposals.submit(member, input).proposals[0];
    expect(proposal.quote).toBe(quote);
    proposals.review(member, proposal.id, { decision: 'accept', expected_memory_version: version() });
    expect(ledger.snapshot(member).current_facts[0].text).toBe(quote);
});
