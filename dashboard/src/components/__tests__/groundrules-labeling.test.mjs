import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { LabelingWorkbench } from '../groundrules-labeling/workbench.tsx';
import { LabelingEntryPanel } from '../task-view/labeling-entry-panel.tsx';
import { describeQuoteFailure, resolveQuote, OPERATOR_KEY_STORAGE } from '../../lib/groundrules-labeling.ts';

// Synthetic packet (an invented library act), never a roster passage. The
// in-memory server below follows the rules of server/routes/groundrules-labeling.js.
const TASK = 'task-synthetic-labeling-ui';
const KEY = 'synthetic-operator-key-0123456789abcdef';
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const ROW_1 = 'A card holder may borrow up to five items at one time, unless the holder has an overdue item, in which case no further loan shall be made.';
const ROW_2 = 'The library shall notify the holder within ten days after an item becomes overdue.';
const ROW_3 = 'a refusal to renew a card for a holder who has paid every fine within thirty days of notice';
const CONTEXT_3 = 'For purposes of this section, an unreasonable refusal includes';
const ROWS = {
  'lib-loans.limit': { id: 'lib-loans.limit', label: '§1(a)', text: ROW_1, contexts: [], anchorWithin: null, citation: 'Synthetic Library Act §1', provisionId: 'lib-loans' },
  'lib-loans.notice': { id: 'lib-loans.notice', label: '§1(b)', text: ROW_2, contexts: [], anchorWithin: null, citation: 'Synthetic Library Act §1', provisionId: 'lib-loans' },
  'lib-renewal.rule': { id: 'lib-renewal.rule', label: '§2(a)', text: ROW_3, contexts: [{ quote: CONTEXT_3, sourceUnit: '/syn/lib/s2', quotable: true }], anchorWithin: null, citation: 'Synthetic Library Act §2', provisionId: 'lib-renewal' },
};
const STAGE_A = { title: 'Part A: blind labels', provisions: [
  { id: 'lib-loans', citation: 'Synthetic Library Act §1', topic: 'Books', jurisdiction: 'federal', sourceId: 'lib', rows: [ROWS['lib-loans.limit'], ROWS['lib-loans.notice']].map(({ id, label, text, contexts, anchorWithin }) => ({ id, label, text, contexts, anchorWithin })) },
  { id: 'lib-renewal', citation: 'Synthetic Library Act §2', topic: 'Books', jurisdiction: 'federal', sourceId: 'lib', rows: [ROWS['lib-renewal.rule']].map(({ id, label, text, contexts, anchorWithin }) => ({ id, label, text, contexts, anchorWithin })) },
] };
const STAGE_B = { title: 'Part B: control judgments', items: [
  { id: 'ctl-s1', rowId: 'lib-loans.notice', form: 'single', ask: 'accept or reject', proposed: { category: 'condition', quote: 'within ten days after an item becomes overdue', numeric: { value: 10, unit: 'day', operator: '<=' } } },
  { id: 'ctl-p1', rowId: 'lib-loans.limit', form: 'pair', ask: 'equivalent or different', proposed: [{ category: 'exception', quote: 'unless the holder has an overdue item' }, { category: 'condition', quote: 'unless the holder has an overdue item' }] },
] };
const STAGE_C = { title: 'Part C', items: [{ id: 'vpu-s1', rowId: 'lib-other.rule', citation: 'Synthetic Library Act §9', label: 'exception-removed', removedText: 'unless the fine is waived', alsoReworded: [], sourceText: 'A holder shall pay the posted fine, unless the fine is waived.', versions: { original: ['Who: A holder', 'Rule (shall): pay the posted fine', 'Exception: the fine may be waived'], mutant: ['Who: A holder', 'Rule (shall): pay the posted fine'] }, example: { description: 'A holder returns a book late and no waiver is requested.', original: 'required', mutant: 'required' }, ask: 'same outcome yes/no; meaning same/different' }] };
const TOTALS = { A: 3, B: 2, C: 1 };
const DIGESTS = { rosterSha256: 'r'.repeat(64), guidelineSha256: 'g'.repeat(64), controlsSha256: 'c'.repeat(64), vpuSha256: 'v'.repeat(64), thresholdsSha256: 't'.repeat(64) };
const MODALITIES = ['may', 'shall', 'must-not', 'is'];
const CATEGORIES = ['condition', 'exception', 'negation'];

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
async function click(node) { assert.ok(node, 'expected a node to click'); await act(async () => node.click()); await settle(); }
async function type(field, value) {
  assert.ok(field, 'expected a field to type into');
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
window.scrollTo = () => {};

function validateA(row, a) {
  const errors = [];
  if (!a.modality) errors.push({ path: 'modality', message: 'Choose the modality, or mark it UNKNOWN if you cannot settle it.' });
  else if (a.modality === 'UNKNOWN') errors.push({ path: 'modality', message: 'Marked UNKNOWN.', unknown: true });
  const text = a.actor.source === 'row' || a.actor.source === '' ? row.text : row.contexts[a.actor.source].quote;
  const actor = resolveQuote(text, a.actor.quote || '', a.actor.within || null);
  if (!a.actor.quote?.trim()) errors.push({ path: 'actor.quote', message: 'Quote the exact words from the passage.' });
  else if (!actor.ok) errors.push({ path: 'actor.quote', message: describeQuoteFailure(actor), reason: actor.reason, count: actor.count });
  const props = a.propositions || [];
  props.forEach((p, i) => {
    if (!CATEGORIES.includes(p.category)) errors.push({ path: `propositions[${i}].category`, message: 'Choose condition, exception or negation.' });
    const res = resolveQuote(row.text, p.quote || '');
    if (!res.ok) errors.push({ path: `propositions[${i}].quote`, message: describeQuoteFailure(res), reason: res.reason, count: res.count });
  });
  if (!a.propositionsDeclared) errors.push({ path: 'propositionsDeclared', message: 'Say whether this passage carries any conditions, exceptions or negations, or that it carries none.' });
  else if (a.propositionsDeclared === 'some' && !props.length) errors.push({ path: 'propositions', message: 'Add at least one proposition, or declare that the passage carries none.' });
  const answer = { modality: a.modality || '', actor: { quote: a.actor.quote || '', source: a.actor.source ?? 'row', within: a.actor.within || '' }, propositionsDeclared: a.propositionsDeclared || '', propositions: props, notes: a.notes || '' };
  if (actor.ok) answer.actorResolved = { source: 'row', index: null, start: actor.start, end: actor.end, slice: actor.slice };
  return { answer, errors };
}
function validateB(item, a) {
  const allowed = item.form === 'pair' ? ['equivalent', 'different'] : ['accept', 'reject'];
  const errors = [];
  if (!a.verdict) errors.push({ path: 'verdict', message: `Answer ${allowed.join(' or ')}.` });
  else if (a.verdict === 'UNKNOWN') errors.push({ path: 'verdict', message: 'Marked UNKNOWN', unknown: true });
  else if (!allowed.includes(a.verdict)) return { malformed: true };
  return { answer: { verdict: a.verdict || '', note: a.note || '' }, errors };
}
function validateC(a) {
  const errors = [];
  if (!a.exampleOutcomeSame) errors.push({ path: 'exampleOutcomeSame', message: 'Answer yes or no.' });
  if (!a.meaning) errors.push({ path: 'meaning', message: 'Answer same or different.' });
  if (a.meaning === 'different' && !(a.divergingCase || '').trim()) errors.push({ path: 'divergingCase', message: 'You answered "different": describe a case where the two versions part.' });
  return { answer: { exampleOutcomeSame: a.exampleOutcomeSame || '', meaning: a.meaning || '', divergingCase: a.divergingCase || '', note: a.note || '' }, errors };
}

/** In-memory labeling API with the gating, hashing and concurrency rules of the real router. */
function server(options = {}) {
  const state = {
    whoami: { operator_session: options.operatorSession ?? false, identity: options.operatorSession ? 'user' : null, reason: 'x', operator_credential_configured: true, user_id: 'local_user' },
    session: null, answers: { A: {}, B: {}, C: {} }, commits: {}, revealed: { B: null, C: null }, revisions: [], exports: [],
    diskSha: SHA, revision: 1, staleNext: false, clock: 0, delayMs: 0,
  };
  const calls = [];
  const now = () => `2026-10-09T10:${String(state.clock++).padStart(2, '0')}:00.000Z`;
  const stageAccess = s => (s === 'A' ? { unlocked: true, reason: null } : state.commits[s === 'B' ? 'A' : 'B'] ? { unlocked: true, reason: null } : { unlocked: false, reason: `stage_${s === 'B' ? 'A' : 'B'}_not_committed` });
  const progress = () => Object.fromEntries(['A', 'B', 'C'].map(s => {
    const list = Object.values(state.answers[s]);
    const count = st => list.filter(a => a.state === st).length;
    return [s, { total: TOTALS[s], complete: count('complete'), draft: count('draft'), unsure: count('unsure'), untouched: TOTALS[s] - list.length, ...stageAccess(s), committed_at: state.commits[s]?.committed_at ?? null, revealed_at: state.revealed[s] ?? null }];
  }));
  const exposureBeforeA = () => Object.fromEntries(['B', 'C'].map(s => [s, state.revealed[s] && (!state.commits.A || state.revealed[s] <= state.commits.A.committed_at) ? state.revealed[s] : null]));
  const summary = () => state.session && { ...state.session, revision: state.revision, blind: !exposureBeforeA().B && !exposureBeforeA().C, exposure_before_a: exposureBeforeA(), stages: { A: { committed_at: state.commits.A?.committed_at ?? null, revealed_at: state.session.created_at }, B: { committed_at: state.commits.B?.committed_at ?? null, revealed_at: state.revealed.B }, C: { committed_at: state.commits.C?.committed_at ?? null, revealed_at: state.revealed.C } }, progress: progress(), packet_conflict: state.session.packet_sha256 !== state.diskSha ? { session_packet_sha256: state.session.packet_sha256, current_packet_sha256: state.diskSha, message: 'The packet on disk changed after this session started.' } : null, route: `/task/${TASK}/labeling` };
  const packet = () => ({ sha256: state.diskSha, path: '/synthetic/packet.json', schemaVersion: '1.0.0', status: 'NEEDS_EVIDENCE', digests: DIGESTS, counts: { provisions: 2, rows: 3, controls: 2, pairs: 1 }, sources: [], guidelineSource: 'docs/gold-set-design.md' });
  const items = s => (s === 'A' ? Object.values(ROWS) : s === 'B' ? STAGE_B.items : STAGE_C.items);
  const handler = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = init.headers ?? {};
    calls.push({ method, path: url.pathname, body, headers, keepalive: init.keepalive === true });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    const p = url.pathname.replace('/api/groundrules-labeling', '');
    const write = () => (state.whoami.operator_session || headers.Authorization === `Bearer ${KEY}` ? null : response({ error: 'Saving needs Robert’s verified operator session or operator credential; the supplied credential is neither', code: 'operator_required' }, 403));
    const packetMatch = () => {
      if (typeof body?.packet_sha256 !== 'string') return response({ error: 'packet_sha256 is required', code: 'packet_sha256_required' }, 400);
      if (body.packet_sha256 !== state.session.packet_sha256) return response({ error: 'mismatch', code: 'packet_mismatch' }, 409);
      if (state.session.packet_sha256 !== state.diskSha) return response({ error: 'The packet on disk changed after this session started. Your answers are kept; rebind deliberately to continue.', code: 'packet_changed' }, 409);
      return null;
    };
    if (method === 'GET' && p === '/whoami') return response(state.whoami);
    if (method === 'GET' && p.startsWith('/tasks/')) {
      const id = decodeURIComponent(p.split('/')[2]);
      if (id !== TASK) return response({ linked: false, task_id: id });
      return response({ linked: true, task_id: id, route: `/task/${TASK}/labeling`, project_id: 'proj', related_tasks: [{ id: 'f70448bc-0000-0000-0000-000000000000', role: 'packet preparation' }], need_id: '163e050c', packet: packet(), packet_error: null, session: summary() });
    }
    if (method === 'POST' && p === `/tasks/${TASK}/session`) {
      const denied = write(); if (denied) return denied;
      if (state.session && state.session.packet_sha256 !== state.diskSha) return response({ error: 'A session exists for an earlier packet', code: 'packet_changed' }, 409);
      let created = false;
      if (!state.session) { state.session = { id: 'sess-1', task_id: TASK, project_id: 'proj', annotator: 'robert', packet_sha256: state.diskSha, packet_path: '/synthetic/packet.json', digests: DIGESTS, carried_from: null, superseded_by: null, created_by: 'local_user', created_authority: 'operator_credential', created_at: now(), updated_at: now() }; created = true; }
      return response({ session: summary(), created }, created ? 201 : 200);
    }
    const m = p.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!m || !state.session || m[1] !== state.session.id) return response({ error: 'Labeling session not found', code: 'session_not_found' }, 404);
    const rest = m[2] ?? '';
    if (method === 'GET' && rest === '') {
      const answers = {};
      for (const s of ['A', 'B', 'C']) if (stageAccess(s).unlocked) answers[s] = Object.values(state.answers[s]).sort((a, b) => a.item_id.localeCompare(b.item_id));
      return response({ session: summary(), packet: { ...packet(), protocol: [], filling: ['copy', 'python3 -m src.ledger goldset …'], guideline: { source: 'x', sha256: DIGESTS.guidelineSha256, text: '' }, alignmentMinJaccard: 0.5 }, stageA: STAGE_A, answers, commits: Object.fromEntries(Object.entries(state.commits).map(([s, c]) => [s, { id: c.id, snapshot_sha256: c.snapshot_sha256, item_count: c.item_count, committed_at: c.committed_at, committed_authority: 'operator_credential', packet_sha256: SHA }])), revisions: state.revisions, exports: state.exports, export_targets: { A: 'labels/robert.json', B: 'judgments/robert.json', C: 'judgments/robert-vpu.json', revisions: 'post-exposure/robert-revisions.json' }, related_tasks: [{ id: 'f70448bc-0000-0000-0000-000000000000', role: 'packet preparation' }], need_id: '163e050c' });
    }
    if (method === 'GET' && rest.startsWith('stages/')) {
      const s = rest.split('/')[1];
      if (!stageAccess(s).unlocked) return response({ error: `Stage ${s} is locked until the previous stage is committed`, code: 'stage_locked', reason: stageAccess(s).reason }, 403);
      // Reading never reveals: an unrevealed later stage is refused until the operator's own POST reveal.
      if (s !== 'A' && !state.revealed[s]) return response({ error: `Stage ${s} has not been opened yet`, code: 'stage_not_revealed' }, 403);
      const payload = { stage: s, session: summary(), answers: Object.values(state.answers[s]), revealed_at: s === 'A' ? state.session.created_at : state.revealed[s], content: s === 'A' ? STAGE_A : s === 'B' ? STAGE_B : STAGE_C };
      if (s === 'B') payload.committed_rows = Object.fromEntries(STAGE_B.items.map(item => [item.rowId, { row: ROWS[item.rowId], answer: state.commits.A?.snapshot[item.rowId]?.answer ?? null }]));
      return response(payload);
    }
    if (method === 'POST' && rest.startsWith('reveal/')) {
      const s = rest.split('/')[1];
      const denied = write(); if (denied) return denied;
      const mismatch = packetMatch(); if (mismatch) return mismatch;
      if (!stageAccess(s).unlocked) return response({ error: 'locked', code: 'stage_locked' }, 403);
      const first = !state.revealed[s];
      if (first) { state.revealed[s] = now(); state.revision += 1; }
      return response({ stage: s, first, revealed_at: state.revealed[s], session: summary() }, first ? 201 : 200);
    }
    if (method === 'PUT' && rest.startsWith('answers/')) {
      const [, s, rawItem] = rest.split('/');
      const itemId = decodeURIComponent(rawItem);
      const denied = write(); if (denied) return denied;
      const mismatch = packetMatch(); if (mismatch) return mismatch;
      const item = items(s).find(i => i.id === itemId);
      if (!item) return response({ error: 'unknown item', code: 'unknown_item' }, 404);
      if (state.commits[s]) return response({ error: `Stage ${s} is committed; its answers are frozen.`, code: 'stage_committed' }, 409);
      if (!stageAccess(s).unlocked) return response({ error: 'locked', code: 'stage_locked' }, 403);
      const v = s === 'A' ? validateA(item, body.answer) : s === 'B' ? validateB(item, body.answer) : validateC(body.answer);
      if (v.malformed) return response({ error: 'verdict must be one of …', code: 'malformed_answer', field: 'verdict' }, 400);
      const existing = state.answers[s][itemId];
      if (state.staleNext && existing) {
        // Another device saved in between: the stored record moves on, and this write is refused.
        state.staleNext = false;
        state.answers[s][itemId] = { ...existing, revision: existing.revision + 1, answer: { ...existing.answer, notes: 'from the phone' }, updated_at: now() };
        return response({ error: 'This passage was saved from another device or tab after you loaded it', code: 'stale_write', current: state.answers[s][itemId] }, 409);
      }
      // A null base revision is a first save; on an existing record it is as stale as a wrong one.
      if (existing && (body.base_revision === null || body.base_revision !== existing.revision)) return response({ error: 'stale', code: 'stale_write', current: existing }, 409);
      const st = body.state === 'unsure' ? 'unsure' : v.errors.length ? 'draft' : 'complete';
      const saved = { session_id: state.session.id, stage: s, item_id: itemId, state: st, answer: v.answer, errors: v.errors, revision: (existing?.revision ?? 0) + 1, updated_by: 'local_user', updated_authority: 'operator_credential', created_at: existing?.created_at ?? now(), updated_at: now() };
      state.answers[s][itemId] = saved;
      state.revision += 1;
      return response({ answer: saved, session: summary(), validation: { complete: v.errors.length === 0, errors: v.errors }, saved_at: saved.updated_at });
    }
    if (method === 'POST' && rest.startsWith('commit/')) {
      const s = rest.split('/')[1];
      const denied = write(); if (denied) return denied;
      const mismatch = packetMatch(); if (mismatch) return mismatch;
      if (state.commits[s]) return response({ error: 'already', code: 'already_committed' }, 409);
      const missing = [], unsure = [], invalid = [], snapshot = {};
      for (const item of items(s)) {
        const a = state.answers[s][item.id];
        if (!a) { missing.push(item.id); continue; }
        if (a.state === 'unsure') { unsure.push(item.id); continue; }
        if (a.errors.length) { invalid.push({ item_id: item.id, errors: a.errors }); continue; }
        snapshot[item.id] = { state: a.state, answer: a.answer, revision: a.revision };
      }
      if (missing.length || unsure.length || invalid.length) return response({ error: `Stage ${s} cannot be committed yet: ${missing.length} untouched, ${unsure.length} marked unsure, ${invalid.length} incomplete or invalid. Drafts are kept.`, code: 'incomplete', missing, unsure, invalid }, 422);
      if (body.expected_revision !== null && body.expected_revision !== state.revision) return response({ error: 'stale session', code: 'stale_session', current_revision: state.revision }, 409);
      state.commits[s] = { id: `commit-${s}`, snapshot, snapshot_sha256: 'f'.repeat(64), item_count: Object.keys(snapshot).length, committed_at: now() };
      state.revision += 1;
      return response({ session: summary(), commit: { ...state.commits[s], stage: s, committed_authority: 'operator_credential' } }, 201);
    }
    if (method === 'POST' && rest.startsWith('revisions/')) {
      const denied = write(); if (denied) return denied;
      const itemId = decodeURIComponent(rest.split('/')[1]);
      if (!state.commits.A) return response({ error: 'not committed', code: 'stage_not_committed' }, 409);
      const v = validateA(ROWS[itemId], body.answer);
      const rev = { id: `rev-${state.revisions.length + 1}`, item_id: itemId, answer: v.answer, errors: v.errors, note: body.note ?? '', exposure: { committed_at: state.commits.A.committed_at, revealed: { B: state.revealed.B, C: state.revealed.C }, after_exposure_to: ['B', 'C'].filter(x => state.revealed[x]), blind: false }, created_at: now(), created_authority: 'operator_credential' };
      state.revisions.push(rev);
      return response({ revision: rev, session: summary(), validation: { complete: !v.errors.length, errors: v.errors } }, 201);
    }
    if (method === 'POST' && rest.startsWith('exports/')) {
      const denied = write(); if (denied) return denied;
      const kind = rest.split('/')[1];
      if (!state.commits[kind === 'revisions' ? 'A' : kind]) return response({ error: 'not committed', code: 'stage_not_committed' }, 412);
      const record = { id: `exp-${state.exports.length + 1}`, kind, path: `/synthetic/gold/${kind}.json`, sha256: 'e'.repeat(64), exported_at: now(), exported_authority: 'operator_credential' };
      state.exports.push(record);
      return response({ export: record, written: true, identical: false, replaced_sha256: null, target: 'labels/robert.json', scorer_command: 'python3 -m src.ledger goldset …' }, 201);
    }
    if (method === 'POST' && rest === 'rebind') {
      const denied = write(); if (denied) return denied;
      if (body.confirm !== true) return response({ error: 'confirm', code: 'confirm_required' }, 400);
      const old = state.session;
      const carried = Object.values(state.answers.A).length;
      state.session = { ...old, id: 'sess-2', packet_sha256: state.diskSha, carried_from: old.id, created_at: now() };
      state.answers = { A: Object.fromEntries(Object.entries(state.answers.A).map(([id, a]) => [id, { ...a, state: a.state === 'unsure' ? 'unsure' : 'draft', revision: 1, errors: [{ path: 'packet', message: 'Carried over from a session bound to an earlier packet; review this answer against the current passage before saving.' }] }])), B: {}, C: {} };
      state.commits = {};
      return response({ session: summary(), superseded: { ...old, superseded_by: 'sess-2' }, carried }, 201);
    }
    return response({ error: `unexpected ${method} ${p}` }, 404);
  };
  return { state, calls, handler };
}

function mount(srv, Component, props) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => srv.handler(new URL(String(url), 'http://localhost'), init);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Component, props)));
  let unmounted = false;
  const unmount = () => { if (!unmounted) { unmounted = true; act(() => root.unmount()); } };
  return { container, unmount, cleanup() { unmount(); container.remove(); globalThis.fetch = original; } };
}
const mountWorkbench = srv => mount(srv, LabelingWorkbench, { taskId: TASK, timings: { autosaveMs: 10 } });
const q = (c, sel) => c.querySelector(sel);
const radio = (c, name, value) => c.querySelector(`input[name="${name}"][value="${value}"]`);
const writes = srv => srv.calls.filter(x => x.method !== 'GET');

async function fillRow(c, srv, i, { modality, actor, declared = 'none' }) {
  await click(radio(c, `a-${i}-modality`, modality));
  await type(q(c, `#a-${i}-actor-quote`), actor);
  await click(radio(c, `a-${i}-declared`, declared));
  await settle(40);
}

test.beforeEach(() => { window.sessionStorage.removeItem(OPERATOR_KEY_STORAGE); window.history.replaceState(null, '', '/'); });

test('entry card: a linked task shows one Start action ahead of the inventory; an unlinked task shows nothing', async () => {
  const srv = server();
  const t = mount(srv, LabelingEntryPanel, { taskId: TASK });
  try {
    await settle();
    const entry = q(t.container, '[data-labeling-entry]');
    assert.ok(entry);
    assert.match(entry.textContent, /Your input goes here/);
    assert.match(entry.textContent, /3 passages/);
    const action = q(entry, '[data-labeling-action]');
    assert.equal(action.textContent.trim(), 'Start labeling');
    assert.equal(action.getAttribute('href'), `/task/${TASK}/labeling`);
    assert.equal(q(entry, '[data-labeling-progress]'), null, 'no progress before a session');
  } finally { t.cleanup(); }
  const other = mount(srv, LabelingEntryPanel, { taskId: 'task-unrelated' });
  try { await settle(); assert.equal(q(other.container, '[data-labeling-entry]'), null); } finally { other.cleanup(); }
});

test('start screen: counts and digests, no Part B or C content, Start needs the operator credential and sends it only on the write', async () => {
  const srv = server();
  const t = mountWorkbench(srv);
  try {
    await settle();
    const c = t.container;
    const card = q(c, '[data-start-card]');
    assert.ok(card);
    assert.match(card.textContent, /3 passages in 2 provisions/);
    assert.match(card.textContent, /2 control judgments/);
    assert.match(card.textContent, /1 original\/mutant pairs/);
    assert.equal(c.textContent.includes('ctl-s1'), false);
    assert.equal(c.textContent.includes('unless the fine is waived'), false);
    const start = q(c, '[data-start-labeling]');
    assert.equal(start.disabled, true, 'no credential yet');
    assert.equal(q(c, '[data-credential-panel]').dataset.credentialPanel, 'needed');
    await type(q(c, '[data-operator-key]'), KEY);
    await click(q(c, '[data-use-key]'));
    assert.equal(q(c, '[data-credential-panel]').dataset.credentialPanel, 'set');
    assert.equal(window.sessionStorage.getItem(OPERATOR_KEY_STORAGE), KEY, 'tab-scoped only');
    assert.equal(start.disabled, false);
    await click(start);
    await settle(20);
    const post = writes(srv)[0];
    assert.equal(post.path, `/api/groundrules-labeling/tasks/${TASK}/session`);
    assert.equal(post.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(srv.calls.filter(x => x.method === 'GET').every(x => x.headers.Authorization !== `Bearer ${KEY}`), 'reads never carry the credential');
    assert.match(q(c, '[data-notice]').textContent, /session started/i);
    assert.equal(q(c, '[data-position]').textContent, 'Passage 1 of 3');
    assert.equal(q(c, '[data-stage-tab="B"]').dataset.stageUnlocked, 'false');
    assert.equal(q(c, '[data-stage-tab="B"]').disabled, true);
    assert.equal(q(c, '[data-stage-tab="C"]').disabled, true);
    assert.ok(q(c, '[data-stage-a-form="lib-loans.limit"]'));
    assert.match(q(c, '[data-passage="row"]').textContent, /A card holder may borrow/);
    assert.equal(c.textContent.includes('ctl-s1'), false, 'no control fixture before commit');
    assert.ok(q(c, '[data-definitions]'));
  } finally { t.cleanup(); }
});

test('autosave: a draft saves with the packet hash and revision, errors come back per field, the pick-words fallback fills the quote, and a reload resumes from the server', async () => {
  const srv = server({ operatorSession: true });
  let t = mountWorkbench(srv);
  try {
    await settle();
    let c = t.container;
    await click(q(c, '[data-start-labeling]'));
    await settle(20);
    await click(radio(c, 'a-0-modality', 'may'));
    await settle(40);
    let put = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.equal(put.path, `/api/groundrules-labeling/sessions/sess-1/answers/A/lib-loans.limit`);
    assert.equal(put.body.packet_sha256, SHA);
    assert.equal(put.body.base_revision, null);
    assert.equal(put.body.state, 'draft');
    assert.equal(put.body.answer.modality, 'may');
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'saved');
    assert.match(q(c, '[data-save-status]').textContent, /Saved/);
    assert.equal(q(c, '[data-index-item="lib-loans.limit"]').dataset.indexState, 'draft');
    const errors = [...c.querySelectorAll('[data-field-error]')].map(e => e.textContent);
    assert.ok(errors.some(e => /Quote the exact words/.test(e)));
    assert.ok(errors.some(e => /carries any conditions/.test(e)));

    // Keyboard-reachable quote: arm the actor field, pick first and last word.
    await click(q(c, '[data-pick-for="a-0-actor-quote"]'));
    assert.match(q(c, '[data-quote-target]').textContent, /Choosing words for: Actor/);
    await click(q(c, '[data-passage="row"] [data-pick-words]'));
    await click(q(c, '[data-passage="row"] button[data-word="0"]'));
    await click(q(c, '[data-passage="row"] button[data-word="2"]'));
    assert.equal(q(c, '#a-0-actor-quote').value, 'A card holder');
    await settle(40);
    put = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.equal(put.body.base_revision, 1, 'optimistic revision from the previous ack');
    assert.equal(put.body.answer.actor.quote, 'A card holder');
    assert.ok([...c.querySelectorAll('[data-passage="row"] span[data-word]')].slice(0, 3).every(w => /bg-cyan/.test(w.className)), 'actor highlighted');

    // A quote that is not in the passage is a field error, not a crash.
    await type(q(c, '#a-0-actor-quote'), 'The card holder');
    await settle(40);
    assert.ok([...c.querySelectorAll('[data-field-error]')].some(e => /do not occur/.test(e.textContent)));
    await type(q(c, '#a-0-actor-quote'), 'A card holder');
    await click(radio(c, 'a-0-declared', 'none'));
    await settle(40);
    assert.equal(q(c, '[data-index-item="lib-loans.limit"]').dataset.indexState, 'complete');
    assert.match(q(c, '[data-stage-progress="A"]').textContent, /1 of 3 complete/);

    // Unsure keeps the draft but never counts as complete.
    await click(q(c, '[data-next]'));
    assert.equal(q(c, '[data-position]').textContent, 'Passage 2 of 3');
    await click(q(c, '[data-unsure] input'));
    await settle(40);
    put = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.equal(put.path, `/api/groundrules-labeling/sessions/sess-1/answers/A/lib-loans.notice`);
    assert.equal(put.body.state, 'unsure');
    assert.equal(q(c, '[data-index-item="lib-loans.notice"]').dataset.indexState, 'unsure');
  } finally { t.cleanup(); }

  // Reload: everything comes back from the server, landing on the first open passage.
  window.history.replaceState(null, '', '/');
  t = mountWorkbench(srv);
  try {
    await settle(20);
    const c = t.container;
    assert.equal(q(c, '[data-start-card]'), null, 'session resumes');
    assert.equal(q(c, '[data-position]').textContent, 'Passage 2 of 3');
    assert.equal(q(c, '[data-unsure] input').checked, true);
    assert.equal(q(c, '[data-index-item="lib-loans.limit"]').dataset.indexState, 'complete');
    await click(q(c, '[data-prev]'));
    assert.equal(q(c, '#a-0-actor-quote').value, 'A card holder');
    assert.equal(radio(c, 'a-0-modality', 'may').checked, true);
    assert.equal(radio(c, 'a-0-declared', 'none').checked, true);
  } finally { t.cleanup(); }
});

test('commit: the review refuses while anything is open, a commit freezes Stage A, Part B opens only through its reveal gate, and a post-exposure change is recorded beside the baseline', async () => {
  const srv = server({ operatorSession: true });
  const t = mountWorkbench(srv);
  try {
    await settle();
    const c = t.container;
    await click(q(c, '[data-start-labeling]'));
    await settle(20);
    await fillRow(c, srv, 0, { modality: 'may', actor: 'A card holder' });
    await click(q(c, '[data-next]'));
    await fillRow(c, srv, 1, { modality: 'shall', actor: 'The library' });
    await click(q(c, '[data-unsure] input'));
    await settle(40);
    await click(q(c, '[data-open-review]'));
    const review = q(c, '[data-commit-review="A"]');
    assert.ok(review);
    assert.match(review.textContent, /2 of 3 items still need work/);
    assert.equal(q(review, '[data-review-item="lib-loans.notice"]').dataset.reviewState, 'unsure');
    assert.equal(q(review, '[data-review-item="lib-renewal.rule"]').dataset.reviewState, 'untouched');
    assert.equal(q(review, '[data-commit]').disabled, true);
    assert.equal(srv.calls.some(x => x.path.includes('/commit/')), false, 'nothing posted');

    await click(q(review, '[data-review-item="lib-loans.notice"] button'));
    await click(q(c, '[data-unsure] input'));
    await settle(40);
    await click(q(c, '[data-next]'));
    assert.equal(q(c, '[data-position]').textContent, 'Passage 3 of 3');
    await click(radio(c, 'a-2-modality', 'is'));
    await type(q(c, '#a-2-actor-quote'), 'a refusal to renew');
    await click(radio(c, 'a-2-declared', 'some'));
    await click(q(c, '[data-add-proposition]'));
    const select = q(c, '#a-2-prop-0-category');
    await act(async () => { select.value = 'condition'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await type(q(c, '#a-2-prop-0-quote'), 'who has paid every fine');
    await settle(40);
    assert.equal(q(c, '[data-index-item="lib-renewal.rule"]').dataset.indexState, 'complete');
    await click(q(c, '[data-open-review]'));
    assert.match(q(c, '[data-commit-review="A"]').textContent, /All 3 items are complete/);
    await click(q(c, '[data-commit]'));
    await settle(30);
    const commit = srv.calls.find(x => x.path.endsWith('/commit/A'));
    assert.equal(commit.body.packet_sha256, SHA);
    assert.equal(typeof commit.body.expected_revision, 'number');
    assert.match(q(c, '[data-notice]').textContent, /Stage A committed/);
    assert.match(q(c, '[data-stage-progress="A"]').textContent, /committed/);
    assert.equal(q(c, '[data-stage-tab="B"]').dataset.stageUnlocked, 'true');
    assert.equal(q(c, '[data-stage-tab="C"]').dataset.stageUnlocked, 'false');
    assert.ok(q(c, '[data-frozen]'));
    assert.equal(q(c, '#a-0-actor-quote')?.disabled ?? q(c, 'textarea[id$="actor-quote"]').disabled, true, 'frozen form');
    assert.equal(q(c, '[data-open-review]'), null);
    assert.equal(srv.state.revealed.B, null, 'nothing revealed by the commit itself');
    assert.equal(c.textContent.includes('within ten days after an item becomes overdue'), false, 'no proposal before the gate');

    await click(q(c, '[data-stage-tab="B"]'));
    assert.ok(q(c, '[data-reveal-gate="B"]'));
    assert.equal(srv.state.revealed.B, null, 'the gate itself reveals nothing');
    await click(q(c, '[data-open-stage="B"]'));
    await settle(20);
    assert.ok(srv.state.revealed.B, 'opening the gate is the recorded exposure');
    const revealCall = srv.calls.findIndex(x => x.method === 'POST' && x.path.endsWith('/reveal/B'));
    const readCall = srv.calls.findIndex(x => x.method === 'GET' && x.path.endsWith('/stages/B'));
    assert.ok(revealCall >= 0 && readCall > revealCall, 'the reveal is a deliberate POST made before the one Part B read');
    assert.equal(srv.calls[revealCall].body.packet_sha256, SHA, 'the reveal is bound to the packet the tab holds');
    assert.equal(q(c, '[data-position]').textContent, 'Fixture 1 of 2');
    assert.ok(q(c, '[data-stage-b-form="ctl-s1"]'));
    assert.match(q(c, '[data-committed-reading]').textContent, /shall/);
    assert.match(q(c, '[data-proposal]').textContent, /within ten days after an item becomes overdue/);
    assert.equal(c.textContent.includes('expected'), false, 'no key shown');
    await click(radio(c, 'b-0-verdict', 'reject'));
    await settle(40);
    const putB = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.equal(putB.path, `/api/groundrules-labeling/sessions/sess-1/answers/B/ctl-s1`);
    assert.equal(putB.body.answer.verdict, 'reject');

    // Back in Stage A, the baseline is frozen; a change of mind is a separate revision.
    await click(q(c, '[data-stage-tab="A"]'));
    assert.ok(q(c, '[data-revisions]'));
    await click(q(c, '[data-revise]'));
    await click(radio(c, 'rev-0-modality', 'shall'));
    await click(q(c, '[data-record-revision]'));
    await settle(30);
    const rev = srv.calls.find(x => x.path.includes('/revisions/'));
    assert.equal(rev.path, `/api/groundrules-labeling/sessions/sess-1/revisions/lib-loans.limit`);
    assert.equal(rev.body.answer.modality, 'shall');
    assert.equal(srv.state.answers.A['lib-loans.limit'].answer.modality, 'may', 'baseline untouched');
    assert.match(q(c, '[data-revision]').textContent, /after exposure to B/);
    assert.match(q(c, '[data-revision]').textContent, /not blind/);
    assert.ok(q(c, '[data-export-panel]'));
  } finally { t.cleanup(); }
});

test('conflicts: a save from another device is surfaced and never overwritten silently; a changed packet blocks saves until a deliberate rebind', async () => {
  const srv = server({ operatorSession: true });
  const t = mountWorkbench(srv);
  try {
    await settle();
    const c = t.container;
    await click(q(c, '[data-start-labeling]'));
    await settle(20);
    await click(radio(c, 'a-0-modality', 'may'));
    await settle(40);
    srv.state.staleNext = true;
    await type(q(c, '#a-0-actor-quote'), 'A card holder');
    await settle(40);
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'stale');
    assert.ok(q(c, '[data-stale-write]'));
    assert.equal(srv.state.answers.A['lib-loans.limit'].answer.actor.quote, '', 'server copy untouched');
    await click(q(c, '[data-stale-mine]'));
    await settle(40);
    const last = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.equal(last.body.base_revision, 2, 'deliberate overwrite names the revision it saw');
    assert.equal(srv.state.answers.A['lib-loans.limit'].answer.actor.quote, 'A card holder');
    assert.equal(srv.state.answers.A['lib-loans.limit'].revision, 3);
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'saved');

    srv.state.diskSha = SHA2;
    await type(q(c, '#a-0-actor-quote'), 'A card');
    await settle(40);
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'error');
    await settle(20);
    assert.ok(q(c, '[data-packet-conflict]'), 'the conflict is visible');
    assert.equal(q(c, '[data-rebind]').disabled, true, 'rebinding needs the explicit confirmation');
    await click(q(c, '[data-packet-conflict] input[type="checkbox"]'));
    await click(q(c, '[data-rebind]'));
    await settle(30);
    const rebind = srv.calls.find(x => x.path.endsWith('/rebind'));
    assert.deepEqual(rebind.body, { confirm: true, from_packet_sha256: SHA, to_packet_sha256: SHA2 });
    assert.match(q(c, '[data-notice]').textContent, /1 answers carried over as drafts/);
    assert.equal(q(c, '[data-packet-conflict]'), null);
    assert.equal(q(c, '[data-index-item="lib-loans.limit"]').dataset.indexState, 'draft');
  } finally { t.cleanup(); }
});

test('a dirty draft keeps the revision it was built on across Reload: after a remote edit its autosave is refused as stale and the conflict is shown, never a silent overwrite', async () => {
  const srv = server({ operatorSession: true });
  const t = mount(srv, LabelingWorkbench, { taskId: TASK, timings: { autosaveMs: 200 } });
  try {
    await settle();
    const c = t.container;
    await click(q(c, '[data-start-labeling]'));
    await type(q(c, '#a-0-actor-quote'), 'A card holder');
    await settle(250);
    const original = srv.state.answers.A['lib-loans.limit'];
    assert.equal(original.revision, 1);
    // Typed against revision 1; before this tab's autosave fires, another
    // device saves revision 2 with a note, and the operator clicks Reload.
    await type(q(c, '#a-0-actor-quote'), 'A card');
    srv.state.answers.A['lib-loans.limit'] = { ...original, revision: 2, answer: { ...original.answer, notes: 'NEW HUMAN INPUT FROM PHONE' }, updated_at: new Date().toISOString() };
    srv.state.revision += 1;
    await click(q(c, '[aria-label="Reload from the server"]'));
    await settle(20);
    assert.equal(q(c, '#a-0-actor-quote').value, 'A card', 'the typed text survives the reload');
    assert.ok(q(c, '[data-stale-write]'), 'the reload itself surfaces the conflict');
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'stale');
    await settle(250);
    const autosave = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.equal(autosave.body.base_revision, 1, 'the autosave names the revision the draft was built on, not the one the reload learnt');
    assert.equal(srv.state.answers.A['lib-loans.limit'].revision, 2, 'nothing was written over the remote edit');
    assert.equal(srv.state.answers.A['lib-loans.limit'].answer.notes, 'NEW HUMAN INPUT FROM PHONE');
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'stale');
    assert.ok(q(c, '[data-stale-write]'));
    // Only an explicit resolution moves the draft on: keeping mine names
    // the remote revision deliberately and lands as the next one.
    await click(q(c, '[data-stale-mine]'));
    await settle(40);
    const overwrite = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.equal(overwrite.body.base_revision, 2);
    assert.equal(srv.state.answers.A['lib-loans.limit'].revision, 3);
    assert.equal(srv.state.answers.A['lib-loans.limit'].answer.actor.quote, 'A card');
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'saved');
    // The next edit starts from the acknowledged revision again.
    await type(q(c, '#a-0-actor-quote'), 'A card holder');
    await settle(250);
    assert.equal(writes(srv).filter(x => x.method === 'PUT').at(-1).body.base_revision, 3);
    assert.equal(srv.state.answers.A['lib-loans.limit'].revision, 4);
  } finally { t.cleanup(); }
});

test('two edits whose saves overlap are sent one after another, the second naming the revision the first acknowledged', async () => {
  const srv = server({ operatorSession: true });
  const t = mountWorkbench(srv);
  try {
    await settle();
    const c = t.container;
    await click(q(c, '[data-start-labeling]'));
    await settle(20);
    srv.state.delayMs = 60; // the server is slow to acknowledge
    await type(q(c, '#a-0-actor-quote'), 'A card');
    await settle(15); // the first autosave is in the air now
    await type(q(c, '#a-0-actor-quote'), 'A card holder');
    await settle(15); // the second autosave fires while the first has no acknowledgment yet
    await settle(200);
    const puts = writes(srv).filter(x => x.method === 'PUT');
    assert.equal(puts.length, 2, 'two saves, not one coalesced and not one dropped');
    assert.deepEqual(puts.map(p => p.body.base_revision), [null, 1], 'the second save names the revision the first acknowledgment returned');
    assert.equal(srv.state.answers.A['lib-loans.limit'].revision, 2);
    assert.equal(srv.state.answers.A['lib-loans.limit'].answer.actor.quote, 'A card holder');
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'saved');
  } finally { t.cleanup(); }
});

test('leaving the page sends the pending autosave at once with keepalive instead of losing it', async () => {
  const srv = server({ operatorSession: true });
  // A long autosave delay, so "not fired yet" below cannot race a slow tick.
  const t = mount(srv, LabelingWorkbench, { taskId: TASK, timings: { autosaveMs: 200 } });
  try {
    await settle();
    const c = t.container;
    await click(q(c, '[data-start-labeling]'));
    await settle(20);
    await type(q(c, '#a-0-actor-quote'), 'A card holder');
    assert.equal(writes(srv).filter(x => x.method === 'PUT').length, 0, 'the autosave has not fired yet');
    t.unmount(); // the page goes away while the autosave timer is still pending
    await settle(20);
    const put = writes(srv).filter(x => x.method === 'PUT').at(-1);
    assert.ok(put, 'the pending save was sent on unmount');
    assert.equal(put.keepalive, true);
    assert.equal(srv.state.answers.A['lib-loans.limit'].answer.actor.quote, 'A card holder');
  } finally { t.cleanup(); }
});

test('a save without any operator proof is refused by the server and shown as not saved, with the credential panel pointing at the fix', async () => {
  const srv = server();
  srv.state.session = { id: 'sess-1', task_id: TASK, project_id: 'proj', annotator: 'robert', packet_sha256: SHA, packet_path: '/synthetic/packet.json', digests: DIGESTS, carried_from: null, superseded_by: null, created_by: 'local_user', created_authority: 'access_user', created_at: '2026-10-09T09:00:00.000Z', updated_at: '2026-10-09T09:00:00.000Z' };
  const t = mountWorkbench(srv);
  try {
    await settle(20);
    const c = t.container;
    await click(radio(c, 'a-0-modality', 'may'));
    await settle(40);
    assert.equal(q(c, '[data-save-status]').dataset.saveStatus, 'error');
    assert.match(q(c, '[data-save-status]').textContent, /Not saved/);
    assert.match(q(c, '[data-credential-notice]').textContent, /operator/i);
    assert.deepEqual(srv.state.answers.A, {}, 'nothing stored');
  } finally { t.cleanup(); }
});
