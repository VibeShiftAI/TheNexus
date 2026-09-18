import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemberEvidence } from '../member-evidence.tsx';

const member = '00000000-0000-4000-8000-000000000001', twin = '00000000-0000-4000-8000-000000000009';
const project = 'fixture-project', otherProject = 'other-project';
const generalId = '00000000-0000-4000-8000-000000000002', inferredId = '00000000-0000-4000-8000-000000000003';
const originalId = '00000000-0000-4000-8000-000000000004', correctionId = '00000000-0000-4000-8000-000000000005', proposalId = '00000000-0000-4000-8000-000000000006';
const bucket = (label, records = [], extra = {}) => ({ label, applies_to: 'general', status: records.length ? 'present' : 'missing', total: records.length, truncated: false, records, ...extra });
const notRequested = label => ({ label, applies_to: null, status: 'not_requested', total: 0, truncated: false, records: [] });
const ledgerRecord = (id, extra) => ({ id, seq: 1, member_id: member, project_id: null, scope: 'general', kind: 'fact', fact_key: 'profile.preference.contact_channel',
  text: 'I prefer email.', evidence: 'self_reported', evidence_label: 'Member stated (claim, not independently verified)', source: 'consultation',
  source_ref: 'consultation:1', recorded_at: '2026-09-18T12:00:00.000Z', source_class: 'general_assertion', conflicted: false, ...extra });
function fixture(overrides = {}) {
  return {
    member_id: member, scope: 'project', project_id: project, question: { type: 'all', fact_key: null }, as_of: '2026-09-18T12:00:00.000Z',
    directory_updated_at: '2026-09-10T00:00:00.000Z',
    identity: { member_id: member, name: 'Alex Rivera', seat_id: 'human:alex-rivera', kind: 'human', status: 'active', ambiguous: true, same_name_member_ids: [twin], note: 'Another member record shares this name.' },
    project_link: { project_id: project, status: 'linked', role: 'Tester', decision_maker: false },
    sources: {
      directory_settings: bucket('Global directory settings', [{ source_class: 'directory_setting', field: 'preferences.channel', label: 'Preferred contact channel', value: 'email',
        evidence: 'directory', evidence_label: 'Directory operating setting (operator-maintained)', applies_to: 'all_projects', project_id: null, is_project_statement: false,
        ref: `/api/members/${member}#preferences.channel`, updated_at: '2026-09-10T00:00:00.000Z' }], { applies_to: 'all_projects', is_project_statement: false, note: 'Not a project statement.' }),
      general_assertions: bucket('General member assertions', [ledgerRecord(generalId)], { is_project_statement: false }),
      project_assertions: bucket('Project-specific assertions', [], { applies_to: `project:${project}`, is_project_statement: true,
        note: 'No project-specific assertion is recorded for this project and question. Do not answer from the general or directory context as if it were a project statement.' }),
      inferred_observations: bucket('Inferred records (unconfirmed)', [ledgerRecord(inferredId, { seq: 2, project_id: project, scope: 'project', text: 'Probably phone.',
        evidence: 'inferred', evidence_label: 'Inferred (unconfirmed)', source: 'praxis', source_ref: undefined, source_class: 'inferred_observation' })]),
      demonstrated_contributions: bucket('Demonstrated outcomes', [], { external: { council_reputation: { status: 'unavailable', seat_id: 'human:alex-rivera', reason: 'Council reputation standing is not stored in Nexus.' } } }),
      completion_claims: bucket('Completion claims (not demonstrated)'),
    },
    context: {
      open_commitments: notRequested('Open commitments'),
      pending_proposals: bucket('Pending profile proposals (unreviewed)', [{ source_class: 'pending_proposal', is_evidence: false, status: 'pending', scope: 'general', id: proposalId, created_seq: 1,
        project_id: null, category: 'expertise', quote: 'I have worked on access testing.', fact_key: 'profile.expertise.fixture', reason: 'needs_review', created_at: '2026-09-18T12:00:00.000Z',
        capture_id: '00000000-0000-4000-8000-000000000007', source_event_ids: ['00000000-0000-4000-8000-000000000008'], source_origin: 'member_reply',
        source_occurred_at: '2026-09-17T10:00:00.000Z', evidence_label: 'Pending profile proposal (unreviewed claim, not evidence)' }]),
      history: {
        corrected: bucket('Corrected facts', [ledgerRecord(originalId, { seq: 3, fact_key: 'availability', text: 'Tuesdays', evidence: 'operator_confirmed', evidence_label: 'Operator confirmed',
          source: 'operator', source_class: 'historical_fact', history_status: 'corrected', corrected_by: correctionId, corrected_at: '2026-09-18T12:00:00.000Z' })]),
        retracted: bucket('Retracted facts'),
        conflicts: bucket('Unresolved conflicts', [{ fact_key: 'profile.preference.slot', scope: 'general', project_id: null, event_ids: [generalId, originalId], status: 'unresolved',
          note: 'Several active assertions disagree.', source_class: 'conflict' }]),
      },
    },
    coverage: { scopes: [`project:${project}`, 'general'], other_projects_included: false, observations_included: false, contact_details_included: false, limit: 50 },
    usage_guidance: 'Global directory settings apply to every project by default and are never project statements.',
    ...overrides,
  };
}
const json = (body, status = 200) => Response.json(body, { status });
async function mount(fetcher, props = {}) {
  const original = globalThis.fetch; globalThis.fetch = fetcher;
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  await act(async () => root.render(React.createElement(MemberEvidence, { memberId: member, projectId: project, version: null, defaultOpen: true, ...props })));
  return { node, dispose: async () => { await act(async () => root.unmount()); node.remove(); globalThis.fetch = original; } };
}
function select(node, label, value) {
  const field = node.querySelector(`[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(field, value);
  field.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('labels every source separately: missing project assertion, directory default, claim, inference, pending proposal, history and identity warning', async () => {
  const urls = [];
  const h = await mount(async url => { urls.push(new URL(url, 'http://localhost')); return json(fixture()); });
  try {
    assert.equal(urls.length, 1);
    assert.equal(urls[0].pathname, `/api/members/${member}/evidence`);
    const params = Object.fromEntries(urls[0].searchParams); delete params._cb;
    assert.deepEqual(params, { scope: 'project', question: 'all', project_id: project });
    const text = h.node.textContent;
    assert.match(text, /No project-specific assertion is recorded for this project/);
    assert.match(text, /Project-specific assertions \(this project\)No project-specific assertion is recorded[^]*?None recorded/);
    assert.match(text, /Global directory settings \(default context, not a project statement\)/);
    assert.match(text, /Preferred contact channel: email/);
    assert.match(text, /Applies to all projects by default; not a project statement/);
    assert.match(text, /General member assertions \(not project-specific\)/);
    assert.match(text, /Member stated \(claim, not independently verified\)/);
    assert.match(text, /consultation:1/);
    assert.match(text, /Inferred \(unconfirmed\)/); assert.match(text, /Probably phone\./); assert.match(text, /This project · profile\.preference\.contact_channel/);
    assert.match(text, /Pending profile proposal \(unreviewed claim, not evidence\)/); assert.match(text, /I have worked on access testing\./);
    assert.match(text, /Corrected facts \(history\)/); assert.match(text, /Tuesdays/); assert.match(text, new RegExp(`Corrected by ${correctionId}`));
    assert.match(text, /Unresolved conflicts/); assert.match(text, /profile\.preference\.slot/);
    assert.match(text, /Council reputation standing: unavailable/);
    assert.match(text, /Open commitmentsNot looked up for this question/);
    assert.match(text, /Another member record shares this name/); assert.match(text, new RegExp(`record ${member} only`));
    assert.match(text, /Link: linked \(Tester\)/);
    assert.ok(!text.includes(twin));
    assert.match(text, new RegExp(`Record: ${generalId}`));
  } finally { await h.dispose(); }
});

test('changing the question refetches with that question and partial buckets say how much is missing', async () => {
  const urls = [];
  const h = await mount(async url => {
    const parsed = new URL(url, 'http://localhost'); urls.push(parsed);
    if (parsed.searchParams.get('question') === 'expertise') {
      return json(fixture({ question: { type: 'expertise', fact_key: null }, sources: { ...fixture().sources,
        general_assertions: bucket('General member assertions', [ledgerRecord(generalId, { fact_key: 'profile.expertise.a', text: 'I run workshops.' })], { status: 'partial', total: 3, truncated: true }) } }));
    }
    return json(fixture());
  });
  try {
    await act(async () => select(h.node, 'Evidence question', 'expertise'));
    assert.equal(urls.length, 2);
    assert.equal(urls[1].searchParams.get('question'), 'expertise');
    assert.match(h.node.textContent, /showing 1 of 3/);
    assert.match(h.node.textContent, /Partial: 2 more not shown/);
    assert.match(h.node.textContent, /I run workshops\./);
  } finally { await h.dispose(); }
});

test('records from another project or member are rejected before anything is rendered', async () => {
  const leaks = [
    fixture({ sources: { ...fixture().sources, general_assertions: bucket('General member assertions', [ledgerRecord(generalId, { project_id: otherProject, scope: 'project', text: 'LEAKED PROJECT FACT' })]) } }),
    fixture({ sources: { ...fixture().sources, general_assertions: bucket('General member assertions', [ledgerRecord(generalId, { member_id: twin, text: 'LEAKED MEMBER FACT' })]) } }),
    fixture({ member_id: twin, identity: { ...fixture().identity, member_id: twin } }),
    fixture({ project_id: otherProject, coverage: { ...fixture().coverage, scopes: [`project:${otherProject}`, 'general'] } }),
    fixture({ sources: { ...fixture().sources, directory_settings: bucket('Global directory settings', [{ ...fixture().sources.directory_settings.records[0], ref: `/api/members/${twin}#preferences.channel`, value: 'LEAKED DIRECTORY' }]) } }),
  ];
  for (const leak of leaks) {
    const h = await mount(async () => json(leak));
    try {
      assert.match(h.node.querySelector('[role="alert"]').textContent, /scope mismatch; nothing was displayed/);
      for (const secret of ['LEAKED', 'I prefer email', 'Tuesdays', 'email']) assert.ok(!h.node.textContent.includes(`: ${secret}`), `rendered ${secret}`);
      assert.equal(h.node.querySelectorAll('li').length, 0);
    } finally { await h.dispose(); }
  }
});

test('an unavailable lookup shows the server error and renders no evidence', async () => {
  const h = await mount(async () => json({ error: 'Project not found' }, 404));
  try {
    assert.match(h.node.querySelector('[role="alert"]').textContent, /Project not found/);
    assert.equal(h.node.querySelectorAll('li').length, 0);
  } finally { await h.dispose(); }
});

// The server modules are loaded from the repo root so the payload comes from the real
// ledger and lookup, not from a hand-written fixture: producer and validator must agree.
const requireRoot = createRequire(new URL('../../../../package.json', import.meta.url));
test('a payload from the real lookup passes the client and renders conflicts, completion claims and named-question topics', async () => {
  const Database = requireRoot('better-sqlite3');
  const { initializeMemberMemory, createMemberMemoryLedger } = requireRoot('./db/member-memory');
  const { createMemberEvidence } = requireRoot('./db/member-evidence');
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, birthday TEXT, notes TEXT, kind TEXT, seat_id TEXT, status TEXT,
      preferences TEXT, expertise TEXT, interests TEXT, claims TEXT, interaction_log TEXT, updated_at TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE project_contacts (project_id TEXT, contact_id TEXT, role TEXT, decision_maker INTEGER DEFAULT 0, PRIMARY KEY(project_id, contact_id))`);
  const realMember = randomUUID(), realProject = randomUUID();
  raw.prepare('INSERT INTO contacts (id, name, kind, seat_id, status, preferences, expertise, interests, claims, interaction_log, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(realMember, 'Real Lookup', 'human', 'human:real-lookup', 'active', JSON.stringify({ availability: 'Weekdays' }), '[]', '[]', '[]', '[]', '2026-09-10T00:00:00.000Z');
  raw.prepare('INSERT INTO projects VALUES (?)').run(realProject);
  raw.prepare('INSERT INTO project_contacts (project_id, contact_id, role) VALUES (?, ?, ?)').run(realProject, realMember, 'Tester');
  initializeMemberMemory(raw);
  const ledger = createMemberMemoryLedger(raw), evidence = createMemberEvidence(raw, ledger);
  const exception = ledger.append(realMember, { project_id: realProject, kind: 'fact', fact_key: 'availability', text: 'Evenings only for this project.', evidence: 'operator_confirmed', source: 'operator' });
  const first = ledger.append(realMember, { kind: 'fact', fact_key: 'profile.preference.slot', text: 'Mornings', evidence: 'self_reported', source: 'consultation' });
  const second = ledger.append(realMember, { kind: 'fact', fact_key: 'profile.preference.slot', text: 'Afternoons', evidence: 'self_reported', source: 'consultation' });
  const claimed = ledger.append(realMember, { kind: 'commitment', owner: 'member', text: 'Send the survey draft.', evidence: 'self_reported', source: 'consultation' });
  ledger.append(realMember, { kind: 'resolution', target_id: claimed.id, outcome: 'completed', text: 'Probably sent it.', evidence: 'inferred', source: 'praxis' });
  const done = ledger.append(realMember, { kind: 'commitment', owner: 'member', text: 'Run the workshop.', evidence: 'self_reported', source: 'consultation' });
  ledger.append(realMember, { kind: 'resolution', target_id: done.id, outcome: 'completed', text: 'Workshop held.', evidence: 'operator_confirmed', source: 'operator' });
  const h = await mount(async url => {
    const params = new URL(url, 'http://localhost').searchParams;
    return json(evidence.lookup(realMember, { scope: 'project', project_id: realProject, question: params.get('question'), ...(params.get('fact_key') && { fact_key: params.get('fact_key') }) }));
  }, { memberId: realMember, projectId: realProject });
  const section = title => [...h.node.querySelectorAll('h5')].find(heading => heading.textContent.startsWith(title)).parentElement.textContent;
  try {
    assert.equal(h.node.querySelector('[role="alert"]'), null);
    assert.match(section('Unresolved conflicts'), /profile\.preference\.slot · General · unresolved/);
    assert.match(section('Unresolved conflicts'), new RegExp(`Records: ${second.id}, ${first.id}`));
    assert.match(section('Completion claims'), /Completion claimed, not demonstrated \(resolution evidence: inferred\)/);
    assert.match(section('Completion claims'), /Completion claimed: Probably sent it\./);
    assert.ok(!section('Demonstrated outcomes').includes('Probably sent it.'));
    assert.match(section('Demonstrated outcomes'), /Demonstrated outcome: member commitment resolved as completed \(resolution evidence: operator_confirmed\)/);
    assert.match(section('Demonstrated outcomes'), /Completed: Workshop held\./);
    assert.ok(!section('Completion claims').includes('Workshop held.'));

    await act(async () => select(h.node, 'Evidence question', 'availability'));
    assert.equal(h.node.querySelector('[role="alert"]'), null);
    assert.match(section('Project-specific assertions'), /Evenings only for this project\./);
    assert.match(section('Project-specific assertions'), new RegExp(`Record: ${exception.id}`));
    assert.match(section('Global directory settings'), /Availability note: Weekdays/);
    assert.match(section('Global directory settings'), /Applies to all projects by default; not a project statement/);
    assert.ok(!h.node.textContent.includes('Mornings'));
  } finally { await h.dispose(); raw.close(); }
});

test('general scope omits the project bucket and the project-only role question', async () => {
  const h = await mount(async () => json(fixture({ scope: 'general', project_id: null, project_link: null,
    sources: { ...fixture().sources, project_assertions: notRequested('Project-specific assertions'), inferred_observations: bucket('Inferred records (unconfirmed)') },
    coverage: { ...fixture().coverage, scopes: ['general'] } })), { projectId: null });
  try {
    assert.ok(!h.node.textContent.includes('Project-specific assertions'));
    assert.ok(![...h.node.querySelectorAll('option')].some(option => option.value === 'role'));
    assert.match(h.node.textContent, /Scope: general/);
  } finally { await h.dispose(); }
});
