/**
 * Member commitment queue over synthetic data: canonical ledger statuses,
 * explicit scope and coverage, corrections and cancellations that never revive
 * a superseded promise, and follow-up drafts that stay distinct from delivery.
 * Every write here is a ledger append; the queue itself never writes.
 */
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { initializeMemberMemory, createMemberMemoryLedger } = require('../../db/member-memory');
const { createMemberCommitments, STATUSES, SCOPES, parseLinks } = require('../../db/member-commitments');

const now = '2026-09-18T12:00:00.000Z';
const PAST = '2026-09-10T09:00:00.000Z';
const FUTURE = '2026-09-25T09:00:00.000Z';
let raw, ledger, queue, member, other, projectA, projectB;

const commitment = (text, extra = {}) => ({ kind: 'commitment', text, owner: 'member', evidence: 'self_reported', source: 'stakeholder_meeting', ...extra });
const resolution = (targetId, outcome, text, extra = {}) => ({ kind: 'resolution', target_id: targetId, outcome, text,
    evidence: 'operator_confirmed', source: 'operator', ...extra });
const observation = (text, sourceRef, extra = {}) => ({ kind: 'observation', text, source_ref: sourceRef,
    evidence: 'observed', source: 'praxis.followup', ...extra });
const expectStatus = (fn, status) => expect(fn).toThrow(expect.objectContaining({ status }));
const ids = entries => entries.map(entry => entry.id);
const byId = (result, id) => result.commitments.find(entry => entry.id === id);

beforeEach(() => {
    raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(`CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, seat_id TEXT, interaction_log TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE project_contacts (project_id TEXT, contact_id TEXT, role TEXT, PRIMARY KEY(project_id, contact_id))`);
    member = randomUUID(); other = randomUUID(); projectA = randomUUID(); projectB = randomUUID();
    raw.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?)').run(member, 'Alex Rivera', 'human:alex-rivera', '[]');
    raw.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?)').run(other, 'Sam Doyle', 'human:sam-doyle', '[]');
    raw.prepare('INSERT INTO projects VALUES (?, ?)').run(projectA, 'Project A');
    raw.prepare('INSERT INTO projects VALUES (?, ?)').run(projectB, 'Project B');
    for (const project of [projectA, projectB]) {
        for (const contact of [member, other]) raw.prepare('INSERT INTO project_contacts VALUES (?, ?, ?)').run(project, contact, 'Tester');
    }
    initializeMemberMemory(raw);
    ledger = createMemberMemoryLedger(raw, { now: () => now });
    queue = createMemberCommitments(raw, { now: () => now });
});
afterEach(() => raw?.close());

test('the queue exposes open, overdue, completed and cancelled commitments with owner, member, project, source and explicit unknown deadlines', () => {
    const open = ledger.append(member, commitment('I will review the pricing deck.', { project_id: projectA, due_at: FUTURE, source_ref: 'meeting:2026-09-16#12' }));
    const overdue = ledger.append(member, commitment('I will send the signed NDA.', { project_id: projectA, due_at: PAST, source_ref: 'meeting:2026-09-08#3' }));
    const unknown = ledger.append(member, commitment('I will get you the logo files soon.', { project_id: projectA }));
    const done = ledger.append(other, commitment('Praxis will circulate the agenda.', { project_id: projectB, owner: 'praxis', due_at: PAST }));
    const dropped = ledger.append(other, commitment('Praxis will book the venue.', { project_id: projectB, owner: 'praxis' }));
    const completion = ledger.append(other, resolution(done.id, 'completed', 'Agenda circulated 2026-09-12.', { project_id: projectB }));
    const cancellation = ledger.append(other, resolution(dropped.id, 'cancelled', 'Meeting moved online; no venue needed.', { project_id: projectB }));

    const result = queue.list({ scope: 'operator' });
    expect(result.status).toBe('ok');
    expect(result.as_of).toBe(now);
    expect(result.summary).toEqual({ total: 5, by_status: { open: 2, overdue: 1, completed: 1, cancelled: 1 },
        by_owner: { praxis: 2, member: 3 }, deadline_unknown: 2, with_prepared_draft: 0 });

    expect(byId(result, open.id)).toMatchObject({ status: 'open', owner: 'member',
        member: { id: member, name: 'Alex Rivera', seat_id: 'human:alex-rivera', ref: `/api/members/${member}` },
        project: { id: projectA, name: 'Project A', scope: 'project', status: 'active' },
        due: { status: 'recorded', due_at: FUTURE, overdue: false } });
    expect(byId(result, open.id).source).toEqual({ text: 'I will review the pricing deck.', source: 'stakeholder_meeting',
        source_ref: 'meeting:2026-09-16#12', evidence: 'self_reported', evidence_label: 'Member stated (claim, not independently verified)',
        event_id: open.id, seq: open.seq, recorded_at: now, occurred_at: null,
        ref: `/api/members/${member}/memory?project_id=${encodeURIComponent(projectA)}` });

    expect(byId(result, overdue.id)).toMatchObject({ status: 'overdue', due: { status: 'recorded', due_at: PAST, overdue: true } });
    expect(byId(result, overdue.id).attention).toEqual(expect.arrayContaining(['overdue', 'no_draft_prepared']));
    expect(byId(result, unknown.id)).toMatchObject({ status: 'open', due: { status: 'unknown', due_at: null, overdue: false } });
    expect(byId(result, unknown.id).due.note).toMatch(/Relative prose in the quoted text is not a deadline/);
    expect(byId(result, done.id)).toMatchObject({ status: 'completed', owner: 'praxis',
        resolution: { id: completion.id, outcome: 'completed', text: 'Agenda circulated 2026-09-12.', evidence: 'operator_confirmed' } });
    expect(byId(result, dropped.id)).toMatchObject({ status: 'cancelled', owner: 'praxis',
        resolution: { id: cancellation.id, outcome: 'cancelled', text: 'Meeting moved online; no venue needed.' } });

    // A closed commitment is never listed as needing attention, and never carries a deadline it did not have.
    expect(byId(result, dropped.id).attention).toEqual([]);
    expect(byId(result, dropped.id).due).toEqual({ status: 'unknown', due_at: null, overdue: false, note: expect.any(String) });
    expect(queue.list({ scope: 'operator', status: 'overdue' }).commitments.map(entry => entry.id)).toEqual([overdue.id]);
    expect(ids(queue.list({ scope: 'operator', owner: 'praxis' }).commitments).sort()).toEqual([done.id, dropped.id].sort());
    expect(result.usage_guidance).toMatch(/do not invent one from its text/);
});

test('exact member and project filters never leak another scope, and the cross-project aggregate is explicit', () => {
    const inA = ledger.append(member, commitment('Alex: pricing deck for A.', { project_id: projectA }));
    const inB = ledger.append(member, commitment('Alex: beta feedback for B.', { project_id: projectB }));
    const general = ledger.append(member, commitment('Alex: general intro to a designer.'));
    const otherMember = ledger.append(other, commitment('Sam: venue shortlist for A.', { project_id: projectA }));

    const exact = queue.list({ scope: 'member', member_id: member, project_id: projectA });
    expect(ids(exact.commitments)).toEqual([inA.id]);
    expect(exact.coverage).toMatchObject({ scope: 'member', members_included: 'one', member_id: member, projects_included: `project:${projectA}` });
    const json = JSON.stringify(exact);
    for (const leak of [inB.id, general.id, otherMember.id, 'Project B', 'Sam Doyle']) expect(json).not.toContain(leak);

    expect(ids(queue.list({ scope: 'member', member_id: member, project_id: 'general' }).commitments)).toEqual([general.id]);
    expect(ids(queue.list({ scope: 'member', member_id: member }).commitments).sort()).toEqual([inA.id, inB.id, general.id].sort());
    expect(ids(queue.list({ scope: 'project', project_id: projectA }).commitments).sort()).toEqual([inA.id, otherMember.id].sort());

    const aggregate = queue.list({ scope: 'operator' });
    expect(ids(aggregate.commitments).sort()).toEqual([inA.id, inB.id, general.id, otherMember.id].sort());
    expect(aggregate.coverage).toMatchObject({ scope: 'operator', members_included: 'all', member_id: null, projects_included: 'all_projects_and_general' });
    expect(aggregate.commitments.find(entry => entry.id === general.id).project).toEqual({ id: null, name: null, scope: 'general', status: 'general' });

    // The aggregate is opt-in and takes no filters; scope is never implicit.
    expectStatus(() => queue.list({ scope: 'operator', project_id: projectA }), 400);
    expectStatus(() => queue.list({ scope: 'member' }), 400);
    expectStatus(() => queue.list({ scope: 'project' }), 400);
    expectStatus(() => queue.list({}), 400);
    expectStatus(() => queue.list({ scope: 'member', member_id: 'alex@example.com' }), 400);
    expectStatus(() => queue.list({ scope: 'member', member_id: randomUUID() }), 404);
    expectStatus(() => queue.list({ scope: 'project', project_id: randomUUID() }), 404);
    expectStatus(() => queue.list({ scope: 'operator', status: 'stale' }), 400);
    expectStatus(() => queue.list({ scope: 'operator', owner: 'robert' }), 400);
});

test('relative-date prose without due_at stays open with an explicitly unknown deadline and no invented date', () => {
    const vague = ledger.append(member, commitment('I will send the sponsorship numbers next week, probably Thursday.', { project_id: projectA }));
    const dated = ledger.append(member, commitment('I will send the contract.', { project_id: projectA, due_at: PAST }));

    const result = queue.list({ scope: 'member', member_id: member, project_id: projectA });
    const entry = byId(result, vague.id);
    expect(entry.status).toBe('open');
    expect(entry.due).toEqual({ status: 'unknown', due_at: null, overdue: false, note: expect.stringContaining('No deadline was recorded') });
    expect(entry.attention).toContain('deadline_unknown');
    expect(entry.attention).not.toContain('overdue');
    expect(entry.source.text).toBe('I will send the sponsorship numbers next week, probably Thursday.');
    expect(result.summary.deadline_unknown).toBe(1);
    // Only the recorded deadline produces an overdue commitment.
    expect(ids(queue.list({ scope: 'member', member_id: member, status: 'overdue' }).commitments)).toEqual([dated.id]);
});

test('repeated draft linkage lists one draft with its preparations and changes neither delivery nor commitment status', () => {
    const promise = ledger.append(member, commitment('I will confirm the sponsorship.', { project_id: projectA, due_at: PAST }));
    const before = queue.list({ scope: 'member', member_id: member, project_id: projectA });
    expect(byId(before, promise.id)).toMatchObject({ status: 'overdue', follow_ups: { drafts: { status: 'missing', total: 0 }, messages: { status: 'missing', total: 0 } } });

    const first = ledger.append(member, observation('Draft follow-up prepared, awaiting approval.',
        `commitment:${promise.id} draft:hitl-followup-1`, { project_id: projectA }));
    const second = ledger.append(member, observation('Follow-up draft revised after the deadline passed.',
        `commitment:${promise.id} draft:hitl-followup-1`, { project_id: projectA }));

    const after = queue.list({ scope: 'member', member_id: member, project_id: projectA });
    const entry = byId(after, promise.id);
    expect(entry.status).toBe('overdue');
    expect(entry.resolution).toBeNull();
    expect(entry.follow_ups.drafts).toMatchObject({ status: 'present', total: 1 });
    expect(entry.follow_ups.drafts.records[0]).toMatchObject({ draft_id: 'hitl-followup-1', status: 'prepared', sent_as: null,
        prepared_count: 2, event_ids: [first.id, second.id], event_id: second.id,
        text: 'Follow-up draft revised after the deadline passed.', source: 'praxis.followup' });
    expect(entry.follow_ups.messages).toMatchObject({ status: 'missing', total: 0, records: [] });
    expect(entry.follow_ups.note).toMatch(/not a sent message and does not resolve a commitment/);
    expect(after.summary.by_status).toEqual({ open: 0, overdue: 1, completed: 0, cancelled: 0 });
    expect(after.summary.with_prepared_draft).toBe(1);

    // A draft linked from a different project never attaches to this commitment.
    ledger.append(member, observation('Unrelated draft in another project.', `commitment:${promise.id} draft:wrong-scope`, { project_id: projectB }));
    expect(byId(queue.list({ scope: 'operator' }), promise.id).follow_ups.drafts.total).toBe(1);
});

test('a delivered message is listed apart from its draft and still does not resolve the commitment', () => {
    const promise = ledger.append(member, commitment('I will confirm the sponsorship.', { project_id: projectA, due_at: PAST }));
    ledger.append(member, observation('Draft prepared.', `commitment:${promise.id} draft:hitl-followup-7`, { project_id: projectA }));
    const sent = ledger.append(member, observation('Follow-up sent, Robert copied.',
        `commitment:${promise.id} draft:hitl-followup-7 message:email-9001`, { project_id: projectA }));

    const entry = byId(queue.list({ scope: 'member', member_id: member, project_id: projectA }), promise.id);
    expect(entry.status).toBe('overdue');
    expect(entry.resolution).toBeNull();
    expect(entry.follow_ups.drafts.records[0]).toMatchObject({ draft_id: 'hitl-followup-7', status: 'sent', sent_as: 'email-9001', prepared_count: 2 });
    expect(entry.follow_ups.messages).toMatchObject({ status: 'present', total: 1 });
    expect(entry.follow_ups.messages.records[0]).toMatchObject({ message_id: 'email-9001', draft_ids: ['hitl-followup-7'],
        event_id: sent.id, text: 'Follow-up sent, Robert copied.' });

    // Only a recorded resolution closes it.
    const closed = ledger.append(member, resolution(promise.id, 'completed', 'Sponsorship confirmed in writing.', { project_id: projectA }));
    const refreshed = byId(queue.list({ scope: 'member', member_id: member, project_id: projectA }), promise.id);
    expect(refreshed).toMatchObject({ status: 'completed', resolution: { id: closed.id, outcome: 'completed' } });
    expect(refreshed.follow_ups.drafts.total).toBe(1);
});

test('a cancelled commitment and its correction: the superseded promise is reflected on refresh and never revived', () => {
    const wrong = ledger.append(member, commitment('I will deliver the report by Friday.', { project_id: projectA, due_at: PAST, source_ref: 'meeting:2026-09-08#4' }));
    const cancelled = ledger.append(member, resolution(wrong.id, 'cancelled', 'Deadline was misheard; re-recording with the agreed date.', { project_id: projectA }));
    const replacement = ledger.append(member, commitment('I will deliver the report by the 25th.',
        { project_id: projectA, due_at: FUTURE, source_ref: `corrects:${wrong.id} meeting:2026-09-16#9` }));

    const result = queue.list({ scope: 'member', member_id: member, project_id: projectA });
    expect(result.summary.by_status).toEqual({ open: 1, overdue: 0, completed: 0, cancelled: 1 });
    expect(result.commitments.filter(entry => entry.id === wrong.id)).toHaveLength(1);
    expect(byId(result, wrong.id)).toMatchObject({ status: 'cancelled', correction: { corrects: null, superseded_by: replacement.id },
        resolution: { id: cancelled.id, outcome: 'cancelled', text: 'Deadline was misheard; re-recording with the agreed date.' } });
    expect(byId(result, wrong.id).attention).toEqual([]);
    expect(byId(result, replacement.id)).toMatchObject({ status: 'open', correction: { corrects: [wrong.id], superseded_by: null },
        due: { status: 'recorded', due_at: FUTURE, overdue: false } });
    expect(ids(queue.list({ scope: 'member', member_id: member, status: 'open,overdue' }).commitments)).toEqual([replacement.id]);

    // Resolving the replacement does not bring the superseded promise back into the open queue.
    ledger.append(member, resolution(replacement.id, 'completed', 'Report delivered.', { project_id: projectA }));
    const refreshed = queue.list({ scope: 'member', member_id: member, project_id: projectA });
    expect(refreshed.summary.by_status).toEqual({ open: 0, overdue: 0, completed: 1, cancelled: 1 });
    expect(ids(refreshed.commitments).filter(id => id === wrong.id)).toHaveLength(1);
    expect(byId(refreshed, wrong.id).status).toBe('cancelled');

    // The ledger stays the single store: the queue appends nothing and creates no table of its own.
    const events = () => raw.prepare('SELECT COUNT(*) AS total FROM member_memory_events').get().total;
    const countBefore = events();
    queue.list({ scope: 'operator' });
    expect(events()).toBe(countBefore);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%commitment%'").all()).toEqual([]);
});

// Reassignment runs both ways: a member promise picked up by Praxis, and a Praxis promise handed back.
test.each([
    { from: 'member', to: 'praxis', note: 'Reassigned to Praxis.' },
    { from: 'praxis', to: 'member', note: 'Handed back to the member.' },
])('a correction reassigning $from to $to keeps its link under an owner filter', ({ from, to, note }) => {
    const original = ledger.append(member, commitment('I will send the deck.', { project_id: projectA, owner: from, due_at: PAST }));
    const cancelled = ledger.append(member, resolution(original.id, 'cancelled', note, { project_id: projectA }));
    const replacement = ledger.append(member, commitment('The deck will be sent by the new owner.',
        { project_id: projectA, owner: to, due_at: FUTURE, evidence: 'observed', source: 'praxis.plan', source_ref: `corrects:${original.id}` }));

    // The owner filter narrows what is returned, never the correction index: the handed-over promise keeps its link.
    for (const options of [{}, { owner: from }]) {
        const result = queue.list({ scope: 'member', member_id: member, project_id: projectA, ...options });
        expect(byId(result, original.id)).toMatchObject({ status: 'cancelled', owner: from,
            correction: { corrects: null, superseded_by: replacement.id }, resolution: { id: cancelled.id, outcome: 'cancelled' } });
        expect(byId(result, original.id).attention).toEqual([]);
    }
    // Returned commitments and totals still respect the owner filter.
    const oldOwner = queue.list({ scope: 'member', member_id: member, project_id: projectA, owner: from });
    expect(ids(oldOwner.commitments)).toEqual([original.id]);
    expect(oldOwner.summary).toMatchObject({ total: 1, by_owner: { [from]: 1, [to]: 0 },
        by_status: { open: 0, overdue: 0, completed: 0, cancelled: 1 } });
    const newOwner = queue.list({ scope: 'member', member_id: member, project_id: projectA, owner: to });
    expect(ids(newOwner.commitments)).toEqual([replacement.id]);
    expect(byId(newOwner, replacement.id)).toMatchObject({ status: 'open', owner: to, correction: { corrects: [original.id], superseded_by: null } });
});

test('an unresolved commitment whose replacement was recorded is flagged rather than silently closed', () => {
    const original = ledger.append(member, commitment('I will draft the charter.', { project_id: projectA, due_at: PAST }));
    const replacement = ledger.append(member, commitment('I will draft the charter (corrected wording).',
        { project_id: projectA, due_at: FUTURE, source_ref: `corrects:${original.id}` }));
    const result = queue.list({ scope: 'member', member_id: member, project_id: projectA });
    expect(byId(result, original.id)).toMatchObject({ status: 'overdue', correction: { superseded_by: replacement.id } });
    expect(byId(result, original.id).attention).toContain('superseded_but_unresolved');
});

test('coverage and paging: totals span the whole scope and a truncated page names its cursor', () => {
    const created = [];
    for (let index = 0; index < 5; index += 1) {
        created.push(ledger.append(member, commitment(`Promise ${index}`, { project_id: projectA, due_at: index % 2 ? PAST : FUTURE })));
    }
    const first = queue.list({ scope: 'member', member_id: member, project_id: projectA, limit: 2 });
    expect(ids(first.commitments)).toEqual([created[4].id, created[3].id]);
    expect(first.summary.total).toBe(5);
    expect(first.coverage.paging).toEqual({ limit: 2, returned: 2, matched_total: 5, remaining_after_page: 3,
        truncated: true, next_before_seq: created[3].seq, complete: false });
    expect(first.coverage.note).toMatch(/must never be treated as "no commitments"/);
    expect(first.coverage.ledger).toEqual({ status: 'available', source: 'member_memory_events' });

    const second = queue.list({ scope: 'member', member_id: member, project_id: projectA, limit: 2, before_seq: first.coverage.paging.next_before_seq });
    expect(ids(second.commitments)).toEqual([created[2].id, created[1].id]);
    expect(second.coverage.paging).toMatchObject({ truncated: true, complete: false, remaining_after_page: 1 });
    const third = queue.list({ scope: 'member', member_id: member, project_id: projectA, limit: 2, before_seq: second.coverage.paging.next_before_seq });
    expect(ids(third.commitments)).toEqual([created[0].id]);
    expect(third.coverage.paging).toMatchObject({ returned: 1, truncated: false, next_before_seq: null, complete: true, remaining_after_page: 0 });

    // A status filter narrows the page but never the scope-wide totals.
    const overdueOnly = queue.list({ scope: 'member', member_id: member, project_id: projectA, status: 'overdue', limit: 1 });
    expect(overdueOnly.summary.total).toBe(5);
    expect(overdueOnly.coverage.paging).toMatchObject({ matched_total: 2, returned: 1, truncated: true, complete: false });
    expectStatus(() => queue.list({ scope: 'operator', limit: 0 }), 400);
    expectStatus(() => queue.list({ scope: 'operator', before_seq: 0 }), 400);
});

test('an unreadable ledger reports unavailable with no summary instead of an empty queue', () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, seat_id TEXT); CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)');
    const offline = createMemberCommitments(bare, { now: () => now });
    const result = offline.list({ scope: 'operator' });
    expect(result.status).toBe('unavailable');
    expect(result.summary).toBeNull();
    expect(result.commitments).toEqual([]);
    expect(result.coverage.ledger).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('not initialized') });
    expect(result.coverage.paging).toMatchObject({ matched_total: null, complete: false });
    expect(result.coverage.note).toMatch(/not proof that none exists elsewhere/);
    bare.close();
});

test('the link grammar reads only its own tokens and ignores every other source_ref shape', () => {
    expect(parseLinks(`commitment:abc-1 draft:hitl-7 message:email-9; corrects:def-2`))
        .toEqual({ commitment: ['abc-1'], draft: ['hitl-7'], message: ['email-9'], corrects: ['def-2'] });
    // Other token types, and anything not standing on its own, are left alone.
    expect(parseLinks('consultation:123:revision:456:part:1/1')).toEqual({ commitment: [], draft: [], message: [], corrects: [] });
    expect(parseLinks('notacommitment:abc')).toEqual({ commitment: [], draft: [], message: [], corrects: [] });
    expect(parseLinks(null)).toEqual({ commitment: [], draft: [], message: [], corrects: [] });
    // A repeated token is one link, and the exposed vocabularies are the documented ones.
    expect(parseLinks('draft:d1, draft:d1 draft:d2').draft).toEqual(['d1', 'd2']);
    expect(STATUSES).toEqual(['open', 'overdue', 'completed', 'cancelled']);
    expect(SCOPES).toEqual(['member', 'project', 'operator']);
});

test('a deleted project keeps its commitments readable and labelled', () => {
    const promise = ledger.append(member, commitment('I will hand over the assets.', { project_id: projectB, due_at: PAST }));
    raw.prepare('DELETE FROM project_contacts WHERE project_id = ?').run(projectB);
    raw.prepare('DELETE FROM projects WHERE id = ?').run(projectB);
    const result = queue.list({ scope: 'project', project_id: projectB });
    expect(ids(result.commitments)).toEqual([promise.id]);
    expect(byId(result, promise.id).project).toEqual({ id: projectB, name: null, scope: 'project', status: 'deleted' });
});
