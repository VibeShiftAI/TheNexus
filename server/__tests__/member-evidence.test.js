/**
 * Member evidence lookup over synthetic data: explicit scope, question types,
 * distinct source labels, truthful history, and no leakage of other projects,
 * other members, raw observations or contact details.
 */
const Database = require('better-sqlite3');
const { randomUUID, createHash } = require('crypto');
const { initializeMemberMemory, createMemberMemoryLedger } = require('../../db/member-memory');
const { initializeMemberProfileProposals, createMemberProfileProposals } = require('../../db/member-profile-proposals');
const { createMemberEvidence, QUESTION_TYPES } = require('../../db/member-evidence');

const now = '2026-09-18T12:00:00.000Z';
let raw, ledger, proposals, evidence, member, twin, project, otherProject;
const fact = (text, fact_key, extra = {}) => ({ kind: 'fact', fact_key, text, evidence: 'self_reported', source: 'consultation', ...extra });
const expectStatus = (fn, status) => expect(fn).toThrow(expect.objectContaining({ status }));
const ids = records => records.map(record => record.id);
const sha = value => createHash('sha256').update(value).digest('hex');

function pendingProposal(response = 'I want to learn piano.', category = 'goal') {
    const captureId = randomUUID();
    const snapshot = { consultationId: randomUUID(), memberId: member, projectId: null, responseText: response,
        responseOrigin: 'member_reply', status: 'answered', question: 'How can we work together?' };
    const serialized = JSON.stringify(snapshot);
    const event = ledger.append(member, { project_id: null, kind: 'observation', evidence: 'self_reported', source: 'consultation',
        text: `Consultation ${snapshot.consultationId}, answered, source part 1/1\n${serialized}`,
        source_ref: `consultation:${snapshot.consultationId}:revision:${captureId}:part:1/1`, occurred_at: '2026-09-17T10:00:00.000Z' });
    return proposals.submit(member, { capture_id: captureId, source_hash: sha(serialized), source_event_ids: [event.id],
        extractor_version: 'member-profile-v1', candidates: [{ category, quote: response }] }).proposals[0];
}

beforeEach(() => {
    raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(`CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, birthday TEXT, notes TEXT, kind TEXT, seat_id TEXT,
            status TEXT, preferences TEXT, expertise TEXT, interests TEXT, claims TEXT, interaction_log TEXT, updated_at TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY);
        CREATE TABLE project_contacts (project_id TEXT, contact_id TEXT, role TEXT, decision_maker INTEGER DEFAULT 0, PRIMARY KEY(project_id, contact_id))`);
    member = randomUUID(); twin = randomUUID(); project = randomUUID(); otherProject = randomUUID();
    const insert = raw.prepare(`INSERT INTO contacts (id, name, email, phone, birthday, notes, kind, seat_id, status, preferences, expertise, interests, claims, interaction_log, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(member, 'Alex Rivera', 'alex-private@example.com', '555-0100', '1990-01-01', 'PRIVATE DIRECTORY NOTE', 'human', 'human:alex-rivera', 'active',
        JSON.stringify({ channel: 'email', tone: 'brief', requireApproval: true }), JSON.stringify(['pricing']), JSON.stringify(['games']),
        JSON.stringify([{ domain: 'revenue-strategy', note: 'says so', claimedAt: '2026-09-01', source: 'self' }]), '[]', '2026-09-10T00:00:00.000Z');
    insert.run(twin, ' alex rivera ', null, null, null, null, 'human', 'human:alex-rivera-2', 'active', '{}', '[]', '[]', '[]', '[]', '2026-09-10T00:00:00.000Z');
    for (const id of [project, otherProject]) {
        raw.prepare('INSERT INTO projects VALUES (?)').run(id);
        raw.prepare('INSERT INTO project_contacts (project_id, contact_id, role, decision_maker) VALUES (?, ?, ?, ?)').run(id, member, 'Tester', id === project ? 1 : 0);
    }
    raw.prepare('INSERT INTO project_contacts (project_id, contact_id, role) VALUES (?, ?, ?)').run(project, twin, 'Client');
    initializeMemberMemory(raw);
    ledger = createMemberMemoryLedger(raw, { now: () => now });
    initializeMemberProfileProposals(raw);
    proposals = createMemberProfileProposals(raw, ledger, { now: () => now });
    evidence = createMemberEvidence(raw, ledger, { now: () => now });
});
afterEach(() => raw?.close());

test('general preference plus project exception: each scope is labelled and other projects never leak', () => {
    const general = ledger.append(member, fact('I prefer email.', 'profile.preference.contact_channel'));
    const exception = ledger.append(member, fact('For this project, phone me.', 'profile.preference.contact_channel', { project_id: project }));
    const foreign = ledger.append(member, fact('Portal only here.', 'profile.preference.contact_channel', { project_id: otherProject }));
    const result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'contact_channel' });
    expect(result).toMatchObject({ member_id: member, scope: 'project', project_id: project, question: { type: 'contact_channel', fact_key: null }, as_of: now,
        directory_updated_at: '2026-09-10T00:00:00.000Z', project_link: { project_id: project, status: 'linked', role: 'Tester', decision_maker: true } });
    expect(result.sources.project_assertions).toMatchObject({ status: 'present', is_project_statement: true, applies_to: `project:${project}`, total: 1, truncated: false });
    expect(ids(result.sources.project_assertions.records)).toEqual([exception.id]);
    expect(result.sources.project_assertions.records[0]).toMatchObject({ scope: 'project', project_id: project, member_id: member, seq: exception.seq,
        source_class: 'project_assertion', evidence: 'self_reported', evidence_label: expect.stringMatching(/claim/), fact_key: 'profile.preference.contact_channel',
        source: 'consultation', recorded_at: now, conflicted: false });
    expect(result.sources.general_assertions).toMatchObject({ status: 'present', applies_to: 'general', is_project_statement: false });
    expect(result.sources.general_assertions.records).toEqual([expect.objectContaining({ id: general.id, scope: 'general', project_id: null, source_class: 'general_assertion' })]);
    expect(result.sources.directory_settings).toMatchObject({ status: 'present', applies_to: 'all_projects', is_project_statement: false });
    expect(result.sources.directory_settings.records).toEqual([expect.objectContaining({ field: 'preferences.channel', value: 'email', source_class: 'directory_setting',
        evidence: 'directory', applies_to: 'all_projects', is_project_statement: false, ref: `/api/members/${member}#preferences.channel`, updated_at: '2026-09-10T00:00:00.000Z' })]);
    const json = JSON.stringify(result);
    for (const leak of [foreign.id, otherProject, 'Portal only']) expect(json).not.toContain(leak);
    expect(result.coverage).toEqual({ scopes: [`project:${project}`, 'general'], other_projects_included: false, observations_included: false, contact_details_included: false, limit: 50 });
    expect(result.usage_guidance).toMatch(/never project statements/);

    const generalOnly = evidence.lookup(member, { scope: 'general', question: 'contact_channel' });
    expect(generalOnly).toMatchObject({ scope: 'general', project_id: null, project_link: null, coverage: { scopes: ['general'] } });
    expect(ids(generalOnly.sources.general_assertions.records)).toEqual([general.id]);
    expect(generalOnly.sources.project_assertions).toMatchObject({ status: 'not_requested', records: [], total: 0 });
    expect(JSON.stringify(generalOnly)).not.toContain(exception.id);
});

test('absent project evidence with a populated directory stays missing and the directory is labelled as a default', () => {
    const result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'contact_channel' });
    expect(result.sources.project_assertions).toMatchObject({ status: 'missing', total: 0, records: [], is_project_statement: true,
        note: expect.stringMatching(/^No project-specific assertion is recorded/) });
    expect(result.sources.general_assertions).toMatchObject({ status: 'missing', records: [] });
    expect(result.sources.directory_settings).toMatchObject({ status: 'present', is_project_statement: false, note: expect.stringMatching(/Not a project statement/) });
    expect(result.sources.directory_settings.records).toEqual([expect.objectContaining({ field: 'preferences.channel', value: 'email', applies_to: 'all_projects' })]);

    const role = evidence.lookup(member, { scope: 'project', project_id: project, question: 'role' });
    expect(role.sources.directory_settings.records).toEqual([
        expect.objectContaining({ field: 'project.role', value: 'Tester', applies_to: 'project', is_project_statement: true, project_id: project, ref: `/api/members/${member}#project.role` }),
        expect.objectContaining({ field: 'project.decision_maker', value: true, applies_to: 'project', project_id: project }),
    ]);
    expectStatus(() => evidence.lookup(member, { scope: 'general', question: 'role' }), 400);
    expect(evidence.lookup(member, { scope: 'general', question: 'all' }).sources.directory_settings.records.map(record => record.field))
        .toEqual(['preferences.channel', 'preferences.tone', 'preferences.requireApproval', 'status', 'expertise', 'interests', 'claims']);

    ledger.append(member, fact('Probably phone.', 'profile.preference.contact_channel', { project_id: project, evidence: 'inferred', source: 'praxis' }));
    const inferred = evidence.lookup(member, { scope: 'project', project_id: project, question: 'contact_channel' });
    expect(inferred.sources.project_assertions).toMatchObject({ status: 'missing', records: [], note: expect.stringMatching(/Inferred project records are listed separately/) });
    expect(inferred.sources.inferred_observations).toMatchObject({ status: 'present', applies_to: [`project:${project}`, 'general'] });
    expect(inferred.sources.inferred_observations.records).toEqual([expect.objectContaining({ scope: 'project', project_id: project, source_class: 'inferred_observation',
        evidence: 'inferred', evidence_label: 'Inferred (unconfirmed)', text: 'Probably phone.' })]);
});

test('named questions discover ledger topics without an extra key, and fact_key narrows to one exact key', () => {
    const projectAvailability = ledger.append(member, fact('Evenings only on this project.', 'availability', { project_id: project, evidence: 'operator_confirmed', source: 'operator' }));
    const generalAvailability = ledger.append(member, fact('Weekdays in general.', 'profile.preference.availability'));
    const tone = ledger.append(member, fact('Keep it blunt.', 'profile.preference.tone'));
    const approval = ledger.append(member, fact('Ask before contacting me.', 'profile.preference.require_approval'));
    const role = ledger.append(member, fact('Lead tester here.', 'role', { project_id: project, evidence: 'operator_confirmed', source: 'operator' }));
    const goal = ledger.append(member, fact('Ship the beta.', 'profile.goal.beta'));
    const channelProposal = pendingProposal('I prefer email.', 'preference');
    expect(channelProposal.fact_key).toBe('profile.preference.contact_channel');

    const availability = evidence.lookup(member, { scope: 'project', project_id: project, question: 'availability' });
    expect(availability.question).toEqual({ type: 'availability', fact_key: null });
    expect(ids(availability.sources.project_assertions.records)).toEqual([projectAvailability.id]);
    expect(ids(availability.sources.general_assertions.records)).toEqual([generalAvailability.id]);
    expect(availability.sources.directory_settings).toMatchObject({ status: 'missing', records: [] });
    for (const excluded of [tone.id, approval.id, role.id, goal.id, channelProposal.id]) expect(JSON.stringify(availability)).not.toContain(excluded);

    expect(ids(evidence.lookup(member, { scope: 'general', question: 'tone' }).sources.general_assertions.records)).toEqual([tone.id]);
    const approvalResult = evidence.lookup(member, { scope: 'general', question: 'approval' });
    expect(ids(approvalResult.sources.general_assertions.records)).toEqual([approval.id]);
    expect(approvalResult.sources.directory_settings.records).toEqual([expect.objectContaining({ field: 'preferences.requireApproval', value: true, applies_to: 'all_projects' })]);
    const roleResult = evidence.lookup(member, { scope: 'project', project_id: project, question: 'role' });
    expect(ids(roleResult.sources.project_assertions.records)).toEqual([role.id]);
    expect(roleResult.sources.directory_settings.records.map(record => record.field)).toEqual(['project.role', 'project.decision_maker']);
    const preference = evidence.lookup(member, { scope: 'project', project_id: project, question: 'preference' });
    expect(ids(preference.sources.project_assertions.records)).toEqual([projectAvailability.id]);
    expect(ids(preference.sources.general_assertions.records)).toEqual([approval.id, tone.id, generalAvailability.id]);
    expect(ids(preference.context.pending_proposals.records)).toEqual([channelProposal.id]);
    expect(ids(evidence.lookup(member, { scope: 'general', question: 'contact_channel' }).context.pending_proposals.records)).toEqual([channelProposal.id]);
    expect(evidence.lookup(member, { scope: 'general', question: 'tone' }).context.pending_proposals).toMatchObject({ status: 'missing', records: [] });

    const exact = evidence.lookup(member, { scope: 'project', project_id: project, question: 'all', fact_key: 'availability' });
    expect(ids(exact.sources.project_assertions.records)).toEqual([projectAvailability.id]);
    expect(exact.sources.general_assertions).toMatchObject({ status: 'missing', records: [] });
    expect(exact.context.pending_proposals).toMatchObject({ status: 'missing', records: [] });
    const narrowed = evidence.lookup(member, { scope: 'project', project_id: project, question: 'availability', fact_key: 'profile.preference.availability' });
    expect(narrowed.sources.project_assertions).toMatchObject({ status: 'missing', records: [] });
    expect(ids(narrowed.sources.general_assertions.records)).toEqual([generalAvailability.id]);
    const disjoint = evidence.lookup(member, { scope: 'general', question: 'tone', fact_key: 'availability' });
    expect(disjoint.question).toEqual({ type: 'tone', fact_key: 'availability' });
    expect(disjoint.sources.general_assertions).toMatchObject({ status: 'missing', records: [] });
});

test('ambiguous identity: same-name members are flagged, only the canonical id is read, and names are refused', () => {
    const mine = ledger.append(member, fact('Mine', 'profile.goal.abc'));
    const theirs = ledger.append(twin, fact('Theirs', 'profile.goal.abc', { project_id: project }));
    const result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'goal' });
    expect(result.identity).toEqual({ member_id: member, name: 'Alex Rivera', seat_id: 'human:alex-rivera', kind: 'human', status: 'active',
        ambiguous: true, same_name_member_ids: [twin], note: expect.stringMatching(/shares this name/) });
    expect(ids(result.sources.general_assertions.records)).toEqual([mine.id]);
    expect(result.sources.project_assertions.status).toBe('missing');
    for (const leak of [theirs.id, 'Theirs', 'human:alex-rivera-2']) expect(JSON.stringify(result)).not.toContain(leak);

    const twinResult = evidence.lookup(twin, { scope: 'project', project_id: project, question: 'goal' });
    expect(ids(twinResult.sources.project_assertions.records)).toEqual([theirs.id]);
    expect(twinResult.identity).toMatchObject({ member_id: twin, ambiguous: true, same_name_member_ids: [member] });
    expect(twinResult.project_link).toEqual({ project_id: project, status: 'linked', role: 'Client', decision_maker: false });
    expect(JSON.stringify(twinResult)).not.toContain(mine.id);

    for (const notCanonical of ['Alex Rivera', 'human:alex-rivera', 'alex-private@example.com', member.slice(0, 35), `${member} `]) {
        expectStatus(() => evidence.lookup(notCanonical, { scope: 'general' }), 400);
    }
    expectStatus(() => evidence.lookup(randomUUID(), { scope: 'general' }), 404);
    raw.prepare('UPDATE contacts SET name = ? WHERE id = ?').run('Alexandra Rivera', twin);
    expect(evidence.lookup(member, { scope: 'general' }).identity).toMatchObject({ ambiguous: false, same_name_member_ids: [] });
});

test('corrected, retracted and conflicting facts stay truthful in history; pending proposals are not evidence', () => {
    const original = ledger.append(member, fact('Tuesdays', 'availability', { evidence: 'operator_confirmed', source: 'operator' }));
    const corrected = ledger.append(member, fact('Wednesdays', 'availability', { supersedes_id: original.id, evidence: 'operator_confirmed', source: 'operator', source_ref: 'meeting:42' }));
    const doomed = ledger.append(member, fact('Never', 'availability', { evidence: 'inferred', source: 'praxis' }));
    const retraction = ledger.append(member, { kind: 'retraction', target_id: doomed.id, text: 'Wrong inference', evidence: 'operator_confirmed', source: 'operator' });
    const a = ledger.append(member, fact('Mornings', 'profile.preference.slot'));
    const b = ledger.append(member, fact('Evenings', 'profile.preference.slot', { source: 'email' }));
    const pending = pendingProposal();
    expect(pending.status).toBe('pending');

    const result = evidence.lookup(member, { scope: 'general', question: 'all' });
    expect(ids(result.sources.general_assertions.records)).toEqual([b.id, a.id, corrected.id]);
    expect(result.sources.general_assertions.records.map(record => record.conflicted)).toEqual([true, true, false]);
    expect(result.sources.general_assertions.records[2]).toMatchObject({ supersedes_id: original.id, source_ref: 'meeting:42', evidence_label: 'Operator confirmed' });
    expect(result.sources.inferred_observations).toMatchObject({ status: 'missing', records: [] });
    expect(result.context.history.corrected.records).toEqual([expect.objectContaining({ id: original.id, text: 'Tuesdays', source_class: 'historical_fact',
        history_status: 'corrected', corrected_by: corrected.id, corrected_at: now })]);
    expect(result.context.history.retracted.records).toEqual([expect.objectContaining({ id: doomed.id, evidence: 'inferred', history_status: 'retracted',
        retracted_by: retraction.id, retraction_text: 'Wrong inference', retracted_at: now })]);
    expect(result.context.history.conflicts).toMatchObject({ status: 'present', records: [{ source_class: 'conflict', fact_key: 'profile.preference.slot', scope: 'general',
        project_id: null, event_ids: [b.id, a.id], status: 'unresolved', note: expect.stringMatching(/disagree/) }] });
    expect(result.context.pending_proposals).toMatchObject({ status: 'present', records: [expect.objectContaining({ id: pending.id, source_class: 'pending_proposal',
        is_evidence: false, status: 'pending', scope: 'general', category: 'goal', quote: 'I want to learn piano.', fact_key: pending.fact_key,
        reason: 'needs_review', capture_id: pending.capture_id, source_event_ids: pending.source_event_ids, source_origin: 'member_reply',
        evidence_label: expect.stringMatching(/unreviewed claim, not evidence/) })] });
    expect(JSON.stringify(result)).not.toContain('How can we work together?');

    const byKey = evidence.lookup(member, { scope: 'general', question: 'availability', fact_key: 'availability' });
    expect(ids(byKey.sources.general_assertions.records)).toEqual([corrected.id]);
    expect(ids(byKey.context.history.corrected.records)).toEqual([original.id]);
    expect(ids(byKey.context.history.retracted.records)).toEqual([doomed.id]);
    expect(byKey.context.history.conflicts.records).toEqual([]);
    expect(byKey.context.pending_proposals).toMatchObject({ status: 'missing', records: [] });
    expect(byKey.sources.directory_settings).toMatchObject({ status: 'missing', records: [] });
    expect(byKey.question).toEqual({ type: 'availability', fact_key: 'availability' });

    proposals.review(member, pending.id, { decision: 'accept', expected_memory_version: proposals.list(member).memory_version });
    const accepted = evidence.lookup(member, { scope: 'general', question: 'goal' });
    expect(accepted.context.pending_proposals.records).toEqual([]);
    expect(accepted.sources.general_assertions.records).toEqual([expect.objectContaining({ text: 'I want to learn piano.', evidence: 'self_reported',
        source: 'member_profile:review', source_ref: expect.stringContaining(`profile_proposal:${pending.id}`) })]);
});

test('unverified expertise stays a claim; demonstrated outcomes are completed member commitments and reputation is unavailable', () => {
    const claim = ledger.append(member, fact('I have run pricing workshops.', 'profile.expertise.abc'));
    const commitment = ledger.append(member, { kind: 'commitment', owner: 'member', text: 'Run a pricing workshop', evidence: 'self_reported', source: 'consultation', project_id: project });
    const praxisCommitment = ledger.append(member, { kind: 'commitment', owner: 'praxis', text: 'Send the agenda', evidence: 'operator_confirmed', source: 'operator', project_id: project });
    let result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'expertise' });
    expect(result.sources.general_assertions.records).toEqual([expect.objectContaining({ id: claim.id, source_class: 'general_assertion', evidence: 'self_reported',
        evidence_label: 'Member stated (claim, not independently verified)' })]);
    expect(result.sources.directory_settings.records).toEqual([
        expect.objectContaining({ field: 'expertise', value: ['pricing'], evidence_label: expect.stringMatching(/not verified/), applies_to: 'all_projects' }),
        expect.objectContaining({ field: 'claims', value: [{ domain: 'revenue-strategy', note: 'says so', claimed_at: '2026-09-01', source: 'self' }] }),
    ]);
    expect(result.sources.demonstrated_contributions).toMatchObject({ status: 'missing', records: [],
        external: { council_reputation: { status: 'unavailable', seat_id: 'human:alex-rivera', reason: expect.stringMatching(/not stored in Nexus/) } } });
    expect(result.sources.completion_claims).toMatchObject({ status: 'missing', records: [], note: expect.stringMatching(/not demonstrated outcomes/) });
    expect(result.context.open_commitments.status).toBe('not_requested');
    expect(result.sources.project_assertions.status).toBe('missing');

    ledger.append(member, { kind: 'resolution', target_id: praxisCommitment.id, outcome: 'completed', text: 'Sent', evidence: 'operator_confirmed', source: 'operator', project_id: project });
    const dropped = ledger.append(member, { kind: 'commitment', owner: 'member', text: 'Write the summary', evidence: 'self_reported', source: 'consultation', project_id: project });
    ledger.append(member, { kind: 'resolution', target_id: dropped.id, outcome: 'cancelled', text: 'Dropped', evidence: 'operator_confirmed', source: 'operator', project_id: project });
    result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'commitment' });
    expect(result.sources.demonstrated_contributions).toMatchObject({ status: 'missing', records: [] });
    expect(result.context.open_commitments).toMatchObject({ status: 'present', records: [expect.objectContaining({ id: commitment.id, scope: 'project', source_class: 'open_commitment', owner: 'member' })] });

    const resolution = ledger.append(member, { kind: 'resolution', target_id: commitment.id, outcome: 'completed', text: 'Workshop held 2026-09-15',
        evidence: 'operator_confirmed', source: 'operator', source_ref: 'meeting:77', project_id: project });
    result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'expertise' });
    expect(result.sources.demonstrated_contributions).toMatchObject({ status: 'present', records: [expect.objectContaining({ id: commitment.id, scope: 'project',
        source_class: 'demonstrated_contribution', owner: 'member', evidence_label: expect.stringMatching(/^Demonstrated outcome/),
        resolution: { id: resolution.id, seq: resolution.seq, recorded_at: now, text: 'Workshop held 2026-09-15', evidence: 'operator_confirmed', source: 'operator', outcome: 'completed', source_ref: 'meeting:77' } })] });
    expect(result.sources.general_assertions.records[0]).toMatchObject({ id: claim.id, source_class: 'general_assertion', evidence_label: expect.stringMatching(/claim/) });
    expect(JSON.stringify(result)).not.toContain(praxisCommitment.id);
    expect(evidence.lookup(member, { scope: 'project', project_id: project, question: 'contact_channel' }).sources.demonstrated_contributions.status).toBe('not_requested');

    const claimed = ledger.append(member, { kind: 'commitment', owner: 'member', text: 'Draft the survey', evidence: 'self_reported', source: 'consultation', project_id: project });
    const guess = ledger.append(member, { kind: 'resolution', target_id: claimed.id, outcome: 'completed', text: 'Probably sent it', evidence: 'inferred', source: 'praxis', project_id: project });
    const selfClaimed = ledger.append(member, { kind: 'commitment', owner: 'member', text: 'Post the notes', evidence: 'self_reported', source: 'consultation' });
    const selfSaid = ledger.append(member, { kind: 'resolution', target_id: selfClaimed.id, outcome: 'completed', text: 'I posted them', evidence: 'self_reported', source: 'consultation' });
    result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'commitment' });
    expect(ids(result.sources.demonstrated_contributions.records)).toEqual([commitment.id]);
    expect(result.sources.completion_claims).toMatchObject({ status: 'present', total: 2, records: [
        expect.objectContaining({ id: selfClaimed.id, scope: 'general', source_class: 'completion_claim', evidence_label: 'Completion claimed, not demonstrated (resolution evidence: self_reported)',
            resolution: expect.objectContaining({ id: selfSaid.id, evidence: 'self_reported', outcome: 'completed' }) }),
        expect.objectContaining({ id: claimed.id, scope: 'project', source_class: 'completion_claim', evidence_label: 'Completion claimed, not demonstrated (resolution evidence: inferred)',
            resolution: expect.objectContaining({ id: guess.id, evidence: 'inferred', outcome: 'completed' }) }),
    ] });
    for (const claim of [claimed.id, selfClaimed.id]) expect(JSON.stringify(result.sources.demonstrated_contributions)).not.toContain(claim);
    expect(evidence.lookup(member, { scope: 'project', project_id: project, question: 'contact_channel' }).sources.completion_claims.status).toBe('not_requested');
});

test('resolution strength decides the classification: table-driven over every evidence class, with partial results and foreign-project exclusion', () => {
    const cases = [
        { evidence: 'operator_confirmed', source: 'operator', bucket: 'demonstrated_contributions', source_class: 'demonstrated_contribution', label: /^Demonstrated outcome/ },
        { evidence: 'observed', source: 'praxis', bucket: 'demonstrated_contributions', source_class: 'demonstrated_contribution', label: /^Demonstrated outcome/ },
        { evidence: 'self_reported', source: 'consultation', bucket: 'completion_claims', source_class: 'completion_claim', label: /^Completion claimed, not demonstrated/ },
        { evidence: 'inferred', source: 'praxis', bucket: 'completion_claims', source_class: 'completion_claim', label: /^Completion claimed, not demonstrated/ },
        { evidence: 'legacy', source: 'legacy', bucket: 'completion_claims', source_class: 'completion_claim', label: /^Completion claimed, not demonstrated/, migrated: true },
    ];
    const seeded = cases.map(entry => {
        const commitment = ledger.append(member, { kind: 'commitment', owner: 'member', text: `Deliver (${entry.evidence})`, evidence: 'self_reported', source: 'consultation', project_id: project });
        const input = { kind: 'resolution', target_id: commitment.id, outcome: 'completed', text: `Done (${entry.evidence})`, evidence: entry.evidence, source: entry.source, project_id: project };
        if (!entry.migrated) return { ...entry, commitment, resolution: ledger.append(member, input) };
        // Legacy evidence is reserved for migration and refused by append, so seed the row the way the migration does.
        expectStatus(() => ledger.append(member, input), 400);
        const row = { id: randomUUID(), member_id: member, project_id: project, recorded_at: now, kind: 'resolution', text: input.text, evidence: 'legacy', source: 'legacy',
            target_id: commitment.id, outcome: 'completed', legacy_at: '2025-01-01', legacy_source: 'interaction_log' };
        const columns = Object.keys(row);
        raw.prepare(`INSERT INTO member_memory_events (${columns.join(', ')}, request_json) VALUES (${columns.map(() => '?').join(', ')}, ?)`).run(...Object.values(row), JSON.stringify(row));
        return { ...entry, commitment, resolution: { ...row, seq: raw.prepare('SELECT seq FROM member_memory_events WHERE id = ?').get(row.id).seq } };
    });

    const result = evidence.lookup(member, { scope: 'project', project_id: project, question: 'commitment' });
    for (const entry of seeded) {
        const other = entry.bucket === 'completion_claims' ? 'demonstrated_contributions' : 'completion_claims';
        expect(result.sources[entry.bucket].records).toContainEqual(expect.objectContaining({ id: entry.commitment.id, scope: 'project', project_id: project, source_class: entry.source_class,
            evidence_label: expect.stringMatching(entry.label),
            resolution: expect.objectContaining({ id: entry.resolution.id, seq: entry.resolution.seq, evidence: entry.evidence, source: entry.source, outcome: 'completed' }) }));
        expect(JSON.stringify(result.sources[other])).not.toContain(entry.commitment.id);
    }
    expect(result.sources.demonstrated_contributions).toMatchObject({ status: 'present', total: 2, truncated: false });
    expect(result.sources.demonstrated_contributions.records.map(record => record.resolution.evidence)).toEqual(['observed', 'operator_confirmed']);
    expect(result.sources.completion_claims).toMatchObject({ status: 'present', total: 3, truncated: false });
    expect(result.sources.completion_claims.records.map(record => record.resolution.evidence)).toEqual(['legacy', 'inferred', 'self_reported']);
    expect(result.context.open_commitments).toMatchObject({ status: 'missing', records: [] });

    const partial = evidence.lookup(member, { scope: 'project', project_id: project, question: 'commitment', limit: 2 });
    expect(partial.sources.completion_claims).toMatchObject({ status: 'partial', total: 3, truncated: true });
    expect(partial.sources.completion_claims.records.map(record => record.resolution.evidence)).toEqual(['legacy', 'inferred']);
    expect(partial.sources.demonstrated_contributions).toMatchObject({ status: 'present', total: 2, truncated: false });

    const foreignClaimed = ledger.append(member, { kind: 'commitment', owner: 'member', text: 'FOREIGN COMMITMENT', evidence: 'self_reported', source: 'consultation', project_id: otherProject });
    const foreignClaim = ledger.append(member, { kind: 'resolution', target_id: foreignClaimed.id, outcome: 'completed', text: 'FOREIGN CLAIM', evidence: 'inferred', source: 'praxis', project_id: otherProject });
    const foreignDone = ledger.append(member, { kind: 'commitment', owner: 'member', text: 'FOREIGN DONE', evidence: 'self_reported', source: 'consultation', project_id: otherProject });
    ledger.append(member, { kind: 'resolution', target_id: foreignDone.id, outcome: 'completed', text: 'FOREIGN OUTCOME', evidence: 'observed', source: 'praxis', project_id: otherProject });
    const scoped = evidence.lookup(member, { scope: 'project', project_id: project, question: 'commitment' });
    expect(scoped.sources.completion_claims.total).toBe(3);
    expect(scoped.sources.demonstrated_contributions.total).toBe(2);
    for (const leak of [foreignClaimed.id, foreignClaim.id, foreignDone.id, 'FOREIGN']) expect(JSON.stringify(scoped)).not.toContain(leak);
    const general = evidence.lookup(member, { scope: 'general', question: 'commitment' });
    expect(general.sources.completion_claims).toMatchObject({ status: 'missing', records: [] });
    expect(general.sources.demonstrated_contributions).toMatchObject({ status: 'missing', records: [] });
    const foreign = evidence.lookup(member, { scope: 'project', project_id: otherProject, question: 'commitment' });
    expect(ids(foreign.sources.completion_claims.records)).toEqual([foreignClaimed.id]);
    expect(ids(foreign.sources.demonstrated_contributions.records)).toEqual([foreignDone.id]);
    for (const entry of seeded) expect(JSON.stringify(foreign)).not.toContain(entry.commitment.id);
});

test('partial results, unavailable stores, deleted or unlinked projects and invalid queries are distinguishable', () => {
    for (let i = 0; i < 3; i++) ledger.append(member, fact(`Goal ${i}`, `profile.goal.${i}`));
    const partial = evidence.lookup(member, { scope: 'general', question: 'goal', limit: 2 });
    expect(partial.sources.general_assertions).toMatchObject({ status: 'partial', total: 3, truncated: true });
    expect(partial.sources.general_assertions.records).toHaveLength(2);
    expect(partial.coverage.limit).toBe(2);
    expect(evidence.lookup(member, { scope: 'general', question: 'goal' }).sources.general_assertions).toMatchObject({ status: 'present', total: 3, truncated: false });

    expectStatus(() => evidence.lookup(member, { scope: 'project', project_id: randomUUID() }), 404);
    const historical = ledger.append(member, fact('Kept', 'profile.goal.kept', { project_id: otherProject }));
    raw.prepare('DELETE FROM project_contacts WHERE project_id = ?').run(otherProject);
    raw.prepare('DELETE FROM projects WHERE id = ?').run(otherProject);
    const deleted = evidence.lookup(member, { scope: 'project', project_id: otherProject, question: 'role' });
    expect(deleted.project_link).toEqual({ project_id: otherProject, status: 'project_deleted', role: null, decision_maker: null });
    expect(deleted.sources.directory_settings).toMatchObject({ status: 'missing', records: [], project_fields: { status: 'unavailable', reason: expect.any(String) } });
    expect(ids(evidence.lookup(member, { scope: 'project', project_id: otherProject, question: 'goal' }).sources.project_assertions.records)).toEqual([historical.id]);
    raw.prepare('DELETE FROM project_contacts WHERE project_id = ? AND contact_id = ?').run(project, member);
    expect(evidence.lookup(member, { scope: 'project', project_id: project }).project_link).toEqual({ project_id: project, status: 'unlinked', role: null, decision_maker: null });

    raw.exec('DROP TABLE member_profile_proposals');
    expect(evidence.lookup(member, { scope: 'general' }).context.pending_proposals).toMatchObject({ status: 'unavailable', reason: expect.any(String), records: [] });

    for (const options of [undefined, null, [], {}, { scope: 'all' }, { scope: 'project' }, { scope: 'project', project_id: ' ' }, { scope: 'general', project_id: project },
        { scope: 'general', question: 'nope' }, { scope: 'general', question: 42 }, { scope: 'general', fact_key: '' }, { scope: 'general', fact_key: 'x'.repeat(201) },
        { scope: 'general', limit: 0 }, { scope: 'general', limit: 201 }, { scope: 'general', limit: 1.5 }, { scope: 'general', limit: '5' }]) {
        expectStatus(() => evidence.lookup(member, options), 400);
    }
    expect(QUESTION_TYPES).toEqual(['all', 'contact_channel', 'tone', 'availability', 'approval', 'role', 'preference', 'goal', 'expertise', 'commitment']);
});

test('private directory details and raw observations never enter the lookup', () => {
    ledger.append(member, { kind: 'observation', text: 'RAW CONSULTATION TRANSCRIPT', evidence: 'self_reported', source: 'consultation' });
    ledger.append(member, { kind: 'observation', text: 'PROJECT PRIVATE NOTE', evidence: 'observed', source: 'praxis', project_id: project });
    const json = JSON.stringify(evidence.lookup(member, { scope: 'project', project_id: project }));
    for (const secret of ['alex-private@example.com', '555-0100', '1990-01-01', 'PRIVATE DIRECTORY NOTE', 'RAW CONSULTATION TRANSCRIPT', 'PROJECT PRIVATE NOTE']) {
        expect(json).not.toContain(secret);
    }
    expect(JSON.parse(json).coverage).toMatchObject({ observations_included: false, contact_details_included: false });
});
